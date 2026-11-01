import { Location, Model, Provider } from "@opencode/client/effect"
import type { ModelListOutput } from "@opencode/client/effect/api"
import type { ModelEditor } from "@opencode/plugin/effect/model"
import type { ProviderRecord } from "@opencode/plugin/effect/provider"
import type { RpcCallContext, RpcHandlers } from "@opencode/plugin/effect/rpc"
import { expect, test } from "bun:test"
import { Effect, Schema, type Scope } from "effect"
import agentStatus, { installPrices, type PriceServerContext } from "../index.ts"
import { Prices, type PricesOutput, PriceUnavailable } from "../rpc.ts"

class DeclaredUnavailable extends Error {
  readonly type: string
  readonly data: { readonly message: string }

  constructor(type: string, message: string, data: { readonly message: string }) {
    super(message)
    this.type = type
    this.data = data
  }
}

interface CostInput {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly tierSize?: number
}

const modelInfo = (
  providerID: string,
  id: string,
  costs: ReadonlyArray<CostInput>,
  settings?: Readonly<Record<string, string>>,
): Model.Info =>
  Schema.decodeUnknownSync(Model.Info)({
    id,
    modelID: id,
    providerID,
    name: `${providerID}/${id}`,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: costs.map((cost) => ({
      input: cost.input,
      output: cost.output,
      cache: { read: cost.cacheRead, write: cost.cacheWrite },
      ...(cost.tierSize === undefined ? {} : { tier: { type: "context", size: cost.tierSize } }),
    })),
    status: "active",
    enabled: true,
    limit: { context: 100_000, output: 32_000 },
    ...(settings === undefined ? {} : { settings }),
  })

const providerRecord = (
  providerID: string,
  models: ReadonlyArray<Model.Info>,
): ProviderRecord => ({
  provider: Provider.Info.empty(Schema.decodeUnknownSync(Provider.ID)(providerID)),
  models: new Map(models.map((model) => [model.id, model])),
})

const initialCost: CostInput = {
  input: 2,
  output: 4,
  cacheRead: 0.1,
  cacheWrite: 0.2,
  tierSize: 200_000,
}

type PriceErrorName = keyof NonNullable<typeof Prices.methods.prices.errors>

interface HostOptions {
  readonly providers: () => readonly ProviderRecord[]
  readonly activeModels: () => readonly Model.Info[]
}

interface Host {
  readonly context: PriceServerContext
  readonly refresh: () => void
  readonly prices: () => Effect.Effect<PricesOutput>
  readonly reads: () => number
  readonly failRead: (cause: unknown) => void
  readonly disposals: () => number
}

const makeHost = (options: HostOptions): Host => {
  let transform: ((editor: ModelEditor) => void) | undefined
  let handlers: RpcHandlers<typeof Prices> | undefined
  let reads = 0
  let readFailure: unknown
  let disposals = 0

  const refresh = (): void => {
    const current = transform
    if (current === undefined) throw new Error("The price transform was not registered")
    current({
      list: () => [],
      get: () => undefined,
      update: () => {},
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
      provider: {
        list: () => options.providers(),
        get: (providerID) =>
          options.providers().find((record) => record.provider.id === providerID),
      },
    })
  }

  const context: PriceServerContext = {
    model: {
      list: (): Effect.Effect<ModelListOutput, unknown> =>
        Effect.gen(function*() {
          reads++
          const failure = readFailure
          if (failure !== undefined) return yield* Effect.fail(failure)
          refresh()
          return {
            location: Schema.decodeUnknownSync(Location.PublicRef)({
              directory: "/tmp/opencode/agents-status-prices",
            }),
            data: [...options.activeModels()],
          }
        }),
      transform: (callback) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            transform = callback
            return {
              dispose: Effect.sync(() => {
                transform = undefined
                disposals++
              }),
            }
          }),
          (registration) => registration.dispose,
        ),
    },
    rpc: {
      register: (_definition, registered) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers = registered
            return {
              dispose: Effect.sync(() => {
                handlers = undefined
                disposals++
              }),
              events: { emit: () => Effect.void },
            }
          }),
          (registration) => registration.dispose,
        ),
    },
  }

  const prices = (): Effect.Effect<PricesOutput> =>
    Effect.gen(function*() {
      const current = handlers
      if (current === undefined) throw new Error("The price RPC was not registered")
      const call = {
        error: <Name extends PriceErrorName>(
          type: Name,
          message: string,
          data?: unknown,
        ): never => {
          throw new DeclaredUnavailable(
            type,
            message,
            Schema.decodeUnknownSync(PriceUnavailable)(data),
          )
        },
      } satisfies RpcCallContext<typeof Prices.methods.prices>
      return yield* Effect.orDie(current.prices({}, call))
    })

  return {
    context,
    refresh,
    prices,
    reads: () => reads,
    failRead: (cause) => {
      readFailure = cause
    },
    disposals: () => disposals,
  }
}

