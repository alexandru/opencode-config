import type {
  MessageListInput,
  ModelInfo,
  ModelListInput,
  ModelListOutput,
  ModelRef,
  OpenCode as OpenCodeSdk,
  OpenCodeClient,
  SessionGetInput,
  SessionInfo,
  SessionListInput,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionRevert,
  SessionsResponse,
  TokenUsageInfo,
} from "@opencode/client"
import type {
  Context,
  Data,
  KeymapCommand,
  KeymapLayer,
  PanelInput,
  Route,
  SlotClaim,
} from "@opencode/plugin/tui/context"
import type { Cleanup, Definition } from "@opencode/plugin/tui/plugin"
import type { HueStep, ResolvedTheme, ThemeDefinition } from "@opencode/theme/tui"
import type { CapturedFrame, CapturedLine, CapturedSpan, Renderable } from "@opentui/core"
import type { TestRendererOptions, TestRendererSetup } from "@opentui/core/testing"
import type { JSX } from "@opentui/solid"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { expect, test } from "bun:test"
import { Effect, type Exit, Option, type Scope } from "effect"
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
}): SessionInfo => ({
  id: input.id,
  parentID: input.parentID,
  projectID: "prj_agents_status",
  agent: input.agent,
  model: input.model,
  title: input.title,
  revert: input.revert,
  cost: input.cost ?? 0,
  tokens: ZERO_USAGE,
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
  agent: "Explorer",
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
  "Explorer",
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
  const client: OpenCodeClient = OpenCode.make({ baseUrl: "http://127.0.0.1:1" })
  const sessions: SessionInfo[] = [...(options?.sessions ?? defaultSessions())]
  const messages: Record<string, readonly SessionMessageInfo[]> = {
    ...(options?.messages ?? { [CHILD_SESSION]: [explorerUsage] }),
  }
  const models: ModelInfo[] = [...(options?.models ?? DEFAULT_MODELS)]
  const modelsByDirectory: Readonly<Record<string, readonly ModelInfo[]>> = {
    ...(options?.modelsByDirectory ?? {}),
  }
  const catalogFailures: Record<string, string> = { ...(options?.catalogFailures ?? {}) }
  const messageFailures: Record<string, string> = { ...(options?.messageFailures ?? {}) }
  const pageSize: number = options?.pageSize ?? 200
  const calls: ApiCall[] = []
  let failure: string | undefined
  const [statuses, setStatuses] = createSignal<Readonly<Record<string, "idle" | "running">>>(
    options?.statuses ?? { [CHILD_SESSION]: "running" },
  )
  const [theme, setThemeState] = createSignal<ResolvedTheme>(THEME_A)

  const record = (method: string, request: { readonly signal?: AbortSignal } | undefined): void => {
    calls.push({ method, signal: request?.signal })
    if (failure !== undefined) throw new Error(failure)
  }

  client.session.get = async (
    input: SessionGetInput,
    request?: OpenCodeSdk.RequestOptions,
  ): Promise<SessionInfo> => {
    record("session.get", request)
    const found = sessions.find((session): boolean => session.id === input.sessionID)
    if (found === undefined) throw new Error(`Unexpected session.get for ${input.sessionID}`)
    return found
  }

  client.session.list = async (
    input?: SessionListInput,
    request?: OpenCodeSdk.RequestOptions,
  ): Promise<SessionsResponse> => {
    record("session.list", request)
    const parentID: string | null | undefined = input?.parentID
    const limit: number = Math.min(input?.limit ?? pageSize, pageSize)
    const offset: number = input?.cursor ? Number(input.cursor) : 0
    const children: SessionInfo[] = sessions
      .filter((session): boolean => session.parentID === parentID)
      .sort((left, right): number => left.id < right.id ? -1 : 1)
    const page: SessionInfo[] = children.slice(offset, offset + limit)
    const next: string | null = offset + limit < children.length ? String(offset + limit) : null
    return { data: page, cursor: { next } }
  }

  client.message.list = async (
    input: MessageListInput,
    request?: OpenCodeSdk.RequestOptions,
  ): Promise<SessionMessagesResponse> => {
    record("message.list", request)
    const messageFailure: string | undefined = messageFailures[input.sessionID]
    if (messageFailure !== undefined) throw new Error(messageFailure)
    const list: readonly SessionMessageInfo[] = messages[input.sessionID] ?? []
    const ordered: SessionMessageInfo[] = input.order === "desc" ? [...list].reverse() : [...list]
    const limit: number = input.limit ?? ordered.length
    const offset: number = input.cursor ? Number(input.cursor) : 0
    const page: SessionMessageInfo[] = ordered.slice(offset, offset + limit)
    const next: string | null = offset + limit < ordered.length ? String(offset + limit) : null
    return { data: page, cursor: { next } }
  }

  client.model.list = async (
    input?: ModelListInput,
    request?: OpenCodeSdk.RequestOptions,
  ): Promise<ModelListOutput> => {
    record("model.list", request)
    const directory: string = input?.location?.directory ?? DIRECTORY
    const catalogFailure: string | undefined = catalogFailures[directory]
    if (catalogFailure !== undefined) throw new Error(catalogFailure)
    return {
      location: { directory },
      data: [...modelsByDirectory[directory] ?? models],
    }
  }

  const layers: KeymapLayer[] = []
  const slots: Array<Option.Option<SlotClaim<"session.panel">>> = []
  const panelOpens: string[] = []
  const panelClose: { calls: number } = { calls: 0 }
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
      status: (sessionID: string): "idle" | "running" => statuses()[sessionID] ?? "idle",
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
      layer: (factory: () => KeymapLayer): void => {
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
        const value: Value = options.initial
        const update = async (mutation: (draft: Value) => void): Promise<void> => {
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
        current: (): Route => ({ type: "session", sessionID: ROOT_SESSION }),
        get register(): never {
          return unexpected("ui.router.register")
        },
        get navigate(): never {
          return unexpected("ui.router.navigate")
        },
      },
      panel: {
        open: (name: string): boolean => {
          panelOpens.push(name)
          currentPanel = { name, sessionID: ROOT_SESSION }
          return true
        },
        close: (): void => {
          panelClose.calls += 1
          currentPanel = undefined
        },
        current: (): { readonly name: string; readonly sessionID: string } | undefined =>
          currentPanel,
      },
      get tabs(): never {
        return unexpected("ui.tabs")
      },
      get model(): never {
        return unexpected("ui.model")
      },
      slot: (claim: SlotClaim): () => void => {
        slots.push(panelClaim(claim))
        return (): void => {}
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
    setSessions: (next: readonly SessionInfo[]): void => {
      sessions.splice(0, sessions.length, ...next)
    },
    setMessages: (sessionID: string, next: readonly SessionMessageInfo[]): void => {
      messages[sessionID] = next
    },
    setStatus: (sessionID: string, status: "idle" | "running"): void => {
      setStatuses((previous): Readonly<Record<string, "idle" | "running">> => ({
        ...previous,
        [sessionID]: status,
      }))
    },
    setTheme: (next: ResolvedTheme): void => {
      setThemeState(next)
    },
    failWith: (message: string): void => {
      failure = message
    },
  }
}

const findCommand = (
  fixture: Fixture,
  predicate: (command: KeymapCommand) => boolean,
): KeymapCommand | undefined =>
  fixture.layers
    .flatMap((layer: KeymapLayer): readonly KeymapCommand[] => layer.commands ?? [])
    .find(predicate)

const findPanelClaim = (fixture: Fixture): SlotClaim<"session.panel"> => {
  for (const claim of fixture.slots) {
    if (Option.isSome(claim)) return claim.value
  }
  throw new Error("Expected the plugin to claim the session.panel slot")
}

const makePanelInput = (name: string, close: () => void = (): void => {}): PanelInput => ({
  name,
  sessionID: ROOT_SESSION,
  width: 120,
  presentation: "panel",
  focused: true,
  focus: (): void => {},
  close,
  toggleFullscreen: (): void => {},
})

type PanelRenderer = (input: PanelInput, size: TestRendererOptions) => Promise<TestRendererSetup>

const renderPanel = (
  context: Context,
  claim: SlotClaim<"session.panel">,
  input: PanelInput,
  size: TestRendererOptions,
): Promise<TestRendererSetup> =>
  testRender(
    (): JSX.Element =>
      PluginContextProvider({
        value: context,
        children: claim.render(input),
      }),
    size,
  )

const setupPlugin = async (fixture: Fixture): Promise<Cleanup> => {
  const setupResult: Cleanup | void = await plugin.setup(fixture.context)
  if (typeof setupResult !== "function") {
    throw new Error("Expected TUI plugin setup to return a cleanup function")
  }
  return setupResult
}

const runScoped = <Result,>(effect: Effect.Effect<Result, never, Scope.Scope>): Promise<Result> =>
  Effect.runPromise(Effect.scoped(effect))

const acquirePluginCleanup = (fixture: Fixture): Effect.Effect<Cleanup, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise((): Promise<Cleanup> => setupPlugin(fixture)),
    (cleanup: Cleanup, _exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
      Effect.promise(async (): Promise<void> => {
        await cleanup()
      }),
  )

const acquirePanelRenderer = (
  render: PanelRenderer,
  input: PanelInput,
  size: TestRendererOptions,
): Effect.Effect<TestRendererSetup, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise((): Promise<TestRendererSetup> => render(input, size)),
    (setup: TestRendererSetup, _exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
      Effect.sync((): void => {
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
      (): Effect.Effect<void, never, Scope.Scope> => {
        const claim: SlotClaim<"session.panel"> = findPanelClaim(fixture)
        const context: Context = fixture.context
        const render: PanelRenderer = (
          input: PanelInput,
          size: TestRendererOptions,
        ): Promise<TestRendererSetup> => renderPanel(context, claim, input, size)
        return Effect.promise((): Promise<void> => body(render))
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
      (setup: TestRendererSetup): Effect.Effect<void, never, Scope.Scope> =>
        Effect.promise((): Promise<void> => body(setup)),
    ),
  )

test("/agents-status opens the session panel that reports child agent usage", async (): Promise<void> => {
  const fixture: Fixture = makeFixture()
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    const command: KeymapCommand | undefined = findCommand(
      fixture,
      (candidate: KeymapCommand): boolean => candidate.slash?.name === SLASH_NAME,
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
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Explorer"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Explorer")
        expect(frame).toContain("opencode-go/deepseek-v4.1-flash#high")
        expect(frame).toContain("Peak context: 1,650 / 10,000 tokens (17%)")
        expect(frame).toContain("$0.0123")
        expect(frame).not.toContain("Unrelated")
      },
    )
  })
})

