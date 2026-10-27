import {
  Agent,
  Event,
  Location,
  Model,
  Provider,
  Session,
  SessionMessage,
} from "@opencode/client/effect"
import type { OpenCodeEvent } from "@opencode/client/effect"
import type { ModelListOutput, SessionContextOutput } from "@opencode/client/effect/api"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ToolFailures, ToolHooks } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Queue, Result, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import agentReminders from "../index.ts"

type ReminderContext = Parameters<typeof agentReminders.effect>[0]

type SessionInputs = { [Name in keyof SessionHooks]?: ReadonlyArray<SessionHooks[Name]> }
type ToolInputs = { [Name in keyof ToolHooks]?: ReadonlyArray<ToolHooks[Name]> }

interface Hooks {
  readonly sessionInputs: SessionInputs
  readonly toolInputs: ToolInputs
  readonly sessionRegistrations: Array<keyof SessionHooks>
  readonly toolRegistrations: Array<keyof ToolHooks>
  readonly sessionEffects: Array<Effect.Effect<void>>
  readonly toolEffects: Array<Effect.Effect<void>>
  readonly toolAfterEffects: Array<Effect.Effect<void>>
  eventSubscriptions: number
}

interface SdkResponses {
  readonly messages: Map<string, SessionContextOutput>
  models: ModelListOutput
  contextReads: number
  modelReads: number
  contextRequest?: (sessionID: string) => Effect.Effect<SessionContextOutput>
}

interface EventEnvelope {
  readonly event: OpenCodeEvent
  readonly acknowledgment: Deferred.Deferred<void>
}

interface EventPublisher {
  readonly stream: Stream.Stream<OpenCodeEvent, unknown>
  readonly publish: (event: OpenCodeEvent) => Effect.Effect<void>
}

const disposeEffects = (
  registered: Array<Effect.Effect<void>>,
  effects: Array<Effect.Effect<void>>,
): void => {
  const removed = new Set(registered)
  for (let index = effects.length - 1; index >= 0; index--) {
    const effect = effects[index]
    if (effect !== undefined && removed.has(effect)) effects.splice(index, 1)
  }
}

const removeLast = <A>(values: Array<A>, value: A): void => {
  const index = values.lastIndexOf(value)
  if (index >= 0) values.splice(index, 1)
}

const makeReminderContext = (
  options: ReminderContext["options"],
  hooks: Hooks,
  sdk: SdkResponses,
  eventStream: Stream.Stream<OpenCodeEvent, unknown>,
): ReminderContext => ({
  options,
  session: {
    context: (input: Parameters<ReminderContext["session"]["context"]>[0]): Effect.Effect<
      SessionContextOutput
    > =>
      Effect.gen(function*(): Effect.fn.Return<SessionContextOutput> {
        sdk.contextReads++
        if (sdk.contextRequest !== undefined) return yield* sdk.contextRequest(input.sessionID)
        return sdk.messages.get(input.sessionID) ?? []
      }),
    hook: <Name extends keyof SessionHooks>(
      name: Name,
      callback: (event: SessionHooks[Name]) => Effect.Effect<void>,
    ): ReturnType<ReminderContext["session"]["hook"]> =>
      Effect.acquireRelease(
        Effect.sync((): { readonly dispose: Effect.Effect<void> } => {
          hooks.sessionRegistrations.push(name)
          const registered = (hooks.sessionInputs[name] ?? []).map(
            (event: SessionHooks[Name]): Effect.Effect<void> => callback(event),
          )
          hooks.sessionEffects.push(...registered)
          return {
            dispose: Effect.sync((): void => {
              disposeEffects(registered, hooks.sessionEffects)
              removeLast(hooks.sessionRegistrations, name)
            }),
          }
        }),
        (registration: { readonly dispose: Effect.Effect<void> }): Effect.Effect<void> =>
          registration.dispose,
      ),
  },
  tool: {
    hook: <Name extends keyof ToolHooks>(
      name: Name,
      callback: (event: ToolHooks[Name]) => Effect.Effect<void, ToolFailures[Name]>,
    ): ReturnType<ReminderContext["tool"]["hook"]> =>
      Effect.acquireRelease(
        Effect.sync((): { readonly dispose: Effect.Effect<void> } => {
          hooks.toolRegistrations.push(name)
          const registered = (hooks.toolInputs[name] ?? []).map(
            (event: ToolHooks[Name]): Effect.Effect<void> =>
              callback(event).pipe(
                Effect.result,
                Effect.flatMap((
                  result: Result.Result<void, ToolFailures[Name]>,
                ): Effect.Effect<void> =>
                  Result.isFailure(result) ? Effect.die(result.failure) : Effect.void
                ),
              ),
          )
          const effects = name === "execute.after" ? hooks.toolAfterEffects : hooks.toolEffects
          effects.push(...registered)
          return {
            dispose: Effect.sync((): void => {
              disposeEffects(registered, effects)
              removeLast(hooks.toolRegistrations, name)
            }),
          }
        }),
        (registration: { readonly dispose: Effect.Effect<void> }): Effect.Effect<void> =>
          registration.dispose,
      ),
  },
  model: {
    list: (): Effect.Effect<ModelListOutput> =>
      Effect.sync((): ModelListOutput => {
        sdk.modelReads++
        return sdk.models
      }),
  },
  event: {
    subscribe: (): Stream.Stream<OpenCodeEvent, unknown> => {
      hooks.eventSubscriptions++
      return eventStream
    },
  },
})

const emptySdk = (): SdkResponses => ({
  messages: new Map(),
  models: {
    location: Schema.decodeUnknownSync(Location.PublicRef)({ directory: "/tmp/agent-reminders" }),
    data: [],
  },
  contextReads: 0,
  modelReads: 0,
})

const modelInfo = (context: number, id = "gpt-test", providerID = "openai"): Model.Info => {
  const model = Model.Info.default(
    Schema.decodeUnknownSync(Provider.ID)(providerID),
    Schema.decodeUnknownSync(Model.ID)(id),
  )
  return { ...model, limit: { ...model.limit, context } }
}

