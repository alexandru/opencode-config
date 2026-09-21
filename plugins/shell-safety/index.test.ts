import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import { Effect, Exit } from "effect"
import {
  buildRequest,
  createPermissionEvaluator,
  decodeOptions,
  encodeAgentDefinition,
  permissionFromAssessment,
  resolveAgentDefinition,
  type AgentPolicy,
  type Fetch,
  type Options,
  type PermissionEvent,
  type SafetyAssessment,
} from "./index"

const options: Options = {
  endpoint: "https://opencode.ai/zen/v1/systemone",
  model: "jev-1.13",
  integration: "opencode",
  allowProbability: 0.45,
  violationProbability: 0.4,
  timeoutMs: 8_000,
  maxAttempts: 2,
  retryDelayMs: 1,
  cache: { capacity: 32, ttlMs: 60_000 },
  agents: {
    Explorer: {
      enabled: true,
      http: { methods: [], credentials: {} },
    },
    Librarian: {
      enabled: true,
      http: {
        methods: ["GET", "HEAD"],
        credentials: { BRAVE_SEARCH_API_KEY: ["api.search.brave.com"] },
      },
    },
    Junior: {
      enabled: true,
      thresholds: { allowProbability: 0.35, violationProbability: 0.5 },
      http: {
        methods: ["GET", "HEAD"],
        credentials: { BRAVE_SEARCH_API_KEY: ["api.search.brave.com"] },
      },
    },
  },
}

const agentDefinition = resolveAgentDefinition({
  id: Agent.ID.make("Librarian"),
  name: Agent.Name.make("Librarian"),
  request: { settings: {}, headers: {}, body: { temperature: 0.2 } },
  system: "Use cellar for JVM dependency APIs. Write only under /tmp/opencode-librarian.",
  description: "Research agent",
  mode: "subagent",
  hidden: false,
  permissions: [
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "cellar *", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "/tmp", effect: "allow" },
    { action: "external_directory", resource: "/tmp/**", effect: "allow" },
  ],
})

const agentPolicy = (agents: Options["agents"], agent: string): AgentPolicy => {
  const policy = agents[agent]
  if (!policy) throw new Error(`missing configured policy for agent: ${agent}`)
  return policy
}

const assessment = (
  withinPolicy: number,
  filesystemViolation: number,
  remoteMutation: number,
  credentialViolation: number,
): SafetyAssessment => ({
  withinPolicy: { type: "noul", noul: withinPolicy },
  filesystemViolation: { type: "noul", noul: filesystemViolation },
  remoteMutation: { type: "noul", noul: remoteMutation },
  credentialViolation: { type: "noul", noul: credentialViolation },
})

const effectResponse = (result: SafetyAssessment): Response => Response.json({ answers: result })

const evaluator = (fetch: Fetch) =>
  createPermissionEvaluator(
    fetch,
    options,
    Effect.succeed("test-key"),
    () => Effect.succeed(agentDefinition),
  ).pipe(
    Effect.map((evaluate) => (event: PermissionEvent) => evaluate(event, "/home/dev/project")),
  )

const librarianEvent = (command: string): PermissionEvent => ({
  sessionID: "session",
  agent: "Librarian",
  action: "shell",
  resources: [command],
  effect: "ask",
})

describe("configuration", () => {
  test("decodes generic per-agent integration policy and cache settings", async () => {
    const decoded = await Effect.runPromise(decodeOptions(JSON.stringify(options)))
    expect(agentPolicy(decoded.agents, "Librarian").http.credentials["BRAVE_SEARCH_API_KEY"]).toEqual([
      "api.search.brave.com",
    ])
    expect(agentPolicy(decoded.agents, "Junior").http.credentials["BRAVE_SEARCH_API_KEY"]).toEqual([
      "api.search.brave.com",
    ])
    expect(agentPolicy(decoded.agents, "Junior").thresholds).toEqual({
      allowProbability: 0.35,
      violationProbability: 0.5,
    })
    expect(decoded.cache).toEqual({ capacity: 32, ttlMs: 60_000 })
    expect(agentPolicy(decoded.agents, "Explorer").enabled).toBeTrue()
    expect(decoded.allowProbability).toBe(0.45)
    expect(decoded.violationProbability).toBe(0.4)
    expect(decoded.maxAttempts).toBe(2)
  })

  test("rejects incomplete and out-of-range configuration", async () => {
    const incomplete = await Effect.runPromiseExit(decodeOptions(JSON.stringify({ agents: {} })))
    const invalidThreshold = await Effect.runPromiseExit(
      decodeOptions(JSON.stringify({ ...options, allowProbability: 2 })),
    )
    expect(Exit.isFailure(incomplete)).toBeTrue()
    expect(Exit.isFailure(invalidThreshold)).toBeTrue()
  })
})

