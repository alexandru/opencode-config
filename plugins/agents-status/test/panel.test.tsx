import type {
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionRevert,
  TokenUsageInfo,
} from "@opencode/client"
import type {
  Context,
  Data,
  KeymapCommand,
  KeymapLayer,
  PanelInput,
  SlotClaim,
} from "@opencode/plugin/tui/context"
import type { Cleanup, Definition } from "@opencode/plugin/tui/plugin"
import type { HueStep, ResolvedTheme, ThemeDefinition } from "@opencode/theme/tui"
import type { CapturedFrame, Renderable } from "@opentui/core"
import type { TestRendererOptions, TestRendererSetup } from "@opentui/core/testing"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { expect, test } from "bun:test"
import { Effect, Option, type Scope } from "effect"
import type { Store } from "solid-js/store"

ensureSolidTransformPlugin()

const { OpenCode } = await import("@opencode/client")
const { PluginContextProvider } = await import("@opencode/plugin/tui")
const { resolveTheme } = await import("@opencode/theme/tui")
const { testRender } = await import("@opentui/solid")
const { createSignal } = await import("solid-js")
const plugin: Definition = (await import("../tui.tsx")).default

const PANEL_NAME: string = "agents-status"
const COMMAND_TITLE: string = "Agents status"
const SLASH_NAME: string = "agents-status"
const ROOT_SESSION: string = "ses_root"
const CHILD_SESSION: string = "ses_child_explorer"
const UNRELATED_SESSION: string = "ses_unrelated"
const OTHER_ROOT: string = "ses_other_root"
const DIRECTORY: string = "/tmp/opencode/agents-status-fixture"

const CHILD_USAGE: TokenUsageInfo = {
  input: 1000,
  output: 200,
  reasoning: 50,
  cache: { read: 300, write: 100 },
}

const HUE_STEPS: Readonly<Record<HueStep, string>> = {
  100: "#111111",
  200: "#222222",
  300: "#333333",
  400: "#444444",
  500: "#555555",
  600: "#666666",
  700: "#777777",
  800: "#888888",
  900: "#999999",
}

const TOKEN: string = "#808080"

const themeDefinition: ThemeDefinition = {
  hue: { neutral: HUE_STEPS, accent: HUE_STEPS, interactive: HUE_STEPS },
  categorical: ["accent"],
  text: {
    base: TOKEN,
    muted: TOKEN,
    action: {
      primary: { base: TOKEN },
      secondary: { base: TOKEN },
      destructive: { base: TOKEN },
    },
    formfield: { base: TOKEN },
    feedback: {
      error: { base: TOKEN },
      warning: { base: TOKEN },
      success: { base: TOKEN },
      info: { base: TOKEN },
    },
  },
  background: {
    base: TOKEN,
    raised: { base: TOKEN, high: TOKEN, max: TOKEN },
    action: {
      primary: { base: TOKEN },
      secondary: { base: TOKEN },
      destructive: { base: TOKEN },
    },
    formfield: { base: TOKEN },
    feedback: {
      error: { base: TOKEN },
      warning: { base: TOKEN },
      success: { base: TOKEN },
      info: { base: TOKEN },
    },
  },
  border: { base: TOKEN },
  scrollbar: { base: TOKEN },
  diff: {
    text: { added: TOKEN, removed: TOKEN, context: TOKEN, hunkHeader: TOKEN },
    background: { added: TOKEN, removed: TOKEN, context: TOKEN },
    highlight: { added: TOKEN, removed: TOKEN },
    lineNumber: { text: TOKEN, background: { added: TOKEN, removed: TOKEN } },
  },
  syntax: {
    comment: TOKEN,
    keyword: TOKEN,
    function: TOKEN,
    variable: TOKEN,
    string: TOKEN,
    number: TOKEN,
    type: TOKEN,
    operator: TOKEN,
    punctuation: TOKEN,
  },
  markdown: {
    text: TOKEN,
    heading: TOKEN,
    link: TOKEN,
    linkText: TOKEN,
    code: TOKEN,
    blockQuote: TOKEN,
    emphasis: TOKEN,
    strong: TOKEN,
    horizontalRule: TOKEN,
    listItem: TOKEN,
    listEnumeration: TOKEN,
    image: TOKEN,
    imageText: TOKEN,
    codeBlock: TOKEN,
  },
}

const themeDefinitionB: ThemeDefinition = {
  ...themeDefinition,
  text: {
    ...themeDefinition.text,
    base: "#2ecc71",
    muted: "#3498db",
  },
}

const THEME_A: ResolvedTheme = resolveTheme(themeDefinition)
const THEME_B: ResolvedTheme = resolveTheme(themeDefinitionB)

const unexpected = (property: string): never => {
  throw new Error(`TUI fixture property '${property}' is not provided yet`)
}

const panelClaim = (claim: SlotClaim): Option.Option<SlotClaim<"session.panel">> => {
  if ("prepend" in claim && claim.prepend === "session.panel") return Option.some(claim)
  if ("append" in claim && claim.append === "session.panel") return Option.some(claim)
  if ("before" in claim && claim.before === "session.panel") return Option.some(claim)
  if ("after" in claim && claim.after === "session.panel") return Option.some(claim)
  if ("replace" in claim && claim.replace === "session.panel") return Option.some(claim)
  return Option.none()
}

interface ApiCall {
  readonly method: string
  readonly signal: AbortSignal | undefined
}

interface FixtureOptions {
  readonly sessions: readonly SessionInfo[]
  readonly messages?: Readonly<Record<string, readonly SessionMessageInfo[]>>
  readonly models?: readonly ModelInfo[]
  readonly modelsByDirectory?: Readonly<Record<string, readonly ModelInfo[]>>
  readonly pageSize?: number
  readonly statuses?: Readonly<Record<string, "idle" | "running">>
  readonly catalogFailures?: Readonly<Record<string, string>>
  readonly messageFailures?: Readonly<Record<string, string>>
}

interface Fixture {
  readonly context: Context
  readonly layers: KeymapLayer[]
  readonly slots: Array<Option.Option<SlotClaim<"session.panel">>>
  readonly panelOpens: string[]
  readonly panelClose: { calls: number }
  readonly calls: ApiCall[]
  readonly setSessions: (sessions: readonly SessionInfo[]) => void
  readonly setMessages: (sessionID: string, messages: readonly SessionMessageInfo[]) => void
  readonly setStatus: (sessionID: string, status: "idle" | "running") => void
  readonly setTheme: (theme: ResolvedTheme) => void
  readonly failWith: (message: string) => void
}

const ZERO_USAGE: TokenUsageInfo = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const sessionInfo = (input: {
  readonly id: string
  readonly parentID?: string
  readonly agent: string
  readonly cost?: number
  readonly title?: string
  readonly revert?: SessionRevert
  readonly directory?: string
  readonly model?: ModelRef
  readonly tokens?: TokenUsageInfo
}): SessionInfo => ({
  id: input.id,
  parentID: input.parentID,
  projectID: "prj_agents_status",
  agent: input.agent,
  model: input.model,
  title: input.title,
  revert: input.revert,
  cost: input.cost ?? 0,
  tokens: input.tokens ?? ZERO_USAGE,
  time: { created: 0, updated: 0 },
  location: { directory: input.directory ?? DIRECTORY },
})

const modelInfo = (providerID: string, modelID: string, context: number): ModelInfo => ({
  id: modelID,
  modelID,
  providerID,
  name: `${providerID}/${modelID}`,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context, output: 32000 },
})

const DEEPSEEK: ModelRef = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" }

const assistantMessage = (
  id: string,
  tokens: TokenUsageInfo,
  model: ModelRef,
  agent: string,
): SessionMessageAssistant => ({
  id,
  time: { created: 0, completed: 0 },
  type: "assistant",
  agent,
  model,
  content: [],
  tokens,
})

const userMessage = (id: string, text: string): SessionMessageInfo => ({
  id,
  time: { created: 0 },
  type: "user",
  text,
})

const explorerSession: SessionInfo = sessionInfo({
  id: CHILD_SESSION,
  parentID: ROOT_SESSION,
  agent: "Junior",
  cost: 0.0123,
  model: DEEPSEEK,
})

const unrelatedSession: SessionInfo = sessionInfo({
  id: UNRELATED_SESSION,
  parentID: OTHER_ROOT,
  agent: "Unrelated",
  model: { providerID: "anthropic", id: "claude-5-opus" },
})

const explorerUsage: SessionMessageAssistant = assistantMessage(
  "msg_explorer_assistant",
  CHILD_USAGE,
  DEEPSEEK,
  "Junior",
)

const rootSession = (): SessionInfo =>
  sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })

const defaultSessions =
  (): readonly SessionInfo[] => [rootSession(), explorerSession, unrelatedSession]

const DEFAULT_MODELS: readonly ModelInfo[] = [
  modelInfo("openai", "gpt-6.1-sol", 200000),
  modelInfo("opencode-go", "deepseek-v4.1-flash", 10000),
]