const contextEvent = (
  session: string,
  agent = "build",
  modelID = "gpt-test",
  providerID = "openai",
): SessionHooks["context"] => ({
  sessionID: Schema.decodeUnknownSync(Session.ID)(session),
  agent: Schema.decodeUnknownSync(Agent.ID)(agent),
  model: Schema.decodeUnknownSync(Model.Ref)({ providerID, id: modelID }),
  system: [],
  messages: [],
  options: {},
  tools: {},
})

const reminderTexts = (
  event: SessionHooks["context"] | undefined,
): Array<string> | undefined =>
  event?.system.map(
    (part: SessionHooks["context"]["system"][number]): string => part.text,
  )

const sessionIDFrom = (session: string): Schema.Schema.Type<typeof Session.ID> =>
  Schema.decodeUnknownSync(Session.ID)(session)

type DurableEventEnvelope = Pick<
  Extract<OpenCodeEvent, { readonly type: "session.agent.selected" }>,
  "id" | "created" | "durable"
>

const durableEventEnvelope = (
  sessionID: Schema.Schema.Type<typeof Session.ID>,
): DurableEventEnvelope => ({
  id: Event.ID.create(),
  created: 0,
  durable: {
    aggregateID: sessionID,
    seq: Schema.decodeUnknownSync(Event.Seq)(1),
    version: Schema.decodeUnknownSync(Event.Version)(1),
  },
})

const agentSelectedEvent = (
  session: string,
  agent: string,
  previous?: string,
): OpenCodeEvent => {
  const sessionID = sessionIDFrom(session)
  return {
    ...durableEventEnvelope(sessionID),
    type: "session.agent.selected",
    data: {
      sessionID,
      agent: Schema.decodeUnknownSync(Agent.ID)(agent),
      ...(previous === undefined ? {} : { previous: Schema.decodeUnknownSync(Agent.ID)(previous) }),
    },
  }
}

const sessionDeletedEvent = (session: string): OpenCodeEvent => {
  const sessionID = sessionIDFrom(session)
  return {
    ...durableEventEnvelope(sessionID),
    type: "session.deleted",
    data: { sessionID },
  }
}

const compactionEndedEvent = (session: string): OpenCodeEvent => {
  const sessionID = sessionIDFrom(session)
  return {
    ...durableEventEnvelope(sessionID),
    type: "session.compaction.ended",
    data: {
      sessionID,
      reason: "manual",
      text: "Summary",
      recent: "Recent",
    },
  }
}

const assistantUsage = (
  id: string,
  tokens: {
    readonly input: number
    readonly output?: number
    readonly reasoning?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  },
): SessionContextOutput[number] =>
  Schema.decodeUnknownSync(SessionMessage.Info)({
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-test" },
    content: [],
    time: { created: 1 },
    id,
    tokens: {
      input: tokens.input,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
    },
  })

const assistantWithoutUsage = (id: string): SessionContextOutput[number] =>
  Schema.decodeUnknownSync(SessionMessage.Info)({
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-test" },
    content: [],
    time: { created: 1 },
    id,
  })

const completedCompaction = (id: string): SessionContextOutput[number] =>
  Schema.decodeUnknownSync(SessionMessage.Info)({
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Summary",
    recent: "Recent",
    id,
    time: { created: 1 },
  })

const beforeEvent = (
  tool: string,
  call: string,
  session = "ses_test",
  message = "msg_test",
  agent = "build",
): ToolHooks["execute.before"] => ({
  tool,
  sessionID: Schema.decodeUnknownSync(Session.ID)(session),
  agent: Schema.decodeUnknownSync(Agent.ID)(agent),
  messageID: Schema.decodeUnknownSync(SessionMessage.ID)(message),
  id: Schema.decodeUnknownSync(Tool.CallID)(call),
  input: {},
})

const failedAfterEvent = (event: ToolHooks["execute.before"]): ToolHooks["execute.after"] => ({
  ...event,
  status: "error",
  error: new Tool.Error({ message: "Fixture tool failure" }),
})

const makeHooks = (input: {
  readonly contexts: ReadonlyArray<SessionHooks["context"]>
  readonly before?: ReadonlyArray<ToolHooks["execute.before"]>
  readonly after?: ReadonlyArray<ToolHooks["execute.after"]>
}): Hooks => ({
  sessionInputs: { context: input.contexts },
  toolInputs: {
    "execute.before": input.before ?? [],
    "execute.after": input.after ?? [],
  },
  sessionEffects: [],
  toolEffects: [],
  toolAfterEffects: [],
  sessionRegistrations: [],
  toolRegistrations: [],
  eventSubscriptions: 0,
})

const requiredEffect = (
  effects: ReadonlyArray<Effect.Effect<void>>,
  index: number,
): Effect.Effect<void> => effects[index] ?? Effect.die("test hook event was not registered")

const makeEventPublisher = (): Effect.Effect<EventPublisher, never, Scope.Scope> =>
  Effect.gen(function*(): Effect.fn.Return<EventPublisher, never, Scope.Scope> {
    const queue = yield* Effect.acquireRelease(
      Queue.unbounded<EventEnvelope>(),
      (events: Queue.Queue<EventEnvelope>): Effect.Effect<void> => Queue.shutdown(events),
    )
    const terminated = yield* Deferred.make<void>()
    let previous: EventEnvelope | undefined
    const pull: Effect.Effect<OpenCodeEvent> = Effect.gen(
      function*(): Effect.fn.Return<OpenCodeEvent> {
        if (previous !== undefined) yield* Deferred.succeed(previous.acknowledgment, undefined)
        const envelope: EventEnvelope = yield* Queue.take(queue)
        previous = envelope
        return envelope.event
      },
    )
    const stream: Stream.Stream<OpenCodeEvent, unknown> = Stream.fromEffectRepeat(pull).pipe(
      Stream.ensuring(
        Effect.flatMap(
          Deferred.succeed(terminated, undefined),
          (): Effect.Effect<void> => Effect.void,
        ),
      ),
    )
    const publish = (event: OpenCodeEvent): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        const acknowledgment = yield* Deferred.make<void>()
        yield* Queue.offer(queue, { event, acknowledgment })
        yield* Effect.raceFirst(
          Deferred.await(acknowledgment),
          Deferred.await(terminated).pipe(
            Effect.flatMap((): Effect.Effect<never> => Effect.interrupt),
          ),
        )
      })
    return { stream, publish }
  })

