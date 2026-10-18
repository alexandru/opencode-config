/** @jsxImportSource @opentui/solid */
import type { TokenUsageInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context, KeymapLayer, PanelInput } from "@opencode/plugin/tui/context"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { JSX } from "@opentui/solid"
import { Effect, Fiber, Option, Result } from "effect"
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { watch } from "./data.ts"
import {
  type AgentSummary,
  contextPercent,
  type ModelSummary,
  type Positive,
  type RequestFailure,
  type SessionSummary,
  type Snapshot,
  usagePercent,
  type Utilization,
} from "./model.ts"

type View =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed"; readonly error: RequestFailure }
  | {
    readonly _tag: "Ready"
    readonly snapshot: Snapshot
    readonly error: Option.Option<RequestFailure>
  }

type StatusTab = "agents" | "sessions"

const compact: Intl.NumberFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
})
const money: Intl.NumberFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

const tokensLabel = (
  tokens: Option.Option<TokenUsageInfo>,
  unavailable: string,
): string =>
  Option.match(tokens, {
    onNone: (): string => unavailable,
    onSome: (value: TokenUsageInfo): string =>
      `↑ ${compact.format(value.input)} · ↓ ${compact.format(value.output)} · ↺ ${
        compact.format(value.cache.read)
      }`,
  })

const usageLabel = (usage: Option.Option<Utilization>): string =>
  Option.match(usage, {
    onNone: (): string => "unknown",
    onSome: (value: Utilization): string =>
      Option.match(value.limit, {
        onNone: (): string => `${compact.format(value.tokens)} tokens (limit unknown)`,
        onSome: (limit: Positive): string =>
          `${compact.format(value.tokens)} / ${compact.format(limit)} tokens (${
            contextPercent(value.tokens, limit)
          }%)`,
      }),
  })

const usageBar = (percent: number): string => {
  const filled: number = Math.max(0, Math.min(12, Math.round(percent / 100 * 12)))
  return "━".repeat(filled) + "╌".repeat(12 - filled)
}

const usageColor = (percent: number, theme: ResolvedTheme): ResolvedTheme["text"]["base"] =>
  percent >= 90
    ? theme.text.feedback.error.base
    : percent >= 75
    ? theme.text.feedback.warning.base
    : theme.text.feedback.info.base

const ModelCard = (
  props: {
    readonly model: ModelSummary
    readonly theme: ResolvedTheme
    readonly multiple: boolean
  },
): JSX.Element => {
  const sample: Accessor<Option.Option<Utilization>> = (): Option.Option<Utilization> =>
    props.model._tag === "Context" ? Option.some(props.model.usage) : props.model.usage
  const meter: Accessor<{ readonly percent: number } | undefined> = createMemo((): {
    readonly percent: number
  } | undefined =>
    Option.getOrUndefined(
      Option.map(
        Option.flatMap(sample(), usagePercent),
        (percent: number): { readonly percent: number } => ({ percent }),
      ),
    )
  )
  return (
    <box flexDirection="column" flexShrink={0} marginTop={props.multiple ? 1 : 0}>
      <text fg={props.theme.text.base}>
        {props.model._tag === "Sessions" ? "Model: " : "Context model: "}
        {props.model.label}
      </text>
      <Show when={props.model._tag === "Sessions" ? props.model : undefined}>
        {(model: Accessor<Extract<ModelSummary, { readonly _tag: "Sessions" }>>): JSX.Element => (
          <>
            <Show when={props.multiple}>
              <text fg={props.theme.text.muted}>
                {model().count} {model().count === 1 ? "session" : "sessions"}
              </text>
            </Show>
            <Show when={model().selected.length > 0}>
              <text fg={props.theme.text.muted}>Selected: {model().selected.join(", ")}</text>
            </Show>
          </>
        )}
      </Show>
      <text fg={props.theme.text.muted}>Peak context: {usageLabel(sample())}</text>
      <Show when={props.model.unavailable}>
        <text fg={props.theme.text.feedback.warning.base}>Context data unavailable</text>
      </Show>
      <Show when={meter()}>
        {(value: Accessor<{ readonly percent: number }>): JSX.Element => (
          <text fg={usageColor(value().percent, props.theme)}>{usageBar(value().percent)}</text>
        )}
      </Show>
    </box>
  )
}