describe("agent definition", () => {
  test("encodes the complete resolved prompt and configuration", () => {
    const definition = encodeAgentDefinition({
      id: Agent.ID.make("Researcher"),
      name: Agent.Name.make("Researcher"),
      request: { settings: {}, headers: {}, body: { temperature: 0.2 } },
      system: "Complete researcher prompt.",
      description: "Research agent",
      mode: "subagent",
      hidden: false,
      permissions: [
        { action: "shell", resource: "*", effect: "ask" },
        { action: "shell", resource: "cellar *", effect: "allow" },
      ],
    })

    expect(definition).toContain('"system":"Complete researcher prompt."')
    expect(definition).toContain('"temperature":0.2')
    expect(definition).toContain('"resource":"cellar *"')
  })
})

describe("Jev request", () => {
  test("passes the complete agent definition and project directory", () => {
    const event: PermissionEvent & { readonly agent: string } = {
      sessionID: "session",
      agent: "Librarian",
      action: "shell",
      resources: ["cellar get-external org.typelevel:cats-effect_3:3.7.1 cats.effect.Resource"],
      effect: "ask",
    }
    const policy = agentPolicy(options.agents, "Librarian")
    const request = buildRequest(event, options.model, policy, agentDefinition, "/home/dev/project")

    expect(request.state.shellCommand).toEqual(event.resources)
    expect(request.state.projectDirectory).toBe("/home/dev/project")
    expect(request.state.agentDefinition).toBe(agentDefinition.encoded)
    expect(request.state.filesystemAccess).toEqual({
      projectDirectory: "/home/dev/project",
      externalDirectoryRules: [
        { resource: "*", effect: "deny" },
        { resource: "/tmp", effect: "allow" },
        { resource: "/tmp/**", effect: "allow" },
      ],
    })
    expect(request.state.policy.http.credentials["BRAVE_SEARCH_API_KEY"]).toEqual(["api.search.brave.com"])
    expect(request.questions.withinPolicy.instructions).toContain("full system prompt")
    expect(request.questions.withinPolicy.instructions).toContain(
      "Work explicitly assigned by the full system prompt is within policy",
    )
    expect(request.questions.filesystemViolation.instructions).toContain(
      'complete ordered list of external-directory rules',
    )
    expect(request.questions.filesystemViolation.instructions).toContain(
      'This applies to reads and writes',
    )
    expect(request.questions.withinPolicy.instructions).toContain(
      'Treat the exact path "/dev/null" as a shell output sink',
    )
    expect(request.questions.filesystemViolation.instructions).toContain(
      'Redirection to the exact path "/dev/null" discards output',
    )
    expect(request.questions.filesystemViolation.instructions).toContain(
      'Executable lookup through "PATH"',
    )
    expect(request.questions.withinPolicy.instructions.startsWith('Read "state.agentDefinition"')).toBeTrue()
    expect(request.questions.withinPolicy.instructions).toContain("\nRules:\n- ")
    expect(request.questions.withinPolicy.instructions.includes("|")).toBeFalse()
  })

  test("allows only high policy confidence with low violation probabilities", () => {
    expect(permissionFromAssessment(assessment(0.45, 0.39, 0.39, 0.39), options)).toBe("allow")
    expect(permissionFromAssessment(assessment(0.44, 0.01, 0.01, 0.01), options)).toBe("deny")
    expect(permissionFromAssessment(assessment(0.99, 0.4, 0.01, 0.01), options)).toBe("deny")
    expect(permissionFromAssessment(assessment(0.99, 0.01, 0.4, 0.01), options)).toBe("deny")
    expect(permissionFromAssessment(assessment(0.99, 0.01, 0.01, 0.4), options)).toBe("deny")
    expect(permissionFromAssessment(assessment(0.1, 0.9, 0.9, 0.9), options)).toBe("deny")
  })

  test("applies per-agent threshold overrides", async () => {
    const evaluate = await Effect.runPromise(
      evaluator(async () => effectResponse(assessment(0.4, 0.49, 0.12, 0.08))),
    )
    const event: PermissionEvent = {
      sessionID: "session",
      agent: "Junior",
      action: "shell",
      resources: ["assigned work"],
      effect: "ask",
    }

    await Effect.runPromise(evaluate(event))

    expect(event.effect).toBe("allow")
  })
})

