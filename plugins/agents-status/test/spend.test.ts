import type {
  ModelRef,
  SessionMessageAssistant,
  SessionMessageCompactionCompleted,
  SessionMessageCompactionFailed,
  SessionMessageCompactionRunning,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client"
import { expect, test } from "bun:test"
import { Option, Result } from "effect"
import {
  estimateCost,
  modelPriceKey,
  type Observation,
  type PriceCatalog,
  type Reading,
  spendBreakdown,
  type SpendInput,
  summarize,
} from "../model.ts"
import type { Price } from "../rpc.ts"

const TOKENS = (
  input: number,
  output: number,
  reasoning: number,
  read: number,
  write: number,
): TokenUsageInfo => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

const ZERO_TOKENS: TokenUsageInfo = TOKENS(0, 0, 0, 0, 0)

const PRICE: Price = {
  input: 1,
  output: 2,
  cache: { read: 0.5, write: 0.25 },
}

const TIERED: ReadonlyArray<Price> = [
  PRICE,
  {
    input: 2,
    output: 2,
    cache: { read: 0.5, write: 0.25 },
    tier: { type: "context", size: 272_000 },
  },
  {
    input: 4,
    output: 2,
    cache: { read: 0.5, write: 0.25 },
    tier: { type: "context", size: 500_000 },
  },
]

const MODEL: ModelRef = { providerID: "acme", id: "model" }
const OTHER: ModelRef = { providerID: "acme", id: "other" }

const assistant = (
  id: string,
  tokens: TokenUsageInfo,
  model: ModelRef,
  created: number = 0,
): SessionMessageAssistant => ({
  id,
  time: { created },
  type: "assistant",
  agent: "Junior",
  model,
  content: [],
  tokens,
})

const completedCompaction = (
  id: string,
  tokens: TokenUsageInfo,
  model: ModelRef,
  created: number = 0,
): SessionMessageCompactionCompleted => ({
  id,
  time: { created },
  type: "compaction",
  status: "completed",
  reason: "auto",
  summary: "summary",
  recent: "recent",
  model,
  tokens,
})

const failedCompaction = (
  id: string,
  tokens: TokenUsageInfo,
  created: number = 0,
): SessionMessageCompactionFailed => ({
  id,
  time: { created },
  type: "compaction",
  status: "failed",
  reason: "auto",
  error: { type: "unknown", message: "failed" },
  tokens,
})

const runningCompaction = (
  id: string,
  created: number = 0,
): SessionMessageCompactionRunning => ({
  id,
  time: { created },
  type: "compaction",
  status: "running",
  reason: "auto",
  summary: "summary",
  recent: "recent",
})

const catalog = (entries: ReadonlyArray<readonly [ModelRef, ReadonlyArray<Price>]>): PriceCatalog =>
  new Map(entries.map(([model, prices]) => [modelPriceKey(model), prices]))

const reading = (messages: ReadonlyArray<SessionMessageInfo>): Reading => ({
  actual: Option.none(),
  usage: Option.none(),
  catalog: Result.void,
  messages,
})

const input = (overrides: Partial<SpendInput>): SpendInput => ({
  selected: Option.some(MODEL),
  aggregate: Option.some(ZERO_TOKENS),
  reading: Result.succeed(reading([])),
  prices: Result.succeed(catalog([[MODEL, [PRICE]]])),
  fork: Option.none(),
  created: 0,
  ...overrides,
})

const observation = (
  id: string,
  selected: ModelRef,
  aggregate: TokenUsageInfo,
  messages: ReadonlyArray<SessionMessageInfo>,
): Observation => ({
  id,
  title: Option.none(),
  agent: "Junior",
  role: "subagent",
  selected: Option.some(selected),
  outcome: Option.none(),
  tokens: Option.some(aggregate),
  created: 0,
  fork: Option.none(),
  reading: Result.succeed(reading(messages)),
  prices: Result.succeed(catalog([[MODEL, [PRICE]], [OTHER, [PRICE]]])),
})

const getSome = <A>(value: Option.Option<A>): A => {
  if (Option.isNone(value)) throw new Error("Expected Some")
  return value.value
}

test("estimateCost charges reasoning as output and cache writes at their own rate", () => {
  const result = estimateCost(
    TOKENS(1_000_000, 1_000_000, 500_000, 2_000_000, 3_000_000),
    [PRICE],
  )
  expect(getSome(result)).toBe(5.75)
})

test("estimateCost selects the greatest context tier strictly above its size", () => {
  const exact = estimateCost(TOKENS(272_000, 0, 0, 0, 0), TIERED)
  const above = estimateCost(TOKENS(272_001, 0, 0, 0, 0), TIERED)
  const highest = estimateCost(TOKENS(600_000, 0, 0, 0, 0), TIERED)
  expect(getSome(exact)).toBe(0.272)
  expect(getSome(above)).toBe(0.544002)
  expect(getSome(highest)).toBe(2.4)
})

test("estimateCost treats known zero usage as zero without a price and missing prices as unavailable", () => {
  expect(getSome(estimateCost(ZERO_TOKENS, []))).toBe(0)
  expect(Option.isNone(estimateCost(TOKENS(1, 0, 0, 0, 0), []))).toBe(true)
})

test("spendBreakdown groups billable assistant and completed compaction usage by provider and model", () => {
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("m1", TOKENS(1_000, 200, 50, 300, 100), MODEL),
    completedCompaction("c1", TOKENS(500, 100, 0, 0, 0), OTHER),
    runningCompaction("c2"),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_500, 300, 50, 300, 100)),
    reading: Result.succeed(reading(messages)),
    prices: Result.succeed(catalog([[MODEL, [PRICE]], [OTHER, [PRICE]]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.usedModels).toBe(2)
  expect(result.rows.length).toBe(2)
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.002375 })
  const modelRow = result.rows.find((row) => row.source._tag === "Model")
  expect(modelRow?.tokens).toEqual(TOKENS(1_000, 200, 50, 300, 100))
})