const makeFixture = (options?: Partial<FixtureOptions>): Fixture => {
  const client = OpenCode.make({ baseUrl: "http://127.0.0.1:1" })
  const sessions = [...(options?.sessions ?? defaultSessions())]
  const messages = {
    ...(options?.messages ?? { [CHILD_SESSION]: [explorerUsage] }),
  }
  const models = [...(options?.models ?? DEFAULT_MODELS)]
  const modelsByDirectory: Readonly<Record<string, readonly ModelInfo[]>> = {
    ...(options?.modelsByDirectory ?? {}),
  }
  const catalogFailures = { ...(options?.catalogFailures ?? {}) }
  const messageFailures = { ...(options?.messageFailures ?? {}) }
  const pageSize = options?.pageSize ?? 200
  const calls: ApiCall[] = []
  let failure: string | undefined
  const [statuses, setStatuses] = createSignal<Readonly<Record<string, "idle" | "running">>>(
    options?.statuses ?? { [CHILD_SESSION]: "running" },
  )
  const [theme, setThemeState] = createSignal<ResolvedTheme>(THEME_A)

  const record = (method: string, request: { readonly signal?: AbortSignal } | undefined) => {
    calls.push({ method, signal: request?.signal })
    if (failure !== undefined) throw new Error(failure)
  }

  client.session.get = async (
    input,
    request,
  ) => {
    record("session.get", request)
    const found = sessions.find((session) => session.id === input.sessionID)
    if (found === undefined) throw new Error(`Unexpected session.get for ${input.sessionID}`)
    return found
  }

  client.session.list = async (
    input,
    request,
  ) => {
    record("session.list", request)
    const parentID = input?.parentID
    const limit = Math.min(input?.limit ?? pageSize, pageSize)
    const offset = input?.cursor ? Number(input.cursor) : 0
    const children = sessions
      .filter((session) => session.parentID === parentID)
      .sort((left, right) => left.id < right.id ? -1 : 1)
    const page = children.slice(offset, offset + limit)
    const next = offset + limit < children.length ? String(offset + limit) : null
    return { data: page, cursor: { next } }
  }

  client.message.list = async (
    input,
    request,
  ) => {
    record("message.list", request)
    const messageFailure = messageFailures[input.sessionID]
    if (messageFailure !== undefined) throw new Error(messageFailure)
    const list: readonly SessionMessageInfo[] = messages[input.sessionID] ?? []
    const ordered = input.order === "desc" ? [...list].reverse() : [...list]
    const limit = input.limit ?? ordered.length
    const offset = input.cursor ? Number(input.cursor) : 0
    const page = ordered.slice(offset, offset + limit)
    const next = offset + limit < ordered.length ? String(offset + limit) : null
    return { data: page, cursor: { next } }
  }

  client.model.list = async (
    input,
    request,
  ) => {
    record("model.list", request)
    const directory = input?.location?.directory ?? DIRECTORY
    const catalogFailure = catalogFailures[directory]
    if (catalogFailure !== undefined) throw new Error(catalogFailure)
    return {
      location: { directory },
      data: [...modelsByDirectory[directory] ?? models],
    }
  }

  const layers: KeymapLayer[] = []
  const slots: Array<Option.Option<SlotClaim<"session.panel">>> = []
  const panelOpens: string[] = []
  const panelClose = { calls: 0 }
  let currentPanel: { readonly name: string; readonly sessionID: string } | undefined

  const data: Data = {
    get on(): never {
      return unexpected("data.on")
    },
    get listen(): never {
      return unexpected("data.listen")
    },
    session: {
      get list(): never {
        return unexpected("data.session.list")
      },
      get get(): never {
        return unexpected("data.session.get")
      },
      get root(): never {
        return unexpected("data.session.root")
      },
      get family(): never {
        return unexpected("data.session.family")
      },
      get cost(): never {
        return unexpected("data.session.cost")
      },
      status: (sessionID) => statuses()[sessionID] ?? "idle",
      get pending(): never {
        return unexpected("data.session.pending")
      },
      get sync(): never {
        return unexpected("data.session.sync")
      },
      get invalidate(): never {
        return unexpected("data.session.invalidate")
      },
      get message(): never {
        return unexpected("data.session.message")
      },
      get permission(): never {
        return unexpected("data.session.permission")
      },
      get form(): never {
        return unexpected("data.session.form")
      },
    },
    get project(): never {
      return unexpected("data.project")
    },
    get shell(): never {
      return unexpected("data.shell")
    },
    get location(): never {
      return unexpected("data.location")
    },
  }

  const context: Context = {
    options: {},
    get location(): never {
      return unexpected("location")
    },
    get app(): never {
      return unexpected("app")
    },
    get renderer(): never {
      return unexpected("renderer")
    },
    client,
    data,
    get attention(): never {
      return unexpected("attention")
    },
    get theme(): ResolvedTheme {
      return theme()
    },
    themeMode: "dark",
    get markdown(): never {
      return unexpected("markdown")
    },
    keymap: {
      layer: (factory) => {
        layers.push(factory())
      },
      get dispatch(): never {
        return unexpected("keymap.dispatch")
      },
      get shortcuts(): never {
        return unexpected("keymap.shortcuts")
      },
      get commands(): never {
        return unexpected("keymap.commands")
      },
      get pending(): never {
        return unexpected("keymap.pending")
      },
      get active(): never {
        return unexpected("keymap.active")
      },
      get mode(): never {
        return unexpected("keymap.mode")
      },
    },
    storage: {
      store: <Value extends object>(
        key: string,
        options: { readonly initial: Value },
      ): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>] => {
        void key
        const value = options.initial
        const update = async (mutation: (draft: Value) => void) => {
          mutation(value)
        }
        return [value, update]
      },
      get memory(): never {
        return unexpected("storage.memory")
      },
    },
    ui: {
      get dialog(): never {
        return unexpected("ui.dialog")
      },
      get toast(): never {
        return unexpected("ui.toast")
      },
      get format(): never {
        return unexpected("ui.format")
      },
      router: {
        current: () => ({ type: "session", sessionID: ROOT_SESSION }),
        get register(): never {
          return unexpected("ui.router.register")
        },
        get navigate(): never {
          return unexpected("ui.router.navigate")
        },
      },
      panel: {
        open: (name) => {
          panelOpens.push(name)
          currentPanel = { name, sessionID: ROOT_SESSION }
          return true
        },
        close: () => {
          panelClose.calls += 1
          currentPanel = undefined
        },
        current: () => currentPanel,
      },
      get tabs(): never {
        return unexpected("ui.tabs")
      },
      get model(): never {
        return unexpected("ui.model")
      },
      slot: (claim) => {
        slots.push(panelClaim(claim))
        return () => {}
      },
    },
  }

  return {
    context,
    layers,
    slots,
    panelOpens,
    panelClose,
    calls,
    setSessions: (next) => {
      sessions.splice(0, sessions.length, ...next)
    },
    setMessages: (sessionID, next) => {
      messages[sessionID] = next
    },
    setStatus: (sessionID, status) => {
      setStatuses((previous) => ({
        ...previous,
        [sessionID]: status,
      }))
    },
    setTheme: (next) => {
      setThemeState(next)
    },
    failWith: (message) => {
      failure = message
    },
  }
}

const findCommand = (
  fixture: Fixture,
  predicate: (command: KeymapCommand) => boolean,
): KeymapCommand | undefined =>
  fixture.layers
    .flatMap((layer) => layer.commands ?? [])
    .find(predicate)

const findPanelClaim = (fixture: Fixture): SlotClaim<"session.panel"> => {
  for (const claim of fixture.slots) {
    if (Option.isSome(claim)) return claim.value
  }
  throw new Error("Expected the plugin to claim the session.panel slot")
}

const makePanelInput = (name: string, close: () => void = () => {}): PanelInput => ({
  name,
  sessionID: ROOT_SESSION,
  width: 120,
  presentation: "panel",
  focused: true,
  focus: () => {},
  close,
  toggleFullscreen: () => {},
})

type PanelRenderer = (input: PanelInput, size: TestRendererOptions) => Promise<TestRendererSetup>

const renderPanel = (
  context: Context,
  claim: SlotClaim<"session.panel">,
  input: PanelInput,
  size: TestRendererOptions,
): Promise<TestRendererSetup> =>
  testRender(
    () =>
      PluginContextProvider({
        value: context,
        children: claim.render(input),
      }),
    size,
  )

const setupPlugin = async (fixture: Fixture): Promise<Cleanup> => {
  const setupResult = await plugin.setup(fixture.context)
  if (typeof setupResult !== "function") {
    throw new Error("Expected TUI plugin setup to return a cleanup function")
  }
  return setupResult
}

const runScoped = <Result,>(effect: Effect.Effect<Result, never, Scope.Scope>): Promise<Result> =>
  Effect.runPromise(Effect.scoped(effect))

const acquirePluginCleanup = (fixture: Fixture): Effect.Effect<Cleanup, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => setupPlugin(fixture)),
    (cleanup, _exit) =>
      Effect.promise(async () => {
        await cleanup()
      }),
  )

const acquirePanelRenderer = (
  render: PanelRenderer,
  input: PanelInput,
  size: TestRendererOptions,
): Effect.Effect<TestRendererSetup, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => render(input, size)),
    (setup, _exit) =>
      Effect.sync(() => {
        setup.renderer.destroy()
      }),
  )

/** Runs the body with the plugin set up, handing it the typed panel render capability. */
const withPlugin = (
  fixture: Fixture,
  body: (render: PanelRenderer) => Promise<void>,
): Promise<void> =>
  runScoped(
    Effect.flatMap(
      acquirePluginCleanup(fixture),
      () => {
        const claim = findPanelClaim(fixture)
        const context = fixture.context
        const render = (
          input: PanelInput,
          size: TestRendererOptions,
        ) => renderPanel(context, claim, input, size)
        return Effect.promise(() => body(render))
      },
    ),
  )

const withPanel = (
  render: PanelRenderer,
  input: PanelInput,
  size: TestRendererOptions,
  body: (setup: TestRendererSetup) => Promise<void>,
): Promise<void> =>
  runScoped(
    Effect.flatMap(
      acquirePanelRenderer(render, input, size),
      (setup) => Effect.promise(() => body(setup)),
    ),
  )

test("/agents-status opens the session panel that reports child agent usage", async () => {
  const fixture = makeFixture()
  await withPlugin(fixture, async (render) => {
    const command = findCommand(
      fixture,
      (candidate) => candidate.slash?.name === SLASH_NAME,
    )
    if (command === undefined) {
      throw new Error(`Expected the plugin to register the /${SLASH_NAME} command`)
    }
    expect(command.title).toBe(COMMAND_TITLE)
    expect(command.palette).toBe(true)
    expect(command.slash?.name).toBe(SLASH_NAME)

    await command.run()
    expect(fixture.panelOpens).toEqual([PANEL_NAME])

    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 24 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Junior"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Junior")
        expect(frame).toContain("opencode-go/deepseek-v4.1-flash#high")
        expect(frame).toContain("Peak context: 1.65K / 10K tokens (17%)")
        expect(frame).toContain("$0.0123")
        expect(frame).not.toContain("Unrelated")
        expect(frame).not.toContain(COMMAND_TITLE)
      },
    )
  })
})

test("command toggles the panel, Escape closes it when focused, and unrelated panels do not render", async () => {
  const fixture = makeFixture()
  await withPlugin(fixture, async (render) => {
    const command = findCommand(
      fixture,
      (candidate) => candidate.slash?.name === SLASH_NAME,
    )
    if (command === undefined) {
      throw new Error(`Expected the plugin to register the /${SLASH_NAME} command`)
    }
    await command.run()
    expect(fixture.panelOpens).toEqual([PANEL_NAME])
    await command.run()
    expect(fixture.panelClose.calls).toBe(1)

    await withPanel(
      render,
      makePanelInput("session-todo.list"),
      { width: 120, height: 24 },
      async (otherSetup) => {
        await otherSetup.flush()
        const otherFrame = otherSetup.captureCharFrame()
        expect(otherFrame).not.toContain("Total reported spend")
        expect(otherFrame).not.toContain("Junior")
        expect(fixture.calls).toEqual([])
      },
    )

    let closeCalls = 0
    await withPanel(
      render,
      makePanelInput(PANEL_NAME, () => {
        closeCalls += 1
      }),
      { width: 120, height: 24 },
      async (focusedSetup) => {
        await focusedSetup.waitForFrame(
          (candidate) => candidate.includes("Junior"),
          { maxPasses: 20 },
        )
        const escape = findCommand(
          fixture,
          (candidate) => candidate.bind === "escape",
        )
        if (escape === undefined) {
          throw new Error("Expected the focused panel to bind Escape")
        }
        const escapeLayer = fixture.layers.find(
          (layer) => (layer.commands ?? []).some((entry) => entry.bind === "escape"),
        )
        expect(escapeLayer?.enabled).toBe(true)
        await escape.run()
        expect(closeCalls).toBe(1)
      },
    )
  })
})

test("panel walks paginated descendants once, keeps same-agent sessions, and excludes unrelated trees", async () => {
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const alpha = sessionInfo({
    id: "ses_child_a",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Alpha task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const beta = sessionInfo({
    id: "ses_child_b",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Beta task",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const gamma = sessionInfo({
    id: "ses_child_c",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Gamma task",
    cost: 0.004,
  })
  const nested = sessionInfo({
    id: "ses_nested",
    parentID: "ses_child_a",
    agent: "Architect",
    title: "Delta task",
    cost: 0.001,
  })
  const stranger = sessionInfo({
    id: "ses_stranger",
    parentID: OTHER_ROOT,
    agent: "Stranger",
    cost: 9.9999,
  })
  const strangerChild = sessionInfo({
    id: "ses_stranger_child",
    parentID: "ses_stranger",
    agent: "Deep stranger child",
    cost: 0.5,
  })
  const fixture = makeFixture({
    sessions: [root, alpha, alpha, beta, gamma, nested, stranger, strangerChild],
    messages: {},
    models: [],
    pageSize: 2,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 60 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Architect"),
          { maxPasses: 20 },
        )
        expect(frame.split("● Junior").length - 1).toBe(1)
        expect(frame).toContain("3 sessions")
        expect(frame).toContain("Spent: $0.0183")
        expect(frame).toContain("● Architect")
        expect(frame).toContain("Total reported spend: $0.0293")
        expect(frame).not.toContain("Alpha task")
        expect(frame).not.toContain("Beta task")
        expect(frame).not.toContain("Gamma task")
        expect(frame).not.toContain("Delta task")
        expect(frame).not.toContain("Stranger")
        expect(frame).not.toContain("$9.9999")
        expect(frame).not.toContain("$0.5000")
      },
    )
  })
})

const PRE_COMPACTION_USAGE: TokenUsageInfo = {
  input: 3000,
  output: 1000,
  reasoning: 500,
  cache: { read: 300, write: 200 },
}

const compactionCompleted = (id: string): SessionMessageInfo => ({
  type: "compaction",
  id,
  time: { created: 1 },
  status: "completed",
  reason: "auto",
  summary: "compacted",
  recent: "recent",
})

interface ContextCase {
  readonly name: string
  readonly child: SessionInfo
  readonly messages: Readonly<Record<string, readonly SessionMessageInfo[]>>
  readonly models: readonly ModelInfo[]
  readonly contains: readonly [string, ...string[]]
  readonly missing: readonly string[]
}