describe("permission hook", () => {
  test("preserves commands allowed by configured shell rules without calling Jev", async () => {
    let requests = 0
    const evaluate = await Effect.runPromise(
      evaluator(async () => {
        requests += 1
        throw new Error("should not be called")
      }),
    )
    const event: PermissionEvent = {
      sessionID: "session",
      agent: "Explorer",
      action: "shell",
      resources: ["git status --short"],
      effect: "allow",
    }

    await Effect.runPromise(evaluate(event))

    expect(event.effect).toBe("allow")
    expect(requests).toBe(0)
  })

  test("classifies an allowed command when shell expansion can change its effects", async () => {
    let requests = 0
    const evaluate = await Effect.runPromise(
      evaluator(async () => {
        requests += 1
        return effectResponse(assessment(0.2, 0.1, 0.1, 0.8))
      }),
    )
    const event: PermissionEvent = {
      sessionID: "session",
      agent: "Librarian",
      action: "shell",
      resources: [`printf '%s\n' "$BRAVE_SEARCH_API_KEY"`],
      effect: "allow",
    }

    await Effect.runPromise(evaluate(event))

    expect(requests).toBe(1)
    expect(event.effect).toBe("deny")
  })

  test("uses the permission session's project directory", async () => {
    let requestBody = ""
    const evaluate = await Effect.runPromise(
      createPermissionEvaluator(
        async (_input, init) => {
          requestBody = typeof init?.body === "string" ? init.body : ""
          return effectResponse(assessment(0.98, 0.01, 0.01, 0.01))
        },
        options,
        Effect.succeed("test-key"),
        () => Effect.succeed(agentDefinition),
      ),
    )
    const event = librarianEvent("inspect project")

    await Effect.runPromise(evaluate(event, "/home/dev/session-project"))

    expect(requestBody).toContain('"projectDirectory":"/home/dev/session-project"')
    expect(event.effect).toBe("allow")
  })

  test("denies classification when the session directory is unavailable", async () => {
    let requests = 0
    const evaluate = await Effect.runPromise(
      createPermissionEvaluator(
        async () => {
          requests += 1
          return effectResponse(assessment(0.98, 0.01, 0.01, 0.01))
        },
        options,
        Effect.succeed("test-key"),
        () => Effect.succeed(agentDefinition),
      ),
    )
    const event = librarianEvent("inspect project")

    await Effect.runPromise(evaluate(event))

    expect(requests).toBe(0)
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("session directory is unavailable")
  })

  test("classifies any agent present in configuration", async () => {
    const genericOptions: Options = {
      ...options,
      agents: {
        Researcher: { enabled: true, http: { methods: [], credentials: {} } },
      },
    }
    let resolvedAgent = ""
    const evaluate = await Effect.runPromise(
      createPermissionEvaluator(
        async () => effectResponse(assessment(0.98, 0.01, 0.01, 0.01)),
        genericOptions,
        Effect.succeed("test-key"),
        (agent) => {
          resolvedAgent = agent
          return Effect.succeed(agentDefinition)
        },
      ),
    )
    const event: PermissionEvent = {
      sessionID: "session",
      agent: "Researcher",
      action: "shell",
      resources: ["inspect dependency"],
      effect: "ask",
    }

    await Effect.runPromise(evaluate(event, "/home/dev/project"))

    expect(resolvedAgent).toBe("Researcher")
    expect(event.effect).toBe("allow")
  })

  test("does not classify commands for a disabled agent", async () => {
    let requests = 0
    const disabledOptions: Options = {
      ...options,
      agents: {
        Researcher: { enabled: false, http: { methods: [], credentials: {} } },
      },
    }
    const evaluate = await Effect.runPromise(
      createPermissionEvaluator(
        async () => {
          requests += 1
          return effectResponse(assessment(0.01, 0.99, 0.99, 0.99))
        },
        disabledOptions,
        Effect.succeed("test-key"),
        () => Effect.succeed(agentDefinition),
      ),
    )
    const event: PermissionEvent = {
      sessionID: "session",
      agent: "Researcher",
      action: "shell",
      resources: ["inspect project"],
      effect: "ask",
    }

    await Effect.runPromise(evaluate(event))

    expect(requests).toBe(0)
    expect(event.effect).toBe("ask")
  })

  test("caches an identical successful classification", async () => {
    let requests = 0
    const evaluate = await Effect.runPromise(
      evaluator(async () => {
        requests += 1
        return effectResponse(assessment(0.98, 0.01, 0.01, 0.01))
      }),
    )

    await Effect.runPromise(evaluate(librarianEvent("cellar get-external example")))
    await Effect.runPromise(evaluate(librarianEvent("cellar get-external example")))

    expect(requests).toBe(1)
  })

  test("allows the Brave Search command with its configured credential destination", async () => {
    const evaluate = await Effect.runPromise(
      evaluator(async () => effectResponse(assessment(0.99, 0.01, 0.01, 0.01))),
    )
    const event = librarianEvent(
      'curl -s "https://api.search.brave.com/res/v1/web/search" -H "X-Subscription-Token: ${BRAVE_SEARCH_API_KEY}"',
    )

    await Effect.runPromise(evaluate(event))

    expect(event.effect).toBe("allow")
  })

  test("tells the agent to rewrite a command rejected by policy", async () => {
    const evaluate = await Effect.runPromise(
      evaluator(async () => effectResponse(assessment(0.2, 0.63, 0.08, 0.11))),
    )
    const event = librarianEvent("unsafe command")

    await Effect.runPromise(evaluate(event))

    expect(event.effect).toBe("deny")
    expect(event.message).toContain(
      "Rewrite the command to comply with your system prompt and permissions, or report the limitation if no compliant form exists.",
    )
    expect(event.message).toContain("withinPolicy=0.200")
    expect(event.message).toContain("filesystemViolation=0.630")
  })

  test("denies without escalating when the Jev request fails", async () => {
    const evaluate = await Effect.runPromise(evaluator(async () => new Response("unavailable", { status: 503 })))
    const event = librarianEvent("curl https://example.com")

    await Effect.runPromise(evaluate(event))

    expect(event.effect).toBe("deny")
    expect(event.message).toContain("HTTP 503 after 2 attempts")
  })

  test("retries a transient HTTP failure with Effect", async () => {
    let attempts = 0
    const evaluate = await Effect.runPromise(
      evaluator(async () => {
        attempts += 1
        return attempts === 1
          ? new Response("unavailable", { status: 503 })
          : effectResponse(assessment(0.99, 0.01, 0.01, 0.01))
      }),
    )
    const event = librarianEvent("curl https://example.com")

    await Effect.runPromise(evaluate(event))

    expect(attempts).toBe(2)
    expect(event.effect).toBe("allow")
  })

  test("reports the final HTTP failure", async () => {
    const evaluate = await Effect.runPromise(evaluator(async () => new Response("rate limited", { status: 429 })))
    const event = librarianEvent("curl https://example.com")

    await Effect.runPromise(evaluate(event))

    expect(event.effect).toBe("deny")
    expect(event.message).toContain("HTTP 429 after 2 attempts")
  })

  test("does not retry a non-transient HTTP failure", async () => {
    let attempts = 0
    const evaluate = await Effect.runPromise(
      evaluator(async () => {
        attempts += 1
        return new Response("unauthorized", { status: 401 })
      }),
    )
    const event = librarianEvent("curl https://example.com")

    await Effect.runPromise(evaluate(event))

    expect(attempts).toBe(1)
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("HTTP 401 after 1 attempt")
  })
})
