import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { Rpc } from "@opencode/schema/rpc"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { afterEach, expect, test } from "bun:test"
import { Effect, Result, Schema, type Scope, type Types } from "effect"
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { register, type TodoPluginContext } from "../index.ts"
import { Snapshot, Todos } from "../src/model.ts"

const directories: Set<string> = new Set()

const temporary = async (): Promise<string> => {
  const directory: string = await mkdtemp(join(tmpdir(), "opencode-todo-plugin-"))
  directories.add(directory)
  return directory
}

afterEach(async (): Promise<void> => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

const rule = (action: string, resource: string, effect: Permission.Effect): Permission.Rule => ({
  action,
  resource,
  effect,
})

const sessionInfo = (
  directory: string,
  permissions: readonly Permission.Rule[] = [],
  id: string = "ses_tools",
): Session.Info =>
  Schema.decodeUnknownSync(Session.Info)({
    id,
    projectID: "proj_test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory },
    permissions,
  })

const agentInfo = (permissions: readonly Permission.Rule[]): Agent.Info => ({
  ...Agent.Info.default(Agent.ID.make("test")),
  permissions,
})

const toolContext = (sessionID: Session.ID, agentID: Agent.ID): Tool.Context => ({
  sessionID,
  agent: agentID,
  messageID: Schema.decodeUnknownSync(SessionMessage.ID)("msg_tools"),
  id: Schema.decodeUnknownSync(Tool.CallID)("call_tools"),
  progress: (): Effect.Effect<void> => Effect.void,
})

interface HostOptions {
  readonly directory: string
  readonly sessions: ReadonlyMap<string, Session.Info>
  readonly agents: ReadonlyMap<string, Agent.Info>
}

type ContextHook = (event: SessionContext) => Effect.Effect<void, never>

interface TodoHost {
  readonly context: TodoPluginContext
  readonly tools: ReadonlyMap<string, Tool.Info>
  readonly events: ReadonlyArray<ReadonlyArray<unknown>>
  readonly dispatchContext: ContextHook
  readonly activeContextHooks: () => number
}

const makeHost = (options: HostOptions): TodoHost => {
  const tools: Map<string, Tool.Info> = new Map()
  const events: unknown[][] = []
  const contextHooks: Array<ContextHook> = []
  const editor: ToolEditor = {
    list: (): readonly (Tool.Info & { readonly id: string })[] =>
      [...tools.entries()].map(([id, tool]): Tool.Info & { readonly id: string } => ({
        ...tool,
        id,
      })),
    get: (id: string): (Tool.Info & { readonly id: string }) | undefined => {
      const tool: Tool.Info | undefined = tools.get(id)
      return tool === undefined ? undefined : { ...tool, id }
    },
    namespace: (): void => {},
    add: (tool): void => {
      tools.set(tool.name, tool)
    },
    update: (id, update): void => {
      const tool: Tool.Info | undefined = tools.get(id)
      if (tool === undefined) return
      const mutable: Types.Mutable<Tool.Info> = { ...tool }
      update(mutable)
      tools.set(id, mutable)
    },
    remove: (id: string): void => {
      tools.delete(id)
    },
  }
  const context: TodoPluginContext = {
    location: { directory: AbsolutePath.make(options.directory) },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) => {
        callback(editor)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    rpc: {
      register: <const D extends Rpc.Definition>(
        definition: D,
        handlers: RpcHandlers<NoInfer<D>>,
      ): Effect.Effect<RpcRegistration<D>, unknown, Scope.Scope> => {
        void definition
        void handlers
        return Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (...args: Rpc.EventInput<D>): Effect.Effect<void, unknown> => {
              events.push(args)
              return Effect.void
            },
          },
        })
      },
    },
    session: {
      get: (input: { readonly sessionID: Session.ID }): Effect.Effect<Session.Info, unknown> => {
        const session: Session.Info | undefined = options.sessions.get(input.sessionID)
        return session === undefined
          ? Effect.fail(new Error(`Unknown session: ${input.sessionID}`))
          : Effect.succeed(session)
      },
      hook: (name, callback): Effect.Effect<Registration, never, Scope.Scope> => {
        void name
        return Effect.acquireRelease(
          Effect.sync((): void => {
            contextHooks.push(callback)
          }),
          (): Effect.Effect<void> =>
            Effect.sync((): void => {
              const index: number = contextHooks.indexOf(callback)
              if (index !== -1) contextHooks.splice(index, 1)
            }),
        ).pipe(Effect.map((): Registration => ({ dispose: Effect.void })))
      },
    },
    agent: {
      get: (input: { readonly agentID: Agent.ID }) => {
        const agent: Agent.Info | undefined = options.agents.get(input.agentID)
        return agent === undefined
          ? Effect.fail(new Error(`Unknown agent: ${input.agentID}`))
          : Effect.succeed({
            location: { directory: AbsolutePath.make(options.directory) },
            data: agent,
          })
      },
    },
  }
  const dispatchContext = (event: SessionContext): Effect.Effect<void, never> =>
    Effect.gen(function*(): Effect.fn.Return<void, never> {
      for (const callback of [...contextHooks]) yield* callback(event)
    })

  const activeContextHooks = (): number => contextHooks.length

  return { context, tools, events, dispatchContext, activeContextHooks }
}

