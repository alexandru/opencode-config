import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { Clock, Effect, Exit, Option, Result, Schema, type Scope } from "effect"
import {
  type Catalog,
  catalog,
  type History,
  history,
  modelPriceKey,
  type Observation,
  observe,
  type PriceCatalog,
  reading,
  type RequestFailure,
  type Snapshot,
  summarize,
} from "./model.ts"
import { describeFailure, Prices, PricesOutput } from "./rpc.ts"

type Client = {
  readonly session: Pick<OpenCodeClient["session"], "get" | "list">
  readonly message: Pick<OpenCodeClient["message"], "list">
  readonly model: Pick<OpenCodeClient["model"], "list">
  readonly rpc: OpenCodeClient["rpc"]
}

type ClientAccessor = () => Client

interface Loaded {
  readonly history: History
  readonly messages: ReadonlyArray<SessionMessageInfo>
}

interface Prepared {
  readonly session: SessionInfo
  readonly models: Effect.Effect<Result.Result<Catalog, RequestFailure>>
  readonly prices: Effect.Effect<Result.Result<PriceCatalog, RequestFailure>>
}

interface PriceCache {
  readonly locations: Map<string, Effect.Effect<PriceCatalog, RequestFailure>>
}

const request = <A>(run: () => PromiseLike<A>): Effect.Effect<A, RequestFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause: unknown): RequestFailure => ({ message: describeFailure(cause) }),
  })

const messages = (
  client: ClientAccessor,
  signal: AbortSignal,
  session: Pick<SessionInfo, "id" | "revert">,
): Effect.Effect<Loaded, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<Loaded, RequestFailure> {
    let cursor: Option.Option<string> = Option.none()
    const boundary = Option.fromUndefinedOr(session.revert?.messageID)
    const collected: Array<SessionMessageInfo> = []
    for (;;) {
      const cursorValue = Option.getOrUndefined(cursor)
      const page = yield* request(() =>
        client().message.list(
          cursorValue === undefined
            ? { sessionID: session.id, limit: 100, order: "desc" }
            : { sessionID: session.id, cursor: cursorValue, limit: 100 },
          { signal },
        )
      )
      for (const message of page.data) {
        collected.push(message)
      }
      cursor = Option.fromNullishOr(page.cursor.next)
      if (Option.isNone(cursor)) break
    }
    collected.reverse()
    const analysis = history(collected, boundary)
    return {
      history: analysis._tag === "Settled"
        ? analysis.history
        : { actual: analysis.actual, sample: Option.none() },
      messages: collected,
    }
  })

const sessions = (
  client: ClientAccessor,
  signal: AbortSignal,
  rootID: string,
): Effect.Effect<ReadonlyArray<SessionInfo>, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<ReadonlyArray<SessionInfo>, RequestFailure> {
    const root = yield* request(() => client().session.get({ sessionID: rootID }, { signal }))
    const tree = [root]
    const seen = new Set([root.id])
    for (const parent of tree) {
      let cursor: Option.Option<string> = Option.none()
      do {
        const cursorValue = Option.getOrUndefined(cursor)
        const page = yield* request(() =>
          client().session.list(
            cursorValue === undefined
              ? { parentID: parent.id, limit: 200, order: "asc" }
              : { cursor: cursorValue, limit: 200 },
            { signal },
          )
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

const priceCatalog = (value: PricesOutput): PriceCatalog => {
  const models: Map<ReturnType<typeof modelPriceKey>, PricesOutput["models"][number]["cost"]> =
    new Map()
  for (const model of value.models) {
    models.set(modelPriceKey(model), model.cost)
  }
  return models
}

const prices = (
  client: ClientAccessor,
  signal: AbortSignal,
  location: SessionInfo["location"],
): Effect.Effect<PriceCatalog, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<PriceCatalog, RequestFailure> {
    const value: unknown = yield* request(() =>
      client().rpc(Prices).prices({}, { signal, location })
    )
    const decoded = Schema.decodeUnknownResult(PricesOutput)(value)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail({
        message: `Price data malformed: ${decoded.failure.message}`,
      })
    }
    return priceCatalog(decoded.success)
  })

const snapshot = (
  client: ClientAccessor,
  signal: AbortSignal,
  rootID: string,
  priceCache: PriceCache,
): Effect.Effect<Snapshot, RequestFailure> =>
  Effect.gen(function*(): Effect.fn.Return<Snapshot, RequestFailure> {
    const tree = yield* sessions(client, signal, rootID)
    const catalogs: Map<string, Effect.Effect<Result.Result<Catalog, RequestFailure>>> = new Map()
    const prepared: Array<Prepared> = []
    for (const session of tree) {
      const key = session.location.directory
      const models = yield* Option.match(
        Option.fromUndefinedOr(catalogs.get(key)),
        {
          onSome: (cached) => Effect.succeed(cached),
          onNone: () =>
            Effect.cached(
              request(() => client().model.list({ location: session.location }, { signal })).pipe(
                Effect.map((page) => catalog(page.data)),
                Effect.result,
              ),
            ),
        },
      )
      catalogs.set(key, models)
      const modelPrices = yield* Option.match(
        Option.fromUndefinedOr(priceCache.locations.get(key)),
        {
          onSome: (cached) => Effect.succeed(cached),
          onNone: () =>
            Effect.cachedWithTTL(
              prices(client, signal, session.location),
              (exit) => Exit.isSuccess(exit) ? "5 minutes" : 0,
            ),
        },
      )
      priceCache.locations.set(key, modelPrices)
      prepared.push({ session, models, prices: Effect.result(modelPrices) })
    }
    const observations = yield* Effect.forEach(
      prepared,
      (item) =>
        Effect.gen(function*(): Effect.fn.Return<Observation> {
          const values = yield* Effect.all({
            models: item.models,
            prices: item.prices,
            loaded: Effect.result(messages(client, signal, item.session)),
          }, { concurrency: "unbounded" })
          const value = Result.map(
            values.loaded,
            (loaded) => reading(loaded.history, values.models, loaded.messages),
          )
          return observe(item.session, rootID, value, values.prices)
        }),
      { concurrency: 8 },
    )
    return summarize(observations)
  })

export const watch = (
  client: ClientAccessor,
  rootID: string,
  publish: (value: Result.Result<Snapshot, RequestFailure>) => void,
): Effect.Effect<never> =>
  Effect.scoped(Effect.gen(function*(): Effect.fn.Return<never, never, Scope.Scope> {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (value) => Effect.sync(() => value.abort()),
    )
    const origin = yield* Clock.currentTimeMillis
    const priceCache: PriceCache = { locations: new Map() }
    const refresh = snapshot(client, controller.signal, rootID, priceCache).pipe(
      Effect.result,
      Effect.flatMap((value) => Effect.sync(() => publish(value))),
    )
    yield* refresh
    return yield* Effect.forever(Effect.gen(function*(): Effect.fn.Return<void> {
      const now = yield* Clock.currentTimeMillis
      const next = origin + (Math.floor((now - origin) / 2000) + 1) * 2000
      yield* Effect.sleep(next - now)
      yield* refresh
    }))
  }))