const contextCases: readonly ContextCase[] = [
  {
    name: "missing model and messages",
    child: sessionInfo({ id: "ses_ghost", parentID: ROOT_SESSION, agent: "Ghost" }),
    messages: {},
    models: DEFAULT_MODELS,
    contains: ["Model: unknown", "Peak context: unknown"],
    missing: [],
  },
  {
    name: "latest completed compaction suppresses earlier usage",
    child: sessionInfo({
      id: "ses_compact",
      parentID: ROOT_SESSION,
      agent: "Compactor",
      model: DEEPSEEK,
    }),
    messages: {
      ses_compact: [
        assistantMessage("msg_before", PRE_COMPACTION_USAGE, DEEPSEEK, "Compactor"),
        compactionCompleted("msg_compaction"),
        assistantMessage("msg_after", CHILD_USAGE, DEEPSEEK, "Compactor"),
      ],
    },
    models: DEFAULT_MODELS,
    contains: ["Peak context: 1.65K / 10K tokens (17%)"],
    missing: ["Peak context: 5K", "50%"],
  },
  {
    name: "absent revert boundary leaves context unknown",
    child: sessionInfo({
      id: "ses_reverted",
      parentID: ROOT_SESSION,
      agent: "Reverted",
      model: DEEPSEEK,
      revert: { messageID: "msg_not_returned" },
    }),
    messages: {
      ses_reverted: [assistantMessage("msg_reverted", CHILD_USAGE, DEEPSEEK, "Reverted")],
    },
    models: DEFAULT_MODELS,
    contains: ["Peak context: unknown"],
    missing: ["1.65K"],
  },
  {
    name: "missing model limit falls back to token count",
    child: sessionInfo({
      id: "ses_limitless",
      parentID: ROOT_SESSION,
      agent: "Limitless",
      model: DEEPSEEK,
    }),
    messages: {
      ses_limitless: [assistantMessage("msg_limitless", CHILD_USAGE, DEEPSEEK, "Limitless")],
    },
    models: [modelInfo("openai", "gpt-6.1-sol", 200000)],
    contains: ["Peak context: 1.65K tokens (limit unknown)"],
    missing: ["/ 10K tokens", "17%"],
  },
]

for (const contextCase of contextCases) {
  test(`context usage: ${contextCase.name}`, async () => {
    const fixture = makeFixture({
      sessions: [rootSession(), contextCase.child],
      messages: contextCase.messages,
      models: contextCase.models,
    })
    await withPlugin(fixture, async (render) => {
      await withPanel(
        render,
        makePanelInput(PANEL_NAME),
        { width: 120, height: 40 },
        async (setup) => {
          const frame = await setup.waitForFrame(
            (candidate) => candidate.includes(contextCase.contains[0]),
            { maxPasses: 20 },
          )
          for (const expected of contextCase.contains) {
            expect(frame).toContain(expected)
          }
          for (const absent of contextCase.missing) {
            expect(frame).not.toContain(absent)
          }
        },
      )
    })
  })
}

test(
  "panel live-refreshes after two seconds and stops fetching once unmounted",
  async () => {
    const low = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "low" }
    const high = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" }
    const root = sessionInfo({
      id: ROOT_SESSION,
      agent: "build",
      cost: 0.01,
      model: { providerID: "openai", id: "gpt-6.1-sol" },
    })
    const childA = sessionInfo({
      id: "ses_child_a",
      parentID: ROOT_SESSION,
      agent: "Junior",
      title: "Alpha task",
      cost: 0.0123,
      model: low,
    })
    const fixture = makeFixture({
      sessions: [root, childA],
      messages: { ses_child_a: [assistantMessage("msg_a_initial", CHILD_USAGE, low, "Junior")] },
      statuses: { ses_child_a: "running" },
    })
    await withPlugin(fixture, async (render) => {
      expect(fixture.calls).toEqual([])

      await withPanel(
        render,
        makePanelInput(PANEL_NAME),
        { width: 120, height: 40 },
        async (setup) => {
          const initial = await setup.waitForFrame(
            (candidate) => candidate.includes("opencode-go/deepseek-v4.1-flash#low"),
            { maxPasses: 20 },
          )
          expect(initial).toContain("Peak context: 1.65K / 10K tokens (17%)")
          expect(initial).toContain("Spent: $0.0123")
          expect(initial).toContain("1 running · 1 session")
          expect(initial).toContain("Total reported spend: $0.0223")
          expect(fixture.calls.length).toBeGreaterThan(0)

          const refreshedUsage = {
            input: 1200,
            output: 300,
            reasoning: 100,
            cache: { read: 300, write: 100 },
          }
          const childB = sessionInfo({
            id: "ses_child_b",
            parentID: ROOT_SESSION,
            agent: "Reviewer",
            title: "Beta task",
            cost: 0.003,
            model: { providerID: "anthropic", id: "claude-5-opus" },
          })
          fixture.setSessions([
            root,
            sessionInfo({
              id: "ses_child_a",
              parentID: ROOT_SESSION,
              agent: "Junior",
              title: "Alpha task",
              cost: 0.02,
              model: high,
            }),
            childB,
          ])
          fixture.setMessages("ses_child_a", [
            assistantMessage("msg_a_refreshed", refreshedUsage, high, "Junior"),
          ])
          fixture.setStatus("ses_child_a", "idle")

          await Bun.sleep(2200)
          const refreshed = await setup.waitForFrame(
            (candidate) => candidate.includes("opencode-go/deepseek-v4.1-flash#high"),
            { maxPasses: 40 },
          )
          expect(refreshed).toContain("Peak context: 2K / 10K tokens (20%)")
          expect(refreshed).toContain("Spent: $0.0200")
          expect(refreshed).toContain("Spent: $0.0030")
          expect(refreshed).toContain("Reviewer")
          expect(refreshed).toContain("0 running · 1 session")
          expect(refreshed).not.toContain("1 running")
          expect(refreshed).not.toContain("#low")
          expect(refreshed).toContain("Total reported spend: $0.0330")

          const before = fixture.calls.length
          setup.renderer.destroy()
          for (const call of fixture.calls) {
            expect(call.signal?.aborted).toBe(true)
          }
          await Bun.sleep(2200)
          expect(fixture.calls.length).toBe(before)
        },
      )
    })
  },
  20000,
)

test("panel warns with stale values when a refresh fails", async () => {
  const fixture = makeFixture()
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const initial = await setup.waitForFrame(
          (candidate) => candidate.includes("Spent: $0.0123"),
          { maxPasses: 20 },
        )
        expect(initial).toContain("Junior")
        expect(initial).not.toContain("Refresh failed")

        fixture.failWith("refresh exploded")
        await Bun.sleep(2200)
        const failed = await setup.waitForFrame(
          (candidate) => candidate.includes("Refresh failed"),
          { maxPasses: 40 },
        )
        expect(failed).toContain("Refresh failed (values may be stale): refresh exploded")
        expect(failed).toContain("Junior")
        expect(failed).toContain("Spent: $0.0123")
        expect(failed).toContain("Total reported spend: $0.0123")

        setup.renderer.destroy()
      },
    )
  })
}, 15000)

interface ScrollBoxLike {
  scrollTop: number
  readonly scrollHeight: number
}

const isScrollBoxLike = (value: unknown): value is ScrollBoxLike =>
  typeof value === "object"
  && value !== null
  && "scrollTop" in value
  && typeof value.scrollTop === "number"
  && "scrollHeight" in value
  && typeof value.scrollHeight === "number"

const findScrollBox = (renderable: Renderable): ScrollBoxLike | undefined => {
  if (isScrollBoxLike(renderable)) return renderable
  for (const child of renderable.getChildren()) {
    const found = findScrollBox(child)
    if (found !== undefined) return found
  }
  return undefined
}

const HEADER_FOREIGN: readonly string[] = [
  "Refreshes",
  "Esc",
  "Spent:",
  "ses_",
  "Model:",
  "Context:",
  "Peak context:",
  "Tokens:",
]
const FOOTER_FOREIGN: readonly string[] = [
  "Spent:",
  "ses_",
  "Model:",
  "Context:",
  "Peak context:",
]
const FOOTER_SHAPE: RegExp = /^Total[ :]*(?:reported spend)?[ :]*\$/
const TOKENS_SHAPE: RegExp = /^Tokens[ :]*(?:↑|unavailable)/
const HELP_TEXTS: readonly string[] = [
  "Refreshes every",
  "Context is the latest",
  "Esc when focused",
]

const chromeProblems = (frame: string, position: string): readonly string[] => {
  const lines: readonly string[] = frame.split("\n").map((line) => line.trim())
  const nonEmpty: readonly string[] = lines.filter((line) => line.length > 0)
  const headers: readonly string[] = lines.filter((line) =>
    line.includes("Agents") && line.includes("Sessions")
  )
  const header = headers[0]
  const footerIndex = lines.findIndex((line) => line.includes("Total"))
  const headerIndex = lines.findIndex((line) =>
    line.includes("Agents") && line.includes("Sessions")
  )
  const footer = footerIndex < 0 ? undefined : lines[footerIndex]
  const tokens = footerIndex < 0 ? undefined : lines[footerIndex + 1]
  const top = nonEmpty[0] ?? ""
  const bottom = nonEmpty[nonEmpty.length - 1] ?? ""
  const problems: string[] = []
  if (headers.length !== 1) {
    problems.push(
      `${position}: expected one row containing both tab labels, found ${headers.length}`,
    )
  }
  if (header === undefined) {
    problems.push(`${position}: tab header row is missing or overwritten`)
  } else {
    if (!header.includes("Agents")) {
      problems.push(`${position}: Agents tab label is missing: ${JSON.stringify(header)}`)
    }
    if (!header.includes("Sessions")) {
      problems.push(`${position}: Sessions tab label is missing: ${JSON.stringify(header)}`)
    }
    if (/\d/.test(header)) {
      problems.push(`${position}: tab header carries counts: ${JSON.stringify(header)}`)
    }
    if (!/▸\s(?:Agents|Sessions)/.test(header)) {
      problems.push(
        `${position}: active-tab marker is not attached to a label: ${JSON.stringify(header)}`,
      )
    }
    if (!header.includes("← →")) {
      problems.push(`${position}: arrow-key hint is missing from the tab header`)
    }
    if (!header.includes("×")) {
      problems.push(`${position}: close control is missing from the tab header`)
    }
    if ((header.match(/▸/g) ?? []).length !== 1) {
      problems.push(`${position}: expected one active-tab marker: ${JSON.stringify(header)}`)
    }
    for (const marker of HEADER_FOREIGN) {
      if (header.includes(marker)) {
        problems.push(
          `${position}: header row carries foreign text ${JSON.stringify(marker)}: ${
            JSON.stringify(header)
          }`,
        )
      }
    }
  }
  if (frame.includes("Agents status")) {
    problems.push(`${position}: panel title 'Agents status' must not be rendered`)
  }
  if (headerIndex >= 0) {
    const below = lines[headerIndex + 1] ?? ""
    if (below !== "") {
      problems.push(
        `${position}: expected a fixed blank row below the tab header, found ${
          JSON.stringify(below)
        }`,
      )
    }
  }
  if (footerIndex > 0) {
    const above = lines[footerIndex - 1] ?? ""
    if (above !== "") {
      problems.push(
        `${position}: expected a fixed blank row above the spend footer, found ${
          JSON.stringify(above)
        }`,
      )
    }
  }
  if (footer === undefined) {
    problems.push(`${position}: footer row containing 'Total' is missing or overwritten`)
  } else {
    if (!FOOTER_SHAPE.test(footer)) {
      problems.push(`${position}: footer row is not intact: ${JSON.stringify(footer)}`)
    }
    for (const marker of [...FOOTER_FOREIGN, "Tokens:"]) {
      if (footer.includes(marker)) {
        problems.push(
          `${position}: footer row carries entry text ${JSON.stringify(marker)}: ${
            JSON.stringify(footer)
          }`,
        )
      }
    }
  }
  if (tokens === undefined || !TOKENS_SHAPE.test(tokens)) {
    problems.push(
      `${position}: token totals row is missing directly below the spend footer: ${
        JSON.stringify(tokens)
      }`,
    )
  } else {
    for (const marker of FOOTER_FOREIGN) {
      if (tokens.includes(marker)) {
        problems.push(
          `${position}: token totals row carries entry text ${JSON.stringify(marker)}: ${
            JSON.stringify(tokens)
          }`,
        )
      }
    }
  }
  if (!top.includes("Agents") || !top.includes("Sessions")) {
    problems.push(`${position}: top row is not the tab header: ${JSON.stringify(top)}`)
  }
  if (!TOKENS_SHAPE.test(bottom)) {
    problems.push(
      `${position}: bottom row is not the token totals footer: ${JSON.stringify(bottom)}`,
    )
  }
  for (const help of HELP_TEXTS) {
    if (frame.includes(help)) {
      problems.push(`${position}: help text still present: ${JSON.stringify(help)}`)
    }
  }
  return problems
}