test("command toggles the panel, Escape closes it when focused, and unrelated panels do not render", async (): Promise<void> => {
  const fixture: Fixture = makeFixture()
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    const command: KeymapCommand | undefined = findCommand(
      fixture,
      (candidate: KeymapCommand): boolean => candidate.slash?.name === SLASH_NAME,
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
      async (otherSetup: TestRendererSetup): Promise<void> => {
        await otherSetup.flush()
        const otherFrame: string = otherSetup.captureCharFrame()
        expect(otherFrame).not.toContain("Total reported spend")
        expect(otherFrame).not.toContain("Explorer")
        expect(fixture.calls).toEqual([])
      },
    )

    let closeCalls: number = 0
    await withPanel(
      render,
      makePanelInput(PANEL_NAME, (): void => {
        closeCalls += 1
      }),
      { width: 120, height: 24 },
      async (focusedSetup: TestRendererSetup): Promise<void> => {
        await focusedSetup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Explorer"),
          { maxPasses: 20 },
        )
        const escape: KeymapCommand | undefined = findCommand(
          fixture,
          (candidate: KeymapCommand): boolean => candidate.bind === "escape",
        )
        if (escape === undefined) {
          throw new Error("Expected the focused panel to bind Escape")
        }
        const escapeLayer: KeymapLayer | undefined = fixture.layers.find(
          (layer: KeymapLayer): boolean =>
            (layer.commands ?? []).some((entry: KeymapCommand): boolean => entry.bind === "escape"),
        )
        expect(escapeLayer?.enabled).toBe(true)
        await escape.run()
        expect(closeCalls).toBe(1)
      },
    )
  })
})

