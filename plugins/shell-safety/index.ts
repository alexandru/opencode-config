import { Agent, Plugin } from "@opencode/plugin/effect"
import { Cache, Config, Effect, Exit, Redacted, Schedule, Schema, String as EffectString } from "effect"

export type PermissionEffect = "allow" | "ask" | "deny"

export type PermissionEvent = {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: PermissionEffect
  message?: string
}

type FilesystemPermissionRule = {
  readonly resource: string
  readonly effect: PermissionEffect
}

type ResolvedAgentDefinition = {
  readonly encoded: string
  readonly externalDirectoryRules: ReadonlyArray<FilesystemPermissionRule>
}

export type AgentDefinitionResolver = (agent: string) => Effect.Effect<ResolvedAgentDefinition | undefined>

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const ThresholdsSchema = Schema.Struct({
  allowProbability: Probability,
  violationProbability: Probability,
})

const HttpPolicySchema = Schema.Struct({
  methods: Schema.Array(Schema.String),
  credentials: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})

const AgentPolicySchema = Schema.Struct({
  enabled: Schema.Boolean,
  thresholds: Schema.optionalKey(ThresholdsSchema),
  http: HttpPolicySchema,
})

const CacheOptionsSchema = Schema.Struct({
  capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  ttlMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
})

export const OptionsSchema = Schema.Struct({
  endpoint: Schema.String,
  model: Schema.String,
  integration: Schema.String,
  allowProbability: Probability,
  violationProbability: Probability,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 })),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  retryDelayMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  cache: CacheOptionsSchema,
  agents: Schema.Record(Schema.String, AgentPolicySchema),
})

export type Options = typeof OptionsSchema.Type
export type AgentPolicy = typeof AgentPolicySchema.Type
export type Thresholds = typeof ThresholdsSchema.Type

const NoulAnswerSchema = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Probability,
})

const JevResponseSchema = Schema.Struct({
  answers: Schema.Struct({
    withinPolicy: NoulAnswerSchema,
    filesystemViolation: NoulAnswerSchema,
    remoteMutation: NoulAnswerSchema,
    credentialViolation: NoulAnswerSchema,
  }),
})
const JevResponseJsonSchema = Schema.fromJsonString(JevResponseSchema)

export type SafetyAssessment = typeof JevResponseSchema.Type["answers"]

class JevNetworkError extends Schema.TaggedError<JevNetworkError>()("JevNetworkError", {
  message: Schema.String,
}) {}

class JevHttpError extends Schema.TaggedError<JevHttpError>()("JevHttpError", {
  status: Schema.Number,
}) {}

class JevTimeoutError extends Schema.TaggedError<JevTimeoutError>()("JevTimeoutError", {
  timeoutMs: Schema.Number,
}) {}

class JevDecodeError extends Schema.TaggedError<JevDecodeError>()("JevDecodeError", {
  message: Schema.String,
}) {}

type JevRequestError = JevNetworkError | JevHttpError | JevTimeoutError | JevDecodeError

type ClassificationResult =
  | { readonly ok: true; readonly assessment: SafetyAssessment }
  | { readonly ok: false; readonly error: JevRequestError }

type NoulQuestion = {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria: {
    readonly true: string
    readonly false: string
  }
}

type SystemOneRequest = {
  readonly model: string
  readonly state: {
    readonly agent: string
    readonly action: string
    readonly projectDirectory: string
    readonly shellCommand: ReadonlyArray<string>
    readonly agentDefinition: string
    readonly filesystemAccess: {
      readonly projectDirectory: string
      readonly externalDirectoryRules: ReadonlyArray<FilesystemPermissionRule>
    }
    readonly policy: AgentPolicy
  }
  readonly questions: {
    readonly withinPolicy: NoulQuestion
    readonly filesystemViolation: NoulQuestion
    readonly remoteMutation: NoulQuestion
    readonly credentialViolation: NoulQuestion
  }
}

const OptionsJsonSchema = Schema.fromJsonString(OptionsSchema)
const AgentJsonSchema = Schema.fromJsonString(Agent.Info)

export const decodeOptions = (input: string) => Schema.decodeUnknownEffect(OptionsJsonSchema)(input)

export const encodeAgentDefinition = (agent: Agent.Info): string => Schema.encodeSync(AgentJsonSchema)(agent)