test("spendBreakdown attributes aggregate usage absent from messages to the current model", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 200, 50, 300, 100)),
    reading: Result.succeed(reading([assistant("m1", TOKENS(600, 100, 0, 0, 0), MODEL)])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.001675 })
  expect(result.rows.length).toBe(1)
  const modelRow = result.rows[0]
  expect(modelRow?.source._tag).toBe("Model")
  expect(modelRow?.tokens).toEqual(TOKENS(1_000, 200, 50, 300, 100))
  expect(modelRow?.amount).toEqual({ _tag: "Estimated", usd: 0.001675 })
  expect(modelRow?.attribution).toEqual({ _tag: "StableSession" })
})

test("spendBreakdown applies a signed correction to the current model without repricing known usage", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([assistant("m1", TOKENS(2_000, 0, 0, 0, 0), MODEL)])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.001 })
  expect(result.rows[0]?.tokens).toEqual(TOKENS(1_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.001 })
})

test("spendBreakdown attributes a failed compaction to the current model as residual usage", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(100, 20, 0, 0, 0)),
    reading: Result.succeed(reading([failedCompaction("c1", TOKENS(100, 20, 0, 0, 0))])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.00014 })
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.source._tag).toBe("Model")
  expect(result.rows[0]?.tokens).toEqual(TOKENS(100, 20, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.00014 })
})