type ToolOutcome = Result.Result<Tool.Result, unknown>

const decodeInput = <A>(
  schema: Tool.ValueSchema<A>,
  input: unknown,
): Effect.Effect<A, Schema.SchemaError> =>
  Schema.isSchema(schema)
    ? Schema.decodeUnknownEffect(schema)(input)
    : Effect.die(new Error("Tool input is not an Effect schema"))

const callTool = (
  host: TodoHost,
  name: string,
  input: unknown,
  context: Tool.Context,
): Effect.Effect<ToolOutcome> =>
  Effect.result(
    Effect.gen(function*(): Effect.fn.Return<Tool.Result, Schema.SchemaError | Tool.Error> {
      const tool: Tool.Info | undefined = host.tools.get(name)
      if (tool === undefined) {
        return yield* Effect.die(new Error(`Tool not registered: ${name}`))
      }
      const decoded: unknown = yield* decodeInput(tool.input, input)
      return yield* tool.execute(decoded, context)
    }),
  )

const runPlugin = async <A>(host: TodoHost, program: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*(): Effect.fn.Return<A, never, Scope.Scope> {
        yield* register(host.context)
        return yield* program
      }),
    ),
  )

const requireTool = (host: TodoHost, name: string): Tool.Info => {
  const tool: Tool.Info | undefined = host.tools.get(name)
  if (tool === undefined) throw new Error(`Tool not registered: ${name}`)
  return tool
}

const expectSuccess = (outcome: ToolOutcome): Tool.Result => {
  if (Result.isFailure(outcome)) {
    throw new Error(`Expected a successful tool call, got: ${String(outcome.failure)}`)
  }
  return outcome.success
}

const expectToolError = (outcome: ToolOutcome): Tool.Error => {
  if (Result.isSuccess(outcome)) throw new Error("Expected a failing tool call")
  const failure: unknown = outcome.failure
  if (!(failure instanceof Tool.Error)) {
    throw new Error(`Expected Tool.Error, got: ${String(failure)}`)
  }
  return failure
}

const expectSchemaError = (outcome: ToolOutcome): void => {
  if (Result.isSuccess(outcome)) throw new Error("Expected a failing tool call")
  const failure: unknown = outcome.failure
  if (!Schema.isSchemaError(failure)) {
    throw new Error(`Expected SchemaError, got: ${String(failure)}`)
  }
}

type SystemPart = SessionContext["system"][number]

const sessionContext = (
  system: Array<SystemPart>,
  tools: SessionContext["tools"],
  messages: SessionContext["messages"] = [],
  options: SessionContext["options"] = {},
): SessionContext => ({
  sessionID: Session.ID.make("ses_hook"),
  agent: Agent.ID.make("test"),
  model: Schema.decodeUnknownSync(Model.Ref)({ id: "test", providerID: "test" }),
  system,
  messages,
  options,
  tools,
})

const toolEntry = (description: string): SessionContext["tools"][string] => ({
  description,
  input: {},
})

const bothTodoTools = (): SessionContext["tools"] => ({
  todowrite: toolEntry("writes the todo list"),
  todoread: toolEntry("reads the todo list"),
})

