import { Plugin } from "@opencode/plugin/effect"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Permission } from "@opencode/schema/permission"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, type Scope } from "effect"
import { resolve } from "node:path"
import { TodoRpc } from "./rpc.ts"
import { TodoInstructions } from "./src/instructions.ts"
import { Snapshot, TodoError, Todos } from "./src/model.ts"
import { makeTodoStore, SessionDirectory, type TodoStore } from "./src/store.ts"

const WriteInput = Schema.Struct({ todos: Todos })
const ReadInput = Schema.Struct({})

export interface TodoPluginContext {
  readonly location: Pick<Plugin.Context["location"], "directory">
  readonly tool: Pick<Plugin.Context["tool"], "transform">
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
  readonly session: Pick<Plugin.Context["session"], "get"> & {
    readonly hook: (
      name: "context",
      callback: (event: SessionContext) => Effect.Effect<void>,
    ) => Effect.Effect<Registration, never, Scope.Scope>
  }
  readonly agent: Pick<Plugin.Context["agent"], "get">
}

const matches = (value: string, pattern: string): boolean => {
  const normalized: string = value.replaceAll("\\", "/")
  let expression: string = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (expression.endsWith(" .*")) expression = `${expression.slice(0, -3)}( .*)?`
  return new RegExp(`^${expression}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

const allowed = (action: string, resource: string, rules: readonly Permission.Rule[]): boolean =>
  rules.findLast(
    (rule): boolean => matches(action, rule.action) && matches(resource, rule.resource),
  )?.effect === "allow"

export const register = (ctx: TodoPluginContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*(): Effect.fn.Return<void, unknown, Scope.Scope> {
    const store: TodoStore = yield* makeTodoStore
    yield* ctx.session.hook(
      "context",
      (event): Effect.Effect<void> =>
        Effect.sync((): void => {
          if (!Object.hasOwn(event.tools, "todowrite") || !Object.hasOwn(event.tools, "todoread")) {
            return
          }
          if (
            event.system.some(
              (part): boolean => part.type === "text" && part.text === TodoInstructions,
            )
          ) {
            return
          }
          event.system.push({ type: "text", text: TodoInstructions })
        }),
    )
    const getSession = Effect.fnUntraced(function*(
      sessionID: Session.ID,
    ): Effect.fn.Return<Session.Info, TodoError> {
      const session: Session.Info = yield* ctx.session
        .get({ sessionID })
        .pipe(
          Effect.mapError(
            (error): TodoError =>
              new TodoError({ message: `Cannot find session: ${String(error)}` }),
          ),
        )
      if (resolve(session.location.directory) !== resolve(ctx.location.directory)) {
        return yield* new TodoError({
          message: "The todo session belongs to another project location",
        })
      }
      return session
    })

    const directoryFor = (session: Session.Info): Effect.Effect<SessionDirectory, TodoError> =>
      Schema.decodeUnknownEffect(SessionDirectory)({
        directory: session.location.directory,
        name: session.id,
      }).pipe(Effect.mapError((error): TodoError => new TodoError({ message: error.message })))

    const read = Effect.fnUntraced(function*(
      sessionID: Session.ID,
    ): Effect.fn.Return<Snapshot, TodoError> {
      return yield* store.read(yield* directoryFor(yield* getSession(sessionID)))
    })

    const rpcHandlers: RpcHandlers<typeof TodoRpc> = {
      read: (input, context): ReturnType<RpcHandlers<typeof TodoRpc>["read"]> =>
        read(input.sessionID).pipe(
          Effect.mapError(
            (error): ReturnType<typeof context.error<"storage">> =>
              context.error("storage", error.message, { message: error.message }),
          ),
        ),
    }
    const rpc = yield* ctx.rpc.register(TodoRpc, rpcHandlers)

    const executeWrite: Tool.Info<typeof WriteInput, typeof Snapshot>["execute"] = Effect.fn(
      "todo.write",
    )(function*(input, context): Effect.fn.Return<Tool.Result<typeof Snapshot>, Tool.Error> {
      const session: Session.Info = yield* getSession(context.sessionID).pipe(
        Effect.mapError((error): Tool.Error => new Tool.Error({ message: error.message })),
      )
      const agent: Agent.Info = (yield* ctx.agent
        .get({ agentID: context.agent })
        .pipe(
          Effect.mapError(
            (error): Tool.Error =>
              new Tool.Error({ message: `Cannot resolve todo permissions: ${String(error)}` }),
          ),
        )).data
      const rules: readonly Permission.Rule[] = [
        ...agent.permissions,
        ...(session.permissions ?? []),
      ]
      const resource: string = `.agents/sessions/${session.id}/todo.txt`
      if (!allowed("todowrite", resource, rules)) {
        return yield* new Tool.Error({
          message:
            "todowrite requires an allow permission. OpenCode V2 does not expose custom-tool approval prompts; deny and ask are rejected.",
        })
      }
      const save: Effect.Effect<Snapshot, TodoError> = directoryFor(session).pipe(
        Effect.flatMap(
          (target): Effect.Effect<Snapshot, TodoError> => store.write(target, input.todos),
        ),
      )
      const snapshot: Snapshot = yield* save.pipe(
        Effect.mapError((error): Tool.Error => new Tool.Error({ message: error.message })),
      )
      yield* rpc.events
        .emit("updated", { sessionID: context.sessionID })
        .pipe(
          Effect.catch(
            (error): Effect.Effect<void> =>
              Effect.logWarning("Todo saved, but notification failed", error),
          ),
        )
      return {
        output: snapshot,
        content: JSON.stringify(snapshot),
        metadata: { todos: snapshot.todos, path: snapshot.path },
      }
    })

    const executeRead: Tool.Info<typeof ReadInput, typeof Snapshot>["execute"] = (
      input,
      context,
    ): Effect.Effect<Tool.Result<typeof Snapshot>, Tool.Error> => {
      void input
      return read(context.sessionID).pipe(
        Effect.map(
          (snapshot): Tool.Result<typeof Snapshot> => ({
            output: snapshot,
            content: JSON.stringify(snapshot),
          }),
        ),
        Effect.mapError((error): Tool.Error => new Tool.Error({ message: error.message })),
      )
    }

    yield* ctx.tool.transform((editor): void => {
      editor.add({
        name: "todowrite",
        description:
          `Replace this session's ordered todo list. First use todoread to preserve existing tasks, order, statuses, and priorities. Status: pending, in_progress, completed, cancelled; at most one in_progress. Priority: high, medium, low. Text is one trimmed line; status:/pri: are reserved. An empty list explicitly clears it. Persists as project-local todo.txt and updates the TUI.\n\n${TodoInstructions}`,
        input: WriteInput,
        output: Snapshot,
        options: { codemode: false, permission: "todowrite" },
        execute: executeWrite,
      })
      editor.add({
        name: "todoread",
        description:
          `Read this session's todo.txt list and storage path. Use before updating an existing list; missing files mean an empty list.\n\n${TodoInstructions}`,
        input: ReadInput,
        output: Snapshot,
        options: { codemode: false, permission: "todowrite" },
        execute: executeRead,
      })
    })
  }).pipe(Effect.orDie)

export default Plugin.define({ id: "session-todo", effect: register })