test("spendBreakdown does not double-count unknown-model usage without a current model", () => {
  const unknown = TOKENS(100, 20, 0, 0, 0)
  const result = spendBreakdown(input({
    selected: Option.none(),
    aggregate: Option.some(unknown),
    reading: Result.succeed(reading([failedCompaction("c1", unknown)])),
  }))
  expect(result.usage._tag).toBe("Incomplete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.source._tag).toBe("Unattributed")
  expect(result.rows[0]?.tokens).toEqual(unknown)
})

test("spendBreakdown keeps known unattributed usage once when aggregate exceeds it", () => {
  const unknown = TOKENS(100, 0, 0, 0, 0)
  const aggregate = TOKENS(150, 0, 0, 0, 0)
  const result = spendBreakdown(input({
    selected: Option.none(),
    aggregate: Option.some(aggregate),
    reading: Result.succeed(reading([failedCompaction("c1", unknown)])),
  }))
  expect(result.usage._tag).toBe("Incomplete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.source._tag).toBe("Unattributed")
  expect(result.rows[0]?.tokens).toEqual(aggregate)
})

test("spendBreakdown reconciles unknown-model usage across every token category without a current model", () => {
  const unknown = TOKENS(100, 20, 30, 40, 50)
  const aggregate = TOKENS(150, 30, 45, 60, 75)
  const result = spendBreakdown(input({
    selected: Option.none(),
    aggregate: Option.some(aggregate),
    reading: Result.succeed(reading([failedCompaction("c1", unknown)])),
  }))
  expect(result.usage._tag).toBe("Incomplete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.source._tag).toBe("Unattributed")
  expect(result.rows[0]?.tokens).toEqual(aggregate)
})

test("spendBreakdown leaves a negative unattributed discrepancy partial", () => {
  const result = spendBreakdown(input({
    selected: Option.none(),
    aggregate: Option.some(TOKENS(100, 0, 0, 0, 0)),
    reading: Result.succeed(reading([
      assistant("m1", TOKENS(200, 0, 0, 0, 0), MODEL),
    ])),
  }))
  expect(result.usage._tag).toBe("Incomplete")
  expect(result.total).toEqual({ _tag: "Partial", usd: 0.0002 })
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.source._tag).toBe("Model")
  expect(result.rows[0]?.tokens).toEqual(TOKENS(200, 0, 0, 0, 0))
})

test("spendBreakdown excludes fork-inherited messages by session creation time", () => {
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("inherited", TOKENS(9_000, 1_000, 0, 0, 0), MODEL, 10),
    assistant("own", TOKENS(1_000, 100, 0, 0, 0), MODEL, 100),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 100, 0, 0, 0)),
    reading: Result.succeed(reading(messages)),
    fork: Option.some({
      sessionID: "ses_parent",
      boundary: { type: "through", messageID: "msg_parent" },
    }),
    created: 50,
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.tokens).toEqual(TOKENS(1_000, 100, 0, 0, 0))
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.0012 })
})

test("spendBreakdown marks an ambiguous fork boundary incomplete instead of filtering it", () => {
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("inherited", TOKENS(1_000, 100, 0, 0, 0), MODEL, 10),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 100, 0, 0, 0)),
    reading: Result.succeed(reading(messages)),
    fork: Option.some({
      sessionID: "",
      boundary: { type: "through", messageID: "" },
    }),
    created: 50,
  }))
  expect(result.usage._tag).toBe("Incomplete")
  expect(result.total).toEqual({ _tag: "Partial", usd: 0.0012 })
})

test("spendBreakdown distinguishes missing aggregates, history-failure fallback, and known zero usage", () => {
  const missingAggregate = spendBreakdown(input({
    aggregate: Option.none(),
    reading: Result.succeed(reading([assistant("m1", TOKENS(10, 0, 0, 0, 0), MODEL)])),
  }))
  expect(missingAggregate.usage._tag).toBe("Incomplete")

  const unavailable = spendBreakdown(input({
    reading: Result.fail({ message: "history failed" }),
  }))
  expect(unavailable.usage._tag).toBe("Complete")
  expect(unavailable.rows.length).toBe(1)
  expect(unavailable.rows[0]?.tokens).toEqual(ZERO_TOKENS)
  expect(unavailable.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0 })
  expect(unavailable.total).toEqual({ _tag: "Estimated", usd: 0 })

  const zero = spendBreakdown(
    input({ aggregate: Option.some(ZERO_TOKENS), prices: Result.succeed(new Map()) }),
  )
  expect(zero.usage._tag).toBe("Complete")
  expect(zero.rows.length).toBe(1)
  expect(zero.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0 })
  expect(zero.total).toEqual({ _tag: "Estimated", usd: 0 })
  expect(zero.usedModels).toBe(0)
  expect(zero.attribution).toEqual({ _tag: "StableSession" })
})

test("spendBreakdown estimates a partial total from known priced model rows", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([
      assistant("priced", TOKENS(400, 0, 0, 0, 0), MODEL),
      assistant("unpriced", TOKENS(600, 0, 0, 0, 0), OTHER),
    ])),
    prices: Result.succeed(catalog([[MODEL, [PRICE]]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.total).toEqual({ _tag: "Partial", usd: 0.0004 })
})

test("spendBreakdown keeps the total unavailable when no recorded model usage is priced", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([assistant("unpriced", TOKENS(1_000, 0, 0, 0, 0), MODEL)])),
    prices: Result.succeed(new Map()),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows[0]?.amount).toEqual({ _tag: "Unavailable", reason: "no catalog price" })
  expect(result.total).toEqual({ _tag: "Unavailable", reason: "no catalog price" })
})