const occurrences = (parts: ReadonlyArray<SystemPart>, text: string): number =>
  parts.filter((part): boolean => part.text.includes(text)).length

const ruleExpectedOnWrite: string =
  "You MUST pass the list you expect to be stored as `previous` to every todowrite"
const ruleInProgressBeforeStart: string = "You MUST mark a task in_progress before starting it."
const ruleCompletedAfterVerification: string =
  "You MUST mark a task completed immediately after finishing its work and required verification."
const ruleNoPrematureComplete: string =
  "You MUST NOT mark blocked, failed, skipped, unfinished, or unverified work completed."
const ruleNoBatchTransitions: string =
  "You MUST NOT batch status updates until the end of the conversation"
const ruleReconcileBeforeFinal: string =
  "Before your final response, you MUST reconcile the list with what was actually done"

const contractRules: ReadonlyArray<string> = [
  ruleExpectedOnWrite,
  ruleInProgressBeforeStart,
  ruleCompletedAfterVerification,
  ruleNoPrematureComplete,
  ruleNoBatchTransitions,
  ruleReconcileBeforeFinal,
]

const snapshotOf = (result: Tool.Result): Snapshot => {
  const content: string | ReadonlyArray<Tool.Content> | undefined = result.content
  if (typeof content !== "string") throw new Error("Expected text tool result content")
  return Schema.decodeUnknownSync(Snapshot)(JSON.parse(content))
}

const writeOutcome = (
  host: TodoHost,
  session: Session.Info,
  agent: Agent.Info,
  previous: unknown,
  todos: unknown,
): Effect.Effect<ToolOutcome> =>
  Effect.gen(function*(): Effect.fn.Return<ToolOutcome, never> {
    return yield* callTool(
      host,
      "todowrite",
      { previous, todos },
      toolContext(session.id, agent.id),
    )
  })

const sessionHost = (directory: string, session: Session.Info, agent: Agent.Info): TodoHost =>
  makeHost({
    directory,
    sessions: new Map([[session.id, session]]),
    agents: new Map([[agent.id, agent]]),
  })

test("register installs exactly todowrite and todoread with codemode disabled", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  await runPlugin(host, Effect.void)
  expect([...host.tools.keys()]).toEqual(["todowrite", "todoread"])
  const todowrite: Tool.Info = requireTool(host, "todowrite")
  const todoread: Tool.Info = requireTool(host, "todoread")
  expect(todowrite.options?.codemode).toBe(false)
  expect(todowrite.options?.permission).toBe("todowrite")
  expect(todoread.options?.codemode).toBe(false)
  expect(todoread.options?.permission).toBe("todowrite")
})

test("todowrite persists exact bytes and todoread returns the same list and path", async (): Promise<void> => {
  const directory: string = await temporary()
  const session: Session.Info = sessionInfo(directory, [rule("todowrite", "*", "allow")])
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
  const host: TodoHost = sessionHost(directory, session, agent)
  const todos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Ship +plugin @opencode", status: "in_progress", priority: "high" },
    { content: "Read docs", status: "pending", priority: "medium" },
  ])
  const context: Tool.Context = toolContext(session.id, agent.id)
  const outcome = await runPlugin(
    host,
    Effect.gen(function*(): Effect.fn.Return<
      { readonly write: ToolOutcome; readonly read: ToolOutcome },
      never
    > {
      const write: ToolOutcome = yield* callTool(
        host,
        "todowrite",
        { previous: [], todos },
        context,
      )
      const read: ToolOutcome = yield* callTool(host, "todoread", {}, context)
      return { write, read }
    }),
  )
  const written: Tool.Result = expectSuccess(outcome.write)
  const read: Snapshot = snapshotOf(expectSuccess(outcome.read))
  const path: string = join(directory, ".agents", "sessions", "ses_tools", "todo.txt")
  const stored: Snapshot = Schema.decodeUnknownSync(Snapshot)(written.output)
  expect(stored.path).toBe(path)
  expect(stored.todos).toEqual(todos)
  expect(written.content).toBe(
    "Todo list updated:\n+ [in_progress|high] Ship +plugin @opencode\n+ [pending|medium] Read docs",
  )
  expect(read.path).toBe(path)
  expect(read.todos).toEqual(todos)
  expect(await readFile(path, "utf8")).toBe(
    "(A) Ship +plugin @opencode status:in_progress\n(B) Read docs\n",
  )
  expect(await readdir(join(directory, ".agents", "sessions", "ses_tools"))).toEqual(["todo.txt"])
  expect(host.events).toHaveLength(1)
  expect(host.events[0]).toEqual([
    "updated",
    {
      sessionID: "ses_tools",
      diff: "+ [in_progress|high] Ship +plugin @opencode\n+ [pending|medium] Read docs",
    },
  ])
})

