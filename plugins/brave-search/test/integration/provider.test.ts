import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createBraveProvider } from "../../src/index.js"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers) server.stop()
  servers.length = 0
})

describe("Brave websearch HTTP integration", () => {
  test("sends the query and key, then returns validated search results", async () => {
    let requestedQuery: string | null = null
    let receivedKey: string | null = null
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requestedQuery = url.searchParams.get("q")
        receivedKey = request.headers.get("X-Subscription-Token")
        return Response.json({
          web: { results: [
            { url: "https://example.org/a", title: "An article", description: "First snippet", page_age: "2025-04-12T14:22:41Z" },
            { url: "https://example.org/b", title: "Another article", description: "Second snippet" },
          ] },
        })
      },
    })
    servers.push(server)
    const provider = createBraveProvider({ endpoint: `http://localhost:${server.port}/res/v1/web/search`, apiKey: () => "secret" })

    const results = await Effect.runPromise(provider.execute({ query: "cats & dogs" }))

    expect<string | null>(requestedQuery).toBe("cats & dogs")
    expect<string | null>(receivedKey).toBe("secret")
    expect(results).toEqual([
      { url: "https://example.org/a", title: "An article", content: "First snippet", time: { published: Date.parse("2025-04-12T14:22:41Z") } },
      { url: "https://example.org/b", title: "Another article", content: "Second snippet", time: {} },
    ])
  })

  test("rejects invalid response bodies", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ web: { results: [{ title: "Missing URL" }] } }) })
    servers.push(server)
    const provider = createBraveProvider({ endpoint: `http://localhost:${server.port}/res/v1/web/search`, apiKey: () => "secret" })

    const result = await Effect.runPromise(Effect.exit(provider.execute({ query: "test" })))

    expect(result._tag).toBe("Failure")
  })

  test("returns no results when Brave omits the web category", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ type: "search", query: { original: "nothing" } }) })
    servers.push(server)
    const provider = createBraveProvider({ endpoint: `http://localhost:${server.port}/res/v1/web/search`, apiKey: () => "secret" })

    expect(await Effect.runPromise(provider.execute({ query: "nothing" }))).toEqual([])
  })

  test("propagates HTTP failures", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("rate limited", { status: 429 }) })
    servers.push(server)
    const provider = createBraveProvider({ endpoint: `http://localhost:${server.port}/res/v1/web/search`, apiKey: () => "secret" })

    const result = await Effect.runPromise(Effect.exit(provider.execute({ query: "test" })))

    expect(result._tag).toBe("Failure")
  })
})