test("spendBreakdown does not treat a zero placeholder as an estimate for unknown usage", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(ZERO_TOKENS),
    reading: Result.succeed(reading([])),
    fork: Option.some({
      sessionID: "",
      boundary: { type: "through", messageID: "" },
    }),
    created: 50,
  }))
  expect(result.usage._tag).toBe("Incomplete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0 })
  expect(result.total).toEqual({
    _tag: "Unavailable",
    reason: "fork history boundary is ambiguous",
  })
})

test("spendBreakdown prices each assistant request before merging variant rows", () => {
  const low: ModelRef = { providerID: "acme", id: "model", variant: "low" }
  const high: ModelRef = { providerID: "acme", id: "model", variant: "high" }
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("low", TOKENS(200_000, 0, 0, 0, 0), low),
    assistant("high", TOKENS(200_000, 0, 0, 0, 0), high),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading(messages)),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.tokens).toEqual(TOKENS(400_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.4 })
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.4 })
  expect(result.attribution).toEqual({ _tag: "StableSession" })
  expect(result.rows[0]?.attribution).toEqual({ _tag: "StableSession" })
})

test("spendBreakdown marks a session that used two models and assigns residual only to the current model", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    selected: Option.some(OTHER),
    reading: Result.succeed(reading([
      assistant("first", TOKENS(400, 0, 0, 0, 0), MODEL),
      assistant("second", TOKENS(300, 0, 0, 0, 0), OTHER),
    ])),
    prices: Result.succeed(catalog([[MODEL, [PRICE]], [OTHER, [PRICE]]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(2)
  expect(result.attribution).toEqual({ _tag: "MixedModelSession" })
  const first = result.rows.find((row) =>
    row.source._tag === "Model" && row.source.model.id === MODEL.id
  )
  const second = result.rows.find((row) =>
    row.source._tag === "Model" && row.source.model.id === OTHER.id
  )
  expect(first?.tokens).toEqual(TOKENS(400, 0, 0, 0, 0))
  expect(first?.amount).toEqual({ _tag: "Estimated", usd: 0.0004 })
  expect(first?.attribution).toEqual({ _tag: "MixedModelSession" })
  expect(second?.tokens).toEqual(TOKENS(600, 0, 0, 0, 0))
  expect(second?.amount).toEqual({ _tag: "Estimated", usd: 0.0006 })
  expect(second?.attribution).toEqual({ _tag: "MixedModelSession" })
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.001 })
})

test("spendBreakdown marks a mixed session even when the aggregate needs no correction", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(700, 0, 0, 0, 0)),
    reading: Result.succeed(reading([
      assistant("first", TOKENS(400, 0, 0, 0, 0), MODEL),
      assistant("second", TOKENS(300, 0, 0, 0, 0), OTHER),
    ])),
    prices: Result.succeed(catalog([[MODEL, [PRICE]], [OTHER, [PRICE]]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.0007 })
  expect(result.attribution).toEqual({ _tag: "MixedModelSession" })
  expect(result.rows.every((row) => row.attribution._tag === "MixedModelSession")).toBe(true)
})

test("summarize merges mixed-session provenance into a shared model row", () => {
  const stable = observation(
    "stable",
    MODEL,
    TOKENS(100, 0, 0, 0, 0),
    [assistant("stable-message", TOKENS(100, 0, 0, 0, 0), MODEL)],
  )
  const mixed = observation(
    "mixed",
    MODEL,
    TOKENS(1_000, 0, 0, 0, 0),
    [
      assistant("mixed-first", TOKENS(400, 0, 0, 0, 0), MODEL),
      assistant("mixed-second", TOKENS(300, 0, 0, 0, 0), OTHER),
    ],
  )
  const snapshot = summarize([stable, mixed])
  const agent = snapshot.agents[0]
  expect(agent?.spend.attribution).toEqual({ _tag: "MixedModelSession" })
  const row = agent?.spend.rows.find((candidate) =>
    candidate.source._tag === "Model" && candidate.source.model.id === MODEL.id
  )
  expect(row?.tokens).toEqual(TOKENS(800, 0, 0, 0, 0))
  expect(row?.amount).toEqual({ _tag: "Estimated", usd: 0.0008 })
  expect(row?.attribution).toEqual({ _tag: "MixedModelSession" })
  expect(agent?.spend.total).toEqual({ _tag: "Estimated", usd: 0.0011 })
  expect(snapshot.spend.attribution).toEqual({ _tag: "MixedModelSession" })
})