const trimmedLines = (frame: string): readonly string[] =>
  frame.split("\n").map((line) => line.replace(/[│█▀▄]/g, " ").trim())

/** Asserts the scrollTop 0 gap: exactly one fixed blank row between the tab header and the first card. */
const topGapProblems = (frame: string, position: string): readonly string[] => {
  const lines: readonly string[] = trimmedLines(frame)
  const headerIndex = lines.findIndex((line) =>
    line.includes("Agents") && line.includes("Sessions")
  )
  if (headerIndex < 0) {
    return [`${position}: tab header row is missing`]
  }
  const gap = lines[headerIndex + 1] ?? ""
  const first = lines[headerIndex + 2] ?? ""
  const problems: string[] = []
  if (gap !== "") {
    problems.push(
      `${position}: expected one fixed blank row below the tab header, found ${
        JSON.stringify(gap)
      }`,
    )
  }
  if (!first.startsWith("● ")) {
    problems.push(
      `${position}: expected the first card title right after the gap, found ${
        JSON.stringify(first)
      }`,
    )
  }
  return problems
}

const makeOverflowFixture = (): Fixture => {
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const child = (index: number, cost: number) =>
    sessionInfo({
      id: `ses_child_${index}`,
      parentID: ROOT_SESSION,
      agent: `Agent ${index}`,
      title: `Entry ${index}`,
      cost,
      model: DEEPSEEK,
    })
  return makeFixture({
    sessions: [root, child(1, 0.0123), child(2, 0.002), child(3, 0.004)],
    messages: {},
    models: DEFAULT_MODELS,
  })
}

test(
  "panel keeps header and footer on coherent rows while entries overflow at 76x22, 12 rows, and 42 cols",
  async () => {
    interface ViewportCase {
      readonly name: string
      readonly width: number
      readonly height: number
    }

    const viewports: readonly ViewportCase[] = [
      { name: "76x22", width: 76, height: 22 },
      { name: "76x12", width: 76, height: 12 },
      { name: "42x22", width: 42, height: 22 },
    ]

    const problems: string[] = []
    for (const viewport of viewports) {
      const fixture = makeOverflowFixture()
      await withPlugin(fixture, async (render) => {
        await withPanel(
          render,
          makePanelInput(PANEL_NAME),
          { width: viewport.width, height: viewport.height },
          async (setup) => {
            const initial = await setup.waitForFrame(
              (candidate) => candidate.includes("Model: openai/gpt-6.1-sol"),
              { maxPasses: 40 },
            )
            problems.push(...chromeProblems(initial, `${viewport.name} agents top`))
            problems.push(...topGapProblems(initial, `${viewport.name} agents top`))

            const scrollbox = findScrollBox(setup.renderer.root)
            if (scrollbox === undefined) {
              throw new Error(
                `${viewport.name}: expected an OpenTUI scrollbox in the rendered panel`,
              )
            }
            scrollbox.scrollTop = Math.floor(scrollbox.scrollHeight / 2)
            await setup.renderOnce()
            problems.push(
              ...chromeProblems(setup.captureCharFrame(), `${viewport.name} agents middle`),
            )

            scrollbox.scrollTop = scrollbox.scrollHeight
            await setup.renderOnce()
            const scrolled = await setup.waitForFrame(
              (candidate) => candidate.includes("Agent 3"),
              { maxPasses: 40 },
            )
            problems.push(...chromeProblems(scrolled, `${viewport.name} agents bottom`))

            const sessionsTab = findCommand(
              fixture,
              (candidate) => candidate.bind === "s",
            )
            if (sessionsTab === undefined) {
              throw new Error("Expected the focused panel to bind 's' to the Sessions tab")
            }
            await sessionsTab.run()
            scrollbox.scrollTop = 0
            await setup.renderOnce()
            const sessionsTop = await setup.waitForFrame(
              (candidate) => candidate.includes("● ses_root"),
              { maxPasses: 40 },
            )
            problems.push(...chromeProblems(sessionsTop, `${viewport.name} sessions top`))
            problems.push(...topGapProblems(sessionsTop, `${viewport.name} sessions top`))

            scrollbox.scrollTop = Math.floor(scrollbox.scrollHeight / 2)
            await setup.renderOnce()
            problems.push(
              ...chromeProblems(setup.captureCharFrame(), `${viewport.name} sessions middle`),
            )

            scrollbox.scrollTop = scrollbox.scrollHeight
            await setup.renderOnce()
            const sessionsBottom = await setup.waitForFrame(
              (candidate) => candidate.includes("Spent: $0.0040"),
              { maxPasses: 40 },
            )
            problems.push(
              ...chromeProblems(sessionsBottom, `${viewport.name} sessions bottom`),
            )
          },
        )
      })
    }

    if (problems.length > 0) {
      throw new Error(`panel chrome is incoherent:\n- ${problems.join("\n- ")}`)
    }
  },
  15000,
)

test("panel shows the executing assistant model as primary and the selected model separately when they differ", async () => {
  const selected = {
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
    variant: "high",
  }
  const executing = { providerID: "anthropic", id: "claude-5-opus" }
  const child = sessionInfo({
    id: "ses_child_divergent",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Divergent model",
    cost: 0.0123,
    model: selected,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: {
      ses_child_divergent: [assistantMessage("msg_divergent", CHILD_USAGE, executing, "Junior")],
    },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Model: anthropic/claude-5-opus"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Model: anthropic/claude-5-opus")
        expect(frame).toMatch(/selected[: ]+opencode-go\/deepseek-v4\.1-flash#high/i)
        expect(frame).not.toContain("Model: opencode-go/deepseek-v4.1-flash#high")
      },
    )
  })
})

test("panel isolates an unavailable model catalog to the affected card", async () => {
  const deletedDirectory = "/tmp/opencode/agents-status-deleted"
  const failedModel = { providerID: "anthropic", id: "claude-5-opus" }
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const childOk = sessionInfo({
    id: "ses_child_ok",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Accessible child",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const childGone = sessionInfo({
    id: "ses_child_gone",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Deleted location child",
    cost: 0.003,
    directory: deletedDirectory,
    model: failedModel,
  })
  const fixture = makeFixture({
    sessions: [root, childOk, childGone],
    messages: {
      ses_child_ok: [assistantMessage("msg_ok", CHILD_USAGE, DEEPSEEK, "Junior")],
      ses_child_gone: [assistantMessage("msg_gone", CHILD_USAGE, failedModel, "Junior")],
    },
    models: DEFAULT_MODELS,
    catalogFailures: { [deletedDirectory]: "catalog unavailable for deleted location" },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Context data unavailable"),
          { maxPasses: 40 },
        )
        expect(frame).toContain("build · main")
        expect(frame).toContain("0 running · 2 sessions")
        expect(frame).toContain("Peak context: 1.65K / 10K tokens (17%)")
        expect(frame).toContain("Model: anthropic/claude-5-opus")
        expect(frame).toContain("Spent: $0.0050")
        expect(frame).toContain("Peak context: 1.65K tokens (limit unknown)")
        expect(frame).toContain("Total reported spend: $0.0150")
        expect(frame).not.toContain("Refresh failed (values may be stale)")

        const failedModelRow = frame.indexOf("Model: anthropic/claude-5-opus")
        const note = frame.indexOf("Context data unavailable")
        const nextModelRow = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#high")
        expect(failedModelRow).toBeGreaterThanOrEqual(0)
        expect(note).toBeGreaterThan(failedModelRow)
        expect(nextModelRow).toBeGreaterThan(note)
      },
    )
  })
})

test("panel paginates message history past the first page to honor a staged revert boundary", async () => {
  const boundary = "msg_boundary"
  const lateUsage = {
    input: 4000,
    output: 1000,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  const history = [
    assistantMessage("msg_early_assistant", CHILD_USAGE, DEEPSEEK, "Junior"),
    userMessage(boundary, "stage revert here"),
  ]
  for (let index = 0; index < 110; index++) {
    history.push(userMessage(`msg_after_${String(index).padStart(3, "0")}`, `follow-up ${index}`))
  }
  history.push(
    assistantMessage(
      "msg_late_assistant",
      lateUsage,
      { providerID: "anthropic", id: "claude-5-opus" },
      "Junior",
    ),
  )
  const child = sessionInfo({
    id: "ses_child_paged",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Paged history",
    cost: 0.0123,
    revert: { messageID: boundary },
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: { ses_child_paged: history },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Peak context: 1.65K / 10K tokens (17%)"),
          { maxPasses: 60 },
        )
        expect(frame).not.toContain("Paged history")
        expect(frame).toContain("Peak context: 1.65K / 10K tokens (17%)")
        expect(frame).toContain("Model: anthropic/claude-5-opus")
        expect(frame).not.toContain("Peak context: 5K")

        const anthropicStart = frame.indexOf("Model: anthropic/claude-5-opus")
        const contextStart = frame.indexOf(
          "Context model: opencode-go/deepseek-v4.1-flash#high",
        )
        expect(anthropicStart).toBeGreaterThanOrEqual(0)
        expect(contextStart).toBeGreaterThan(anthropicStart)

        const anthropicGroup = frame.slice(anthropicStart, contextStart)
        expect(anthropicGroup).toContain("Peak context: unknown")
        expect(anthropicGroup).not.toContain("1.65K")
        expect(anthropicGroup).not.toContain("17%")

        const contextGroup = frame.slice(
          contextStart,
          frame.indexOf("Total reported spend"),
        )
        expect(contextGroup).toMatch(/Peak context:\s*1\.65K\s*\/\s*10K tokens\s*\(17%\)/)
      },
    )
  })
})

test("panel does not report the selected model as actual when message history is unavailable", async () => {
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    title: "Main task",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const child = sessionInfo({
    id: "ses_child_lost",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Lost history",
    cost: 0.003,
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [root, child],
    messages: {},
    messageFailures: { ses_child_lost: "message history unavailable" },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Selected: opencode-go/deepseek-v4.1-flash#high"),
          { maxPasses: 40 },
        )
        const cardStart = frame.indexOf("● Junior")
        const cardEnd = frame.indexOf("Total reported spend")
        expect(cardStart).toBeGreaterThanOrEqual(0)
        expect(cardEnd).toBeGreaterThan(cardStart)
        const card = frame.slice(cardStart, cardEnd)
        expect(card).toContain("Spent: $0.0030")
        expect(card).toContain("Model: unknown")
        expect(card).toContain("Selected: opencode-go/deepseek-v4.1-flash#high")
        expect(card).toContain("Context data unavailable")
        expect(card).not.toContain("Model: opencode-go/deepseek-v4.1-flash#high")
        expect(frame).toContain("Total reported spend: $0.0130")
        expect(frame).not.toContain("Refresh failed (values may be stale)")
      },
    )
  })
})

test("focused panel scrolls on PageDown and PageUp while header and footer stay fixed", async () => {
  const fixture = makeOverflowFixture()
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 76, height: 22 },
      async (setup) => {
        const initial = await setup.waitForFrame(
          (candidate) => candidate.includes("Model: openai/gpt-6.1-sol"),
          { maxPasses: 40 },
        )
        expect(chromeProblems(initial, "initial")).toEqual([])

        const scrollbox = findScrollBox(setup.renderer.root)
        if (scrollbox === undefined) {
          throw new Error("Expected an OpenTUI scrollbox in the rendered panel")
        }
        const before = scrollbox.scrollTop
        expect(before).toBe(0)

        setup.mockInput.pressKey("\x1b[6~")
        await setup.renderOnce()
        const afterDown = scrollbox.scrollTop
        expect(afterDown).toBeGreaterThan(before)
        expect(chromeProblems(setup.captureCharFrame(), "after PageDown")).toEqual([])

        setup.mockInput.pressKey("\x1b[5~")
        await setup.renderOnce()
        const afterUp = scrollbox.scrollTop
        expect(afterUp).toBeLessThan(afterDown)
        expect(chromeProblems(setup.captureCharFrame(), "after PageUp")).toEqual([])
      },
    )
  })
})

