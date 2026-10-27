import type { OpenCodeEvent } from "@opencode/client/effect"
import type { ModelListOutput, SessionContextOutput } from "@opencode/client/effect/api"
import type {
  Context as PluginContext,
  Plugin as NativePlugin,
} from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Array as Arr, Clock, Effect, Option, Ref, Result, type Scope, Stream } from "effect"
import {
  type Configuration,
  decodeConfiguration,
  decodePositive,
  errorMessage,
  type Positive,
} from "./config.ts"
import {
  type CompiledEntry,
  type CompiledPolicy,
  compilePolicy,
  type ContextSample,
  deleteSession,
  policyFor,
  type SessionEvent,
  type SessionState,
  setSession,
  type Step,
  step,
} from "./machine.ts"

type AssistantMessage = Extract<SessionContextOutput[number], { readonly type: "assistant" }>
type AssistantWithTokens = AssistantMessage & {
  readonly tokens: NonNullable<AssistantMessage["tokens"]>
}

type ContextSampleBoundary =
  | Extract<SessionContextOutput[number], { readonly type: "compaction" }> & {
    readonly status: "completed"
  }
  | AssistantWithTokens

const isContextSampleBoundary = (
  message: SessionContextOutput[number],
): message is ContextSampleBoundary =>
  (message.type === "compaction" && message.status === "completed")
  || (message.type === "assistant" && message.tokens !== undefined)

interface ReminderContext {
  readonly options: PluginContext["options"]
  readonly session: Pick<PluginContext["session"], "context" | "hook">
  readonly tool: Pick<PluginContext["tool"], "hook">
  readonly model: Pick<PluginContext["model"], "list">
  readonly event: Pick<PluginContext["event"], "subscribe">
}

interface NativeHandlers {
  readonly toolBefore: (event: ToolHooks["execute.before"]) => Effect.Effect<void>
  readonly toolAfter: (event: ToolHooks["execute.after"]) => Effect.Effect<void>
  readonly sessionContext: (event: SessionHooks["context"]) => Effect.Effect<void>
  readonly event: (event: OpenCodeEvent) => Effect.Effect<void>
}

const readRequest = <A, E>(
  operation: string,
  request: Effect.Effect<A, E>,
): Effect.Effect<Option.Option<A>> =>
  Effect.result(request).pipe(
    Effect.flatMap((result: Result.Result<A, E>): Effect.Effect<Option.Option<A>> => {
      if (Result.isFailure(result)) {
        return Effect.logWarning(
          `Agent reminders could not read ${operation}: ${errorMessage(result.failure)}`,
        )
          .pipe(Effect.as(Option.none()))
      }
      return Effect.succeed(Option.some(result.success))
    }),
  )

const latestContextSample = (messages: SessionContextOutput): Option.Option<Positive> =>
  Option.flatMap(
    Arr.findLast(messages, isContextSampleBoundary),
    (message: ContextSampleBoundary): Option.Option<Positive> => {
      if (message.type === "compaction") return Option.none()
      const usage = message.tokens
      const total = usage.input + usage.output + usage.reasoning + usage.cache.read
        + usage.cache.write
      return decodePositive(total)
    },
  )

const contextLimit = (
  models: ModelListOutput,
  model: SessionHooks["context"]["model"],
): Option.Option<Positive> => {
  const current = models.data.find((candidate: ModelListOutput["data"][number]): boolean =>
    candidate.providerID === model.providerID && candidate.id === model.id
  )
  if (current === undefined) return Option.none()
  const limit = current.limit.context
  return decodePositive(limit)
}

const readContextSample = (
  context: ReminderContext,
  event: SessionHooks["context"],
  needsTokens: boolean,
  needsLimit: boolean,
): Effect.Effect<ContextSample> =>
  Effect.gen(function*(): Effect.fn.Return<ContextSample> {
    const messages: Option.Option<SessionContextOutput> = needsTokens
      ? yield* readRequest(
        "session context",
        context.session.context({ sessionID: event.sessionID }),
      )
      : Option.none()
    const models: Option.Option<ModelListOutput> = needsLimit
      ? yield* readRequest("model metadata", context.model.list())
      : Option.none()
    const tokens: Option.Option<Positive> = Option.match(messages, {
      onNone: Option.none,
      onSome: latestContextSample,
    })
    const limit: Option.Option<Positive> = Option.flatMap(
      models,
      (value: ModelListOutput): Option.Option<Positive> => contextLimit(value, event.model),
    )
    return {
      tokens,
      modelLimit: limit,
    }
  })

const logInjection = (
  event: SessionHooks["context"],
  firedAt: number,
): Effect.Effect<void> =>
  Effect.logInfo("Agent reminder injected").pipe(
    Effect.annotateLogs({
      sessionID: event.sessionID,
      agent: event.agent,
      providerID: event.model.providerID,
      modelID: event.model.id,
      firedAt,
    }),
  )