test("todowrite reports a before/after diff over the stored list", async (): Promise<void> => {
  const directory: string = await temporary()
  const session: Session.Info = sessionInfo(directory, [rule("todowrite", "*", "allow")])
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
  const host: TodoHost = sessionHost(directory, session, agent)
  const first: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Alpha", status: "pending", priority: "high" },
      { content: "Beta", status: "pending", priority: "medium" },
    ]),
  )
  const second: ToolOutcome = await runPlugin(
    host,
    writeOutcome(
      host,
      session,
      agent,
      [
        { content: "Alpha", status: "pending", priority: "high" },
        { content: "Beta", status: "pending", priority: "medium" },
      ],
      [
        { content: "Alpha", status: "in_progress", priority: "high" },
        { content: "Gamma", status: "pending", priority: "low" },
      ],
    ),
  )
  const third: ToolOutcome = await runPlugin(
    host,
    writeOutcome(
      host,
      session,
      agent,
      [
        { content: "Alpha", status: "in_progress", priority: "high" },
        { content: "Gamma", status: "pending", priority: "low" },
      ],
      [
        { content: "Alpha", status: "in_progress", priority: "high" },
        { content: "Gamma", status: "pending", priority: "low" },
      ],
    ),
  )
  expect(expectSuccess(first).content).toBe(
    "Todo list updated:\n+ [pending|high] Alpha\n+ [pending|medium] Beta",
  )
  expect(expectSuccess(second).content).toBe(
    "Todo list updated:\n- [pending|high] Alpha\n- [pending|medium] Beta\n"
      + "+ [in_progress|high] Alpha\n+ [pending|low] Gamma",
  )
  expect(expectSuccess(third).content).toBe("Todo list unchanged.")
})

test("todowrite fails on an unexpected stored list and instructs a fresh read", async (): Promise<void> => {
  const directory: string = await temporary()
  const session: Session.Info = sessionInfo(directory, [rule("todowrite", "*", "allow")])
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
  const host: TodoHost = sessionHost(directory, session, agent)
  const first: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Alpha", status: "pending", priority: "high" },
    ]),
  )
  expectSuccess(first)
  const stale: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Beta", status: "pending", priority: "medium" },
    ]),
  )
  const failure: Tool.Error = expectToolError(stale)
  expect(failure.message).toContain("does not match the `previous` list")
  expect(failure.message).toContain("todoread")
  const path: string = join(directory, ".agents", "sessions", "ses_tools", "todo.txt")
  expect(await readFile(path, "utf8")).toBe("(A) Alpha\n")
  expect(host.events).toHaveLength(1)
  const recovered: ToolOutcome = await runPlugin(
    host,
    writeOutcome(
      host,
      session,
      agent,
      [{ content: "Alpha", status: "pending", priority: "high" }],
      [{ content: "Alpha", status: "in_progress", priority: "high" }],
    ),
  )
  expectSuccess(recovered)
  expect(await readFile(path, "utf8")).toBe("(A) Alpha status:in_progress\n")
  expect(host.events).toHaveLength(2)
})

