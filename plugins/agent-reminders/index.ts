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
  type AgentReminder,
  type Condition,
  type Configuration,
  decodeConfiguration,
  decodePositive,
  errorMessage,
  type Positive,
} from "./config.ts"

interface Interval {
  readonly resetAt: number
  readonly toolCounts: ReadonlyMap<string, number>
  readonly contextBaseline: Option.Option<Positive>
  readonly latestContext: Option.Option<Positive>
}

type ActiveCalls = ReadonlyMap<string, ReadonlyMap<string, string>>
type CallIdentity = Pick<ToolHooks["execute.before"], "messageID" | "id">
type CallWithTool = Readonly<Pick<ToolHooks["execute.before"], "messageID" | "id" | "tool">>

interface SessionState {
  readonly agent: string
  readonly interval: Interval
  readonly activeCalls: ActiveCalls
}

interface ContextSample {
  readonly tokens: Option.Option<Positive>
  readonly modelLimit: Option.Option<Positive>
}

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

interface CompiledCondition {
  readonly needsTokens: boolean
  readonly needsLimit: boolean
  readonly matches: (current: Interval, now: number, sample: ContextSample) => boolean
}

interface CompiledAgentReminder {
  readonly message: string
  readonly condition: CompiledCondition
}

const DEFAULT_TOOLS: ReadonlyArray<string> = ["shell", "execute"]

const compileCondition = (condition: Condition): CompiledCondition => {
  switch (condition.type) {
    case "toolCalls": {
      const selected: ReadonlySet<string> = new Set(condition.tools ?? DEFAULT_TOOLS)
      return {
        needsTokens: false,
        needsLimit: false,
        matches: (current: Interval, _now: number, _sample: ContextSample): boolean => {
          let count = 0
          for (const tool of selected) count += current.toolCounts.get(tool) ?? 0
          return count >= condition.count
        },
      }
    }
    case "elapsedTime":
      return {
        needsTokens: false,
        needsLimit: false,
        matches: (current: Interval, now: number, _sample: ContextSample): boolean =>
          (now - current.resetAt) / 1000 >= condition.seconds,
      }
    case "contextGrowth":
      return {
        needsTokens: true,
        needsLimit: false,
        matches: (current: Interval, _now: number, sample: ContextSample): boolean =>
          Option.isSome(current.contextBaseline) && Option.isSome(sample.tokens)
          && sample.tokens.value - current.contextBaseline.value >= condition.tokens,
      }
    case "contextUtilizationGrowth":
      return {
        needsTokens: true,
        needsLimit: true,
        matches: (current: Interval, _now: number, sample: ContextSample): boolean =>
          Option.isSome(current.contextBaseline) && Option.isSome(sample.tokens)
          && Option.isSome(sample.modelLimit)
          && 100 * (sample.tokens.value - current.contextBaseline.value) / sample.modelLimit.value
            >= condition.percentagePoints,
      }
    case "all":
    case "any": {
      const children: ReadonlyArray<CompiledCondition> = condition.conditions.map(
        (nested: Condition): CompiledCondition => compileCondition(nested),
      )
      const needsTokens: boolean = children.some(
        (child: CompiledCondition): boolean => child.needsTokens,
      )
      const needsLimit: boolean = children.some(
        (child: CompiledCondition): boolean => child.needsLimit,
      )
      const matches: CompiledCondition["matches"] = condition.type === "all"
        ? (current: Interval, now: number, sample: ContextSample): boolean =>
          children.every((child: CompiledCondition): boolean => child.matches(current, now, sample))
        : (current: Interval, now: number, sample: ContextSample): boolean =>
          children.some((child: CompiledCondition): boolean => child.matches(current, now, sample))
      return { needsTokens, needsLimit, matches }
    }
  }
}

const compileAgentReminders = (
  agents: Readonly<Record<string, AgentReminder>>,
): Readonly<Record<string, CompiledAgentReminder>> =>
  Object.fromEntries(
    Object.entries(agents).map(([agent, reminder]): [string, CompiledAgentReminder] => [
      agent,
      { message: reminder.message, condition: compileCondition(reminder.condition) },
    ]),
  )