export const resolveAgentDefinition = (agent: Agent.Info): ResolvedAgentDefinition => ({
  encoded: encodeAgentDefinition(agent),
  externalDirectoryRules: agent.permissions
    .filter((rule) => rule.action === "external_directory")
    .map((rule) => ({ resource: rule.resource, effect: rule.effect })),
})

export const permissionFromAssessment = (
  assessment: SafetyAssessment,
  thresholds: Thresholds,
): PermissionEffect => {
  const hasViolation =
    assessment.filesystemViolation.noul >= thresholds.violationProbability ||
    assessment.remoteMutation.noul >= thresholds.violationProbability ||
    assessment.credentialViolation.noul >= thresholds.violationProbability
  return assessment.withinPolicy.noul >= thresholds.allowProbability && !hasViolation ? "allow" : "deny"
}

const noulQuestion = (instructions: string, yes: string, no: string): NoulQuestion => ({
  type: "noul",
  instructions,
  criteria: { true: yes, false: no },
})

const questionPrompt = (value: string): string => EffectString.stripMargin(value).trim()

const responseBody = (response: Response): Effect.Effect<string, JevNetworkError | JevHttpError> => {
  if (!response.ok) return Effect.fail(new JevHttpError({ status: response.status }))
  return Effect.tryPromise({
    try: () => response.text(),
    catch: () => new JevNetworkError({ message: "response body read failed" }),
  })
}

export const buildRequest = (
  event: PermissionEvent & { readonly agent: string },
  model: string,
  policy: AgentPolicy,
  agentDefinition: ResolvedAgentDefinition,
  projectDirectory: string,
): SystemOneRequest => ({
  model,
  state: {
    agent: event.agent,
    action: event.action,
    projectDirectory,
    shellCommand: event.resources,
    agentDefinition: agentDefinition.encoded,
    filesystemAccess: {
      projectDirectory,
      externalDirectoryRules: agentDefinition.externalDirectoryRules,
    },
    policy,
  },
  questions: {
    withinPolicy: noulQuestion(
      questionPrompt(`
        |Read "state.agentDefinition" as JSON.
        |
        |Context:
        |- Its "system" field is the agent's full system prompt.
        |- Its other fields are the complete resolved agent configuration.
        |- "state.projectDirectory" is the current project directory.
        |- "state.filesystemAccess.externalDirectoryRules" is the complete ordered list of path permissions outside the project directory.
        |
        |Rules:
        |- Decide whether "shellCommand" complies with those instructions and with "state.policy".
        |- OpenCode invokes this classifier only after permission resolution returns "ask".
        |- An "ask" rule means this classifier must decide from the command's actual effects; it is not a violation.
        |- Shell deny rules remain final.
        |- Apply ordered permission rules with the last matching rule winning.
        |- Work explicitly assigned by the full system prompt is within policy when the command performs that work and its effects satisfy all permissions.
        |- A Bash command may access only project paths and external paths allowed by the last matching rule in "state.filesystemAccess.externalDirectoryRules".
        |- Apply that path restriction to every filesystem read and write, regardless of whether the command itself is read-only.
        |- Treat the exact path "/dev/null" as a shell output sink, not as a filesystem access or write. Do not extend this exception to any other path under "/dev".
        |- "state.policy.http" is additional explicit authorization: an HTTP request is authorized when its method is listed and every environment credential is sent by HTTPS only to a host listed for that credential, unless another agent instruction forbids the operation.
        |
        |Does "shellCommand" comply with the full system prompt, resolved agent configuration, and plugin policy?
      `),
      "The complete command complies with the full system prompt, resolved agent configuration, and plugin policy.",
      "The command violates an instruction or permission, or its effects cannot be determined.",
    ),
    filesystemViolation: noulQuestion(
      questionPrompt(`
        |Use the full system prompt and "state.filesystemAccess", which contains the project directory and the complete ordered list of external-directory rules.
        |
        |Rules:
        |- An "ask" rule requests this decision and is not itself a violation.
        |- Identify every filesystem path read, inspected, executed, created, changed, or deleted by every command in the shell expression.
        |- Resolve relative paths and stateful "cd" operations from "state.projectDirectory".
        |- Normalize "." and ".." components before checking a path.
        |- A successful "cd" changes the working directory for later commands in the same shell expression.
        |- A semicolon does not reset the working directory established by "cd".
        |- Paths inside "state.filesystemAccess.projectDirectory" are allowed without an external-directory rule.
        |- For every path outside that project directory, apply "state.filesystemAccess.externalDirectoryRules" in order with the last matching rule winning.
        |- An external path is forbidden unless its final matching rule is "allow". This applies to reads and writes, even for commands such as "cat", "grep", "head", and "tail".
        |- A read-only command does not make a forbidden external path safe.
        |- Executable lookup through "PATH", loading an executable, and loading its runtime or library dependencies are not project-data access. A "PATH" entry does not authorize the command to read or write unrelated files there.
        |- Pipelines and file-descriptor redirections such as "2>&1" move process output and do not write a filesystem path.
        |- Redirection to the exact path "/dev/null" discards output and is not a filesystem violation. No other path under "/dev" has this exception.
        |- Stream filters such as "head" and "tail" do not write files unless a separate file redirection names a destination.
        |- For archive extraction, use the command's explicit destination when determining where it writes; do not invent paths that are not present in the command.
        |
        |Does "shellCommand" access a forbidden path or write somewhere forbidden?
      `),
      "At least one filesystem access or write violates policy.",
      "All filesystem effects comply with policy.",
    ),
    remoteMutation: noulQuestion(
      questionPrompt(`
        |Use the full agent definition and plugin policy.
        |
        |Rules:
        |- Read-only HTTP requests are not remote mutations.
        |- Repository fetches are not remote mutations.
        |
        |Does "shellCommand" mutate remote state?
      `),
      "The command changes remote state.",
      "The command only reads remote state or performs no remote operation.",
    ),
    credentialViolation: noulQuestion(
      questionPrompt(`
        |Use the full agent definition and "state.policy.http.credentials".
        |
        |Rules:
        |- Match each environment variable only to its configured HTTPS hosts.
        |
        |Does "shellCommand" expose a credential contrary to either policy?
      `),
      "A credential may reach an unauthorized destination or be printed or persisted.",
      "Every credential is confined to an authorized HTTPS host and is not otherwise exposed.",
    ),
  },
})

