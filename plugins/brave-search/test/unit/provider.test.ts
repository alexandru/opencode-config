import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createBraveProvider, registerBrave } from "../../src/index.js"
import plugin from "../../index.js"

describe("Brave websearch registration", () => {
  test("exports a plugin definition at the directory entrypoint", () => {
    expect(plugin.id).toBe("brave-websearch")
  })

  test("registers Brave as the default provider", () => {
    const providers: string[] = []
    let selection: string | false | undefined
    const provider = createBraveProvider({ apiKey: () => "test-key" })

    registerBrave({
      add: (definition) => { providers.push(definition.id) },
      default: {
        get: () => selection,
        set: (value) => { selection = value },
      },
    }, provider)

    expect(providers).toEqual(["brave"])
    expect(selection).toBe("brave")
  })

  test("fails without a configured API key", async () => {
    const provider = createBraveProvider({ apiKey: () => undefined })
    const result = await Effect.runPromise(Effect.exit(provider.execute({ query: "docs" })))

    expect(result._tag).toBe("Failure")
  })
})