const AgentCard = (
  props: {
    readonly agent: AgentSummary
    readonly theme: ResolvedTheme
    readonly status: Context["data"]["session"]["status"]
    readonly first: boolean
    readonly session?: SessionSummary
  },
): JSX.Element => {
  const running: Accessor<number> = createMemo((): number =>
    props.agent.sessions.reduce(
      (total: number, id: string): number => total + Number(props.status(id) === "running"),
      0,
    )
  )
  const color: Accessor<ResolvedTheme["text"]["base"]> = (): ResolvedTheme["text"]["base"] =>
    running() > 0
      ? props.theme.text.feedback.warning.base
      : props.agent.failed > 0
      ? props.theme.text.feedback.error.base
      : props.agent.succeeded === props.agent.sessions.length
      ? props.theme.text.feedback.success.base
      : props.theme.text.muted
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginTop={props.first ? 0 : 1}
      border={["left"]}
      borderColor={color()}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show
        when={props.session}
        fallback={
          <text fg={props.theme.text.base}>
            <span style={{ fg: color() }}>{"● "}</span>
            <b>{props.agent.name}</b>
            <span style={{ fg: props.theme.text.muted }}>
              {props.agent.role === "primary" ? " · main" : ""}
            </span>
          </text>
        }
      >
        {(session: Accessor<SessionSummary>): JSX.Element => (
          <text fg={props.theme.text.base}>
            <span style={{ fg: color() }}>{"● "}</span>
            <b>{Option.getOrElse(session().title, (): string => session().id)}</b>
          </text>
        )}
      </Show>
      <Show
        when={props.session}
        fallback={
          <text fg={color()}>
            {running()} running · {props.agent.sessions.length}{" "}
            {props.agent.sessions.length === 1 ? "session" : "sessions"}
            {props.agent.failed > 0 ? ` · ${props.agent.failed} failed/interrupted` : ""}
          </text>
        }
      >
        {(session: Accessor<SessionSummary>): JSX.Element => (
          <>
            <text fg={props.theme.text.muted}>
              {session().name}
              {session().role === "primary" ? " · main" : ""} · {session().id}
            </text>
            <text fg={color()}>
              Status: {running() > 0
                ? "running"
                : Option.getOrElse(session().outcome, (): string => "idle")}
            </text>
          </>
        )}
      </Show>
      <For each={props.agent.models}>
        {(model: ModelSummary): JSX.Element => (
          <ModelCard model={model} theme={props.theme} multiple={props.agent.models.length > 1} />
        )}
      </For>
      <text fg={props.theme.text.muted}>
        Spent: {money.format(props.agent.cost)} ·{" "}
        {tokensLabel(props.agent.tokens, "tokens unavailable")}
      </text>
    </box>
  )
}