const readRequest = <A>(
  operation: string,
  request: Effect.Effect<A, unknown>,
): Effect.Effect<Option.Option<A>> =>
  Effect.result(request).pipe(
    Effect.flatMap((result: Result.Result<A, unknown>): Effect.Effect<Option.Option<A>> => {
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
  condition: CompiledCondition,
): Effect.Effect<ContextSample> =>
  Effect.gen(function*(): Effect.fn.Return<ContextSample> {
    const wantsTokens: boolean = condition.needsTokens
    const wantsLimit: boolean = condition.needsLimit
    const messages: Option.Option<SessionContextOutput> = wantsTokens
      ? yield* readRequest(
        "session context",
        context.session.context({ sessionID: event.sessionID }),
      )
      : Option.none()
    const models: Option.Option<ModelListOutput> = wantsLimit
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

const interval = (
  resetAt: number,
  tokens: Option.Option<Positive>,
): Interval => ({
  resetAt,
  toolCounts: new Map(),
  contextBaseline: tokens,
  latestContext: tokens,
})

const setSession = (
  current: Map<string, SessionState>,
  sessionID: string,
  state: SessionState,
): Map<string, SessionState> => {
  const next = new Map(current)
  next.set(sessionID, state)
  return next
}

const deleteSession = (
  current: Map<string, SessionState>,
  sessionID: string,
): Map<string, SessionState> => {
  if (!current.has(sessionID)) return current
  const next = new Map(current)
  next.delete(sessionID)
  return next
}

const resolveState = (
  previous: SessionState | undefined,
  agent: string,
  now: number,
): SessionState =>
  previous === undefined
    ? { agent, interval: interval(now, Option.none()), activeCalls: new Map() }
    : previous.agent === agent
    ? previous
    : {
      agent,
      interval: interval(now, Option.none()),
      activeCalls: previous.activeCalls,
    }

const activeCall = (
  activeCalls: ActiveCalls,
  identity: CallIdentity,
): string | undefined => activeCalls.get(identity.messageID)?.get(identity.id)

const addActiveCall = (
  activeCalls: ActiveCalls,
  call: CallWithTool,
): ActiveCalls => {
  const forMessage = new Map(activeCalls.get(call.messageID) ?? [])
  forMessage.set(call.id, call.tool)
  const next = new Map(activeCalls)
  next.set(call.messageID, forMessage)
  return next
}

const removeActiveCall = (
  activeCalls: ActiveCalls,
  identity: CallIdentity,
): ActiveCalls => {
  const existing = activeCalls.get(identity.messageID)
  if (existing === undefined || !existing.has(identity.id)) return activeCalls
  const forMessage = new Map(existing)
  forMessage.delete(identity.id)
  const next = new Map(activeCalls)
  if (forMessage.size === 0) next.delete(identity.messageID)
  else next.set(identity.messageID, forMessage)
  return next
}

const updateIntervalSample = (current: Interval, sample: ContextSample): Interval => {
  return {
    ...current,
    contextBaseline: Option.isNone(current.contextBaseline) && Option.isSome(sample.tokens)
      ? sample.tokens
      : current.contextBaseline,
    latestContext: sample.tokens,
  }
}

const configuredAgent = (
  agents: Readonly<Record<string, CompiledAgentReminder>>,
  agent: string,
): CompiledAgentReminder | undefined =>
  Object.prototype.hasOwnProperty.call(agents, agent) ? agents[agent] : undefined

interface NativeHandlers {
  readonly toolBefore: (event: ToolHooks["execute.before"]) => Effect.Effect<void>
  readonly toolAfter: (event: ToolHooks["execute.after"]) => Effect.Effect<void>
  readonly sessionContext: (event: SessionHooks["context"]) => Effect.Effect<void>
  readonly event: (event: OpenCodeEvent) => Effect.Effect<void>
}

const makeHandlers = (
  context: ReminderContext,
  agents: Readonly<Record<string, CompiledAgentReminder>>,
  states: Ref.Ref<Map<string, SessionState>>,
): NativeHandlers => {
  const toolBefore = (event: ToolHooks["execute.before"]): Effect.Effect<void> =>
    Effect.gen(function*(): Effect.fn.Return<void> {
      const now: number = yield* Clock.currentTimeMillis
      yield* Ref.update(states, (current): Map<string, SessionState> => {
        const previous = current.get(event.sessionID)
        const existingCall = previous === undefined
          ? undefined
          : activeCall(previous.activeCalls, event)
        const state: SessionState = resolveState(previous, event.agent, now)
        const reminder: CompiledAgentReminder | undefined = configuredAgent(agents, state.agent)
        if (event.tool === "subagent") {
          const activeCalls = existingCall === undefined
            ? addActiveCall(state.activeCalls, event)
            : state.activeCalls
          const nextState: SessionState = {
            ...state,
            interval: interval(now, state.interval.latestContext),
            activeCalls,
          }
          return setSession(current, event.sessionID, nextState)
        }
        if (existingCall !== undefined || reminder === undefined) {
          if (previous === undefined) return current
          return setSession(current, event.sessionID, state)
        }
        const counts = new Map(state.interval.toolCounts)
        counts.set(event.tool, (counts.get(event.tool) ?? 0) + 1)
        const nextState: SessionState = {
          ...state,
          interval: { ...state.interval, toolCounts: counts },
          activeCalls: addActiveCall(state.activeCalls, event),
        }
        return setSession(current, event.sessionID, nextState)
      })
    })

  const toolAfter = (event: ToolHooks["execute.after"]): Effect.Effect<void> =>
    Ref.update(states, (current): Map<string, SessionState> => {
      const previous = current.get(event.sessionID)
      if (previous === undefined) return current
      const outerTool = activeCall(previous.activeCalls, event)
      if (outerTool === undefined || outerTool !== event.tool) return current
      const activeCalls = removeActiveCall(previous.activeCalls, event)
      return setSession(current, event.sessionID, { ...previous, activeCalls })
    })

  const sessionContext = (event: SessionHooks["context"]): Effect.Effect<void> =>
    Effect.gen(function*(): Effect.fn.Return<void> {
      const reminder: CompiledAgentReminder | undefined = configuredAgent(agents, event.agent)
      const now: number = yield* Clock.currentTimeMillis
      if (reminder === undefined) {
        yield* Ref.update(states, (current): Map<string, SessionState> => {
          const previous = current.get(event.sessionID)
          if (previous === undefined || previous.agent === event.agent) return current
          return setSession(current, event.sessionID, resolveState(previous, event.agent, now))
        })
        return
      }
      const sample: ContextSample = yield* readContextSample(context, event, reminder.condition)
      const shouldRemind: boolean = yield* Ref.modify(
        states,
        (current): readonly [boolean, Map<string, SessionState>] => {
          const previous = current.get(event.sessionID)
          const state: SessionState = resolveState(previous, event.agent, now)
          const measured: Interval = updateIntervalSample(state.interval, sample)
          const matched: boolean = reminder.condition.matches(measured, now, sample)
          const nextInterval: Interval = matched
            ? interval(now, measured.latestContext)
            : measured
          const nextState: SessionState = { ...state, interval: nextInterval }
          return [matched, setSession(current, event.sessionID, nextState)]
        },
      )
      if (shouldRemind) event.system.push({ type: "text", text: reminder.message })
    })

  const eventHandler = (event: OpenCodeEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "session.agent.selected":
        return Effect.gen(function*(): Effect.fn.Return<void> {
          const now: number = yield* Clock.currentTimeMillis
          yield* Ref.update(states, (current): Map<string, SessionState> => {
            const previous = current.get(event.data.sessionID)
            if (previous?.agent === event.data.agent) return current
            if (
              previous === undefined && configuredAgent(agents, event.data.agent) === undefined
            ) return current
            return setSession(
              current,
              event.data.sessionID,
              resolveState(previous, event.data.agent, now),
            )
          })
        })
      case "session.compaction.ended":
        return Ref.update(states, (current): Map<string, SessionState> => {
          const previous = current.get(event.data.sessionID)
          if (previous === undefined) return current
          return setSession(current, event.data.sessionID, {
            ...previous,
            interval: {
              ...previous.interval,
              contextBaseline: Option.none(),
              latestContext: Option.none(),
            },
          })
        })
      case "session.deleted":
        return Ref.update(
          states,
          (current): Map<string, SessionState> => deleteSession(current, event.data.sessionID),
        )
      default:
        return Effect.void
    }
  }

  return { toolBefore, toolAfter, sessionContext, event: eventHandler }
}

const pluginEffect = (context: ReminderContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*(): Effect.fn.Return<void, never, Scope.Scope> {
    const configuration = yield* Effect.sync(
      (): Configuration => decodeConfiguration(context.options),
    )
    const agents: Readonly<Record<string, CompiledAgentReminder>> = compileAgentReminders(
      configuration.agents,
    )
    const states: Ref.Ref<Map<string, SessionState>> = yield* Ref.make(new Map())
    const handlers: NativeHandlers = makeHandlers(context, agents, states)
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