const makeHandlers = (
  context: ReminderContext,
  policy: CompiledPolicy,
  states: Ref.Ref<Map<string, SessionState>>,
): NativeHandlers => {
  const transition = (sessionID: string, event: SessionEvent): Effect.Effect<Step> =>
    Ref.modify(
      states,
      (current: Map<string, SessionState>): readonly [Step, Map<string, SessionState>] => {
        const [result, next]: readonly [Step, SessionState | undefined] = step(
          policy,
          current.get(sessionID),
          event,
        )
        return [
          result,
          next === undefined ? current : setSession(current, sessionID, next),
        ]
      },
    )

  const toolBefore = (event: ToolHooks["execute.before"]): Effect.Effect<void> =>
    Effect.gen(function*(): Effect.fn.Return<void> {
      const now: number = yield* Clock.currentTimeMillis
      yield* transition(event.sessionID, {
        type: "tool.before",
        now,
        tool: event.tool,
        agent: event.agent,
        call: { messageID: event.messageID, id: event.id },
      })
    })

  const toolAfter = (event: ToolHooks["execute.after"]): Effect.Effect<void> =>
    Effect.gen(function*(): Effect.fn.Return<void> {
      const now: number = yield* Clock.currentTimeMillis
      yield* transition(event.sessionID, {
        type: "tool.after",
        now,
        tool: event.tool,
        call: { messageID: event.messageID, id: event.id },
      })
    })

  const sessionContext = (event: SessionHooks["context"]): Effect.Effect<void> =>
    Effect.gen(function*(): Effect.fn.Return<void> {
      const now: number = yield* Clock.currentTimeMillis
      const entries: ReadonlyArray<CompiledEntry> | undefined = policyFor(policy, event.agent)
      const needsTokens: boolean = entries?.some(
        (entry: CompiledEntry): boolean => entry.condition.needsTokens,
      ) ?? false
      const needsLimit: boolean = entries?.some(
        (entry: CompiledEntry): boolean => entry.condition.needsLimit,
      ) ?? false
      const sample: ContextSample = yield* readContextSample(
        context,
        event,
        needsTokens,
        needsLimit,
      )
      const emitted: Step = yield* transition(event.sessionID, {
        type: "context",
        now,
        agent: event.agent,
        sample,
      })
      if (emitted.type === "Emit") {
        for (const message of emitted.messages) {
          event.system.push({ type: "text", text: message })
          yield* logInjection(event, now)
        }
      }
    })

  const eventHandler = (event: OpenCodeEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "session.agent.selected":
        return Effect.gen(function*(): Effect.fn.Return<void> {
          const now: number = yield* Clock.currentTimeMillis
          yield* transition(event.data.sessionID, {
            type: "agent.selected",
            now,
            agent: event.data.agent,
          })
        })
      case "session.compaction.ended":
        return Effect.gen(function*(): Effect.fn.Return<void> {
          const now: number = yield* Clock.currentTimeMillis
          yield* transition(event.data.sessionID, {
            type: "compaction.ended",
            now,
          })
        })
      case "session.deleted":
        return Ref.update(
          states,
          (current: Map<string, SessionState>): Map<string, SessionState> =>
            deleteSession(current, event.data.sessionID),
        )
      default:
        return Effect.void
    }
  }

  return { toolBefore, toolAfter, sessionContext, event: eventHandler }
}

const pluginEffect = (context: ReminderContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*(): Effect.fn.Return<void, never, Scope.Scope> {
    const configuration: Configuration = yield* Effect.sync(
      (): Configuration => decodeConfiguration(context.options),
    )
    const policy: CompiledPolicy = compilePolicy(configuration)
    if (Object.entries(configuration.agents).length === 0) {
      yield* Effect.logWarning(
        "Agent reminders loaded with no agents configured; no reminders will fire.",
      )
    }
    const states: Ref.Ref<Map<string, SessionState>> = yield* Ref.make(new Map())
    const handlers: NativeHandlers = makeHandlers(context, policy, states)
    yield* Effect.addFinalizer((): Effect.Effect<void> => Ref.set(states, new Map()))
    yield* context.tool.hook("execute.before", handlers.toolBefore)
    yield* context.tool.hook("execute.after", handlers.toolAfter)
    yield* context.session.hook("context", handlers.sessionContext)
    const events = Stream.runForEach(context.event.subscribe(), handlers.event)
    yield* Effect.forkScoped(
      events.pipe(
        Effect.result,
        Effect.flatMap((result: Result.Result<void, unknown>): Effect.Effect<void> =>
          Result.isFailure(result)
            ? Effect.logWarning(
              `Agent reminders event subscription stopped: ${errorMessage(result.failure)}`,
            )
            : Effect.void
        ),
      ),
    )
  })

const agentReminders = { id: "agent-reminders", effect: pluginEffect } satisfies NativePlugin

export default agentReminders