test("deny, ask, and unmatched rules reject todowrite without creating .agents", async (): Promise<void> => {
  const cases: ReadonlyArray<readonly [string, readonly Permission.Rule[]]> = [
    ["deny", [rule("todowrite", "*", "deny")]],
    ["ask", [rule("todowrite", "*", "ask")]],
    ["no matching allow", [rule("todoread", "*", "allow")]],
  ]
  for (const [label, permissions] of cases) {
    const directory: string = await temporary()
    const session: Session.Info = sessionInfo(directory, permissions)
    const agent: Agent.Info = agentInfo(permissions)
    const host: TodoHost = sessionHost(directory, session, agent)
    const outcome: ToolOutcome = await runPlugin(
      host,
      writeOutcome(host, session, agent, [], [
        { content: "Blocked", status: "pending", priority: "high" },
      ]),
    )
    const failure: Tool.Error = expectToolError(outcome)
    expect(failure.message, label).toContain("requires an allow permission")
    expect(host.events, label).toHaveLength(0)
    expect(await pathExists(join(directory, ".agents")), label).toBe(false)
  }
})

test("a session deny overrides an earlier agent allow", async (): Promise<void> => {
  const directory: string = await temporary()
  const session: Session.Info = sessionInfo(directory, [rule("todowrite", "*", "deny")])
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
  const host: TodoHost = sessionHost(directory, session, agent)
  const outcome: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Blocked", status: "pending", priority: "high" },
    ]),
  )
  const failure: Tool.Error = expectToolError(outcome)
  expect(failure.message).toContain("requires an allow permission")
  expect(host.events).toHaveLength(0)
  expect(await pathExists(join(directory, ".agents"))).toBe(false)
})

test("a resource-specific deny after a generic allow denies with native separator patterns", async (): Promise<void> => {
  const directory: string = await temporary()
  const session: Session.Info = sessionInfo(directory)
  const agent: Agent.Info = agentInfo([
    rule("todowrite", "*", "allow"),
    rule("todowrite", ".agents\\sessions\\*", "deny"),
  ])
  const host: TodoHost = sessionHost(directory, session, agent)
  const outcome: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Blocked", status: "pending", priority: "high" },
    ]),
  )
  const failure: Tool.Error = expectToolError(outcome)
  expect(failure.message).toContain("requires an allow permission")
  expect(host.events).toHaveLength(0)
  expect(await pathExists(join(directory, ".agents"))).toBe(false)
})

test("a session allow overrides an earlier agent deny", async (): Promise<void> => {
  const directory: string = await temporary()
  const session: Session.Info = sessionInfo(directory, [rule("todowrite", "*", "allow")])
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "deny")])
  const host: TodoHost = sessionHost(directory, session, agent)
  const outcome: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Override", status: "pending", priority: "high" },
    ]),
  )
  expectSuccess(outcome)
  const path: string = join(directory, ".agents", "sessions", "ses_tools", "todo.txt")
  expect(await readFile(path, "utf8")).toBe("(A) Override\n")
  expect(host.events).toHaveLength(1)
  expect(host.events[0]).toEqual([
    "updated",
    { sessionID: "ses_tools", diff: "+ [pending|high] Override" },
  ])
})

test("an unknown session rejects todowrite without writing", async (): Promise<void> => {
  const directory: string = await temporary()
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map([[agent.id, agent]]),
  })
  const sessionID: Session.ID = Schema.decodeUnknownSync(Session.ID)("ses_missing")
  const outcome: ToolOutcome = await runPlugin(
    host,
    Effect.gen(function*(): Effect.fn.Return<ToolOutcome, never> {
      return yield* callTool(
        host,
        "todowrite",
        { previous: [], todos: [{ content: "Blocked", status: "pending", priority: "high" }] },
        toolContext(sessionID, agent.id),
      )
    }),
  )
  const failure: Tool.Error = expectToolError(outcome)
  expect(failure.message).toContain("Cannot find session")
  expect(await pathExists(join(directory, ".agents"))).toBe(false)
})

test("a session bound to another location rejects todowrite without writing", async (): Promise<void> => {
  const directory: string = await temporary()
  const elsewhere: string = await temporary()
  const session: Session.Info = sessionInfo(elsewhere, [rule("todowrite", "*", "allow")])
  const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
  const host: TodoHost = sessionHost(directory, session, agent)
  const outcome: ToolOutcome = await runPlugin(
    host,
    writeOutcome(host, session, agent, [], [
      { content: "Blocked", status: "pending", priority: "high" },
    ]),
  )
  const failure: Tool.Error = expectToolError(outcome)
  expect(failure.message).toContain("another project location")
  expect(await pathExists(join(directory, ".agents"))).toBe(false)
  expect(await pathExists(join(elsewhere, ".agents"))).toBe(false)
})