test("panel walks paginated descendants once, keeps same-agent sessions, and excludes unrelated trees", async (): Promise<void> => {
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const alpha: SessionInfo = sessionInfo({
    id: "ses_child_a",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Alpha task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const beta: SessionInfo = sessionInfo({
    id: "ses_child_b",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Beta task",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const gamma: SessionInfo = sessionInfo({
    id: "ses_child_c",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Gamma task",
    cost: 0.004,
  })
  const nested: SessionInfo = sessionInfo({
    id: "ses_nested",
    parentID: "ses_child_a",
    agent: "Architect",
    title: "Delta task",
    cost: 0.001,
  })
  const stranger: SessionInfo = sessionInfo({
    id: "ses_stranger",
    parentID: OTHER_ROOT,
    agent: "Stranger",
    cost: 9.9999,
  })
  const strangerChild: SessionInfo = sessionInfo({
    id: "ses_stranger_child",
    parentID: "ses_stranger",
    agent: "Deep stranger child",
    cost: 0.5,
  })
  const fixture: Fixture = makeFixture({
    sessions: [root, alpha, alpha, beta, gamma, nested, stranger, strangerChild],
    messages: {},
    models: [],
    pageSize: 2,
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 60 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Architect"),
          { maxPasses: 20 },
        )
        expect(frame.split("● Explorer").length - 1).toBe(1)
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
    contains: ["Peak context: 1,650 / 10,000 tokens (17%)"],
    missing: ["5,000", "50%"],
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
    missing: ["1,650"],
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
    contains: ["Peak context: 1,650 tokens (limit unknown)"],
    missing: ["/ 10,000 tokens", "17%"],
  },
]

for (const contextCase of contextCases) {
  test(`context usage: ${contextCase.name}`, async (): Promise<void> => {
    const fixture: Fixture = makeFixture({
      sessions: [rootSession(), contextCase.child],
      messages: contextCase.messages,
      models: contextCase.models,
    })
    await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
      await withPanel(
        render,
        makePanelInput(PANEL_NAME),
        { width: 120, height: 40 },
        async (setup: TestRendererSetup): Promise<void> => {
          const frame: string = await setup.waitForFrame(
            (candidate: string): boolean => candidate.includes(contextCase.contains[0]),
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
  async (): Promise<void> => {
    const low: ModelRef = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "low" }
    const high: ModelRef = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" }
    const root: SessionInfo = sessionInfo({
      id: ROOT_SESSION,
      agent: "build",
      cost: 0.01,
      model: { providerID: "openai", id: "gpt-6.1-sol" },
    })
    const childA: SessionInfo = sessionInfo({
      id: "ses_child_a",
      parentID: ROOT_SESSION,
      agent: "Explorer",
      title: "Alpha task",
      cost: 0.0123,
      model: low,
    })
    const fixture: Fixture = makeFixture({
      sessions: [root, childA],
      messages: { ses_child_a: [assistantMessage("msg_a_initial", CHILD_USAGE, low, "Explorer")] },
      statuses: { ses_child_a: "running" },
    })
    await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
      expect(fixture.calls).toEqual([])

      await withPanel(
        render,
        makePanelInput(PANEL_NAME),
        { width: 120, height: 40 },
        async (setup: TestRendererSetup): Promise<void> => {
          const initial: string = await setup.waitForFrame(
            (candidate: string): boolean =>
              candidate.includes("opencode-go/deepseek-v4.1-flash#low"),
            { maxPasses: 20 },
          )
          expect(initial).toContain("Peak context: 1,650 / 10,000 tokens (17%)")
          expect(initial).toContain("Spent: $0.0123")
          expect(initial).toContain("1 running · 1 session")
          expect(initial).toContain("Total reported spend: $0.0223")
          expect(fixture.calls.length).toBeGreaterThan(0)

          const refreshedUsage: TokenUsageInfo = {
            input: 1200,
            output: 300,
            reasoning: 100,
            cache: { read: 300, write: 100 },
          }
          const childB: SessionInfo = sessionInfo({
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
              agent: "Explorer",
              title: "Alpha task",
              cost: 0.02,
              model: high,
            }),
            childB,
          ])
          fixture.setMessages("ses_child_a", [
            assistantMessage("msg_a_refreshed", refreshedUsage, high, "Explorer"),
          ])
          fixture.setStatus("ses_child_a", "idle")

          await Bun.sleep(2200)
          const refreshed: string = await setup.waitForFrame(
            (candidate: string): boolean =>
              candidate.includes("opencode-go/deepseek-v4.1-flash#high"),
            { maxPasses: 40 },
          )
          expect(refreshed).toContain("Peak context: 2,000 / 10,000 tokens (20%)")
          expect(refreshed).toContain("Spent: $0.0200")
          expect(refreshed).toContain("Spent: $0.0030")
          expect(refreshed).toContain("Reviewer")
          expect(refreshed).toContain("0 running · 1 session")
          expect(refreshed).not.toContain("1 running")
          expect(refreshed).not.toContain("#low")
          expect(refreshed).toContain("Total reported spend: $0.0330")

          const before: number = fixture.calls.length
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

test("panel warns with stale values when a refresh fails", async (): Promise<void> => {
  const fixture: Fixture = makeFixture()
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const initial: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Spent: $0.0123"),
          { maxPasses: 20 },
        )
        expect(initial).toContain("Explorer")
        expect(initial).not.toContain("Refresh failed")

        fixture.failWith("refresh exploded")
        await Bun.sleep(2200)
        const failed: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Refresh failed"),
          { maxPasses: 40 },
        )
        expect(failed).toContain("Refresh failed (values may be stale): refresh exploded")
        expect(failed).toContain("Explorer")
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
    const found: ScrollBoxLike | undefined = findScrollBox(child)
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
]
const FOOTER_FOREIGN: readonly string[] = [
  "Spent:",
  "ses_",
  "Model:",
  "Context:",
  "Peak context:",
]
const FOOTER_SHAPE: RegExp = /^Total[ :]*(?:reported spend)?[ :]*\$/
const HELP_TEXTS: readonly string[] = [
  "Refreshes every",
  "Context is the latest",
  "Esc when focused",
]

const chromeProblems = (frame: string, position: string): readonly string[] => {
  const lines: readonly string[] = frame.split("\n").map((line: string): string => line.trim())
  const nonEmpty: readonly string[] = lines.filter((line: string): boolean => line.length > 0)
  const header: string | undefined = lines.find((line: string): boolean =>
    line.includes("Agents status")
  )
  const footer: string | undefined = lines.find((line: string): boolean => line.includes("Total"))
  const top: string = nonEmpty[0] ?? ""
  const bottom: string = nonEmpty[nonEmpty.length - 1] ?? ""
  const problems: string[] = []
  if (header === undefined) {
    problems.push(`${position}: header row containing 'Agents status' is missing or overwritten`)
  } else {
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
  if (footer === undefined) {
    problems.push(`${position}: footer row containing 'Total' is missing or overwritten`)
  } else {
    if (!FOOTER_SHAPE.test(footer)) {
      problems.push(`${position}: footer row is not intact: ${JSON.stringify(footer)}`)
    }
    for (const marker of FOOTER_FOREIGN) {
      if (footer.includes(marker)) {
        problems.push(
          `${position}: footer row carries entry text ${JSON.stringify(marker)}: ${
            JSON.stringify(footer)
          }`,
        )
      }
    }
  }
  if (!top.includes("Agents status")) {
    problems.push(`${position}: top row is not the header: ${JSON.stringify(top)}`)
  }
  if (!bottom.includes("Total")) {
    problems.push(`${position}: bottom row is not the footer: ${JSON.stringify(bottom)}`)
  }
  for (const help of HELP_TEXTS) {
    if (frame.includes(help)) {
      problems.push(`${position}: help text still present: ${JSON.stringify(help)}`)
    }
  }
  return problems
}

const makeOverflowFixture = (): Fixture => {
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const child = (index: number, cost: number): SessionInfo =>
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
  async (): Promise<void> => {
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
      const fixture: Fixture = makeOverflowFixture()
      await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
        await withPanel(
          render,
          makePanelInput(PANEL_NAME),
          { width: viewport.width, height: viewport.height },
          async (setup: TestRendererSetup): Promise<void> => {
            const initial: string = await setup.waitForFrame(
              (candidate: string): boolean => candidate.includes("Model: openai/gpt-6.1-sol"),
              { maxPasses: 40 },
            )
            problems.push(...chromeProblems(initial, `${viewport.name} initial`))

            const scrollbox: ScrollBoxLike | undefined = findScrollBox(setup.renderer.root)
            if (scrollbox === undefined) {
              throw new Error(
                `${viewport.name}: expected an OpenTUI scrollbox in the rendered panel`,
              )
            }
            scrollbox.scrollTop = scrollbox.scrollHeight
            await setup.renderOnce()
            const scrolled: string = await setup.waitForFrame(
              (candidate: string): boolean => candidate.includes("Agent 3"),
              { maxPasses: 40 },
            )
            problems.push(...chromeProblems(scrolled, `${viewport.name} bottom-scrolled`))
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

test("panel shows the executing assistant model as primary and the selected model separately when they differ", async (): Promise<void> => {
  const selected: ModelRef = {
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
    variant: "high",
  }
  const executing: ModelRef = { providerID: "anthropic", id: "claude-5-opus" }
  const child: SessionInfo = sessionInfo({
    id: "ses_child_divergent",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Divergent model",
    cost: 0.0123,
    model: selected,
  })
  const fixture: Fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: {
      ses_child_divergent: [assistantMessage("msg_divergent", CHILD_USAGE, executing, "Explorer")],
    },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Model: anthropic/claude-5-opus"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Model: anthropic/claude-5-opus")
        expect(frame).toMatch(/selected[: ]+opencode-go\/deepseek-v4\.1-flash#high/i)
        expect(frame).not.toContain("Model: opencode-go/deepseek-v4.1-flash#high")
      },
    )
  })
})

test("panel isolates an unavailable model catalog to the affected card", async (): Promise<void> => {
  const deletedDirectory: string = "/tmp/opencode/agents-status-deleted"
  const failedModel: ModelRef = { providerID: "anthropic", id: "claude-5-opus" }
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const childOk: SessionInfo = sessionInfo({
    id: "ses_child_ok",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Accessible child",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const childGone: SessionInfo = sessionInfo({
    id: "ses_child_gone",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Deleted location child",
    cost: 0.003,
    directory: deletedDirectory,
    model: failedModel,
  })
  const fixture: Fixture = makeFixture({
    sessions: [root, childOk, childGone],
    messages: {
      ses_child_ok: [assistantMessage("msg_ok", CHILD_USAGE, DEEPSEEK, "Explorer")],
      ses_child_gone: [assistantMessage("msg_gone", CHILD_USAGE, failedModel, "Explorer")],
    },
    models: DEFAULT_MODELS,
    catalogFailures: { [deletedDirectory]: "catalog unavailable for deleted location" },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Context data unavailable"),
          { maxPasses: 40 },
        )
        expect(frame).toContain("build · main")
        expect(frame).toContain("0 running · 2 sessions")
        expect(frame).toContain("Peak context: 1,650 / 10,000 tokens (17%)")
        expect(frame).toContain("Model: anthropic/claude-5-opus")
        expect(frame).toContain("Spent: $0.0050")
        expect(frame).toContain("Peak context: 1,650 tokens (limit unknown)")
        expect(frame).toContain("Total reported spend: $0.0150")
        expect(frame).not.toContain("Refresh failed (values may be stale)")

        const failedModelRow: number = frame.indexOf("Model: anthropic/claude-5-opus")
        const note: number = frame.indexOf("Context data unavailable")
        const nextModelRow: number = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#high")
        expect(failedModelRow).toBeGreaterThanOrEqual(0)
        expect(note).toBeGreaterThan(failedModelRow)
        expect(nextModelRow).toBeGreaterThan(note)
      },
    )
  })
})

test("panel paginates message history past the first page to honor a staged revert boundary", async (): Promise<void> => {
  const boundary: string = "msg_boundary"
  const lateUsage: TokenUsageInfo = {
    input: 4000,
    output: 1000,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  const history: SessionMessageInfo[] = [
    assistantMessage("msg_early_assistant", CHILD_USAGE, DEEPSEEK, "Explorer"),
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
      "Explorer",
    ),
  )
  const child: SessionInfo = sessionInfo({
    id: "ses_child_paged",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Paged history",
    cost: 0.0123,
    revert: { messageID: boundary },
    model: DEEPSEEK,
  })
  const fixture: Fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: { ses_child_paged: history },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean =>
            candidate.includes("Peak context: 1,650 / 10,000 tokens (17%)"),
          { maxPasses: 60 },
        )
        expect(frame).not.toContain("Paged history")
        expect(frame).toContain("Peak context: 1,650 / 10,000 tokens (17%)")
        expect(frame).toContain("Model: anthropic/claude-5-opus")
        expect(frame).not.toContain("5,000")

        const anthropicStart: number = frame.indexOf("Model: anthropic/claude-5-opus")
        const contextStart: number = frame.indexOf(
          "Context model: opencode-go/deepseek-v4.1-flash#high",
        )
        expect(anthropicStart).toBeGreaterThanOrEqual(0)
        expect(contextStart).toBeGreaterThan(anthropicStart)

        const anthropicGroup: string = frame.slice(anthropicStart, contextStart)
        expect(anthropicGroup).toContain("Peak context: unknown")
        expect(anthropicGroup).not.toContain("1,650")
        expect(anthropicGroup).not.toContain("17%")

        const contextGroup: string = frame.slice(
          contextStart,
          frame.indexOf("Total reported spend"),
        )
        expect(contextGroup).toMatch(/Peak context:\s*1,650\s*\/\s*10,000 tokens\s*\(17%\)/)
      },
    )
  })
})

test("panel does not report the selected model as actual when message history is unavailable", async (): Promise<void> => {
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    title: "Main task",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const child: SessionInfo = sessionInfo({
    id: "ses_child_lost",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Lost history",
    cost: 0.003,
    model: DEEPSEEK,
  })
  const fixture: Fixture = makeFixture({
    sessions: [root, child],
    messages: {},
    messageFailures: { ses_child_lost: "message history unavailable" },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean =>
            candidate.includes("Selected: opencode-go/deepseek-v4.1-flash#high"),
          { maxPasses: 40 },
        )
        const cardStart: number = frame.indexOf("● Explorer")
        const cardEnd: number = frame.indexOf("Total reported spend")
        expect(cardStart).toBeGreaterThanOrEqual(0)
        expect(cardEnd).toBeGreaterThan(cardStart)
        const card: string = frame.slice(cardStart, cardEnd)
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

test("focused panel scrolls on PageDown and PageUp while header and footer stay fixed", async (): Promise<void> => {
  const fixture: Fixture = makeOverflowFixture()
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 76, height: 22 },
      async (setup: TestRendererSetup): Promise<void> => {
        const initial: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Model: openai/gpt-6.1-sol"),
          { maxPasses: 40 },
        )
        expect(chromeProblems(initial, "initial")).toEqual([])

        const scrollbox: ScrollBoxLike | undefined = findScrollBox(setup.renderer.root)
        if (scrollbox === undefined) {
          throw new Error("Expected an OpenTUI scrollbox in the rendered panel")
        }
        const before: number = scrollbox.scrollTop
        expect(before).toBe(0)

        setup.mockInput.pressKey("\x1b[6~")
        await setup.renderOnce()
        const afterDown: number = scrollbox.scrollTop
        expect(afterDown).toBeGreaterThan(before)
        expect(chromeProblems(setup.captureCharFrame(), "after PageDown")).toEqual([])

        setup.mockInput.pressKey("\x1b[5~")
        await setup.renderOnce()
        const afterUp: number = scrollbox.scrollTop
        expect(afterUp).toBeLessThan(afterDown)
        expect(chromeProblems(setup.captureCharFrame(), "after PageUp")).toEqual([])
      },
    )
  })
})

