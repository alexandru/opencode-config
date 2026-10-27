import { type Option, Schema } from "effect"

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const PositiveFinite = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("AgentReminders.Positive"),
)

export type Positive = Schema.Schema.Type<typeof PositiveFinite>

export const decodePositive: (input: unknown) => Option.Option<Positive> = Schema
  .decodeUnknownOption(PositiveFinite)

const PositiveInteger = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("AgentReminders.PositiveInteger"),
)

const ConditionType = Schema.Literals([
  "toolCalls",
  "elapsedTime",
  "contextGrowth",
  "contextUtilizationGrowth",
  "all",
  "any",
])
const CompositeConditionType = ConditionType.pick(["all", "any"])

const ToolCallsConditionSchema = Schema.Struct({
  type: ConditionType.pick(["toolCalls"]),
  count: PositiveInteger,
  tools: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
})
const ElapsedTimeConditionSchema = Schema.Struct({
  type: ConditionType.pick(["elapsedTime"]),
  seconds: PositiveFinite,
})
const ContextGrowthConditionSchema = Schema.Struct({
  type: ConditionType.pick(["contextGrowth"]),
  tokens: PositiveFinite,
})
const ContextUtilizationGrowthConditionSchema = Schema.Struct({
  type: ConditionType.pick(["contextUtilizationGrowth"]),
  percentagePoints: PositiveFinite,
})

type ToolCallsCondition = Schema.Schema.Type<typeof ToolCallsConditionSchema>
type ElapsedTimeCondition = Schema.Schema.Type<typeof ElapsedTimeConditionSchema>
type ContextGrowthCondition = Schema.Schema.Type<typeof ContextGrowthConditionSchema>
type ContextUtilizationGrowthCondition = Schema.Schema.Type<
  typeof ContextUtilizationGrowthConditionSchema
>
type CompositeConditionTag = Schema.Schema.Type<typeof CompositeConditionType>

export type Condition =
  | ToolCallsCondition
  | ElapsedTimeCondition
  | ContextGrowthCondition
  | ContextUtilizationGrowthCondition
  | CompositeCondition

interface CompositeCondition {
  readonly type: CompositeConditionTag
  readonly conditions: readonly [Condition, ...Array<Condition>]
}

export interface AgentReminder {
  readonly message: string
  readonly condition: Condition
}

export interface Configuration {
  readonly agents: Readonly<Record<string, AgentReminder>>
}

const ConditionSchema: Schema.ConstraintDecoder<Condition> = Schema.suspend(
  (): Schema.ConstraintDecoder<Condition> =>
    Schema.Union([
      ToolCallsConditionSchema,
      ElapsedTimeConditionSchema,
      ContextGrowthConditionSchema,
      ContextUtilizationGrowthConditionSchema,
      Schema.Struct({
        type: CompositeConditionType,
        conditions: Schema.NonEmptyArray(ConditionSchema),
      }),
    ]),
)

const AgentReminderSchema = Schema.Struct({
  message: Schema.NonEmptyString,
  condition: ConditionSchema,
})

const ConfigurationSchema = Schema.Struct({
  agents: Schema.optional(Schema.Record(Schema.NonEmptyString, AgentReminderSchema)),
})

export const decodeConfiguration = (input: unknown): Configuration => {
  try {
    const decoded = Schema.decodeUnknownSync(ConfigurationSchema)(input, {
      onExcessProperty: "error",
    })
    return { agents: decoded.agents ?? {} }
  } catch (cause: unknown) {
    throw new Error(`Invalid agent reminder configuration: ${errorMessage(cause)}`)
  }
}