const runScoped = <A>(effect: Effect.Effect<A, never, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

const rejection = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation
  } catch (cause) {
    return cause
  }
  throw new Error("Expected the operation to fail")
}

type ValidatePrices = typeof Prices.methods.prices.output["~standard"]["validate"]

const validatePrices = (value: unknown): Awaited<ReturnType<ValidatePrices>> => {
  const result = Prices.methods.prices.output["~standard"].validate(value)
  if (result instanceof Promise) throw new Error("Expected synchronous price validation")
  return result
}

test("the server plugin declares the agents-status id", () => {
  expect(agentStatus.id).toBe("agents-status")
})

test("subscription-cleared active costs do not replace captured provider prices", async () => {
  const source = modelInfo("opencode-go", "deepseek-v4.1-flash", [initialCost])
  const cleared = modelInfo("opencode-go", "deepseek-v4.1-flash", [])
  const host = makeHost({
    providers: () => [providerRecord("opencode-go", [source])],
    activeModels: () => [cleared],
  })

  const prices = await runScoped(Effect.gen(function*() {
    yield* installPrices(host.context)
    host.refresh()
    return yield* host.prices()
  }))

  expect(prices).toEqual({
    models: [
      {
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
        cost: [
          {
            input: 2,
            output: 4,
            cache: { read: 0.1, write: 0.2 },
            tier: { type: "context", size: 200_000 },
          },
        ],
      },
    ],
  })
})

test("reload captures updated provider prices before the RPC reads them", async () => {
  let source = modelInfo("openai", "gpt-priced", [initialCost])
  const host = makeHost({
    providers: () => [providerRecord("openai", [source])],
    activeModels: () => [modelInfo("openai", "gpt-priced", [])],
  })

  const result = await runScoped(Effect.gen(function*() {
    yield* installPrices(host.context)
    host.refresh()
    const before = yield* host.prices()
    source = modelInfo("openai", "gpt-priced", [
      { input: 9, output: 12, cacheRead: 1, cacheWrite: 2, tierSize: 400_000 },
    ])
    const after = yield* host.prices()
    return { before, after }
  }))

  expect(result.before.models.at(0)?.cost.at(0)?.input).toBe(2)
  expect(result.after).toEqual({
    models: [
      {
        providerID: "openai",
        id: "gpt-priced",
        cost: [
          {
            input: 9,
            output: 12,
            cache: { read: 1, write: 2 },
            tier: { type: "context", size: 400_000 },
          },
        ],
      },
    ],
  })
  expect(host.reads()).toBe(2)
})

test("a model.list failure produces the declared unavailable error", async () => {
  const source = modelInfo("openai", "gpt-priced", [initialCost])
  const host = makeHost({
    providers: () => [providerRecord("openai", [source])],
    activeModels: () => [source],
  })

  const cause = await rejection(runScoped(Effect.gen(function*() {
    yield* installPrices(host.context)
    host.refresh()
    host.failRead(new Error("registry unavailable"))
    return yield* host.prices()
  })))

  expect(cause).toBeInstanceOf(DeclaredUnavailable)
  if (!(cause instanceof DeclaredUnavailable)) {
    throw new Error("Expected the declared unavailable error")
  }
  expect(cause.type).toBe("unavailable")
  expect(cause.message).toBe("Model prices are unavailable")
  expect(cause.data).toEqual({ message: "registry unavailable" })
  expect(host.reads()).toBe(1)
})

test("an object model.list failure keeps its message in the declared unavailable error", async () => {
  const source = modelInfo("openai", "gpt-priced", [initialCost])
  const host = makeHost({
    providers: () => [providerRecord("openai", [source])],
    activeModels: () => [source],
  })

  const cause = await rejection(runScoped(Effect.gen(function*() {
    yield* installPrices(host.context)
    host.refresh()
    host.failRead({ message: "registry unavailable" })
    return yield* host.prices()
  })))

  expect(cause).toBeInstanceOf(DeclaredUnavailable)
  if (!(cause instanceof DeclaredUnavailable)) {
    throw new Error("Expected the declared unavailable error")
  }
  expect(cause.type).toBe("unavailable")
  expect(cause.data).toEqual({ message: "registry unavailable" })
  expect(host.reads()).toBe(1)
})