const StatusPanel = (props: PanelInput & { readonly context: Context }): JSX.Element => {
  const ctx: Context = props.context
  const status: Context["data"]["session"]["status"] = (id: string): "running" | "idle" =>
    ctx.data.session.status(id)
  const [view, setView] = createSignal<View>({ _tag: "Loading" })
  const [tab, setTab] = createSignal<StatusTab>("agents")
  const switchTab = (): void => {
    setTab((current: StatusTab): StatusTab => current === "agents" ? "sessions" : "agents")
  }
  const snapshot: Accessor<Snapshot> = (): Snapshot => {
    const current: View = view()
    return current._tag === "Ready"
      ? current.snapshot
      : { agents: [], sessions: [], cost: 0, tokens: Option.none() }
  }
  const error: Accessor<Option.Option<RequestFailure>> = (): Option.Option<RequestFailure> => {
    const current: View = view()
    switch (current._tag) {
      case "Loading":
        return Option.none()
      case "Failed":
        return Option.some(current.error)
      case "Ready":
        return current.error
    }
  }
  ctx.keymap.layer((): KeymapLayer => ({
    mode: "global",
    enabled: props.focused,
    commands: [
      { bind: "escape", title: "Close agents status", run: props.close },
      { bind: "left", title: "Previous status tab", run: switchTab },
      { bind: "right", title: "Next status tab", run: switchTab },
      {
        bind: "a",
        title: "Show agent totals",
        run: (): void => {
          setTab("agents")
        },
      },
      {
        bind: "s",
        title: "Show agent sessions",
        run: (): void => {
          setTab("sessions")
        },
      },
    ],
  }))
  createEffect((): void => {
    setView({ _tag: "Loading" })
    const fiber: Fiber.Fiber<never> = Effect.runFork(
      watch(
        ctx.client,
        props.sessionID,
        (result: Result.Result<Snapshot, RequestFailure>): void => {
          setView((current: View): View =>
            Result.match(result, {
              onSuccess: (value: Snapshot): View => ({
                _tag: "Ready",
                snapshot: value,
                error: Option.none(),
              }),
              onFailure: (failure: RequestFailure): View =>
                current._tag === "Ready"
                  ? { ...current, error: Option.some(failure) }
                  : { _tag: "Failed", error: failure },
            })
          )
        },
      ),
    )
    onCleanup((): void => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
  })
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} padding={1}>
      <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <box flexDirection="row" height={1} gap={1}>
          <For each={["agents", "sessions"] as const}>
            {(name: StatusTab): JSX.Element => (
              <box
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                height={1}
                backgroundColor={tab() === name
                  ? ctx.theme.background.action.primary.base
                  : ctx.theme.background.raised.base}
                alignItems="center"
                justifyContent="center"
                onMouseDown={(): void => {
                  props.focus()
                  setTab(name)
                }}
              >
                <text
                  fg={tab() === name ? ctx.theme.text.action.primary.base : ctx.theme.text.muted}
                  selectable={false}
                >
                  {tab() === name ? "▸ " : "  "}
                  <b>{name === "agents" ? "Agents" : "Sessions"}</b>
                  {"  "}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={ctx.theme.text.muted}>← →</text>
          <text fg={ctx.theme.text.muted} onMouseDown={props.close}>×</text>
        </box>
      </box>
      <scrollbox
        marginTop={1}
        marginBottom={1}
        flexGrow={1}
        flexBasis={0}
        minHeight={0}
        focused={props.focused}
      >
        <Show when={view()._tag === "Loading"}>
          <text fg={ctx.theme.text.muted}>Loading agents…</text>
        </Show>
        <Show when={Option.getOrUndefined(error())}>
          {(failure: Accessor<RequestFailure>): JSX.Element => (
            <text fg={ctx.theme.text.feedback.error.base}>
              Refresh failed (values may be stale): {failure().message}
            </text>
          )}
        </Show>
        <Show
          when={tab() === "agents"}
          fallback={
            <For each={snapshot().sessions}>
              {(session: SessionSummary, index: Accessor<number>): JSX.Element => (
                <AgentCard
                  agent={session}
                  session={session}
                  theme={ctx.theme}
                  status={status}
                  first={index() === 0}
                />
              )}
            </For>
          }
        >
          <For each={snapshot().agents}>
            {(agent: AgentSummary, index: Accessor<number>): JSX.Element => (
              <AgentCard
                agent={agent}
                theme={ctx.theme}
                status={status}
                first={index() === 0}
              />
            )}
          </For>
        </Show>
      </scrollbox>
      <text fg={ctx.theme.text.base} flexShrink={0} height={1}>
        Total reported spend: {money.format(snapshot().cost)}
      </text>
      <text fg={ctx.theme.text.muted} flexShrink={0} height={1}>
        Tokens: {tokensLabel(snapshot().tokens, "unavailable")}
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "agents-status",
  setup(ctx: Context): () => void {
    const release: () => void = ctx.ui.slot({
      append: "session.panel",
      render: (props: PanelInput): JSX.Element => (
        <Show when={props.name === "agents-status"}>
          <StatusPanel {...props} context={ctx} />
        </Show>
      ),
    })
    ctx.keymap.layer((): KeymapLayer => ({
      mode: "global",
      commands: [{
        id: "agents-status",
        title: "Agents status",
        group: "Session",
        palette: true,
        slash: { name: "agents-status" },
        enabled: ctx.ui.router.current().type === "session",
        run: (): void => {
          if (ctx.ui.panel.current()?.name === "agents-status") ctx.ui.panel.close()
          else ctx.ui.panel.open("agents-status")
        },
      }],
    }))
    return release
  },
})