test("invalid todo input fails decoding before execute and creates no file", async (): Promise<void> => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    [
      "empty status token",
      {
        previous: [],
        todos: [{ content: "Discuss status:", status: "pending", priority: "high" }],
      },
    ],
    [
      "empty priority token",
      { previous: [], todos: [{ content: "Discuss pri:", status: "pending", priority: "high" }] },
    ],
    [
      "two in_progress",
      {
        previous: [],
        todos: [
          { content: "First", status: "in_progress", priority: "high" },
          { content: "Second", status: "in_progress", priority: "low" },
        ],
      },
    ],
  ]
  for (const [label, input] of cases) {
    const directory: string = await temporary()
    const session: Session.Info = sessionInfo(directory, [rule("todowrite", "*", "allow")])
    const agent: Agent.Info = agentInfo([rule("todowrite", "*", "allow")])
    const host: TodoHost = sessionHost(directory, session, agent)
    const outcome: ToolOutcome = await runPlugin(
      host,
      Effect.gen(function*(): Effect.fn.Return<ToolOutcome, never> {
        return yield* callTool(host, "todowrite", input, toolContext(session.id, agent.id))
      }),
    )
    expectSchemaError(outcome)
    expect(host.events, label).toHaveLength(0)
    expect(await pathExists(join(directory, ".agents")), label).toBe(false)
  }
})

test.skipIf(process.platform !== "win32")(
  "permission patterns match case-insensitively on Windows",
  async (): Promise<void> => {
    const directory: string = await temporary()
    const session: Session.Info = sessionInfo(directory)
    const agent: Agent.Info = agentInfo([
      rule("todowrite", "*", "allow"),
      rule("todowrite", ".AGENTS/SESSIONS/*", "deny"),
    ])
    const host: TodoHost = sessionHost(directory, session, agent)
    const outcome: ToolOutcome = await runPlugin(
      host,
      writeOutcome(host, session, agent, [], [
        { content: "Blocked", status: "pending", priority: "high" },
      ]),
    )
    const failure: Tool.Error = expectToolError(outcome)
    expect(failure.message).toContain("requires an allow permission")
    expect(await pathExists(join(directory, ".agents"))).toBe(false)
  },
)

test("both todo tool descriptions carry the RFC 2119 lifecycle rules", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  await runPlugin(host, Effect.void)
  const descriptions: ReadonlyArray<readonly [string, string]> = [
    ["todowrite", requireTool(host, "todowrite").description],
    ["todoread", requireTool(host, "todoread").description],
  ]
  for (const [name, description] of descriptions) {
    expect(description, name).toContain("MUST NOT")
    for (const rule of contractRules) {
      expect(description, `${name} missing: ${rule}`).toContain(rule)
    }
  }
})

test("context hook appends one instruction after existing system text when both todo tools are present", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  const base: SystemPart = { type: "text", text: "existing system prompt" }
  const system: Array<SystemPart> = [base]
  const event: SessionContext = sessionContext(system, bothTodoTools())
  await runPlugin(host, host.dispatchContext(event))
  expect(event.system).toHaveLength(2)
  expect(event.system[0]).toBe(base)
  expect(base.text).toBe("existing system prompt")
  expect(event.system[1]?.type).toBe("text")
  const injected: string = event.system[1]?.text ?? ""
  for (const rule of contractRules) {
    expect(injected, `missing: ${rule}`).toContain(rule)
  }
})

test("context hook skips injection when todowrite or todoread is missing", async (): Promise<void> => {
  const cases: ReadonlyArray<readonly [string, SessionContext["tools"]]> = [
    ["only todoread", { todoread: toolEntry("reads the todo list") }],
    ["only todowrite", { todowrite: toolEntry("writes the todo list") }],
    ["no todo tools", {}],
  ]
  for (const [label, tools] of cases) {
    const directory: string = await temporary()
    const host: TodoHost = makeHost({
      directory,
      sessions: new Map<string, Session.Info>(),
      agents: new Map<string, Agent.Info>(),
    })
    const base: SystemPart = { type: "text", text: "existing system prompt" }
    const event: SessionContext = sessionContext([base], tools)
    await runPlugin(host, host.dispatchContext(event))
    expect(event.system, label).toHaveLength(1)
    expect(event.system[0], label).toBe(base)
  }
})