test("panel picks the highest known context percentage per model across locations", async () => {
  const locationA = "/tmp/opencode/agents-status-limit-a"
  const locationB = "/tmp/opencode/agents-status-limit-b"
  const smallUsage = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const largeUsage = {
    input: 16000,
    output: 3000,
    reasoning: 500,
    cache: { read: 400, write: 100 },
  }
  const first = sessionInfo({
    id: "ses_limit_a",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0123,
    directory: locationA,
    model: DEEPSEEK,
  })
  const second = sessionInfo({
    id: "ses_limit_b",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.002,
    directory: locationB,
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), first, second],
    messages: {
      ses_limit_a: [assistantMessage("msg_limit_a", smallUsage, DEEPSEEK, "Junior")],
      ses_limit_b: [assistantMessage("msg_limit_b", largeUsage, DEEPSEEK, "Junior")],
    },
    modelsByDirectory: {
      [locationA]: [modelInfo("opencode-go", "deepseek-v4.1-flash", 10000)],
      [locationB]: [modelInfo("opencode-go", "deepseek-v4.1-flash", 100000)],
    },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Peak context: 5K / 10K tokens (50%)"),
          { maxPasses: 40 },
        )
        expect(frame).toContain("2 sessions")
        expect(frame).toContain("opencode-go/deepseek-v4.1-flash#high")
        expect(frame).not.toContain("Peak context: 20K / 100K tokens (20%)")
        expect(frame).not.toContain("20K")
        expect(frame).not.toContain("25K")
      },
    )
  })
})

test("focused panel switches between aggregate agents and per-session usage", async () => {
  const actualBeta = { providerID: "anthropic", id: "claude-5-opus", variant: "high" }
  const betaUsage = {
    input: 4000,
    output: 500,
    reasoning: 100,
    cache: { read: 300, write: 100 },
  }
  const alpha = sessionInfo({
    id: "ses_child_a",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Alpha task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const beta = sessionInfo({
    id: "ses_child_b",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Beta task",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), alpha, beta, unrelatedSession],
    messages: {
      ses_child_a: [assistantMessage("msg_alpha", CHILD_USAGE, DEEPSEEK, "Junior")],
      ses_child_b: [assistantMessage("msg_beta", betaUsage, actualBeta, "Junior")],
    },
    models: [
      modelInfo("opencode-go", "deepseek-v4.1-flash", 10000),
      modelInfo("anthropic", "claude-5-opus", 20000),
    ],
    statuses: { ses_child_a: "running", ses_child_b: "idle" },
  })

  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 65 },
      async (setup) => {
        const aggregate = await setup.waitForFrame(
          (candidate) => candidate.includes("Total reported spend: $0.0143"),
          { maxPasses: 40 },
        )
        expect(aggregate.split("● Junior").length - 1).toBe(1)
        expect(aggregate).toContain("2 sessions")
        expect(aggregate).toContain("Spent: $0.0143")
        expect(aggregate).not.toContain("Alpha task")
        expect(aggregate).not.toContain("Beta task")
        expect(aggregate).not.toContain("Unrelated")

        const sessionsTab = findCommand(
          fixture,
          (candidate) => candidate.bind === "s",
        )
        if (sessionsTab === undefined) {
          throw new Error("Expected the focused panel to bind 's' to the Sessions tab")
        }
        await sessionsTab.run()

        const sessions = await setup.waitForFrame(
          (candidate) => candidate.includes("Alpha task") && candidate.includes("Beta task"),
          { maxPasses: 40 },
        )
        const alphaStart = sessions.indexOf("Alpha task")
        const betaStart = sessions.indexOf("Beta task")
        const totalStart = sessions.indexOf("Total reported spend")
        expect(alphaStart).toBeGreaterThanOrEqual(0)
        expect(betaStart).toBeGreaterThan(alphaStart)
        expect(totalStart).toBeGreaterThan(betaStart)
        const alphaCard = sessions.slice(alphaStart, betaStart)
        const betaCard = sessions.slice(betaStart, totalStart)

        expect(alphaCard).toContain("Junior")
        expect(alphaCard).toContain("Model: opencode-go/deepseek-v4.1-flash#high")
        expect(alphaCard).toContain("Peak context: 1.65K / 10K tokens (17%)")
        expect(alphaCard).toContain("Spent: $0.0123")
        expect(alphaCard).toMatch(/running/i)
        expect(alphaCard).not.toContain("Selected:")
        expect(alphaCard).not.toContain("Beta task")
        expect(alphaCard).not.toContain("claude-5-opus")
        expect(alphaCard).not.toContain("Peak context: 5K")
        expect(alphaCard).not.toContain("$0.0020")
        expect(alphaCard).not.toMatch(/idle/i)

        expect(betaCard).toContain("Junior")
        expect(betaCard).toContain("Model: anthropic/claude-5-opus#high")
        expect(betaCard).toContain("Selected: opencode-go/deepseek-v4.1-flash#high")
        expect(betaCard).toContain("Peak context: 5K / 20K tokens (25%)")
        expect(betaCard).toContain("Spent: $0.0020")
        expect(betaCard).toMatch(/idle/i)
        expect(betaCard).not.toContain("Alpha task")
        expect(betaCard).not.toContain("1.65K")
        expect(betaCard).not.toContain("$0.0123")
        expect(betaCard).not.toMatch(/running/i)
        expect(sessions).toContain("Total reported spend: $0.0143")
        expect(sessions).not.toContain("Unrelated")

        const agentsTab = findCommand(
          fixture,
          (candidate) => candidate.bind === "a",
        )
        if (agentsTab === undefined) {
          throw new Error("Expected the focused panel to bind 'a' to the Agents tab")
        }
        await agentsTab.run()

        const restoredAggregate = await setup.waitForFrame(
          (candidate) =>
            candidate.includes("Total reported spend: $0.0143")
            && !candidate.includes("Alpha task")
            && !candidate.includes("Beta task"),
          { maxPasses: 40 },
        )
        expect(restoredAggregate.split("● Junior").length - 1).toBe(1)
        expect(restoredAggregate).toContain("2 sessions")
        expect(restoredAggregate).toContain("Spent: $0.0143")
      },
    )
  })
})

test("panel attributes a usage sample to its own model when the latest assistant has no tokens", async () => {
  const anthropic = { providerID: "anthropic", id: "claude-5-opus" }
  const switchedUsage = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const anthropicUsage = {
    input: 1500,
    output: 300,
    reasoning: 100,
    cache: { read: 100, write: 0 },
  }
  const { tokens: _omitted, ...anthropicNoTokens } = assistantMessage(
    "msg_switch_anthropic",
    ZERO_USAGE,
    anthropic,
    "Junior",
  )
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const switched = sessionInfo({
    id: "ses_switch_a",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0123,
    model: anthropic,
  })
  const current = sessionInfo({
    id: "ses_switch_b",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.002,
    model: anthropic,
  })
  const fixture = makeFixture({
    sessions: [root, switched, current],
    messages: {
      ses_switch_a: [
        assistantMessage("msg_switch_deepseek", switchedUsage, DEEPSEEK, "Junior"),
        anthropicNoTokens,
      ],
      ses_switch_b: [
        assistantMessage("msg_switch_anthropic_usage", anthropicUsage, anthropic, "Junior"),
      ],
    },
    models: [...DEFAULT_MODELS, modelInfo("anthropic", "claude-5-opus", 200000)],
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Model: anthropic/claude-5-opus"),
          { maxPasses: 40 },
        )
        expect(frame.split("● Junior").length - 1).toBe(1)
        expect(frame).toContain("2 sessions")

        const anthropicStart = frame.indexOf("Model: anthropic/claude-5-opus")
        const contextStart = frame.indexOf("Context model:")
        expect(anthropicStart).toBeGreaterThanOrEqual(0)
        expect(contextStart).toBeGreaterThan(anthropicStart)

        const anthropicGroup = frame.slice(anthropicStart, contextStart)
        expect(anthropicGroup).toMatch(/Peak context:\s*2K\s*\/\s*200K tokens\s*\(1%\)/)
        expect(anthropicGroup).not.toContain("5K")
        expect(anthropicGroup).not.toContain("50%")

        const contextGroup = frame.slice(
          contextStart,
          frame.indexOf("Total reported spend"),
        )
        expect(contextGroup).toContain("Context model: opencode-go/deepseek-v4.1-flash#high")
        expect(contextGroup).toMatch(/Peak context:\s*5K\s*\/\s*10K tokens\s*\(50%\)/)
        expect(contextGroup).not.toContain("session")

        expect(frame.split("Spent: $0.0143").length - 1).toBe(1)
        expect(frame.split("Total reported spend: $0.0243").length - 1).toBe(1)
      },
    )
  })
})

test("panel keeps distinct variant rows with per-variant peak context for a main and child session", async () => {
  const low = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "low" }
  const mainUsage = {
    input: 1000,
    output: 200,
    reasoning: 50,
    cache: { read: 300, write: 100 },
  }
  const childUsage = {
    input: 1500,
    output: 300,
    reasoning: 100,
    cache: { read: 100, write: 0 },
  }
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const child = sessionInfo({
    id: "ses_variant_low",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.002,
    model: low,
  })
  const fixture = makeFixture({
    sessions: [root, child],
    messages: {
      [ROOT_SESSION]: [assistantMessage("msg_variant_high", mainUsage, DEEPSEEK, "Junior")],
      ses_variant_low: [assistantMessage("msg_variant_low", childUsage, low, "Junior")],
    },
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Model: opencode-go/deepseek-v4.1-flash#low"),
          { maxPasses: 40 },
        )
        expect(frame.split("● Junior").length - 1).toBe(1)
        expect(frame).toContain("● Junior · main")
        expect(frame).toContain("2 sessions")
        expect(frame.split("Spent: $0.0143").length - 1).toBe(1)

        const highStart = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#high")
        const lowStart = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#low")
        expect(highStart).toBeGreaterThanOrEqual(0)
        expect(lowStart).toBeGreaterThan(highStart)

        const highGroup = frame.slice(highStart, lowStart)
        expect(highGroup).toMatch(/Peak context:\s*1\.65K\s*\/\s*10K tokens\s*\(17%\)/)
        expect(highGroup).toContain("1 session")
        expect(highGroup).not.toContain("2K")
        expect(highGroup).not.toContain("20%")

        const lowGroup = frame.slice(lowStart, frame.indexOf("Total reported spend"))
        expect(lowGroup).toMatch(/Peak context:\s*2K\s*\/\s*10K tokens\s*\(20%\)/)
        expect(lowGroup).toContain("1 session")
        expect(lowGroup).not.toContain("1.65K")
        expect(lowGroup).not.toContain("17%")
      },
    )
  })
})

