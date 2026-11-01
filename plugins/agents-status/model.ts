import type {
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client"
import { Array as Arr, Brand, Option, Order, Result } from "effect"
import type { Price } from "./rpc.ts"

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

export type SpendModelKey = string & Brand.Brand<"AgentsStatus.SpendModelKey">
const SpendModelKey: Brand.Constructor<SpendModelKey> = Brand.nominal<SpendModelKey>()

export const modelPriceKey = (model: Pick<ModelRef, "providerID" | "id">): SpendModelKey =>
  SpendModelKey(`${model.providerID}/${model.id}`)

export type PriceCatalog = ReadonlyMap<SpendModelKey, ReadonlyArray<Price>>

export interface Reading {
  readonly actual: Option.Option<ModelRef>
  readonly usage: Option.Option<Usage>
  readonly catalog: Result.Result<void, RequestFailure>
  readonly messages: ReadonlyArray<SessionMessageInfo>
}

export type Fork = NonNullable<SessionInfo["fork"]>

export interface Observation {
  readonly id: string
  readonly title: Option.Option<string>
  readonly agent: string
  readonly role: "primary" | "subagent"
  readonly selected: Option.Option<ModelRef>
  readonly outcome: Option.Option<NonNullable<SessionInfo["outcome"]>>
  readonly tokens: Option.Option<TokenUsageInfo>
  readonly created: number
  readonly fork: Option.Option<Fork>
  readonly reading: Result.Result<Reading, RequestFailure>
  readonly prices: Result.Result<PriceCatalog, RequestFailure>
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

export type SpendUsage =
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Incomplete"; readonly reason: string }
  | { readonly _tag: "Unavailable"; readonly reason: string }

export type SpendAmount =
  | { readonly _tag: "Estimated"; readonly usd: number }
  | { readonly _tag: "Unavailable"; readonly reason: string }

export type SpendSource =
  | { readonly _tag: "Model"; readonly model: ModelRef }
  | { readonly _tag: "Unattributed" }

export type SpendAttribution =
  | { readonly _tag: "StableSession" }
  | { readonly _tag: "MixedModelSession" }

const stableSession: SpendAttribution = { _tag: "StableSession" }
const mixedModelSession: SpendAttribution = { _tag: "MixedModelSession" }

const mergeAttribution = (
  left: SpendAttribution,
  right: SpendAttribution,
): SpendAttribution =>
  left._tag === "MixedModelSession" || right._tag === "MixedModelSession"
    ? mixedModelSession
    : stableSession

export interface SpendRow {
  readonly source: SpendSource
  readonly tokens: TokenUsageInfo
  readonly amount: SpendAmount
  readonly attribution: SpendAttribution
}

export type SpendTotal =
  | { readonly _tag: "Estimated"; readonly usd: number }
  | { readonly _tag: "Partial"; readonly usd: number }
  | { readonly _tag: "Unavailable"; readonly reason: string }

export interface SpendBreakdown {
  readonly rows: ReadonlyArray<SpendRow>
  readonly usage: SpendUsage
  readonly total: SpendTotal
  readonly usedModels: number
  readonly attribution: SpendAttribution
}

export interface AgentSummary {
  readonly name: string
  readonly sessions: Arr.NonEmptyReadonlyArray<string>
  readonly role: Observation["role"]
  readonly tokens: Option.Option<TokenUsageInfo>
  readonly spend: SpendBreakdown
  readonly failed: number
  readonly succeeded: number
  readonly models: ReadonlyArray<ModelSummary>
}

export interface Snapshot {
  readonly agents: ReadonlyArray<AgentSummary>
  readonly sessions: ReadonlyArray<SessionSummary>
  readonly spend: SpendBreakdown
  readonly tokens: Option.Option<TokenUsageInfo>
}

export interface SessionSummary extends AgentSummary {
  readonly id: string
  readonly title: Option.Option<string>
  readonly outcome: Observation["outcome"]
}

export type SessionCount = number & Brand.Brand<"AgentsStatus.SessionCount">
const SessionCount: Brand.Constructor<SessionCount> = Brand.nominal<SessionCount>()
const oneSession: SessionCount = SessionCount(1)
const incrementSessions = (count: SessionCount): SessionCount => SessionCount(count + 1)

type CanonicalModelKey = string & Brand.Brand<"AgentsStatus.CanonicalModelKey">
const CanonicalModelKey: Brand.Constructor<CanonicalModelKey> = Brand.nominal<CanonicalModelKey>()
const unknownModel: unique symbol = Symbol("Unknown model")
type ModelKey = CanonicalModelKey | typeof unknownModel
const unattributed: unique symbol = Symbol("Unattributed")

const canonicalModelKey = (ref: ModelRef): CanonicalModelKey =>
  CanonicalModelKey(
    `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`,
  )

const modelKey = (model: Option.Option<ModelRef>): ModelKey =>
  Option.isSome(model) ? canonicalModelKey(model.value) : unknownModel

export const usagePercent = (usage: Utilization): Option.Option<number> =>
  Option.map(
    usage.limit,
    (limit) => contextPercent(usage.tokens, limit),
  )

export const contextPercent = (tokens: Positive, limit: Positive): number =>
  Math.round(tokens / limit * 100)

const eligibleEnd = (
  messages: ReadonlyArray<SessionMessageInfo>,
  boundary: Option.Option<string>,
): Option.Option<number> =>
  Option.match(boundary, {
    onNone: () => Option.some(messages.length),
    onSome: (id) =>
      Arr.findFirstIndex(
        messages,
        (message) => message.id === id,
      ),
  })

export const history = (
  messages: ReadonlyArray<SessionMessageInfo>,
  boundary: Option.Option<string>,
): HistoryAnalysis => {
  const actual = Arr.findLast(
    messages,
    (message): message is SessionMessageAssistant => message.type === "assistant",
  ).pipe(
    Option.map((message) => message.model),
  )
  return Option.match(eligibleEnd(messages, boundary), {
    onNone: () => ({ _tag: "Earlier", actual }),
    onSome: (end) =>
      Option.match(
        Arr.findLast(
          messages,
          (message, index): message is
            | (SessionMessageAssistant & { readonly tokens: TokenUsageInfo })
            | (Extract<SessionMessageInfo, { readonly type: "compaction" }> & {
              readonly status: "completed"
            }) =>
            index < end && (message.type === "assistant" && message.tokens !== undefined
              || message.type === "compaction" && message.status === "completed"),
        ),
        {
          onNone: () => ({ _tag: "Earlier", actual }),
          onSome: (message) => {
            if (message.type === "compaction") {
              return { _tag: "Settled", history: { actual, sample: Option.none() } }
            }
            const tokens = message.tokens.input + message.tokens.output
              + message.tokens.reasoning
              + message.tokens.cache.read + message.tokens.cache.write
            const sample = Option.map(
              Positive.option(tokens),
              (value) => ({ model: message.model, tokens: value }),
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
  messages: ReadonlyArray<SessionMessageInfo>,
): Reading => ({
  actual: value.actual,
  usage: Option.map(value.sample, (sample) => ({
    ...sample,
    limit: Result.getSuccess(models).pipe(
      Option.flatMap((entries) => Option.fromUndefinedOr(entries.get(sample.model.providerID))),
      Option.flatMap((entries) => Option.fromUndefinedOr(entries.get(sample.model.id))),
      Option.flatMap((limit) => Positive.option(limit)),
    ),
  })),
  catalog: Result.map(models, (): void => undefined),
  messages,
})

export const observe = (
  session: SessionInfo,
  rootID: string,
  value: Result.Result<Reading, RequestFailure>,
  prices: Result.Result<PriceCatalog, RequestFailure>,
): Observation => ({
  id: session.id,
  title: Option.fromUndefinedOr(session.title),
  agent: session.agent ?? "Unknown agent",
  role: session.id === rootID ? "primary" : "subagent",
  selected: Option.fromUndefinedOr(session.model),
  outcome: Option.fromUndefinedOr(session.outcome),
  tokens: Option.fromUndefinedOr(session.tokens),
  created: session.time.created,
  fork: Option.fromUndefinedOr(session.fork),
  reading: value,
  prices,
})

interface TokenTotals {
  usage: TokenUsageInfo
  known: boolean
}

const zeroTokens: TokenUsageInfo = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const emptyTokens = (): TokenUsageInfo => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

const tokenTotals = (): TokenTotals => ({ usage: zeroTokens, known: true })

const addTokens = (totals: TokenTotals, tokens: Option.Option<TokenUsageInfo>): void => {
  if (Option.isNone(tokens)) {
    totals.known = false
    return
  }
  const value = tokens.value
  totals.usage = {
    input: totals.usage.input + value.input,
    output: totals.usage.output + value.output,
    reasoning: totals.usage.reasoning + value.reasoning,
    cache: {
      read: totals.usage.cache.read + value.cache.read,
      write: totals.usage.cache.write + value.cache.write,
    },
  }
}

const knownTokens = (totals: TokenTotals): Option.Option<TokenUsageInfo> =>
  totals.known ? Option.some(totals.usage) : Option.none()

const addUsage = (left: TokenUsageInfo, right: TokenUsageInfo): TokenUsageInfo => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cache: {
    read: left.cache.read + right.cache.read,
    write: left.cache.write + right.cache.write,
  },
})

const zeroUsage = (tokens: TokenUsageInfo): boolean =>
  tokens.input === 0
  && tokens.output === 0
  && tokens.reasoning === 0
  && tokens.cache.read === 0
  && tokens.cache.write === 0

interface SignedUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

const subtractUsage = (left: TokenUsageInfo, right: TokenUsageInfo): SignedUsage => ({
  input: left.input - right.input,
  output: left.output - right.output,
  reasoning: left.reasoning - right.reasoning,
  cache: {
    read: left.cache.read - right.cache.read,
    write: left.cache.write - right.cache.write,
  },
})

const addSignedUsage = (left: SignedUsage, right: SignedUsage): SignedUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cache: {
    read: left.cache.read + right.cache.read,
    write: left.cache.write + right.cache.write,
  },
})

const positiveUsage = (value: SignedUsage): TokenUsageInfo => ({
  input: Math.max(0, value.input),
  output: Math.max(0, value.output),
  reasoning: Math.max(0, value.reasoning),
  cache: {
    read: Math.max(0, value.cache.read),
    write: Math.max(0, value.cache.write),
  },
})

const negativeUsage = (value: SignedUsage): TokenUsageInfo => ({
  input: Math.max(0, -value.input),
  output: Math.max(0, -value.output),
  reasoning: Math.max(0, -value.reasoning),
  cache: {
    read: Math.max(0, -value.cache.read),
    write: Math.max(0, -value.cache.write),
  },
})

const signedIsZero = (value: SignedUsage): boolean =>
  value.input === 0
  && value.output === 0
  && value.reasoning === 0
  && value.cache.read === 0
  && value.cache.write === 0

const usageFromSigned = (value: SignedUsage): Option.Option<TokenUsageInfo> =>
  value.input < 0
    || value.output < 0
    || value.reasoning < 0
    || value.cache.read < 0
    || value.cache.write < 0
    ? Option.none()
    : Option.some({
      input: value.input,
      output: value.output,
      reasoning: value.reasoning,
      cache: { read: value.cache.read, write: value.cache.write },
    })

interface RecordedUsage {
  readonly model: Option.Option<ModelRef>
  readonly tokens: TokenUsageInfo
  readonly aggregatedCalls: boolean
}

const recordedUsage = (message: SessionMessageInfo): Option.Option<RecordedUsage> => {
  switch (message.type) {
    case "assistant":
      return Option.map(
        Option.fromUndefinedOr(message.tokens),
        (tokens) => ({
          model: Option.some(message.model),
          tokens,
          aggregatedCalls: false,
        }),
      )
    case "compaction":
      if (message.status === "running" || message.tokens === undefined) return Option.none()
      return Option.some({
        model: message.status === "completed"
          ? Option.fromUndefinedOr(message.model)
          : Option.none(),
        tokens: message.tokens,
        aggregatedCalls: true,
      })
    default:
      return Option.none()
  }
}

interface RetainedMessages {
  readonly messages: ReadonlyArray<SessionMessageInfo>
  readonly usage: SpendUsage
}

const retainForkMessages = (
  messages: ReadonlyArray<SessionMessageInfo>,
  fork: Option.Option<Fork>,
  created: number,
): RetainedMessages => {
  if (Option.isNone(fork)) return { messages, usage: { _tag: "Complete" } }
  const boundary = fork.value.boundary
  if (
    fork.value.sessionID.length === 0
    || boundary.messageID.length === 0
    || !Number.isFinite(created)
    || created <= 0
  ) {
    return {
      messages,
      usage: { _tag: "Incomplete", reason: "fork history boundary is ambiguous" },
    }
  }
  return {
    messages: messages.filter((message) => message.time.created >= created),
    usage: { _tag: "Complete" },
  }
}

const priceFor = (
  costs: ReadonlyArray<Price>,
  context: number,
): Option.Option<Price> => {
  let tiered: Option.Option<{ readonly price: Price; readonly size: number }> = Option.none()
  for (const cost of costs) {
    const tier = cost.tier
    if (tier === undefined || context <= tier.size) continue
    if (Option.isNone(tiered) || tier.size > tiered.value.size) {
      tiered = Option.some({ price: cost, size: tier.size })
    }
  }
  if (Option.isSome(tiered)) return Option.some(tiered.value.price)
  return Option.fromUndefinedOr(costs.find((cost) => cost.tier === undefined))
}

export const estimateCost = (
  tokens: TokenUsageInfo,
  costs: ReadonlyArray<Price>,
): Option.Option<number> => {
  if (zeroUsage(tokens)) return Option.some(0)
  if (costs.length === 0) return Option.none()
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  return Option.map(priceFor(costs, context), (price) => linearCost(tokens, price))
}

const basePrice = (costs: ReadonlyArray<Price>): Option.Option<Price> =>
  Option.fromUndefinedOr(costs.find((cost) => cost.tier === undefined))

const linearCost = (tokens: TokenUsageInfo, price: Price): number =>
  (tokens.input * price.input
    + (tokens.output + tokens.reasoning) * price.output
    + tokens.cache.read * price.cache.read
    + tokens.cache.write * price.cache.write) / 1_000_000

const compactionTierGap: string = "per-call compaction usage unavailable for tier pricing"

const spendAmount = (
  tokens: TokenUsageInfo,
  prices: Result.Result<PriceCatalog, RequestFailure>,
  model: ModelRef,
  aggregatedCalls: boolean,
): SpendAmount => {
  if (zeroUsage(tokens)) return { _tag: "Estimated", usd: 0 }
  return Result.match(prices, {
    onFailure: (failure) => ({
      _tag: "Unavailable",
      reason: `price data unavailable: ${failure.message}`,
    }),
    onSuccess: (catalog) => {
      const costs = catalog.get(modelPriceKey(model))
      if (costs === undefined || costs.length === 0) {
        return { _tag: "Unavailable", reason: "no catalog price" }
      }
      if (aggregatedCalls) {
        const context = tokens.input + tokens.cache.read + tokens.cache.write
        if (costs.some((cost) => cost.tier !== undefined && context > cost.tier.size)) {
          return { _tag: "Unavailable", reason: compactionTierGap }
        }
      }
      return Option.match(estimateCost(tokens, costs), {
        onNone: () => ({ _tag: "Unavailable", reason: "no applicable catalog price" }),
        onSome: (usd) => ({ _tag: "Estimated", usd }),
      })
    },
  })
}

const correctionAmount = (
  delta: SignedUsage,
  prices: Result.Result<PriceCatalog, RequestFailure>,
  model: ModelRef,
): SpendAmount => {
  const positive = positiveUsage(delta)
  const negative = negativeUsage(delta)
  if (zeroUsage(positive) && zeroUsage(negative)) return { _tag: "Estimated", usd: 0 }
  return Result.match(prices, {
    onFailure: (failure) => ({
      _tag: "Unavailable",
      reason: `price data unavailable: ${failure.message}`,
    }),
    onSuccess: (catalog) => {
      const costs = catalog.get(modelPriceKey(model))
      if (costs === undefined || costs.length === 0) {
        return { _tag: "Unavailable", reason: "no catalog price" }
      }
      return Option.match(basePrice(costs), {
        onNone: () => ({ _tag: "Unavailable", reason: "no applicable catalog price" }),
        onSome: (price) => ({
          _tag: "Estimated",
          usd: linearCost(positive, price) - linearCost(negative, price),
        }),
      })
    },
  })
}

export interface SpendInput {
  readonly selected: Option.Option<ModelRef>
  readonly aggregate: Option.Option<TokenUsageInfo>
  readonly reading: Result.Result<Reading, RequestFailure>
  readonly prices: Result.Result<PriceCatalog, RequestFailure>
  readonly fork: Option.Option<Fork>
  readonly created: number
}

interface SpendGroup {
  readonly model: ModelRef
  tokens: TokenUsageInfo
  amount: SpendAmount
}

const breakdown = (
  rows: ReadonlyArray<SpendRow>,
  usage: SpendUsage,
): SpendBreakdown => {
  let usd = 0
  let firstUnavailable: Option.Option<string> = Option.none()
  let usedModels = 0
  let pricedModelUsage = false
  let attribution: SpendAttribution = stableSession
  for (const row of rows) {
    if (row.amount._tag === "Estimated") {
      usd += row.amount.usd
    } else if (Option.isNone(firstUnavailable)) {
      firstUnavailable = Option.some(row.amount.reason)
    }
    if (row.source._tag === "Model" && !zeroUsage(row.tokens)) {
      usedModels += 1
      if (row.amount._tag === "Estimated") pricedModelUsage = true
    }
    attribution = mergeAttribution(attribution, row.attribution)
  }
  const total: SpendTotal = usage._tag === "Complete" && Option.isNone(firstUnavailable)
    ? { _tag: "Estimated", usd }
    : pricedModelUsage
    ? { _tag: "Partial", usd }
    : {
      _tag: "Unavailable",
      reason: Option.match(firstUnavailable, {
        onNone: () =>
          usage._tag === "Complete"
            ? "recorded usage could not be priced"
            : usage.reason,
        onSome: (reason) => reason,
      }),
    }
  return { rows, usage, total, usedModels, attribution }
}

export const emptySpend: SpendBreakdown = breakdown([], { _tag: "Complete" })

const currentModel = (input: SpendInput): Option.Option<ModelRef> =>
  Option.isSome(input.selected)
    ? input.selected
    : Result.match(input.reading, {
      onFailure: () => Option.none(),
      onSuccess: (reading) => reading.actual,
    })

export const spendBreakdown = (input: SpendInput): SpendBreakdown => {
  const current = currentModel(input)
  if (
    Result.isFailure(input.reading)
    && (Option.isNone(input.aggregate) || Option.isNone(current))
  ) {
    return breakdown([], {
      _tag: "Unavailable",
      reason: `message history unavailable: ${input.reading.failure.message}`,
    })
  }
  const retained = Result.match(input.reading, {
    onFailure: (): RetainedMessages => ({
      messages: [],
      usage: { _tag: "Complete" },
    }),
    onSuccess: (reading) =>
      retainForkMessages(
        reading.messages,
        input.fork,
        input.created,
      ),
  })
  const groups: Map<SpendModelKey, SpendGroup> = new Map()
  let attributed = emptyTokens()
  let unattributedTokens = emptyTokens()
  let hasUnattributed = false
  for (const message of retained.messages) {
    const usage = recordedUsage(message)
    if (Option.isNone(usage)) continue
    const value = usage.value
    if (zeroUsage(value.tokens)) continue
    if (Option.isSome(value.model)) {
      const model = value.model.value
      const key = modelPriceKey(model)
      attributed = addUsage(attributed, value.tokens)
      const amount = spendAmount(value.tokens, input.prices, model, value.aggregatedCalls)
      const group = groups.get(key)
      if (group === undefined) {
        groups.set(key, { model, tokens: { ...value.tokens }, amount })
      } else {
        group.tokens = addUsage(group.tokens, value.tokens)
        group.amount = mergeAmount(group.amount, amount)
      }
    } else {
      unattributedTokens = addUsage(unattributedTokens, value.tokens)
      hasUnattributed = true
    }
  }

  let usage = retained.usage
  let residualAssigned = false
  const unavailable = "session token totals unavailable"
  if (Option.isNone(input.aggregate)) {
    const known = groups.size > 0 || hasUnattributed
    usage = mergeUsage(
      usage,
      known
        ? { _tag: "Incomplete", reason: unavailable }
        : { _tag: "Unavailable", reason: unavailable },
    )
  } else {
    const delta = subtractUsage(input.aggregate.value, attributed)
    if (!signedIsZero(delta) && Option.isSome(current)) {
      const model = current.value
      const key = modelPriceKey(model)
      const existing = groups.get(key)
      const correction = correctionAmount(delta, input.prices, model)
      const unpricedResidual = existing !== undefined
        && existing.amount._tag === "Estimated"
        && correction._tag === "Unavailable"
      if (unpricedResidual) {
        usage = mergeUsage(usage, {
          _tag: "Incomplete",
          reason:
            "current-model residual tokens could not be priced; recorded usage is a partial estimate",
        })
      } else {
        const adjusted = usageFromSigned(addSignedUsage(existing?.tokens ?? zeroTokens, delta))
        const negativeSpend = existing !== undefined
          && existing.amount._tag === "Estimated"
          && correction._tag === "Estimated"
          && existing.amount.usd + correction.usd < 0
        if (Option.isSome(adjusted) && !negativeSpend) {
          residualAssigned = true
          if (existing === undefined) {
            groups.set(key, { model, tokens: adjusted.value, amount: correction })
          } else {
            existing.tokens = adjusted.value
            existing.amount = mergeAmount(existing.amount, correction)
          }
        } else {
          usage = mergeUsage(usage, {
            _tag: "Incomplete",
            reason:
              "session totals cannot be reconciled with current-model usage; recorded usage is a partial estimate",
          })
        }
      }
    } else if (!signedIsZero(delta)) {
      const missing = positiveUsage(
        subtractUsage(
          input.aggregate.value,
          addUsage(attributed, unattributedTokens),
        ),
      )
      if (!zeroUsage(missing)) {
        unattributedTokens = addUsage(unattributedTokens, missing)
        hasUnattributed = true
      }
      usage = mergeUsage(usage, {
        _tag: "Incomplete",
        reason: "session usage includes tokens absent from retained messages",
      })
    }
  }
  if (residualAssigned) hasUnattributed = false

  const attribution = groups.size > 1 ? mixedModelSession : stableSession
  const rows: Array<SpendRow> = []
  for (const group of groups.values()) {
    rows.push({
      source: { _tag: "Model", model: group.model },
      tokens: group.tokens,
      amount: group.amount,
      attribution,
    })
  }
  if (hasUnattributed) {
    rows.push({
      source: { _tag: "Unattributed" },
      tokens: unattributedTokens,
      amount: { _tag: "Unavailable", reason: "usage could not be attributed to a model" },
      attribution,
    })
  }
  if (
    rows.length === 0
    && Option.isSome(input.aggregate)
    && zeroUsage(input.aggregate.value)
    && Option.isSome(current)
  ) {
    rows.push({
      source: { _tag: "Model", model: current.value },
      tokens: emptyTokens(),
      amount: { _tag: "Estimated", usd: 0 },
      attribution,
    })
  }
  return breakdown(rows, usage)
}

const mergeUsage = (left: SpendUsage, right: SpendUsage): SpendUsage => {
  if (left._tag === "Unavailable") return left
  if (right._tag === "Unavailable") return right
  if (left._tag === "Incomplete") return left
  if (right._tag === "Incomplete") return right
  return left
}

const mergeAmount = (left: SpendAmount, right: SpendAmount): SpendAmount => {
  if (left._tag === "Unavailable") return left
  if (right._tag === "Unavailable") return right
  return { _tag: "Estimated", usd: left.usd + right.usd }
}

interface SpendRowBuilder {
  readonly source: SpendSource
  tokens: TokenUsageInfo
  amount: SpendAmount
  attribution: SpendAttribution
}

interface SpendAccumulator {
  readonly rows: Map<SpendModelKey | typeof unattributed, SpendRowBuilder>
  usage: SpendUsage
}

const newSpendAccumulator = (): SpendAccumulator => ({
  rows: new Map(),
  usage: { _tag: "Complete" },
})

const addSpendBreakdown = (accumulator: SpendAccumulator, value: SpendBreakdown): void => {
  accumulator.usage = mergeUsage(accumulator.usage, value.usage)
  for (const row of value.rows) {
    const key = row.source._tag === "Model" ? modelPriceKey(row.source.model) : unattributed
    const existing = accumulator.rows.get(key)
    if (existing === undefined) {
      accumulator.rows.set(key, {
        source: row.source,
        tokens: { ...row.tokens },
        amount: row.amount,
        attribution: row.attribution,
      })
    } else {
      existing.tokens = addUsage(existing.tokens, row.tokens)
      existing.amount = mergeAmount(existing.amount, row.amount)
      existing.attribution = mergeAttribution(existing.attribution, row.attribution)
    }
  }
}

const projectSpend = (accumulator: SpendAccumulator): SpendBreakdown =>
  breakdown(Array.from(accumulator.rows.values()), accumulator.usage)

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
  readonly tokens: TokenTotals
  readonly spend: SpendAccumulator
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
  const order = percentageOrder(right, left)
  return order > 0 || order === 0 && right.tokens > left.tokens ? right : left
}

const addModel = (
  agent: Pick<AgentBuilder, "models" | "contexts">,
  model: Option.Option<ModelRef>,
  selected: Option.Option<ModelRef>,
  usage: Option.Option<Usage>,
  unavailable: boolean,
): void => {
  const key = modelKey(model)
  const existing = agent.models.get(key)
  const current: SessionBuilder = existing
    ?? { count: oneSession, selected: new Set(), unavailable }
  if (existing !== undefined) {
    current.count = incrementSessions(current.count)
    current.unavailable ||= unavailable
  }
  if (Option.isSome(selected)) current.selected.add(canonicalModelKey(selected.value))
  agent.models.set(key, current)
  if (Option.isSome(usage)) {
    const sample = usage.value
    const label = canonicalModelKey(sample.model)
    const previous = agent.contexts.get(label)
    const context = previous ?? { usage: sample, unavailable }
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
    const sample = label === unknownModel
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
    tokens: knownTokens(agent.tokens),
    spend: projectSpend(agent.spend),
    failed: agent.failed,
    succeeded: agent.succeeded,
    models,
  }
}

const newAgent = (observation: Observation): AgentBuilder => ({
  name: observation.agent,
  sessions: [observation.id],
  role: observation.role,
  tokens: tokenTotals(),
  spend: newSpendAccumulator(),
  failed: 0,
  succeeded: 0,
  models: new Map(),
  contexts: new Map(),
})

const record = (
  agent: AgentBuilder,
  observation: Observation,
  spend: SpendBreakdown,
): void => {
  addTokens(agent.tokens, observation.tokens)
  addSpendBreakdown(agent.spend, spend)
  if (Option.isSome(observation.outcome)) {
    const outcome = observation.outcome.value
    if (outcome === "failed" || outcome === "interrupted") agent.failed++
    if (outcome === "succeeded") agent.succeeded++
  }
  if (Result.isFailure(observation.reading)) {
    addModel(agent, Option.none(), observation.selected, Option.none(), true)
  } else {
    const value = observation.reading.success
    const primary = Option.isSome(value.actual)
      ? value.actual
      : observation.selected
    const selected = Option.isSome(value.actual) && Option.isSome(observation.selected)
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
}

export const summarize = (observations: ReadonlyArray<Observation>): Snapshot => {
  const agents: Map<string, AgentBuilder> = new Map()
  const sessions: Array<SessionSummary> = []
  const tokens = tokenTotals()
  const spend = newSpendAccumulator()
  for (const observation of observations) {
    const existing = agents.get(observation.agent)
    const agent = existing ?? newAgent(observation)
    if (existing !== undefined) {
      agent.sessions.push(observation.id)
      if (observation.role === "primary") agent.role = "primary"
    }
    const observationSpend = spendBreakdown({
      selected: observation.selected,
      aggregate: observation.tokens,
      reading: observation.reading,
      prices: observation.prices,
      fork: observation.fork,
      created: observation.created,
    })
    record(agent, observation, observationSpend)
    agents.set(observation.agent, agent)
    const individual = newAgent(observation)
    record(individual, observation, observationSpend)
    sessions.push({
      ...projectAgent(individual),
      id: observation.id,
      title: observation.title,
      outcome: observation.outcome,
    })
    addTokens(tokens, observation.tokens)
    addSpendBreakdown(spend, observationSpend)
  }
  return {
    agents: Array.from(agents.values(), projectAgent),
    sessions,
    spend: projectSpend(spend),
    tokens: knownTokens(tokens),
  }
}