test("panel picks the highest known context percentage per model across locations", async (): Promise<void> => {
  const locationA: string = "/tmp/opencode/agents-status-limit-a"
  const locationB: string = "/tmp/opencode/agents-status-limit-b"
  const smallUsage: TokenUsageInfo = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const largeUsage: TokenUsageInfo = {
    input: 16000,
    output: 3000,
    reasoning: 500,
    cache: { read: 400, write: 100 },
  }
  const first: SessionInfo = sessionInfo({
    id: "ses_limit_a",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0123,
    directory: locationA,
    model: DEEPSEEK,
  })
  const second: SessionInfo = sessionInfo({
    id: "ses_limit_b",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.002,
    directory: locationB,
    model: DEEPSEEK,
  })
  const fixture: Fixture = makeFixture({
    sessions: [rootSession(), first, second],
    messages: {
      ses_limit_a: [assistantMessage("msg_limit_a", smallUsage, DEEPSEEK, "Explorer")],
      ses_limit_b: [assistantMessage("msg_limit_b", largeUsage, DEEPSEEK, "Explorer")],
    },
    modelsByDirectory: {
      [locationA]: [modelInfo("opencode-go", "deepseek-v4.1-flash", 10000)],
      [locationB]: [modelInfo("opencode-go", "deepseek-v4.1-flash", 100000)],
    },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean =>
            candidate.includes("Peak context: 5,000 / 10,000 tokens (50%)"),
          { maxPasses: 40 },
        )
        expect(frame).toContain("2 sessions")
        expect(frame).toContain("opencode-go/deepseek-v4.1-flash#high")
        expect(frame).not.toContain("Peak context: 20,000 / 100,000 tokens (20%)")
        expect(frame).not.toContain("20,000")
        expect(frame).not.toContain("25,000")
      },
    )
  })
})