test("panel groups descendants by agent with combined counts, single-count spend, and per-model peak context", async () => {
  const alternate = { providerID: "anthropic", id: "claude-5-opus", variant: "medium" }
  const peakUsage = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const nestedUsage = {
    input: 1500,
    output: 300,
    reasoning: 100,
    cache: { read: 100, write: 0 },
  }
  const root = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    title: "Root grouped task",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const alpha = sessionInfo({
    id: "ses_grouped_alpha",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Alpha grouped task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const beta = sessionInfo({
    id: "ses_grouped_beta",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Beta grouped task",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const nested = sessionInfo({
    id: "ses_grouped_nested",
    parentID: alpha.id,
    agent: "Junior",
    title: "Nested grouped task",
    cost: 0.003,
    model: alternate,
  })
  const fixture = makeFixture({
    sessions: [root, alpha, beta, nested, unrelatedSession],
    messages: {
      ses_grouped_alpha: [assistantMessage("msg_grouped_alpha", CHILD_USAGE, DEEPSEEK, "Junior")],
      ses_grouped_beta: [assistantMessage("msg_grouped_beta", peakUsage, DEEPSEEK, "Junior")],
      ses_grouped_nested: [
        assistantMessage("msg_grouped_nested", nestedUsage, alternate, "Junior"),
      ],
    },
    models: [...DEFAULT_MODELS, modelInfo("anthropic", "claude-5-opus", 200000)],
    statuses: { ses_grouped_alpha: "running", ses_grouped_beta: "running" },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        const headings = frame.split("● Junior").length - 1
        expect(headings).toBe(1)

        const groupStart = frame.indexOf("● Junior")
        const groupEnd = frame.indexOf("Total reported spend")
        expect(groupEnd).toBeGreaterThan(groupStart)
        const group = frame.slice(groupStart, groupEnd)
        expect(group).toContain("2 running")
        expect(group).toContain("3 sessions")
        expect(group).toMatch(/Spent:\s*\$0\.0173/)
        expect(group).toContain("opencode-go/deepseek-v4.1-flash#high")
        expect(group).toContain("anthropic/claude-5-opus#medium")
        expect(group).toMatch(/Peak context:\s*5K\s*\/\s*10K tokens\s*\(50%\)/)
        expect(group).not.toContain("6.65K")
        expect(frame).toContain("Total reported spend: $0.0273")

        const spent = group.indexOf("Spent: $0.0173")
        const secondModel = group.indexOf("anthropic/claude-5-opus#medium")
        const lastContext = group.lastIndexOf("Peak context:")
        expect(spent).toBeGreaterThan(secondModel)
        expect(spent).toBeGreaterThan(lastContext)

        expect(frame).not.toContain("Root grouped task")
        expect(frame).not.toContain("Alpha grouped task")
        expect(frame).not.toContain("Beta grouped task")
        expect(frame).not.toContain("Nested grouped task")
        expect(frame).not.toContain("↳")
        expect(frame).not.toContain("ses_")
        expect(frame).not.toContain("Unrelated")

        fixture.setStatus("ses_grouped_nested", "running")
        await setup.renderOnce()
        const updated = setup.captureCharFrame()
        expect(updated).toContain("3 running · 3 sessions")
        expect(updated.split("● Junior").length - 1).toBe(1)
      },
    )
  })
})

const capturedForegrounds = (
  frame: CapturedFrame,
  text: string,
): ReadonlyArray<readonly [number, number, number, number]> =>
  frame.lines.flatMap(
    (line) =>
      line.spans
        .filter((span) => span.text.includes(text))
        .map((span) => span.fg.toInts()),
  )

test("panel repaints card text when the theme changes without a data refresh", async () => {
  const fixture = makeFixture()
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Junior"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Spent: $0.0123")
        expect(frame).not.toContain(COMMAND_TITLE)

        const before = setup.captureSpans()
        expect(capturedForegrounds(before, "Agents")).toEqual([
          THEME_A.text.action.primary.base.toInts(),
        ])
        expect(capturedForegrounds(before, "Sessions")).toEqual([THEME_A.text.muted.toInts()])
        expect(capturedForegrounds(before, "Junior")).toEqual([THEME_A.text.base.toInts()])
        expect(capturedForegrounds(before, "Spent: $0.0123")).toEqual([THEME_A.text.muted.toInts()])

        fixture.failWith("refresh blocked")
        fixture.setTheme(THEME_B)
        await setup.renderOnce()
        const after = setup.captureSpans()
        const afterFrame = setup.captureCharFrame()

        expect(afterFrame).toContain("Junior")
        expect(afterFrame).toContain("Model: opencode-go/deepseek-v4.1-flash#high")
        expect(afterFrame).toContain("Spent: $0.0123")
        expect(afterFrame).toContain("Total reported spend: $0.0123")
        expect(afterFrame).toContain("▸ Agents")
        expect(afterFrame).toContain("Sessions")
        expect(afterFrame).not.toContain(COMMAND_TITLE)
        expect(afterFrame).not.toContain("Refresh failed")

        expect(capturedForegrounds(after, "Agents")).toEqual([
          THEME_B.text.action.primary.base.toInts(),
        ])
        expect(capturedForegrounds(after, "Sessions")).toEqual([THEME_B.text.muted.toInts()])
        expect(capturedForegrounds(after, "Junior")).toEqual([THEME_B.text.base.toInts()])
        expect(
          capturedForegrounds(after, "Model: opencode-go/deepseek-v4.1-flash#high"),
        ).toEqual([THEME_B.text.base.toInts()])
        expect(capturedForegrounds(after, "Spent: $0.0123")).toEqual([THEME_B.text.muted.toInts()])
      },
    )
  })
})

test("panel groups canonical-equivalent model references into one row without a Selected line", async () => {
  const hashRef = { providerID: "acme", id: "model#high" }
  const variantRef = { providerID: "acme", id: "model", variant: "high" }
  const plainRef = { providerID: "acme", id: "model" }
  const emptyVariantRef = { providerID: "acme", id: "model", variant: "" }
  const hashSession = sessionInfo({
    id: "ses_canon_hash",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0100,
    model: hashRef,
  })
  const variantSession = sessionInfo({
    id: "ses_canon_variant",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0020,
    model: variantRef,
  })
  const plainSession = sessionInfo({
    id: "ses_canon_plain",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0004,
    model: plainRef,
  })
  const emptyVariantSession = sessionInfo({
    id: "ses_canon_empty",
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0006,
    model: emptyVariantRef,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), hashSession, variantSession, plainSession, emptyVariantSession],
    messages: {
      ses_canon_hash: [assistantMessage("msg_canon_hash", CHILD_USAGE, hashRef, "Junior")],
      ses_canon_variant: [
        assistantMessage("msg_canon_variant", CHILD_USAGE, variantRef, "Junior"),
      ],
      ses_canon_plain: [assistantMessage("msg_canon_plain", CHILD_USAGE, plainRef, "Junior")],
      ses_canon_empty: [
        assistantMessage("msg_canon_empty", CHILD_USAGE, emptyVariantRef, "Junior"),
      ],
    },
    models: [],
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("acme/model#high"),
          { maxPasses: 20 },
        )
        const lines: readonly string[] = frame.split("\n").map((line) =>
          line.replace(/[│█]/g, " ").trim()
        )
        expect(frame.split("● Junior").length - 1).toBe(1)
        expect(frame).toContain("0 running · 4 sessions")
        expect(lines.filter((line) => line === "Model: acme/model#high").length)
          .toBe(1)
        expect(lines.filter((line) => line === "Model: acme/model").length).toBe(1)
        expect(lines.filter((line) => line === "2 sessions").length).toBe(2)
        expect(frame).not.toContain("Selected:")
        expect(frame).toContain("Spent: $0.0130")
        expect(frame).toContain("Total reported spend: $0.0130")
      },
    )
  })
})

test("panel stops at the latest eligible assistant and does not fall back to older usage", async () => {
  const olderUsage = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const history: SessionMessageInfo[] = [
    assistantMessage("msg_older_usage", olderUsage, DEEPSEEK, "Junior"),
  ]
  for (let index = 0; index < 150; index++) {
    history.push(userMessage(`msg_noise_${String(index).padStart(3, "0")}`, `noise ${index}`))
  }
  history.push(assistantMessage("msg_latest_zero", ZERO_USAGE, DEEPSEEK, "Junior"))
  const child = sessionInfo({
    id: CHILD_SESSION,
    parentID: ROOT_SESSION,
    agent: "Junior",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: { [CHILD_SESSION]: history },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Model: opencode-go/deepseek-v4.1-flash#high"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Peak context: unknown")
        expect(frame).not.toContain("Peak context: 5K")
        expect(frame).toContain("Spent: $0.0123")
        const messageCalls: readonly ApiCall[] = fixture.calls.filter(
          (call) => call.method === "message.list",
        )
        expect(messageCalls.length).toBe(2)
      },
    )
  })
})

test(
  "Sessions cards isolate failures, fall back to IDs, and keep live status through refresh errors",
  async () => {
    const actual = { providerID: "anthropic", id: "claude-5-opus", variant: "high" }
    const usage = {
      input: 4000,
      output: 500,
      reasoning: 100,
      cache: { read: 300, write: 100 },
    }
    const titleless = sessionInfo({
      id: "ses_child_a",
      parentID: ROOT_SESSION,
      agent: "Junior",
      cost: 0.0123,
      model: DEEPSEEK,
    })
    const unavailable: SessionInfo = {
      ...sessionInfo({
        id: "ses_child_b",
        parentID: ROOT_SESSION,
        agent: "Reviewer",
        title: "Beta task",
        cost: 0.002,
        model: DEEPSEEK,
      }),
      outcome: "succeeded",
    }
    const fixture = makeFixture({
      sessions: [rootSession(), titleless, unavailable],
      messages: {
        ses_child_a: [assistantMessage("msg_titleless", usage, actual, "Junior")],
      },
      messageFailures: { ses_child_b: "message history unavailable" },
      models: [
        modelInfo("opencode-go", "deepseek-v4.1-flash", 10000),
        modelInfo("anthropic", "claude-5-opus", 20000),
      ],
      statuses: { ses_child_a: "running", ses_child_b: "idle" },
    })

    await withPlugin(fixture, async (render) => {
      await withPanel(
        render,
        makePanelInput(PANEL_NAME),
        { width: 120, height: 65 },
        async (setup) => {
          const sessionsTab = findCommand(
            fixture,
            (candidate) => candidate.bind === "s",
          )
          if (sessionsTab === undefined) {
            throw new Error("Expected the focused panel to bind 's' to the Sessions tab")
          }
          await sessionsTab.run()

          const sessions = await setup.waitForFrame(
            (candidate) => candidate.includes("● ses_child_a") && candidate.includes("Beta task"),
            { maxPasses: 40 },
          )
          const titlelessStart = sessions.indexOf("● ses_child_a")
          const unavailableStart = sessions.indexOf("Beta task")
          const totalStart = sessions.indexOf("Total reported spend")
          expect(titlelessStart).toBeGreaterThanOrEqual(0)
          expect(unavailableStart).toBeGreaterThan(titlelessStart)
          expect(totalStart).toBeGreaterThan(unavailableStart)
          const titlelessCard = sessions.slice(titlelessStart, unavailableStart)
          const unavailableCard = sessions.slice(unavailableStart, totalStart)

          expect(titlelessCard).toContain("Junior · ses_child_a")
          expect(titlelessCard).toContain("Model: anthropic/claude-5-opus#high")
          expect(titlelessCard).toContain("Selected: opencode-go/deepseek-v4.1-flash#high")
          expect(titlelessCard).toContain("Peak context: 5K / 20K tokens (25%)")
          expect(titlelessCard).toContain("Spent: $0.0123")
          expect(titlelessCard).toContain("Status: running")
          expect(titlelessCard).not.toContain("Beta task")
          expect(titlelessCard).not.toContain("Context data unavailable")

          expect(unavailableCard).toContain("Reviewer · ses_child_b")
          expect(unavailableCard).toContain("Model: unknown")
          expect(unavailableCard).toContain("Selected: opencode-go/deepseek-v4.1-flash#high")
          expect(unavailableCard).toContain("Context data unavailable")
          expect(unavailableCard).toContain("Spent: $0.0020")
          expect(unavailableCard).toContain("Status: succeeded")
          expect(unavailableCard).not.toContain("claude-5-opus")
          expect(unavailableCard).not.toContain("5K")
          expect(unavailableCard).not.toContain("$0.0123")
          expect(unavailableCard).not.toContain("Status: running")
          expect(sessions).toContain("Total reported spend: $0.0143")

          fixture.setStatus("ses_child_a", "idle")
          await setup.renderOnce()
          const updated = setup.captureCharFrame()
          expect(updated).toContain("● ses_child_a")
          expect(updated).toContain("Beta task")
          expect(updated).not.toContain("● Junior")
          expect(updated).toContain("Status: idle")
          expect(updated).toContain("Status: succeeded")
          expect(updated).not.toContain("Status: running")

          fixture.failWith("refresh exploded")
          await Bun.sleep(2200)
          const failedRefresh = await setup.waitForFrame(
            (candidate) => candidate.includes("Refresh failed"),
            { maxPasses: 40 },
          )
          expect(failedRefresh).toContain("Refresh failed (values may be stale): refresh exploded")
          expect(failedRefresh).toContain("● ses_child_a")
          expect(failedRefresh).toContain("Beta task")
          expect(failedRefresh).not.toContain("● Junior")
          expect(failedRefresh).toContain("Peak context: 5K / 20K tokens (25%)")
          expect(failedRefresh).toContain("Spent: $0.0123")
          expect(failedRefresh).toContain("Status: idle")
          expect(failedRefresh).toContain("Status: succeeded")
          expect(failedRefresh).toContain("Total reported spend: $0.0143")
        },
      )
    })
  },
  15000,
)