test("spendBreakdown reconciles positive and negative residual components at the base rate", () => {
  const positive = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400, 0, 0, 0, 0)),
    reading: Result.succeed(reading([assistant("m1", TOKENS(1_000, 0, 0, 0, 0), MODEL)])),
  }))
  expect(positive.usage._tag).toBe("Complete")
  expect(positive.rows[0]?.tokens).toEqual(TOKENS(400, 0, 0, 0, 0))
  const positiveAmount = positive.rows[0]?.amount
  expect(positiveAmount?._tag).toBe("Estimated")
  if (positiveAmount?._tag === "Estimated") {
    expect(positiveAmount.usd).toBeCloseTo(0.0004, 12)
  }
  expect(positive.total._tag).toBe("Estimated")
  if (positive.total._tag === "Estimated") {
    expect(positive.total.usd).toBeCloseTo(0.0004, 12)
  }

  const mixedSign = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_200, 800, 0, 0, 0)),
    reading: Result.succeed(reading([assistant("m1", TOKENS(1_000, 1_000, 0, 0, 0), MODEL)])),
  }))
  expect(mixedSign.usage._tag).toBe("Complete")
  expect(mixedSign.rows[0]?.tokens).toEqual(TOKENS(1_200, 800, 0, 0, 0))
  expect(mixedSign.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.0028 })
  expect(mixedSign.total).toEqual({ _tag: "Estimated", usd: 0.0028 })
})

test("spendBreakdown preserves recorded usage when a negative correction is impossible", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    selected: Option.some(MODEL),
    reading: Result.succeed(reading([
      assistant("historical", TOKENS(1_000_000, 0, 0, 0, 0), OTHER),
      assistant("current", TOKENS(100, 0, 0, 0, 0), MODEL),
    ])),
    prices: Result.succeed(catalog([[MODEL, [PRICE]], [OTHER, [PRICE]]])),
  }))
  expect(result.usage).toEqual({
    _tag: "Incomplete",
    reason:
      "session totals cannot be reconciled with current-model usage; recorded usage is a partial estimate",
  })
  expect(result.total).toEqual({ _tag: "Partial", usd: 1.0001 })
  expect(result.attribution).toEqual({ _tag: "MixedModelSession" })
  const historical = result.rows.find((row) =>
    row.source._tag === "Model" && row.source.model.id === OTHER.id
  )
  const current = result.rows.find((row) =>
    row.source._tag === "Model" && row.source.model.id === MODEL.id
  )
  expect(historical?.tokens).toEqual(TOKENS(1_000_000, 0, 0, 0, 0))
  expect(historical?.amount).toEqual({ _tag: "Estimated", usd: 1 })
  expect(current?.tokens).toEqual(TOKENS(100, 0, 0, 0, 0))
  expect(current?.amount).toEqual({ _tag: "Estimated", usd: 0.0001 })
})

test("spendBreakdown preserves recorded usage when a negative correction would make spend negative", () => {
  const freeAboveTier: Price = {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
    tier: { type: "context", size: 100 },
  }
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400, 0, 0, 0, 0)),
    reading: Result.succeed(reading([assistant("m1", TOKENS(1_000, 0, 0, 0, 0), MODEL)])),
    prices: Result.succeed(catalog([[MODEL, [PRICE, freeAboveTier]]])),
  }))
  expect(result.usage).toEqual({
    _tag: "Incomplete",
    reason:
      "session totals cannot be reconciled with current-model usage; recorded usage is a partial estimate",
  })
  expect(result.rows[0]?.tokens).toEqual(TOKENS(1_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0 })
  expect(result.total).toEqual({ _tag: "Partial", usd: 0 })
})

test("spendBreakdown keeps tier-priced recorded amounts when a positive residual has no base price", () => {
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("first", TOKENS(300_000, 0, 0, 0, 0), MODEL),
    assistant("second", TOKENS(300_000, 0, 0, 0, 0), MODEL),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(700_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading(messages)),
    prices: Result.succeed(catalog([[MODEL, TIERED.slice(1)]])),
  }))
  expect(result.usage).toEqual({
    _tag: "Incomplete",
    reason:
      "current-model residual tokens could not be priced; recorded usage is a partial estimate",
  })
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.tokens).toEqual(TOKENS(600_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 1.2 })
  expect(result.total).toEqual({ _tag: "Partial", usd: 1.2 })
})

