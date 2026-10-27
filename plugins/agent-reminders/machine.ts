import { Option } from "effect"
import {
  type AgentReminderEntry,
  type Condition,
  type Configuration,
  countingTools,
  DEFAULT_TOOLS,
  type Positive,
  type ToolPattern,
} from "./config.ts"

export interface Interval {
  readonly resetAt: number
  readonly toolCounts: ReadonlyMap<string, number>
  readonly contextBaseline: Option.Option<Positive>
  readonly latestContext: Option.Option<Positive>
}

export type ActiveCalls = ReadonlyMap<string, ReadonlyMap<string, string>>

export interface CallIdentity {
  readonly messageID: string
  readonly id: string
}

interface CallWithTool extends CallIdentity {
  readonly tool: string
}

export interface SessionState {
  readonly agent: string
  readonly entries: ReadonlyArray<Interval>
  readonly activeCalls: ActiveCalls
}

export interface ContextSample {
  readonly tokens: Option.Option<Positive>
  readonly modelLimit: Option.Option<Positive>
}

export interface CompiledCondition {
  readonly needsTokens: boolean
  readonly needsLimit: boolean
  readonly matches: (current: Interval, now: number, sample: ContextSample) => boolean
}

export interface CompiledEntry {
  readonly message: string
  readonly resets: (tool: string) => boolean
  readonly counts: (tool: string) => boolean
  readonly condition: CompiledCondition
}

export type CompiledPolicy = Readonly<Record<string, ReadonlyArray<CompiledEntry>>>

export type SessionEvent =
  | {
    readonly type: "tool.before"
    readonly now: number
    readonly tool: string
    readonly agent: string
    readonly call: CallIdentity
  }
  | {
    readonly type: "tool.after"
    readonly now: number
    readonly tool: string
    readonly call: CallIdentity
  }
  | {
    readonly type: "context"
    readonly now: number
    readonly agent: string
    readonly sample: ContextSample
  }
  | {
    readonly type: "agent.selected"
    readonly now: number
    readonly agent: string
  }
  | {
    readonly type: "compaction.ended"
    readonly now: number
  }

export type Step =
  | { readonly type: "Continue" }
  | { readonly type: "Emit"; readonly messages: ReadonlyArray<string> }

const CONTINUE: Step = { type: "Continue" }

const matchesPattern = (pattern: ToolPattern, tool: string): boolean =>
  pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern

const toolMatcher = (
  patterns: ReadonlyArray<ToolPattern>,
): (tool: string) => boolean => {
  const matchers: ReadonlyArray<(tool: string) => boolean> = patterns.map(
    (pattern: ToolPattern): (tool: string) => boolean => (tool: string): boolean =>
      matchesPattern(pattern, tool),
  )
  return (tool: string): boolean =>
    matchers.some((matches: (tool: string) => boolean): boolean => matches(tool))
}