test("focused panel switches tabs with wrapping left and right arrows", async () => {
  const child = sessionInfo({
    id: "ses_child_arrow",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Arrow navigation task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: {
      ses_child_arrow: [assistantMessage("msg_arrow", CHILD_USAGE, DEEPSEEK, "Junior")],
    },
    models: DEFAULT_MODELS,
    statuses: { ses_child_arrow: "running" },
  })

  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const initial = await setup.waitForFrame(
          (candidate) =>
            candidate.includes("Total reported spend: $0.0123")
            && candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        expect(initial.split("● Junior").length - 1).toBe(1)
        expect(initial).not.toContain("Arrow navigation task")
        expect(initial).toContain("Total reported spend: $0.0123")

        const right = findCommand(
          fixture,
          (candidate) => candidate.bind === "right",
        )
        if (right === undefined) {
          throw new Error("Expected the focused panel to bind 'right' to the next tab")
        }
        const left = findCommand(
          fixture,
          (candidate) => candidate.bind === "left",
        )
        if (left === undefined) {
          throw new Error("Expected the focused panel to bind 'left' to the previous tab")
        }
        const focusedArrowLayer = fixture.layers.find(
          (layer) =>
            (layer.commands ?? []).includes(left) && (layer.commands ?? []).includes(right),
        )
        if (focusedArrowLayer === undefined) {
          throw new Error("Expected both arrow commands in the focused panel's keymap layer")
        }
        expect(focusedArrowLayer.enabled).toBe(true)

        await right.run()
        const sessionsFromRight = await setup.waitForFrame(
          (candidate) => candidate.includes("Arrow navigation task"),
          { maxPasses: 40 },
        )
        expect(sessionsFromRight).toContain("● Arrow navigation task")
        expect(sessionsFromRight).toContain("Junior · ses_child_arrow")
        expect(sessionsFromRight).not.toContain("● Junior")
        expect(sessionsFromRight).toContain("Total reported spend: $0.0123")

        await right.run()
        const agentsFromRight = await setup.waitForFrame(
          (candidate) =>
            candidate.includes("● Junior") && !candidate.includes("Arrow navigation task"),
          { maxPasses: 40 },
        )
        expect(agentsFromRight.split("● Junior").length - 1).toBe(1)
        expect(agentsFromRight).toContain("Total reported spend: $0.0123")

        await left.run()
        const sessionsFromLeft = await setup.waitForFrame(
          (candidate) => candidate.includes("Arrow navigation task"),
          { maxPasses: 40 },
        )
        expect(sessionsFromLeft).toContain("● Arrow navigation task")
        expect(sessionsFromLeft).not.toContain("● Junior")
        expect(sessionsFromLeft).toContain("Total reported spend: $0.0123")

        await left.run()
        const agentsFromLeft = await setup.waitForFrame(
          (candidate) =>
            candidate.includes("● Junior") && !candidate.includes("Arrow navigation task"),
          { maxPasses: 40 },
        )
        expect(agentsFromLeft.split("● Junior").length - 1).toBe(1)
        expect(agentsFromLeft).toContain("Total reported spend: $0.0123")
      },
    )
  })

  const unfocusedFixture = makeFixture({
    sessions: [rootSession(), child],
    messages: {
      ses_child_arrow: [assistantMessage("msg_arrow", CHILD_USAGE, DEEPSEEK, "Junior")],
    },
    models: DEFAULT_MODELS,
    statuses: { ses_child_arrow: "running" },
  })
  await withPlugin(unfocusedFixture, async (render) => {
    const input = { ...makePanelInput(PANEL_NAME), focused: false }
    await withPanel(
      render,
      input,
      { width: 120, height: 40 },
      async (setup) => {
        await setup.waitForFrame(
          (candidate) => candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        const right = findCommand(
          unfocusedFixture,
          (candidate) => candidate.bind === "right",
        )
        if (right === undefined) {
          throw new Error("Expected the unfocused panel to register the 'right' command")
        }
        const left = findCommand(
          unfocusedFixture,
          (candidate) => candidate.bind === "left",
        )
        if (left === undefined) {
          throw new Error("Expected the unfocused panel to register the 'left' command")
        }
        const unfocusedArrowLayer = unfocusedFixture.layers.find(
          (layer) =>
            (layer.commands ?? []).includes(left) && (layer.commands ?? []).includes(right),
        )
        if (unfocusedArrowLayer === undefined) {
          throw new Error("Expected both arrow commands in the unfocused panel's keymap layer")
        }
        expect(unfocusedArrowLayer.enabled).toBe(false)
      },
    )
  })
})

test("mouse clicks switch tab pills and refocus the panel", async () => {
  const child = sessionInfo({
    id: "ses_child_click",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Click navigation task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: {
      ses_child_click: [assistantMessage("msg_click", CHILD_USAGE, DEEPSEEK, "Junior")],
    },
    models: DEFAULT_MODELS,
    statuses: { ses_child_click: "running" },
  })
  let focusCalls = 0
  const input = {
    ...makePanelInput(PANEL_NAME),
    focus: () => {
      focusCalls += 1
    },
  }

  const tabForegrounds = (
    frame: CapturedFrame,
    label: string,
  ) => capturedForegrounds(frame, label)
  const hasColor = (
    colors: ReadonlyArray<readonly [number, number, number, number]>,
    expected: readonly [number, number, number, number],
  ) => colors.some((color) => color.every((channel, index) => channel === expected[index]))
  const tabRow = (frame: string): { readonly line: string; readonly y: number } => {
    const lines: readonly string[] = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("Agents") && line.includes("Sessions"))
    if (y < 0) throw new Error("Expected both tab pill labels in one rendered row")
    return { line: lines[y] ?? "", y }
  }
  const verifyChrome = (frame: string) => {
    expect(chromeProblems(frame, "mouse panel")).toEqual([])
  }
  const clickTab = async (
    setup: TestRendererSetup,
    label: "Agents" | "Sessions",
  ) => {
    const frame = setup.captureCharFrame()
    const tabs = tabRow(frame)
    const column = tabs.line.indexOf(label)
    if (column < 0) throw new Error(`Expected the ${label} tab pill to be visible`)
    await setup.mockMouse.click(column + Math.floor(label.length / 2), tabs.y)
    await setup.renderOnce()
    return setup.captureCharFrame()
  }

  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      input,
      { width: 120, height: 40 },
      async (setup) => {
        const initial = await setup.waitForFrame(
          (candidate) => candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        expect(initial).not.toContain("Click navigation task")
        expect(initial).toContain("Total reported spend: $0.0123")

        const initialStyles = setup.captureSpans()
        expect(
          hasColor(tabForegrounds(initialStyles, "Sessions"), THEME_A.text.muted.toInts()),
        ).toBe(true)
        fixture.setTheme(THEME_B)
        await setup.renderOnce()
        const themedAgents = setup.captureSpans()
        expect(
          hasColor(
            tabForegrounds(themedAgents, "Agents"),
            THEME_B.text.action.primary.base.toInts(),
          ),
        ).toBe(true)
        expect(
          hasColor(tabForegrounds(themedAgents, "Sessions"), THEME_B.text.muted.toInts()),
        ).toBe(true)

        const sessions = await clickTab(setup, "Sessions")
        const sessionsFrame = await setup.waitForFrame(
          (candidate) => candidate.includes("Click navigation task"),
          { maxPasses: 40 },
        )
        expect(sessionsFrame).toContain("● Click navigation task")
        expect(sessionsFrame).toContain("Junior · ses_child_click")
        expect(sessionsFrame).not.toContain("● Junior")
        expect(sessionsFrame).toContain("Total reported spend: $0.0123")
        expect(focusCalls).toBe(1)
        expect(
          hasColor(
            tabForegrounds(setup.captureSpans(), "Sessions"),
            THEME_B.text.action.primary.base.toInts(),
          ),
        ).toBe(true)
        expect(
          hasColor(tabForegrounds(setup.captureSpans(), "Agents"), THEME_B.text.muted.toInts()),
        ).toBe(true)
        expect(sessions).toContain("Click navigation task")

        const agents = await clickTab(setup, "Agents")
        const agentsFrame = await setup.waitForFrame(
          (candidate) =>
            candidate.includes("● Junior") && !candidate.includes("Click navigation task"),
          { maxPasses: 40 },
        )
        expect(agentsFrame.split("● Junior").length - 1).toBe(1)
        expect(agentsFrame).toContain("Total reported spend: $0.0123")
        expect(focusCalls).toBe(2)
        expect(agents).not.toContain("Click navigation task")
      },
    )

    const viewports: readonly {
      readonly name: string
      readonly width: number
      readonly height: number
    }[] = [
      { name: "42x22", width: 42, height: 22 },
      { name: "76x12", width: 76, height: 12 },
    ]
    for (const viewport of viewports) {
      await withPanel(
        render,
        input,
        { width: viewport.width, height: viewport.height },
        async (setup) => {
          const smallAgents = await setup.waitForFrame(
            (candidate) => candidate.includes("Total reported spend: $0.0123"),
            { maxPasses: 40 },
          )
          verifyChrome(smallAgents)
          expect(
            hasColor(
              tabForegrounds(setup.captureSpans(), "Agents"),
              THEME_B.text.action.primary.base.toInts(),
            ),
          ).toBe(true)

          const smallSessions = await clickTab(setup, "Sessions")
          verifyChrome(smallSessions)
          expect(
            hasColor(
              tabForegrounds(setup.captureSpans(), "Sessions"),
              THEME_B.text.action.primary.base.toInts(),
            ),
          ).toBe(true)
          expect(focusCalls).toBe(viewport.name === "42x22" ? 3 : 5)

          const smallAgentsRestored = await clickTab(setup, "Agents")
          verifyChrome(smallAgentsRestored)
          expect(
            hasColor(
              tabForegrounds(setup.captureSpans(), "Agents"),
              THEME_B.text.action.primary.base.toInts(),
            ),
          ).toBe(true)
          expect(focusCalls).toBe(viewport.name === "42x22" ? 4 : 6)
        },
      )
    }
  })
})

/** Asserts the token line uses plain text symbols, never emoji sequences. */
const expectPlainTokenSymbols = (frame: string): void => {
  expect(frame).toContain("↑")
  expect(frame).toContain("↓")
  expect(frame).toContain("↺")
  expect(frame).not.toContain("\uFE0F")
  expect(frame).not.toContain("⬆")
  expect(frame).not.toContain("⬇")
  expect(frame).not.toContain("♻")
}

