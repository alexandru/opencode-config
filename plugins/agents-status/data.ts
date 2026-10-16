import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { Clock, Effect, Option, Result, type Scope } from "effect"
import {
  type Catalog,
  catalog,
  type History,
  history,
  type HistoryAnalysis,
  type Observation,
  observe,
  type Reading,
  reading,
  type RequestFailure,
  type Snapshot,
  summarize,
} from "./model.ts"

type Client = {
  readonly session: Pick<OpenCodeClient["session"], "get" | "list">
  readonly message: Pick<OpenCodeClient["message"], "list">
  readonly model: Pick<OpenCodeClient["model"], "list">
}

interface Prepared {
  readonly session: SessionInfo
  readonly models: Effect.Effect<Result.Result<Catalog, RequestFailure>>
}

const request = <A>(run: () => PromiseLike<A>): Effect.Effect<A, RequestFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause: unknown): RequestFailure => ({
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  })

const messages = (
  client: Client["message"],
  signal: AbortSignal,
  session: Pick<SessionInfo, "id" | "revert">,
): Effect.Effect<History, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<History, RequestFailure> {
    let collected: Array<SessionMessageInfo> = []
    let cursor: Option.Option<string> = Option.none()
    const boundary: Option.Option<string> = Option.fromUndefinedOr(session.revert?.messageID)
    for (;;) {
      const page = yield* request((): ReturnType<Client["message"]["list"]> =>
        client.list({
          sessionID: session.id,
          limit: 100,
          order: "desc",
          cursor: Option.getOrUndefined(cursor),
        }, { signal })
      )
      collected = [...page.data.toReversed(), ...collected]
      const analysis: HistoryAnalysis = history(collected, boundary)
      if (analysis._tag === "Settled") return analysis.history
      cursor = Option.fromNullishOr(page.cursor.next)
      if (Option.isNone(cursor)) return { actual: analysis.actual, sample: Option.none() }
    }
  })

const sessions = (
  client: Client["session"],
  signal: AbortSignal,
  rootID: string,
): Effect.Effect<ReadonlyArray<SessionInfo>, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<ReadonlyArray<SessionInfo>, RequestFailure> {
    const root: SessionInfo = yield* request((): ReturnType<Client["session"]["get"]> =>
      client.get({ sessionID: rootID }, { signal })
    )
    const tree: Array<SessionInfo> = [root]
    const seen: Set<string> = new Set([root.id])
    for (const parent of tree) {
      let cursor: Option.Option<string> = Option.none()
      do {
        const page = yield* request((): ReturnType<Client["session"]["list"]> =>
          client.list({
            parentID: parent.id,
            limit: 200,
            order: "asc",
            cursor: Option.getOrUndefined(cursor),
          }, { signal })
        )
        for (const child of page.data) {
          if (child.parentID === parent.id && !seen.has(child.id)) {
            seen.add(child.id)
            tree.push(child)
          }
        }
        cursor = Option.fromNullishOr(page.cursor.next)
      } while (Option.isSome(cursor))
    }
    return tree
  })

const snapshot = (
  client: Client,
  signal: AbortSignal,
  rootID: string,
): Effect.Effect<Snapshot, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<Snapshot, RequestFailure> {
    const tree: ReadonlyArray<SessionInfo> = yield* sessions(client.session, signal, rootID)
    const catalogs: Map<string, Effect.Effect<Result.Result<Catalog, RequestFailure>>> = new Map()
    const prepared: Array<Prepared> = []
    for (const session of tree) {
      const key: string = session.location.directory
      const models: Effect.Effect<Result.Result<Catalog, RequestFailure>> = yield* Option.match(
        Option.fromUndefinedOr(catalogs.get(key)),
        {
          onSome: (
            cached: Effect.Effect<Result.Result<Catalog, RequestFailure>>,
          ): Effect.Effect<Effect.Effect<Result.Result<Catalog, RequestFailure>>> =>
            Effect.succeed(cached),
          onNone: (): Effect.Effect<Effect.Effect<Result.Result<Catalog, RequestFailure>>> =>
            Effect.cached(
              request((): ReturnType<Client["model"]["list"]> =>
                client.model.list({ location: session.location }, { signal })
              ).pipe(
                Effect.map((page): Catalog => catalog(page.data)),
                Effect.result,
              ),
            ),
        },
      )
      catalogs.set(key, models)
      prepared.push({ session, models })
    }
    const observations: ReadonlyArray<Observation> = yield* Effect.forEach(
      prepared,
      (item: Prepared): Effect.Effect<Observation> =>
        Effect.gen(function*(): Effect.fn.Return<Observation> {
          const values = yield* Effect.all({
            models: item.models,
            loaded: Effect.result(messages(client.message, signal, item.session)),
          }, { concurrency: "unbounded" })
          const value: Result.Result<Reading, RequestFailure> = Result.map(
            values.loaded,
            (value: History): Reading => reading(value, values.models),
          )
          return observe(item.session, rootID, value)
        }),
      { concurrency: "unbounded" },
    )
    return summarize(observations)
  })

export const watch = (
  client: Client,
  rootID: string,
  publish: (value: Result.Result<Snapshot, RequestFailure>) => void,
): Effect.Effect<never> =>
  Effect.scoped(Effect.gen(function*(): Effect.fn.Return<never, never, Scope.Scope> {
    const controller: AbortController = yield* Effect.acquireRelease(
      Effect.sync((): AbortController => new AbortController()),
      (value: AbortController): Effect.Effect<void> => Effect.sync((): void => value.abort()),
    )
    const origin: number = yield* Clock.currentTimeMillis
    const refresh: Effect.Effect<void> = snapshot(client, controller.signal, rootID).pipe(
      Effect.result,
      Effect.flatMap((value: Result.Result<Snapshot, RequestFailure>): Effect.Effect<void> =>
        Effect.sync((): void => publish(value))
      ),
    )
    yield* refresh
    return yield* Effect.forever(Effect.gen(function*(): Effect.fn.Return<void> {
      const now: number = yield* Clock.currentTimeMillis
      const next: number = origin + (Math.floor((now - origin) / 2000) + 1) * 2000
      yield* Effect.sleep(next - now)
      yield* refresh
    }))
  }))