test("context hook injects without replacing system messages options tools or config", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  const base: SystemPart = { type: "text", text: "existing system prompt" }
  const system: Array<SystemPart> = [base]
  const messages: SessionContext["messages"] = []
  const options: SessionContext["options"] = {}
  const tools: SessionContext["tools"] = bothTodoTools()
  const event: SessionContext = sessionContext(system, tools, messages, options)
  await runPlugin(host, host.dispatchContext(event))
  expect(event.system).toBe(system)
  expect(event.messages).toBe(messages)
  expect(event.options).toBe(options)
  expect(event.tools).toBe(tools)
  expect(event.system).toHaveLength(2)
  expect(event.system[0]).toBe(base)
  expect(base.text).toBe("existing system prompt")
  expect(messages).toHaveLength(0)
  expect(Object.keys(options)).toHaveLength(0)
  expect(Object.keys(tools)).toEqual(["todowrite", "todoread"])
  expect(host.tools.size).toBe(2)
})

test("repeated dispatch of the same event does not duplicate the instruction", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  const event: SessionContext = sessionContext(
    [{ type: "text", text: "existing system prompt" }],
    bothTodoTools(),
  )
  await runPlugin(
    host,
    Effect.gen(function*(): Effect.fn.Return<void, never> {
      yield* host.dispatchContext(event)
      yield* host.dispatchContext(event)
    }),
  )
  expect(event.system).toHaveLength(2)
  expect(occurrences(event.system, ruleExpectedOnWrite)).toBe(1)
})

test("a distinct new-turn event receives the instruction", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  const first: SessionContext = sessionContext(
    [{ type: "text", text: "first turn" }],
    bothTodoTools(),
  )
  const second: SessionContext = sessionContext(
    [{ type: "text", text: "second turn" }],
    bothTodoTools(),
  )
  await runPlugin(
    host,
    Effect.gen(function*(): Effect.fn.Return<void, never> {
      yield* host.dispatchContext(first)
      yield* host.dispatchContext(second)
    }),
  )
  expect(first.system).toHaveLength(2)
  expect(second.system).toHaveLength(2)
  expect(occurrences(first.system, ruleExpectedOnWrite)).toBe(1)
  expect(occurrences(second.system, ruleExpectedOnWrite)).toBe(1)
})

test("context hook registration is scoped and re-registration leaves one active hook", async (): Promise<void> => {
  const directory: string = await temporary()
  const host: TodoHost = makeHost({
    directory,
    sessions: new Map<string, Session.Info>(),
    agents: new Map<string, Agent.Info>(),
  })
  const first: SessionContext = sessionContext(
    [{ type: "text", text: "first scope" }],
    bothTodoTools(),
  )
  const firstCount: number = await runPlugin(
    host,
    Effect.gen(function*(): Effect.fn.Return<number, never> {
      yield* host.dispatchContext(first)
      return host.activeContextHooks()
    }),
  )
  expect(firstCount).toBe(1)
  expect(first.system).toHaveLength(2)
  expect(host.activeContextHooks()).toBe(0)
  const between: SessionContext = sessionContext(
    [{ type: "text", text: "between scopes" }],
    bothTodoTools(),
  )
  await Effect.runPromise(host.dispatchContext(between))
  expect(between.system).toHaveLength(1)
  const second: SessionContext = sessionContext(
    [{ type: "text", text: "second scope" }],
    bothTodoTools(),
  )
  const secondCount: number = await runPlugin(
    host,
    Effect.gen(function*(): Effect.fn.Return<number, never> {
      yield* host.dispatchContext(second)
      yield* host.dispatchContext(second)
      return host.activeContextHooks()
    }),
  )
  expect(secondCount).toBe(1)
  expect(host.activeContextHooks()).toBe(0)
  expect(second.system).toHaveLength(2)
  expect(occurrences(second.system, ruleExpectedOnWrite)).toBe(1)
})