const runPlugin = async <A>(
  options: ReminderContext["options"],
  hooks: Hooks,
  sdk: SdkResponses,
  exercise: (publisher: EventPublisher) => Effect.Effect<A>,
): Promise<A> => {
  return Effect.runPromise(
    Effect.provide(
      Effect.scoped(Effect.gen(function*(): Effect.fn.Return<A, never, Scope.Scope> {
        const publisher: EventPublisher = yield* makeEventPublisher()
        const context = makeReminderContext(
          options,
          hooks,
          sdk,
          publisher.stream,
        )
        yield* agentReminders.effect(context)
        return yield* exercise(publisher)
      })),
      TestClock.layer(),
    ),
  )
}

test("a matching outer shell call appends its configured system reminder", async (): Promise<void> => {
  const outgoing = contextEvent("ses_test")
  const before = beforeEvent("shell", "call_shell")
  const hooks = makeHooks({ contexts: [outgoing, outgoing], before: [before] })
  const sdk: SdkResponses = emptySdk()
  await runPlugin(
    {
      agents: {
        build: {
          message: "Reconsider delegation before continuing.",
          condition: { type: "toolCalls", count: 1, tools: ["shell"] },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(
          reminderTexts(outgoing),
        ).toEqual([
          "Reconsider delegation before continuing.",
        ])
        expect(outgoing.messages).toEqual([])
        expect(hooks.sessionRegistrations).toEqual(["context"])
        expect(hooks.toolRegistrations).toEqual(["execute.before", "execute.after"])
        expect(hooks.eventSubscriptions).toBe(1)
      }),
  )
  expect(hooks.sessionRegistrations).toEqual([])
  expect(hooks.toolRegistrations).toEqual([])
  expect(hooks.sessionEffects).toEqual([])
  expect(hooks.toolEffects).toEqual([])
  expect(hooks.toolAfterEffects).toEqual([])
})

test("default tools count outer calls once and count failed calls", async (): Promise<void> => {
  const initial = contextEvent("ses_default")
  const afterOuter = contextEvent("ses_default")
  const afterShell = contextEvent("ses_default")
  const outer = beforeEvent("execute", "call_execute", "ses_default", "msg_default")
  const nestedShell = beforeEvent("shell", "call_execute", "ses_default", "msg_default")
  const nestedRead = beforeEvent("read", "call_execute", "ses_default", "msg_default")
  const shell = beforeEvent("shell", "call_shell", "ses_default", "msg_default")
  const hooks = makeHooks({
    contexts: [initial, afterOuter, afterShell],
    before: [outer, nestedShell, nestedRead, shell],
    after: [
      failedAfterEvent(nestedShell),
      failedAfterEvent(nestedRead),
      failedAfterEvent(outer),
      failedAfterEvent(shell),
    ],
  })

  await runPlugin(
    {
      agents: {
        build: { message: "Reconsider delegation.", condition: { type: "toolCalls", count: 2 } },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolEffects, 2)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 2)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(afterOuter.system).toEqual([])
        yield* requiredEffect(hooks.toolEffects, 3)
        yield* requiredEffect(hooks.toolAfterEffects, 3)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(reminderTexts(afterShell)).toEqual(["Reconsider delegation."])
      }),
  )
})

test("concurrent execute calls count separately while their nested tools count zero", async (): Promise<void> => {
  const session = "ses_concurrent_execute"
  const initial = contextEvent(session)
  const outgoing = contextEvent(session)
  const outerA = beforeEvent("execute", "call_execute_a", session, "msg_concurrent")
  const nestedA = beforeEvent("shell", "call_execute_a", session, "msg_concurrent")
  const outerB = beforeEvent("execute", "call_execute_b", session, "msg_concurrent")
  const nestedB = beforeEvent("read", "call_execute_b", session, "msg_concurrent")
  const hooks = makeHooks({
    contexts: [initial, outgoing],
    before: [outerA, nestedA, outerB, nestedB],
    after: [
      failedAfterEvent(nestedA),
      failedAfterEvent(nestedB),
      failedAfterEvent(outerB),
      failedAfterEvent(outerA),
    ],
  })

  await runPlugin(
    {
      agents: {
        build: {
          message: "Concurrent calls reminder.",
          condition: { type: "toolCalls", count: 2 },
        },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        for (let index = 0; index < 4; index++) yield* requiredEffect(hooks.toolEffects, index)
        for (let index = 0; index < 4; index++) yield* requiredEffect(hooks.toolAfterEffects, index)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(
          reminderTexts(outgoing),
        ).toEqual(["Concurrent calls reminder."])
      }),
  )
})

test("sessions keep independent tool counters and reminder reset cycles", async (): Promise<void> => {
  const sessionA = "ses_independent_a"
  const sessionB = "ses_independent_b"
  const contexts = [
    contextEvent(sessionA),
    contextEvent(sessionB),
    contextEvent(sessionA),
    contextEvent(sessionB),
    contextEvent(sessionB),
    contextEvent(sessionB),
    contextEvent(sessionB),
    contextEvent(sessionA),
  ]
  const calls = [
    beforeEvent("shell", "call_a1", sessionA, "msg_a"),
    beforeEvent("shell", "call_b1", sessionB, "msg_b"),
    beforeEvent("shell", "call_b2", sessionB, "msg_b"),
    beforeEvent("shell", "call_b3", sessionB, "msg_b"),
    beforeEvent("shell", "call_b4", sessionB, "msg_b"),
    beforeEvent("shell", "call_a2", sessionA, "msg_a"),
  ]
  const hooks = makeHooks({ contexts, before: calls, after: calls.map(failedAfterEvent) })

  await runPlugin(
    {
      agents: {
        build: {
          message: "Session-local reminder.",
          condition: { type: "toolCalls", count: 2, tools: ["shell"] },
        },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])

        for (let index = 1; index < calls.length; index++) {
          yield* requiredEffect(hooks.toolEffects, index)
          yield* requiredEffect(hooks.toolAfterEffects, index)
          yield* requiredEffect(hooks.sessionEffects, index + 2)
          const expected = index === 2 || index === 4 || index === 5
            ? ["Session-local reminder."]
            : []
          expect(reminderTexts(contexts[index + 2]) ?? []).toEqual(expected)
        }
      }),
  )
})