test("panel attributes a usage sample to its own model when the latest assistant has no tokens", async (): Promise<void> => {
  const anthropic: ModelRef = { providerID: "anthropic", id: "claude-5-opus" }
  const switchedUsage: TokenUsageInfo = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const anthropicUsage: TokenUsageInfo = {
    input: 1500,
    output: 300,
    reasoning: 100,
    cache: { read: 100, write: 0 },
  }
  const { tokens: _omitted, ...anthropicNoTokens } = assistantMessage(
    "msg_switch_anthropic",
    ZERO_USAGE,
    anthropic,
    "Explorer",
  )
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const switched: SessionInfo = sessionInfo({
    id: "ses_switch_a",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0123,
    model: anthropic,
  })
  const current: SessionInfo = sessionInfo({
    id: "ses_switch_b",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.002,
    model: anthropic,
  })
  const fixture: Fixture = makeFixture({
    sessions: [root, switched, current],
    messages: {
      ses_switch_a: [
        assistantMessage("msg_switch_deepseek", switchedUsage, DEEPSEEK, "Explorer"),
        anthropicNoTokens,
      ],
      ses_switch_b: [
        assistantMessage("msg_switch_anthropic_usage", anthropicUsage, anthropic, "Explorer"),
      ],
    },
    models: [...DEFAULT_MODELS, modelInfo("anthropic", "claude-5-opus", 200000)],
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Model: anthropic/claude-5-opus"),
          { maxPasses: 40 },
        )
        expect(frame.split("● Explorer").length - 1).toBe(1)
        expect(frame).toContain("2 sessions")

        const anthropicStart: number = frame.indexOf("Model: anthropic/claude-5-opus")
        const contextStart: number = frame.indexOf("Context model:")
        expect(anthropicStart).toBeGreaterThanOrEqual(0)
        expect(contextStart).toBeGreaterThan(anthropicStart)

        const anthropicGroup: string = frame.slice(anthropicStart, contextStart)
        expect(anthropicGroup).toMatch(/Peak context:\s*2,000\s*\/\s*200,000 tokens\s*\(1%\)/)
        expect(anthropicGroup).not.toContain("5,000")
        expect(anthropicGroup).not.toContain("50%")

        const contextGroup: string = frame.slice(
          contextStart,
          frame.indexOf("Total reported spend"),
        )
        expect(contextGroup).toContain("Context model: opencode-go/deepseek-v4.1-flash#high")
        expect(contextGroup).toMatch(/Peak context:\s*5,000\s*\/\s*10,000 tokens\s*\(50%\)/)
        expect(contextGroup).not.toContain("session")

        expect(frame.split("Spent: $0.0143").length - 1).toBe(1)
        expect(frame.split("Total reported spend: $0.0243").length - 1).toBe(1)
      },
    )
  })
})

