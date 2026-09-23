import { Plugin } from "@opencode/plugin/effect"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/effect/websearch"
import { Effect, Schema } from "effect"

const endpoint = "https://api.search.brave.com/res/v1/web/search"

const BraveResult = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  page_age: Schema.optional(Schema.String),
})

const BraveResponse = Schema.Struct({
  web: Schema.optional(Schema.Struct({ results: Schema.Array(BraveResult) })),
})

type BraveResult = typeof BraveResult.Type

const toResult = (result: BraveResult) => {
  const published = result.page_age === undefined ? NaN : Date.parse(result.page_age)

  return {
    url: result.url,
    ...(result.title === undefined ? {} : { title: result.title }),
    ...(result.description === undefined ? {} : { content: result.description }),
    time: Number.isFinite(published) ? { published } : {},
  }
}

export interface BraveOptions {
  readonly endpoint?: string
  readonly apiKey?: () => string | undefined
}

export const createBraveProvider = (options: BraveOptions = {}): WebSearchDefinition => ({
  id: "brave",
  name: "Brave Search",
  execute: ({ query }) => Effect.gen(function* () {
    const key = (options.apiKey ?? (() => process.env["BRAVE_SEARCH_API_KEY"]))()
    if (!key) return yield* Effect.fail(new Error("BRAVE_SEARCH_API_KEY is not set"))

    const url = new URL(options.endpoint ?? endpoint)
    url.searchParams.set("q", query)

    const response = yield* Effect.tryPromise({
      try: () => fetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
      }),
      catch: () => new Error("Brave Search request failed"),
    })
    if (!response.ok) return yield* Effect.fail(new Error(`Brave Search API returned HTTP ${response.status}`))

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new Error("Could not read Brave Search response"),
    })
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(BraveResponse))(body)
    return (decoded.web?.results ?? []).map(toResult)
  }),
})

export const registerBrave = (editor: WebSearchEditor, provider: WebSearchDefinition): void => {
  editor.add(provider)
  editor.default.set(provider.id)
}

export default Plugin.define({
  id: "brave-websearch",
  effect: (context) => Effect.gen(function* () {
    yield* context.websearch.transform((editor) => registerBrave(editor, createBraveProvider()))
    yield* context.websearch.reload()
  }),
})