test("duplicate names in a custom tool list do not double-count one invocation", async (): Promise<void> => {
  const session = "ses_duplicate_tool_names"
  const contexts = [contextEvent(session), contextEvent(session), contextEvent(session)]
  const calls = [
    beforeEvent("shell", "call_duplicate_one", session, "msg_duplicate"),
    beforeEvent("shell", "call_duplicate_two", session, "msg_duplicate"),
  ]
  const hooks = makeHooks({ contexts, before: calls, after: calls.map(failedAfterEvent) })

  await runPlugin(
    {
      agents: {
        build: {
          message: "Duplicate-list reminder.",
          condition: { type: "toolCalls", count: 2, tools: ["shell", "shell"] },
        },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 1)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual([
          "Duplicate-list reminder.",
        ])
      }),
  )
})

test("context growth uses reported occupied tokens, excludes the initial sample, and resets after delivery", async (): Promise<void> => {
  const session = "ses_context_growth"
  const contexts = [0, 1, 2, 3].map((_index: number): SessionHooks["context"] =>
    contextEvent(session)
  )
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = []

  await runPlugin(
    {
      agents: {
        build: {
          message: "Context reminder.",
          condition: { type: "contextGrowth", tokens: 100 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        history = [...history, assistantUsage("msg_usage_initial", { input: 10_000 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 0)
        expect(contexts[0]?.system).toEqual([])

        history = [
          ...history,
          assistantUsage("msg_usage_below", {
            input: 10_070,
            output: 10,
            reasoning: 10,
            cacheRead: 9,
          }),
        ]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [
          ...history,
          assistantUsage("msg_usage_at", {
            input: 10_070,
            output: 10,
            reasoning: 10,
            cacheRead: 9,
            cacheWrite: 1,
          }),
        ]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Context reminder."])

        history = [
          ...history,
          assistantUsage("msg_usage_after_reset", { input: 10_181, cacheRead: 20 }),
        ]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Context reminder."])
      }),
  )
})

test("zero and missing usage leave the context baseline unknown until a positive sample arrives", async (): Promise<void> => {
  const session = "ses_zero_usage"
  const contexts = [0, 1, 2, 3].map((_index: number): SessionHooks["context"] =>
    contextEvent(session)
  )
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = []

  await runPlugin(
    {
      agents: {
        build: {
          message: "Usage reminder.",
          condition: { type: "contextGrowth", tokens: 10 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        expect(contexts[0]?.system).toEqual([])

        history = [...history, assistantUsage("msg_zero_usage", { input: 0 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_first_positive", { input: 10 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])

        history = [...history, assistantUsage("msg_growth_threshold", { input: 20 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Usage reminder."])
      }),
  )
})

test("a latest zero-usage assistant invalidates an older positive context sample", async (): Promise<void> => {
  const session = "ses_latest_zero_usage"
  const contexts = [0, 1, 2].map((_index: number): SessionHooks["context"] => contextEvent(session))
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [
    assistantUsage("msg_old_positive", { input: 100 }),
    assistantUsage("msg_latest_zero", { input: 0 }),
  ]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Latest usage reminder.",
          condition: { type: "contextGrowth", tokens: 50 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        expect(contexts[0]?.system).toEqual([])

        history = [...history, assistantUsage("msg_first_usable", { input: 10_000 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_growth_threshold", { input: 10_050 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual([
          "Latest usage reminder.",
        ])
      }),
  )
})

test("assistant messages without token data are skipped when selecting occupied context", async (): Promise<void> => {
  const session = "ses_missing_token_data"
  const contexts = [contextEvent(session), contextEvent(session)]
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  const history: SessionContextOutput = [
    assistantUsage("msg_token_usage", { input: 100 }),
    assistantWithoutUsage("msg_without_usage"),
  ]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Missing-usage reminder.",
          condition: { type: "contextGrowth", tokens: 50 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        expect(contexts[0]?.system).toEqual([])
      }),
  )
})

test("recursive all/any conditions sum each leaf's selected tools and reset after reminders", async (): Promise<void> => {
  const session = "ses_composite_tools"
  const toolNames = [
    "shell",
    "read",
    "write",
    "shell",
    "read",
    "shell",
    "read",
    "write",
    "shell",
    "read",
  ]
  const contexts = Array.from(
    { length: toolNames.length + 1 },
    (_value: unknown, _index: number): SessionHooks["context"] => contextEvent(session),
  )
  const before = toolNames.map((tool: string, index: number): ToolHooks["execute.before"] =>
    beforeEvent(tool, `call_composite_${index}`, session, `msg_composite_${index}`)
  )
  const hooks = makeHooks({
    contexts,
    before,
    after: before.map(failedAfterEvent),
  })
  const sdk = emptySdk()

  await runPlugin(
    {
      agents: {
        build: {
          message: "Composite reminder.",
          condition: {
            type: "any",
            conditions: [
              {
                type: "all",
                conditions: [
                  { type: "toolCalls", count: 3, tools: ["shell", "read", "shell"] },
                  { type: "toolCalls", count: 3, tools: ["read", "write"] },
                ],
              },
              { type: "elapsedTime", seconds: 1 },
            ],
          },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        for (let index = 0; index < toolNames.length; index++) {
          yield* requiredEffect(hooks.toolEffects, index)
          yield* requiredEffect(hooks.toolAfterEffects, index)
          if (index === 4) yield* TestClock.adjust("1 second")
          yield* requiredEffect(hooks.sessionEffects, index + 1)
          const expected = index === 4 || index === 9 ? ["Composite reminder."] : []
          expect(reminderTexts(contexts[index + 1]) ?? []).toEqual(expected)
        }
        expect(sdk.contextReads).toBe(0)
        expect(sdk.modelReads).toBe(0)
        expect(hooks.sessionRegistrations).toEqual(["context"])
        expect(hooks.eventSubscriptions).toBe(1)
      }),
  )
})

test("context utilization uses the current model limit and percentage-point growth", async (): Promise<void> => {
  const session = "ses_context_utilization"
  const contexts = [
    contextEvent(session),
    contextEvent(session),
    contextEvent(session, "build", "gpt-test"),
    contextEvent(session, "build", "gpt-larger"),
    contextEvent(session, "build", "gpt-larger"),
  ]
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = []
  sdk.models = {
    ...sdk.models,
    data: [modelInfo(1_000), modelInfo(2_000, "gpt-larger")],
  }

  await runPlugin(
    {
      agents: {
        build: {
          message: "Utilization reminder.",
          condition: { type: "contextUtilizationGrowth", percentagePoints: 5 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        history = [...history, assistantUsage("msg_usage_initial", { input: 100 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 0)

        history = [...history, assistantUsage("msg_usage_below", { input: 149 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_usage_at", { input: 150 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Utilization reminder."])

        history = [...history, assistantUsage("msg_usage_model_switch", { input: 150 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(contexts[3]?.system).toEqual([])

        history = [...history, assistantUsage("msg_usage_above", { input: 251 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 4)
        expect(
          reminderTexts(contexts[4]),
        ).toEqual(["Utilization reminder."])
      }),
  )
})

test("missing and invalid model limits cannot satisfy utilization conditions", async (): Promise<void> => {
  const session = "ses_missing_limit"
  const contexts = [
    contextEvent(session),
    contextEvent(session),
    contextEvent(session),
    contextEvent(session),
  ]
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [assistantUsage("msg_limit_initial", { input: 100 })]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Model-limit reminder.",
          condition: { type: "contextUtilizationGrowth", percentagePoints: 5 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)

        history = [...history, assistantUsage("msg_limit_growth", { input: 200 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        sdk.models = { ...sdk.models, data: [modelInfo(0)] }
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])

        sdk.models = { ...sdk.models, data: [modelInfo(1_000)] }
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Model-limit reminder."])
      }),
  )
})

test("configured agents receive their own messages and other agents receive none", async (): Promise<void> => {
  const buildSession = "ses_role_build"
  const reviewSession = "ses_role_review"
  const contexts = [
    contextEvent(buildSession, "build"),
    contextEvent(reviewSession, "review"),
    contextEvent(buildSession, "build"),
    contextEvent(reviewSession, "review"),
    contextEvent("ses_role_unknown", "unconfigured"),
  ]
  const calls = [
    beforeEvent("shell", "call_role_build", buildSession, "msg_role_build", "build"),
    beforeEvent("shell", "call_role_review", reviewSession, "msg_role_review", "review"),
  ]
  const hooks = makeHooks({ contexts, before: calls, after: calls.map(failedAfterEvent) })
  const sdk = emptySdk()

  await runPlugin(
    {
      agents: {
        build: {
          message: "Build-specific message.",
          condition: { type: "toolCalls", count: 1, tools: ["shell"] },
        },
        review: {
          message: "Review-specific message.",
          condition: { type: "toolCalls", count: 1, tools: ["shell"] },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Build-specific message."])

        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 1)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Review-specific message."])
        yield* requiredEffect(hooks.sessionEffects, 4)
        expect(contexts[4]?.system).toEqual([])
        expect(sdk.contextReads).toBe(0)
        expect(sdk.modelReads).toBe(0)
      }),
  )
})

test("malformed recursive conditions fail plugin initialization clearly", async (): Promise<void> => {
  const invalidConfigurations: ReadonlyArray<ReminderContext["options"]> = [
    {
      agents: {
        build: {
          message: "Invalid threshold.",
          condition: { type: "toolCalls", count: 0 },
        },
      },
    },
    {
      agents: {
        build: {
          message: "Invalid composition.",
          condition: { type: "all", conditions: [] },
        },
      },
    },
    {
      agents: {
        build: {
          message: "Unknown condition field.",
          condition: { type: "elapsedTime", seconds: 5, steps: 3 },
        },
      },
    },
    {
      agents: {
        build: {
          message: "Unknown condition type.",
          condition: { type: "steps", count: 3 },
        },
      },
    },
    {
      agents: {
        build: {
          message: "Unknown nested condition type.",
          condition: {
            type: "all",
            conditions: [{ type: "any", conditions: [{ type: "steps", count: 3 }] }],
          },
        },
      },
    },
  ]

  for (const options of invalidConfigurations) {
    await expect(
      runPlugin(
        options,
        makeHooks({ contexts: [] }),
        emptySdk(),
        (): Effect.Effect<void> => Effect.void,
      ),
    )
      .rejects.toThrow("Invalid agent reminder configuration")
  }
})

test("elapsed-time reminders wait for an ordinary continuation and use inclusive wall-clock thresholds", async (): Promise<void> => {
  const contexts = [
    contextEvent("ses_elapsed"),
    contextEvent("ses_elapsed"),
    contextEvent("ses_elapsed"),
    contextEvent("ses_elapsed"),
  ]
  const hooks = makeHooks({ contexts })

  await runPlugin(
    {
      agents: {
        build: { message: "Time reminder.", condition: { type: "elapsedTime", seconds: 60 } },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* TestClock.adjust("59 seconds")
        expect(contexts[1]?.system).toEqual([])
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        yield* TestClock.adjust("1 second")
        expect(contexts[2]?.system).toEqual([])
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Time reminder."])

        yield* TestClock.adjust("61 seconds")
        expect(contexts[3]?.system).toEqual([])
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Time reminder."])
      }),
  )
})

test("prototype property names are not treated as configured agents", async (): Promise<void> => {
  const contexts = [
    contextEvent("ses_constructor", "constructor"),
    contextEvent("ses_to_string", "toString"),
  ]
  const hooks = makeHooks({ contexts })

  await runPlugin(
    { agents: {} },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(
          contexts.map((event: SessionHooks["context"]): SessionHooks["context"]["system"] =>
            event.system
          ),
        ).toEqual([[], []])
      }),
  )
})

test("explicitly configured prototype-like agent names receive reminders while a missing prototype-like name receives none", async (): Promise<void> => {
  const constructorSession = "ses_prototype_constructor"
  const toStringSession = "ses_prototype_to_string"
  const missingSession = "ses_prototype_missing"
  const contexts = [
    contextEvent(constructorSession, "constructor"),
    contextEvent(toStringSession, "toString"),
    contextEvent(missingSession, "valueOf"),
    contextEvent(constructorSession, "constructor"),
    contextEvent(toStringSession, "toString"),
    contextEvent(missingSession, "valueOf"),
  ]
  const calls = [
    beforeEvent(
      "shell",
      "call_prototype_constructor",
      constructorSession,
      "msg_prototype_constructor",
      "constructor",
    ),
    beforeEvent(
      "shell",
      "call_prototype_to_string",
      toStringSession,
      "msg_prototype_to_string",
      "toString",
    ),
    beforeEvent(
      "shell",
      "call_prototype_missing",
      missingSession,
      "msg_prototype_missing",
      "valueOf",
    ),
  ]
  const hooks = makeHooks({ contexts, before: calls, after: calls.map(failedAfterEvent) })

  await runPlugin(
    {
      agents: {
        constructor: {
          message: "Constructor-named reminder.",
          condition: { type: "toolCalls", count: 1, tools: ["shell"] },
        },
        toString: {
          message: "ToString-named reminder.",
          condition: { type: "toolCalls", count: 1, tools: ["shell"] },
        },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        yield* requiredEffect(hooks.sessionEffects, 2)

        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(reminderTexts(contexts[3])).toEqual(["Constructor-named reminder."])

        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 1)
        yield* requiredEffect(hooks.sessionEffects, 4)
        expect(reminderTexts(contexts[4])).toEqual(["ToString-named reminder."])

        yield* requiredEffect(hooks.toolEffects, 2)
        yield* requiredEffect(hooks.toolAfterEffects, 2)
        yield* requiredEffect(hooks.sessionEffects, 5)
        expect(contexts[5]?.system).toEqual([])
      }),
  )
})

test("agent-selected events reset at switch time while redundant selections leave intervals intact", async (): Promise<void> => {
  const session = "ses_agent_switch"
  const contexts = [
    contextEvent(session, "build"),
    contextEvent(session, "build"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
  ]
  const hooks = makeHooks({ contexts })

  await runPlugin(
    {
      agents: {
        build: { message: "Build reminder.", condition: { type: "elapsedTime", seconds: 60 } },
        review: { message: "Review reminder.", condition: { type: "elapsedTime", seconds: 60 } },
      },
    },
    hooks,
    emptySdk(),
    (events: EventPublisher): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* TestClock.adjust("30 seconds")
        yield* events.publish(agentSelectedEvent(session, "build", "build"))
        yield* TestClock.adjust("30 seconds")
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(
          reminderTexts(contexts[1]),
        ).toEqual(["Build reminder."])

        yield* events.publish(agentSelectedEvent(session, "review", "build"))
        yield* TestClock.adjust("59 seconds")
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])
        yield* TestClock.adjust("1 second")
        expect(contexts[3]?.system).toEqual([])
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Review reminder."])

        yield* events.publish(agentSelectedEvent(session, "idle", "review"))
        yield* events.publish(agentSelectedEvent(session, "review", "idle"))
        yield* TestClock.adjust("59 seconds")
        yield* requiredEffect(hooks.sessionEffects, 4)
        expect(contexts[4]?.system).toEqual([])
        yield* TestClock.adjust("1 second")
        yield* requiredEffect(hooks.sessionEffects, 5)
        expect(
          reminderTexts(contexts[5]),
        ).toEqual(["Review reminder."])
      }),
  )
})

test("the first configured agent-selected event starts the elapsed interval immediately", async (): Promise<void> => {
  const session = "ses_first_agent_event"
  const outgoing = contextEvent(session, "build")
  const hooks = makeHooks({ contexts: [outgoing] })

  await runPlugin(
    {
      agents: {
        build: {
          message: "First-event reminder.",
          condition: { type: "elapsedTime", seconds: 60 },
        },
      },
    },
    hooks,
    emptySdk(),
    (events: EventPublisher): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* events.publish(agentSelectedEvent(session, "build"))
        yield* TestClock.adjust("60 seconds")
        yield* requiredEffect(hooks.sessionEffects, 0)
        expect(
          reminderTexts(outgoing),
        ).toEqual(["First-event reminder."])
      }),
  )
})

test("an agent switch establishes the new context baseline on its first usable sample", async (): Promise<void> => {
  const session = "ses_agent_context_baseline"
  const contexts = [
    contextEvent(session, "build"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
  ]
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [assistantUsage("msg_before_agent_switch", { input: 100 })]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Build context reminder.",
          condition: { type: "contextGrowth", tokens: 1_000 },
        },
        review: {
          message: "Review context reminder.",
          condition: { type: "contextGrowth", tokens: 50 },
        },
      },
    },
    hooks,
    sdk,
    (events: EventPublisher): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* events.publish(agentSelectedEvent(session, "review", "build"))
        history = [...history, assistantUsage("msg_after_agent_switch", { input: 150 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_review_growth", { input: 200 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Review context reminder."])
      }),
  )
})

test("an unconfigured role's accumulated context does not count when switching back", async (): Promise<void> => {
  const session = "ses_unconfigured_context_switch"
  const contexts = [
    contextEvent(session, "build"),
    contextEvent(session, "idle"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
  ]
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [assistantUsage("msg_before_idle", { input: 100 })]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Build context reminder.",
          condition: { type: "contextGrowth", tokens: 1_000 },
        },
        review: {
          message: "Review context reminder.",
          condition: { type: "contextGrowth", tokens: 50 },
        },
      },
    },
    hooks,
    sdk,
    (events: EventPublisher): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* events.publish(agentSelectedEvent(session, "idle", "build"))

        history = [...history, assistantUsage("msg_while_unconfigured", { input: 500 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        yield* events.publish(agentSelectedEvent(session, "review", "idle"))

        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])

        history = [...history, assistantUsage("msg_after_switch_back", { input: 550 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual(["Review context reminder."])
      }),
  )
})

test("an agent change observed at the context hook starts with a fresh baseline", async (): Promise<void> => {
  const session = "ses_context_fallback_switch"
  const contexts = [
    contextEvent(session, "build"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
  ]
  const hooks = makeHooks({ contexts })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [
    assistantUsage("msg_before_context_fallback", { input: 100 }),
  ]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Build reminder.",
          condition: { type: "contextGrowth", tokens: 1_000 },
        },
        review: {
          message: "Review reminder.",
          condition: { type: "contextGrowth", tokens: 50 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        history = [...history, assistantUsage("msg_first_context_fallback", { input: 150 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_second_context_fallback", { input: 200 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Review reminder."])
      }),
  )
})

test("an agent change observed at a tool hook starts with a fresh baseline", async (): Promise<void> => {
  const session = "ses_tool_fallback_switch"
  const contexts = [
    contextEvent(session, "build"),
    contextEvent(session, "review"),
    contextEvent(session, "review"),
  ]
  const switchTool = beforeEvent(
    "shell",
    "call_tool_fallback",
    session,
    "msg_tool_fallback",
    "review",
  )
  const hooks = makeHooks({ contexts, before: [switchTool], after: [failedAfterEvent(switchTool)] })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [assistantUsage("msg_before_tool_fallback", { input: 100 })]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Build reminder.",
          condition: { type: "contextGrowth", tokens: 1_000 },
        },
        review: {
          message: "Review reminder.",
          condition: { type: "contextGrowth", tokens: 50 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        history = [...history, assistantUsage("msg_first_tool_fallback", { input: 150 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_second_tool_fallback", { input: 200 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual(["Review reminder."])
      }),
  )
})

test("successful compaction rebases context while preserving elapsed time and tool counts", async (): Promise<void> => {
  const session = "ses_compaction"
  const contexts = [contextEvent(session), contextEvent(session), contextEvent(session)]
  const shell = beforeEvent("shell", "call_compaction_shell", session, "msg_compaction")
  const hooks = makeHooks({ contexts, before: [shell], after: [failedAfterEvent(shell)] })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = [assistantUsage("msg_pre_compaction", { input: 1_000 })]
  sdk.messages.set(sessionID, history)

  await runPlugin(
    {
      agents: {
        build: {
          message: "Post-compaction reminder.",
          condition: {
            type: "all",
            conditions: [
              { type: "elapsedTime", seconds: 60 },
              { type: "toolCalls", count: 1, tools: ["shell"] },
              { type: "contextGrowth", tokens: 100 },
            ],
          },
        },
      },
    },
    hooks,
    sdk,
    (events: EventPublisher): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* TestClock.adjust("20 seconds")

        yield* events.publish(compactionEndedEvent(session))
        history = [
          completedCompaction("msg_compaction_marker"),
          assistantUsage("msg_post_compaction", { input: 100 }),
        ]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        yield* TestClock.adjust("40 seconds")
        history = [...history, assistantUsage("msg_post_compaction_growth", { input: 200 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual([
          "Post-compaction reminder.",
        ])
      }),
  )
})

test("session deletion clears interval state and scoped hook registrations are disposed", async (): Promise<void> => {
  const session = "ses_deleted"
  const contexts = [
    contextEvent(session),
    contextEvent(session),
    contextEvent(session),
    contextEvent(session),
  ]
  const calls = [
    beforeEvent("shell", "call_before_delete", session, "msg_deleted"),
    beforeEvent("shell", "call_after_delete_1", session, "msg_deleted"),
    beforeEvent("shell", "call_after_delete_2", session, "msg_deleted"),
  ]
  const hooks = makeHooks({ contexts, before: calls, after: calls.map(failedAfterEvent) })
  const options = {
    agents: {
      build: {
        message: "Deleted-session reminder.",
        condition: { type: "toolCalls", count: 2, tools: ["shell"] },
      },
    },
  }

  await runPlugin(
    options,
    hooks,
    emptySdk(),
    (events: EventPublisher): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        yield* events.publish(sessionDeletedEvent(session))
        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 1)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])

        yield* requiredEffect(hooks.toolEffects, 2)
        yield* requiredEffect(hooks.toolAfterEffects, 2)
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(
          reminderTexts(contexts[3]),
        ).toEqual([
          "Deleted-session reminder.",
        ])
      }),
  )

  expect(hooks.sessionEffects).toEqual([])
  expect(hooks.toolEffects).toEqual([])
  expect(hooks.toolAfterEffects).toEqual([])
})

test("scope closure prevents an in-flight context hook from appending a stale reminder", async (): Promise<void> => {
  const session = "ses_scope_close_in_flight"
  const initial = contextEvent(session)
  const pending = contextEvent(session)
  const outerCall = beforeEvent("shell", "call_scope_close", session, "msg_scope_close")
  const hooks = makeHooks({
    contexts: [initial, pending],
    before: [outerCall],
    after: [failedAfterEvent(outerCall)],
  })
  const sdk = emptySdk()
  const options = {
    agents: {
      build: {
        message: "Stale scope reminder.",
        condition: {
          type: "any",
          conditions: [
            { type: "toolCalls", count: 1, tools: ["shell"] },
            { type: "contextGrowth", tokens: 100 },
          ],
        },
      },
    },
  }

  const program = Effect.scoped(
    Effect.gen(function*(): Effect.fn.Return<void, never, Scope.Scope> {
      const publisher: EventPublisher = yield* makeEventPublisher()
      const pluginScope = yield* Scope.make()
      const context = makeReminderContext(options, hooks, sdk, publisher.stream)
      yield* Effect.provideService(agentReminders.effect(context), Scope.Scope, pluginScope)
      yield* requiredEffect(hooks.sessionEffects, 0)
      yield* requiredEffect(hooks.toolEffects, 0)
      yield* requiredEffect(hooks.toolAfterEffects, 0)

      const contextReadStarted = yield* Deferred.make<void>()
      const contextResponse = yield* Deferred.make<SessionContextOutput>()
      sdk.contextRequest = (_sessionID: string): Effect.Effect<SessionContextOutput> =>
        Effect.gen(function*(): Effect.fn.Return<SessionContextOutput> {
          yield* Deferred.succeed(contextReadStarted, undefined)
          return yield* Deferred.await(contextResponse)
        })

      const contextCallback: Effect.Effect<void> = requiredEffect(hooks.sessionEffects, 1)
      const callerFiber = yield* contextCallback.pipe(Effect.forkChild)
      yield* Deferred.await(contextReadStarted)
      yield* Scope.close(pluginScope, Exit.succeed(undefined))
      yield* Deferred.succeed(contextResponse, [
        assistantUsage("msg_scope_response", { input: 200 }),
      ])
      yield* Fiber.join(callerFiber)

      expect(reminderTexts(pending)).toEqual([])
    }),
  )
  await Effect.runPromise(Effect.provide(program, TestClock.layer()))
})

test("a fresh plugin scope starts with fresh intervals after reload", async (): Promise<void> => {
  const options = {
    agents: {
      build: {
        message: "Reload reminder.",
        condition: { type: "toolCalls", count: 2, tools: ["shell"] },
      },
    },
  }
  const firstContext = contextEvent("ses_reload")
  const firstCall = beforeEvent("shell", "call_before_reload", "ses_reload", "msg_reload")
  const firstHooks = makeHooks({ contexts: [firstContext], before: [firstCall] })
  await runPlugin(
    options,
    firstHooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(firstHooks.sessionEffects, 0)
        yield* requiredEffect(firstHooks.toolEffects, 0)
      }),
  )

  const reloadedContext = contextEvent("ses_reload")
  const nextContext = contextEvent("ses_reload")
  const afterReloadCall = beforeEvent("shell", "call_after_reload", "ses_reload", "msg_reload")
  const reloadedHooks = makeHooks({
    contexts: [reloadedContext, nextContext],
    before: [afterReloadCall],
  })
  await runPlugin(
    options,
    reloadedHooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(reloadedHooks.sessionEffects, 0)
        yield* requiredEffect(reloadedHooks.toolEffects, 0)
        yield* requiredEffect(reloadedHooks.sessionEffects, 1)
        expect(nextContext.system).toEqual([])
      }),
  )
})