test("emitted prices include empty costs and exclude every unrelated model field", async () => {
  const priced = modelInfo("openai", "gpt-secret", [initialCost], { apiKey: "sk-secret" })
  const unpriced = modelInfo("anthropic", "claude-unpriced", [])
  const host = makeHost({
    providers: () => [
      providerRecord("openai", [priced]),
      providerRecord("anthropic", [unpriced]),
    ],
    activeModels: () => [priced, unpriced],
  })

  const prices = await runScoped(Effect.gen(function*() {
    yield* installPrices(host.context)
    host.refresh()
    return yield* host.prices()
  }))

  expect(prices).toEqual({
    models: [
      {
        providerID: "openai",
        id: "gpt-secret",
        cost: [
          {
            input: 2,
            output: 4,
            cache: { read: 0.1, write: 0.2 },
            tier: { type: "context", size: 200_000 },
          },
        ],
      },
      {
        providerID: "anthropic",
        id: "claude-unpriced",
        cost: [],
      },
    ],
  })
  for (const model of prices.models) {
    expect(Object.keys(model).toSorted()).toEqual(["cost", "id", "providerID"])
  }
  expect(JSON.stringify(prices)).not.toContain("sk-secret")
  expect(JSON.stringify(prices)).not.toContain("openai/gpt-secret")
  expect(JSON.stringify(prices)).not.toContain("100000")
})

test("the portable output schema rejects non-finite or negative prices and tier sizes", () => {
  const valid = validatePrices({
    models: [
      {
        providerID: "openai",
        id: "gpt-valid",
        cost: [{ input: 1, output: 2, cache: { read: 0, write: 0.5 } }],
      },
    ],
  })
  expect("issues" in valid).toBe(false)
  if (!("value" in valid)) throw new Error("Expected the valid price catalog to parse")
  expect(valid.value).toEqual({
    models: [
      {
        providerID: "openai",
        id: "gpt-valid",
        cost: [{ input: 1, output: 2, cache: { read: 0, write: 0.5 } }],
      },
    ],
  })

  const baseCost = { input: 1, output: 2, cache: { read: 0, write: 0 } }
  const base = { providerID: "openai", id: "gpt-invalid", cost: [baseCost] }
  const invalidValues: ReadonlyArray<unknown> = [
    { models: [{ ...base, cost: [{ ...baseCost, input: -1 }] }] },
    { models: [{ ...base, cost: [{ ...baseCost, output: Number.NaN }] }] },
    { models: [{ ...base, cost: [{ ...baseCost, output: Number.POSITIVE_INFINITY }] }] },
    {
      models: [{
        ...base,
        cost: [{ ...baseCost, tier: { type: "context", size: -1 } }],
      }],
    },
    {
      models: [{
        ...base,
        cost: [{
          ...baseCost,
          tier: { type: "context", size: Number.POSITIVE_INFINITY },
        }],
      }],
    },
  ]
  for (const invalid of invalidValues) {
    expect("issues" in validatePrices(invalid)).toBe(true)
  }
})

test("plugin instances keep independent captured prices", async () => {
  const alpha = makeHost({
    providers: () => [providerRecord("openai", [modelInfo("openai", "alpha", [initialCost])])],
    activeModels: () => [],
  })
  const beta = makeHost({
    providers: () => [providerRecord("anthropic", [modelInfo("anthropic", "beta", [
      { input: 7, output: 8, cacheRead: 0.3, cacheWrite: 0.4 },
    ])])],
    activeModels: () => [],
  })

  const result = await runScoped(Effect.gen(function*() {
    yield* installPrices(alpha.context)
    alpha.refresh()
    const firstAlpha = yield* alpha.prices()
    yield* installPrices(beta.context)
    beta.refresh()
    const firstBeta = yield* beta.prices()
    const secondAlpha = yield* alpha.prices()
    return { firstAlpha, firstBeta, secondAlpha }
  }))

  expect(result.firstAlpha.models.at(0)).toMatchObject({
    providerID: "openai",
    id: "alpha",
    cost: [{ input: 2 }],
  })
  expect(result.firstBeta.models.at(0)).toMatchObject({
    providerID: "anthropic",
    id: "beta",
    cost: [{ input: 7 }],
  })
  expect(result.secondAlpha).toEqual(result.firstAlpha)
})

test("scope finalization disposes the price transform and RPC registration", async () => {
  const source = modelInfo("openai", "gpt-priced", [initialCost])
  const host = makeHost({
    providers: () => [providerRecord("openai", [source])],
    activeModels: () => [source],
  })

  const prices = await runScoped(Effect.gen(function*() {
    yield* installPrices(host.context)
    host.refresh()
    return yield* host.prices()
  }))

  expect(prices.models).toHaveLength(1)
  expect(host.disposals()).toBe(2)
  expect(() => host.refresh()).toThrow("The price transform was not registered")
  await expect(Effect.runPromise(host.prices())).rejects.toThrow(
    "The price RPC was not registered",
  )
})