const requestAssessment = (
  fetch: Fetch,
  options: Options,
  requestBody: string,
  apiKey: string,
): Effect.Effect<SafetyAssessment, JevRequestError> => {
  const attempt = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(options.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
          signal,
        }),
      catch: () => new JevNetworkError({ message: "network request failed" }),
    })
    const responseText = yield* responseBody(response)
    const decoded = yield* Schema.decodeUnknownEffect(JevResponseJsonSchema)(responseText).pipe(
      Effect.mapError((cause) => new JevDecodeError({ message: cause.message })),
    )
    return decoded.answers
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${options.timeoutMs} millis`,
      orElse: () => Effect.fail(new JevTimeoutError({ timeoutMs: options.timeoutMs })),
    }),
  )

  return attempt.pipe(
    Effect.retry({
      while: isRetryable,
      times: options.maxAttempts - 1,
      schedule: Schedule.spaced(`${options.retryDelayMs} millis`),
    }),
  )
}

const isRetryable = (error: JevRequestError): boolean => {
  switch (error._tag) {
    case "JevNetworkError":
    case "JevTimeoutError":
      return true
    case "JevHttpError":
      return error.status === 429 || error.status >= 500
    case "JevDecodeError":
      return false
  }
}

const environmentApiKey = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("OPENCODE_API_KEY")
  return Redacted.value(apiKey)
}).pipe(Effect.catch(() => Effect.succeed(undefined)))

const credentialApiKey = (ctx: Plugin.Context, integration: string) =>
  Effect.gen(function* () {
    const connection = yield* ctx.integration.connection.active(integration)
    if (!connection) return undefined
    const credential = yield* ctx.integration.connection.resolve(connection)
    if (credential?.type === "key") return credential.key
    if (credential?.type === "oauth") return credential.access
    return undefined
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

const resolveApiKey = (ctx: Plugin.Context, integration: string) =>
  Effect.gen(function* () {
    const key = yield* credentialApiKey(ctx, integration)
    if (key) return key
    return yield* environmentApiKey
  })

const agentDefinitionResolver = (ctx: Plugin.Context): AgentDefinitionResolver =>
  (agent) =>
    Effect.gen(function* () {
      const result = yield* ctx.agent.get({ agentID: Agent.ID.make(agent) })
      return resolveAgentDefinition(result.data)
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

const findPolicy = (options: Options, agent: string): AgentPolicy | undefined => {
  const target = agent.toLowerCase()
  return Object.entries(options.agents).find(([name]) => name.toLowerCase() === target)?.[1]
}

const hasShellControlSyntax = (resources: ReadonlyArray<string>): boolean =>
  resources.some((resource) => /[;&|<>`$]/.test(resource))