export const compileCondition = (condition: Condition): CompiledCondition => {
  switch (condition.type) {
    case "toolCalls": {
      const selected: (tool: string) => boolean = toolMatcher(condition.tools ?? DEFAULT_TOOLS)
      return {
        needsTokens: false,
        needsLimit: false,
        matches: (current: Interval, _now: number, _sample: ContextSample): boolean => {
          let count = 0
          for (const [tool, calls] of current.toolCounts) {
            if (selected(tool)) count += calls
          }
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

export const compilePolicy = (configuration: Configuration): CompiledPolicy => {
  const policy: Record<string, ReadonlyArray<CompiledEntry>> = {}
  for (const [agent, entries] of Object.entries(configuration.agents)) {
    policy[agent] = entries.map((entry: AgentReminderEntry): CompiledEntry => ({
      message: entry.message,
      resets: toolMatcher(entry.resetTools),
      counts: toolMatcher(countingTools(entry.condition)),
      condition: compileCondition(entry.condition),
    }))
  }
  return policy
}

export const policyFor = (
  policy: CompiledPolicy,
  agent: string,
): ReadonlyArray<CompiledEntry> | undefined => {
  if (!Object.prototype.hasOwnProperty.call(policy, agent)) return undefined
  const entries: ReadonlyArray<CompiledEntry> | undefined = policy[agent]
  return entries
}

const interval = (resetAt: number, tokens: Option.Option<Positive>): Interval => ({
  resetAt,
  toolCounts: new Map(),
  contextBaseline: tokens,
  latestContext: tokens,
})

const freshEntries = (
  entries: ReadonlyArray<CompiledEntry>,
  now: number,
): ReadonlyArray<Interval> =>
  entries.map((_entry: CompiledEntry): Interval => interval(now, Option.none()))

const updateIntervalSample = (current: Interval, sample: ContextSample): Interval => ({
  ...current,
  contextBaseline: Option.isNone(current.contextBaseline) && Option.isSome(sample.tokens)
    ? sample.tokens
    : current.contextBaseline,
  latestContext: sample.tokens,
})

const activeCall = (activeCalls: ActiveCalls, call: CallIdentity): string | undefined =>
  activeCalls.get(call.messageID)?.get(call.id)

const addActiveCall = (activeCalls: ActiveCalls, call: CallWithTool): ActiveCalls => {
  const forMessage = new Map(activeCalls.get(call.messageID) ?? [])
  forMessage.set(call.id, call.tool)
  const next = new Map(activeCalls)
  next.set(call.messageID, forMessage)
  return next
}

const removeActiveCall = (activeCalls: ActiveCalls, call: CallIdentity): ActiveCalls => {
  const existing = activeCalls.get(call.messageID)
  if (existing === undefined || !existing.has(call.id)) return activeCalls
  const forMessage = new Map(existing)
  forMessage.delete(call.id)
  const next = new Map(activeCalls)
  if (forMessage.size === 0) next.delete(call.messageID)
  else next.set(call.messageID, forMessage)
  return next
}

export const setSession = (
  current: Map<string, SessionState>,
  sessionID: string,
  state: SessionState,
): Map<string, SessionState> => {
  const next = new Map(current)
  next.set(sessionID, state)
  return next
}

export const deleteSession = (
  current: Map<string, SessionState>,
  sessionID: string,
): Map<string, SessionState> => {
  if (!current.has(sessionID)) return current
  const next = new Map(current)
  next.delete(sessionID)
  return next
}

interface ResolvedEntries {
  readonly state: SessionState
  readonly entries: ReadonlyArray<CompiledEntry>
}

const resolveEntries = (
  policy: CompiledPolicy,
  previous: SessionState | undefined,
  agent: string,
  now: number,
): ResolvedEntries | undefined => {
  const entries: ReadonlyArray<CompiledEntry> = policyFor(policy, agent) ?? []
  if (previous !== undefined && previous.agent === agent) {
    return { state: previous, entries }
  }
  if (previous === undefined && entries.length === 0) return undefined
  return {
    state: {
      agent,
      entries: freshEntries(entries, now),
      activeCalls: previous === undefined ? new Map() : previous.activeCalls,
    },
    entries,
  }
}

const applyToolBefore = (
  entries: ReadonlyArray<CompiledEntry>,
  state: SessionState,
  event: Extract<SessionEvent, { readonly type: "tool.before" }>,
): SessionState => {
  const outerTool: string | undefined = activeCall(state.activeCalls, event.call)
  const countsTool: boolean = outerTool === undefined || outerTool !== event.tool
  const entriesUpdated: ReadonlyArray<Interval> = state.entries.map(
    (current: Interval, index: number): Interval => {
      const entry: CompiledEntry | undefined = entries[index]
      if (entry === undefined) return current
      if (entry.resets(event.tool)) return interval(event.now, current.latestContext)
      if (countsTool && entry.counts(event.tool)) {
        const counts = new Map(current.toolCounts)
        counts.set(event.tool, (counts.get(event.tool) ?? 0) + 1)
        return { ...current, toolCounts: counts }
      }
      return current
    },
  )
  const activeCalls: ActiveCalls = outerTool === undefined
    ? addActiveCall(state.activeCalls, {
      messageID: event.call.messageID,
      id: event.call.id,
      tool: event.tool,
    })
    : state.activeCalls
  return { ...state, entries: entriesUpdated, activeCalls }
}

const stepToolBefore = (
  policy: CompiledPolicy,
  previous: SessionState | undefined,
  event: Extract<SessionEvent, { readonly type: "tool.before" }>,
): readonly [Step, SessionState | undefined] => {
  const resolved: ResolvedEntries | undefined = resolveEntries(
    policy,
    previous,
    event.agent,
    event.now,
  )
  if (resolved === undefined) return [CONTINUE, undefined]
  return [CONTINUE, applyToolBefore(resolved.entries, resolved.state, event)]
}

const stepToolAfter = (
  state: SessionState | undefined,
  event: Extract<SessionEvent, { readonly type: "tool.after" }>,
): readonly [Step, SessionState | undefined] => {
  if (state === undefined) return [CONTINUE, undefined]
  const outerTool: string | undefined = activeCall(state.activeCalls, event.call)
  if (outerTool === undefined || outerTool !== event.tool) return [CONTINUE, state]
  return [CONTINUE, { ...state, activeCalls: removeActiveCall(state.activeCalls, event.call) }]
}

const stepContext = (
  policy: CompiledPolicy,
  previous: SessionState | undefined,
  event: Extract<SessionEvent, { readonly type: "context" }>,
): readonly [Step, SessionState | undefined] => {
  const resolved: ResolvedEntries | undefined = resolveEntries(
    policy,
    previous,
    event.agent,
    event.now,
  )
  if (resolved === undefined) return [CONTINUE, undefined]
  const messages: Array<string> = []
  const entriesUpdated: ReadonlyArray<Interval> = resolved.state.entries.map(
    (current: Interval, index: number): Interval => {
      const entry: CompiledEntry | undefined = resolved.entries[index]
      if (entry === undefined) return current
      const measured: Interval = updateIntervalSample(current, event.sample)
      if (!entry.condition.matches(measured, event.now, event.sample)) return measured
      messages.push(entry.message)
      return interval(event.now, measured.latestContext)
    },
  )
  const nextState: SessionState = { ...resolved.state, entries: entriesUpdated }
  if (messages.length === 0) return [CONTINUE, nextState]
  return [{ type: "Emit", messages }, nextState]
}

const stepAgentSelected = (
  policy: CompiledPolicy,
  previous: SessionState | undefined,
  event: Extract<SessionEvent, { readonly type: "agent.selected" }>,
): readonly [Step, SessionState | undefined] => {
  const resolved: ResolvedEntries | undefined = resolveEntries(
    policy,
    previous,
    event.agent,
    event.now,
  )
  if (resolved === undefined) return [CONTINUE, undefined]
  return [CONTINUE, resolved.state]
}

const stepCompactionEnded = (
  state: SessionState | undefined,
): readonly [Step, SessionState | undefined] => {
  if (state === undefined) return [CONTINUE, undefined]
  return [
    CONTINUE,
    {
      ...state,
      entries: state.entries.map((current: Interval): Interval => ({
        ...current,
        contextBaseline: Option.none(),
        latestContext: Option.none(),
      })),
    },
  ]
}

export const step = (
  policy: CompiledPolicy,
  state: SessionState | undefined,
  event: SessionEvent,
): readonly [Step, SessionState | undefined] => {
  switch (event.type) {
    case "tool.before":
      return stepToolBefore(policy, state, event)
    case "tool.after":
      return stepToolAfter(state, event)
    case "context":
      return stepContext(policy, state, event)
    case "agent.selected":
      return stepAgentSelected(policy, state, event)
    case "compaction.ended":
      return stepCompactionEnded(state)
  }
}