test("panel aggregates cumulative tokens per agent card and places spend below the model lines", async () => {
  const alphaTokens = {
    input: 1000,
    output: 200,
    reasoning: 50,
    cache: { read: 300, write: 100 },
  }
  const betaTokens = {
    input: 4000,
    output: 500,
    reasoning: 100,
    cache: { read: 300, write: 100 },
  }
  const alpha = sessionInfo({
    id: "ses_tokens_a",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Alpha task",
    cost: 0.0123,
    model: DEEPSEEK,
    tokens: alphaTokens,
  })
  const beta = sessionInfo({
    id: "ses_tokens_b",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Beta task",
    cost: 0.002,
    model: DEEPSEEK,
    tokens: betaTokens,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), alpha, beta],
    messages: {
      ses_tokens_a: [assistantMessage("msg_tokens_a", CHILD_USAGE, DEEPSEEK, "Junior")],
      ses_tokens_b: [
        assistantMessage(
          "msg_tokens_b",
          { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          DEEPSEEK,
          "Junior",
        ),
      ],
    },
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        expect(frame).toContain("2 sessions")
        expect(frame).toContain("Peak context: 1.65K / 10K tokens (17%)")
        expect(frame).not.toContain("1.77K")

        const lines: readonly string[] = trimmedLines(frame)
        const title = lines.find((line) => line.startsWith("● Junior"))
        expect(title).toBe("● Junior")
        expect(
          lines.filter((line) => line === "Spent: $0.0143 · ↑ 5K · ↓ 700 · ↺ 600")
            .length,
        ).toBe(1)
        expect(frame).toContain("Total reported spend: $0.0143")
        expect(lines).toContain("Tokens: ↑ 5K · ↓ 700 · ↺ 600")
        expectPlainTokenSymbols(frame)

        const status = frame.indexOf("0 running · 2 sessions")
        const model = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#high")
        const context = frame.indexOf("Peak context: 1.65K / 10K tokens (17%)")
        const spent = frame.indexOf("Spent: $0.0143")
        expect(status).toBeGreaterThanOrEqual(0)
        expect(model).toBeGreaterThan(status)
        expect(context).toBeGreaterThan(model)
        expect(spent).toBeGreaterThan(context)
      },
    )
  })
})

test("Sessions cards show each session's own cumulative tokens while the agent card sums them", async () => {
  const alphaTokens = {
    input: 1000,
    output: 200,
    reasoning: 50,
    cache: { read: 300, write: 100 },
  }
  const betaTokens = {
    input: 4000,
    output: 500,
    reasoning: 100,
    cache: { read: 300, write: 100 },
  }
  const alpha = sessionInfo({
    id: "ses_tokens_a",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Alpha task",
    cost: 0.0123,
    model: DEEPSEEK,
    tokens: alphaTokens,
  })
  const beta = sessionInfo({
    id: "ses_tokens_b",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Beta task",
    cost: 0.002,
    model: DEEPSEEK,
    tokens: betaTokens,
  })
  const fixture = makeFixture({
    sessions: [rootSession(), alpha, beta],
    messages: {},
    models: DEFAULT_MODELS,
    statuses: { ses_tokens_a: "running", ses_tokens_b: "idle" },
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const sessionsTab = findCommand(
          fixture,
          (candidate) => candidate.bind === "s",
        )
        if (sessionsTab === undefined) {
          throw new Error("Expected the focused panel to bind 's' to the Sessions tab")
        }
        await sessionsTab.run()
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("Alpha task") && candidate.includes("Beta task"),
          { maxPasses: 40 },
        )
        const alphaStart = frame.indexOf("● Alpha task")
        const betaStart = frame.indexOf("● Beta task")
        const totalStart = frame.indexOf("Total reported spend")
        expect(alphaStart).toBeGreaterThanOrEqual(0)
        expect(betaStart).toBeGreaterThan(alphaStart)
        expect(totalStart).toBeGreaterThan(betaStart)
        const alphaCard = frame.slice(alphaStart, betaStart)
        const betaCard = frame.slice(betaStart, totalStart)

        const alphaStatus = alphaCard.indexOf("Status: running")
        const alphaModel = alphaCard.indexOf("Model: opencode-go/deepseek-v4.1-flash#high")
        const alphaContext = alphaCard.indexOf("Peak context: unknown")
        const alphaSpent = alphaCard.indexOf(
          "Spent: $0.0123 · ↑ 1K · ↓ 200 · ↺ 300",
        )
        expect(alphaStatus).toBeGreaterThanOrEqual(0)
        expect(alphaModel).toBeGreaterThan(alphaStatus)
        expect(alphaContext).toBeGreaterThan(alphaModel)
        expect(alphaSpent).toBeGreaterThan(alphaContext)
        expect(alphaCard).not.toContain("↑ 5K")

        expect(betaCard).toContain("Status: idle")
        expect(betaCard).toContain("Spent: $0.0020 · ↑ 4K · ↓ 500 · ↺ 300")

        const agentsTab = findCommand(
          fixture,
          (candidate) => candidate.bind === "a",
        )
        if (agentsTab === undefined) {
          throw new Error("Expected the focused panel to bind 'a' to the Agents tab")
        }
        await agentsTab.run()
        const aggregate = await setup.waitForFrame(
          (candidate) => candidate.includes("Spent: $0.0143 · ↑ 5K · ↓ 700 · ↺ 600"),
          { maxPasses: 40 },
        )
        expect(trimmedLines(aggregate)).toContain("Tokens: ↑ 5K · ↓ 700 · ↺ 600")
        expect(aggregate).not.toContain("Alpha task")
        expect(aggregate).not.toContain("Beta task")
      },
    )
  })
})

test("panel totals tokens across agents in the global footer", async () => {
  const explorer = sessionInfo({
    id: "ses_global_explorer",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Global explorer task",
    cost: 0.0123,
    model: DEEPSEEK,
    tokens: { input: 1000, output: 200, reasoning: 25, cache: { read: 300, write: 50 } },
  })
  const reviewer = sessionInfo({
    id: "ses_global_reviewer",
    parentID: ROOT_SESSION,
    agent: "Reviewer",
    title: "Global reviewer task",
    cost: 0.002,
    model: DEEPSEEK,
    tokens: { input: 1000, output: 3000, reasoning: 10, cache: { read: 700, write: 0 } },
  })
  const fixture = makeFixture({
    sessions: [rootSession(), explorer, reviewer],
    messages: {},
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("● Reviewer"),
          { maxPasses: 40 },
        )
        const lines: readonly string[] = trimmedLines(frame)
        expect(lines).toContain("Spent: $0.0123 · ↑ 1K · ↓ 200 · ↺ 300")
        expect(lines).toContain("Spent: $0.0020 · ↑ 1K · ↓ 3K · ↺ 700")
        expect(lines).toContain("Tokens: ↑ 2K · ↓ 3.2K · ↺ 1K")
        expect(frame).toContain("Total reported spend: $0.0143")
        const spend = frame.indexOf("Total reported spend: $0.0143")
        const tokens = frame.indexOf("Tokens: ↑ 2K · ↓ 3.2K · ↺ 1K")
        expect(tokens).toBeGreaterThan(spend)
      },
    )
  })
})

test("panel reports a reported zero token count as known usage", async () => {
  const zero = sessionInfo({
    id: "ses_zero_tokens",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Zero token task",
    cost: 0.002,
    model: DEEPSEEK,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const fixture = makeFixture({
    sessions: [rootSession(), zero],
    messages: {},
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        const lines: readonly string[] = trimmedLines(frame)
        expect(lines).toContain("Spent: $0.0020 · ↑ 0 · ↓ 0 · ↺ 0")
        expect(lines).toContain("Tokens: ↑ 0 · ↓ 0 · ↺ 0")
        expect(frame).not.toContain("tokens unavailable")
        expect(frame).not.toContain("Tokens: unavailable")
        expectPlainTokenSymbols(frame)
      },
    )
  })
})

test("panel marks tokens unavailable instead of inventing zero when a session omits them", async () => {
  const known = sessionInfo({
    id: "ses_known_tokens",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Known token task",
    cost: 0.0123,
    model: DEEPSEEK,
    tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 300, write: 0 } },
  })
  const { tokens: _absent, ...tokenlessShape } = sessionInfo({
    id: "ses_tokenless",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Tokenless task",
    cost: 0.003,
    model: DEEPSEEK,
  })
  const tokenless = tokenlessShape as SessionInfo
  const fixture = makeFixture({
    sessions: [rootSession(), known, tokenless],
    messages: {},
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const agents = await setup.waitForFrame(
          (candidate) => candidate.includes("● Junior"),
          { maxPasses: 40 },
        )
        const agentLines: readonly string[] = trimmedLines(agents)
        expect(agentLines).toContain("Spent: $0.0153 · tokens unavailable")
        expect(agentLines).toContain("Spent: $0.0000 · ↑ 0 · ↓ 0 · ↺ 0")
        expect(agentLines).toContain("Tokens: unavailable")
        expect(agents).not.toContain("Tokens: ↑")

        const sessionsTab = findCommand(
          fixture,
          (candidate) => candidate.bind === "s",
        )
        if (sessionsTab === undefined) {
          throw new Error("Expected the focused panel to bind 's' to the Sessions tab")
        }
        await sessionsTab.run()
        const sessions = await setup.waitForFrame(
          (candidate) =>
            candidate.includes("Known token task") && candidate.includes("Tokenless task"),
          { maxPasses: 40 },
        )
        const sessionsLines: readonly string[] = trimmedLines(sessions)
        expect(sessionsLines).toContain("Spent: $0.0123 · ↑ 1K · ↓ 200 · ↺ 300")
        expect(sessionsLines).toContain("Spent: $0.0030 · tokens unavailable")
        expect(sessionsLines).toContain("Tokens: unavailable")
      },
    )
  })
})

test(
  "panel re-reads cumulative tokens on refresh without double-counting",
  async () => {
    const initial = sessionInfo({
      id: "ses_tokens_refresh",
      parentID: ROOT_SESSION,
      agent: "Junior",
      title: "Refresh task",
      cost: 0.0123,
      model: DEEPSEEK,
      tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 100, write: 0 } },
    })
    const refreshed = sessionInfo({
      id: "ses_tokens_refresh",
      parentID: ROOT_SESSION,
      agent: "Junior",
      title: "Refresh task",
      cost: 0.02,
      model: DEEPSEEK,
      tokens: { input: 3000, output: 500, reasoning: 0, cache: { read: 300, write: 0 } },
    })
    const fixture = makeFixture({
      sessions: [rootSession(), initial],
      messages: {},
      models: DEFAULT_MODELS,
    })
    await withPlugin(fixture, async (render) => {
      await withPanel(
        render,
        makePanelInput(PANEL_NAME),
        { width: 120, height: 40 },
        async (setup) => {
          const before = await setup.waitForFrame(
            (candidate) => candidate.includes("Spent: $0.0123 · ↑ 1K · ↓ 200 · ↺ 100"),
            { maxPasses: 40 },
          )
          expect(trimmedLines(before)).toContain("Tokens: ↑ 1K · ↓ 200 · ↺ 100")

          fixture.setSessions([rootSession(), refreshed])
          await Bun.sleep(2200)
          const after = await setup.waitForFrame(
            (candidate) => candidate.includes("Spent: $0.0200 · ↑ 3K · ↓ 500 · ↺ 300"),
            { maxPasses: 40 },
          )
          const lines: readonly string[] = trimmedLines(after)
          expect(lines).toContain("Tokens: ↑ 3K · ↓ 500 · ↺ 300")
          expect(after).not.toContain("↑ 4K")
          expect(after).not.toContain("↓ 700")
          expect(after).not.toContain("↺ 400")
          setup.renderer.destroy()
        },
      )
    })
  },
  15000,
)

test("panel formats cumulative token counts compactly at rounding thresholds", async () => {
  const large = sessionInfo({
    id: "ses_tokens_large",
    parentID: ROOT_SESSION,
    agent: "Junior",
    title: "Large totals",
    cost: 0.0123,
    model: DEEPSEEK,
    tokens: {
      input: 1234567,
      output: 12345,
      reasoning: 7654,
      cache: { read: 1500000, write: 7654321 },
    },
  })
  const small = sessionInfo({
    id: "ses_tokens_small",
    parentID: ROOT_SESSION,
    agent: "Reviewer",
    title: "Small totals",
    cost: 0.001,
    model: DEEPSEEK,
    tokens: { input: 999, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const fixture = makeFixture({
    sessions: [rootSession(), large, small],
    messages: {},
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render) => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup) => {
        const frame = await setup.waitForFrame(
          (candidate) => candidate.includes("● Reviewer"),
          { maxPasses: 40 },
        )
        const lines: readonly string[] = trimmedLines(frame)
        expect(lines).toContain("Spent: $0.0123 · ↑ 1.23M · ↓ 12.35K · ↺ 1.5M")
        expect(lines).toContain("Spent: $0.0010 · ↑ 999 · ↓ 1K · ↺ 0")
        expect(lines).toContain("Tokens: ↑ 1.24M · ↓ 13.35K · ↺ 1.5M")
        expect(frame).not.toContain("7.65M")
        expect(frame).not.toContain("7.65K")
        expectPlainTokenSymbols(frame)
      },
    )
  })
})
