import type {
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client"
import { Array as Arr, Brand, Option, Order, Result } from "effect"

export interface RequestFailure {
  readonly message: string
}

export type Positive = number & Brand.Brand<"AgentsStatus.Positive">
const Positive: Brand.Constructor<Positive> = Brand.make<Positive>(
  (value: number): string | undefined => value > 0 ? undefined : "Expected a positive number",
)

export interface Sample {
  readonly model: ModelRef
  readonly tokens: Positive
}

export interface Usage extends Sample {
  readonly limit: Option.Option<Positive>
}

export type Utilization = Pick<Usage, "tokens" | "limit">

export interface History {
  readonly actual: Option.Option<ModelRef>
  readonly sample: Option.Option<Sample>
}

export type HistoryAnalysis =
  | { readonly _tag: "Settled"; readonly history: History }
  | { readonly _tag: "Earlier"; readonly actual: Option.Option<ModelRef> }

export type Catalog = ReadonlyMap<string, ReadonlyMap<string, number>>

export interface Reading {
  readonly actual: Option.Option<ModelRef>
  readonly usage: Option.Option<Usage>
  readonly catalog: Result.Result<void, RequestFailure>
}

export interface Observation {
  readonly id: string
  readonly agent: string
  readonly role: "primary" | "subagent"
  readonly selected: Option.Option<ModelRef>
  readonly outcome: Option.Option<NonNullable<SessionInfo["outcome"]>>
  readonly cost: number
  readonly reading: Result.Result<Reading, RequestFailure>
}

export interface SessionModel {
  readonly _tag: "Sessions"
  readonly label: CanonicalModelKey | "unknown"
  readonly count: SessionCount
  readonly selected: ReadonlyArray<string>
  readonly usage: Option.Option<Utilization>
  readonly unavailable: boolean
}

export interface ContextModel {
  readonly _tag: "Context"
  readonly label: CanonicalModelKey
  readonly usage: Utilization
  readonly unavailable: boolean
}

export type ModelSummary = SessionModel | ContextModel

export interface AgentSummary {
  readonly name: string
  readonly sessions: Arr.NonEmptyReadonlyArray<string>
  readonly role: Observation["role"]
  readonly cost: number
  readonly failed: number
  readonly succeeded: number
  readonly models: ReadonlyArray<ModelSummary>
}

export interface Snapshot {
  readonly agents: ReadonlyArray<AgentSummary>
  readonly cost: number
}

export type SessionCount = number & Brand.Brand<"AgentsStatus.SessionCount">
const SessionCount: Brand.Constructor<SessionCount> = Brand.nominal<SessionCount>()
const oneSession: SessionCount = SessionCount(1)
const incrementSessions = (count: SessionCount): SessionCount => SessionCount(count + 1)

type CanonicalModelKey = string & Brand.Brand<"AgentsStatus.CanonicalModelKey">
const CanonicalModelKey: Brand.Constructor<CanonicalModelKey> = Brand.nominal<CanonicalModelKey>()
const unknownModel: unique symbol = Symbol("Unknown model")
type ModelKey = CanonicalModelKey | typeof unknownModel

const canonicalModelKey = (ref: ModelRef): CanonicalModelKey =>
  CanonicalModelKey(
    `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`,
  )

const modelKey = (model: Option.Option<ModelRef>): ModelKey =>
  Option.isSome(model) ? canonicalModelKey(model.value) : unknownModel

export const usagePercent = (usage: Utilization): Option.Option<number> =>
  Option.map(
    usage.limit,
    (limit: Positive): number => contextPercent(usage.tokens, limit),
  )

export const contextPercent = (tokens: Positive, limit: Positive): number =>
  Math.round(tokens / limit * 100)

const eligibleEnd = (
  messages: ReadonlyArray<SessionMessageInfo>,
  boundary: Option.Option<string>,
): Option.Option<number> =>
  Option.match(boundary, {
    onNone: (): Option.Option<number> => Option.some(messages.length),
    onSome: (id: string): Option.Option<number> =>
      Arr.findFirstIndex(
        messages,
        (message: SessionMessageInfo): boolean => message.id === id,
      ),
  })

export const history = (
  messages: ReadonlyArray<SessionMessageInfo>,
  boundary: Option.Option<string>,
): HistoryAnalysis => {
  const actual: Option.Option<ModelRef> = Arr.findLast(
    messages,
    (message: SessionMessageInfo): message is SessionMessageAssistant =>
      message.type === "assistant",
  ).pipe(
    Option.map((message: SessionMessageAssistant): ModelRef => message.model),
  )
  return Option.match(eligibleEnd(messages, boundary), {
    onNone: (): HistoryAnalysis => ({ _tag: "Earlier", actual }),
    onSome: (end: number): HistoryAnalysis =>
      Option.match(
        Arr.findLast(
          messages,
          (message: SessionMessageInfo, index: number): message is
            | (SessionMessageAssistant & { readonly tokens: TokenUsageInfo })
            | (Extract<SessionMessageInfo, { readonly type: "compaction" }> & {
              readonly status: "completed"
            }) =>
            index < end && (message.type === "assistant" && message.tokens !== undefined
              || message.type === "compaction" && message.status === "completed"),
        ),
        {
          onNone: (): HistoryAnalysis => ({ _tag: "Earlier", actual }),
          onSome: (message): HistoryAnalysis => {
            if (message.type === "compaction") {
              return { _tag: "Settled", history: { actual, sample: Option.none() } }
            }
            const tokens: number = message.tokens.input + message.tokens.output
              + message.tokens.reasoning
              + message.tokens.cache.read + message.tokens.cache.write
            const sample: Option.Option<Sample> = Option.map(
              Positive.option(tokens),
              (value: Positive): Sample => ({ model: message.model, tokens: value }),
            )
            return { _tag: "Settled", history: { actual, sample } }
          },
        },
      ),
  })
}

export const catalog = (models: ReadonlyArray<ModelInfo>): Catalog => {
  const providers: Map<string, Map<string, number>> = new Map()
  for (const model of models) {
    const entries: Map<string, number> = providers.get(model.providerID) ?? new Map()
    if (!entries.has(model.id)) entries.set(model.id, model.limit.context)
    providers.set(model.providerID, entries)
  }
  return providers
}

export const reading = (
  value: History,
  models: Result.Result<Catalog, RequestFailure>,
): Reading => ({
  actual: value.actual,
  usage: Option.map(value.sample, (sample: Sample): Usage => ({
    ...sample,
    limit: Result.getSuccess(models).pipe(
      Option.flatMap((entries: Catalog): Option.Option<ReadonlyMap<string, number>> =>
        Option.fromUndefinedOr(entries.get(sample.model.providerID))
      ),
      Option.flatMap((entries: ReadonlyMap<string, number>): Option.Option<number> =>
        Option.fromUndefinedOr(entries.get(sample.model.id))
      ),
      Option.flatMap((limit: number): Option.Option<Positive> => Positive.option(limit)),
    ),
  })),
  catalog: Result.map(models, (): void => undefined),
})

export const observe = (
  session: SessionInfo,
  rootID: string,
  value: Result.Result<Reading, RequestFailure>,
): Observation => ({
  id: session.id,
  agent: session.agent ?? "Unknown agent",
  role: session.id === rootID ? "primary" : "subagent",
  selected: Option.fromUndefinedOr(session.model),
  outcome: Option.fromUndefinedOr(session.outcome),
  cost: session.cost,
  reading: value,
})

interface SessionBuilder {
  count: SessionCount
  readonly selected: Set<CanonicalModelKey>
  unavailable: boolean
}

interface ContextBuilder {
  usage: Usage
  unavailable: boolean
}

interface AgentBuilder {
  readonly name: string
  readonly sessions: Arr.NonEmptyArray<string>
  role: Observation["role"]
  cost: number
  failed: number
  succeeded: number
  readonly models: Map<ModelKey, SessionBuilder>
  readonly contexts: Map<CanonicalModelKey, ContextBuilder>
}

const percentageOrder: Order.Order<Usage> = (left: Usage, right: Usage): -1 | 0 | 1 => {
  if (Option.isSome(left.limit)) {
    return Option.isSome(right.limit)
      ? Order.Number(
        contextPercent(left.tokens, left.limit.value),
        contextPercent(right.tokens, right.limit.value),
      )
      : 1
  }
  return Option.isSome(right.limit) ? -1 : 0
}

const peak = (left: Usage, right: Usage): Usage => {
  const order: number = percentageOrder(right, left)
  return order > 0 || order === 0 && right.tokens > left.tokens ? right : left
}

const addModel = (
  agent: Pick<AgentBuilder, "models" | "contexts">,
  model: Option.Option<ModelRef>,
  selected: Option.Option<ModelRef>,
  usage: Option.Option<Usage>,
  unavailable: boolean,
): void => {
  const key: ModelKey = modelKey(model)
  const existing: SessionBuilder | undefined = agent.models.get(key)
  const current: SessionBuilder = existing
    ?? { count: oneSession, selected: new Set(), unavailable }
  if (existing !== undefined) {
    current.count = incrementSessions(current.count)
    current.unavailable ||= unavailable
  }
  if (Option.isSome(selected)) current.selected.add(canonicalModelKey(selected.value))
  agent.models.set(key, current)
  if (Option.isSome(usage)) {
    const sample: Usage = usage.value
    const label: CanonicalModelKey = canonicalModelKey(sample.model)
    const previous: ContextBuilder | undefined = agent.contexts.get(label)
    const context: ContextBuilder = previous ?? { usage: sample, unavailable }
    if (previous !== undefined) {
      context.usage = peak(context.usage, sample)
      context.unavailable ||= unavailable
    }
    agent.contexts.set(label, context)
  }
}

const projectAgent = (agent: AgentBuilder): AgentSummary => {
  const models: Array<ModelSummary> = []
  for (const [label, group] of agent.models) {
    const sample: ContextBuilder | undefined = label === unknownModel
      ? undefined
      : agent.contexts.get(label)
    models.push({
      _tag: "Sessions",
      label: label === unknownModel ? "unknown" : label,
      count: group.count,
      selected: Array.from(group.selected),
      usage: sample === undefined
        ? Option.none()
        : Option.some({ tokens: sample.usage.tokens, limit: sample.usage.limit }),
      unavailable: group.unavailable || sample?.unavailable === true,
    })
  }
  for (const [label, group] of agent.contexts) {
    if (!agent.models.has(label)) {
      models.push({
        _tag: "Context",
        label,
        usage: { tokens: group.usage.tokens, limit: group.usage.limit },
        unavailable: group.unavailable,
      })
    }
  }
  return {
    name: agent.name,
    sessions: agent.sessions,
    role: agent.role,
    cost: agent.cost,
    failed: agent.failed,
    succeeded: agent.succeeded,
    models,
  }
}

export const summarize = (observations: ReadonlyArray<Observation>): Snapshot => {
  const agents: Map<string, AgentBuilder> = new Map()
  let cost: number = 0
  for (const observation of observations) {
    const existing: AgentBuilder | undefined = agents.get(observation.agent)
    const agent: AgentBuilder = existing ?? {
      name: observation.agent,
      sessions: [observation.id],
      role: observation.role,
      cost: 0,
      failed: 0,
      succeeded: 0,
      models: new Map(),
      contexts: new Map(),
    }
    if (existing !== undefined) {
      agent.sessions.push(observation.id)
      if (observation.role === "primary") agent.role = "primary"
    }
    agent.cost += observation.cost
    cost += observation.cost
    if (Option.isSome(observation.outcome)) {
      const outcome: NonNullable<SessionInfo["outcome"]> = observation.outcome.value
      if (outcome === "failed" || outcome === "interrupted") agent.failed++
      if (outcome === "succeeded") agent.succeeded++
    }
    if (Result.isFailure(observation.reading)) {
      addModel(agent, Option.none(), observation.selected, Option.none(), true)
    } else {
      const value: Reading = observation.reading.success
      const primary: Option.Option<ModelRef> = Option.isSome(value.actual)
        ? value.actual
        : observation.selected
      const selected: Option.Option<ModelRef> =
        Option.isSome(value.actual) && Option.isSome(observation.selected)
          && canonicalModelKey(value.actual.value) !== canonicalModelKey(observation.selected.value)
          ? observation.selected
          : Option.none()
      addModel(
        agent,
        primary,
        selected,
        value.usage,
        Result.isFailure(value.catalog),
      )
    }
    agents.set(observation.agent, agent)
  }
  return { agents: Array.from(agents.values(), projectAgent), cost }
}