test("panel keeps distinct variant rows with per-variant peak context for a main and child session", async (): Promise<void> => {
  const low: ModelRef = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "low" }
  const mainUsage: TokenUsageInfo = {
    input: 1000,
    output: 200,
    reasoning: 50,
    cache: { read: 300, write: 100 },
  }
  const childUsage: TokenUsageInfo = {
    input: 1500,
    output: 300,
    reasoning: 100,
    cache: { read: 100, write: 0 },
  }
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const child: SessionInfo = sessionInfo({
    id: "ses_variant_low",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.002,
    model: low,
  })
  const fixture: Fixture = makeFixture({
    sessions: [root, child],
    messages: {
      [ROOT_SESSION]: [assistantMessage("msg_variant_high", mainUsage, DEEPSEEK, "Explorer")],
      ses_variant_low: [assistantMessage("msg_variant_low", childUsage, low, "Explorer")],
    },
    models: DEFAULT_MODELS,
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean =>
            candidate.includes("Model: opencode-go/deepseek-v4.1-flash#low"),
          { maxPasses: 40 },
        )
        expect(frame.split("● Explorer").length - 1).toBe(1)
        expect(frame).toContain("● Explorer · main")
        expect(frame).toContain("2 sessions")
        expect(frame.split("Spent: $0.0143").length - 1).toBe(1)

        const highStart: number = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#high")
        const lowStart: number = frame.indexOf("Model: opencode-go/deepseek-v4.1-flash#low")
        expect(highStart).toBeGreaterThanOrEqual(0)
        expect(lowStart).toBeGreaterThan(highStart)

        const highGroup: string = frame.slice(highStart, lowStart)
        expect(highGroup).toMatch(/Peak context:\s*1,650\s*\/\s*10,000 tokens\s*\(17%\)/)
        expect(highGroup).toContain("1 session")
        expect(highGroup).not.toContain("2,000")
        expect(highGroup).not.toContain("20%")

        const lowGroup: string = frame.slice(lowStart, frame.indexOf("Total reported spend"))
        expect(lowGroup).toMatch(/Peak context:\s*2,000\s*\/\s*10,000 tokens\s*\(20%\)/)
        expect(lowGroup).toContain("1 session")
        expect(lowGroup).not.toContain("1,650")
        expect(lowGroup).not.toContain("17%")
      },
    )
  })
})

