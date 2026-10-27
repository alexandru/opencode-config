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

export const DEFAULT_TOOLS: ReadonlyArray<string> = ["shell"]

const DEFAULT_RESET_TOOLS: ReadonlyArray<string> = ["subagent"]

const ToolPatternRegExp = /^[A-Za-z0-9_-]+\*?$/

const ToolPatternSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(ToolPatternRegExp)),
)

export type ToolPattern = Schema.Schema.Type<typeof ToolPatternSchema>

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
  tools: Schema.optional(Schema.NonEmptyArray(ToolPatternSchema)),
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

export interface AgentReminderEntry {
  readonly message: string
  readonly resetTools: ReadonlyArray<ToolPattern>
  readonly condition: Condition
}

export interface Configuration {
  readonly agents: Readonly<Record<string, ReadonlyArray<AgentReminderEntry>>>
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
  resetTools: Schema.optional(Schema.Array(ToolPatternSchema)),
  condition: ConditionSchema,
})

type DecodedEntry = Schema.Schema.Type<typeof AgentReminderSchema>

const ConfigurationSchema = Schema.Struct({
  agents: Schema.optional(
    Schema.Record(Schema.NonEmptyString, Schema.NonEmptyArray(AgentReminderSchema)),
  ),
})

export const countingTools = (condition: Condition): ReadonlyArray<ToolPattern> => {
  const tools: Array<ToolPattern> = []
  const collect = (node: Condition): void => {
    switch (node.type) {
      case "toolCalls": {
        for (const tool of node.tools ?? DEFAULT_TOOLS) tools.push(tool)
        return
      }
      case "all":
      case "any": {
        for (const child of node.conditions) collect(child)
        return
      }
      case "elapsedTime":
      case "contextGrowth":
      case "contextUtilizationGrowth":
        return
    }
  }
  collect(condition)
  return tools
}

const patternsOverlap = (counted: ToolPattern, reset: ToolPattern): boolean => {
  if (counted.endsWith("*") && reset.endsWith("*")) {
    const countedPrefix = counted.slice(0, -1)
    const resetPrefix = reset.slice(0, -1)
    return countedPrefix.startsWith(resetPrefix) || resetPrefix.startsWith(countedPrefix)
  }
  if (counted.endsWith("*")) return reset.startsWith(counted.slice(0, -1))
  if (reset.endsWith("*")) return counted.startsWith(reset.slice(0, -1))
  return counted === reset
}

const validateEntry = (agent: string, index: number, entry: AgentReminderEntry): void => {
  for (const counted of countingTools(entry.condition)) {
    for (const reset of entry.resetTools) {
      if (patternsOverlap(counted, reset)) {
        throw new Error(
          `agent "${agent}" entry ${index} counts tool "${counted}" that also resets it ("${reset}")`,
        )
      }
    }
  }
}

export const decodeConfiguration = (input: unknown): Configuration => {
  try {
    const decoded = Schema.decodeUnknownSync(ConfigurationSchema)(input, {
      onExcessProperty: "error",
    })
    const agents: Record<string, ReadonlyArray<AgentReminderEntry>> = {}
    for (const [agent, entries] of Object.entries(decoded.agents ?? {})) {
      agents[agent] = Array.from(
        entries,
        (entry: DecodedEntry, index: number): AgentReminderEntry => {
          const resolved: AgentReminderEntry = {
            message: entry.message,
            resetTools: entry.resetTools ?? DEFAULT_RESET_TOOLS,
            condition: entry.condition,
          }
          validateEntry(agent, index, resolved)
          return resolved
        },
      )
    }
    return { agents }
  } catch (cause: unknown) {
    throw new Error(`Invalid agent reminder configuration: ${errorMessage(cause)}`)
  }
}