test("spendBreakdown keeps tier-priced recorded amounts when a negative residual has no base price", () => {
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("first", TOKENS(300_000, 0, 0, 0, 0), MODEL),
    assistant("second", TOKENS(300_000, 0, 0, 0, 0), MODEL),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(500_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading(messages)),
    prices: Result.succeed(catalog([[MODEL, TIERED.slice(1)]])),
  }))
  expect(result.usage).toEqual({
    _tag: "Incomplete",
    reason:
      "current-model residual tokens could not be priced; recorded usage is a partial estimate",
  })
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.tokens).toEqual(TOKENS(600_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 1.2 })
  expect(result.total).toEqual({ _tag: "Partial", usd: 1.2 })
})

test("spendBreakdown prices a message-less session at the base rate", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.tokens).toEqual(TOKENS(1_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.001 })
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.001 })
  expect(result.attribution).toEqual({ _tag: "StableSession" })
})

test("spendBreakdown falls back to the aggregate when message history fails", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.fail({ message: "history failed" }),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows[0]?.tokens).toEqual(TOKENS(1_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.001 })
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.001 })

  const noCurrent = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    selected: Option.none(),
    reading: Result.fail({ message: "history failed" }),
  }))
  expect(noCurrent.usage).toEqual({
    _tag: "Unavailable",
    reason: "message history unavailable: history failed",
  })
  expect(noCurrent.rows).toEqual([])

  const noAggregate = spendBreakdown(input({
    aggregate: Option.none(),
    reading: Result.fail({ message: "history failed" }),
  }))
  expect(noAggregate.usage).toEqual({
    _tag: "Unavailable",
    reason: "message history unavailable: history failed",
  })
  expect(noAggregate.rows).toEqual([])
})

test("spendBreakdown makes residual pricing explicit when no base price exists", () => {
  const noPrice = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([])),
    prices: Result.succeed(new Map()),
  }))
  expect(noPrice.rows[0]?.amount).toEqual({
    _tag: "Unavailable",
    reason: "no catalog price",
  })
  expect(noPrice.total).toEqual({ _tag: "Unavailable", reason: "no catalog price" })

  const noBase = spendBreakdown(input({
    aggregate: Option.some(TOKENS(1_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([])),
    prices: Result.succeed(catalog([[MODEL, TIERED.slice(1)]])),
  }))
  expect(noBase.rows[0]?.amount).toEqual({
    _tag: "Unavailable",
    reason: "no applicable catalog price",
  })
  expect(noBase.total).toEqual({ _tag: "Unavailable", reason: "no applicable catalog price" })
})

test("spendBreakdown charges a large residual at the base rate instead of a cumulative tier", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([
      assistant("known", TOKENS(100_000, 0, 0, 0, 0), MODEL),
    ])),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows[0]?.tokens).toEqual(TOKENS(400_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.4 })
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.4 })

  const negative = spendBreakdown(input({
    aggregate: Option.some(TOKENS(300_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading([
      assistant("known", TOKENS(400_000, 0, 0, 0, 0), MODEL),
    ])),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  expect(negative.usage._tag).toBe("Complete")
  expect(negative.rows[0]?.tokens).toEqual(TOKENS(300_000, 0, 0, 0, 0))
  const negativeAmount = negative.rows[0]?.amount
  expect(negativeAmount?._tag).toBe("Estimated")
  if (negativeAmount?._tag === "Estimated") {
    expect(negativeAmount.usd).toBeCloseTo(0.7, 12)
  }
  expect(negative.total._tag).toBe("Estimated")
  if (negative.total._tag === "Estimated") {
    expect(negative.total.usd).toBeCloseTo(0.7, 12)
  }
})

test("spendBreakdown applies tiers per assistant request, then adds the amounts", () => {
  const messages: ReadonlyArray<SessionMessageInfo> = [
    assistant("base", TOKENS(100_000, 0, 0, 0, 0), MODEL),
    assistant("tiered", TOKENS(300_000, 0, 0, 0, 0), MODEL),
  ]
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400_000, 0, 0, 0, 0)),
    reading: Result.succeed(reading(messages)),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  expect(result.rows[0]?.tokens).toEqual(TOKENS(400_000, 0, 0, 0, 0))
  expect(result.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.7 })
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.7 })
})