test("panel groups descendants by agent with combined counts, single-count spend, and per-model peak context", async (): Promise<void> => {
  const alternate: ModelRef = { providerID: "anthropic", id: "claude-5-opus", variant: "medium" }
  const peakUsage: TokenUsageInfo = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const nestedUsage: TokenUsageInfo = {
    input: 1500,
    output: 300,
    reasoning: 100,
    cache: { read: 100, write: 0 },
  }
  const root: SessionInfo = sessionInfo({
    id: ROOT_SESSION,
    agent: "build",
    title: "Root grouped task",
    cost: 0.01,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
  })
  const alpha: SessionInfo = sessionInfo({
    id: "ses_grouped_alpha",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Alpha grouped task",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const beta: SessionInfo = sessionInfo({
    id: "ses_grouped_beta",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    title: "Beta grouped task",
    cost: 0.002,
    model: DEEPSEEK,
  })
  const nested: SessionInfo = sessionInfo({
    id: "ses_grouped_nested",
    parentID: alpha.id,
    agent: "Explorer",
    title: "Nested grouped task",
    cost: 0.003,
    model: alternate,
  })
  const fixture: Fixture = makeFixture({
    sessions: [root, alpha, beta, nested, unrelatedSession],
    messages: {
      ses_grouped_alpha: [assistantMessage("msg_grouped_alpha", CHILD_USAGE, DEEPSEEK, "Explorer")],
      ses_grouped_beta: [assistantMessage("msg_grouped_beta", peakUsage, DEEPSEEK, "Explorer")],
      ses_grouped_nested: [
        assistantMessage("msg_grouped_nested", nestedUsage, alternate, "Explorer"),
      ],
    },
    models: [...DEFAULT_MODELS, modelInfo("anthropic", "claude-5-opus", 200000)],
    statuses: { ses_grouped_alpha: "running", ses_grouped_beta: "running" },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("● Explorer"),
          { maxPasses: 40 },
        )
        const headings: number = frame.split("● Explorer").length - 1
        expect(headings).toBe(1)

        const groupStart: number = frame.indexOf("● Explorer")
        const groupEnd: number = frame.indexOf("Total reported spend")
        expect(groupEnd).toBeGreaterThan(groupStart)
        const group: string = frame.slice(groupStart, groupEnd)
        expect(group).toContain("2 running")
        expect(group).toContain("3 sessions")
        expect(group).toMatch(/Spent:\s*\$0\.0173/)
        expect(group).toContain("opencode-go/deepseek-v4.1-flash#high")
        expect(group).toContain("anthropic/claude-5-opus#medium")
        expect(group).toMatch(/Peak context:\s*5,000\s*\/\s*10,000 tokens\s*\(50%\)/)
        expect(group).not.toContain("6,650")
        expect(frame).toContain("Total reported spend: $0.0273")

        expect(frame).not.toContain("Root grouped task")
        expect(frame).not.toContain("Alpha grouped task")
        expect(frame).not.toContain("Beta grouped task")
        expect(frame).not.toContain("Nested grouped task")
        expect(frame).not.toContain("↳")
        expect(frame).not.toContain("ses_")
        expect(frame).not.toContain("Unrelated")

        fixture.setStatus("ses_grouped_nested", "running")
        await setup.renderOnce()
        const updated: string = setup.captureCharFrame()
        expect(updated).toContain("3 running · 3 sessions")
        expect(updated.split("● Explorer").length - 1).toBe(1)
      },
    )
  })
})

const capturedForegrounds = (
  frame: CapturedFrame,
  text: string,
): ReadonlyArray<readonly [number, number, number, number]> =>
  frame.lines.flatMap(
    (line: CapturedLine): ReadonlyArray<readonly [number, number, number, number]> =>
      line.spans
        .filter((span: CapturedSpan): boolean => span.text.includes(text))
        .map((span: CapturedSpan): readonly [number, number, number, number] => span.fg.toInts()),
  )