test("delegation resets to the latest known context sample", async (): Promise<void> => {
  const session = "ses_delegation_context"
  const contexts = [contextEvent(session), contextEvent(session), contextEvent(session)]
  const outer = beforeEvent("execute", "call_delegate", session, "msg_delegate")
  const delegation = beforeEvent("subagent", "call_delegate", session, "msg_delegate")
  const hooks = makeHooks({
    contexts,
    before: [outer, delegation],
    after: [failedAfterEvent(delegation), failedAfterEvent(outer)],
  })
  const sdk = emptySdk()
  const sessionID = sessionIDFrom(session)
  let history: SessionContextOutput = []

  await runPlugin(
    {
      agents: {
        build: {
          message: "Delegation context reminder.",
          condition: { type: "contextGrowth", tokens: 100 },
        },
      },
    },
    hooks,
    sdk,
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        history = [...history, assistantUsage("msg_before_delegate", { input: 100 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 1)

        history = [...history, assistantUsage("msg_after_delegate", { input: 150 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        history = [...history, assistantUsage("msg_delegation_threshold", { input: 200 })]
        sdk.messages.set(sessionID, history)
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(
          reminderTexts(contexts[2]),
        ).toEqual([
          "Delegation context reminder.",
        ])
      }),
  )
})

test("delegation resets tool counts and elapsed time in the same interval", async (): Promise<void> => {
  const session = "ses_delegation_interval"
  const contexts = Array.from(
    { length: 5 },
    (_value: unknown, _index: number): SessionHooks["context"] => contextEvent(session),
  )
  const shellBefore = beforeEvent(
    "shell",
    "call_before_delegation",
    session,
    "msg_delegation_interval",
  )
  const executeBefore = beforeEvent(
    "execute",
    "call_nested_delegation",
    session,
    "msg_delegation_interval",
  )
  const subagentBefore = beforeEvent(
    "subagent",
    "call_nested_delegation",
    session,
    "msg_delegation_interval",
  )
  const shellAfterOne = beforeEvent(
    "shell",
    "call_after_delegation_one",
    session,
    "msg_delegation_interval",
  )
  const shellAfterTwo = beforeEvent(
    "shell",
    "call_after_delegation_two",
    session,
    "msg_delegation_interval",
  )
  const hooks = makeHooks({
    contexts,
    before: [shellBefore, executeBefore, subagentBefore, shellAfterOne, shellAfterTwo],
    after: [
      failedAfterEvent(shellBefore),
      failedAfterEvent(subagentBefore),
      failedAfterEvent(executeBefore),
      failedAfterEvent(shellAfterOne),
      failedAfterEvent(shellAfterTwo),
    ],
  })

  await runPlugin(
    {
      agents: {
        build: {
          message: "Shared interval reminder.",
          condition: {
            type: "all",
            conditions: [
              { type: "elapsedTime", seconds: 60 },
              { type: "toolCalls", count: 2, tools: ["shell"] },
            ],
          },
        },
      },
    },
    hooks,
    emptySdk(),
    (): Effect.Effect<void> =>
      Effect.gen(function*(): Effect.fn.Return<void> {
        yield* requiredEffect(hooks.sessionEffects, 0)
        yield* requiredEffect(hooks.toolEffects, 0)
        yield* requiredEffect(hooks.toolAfterEffects, 0)
        yield* TestClock.adjust("30 seconds")
        yield* requiredEffect(hooks.toolEffects, 1)
        yield* requiredEffect(hooks.toolEffects, 2)
        yield* requiredEffect(hooks.toolAfterEffects, 1)
        yield* requiredEffect(hooks.toolAfterEffects, 2)

        yield* requiredEffect(hooks.toolEffects, 3)
        yield* requiredEffect(hooks.toolAfterEffects, 3)
        yield* requiredEffect(hooks.sessionEffects, 1)
        expect(contexts[1]?.system).toEqual([])

        yield* TestClock.adjust("30 seconds")
        yield* requiredEffect(hooks.sessionEffects, 2)
        expect(contexts[2]?.system).toEqual([])
        yield* TestClock.adjust("30 seconds")
        yield* requiredEffect(hooks.sessionEffects, 3)
        expect(contexts[3]?.system).toEqual([])

        yield* requiredEffect(hooks.toolEffects, 4)
        yield* requiredEffect(hooks.toolAfterEffects, 4)
        yield* requiredEffect(hooks.sessionEffects, 4)
        expect(
          reminderTexts(contexts[4]),
        ).toEqual([
          "Shared interval reminder.",
        ])
      }),
  )
})