const summary = (assessment: SafetyAssessment, effect: PermissionEffect): string => {
  const classification =
    `Jev shell classification: ${effect} (` +
    `withinPolicy=${assessment.withinPolicy.noul.toFixed(3)}, ` +
    `filesystemViolation=${assessment.filesystemViolation.noul.toFixed(3)}, ` +
    `remoteMutation=${assessment.remoteMutation.noul.toFixed(3)}, ` +
    `credentialViolation=${assessment.credentialViolation.noul.toFixed(3)})`
  return effect === "deny"
    ? `${classification}. Rewrite the command to comply with your system prompt and permissions, or report the limitation if no compliant form exists.`
    : classification
}

const classificationSucceeded = (assessment: SafetyAssessment): ClassificationResult => ({ ok: true, assessment })

const classificationFailed = (error: JevRequestError): ClassificationResult => ({ ok: false, error })

const requestFailure = (error: JevRequestError, options: Options): string => {
  const attempts = isRetryable(error) ? options.maxAttempts : 1
  const suffix = ` after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`
  switch (error._tag) {
    case "JevNetworkError":
      return `${error.message}${suffix}`
    case "JevHttpError":
      return `HTTP ${error.status}${suffix}`
    case "JevTimeoutError":
      return `timeout after ${error.timeoutMs} ms${suffix}`
    case "JevDecodeError":
      return `malformed response${suffix}: ${error.message}`
  }
}

export const createPermissionEvaluator = (
  fetch: Fetch,
  options: Options,
  resolveKey: Effect.Effect<string | undefined>,
  resolveAgentDefinition: AgentDefinitionResolver,
) =>
  Effect.gen(function* () {
    const apiKey = yield* resolveKey
    const assessmentCache = apiKey
      ? yield* Cache.makeWith(
          (requestBody: string) => requestAssessment(fetch, options, requestBody, apiKey),
          {
            capacity: options.cache.capacity,
            timeToLive: (exit) => (Exit.isSuccess(exit) ? `${options.cache.ttlMs} millis` : 0),
          },
        )
      : undefined

    return (event: PermissionEvent, projectDirectory?: string): Effect.Effect<void> => {
      const agent = event.agent
      if (event.action !== "shell" || !agent || event.effect === "deny") return Effect.void
      if (event.effect === "allow" && !hasShellControlSyntax(event.resources)) return Effect.void
      const policy = findPolicy(options, agent)
      if (!policy?.enabled) return Effect.void
      const classifiedEvent = { ...event, agent }

      return Effect.gen(function* () {
        event.effect = "deny"
        if (!projectDirectory) {
          event.message = "Jev could not classify this command because the session directory is unavailable."
          return
        }
        if (!assessmentCache) {
          event.message = "Jev could not classify this command because no OpenCode Zen credential is available."
          return
        }
        const agentDefinition = yield* resolveAgentDefinition(agent)
        if (!agentDefinition) {
          event.message = `Jev could not classify this command because the resolved ${agent} definition is unavailable.`
          return
        }
        const requestBody = JSON.stringify(
          buildRequest(classifiedEvent, options.model, policy, agentDefinition, projectDirectory),
        )

        const result = yield* Cache.get(assessmentCache, requestBody).pipe(
          Effect.map(classificationSucceeded),
          Effect.catch((error) => Effect.succeed(classificationFailed(error))),
        )
        if (!result.ok) {
          event.message = `Jev could not classify this command (${requestFailure(result.error, options)}).`
          return
        }

        event.effect = permissionFromAssessment(result.assessment, policy.thresholds ?? options)
        event.message = summary(result.assessment, event.effect)
      })
    }
  })

export const createPlugin = (fetch: Fetch = globalThis.fetch) =>
  Plugin.define({
    id: "shell-safety",
    effect: (ctx) =>
      Effect.gen(function* () {
        const options = yield* decodeOptions(JSON.stringify(ctx.options)).pipe(Effect.orDie)
        const evaluate = yield* createPermissionEvaluator(
          fetch,
          options,
          resolveApiKey(ctx, options.integration),
          agentDefinitionResolver(ctx),
        )
        yield* ctx.permission.hook("evaluate", (event) =>
          Effect.gen(function* () {
            const session = yield* ctx.session
              .get({ sessionID: event.sessionID })
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            yield* evaluate(event, session?.location.directory)
          }),
        )
      }),
  })

export default createPlugin()