test("panel repaints card text when the theme changes without a data refresh", async (): Promise<void> => {
  const fixture: Fixture = makeFixture()
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("Explorer"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Spent: $0.0123")

        const before: CapturedFrame = setup.captureSpans()
        expect(capturedForegrounds(before, "Agents status")).toEqual([THEME_A.text.base.toInts()])
        expect(capturedForegrounds(before, "Explorer")).toEqual([THEME_A.text.base.toInts()])
        expect(capturedForegrounds(before, "Spent: $0.0123")).toEqual([THEME_A.text.muted.toInts()])

        fixture.failWith("refresh blocked")
        fixture.setTheme(THEME_B)
        await setup.renderOnce()
        const after: CapturedFrame = setup.captureSpans()
        const afterFrame: string = setup.captureCharFrame()

        expect(afterFrame).toContain("Explorer")
        expect(afterFrame).toContain("Model: opencode-go/deepseek-v4.1-flash#high")
        expect(afterFrame).toContain("Spent: $0.0123")
        expect(afterFrame).toContain("Total reported spend: $0.0123")
        expect(afterFrame).not.toContain("Refresh failed")

        expect(capturedForegrounds(after, "Agents status")).toEqual([THEME_B.text.base.toInts()])
        expect(capturedForegrounds(after, "Explorer")).toEqual([THEME_B.text.base.toInts()])
        expect(
          capturedForegrounds(after, "Model: opencode-go/deepseek-v4.1-flash#high"),
        ).toEqual([THEME_B.text.base.toInts()])
        expect(capturedForegrounds(after, "Spent: $0.0123")).toEqual([THEME_B.text.muted.toInts()])
      },
    )
  })
})

test("panel groups canonical-equivalent model references into one row without a Selected line", async (): Promise<void> => {
  const hashRef: ModelRef = { providerID: "acme", id: "model#high" }
  const variantRef: ModelRef = { providerID: "acme", id: "model", variant: "high" }
  const plainRef: ModelRef = { providerID: "acme", id: "model" }
  const emptyVariantRef: ModelRef = { providerID: "acme", id: "model", variant: "" }
  const hashSession: SessionInfo = sessionInfo({
    id: "ses_canon_hash",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0100,
    model: hashRef,
  })
  const variantSession: SessionInfo = sessionInfo({
    id: "ses_canon_variant",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0020,
    model: variantRef,
  })
  const plainSession: SessionInfo = sessionInfo({
    id: "ses_canon_plain",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0004,
    model: plainRef,
  })
  const emptyVariantSession: SessionInfo = sessionInfo({
    id: "ses_canon_empty",
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0006,
    model: emptyVariantRef,
  })
  const fixture: Fixture = makeFixture({
    sessions: [rootSession(), hashSession, variantSession, plainSession, emptyVariantSession],
    messages: {
      ses_canon_hash: [assistantMessage("msg_canon_hash", CHILD_USAGE, hashRef, "Explorer")],
      ses_canon_variant: [
        assistantMessage("msg_canon_variant", CHILD_USAGE, variantRef, "Explorer"),
      ],
      ses_canon_plain: [assistantMessage("msg_canon_plain", CHILD_USAGE, plainRef, "Explorer")],
      ses_canon_empty: [
        assistantMessage("msg_canon_empty", CHILD_USAGE, emptyVariantRef, "Explorer"),
      ],
    },
    models: [],
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean => candidate.includes("acme/model#high"),
          { maxPasses: 20 },
        )
        const lines: readonly string[] = frame.split("\n").map((line: string): string =>
          line.replace(/[│█]/g, " ").trim()
        )
        expect(frame.split("● Explorer").length - 1).toBe(1)
        expect(frame).toContain("0 running · 4 sessions")
        expect(lines.filter((line: string): boolean => line === "Model: acme/model#high").length)
          .toBe(1)
        expect(lines.filter((line: string): boolean => line === "Model: acme/model").length).toBe(1)
        expect(lines.filter((line: string): boolean => line === "2 sessions").length).toBe(2)
        expect(frame).not.toContain("Selected:")
        expect(frame).toContain("Spent: $0.0130")
        expect(frame).toContain("Total reported spend: $0.0130")
      },
    )
  })
})

test("panel stops at the latest eligible assistant and does not fall back to older usage", async (): Promise<void> => {
  const olderUsage: TokenUsageInfo = {
    input: 4000,
    output: 700,
    reasoning: 200,
    cache: { read: 100, write: 0 },
  }
  const history: SessionMessageInfo[] = [
    assistantMessage("msg_older_usage", olderUsage, DEEPSEEK, "Explorer"),
  ]
  for (let index = 0; index < 150; index++) {
    history.push(userMessage(`msg_noise_${String(index).padStart(3, "0")}`, `noise ${index}`))
  }
  history.push(assistantMessage("msg_latest_zero", ZERO_USAGE, DEEPSEEK, "Explorer"))
  const child: SessionInfo = sessionInfo({
    id: CHILD_SESSION,
    parentID: ROOT_SESSION,
    agent: "Explorer",
    cost: 0.0123,
    model: DEEPSEEK,
  })
  const fixture: Fixture = makeFixture({
    sessions: [rootSession(), child],
    messages: { [CHILD_SESSION]: history },
  })
  await withPlugin(fixture, async (render: PanelRenderer): Promise<void> => {
    await withPanel(
      render,
      makePanelInput(PANEL_NAME),
      { width: 120, height: 40 },
      async (setup: TestRendererSetup): Promise<void> => {
        const frame: string = await setup.waitForFrame(
          (candidate: string): boolean =>
            candidate.includes("Model: opencode-go/deepseek-v4.1-flash#high"),
          { maxPasses: 20 },
        )
        expect(frame).toContain("Peak context: unknown")
        expect(frame).not.toContain("5,000")
        expect(frame).toContain("Spent: $0.0123")
        const messageCalls: readonly ApiCall[] = fixture.calls.filter(
          (call: ApiCall): boolean => call.method === "message.list",
        )
        expect(messageCalls.length).toBe(2)
      },
    )
  })
})
