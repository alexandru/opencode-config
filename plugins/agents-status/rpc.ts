import { Rpc } from "@opencode/plugin/effect"
import { Option, Schema } from "effect"

const TokenPrice = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const TierSize = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export interface Price extends Schema.Schema.Type<typeof Price> {}

export const Price = Schema.Struct({
  input: TokenPrice,
  output: TokenPrice,
  cache: Schema.Struct({
    read: TokenPrice,
    write: TokenPrice,
  }),
  tier: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("context"),
      size: TierSize,
    }),
  ),
})

export interface ModelPrice extends Schema.Schema.Type<typeof ModelPrice> {}

export const ModelPrice = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  cost: Schema.Array(Price),
})

export interface PricesOutput extends Schema.Schema.Type<typeof PricesOutput> {}

export const PricesOutput = Schema.Struct({
  models: Schema.Array(ModelPrice),
})

export interface PriceUnavailable extends Schema.Schema.Type<typeof PriceUnavailable> {}

export const PriceUnavailable = Schema.Struct({
  message: Schema.String,
})

/** Renders an unknown failure cause from its declared message when one is present. */
export const describeFailure = (cause: unknown): string => {
  const parsed = Schema.decodeUnknownOption(PriceUnavailable)(cause)
  if (Option.isSome(parsed)) return parsed.value.message
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The agents-status price catalog. Prices come from the immutable provider
 * definitions captured before subscription model transforms clear active costs.
 */
export const Prices = Rpc.define({
  id: "agents-status.prices",
  methods: {
    prices: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(PricesOutput),
      errors: {
        unavailable: Schema.toStandardSchemaV1(PriceUnavailable),
      },
    },
  },
  events: {},
})
