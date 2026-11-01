import type { Model } from "@opencode/client/effect"
import { Plugin } from "@opencode/plugin/effect"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { ProviderRecord } from "@opencode/plugin/effect/provider"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Effect, MutableRef, Ref, Result, type Scope } from "effect"
import {
  describeFailure,
  type ModelPrice,
  type Price,
  Prices,
  type PricesOutput,
  type PriceUnavailable,
} from "./rpc.ts"

export interface PriceServerContext {
  readonly model: Pick<PluginContext["model"], "list" | "transform">
  readonly rpc: {
    readonly register: (
      definition: typeof Prices,
      handlers: RpcHandlers<typeof Prices>,
    ) => Effect.Effect<RpcRegistration<typeof Prices>, unknown, Scope.Scope>
  }
}

const price = (cost: Model.Info["cost"][number]): Price => {
  const tier = cost.tier
  return {
    input: cost.input,
    output: cost.output,
    cache: {
      read: cost.cache.read,
      write: cost.cache.write,
    },
    ...(tier === undefined ? {} : { tier: { type: tier.type, size: tier.size } }),
  }
}

const capturePrices = (providers: readonly ProviderRecord[]): PricesOutput => {
  const byProvider: Map<string, Map<string, ModelPrice>> = new Map()
  for (const record of providers) {
    for (const model of record.models.values()) {
      const models = byProvider.get(model.providerID) ?? new Map<string, ModelPrice>()
      models.set(model.id, {
        providerID: model.providerID,
        id: model.id,
        cost: model.cost.map(price),
      })
      byProvider.set(model.providerID, models)
    }
  }
  return {
    models: Array.from(byProvider.values(), (models) => Array.from(models.values())).flat(),
  }
}

const currentPrices = (
  model: Pick<PluginContext["model"], "list">,
  prices: Ref.Ref<PricesOutput>,
): Effect.Effect<PricesOutput, PriceUnavailable> =>
  Effect.gen(function*() {
    const listed = yield* Effect.result(model.list())
    if (Result.isFailure(listed)) {
      return yield* Effect.fail({ message: describeFailure(listed.failure) })
    }
    return yield* Ref.get(prices)
  })

/**
 * Installs the read-only price catalog over the plugin's model domain. The
 * transform captures immutable provider definitions before model transforms
 * clear active subscription costs; the RPC materializes the current registry
 * before reading the captured prices.
 */
export const installPrices = (
  context: PriceServerContext,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const prices: Ref.Ref<PricesOutput> = yield* Ref.make<PricesOutput>({ models: [] })
    yield* context.model.transform((editor) => {
      // The host transform callback is synchronous; Ref has no synchronous setter in Effect 4.0.1.
      MutableRef.set(prices.ref, capturePrices(editor.provider.list()))
    })
    yield* Effect.orDie(
      context.rpc.register(Prices, {
        prices: (_input, call) =>
          currentPrices(context.model, prices).pipe(
            Effect.catch((failure) =>
              Effect.fail(
                call.error("unavailable", "Model prices are unavailable", {
                  message: failure.message,
                }),
              )
            ),
          ),
      }),
    )
  })

const agentsStatus = Plugin.define({
  id: "agents-status",
  effect: (context: PluginContext): Effect.Effect<void, never, Scope.Scope> =>
    installPrices(context),
})

export default agentsStatus