test("spendBreakdown refuses tier pricing for compaction totals that may span calls", () => {
  const aggregate = TOKENS(300_000, 0, 0, 0, 0)
  const result = spendBreakdown(input({
    aggregate: Option.some(aggregate),
    reading: Result.succeed(reading([completedCompaction("compact", aggregate, MODEL)])),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.amount).toEqual({
    _tag: "Unavailable",
    reason: "per-call compaction usage unavailable for tier pricing",
  })
  expect(result.total._tag).toBe("Unavailable")
})

test("spendBreakdown uses base pricing for compaction totals that cannot cross a tier", () => {
  const below = TOKENS(200_000, 0, 0, 0, 0)
  const exact = TOKENS(272_000, 0, 0, 0, 0)
  const belowResult = spendBreakdown(input({
    aggregate: Option.some(below),
    reading: Result.succeed(reading([completedCompaction("below", below, MODEL)])),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  const exactResult = spendBreakdown(input({
    aggregate: Option.some(exact),
    reading: Result.succeed(reading([completedCompaction("exact", exact, MODEL)])),
    prices: Result.succeed(catalog([[MODEL, TIERED]])),
  }))
  expect(belowResult.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.2 })
  expect(exactResult.rows[0]?.amount).toEqual({ _tag: "Estimated", usd: 0.272 })
})

test("spendBreakdown keeps mixed attribution when a signed correction zeroes one model row", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400, 0, 0, 0, 0)),
    selected: Option.some(OTHER),
    reading: Result.succeed(reading([
      assistant("first", TOKENS(400, 0, 0, 0, 0), MODEL),
      assistant("second", TOKENS(300, 0, 0, 0, 0), OTHER),
    ])),
    prices: Result.succeed(catalog([[MODEL, [PRICE]], [OTHER, [PRICE]]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(2)
  expect(result.attribution).toEqual({ _tag: "MixedModelSession" })
  const zeroed = result.rows.find((row) =>
    row.source._tag === "Model" && row.source.model.id === OTHER.id
  )
  expect(zeroed?.tokens).toEqual(ZERO_TOKENS)
  expect(zeroed?.amount).toEqual({ _tag: "Estimated", usd: 0 })
  expect(result.usedModels).toBe(1)
  expect(result.total).toEqual({ _tag: "Estimated", usd: 0.0004 })
})

test("spendBreakdown reports the first unavailable row reason when reasons differ", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(300_100, 0, 0, 0, 0)),
    selected: Option.some(OTHER),
    reading: Result.succeed(reading([
      assistant("unpriced", TOKENS(100, 0, 0, 0, 0), MODEL),
      completedCompaction("tiered", TOKENS(300_000, 0, 0, 0, 0), OTHER),
    ])),
    prices: Result.succeed(catalog([[OTHER, TIERED]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(2)
  expect(result.rows[0]?.amount).toEqual({ _tag: "Unavailable", reason: "no catalog price" })
  expect(result.rows[1]?.amount).toEqual({
    _tag: "Unavailable",
    reason: "per-call compaction usage unavailable for tier pricing",
  })
  expect(result.total).toEqual({ _tag: "Unavailable", reason: "no catalog price" })
})

test("spendBreakdown keeps a partial total when a zero-token row is unavailable", () => {
  const result = spendBreakdown(input({
    aggregate: Option.some(TOKENS(400, 0, 0, 0, 0)),
    selected: Option.some(MODEL),
    reading: Result.succeed(reading([
      assistant("priced", TOKENS(400, 0, 0, 0, 0), OTHER),
      completedCompaction("zeroed", TOKENS(300_000, 0, 0, 0, 0), MODEL),
    ])),
    prices: Result.succeed(catalog([[OTHER, [PRICE]], [MODEL, TIERED]])),
  }))
  expect(result.usage._tag).toBe("Complete")
  expect(result.rows.length).toBe(2)
  const zeroed = result.rows.find((row) =>
    row.source._tag === "Model" && row.source.model.id === MODEL.id
  )
  expect(zeroed?.tokens).toEqual(ZERO_TOKENS)
  expect(zeroed?.amount).toEqual({
    _tag: "Unavailable",
    reason: "per-call compaction usage unavailable for tier pricing",
  })
  expect(result.total).toEqual({ _tag: "Partial", usd: 0.0004 })
})
