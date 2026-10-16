/** @jsxImportSource @opentui/solid */
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

const number: Intl.NumberFormat = new Intl.NumberFormat("en-US")
const money: Intl.NumberFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

const usageLabel = (usage: Option.Option<Utilization>): string =>
  Option.match(usage, {
    onNone: (): string => "unknown",
    onSome: (value: Utilization): string =>
      Option.match(value.limit, {
        onNone: (): string => `${number.format(value.tokens)} tokens (limit unknown)`,
        onSome: (limit: Positive): string =>
          `${number.format(value.tokens)} / ${number.format(limit)} tokens (${
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
      marginTop={1}
      border={["left"]}
      borderColor={color()}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={props.theme.text.base}>
          <span style={{ fg: color() }}>{"● "}</span>
          <b>{props.agent.name}</b>
          <span style={{ fg: props.theme.text.muted }}>
            {props.agent.role === "primary" ? " · main" : ""}
          </span>
        </text>
        <text fg={props.theme.text.muted} flexShrink={0}>
          Spent: {money.format(props.agent.cost)}
        </text>
      </box>
      <text fg={color()}>
        {running()} running · {props.agent.sessions.length}{" "}
        {props.agent.sessions.length === 1 ? "session" : "sessions"}
        {props.agent.failed > 0 ? ` · ${props.agent.failed} failed/interrupted` : ""}
      </text>
      <For each={props.agent.models}>
        {(model: ModelSummary): JSX.Element => (
          <ModelCard model={model} theme={props.theme} multiple={props.agent.models.length > 1} />
        )}
      </For>
    </box>
  )
}

const StatusPanel = (props: PanelInput & { readonly context: Context }): JSX.Element => {
  const ctx: Context = props.context
  const status: Context["data"]["session"]["status"] = (id: string): "running" | "idle" =>
    ctx.data.session.status(id)
  const [view, setView] = createSignal<View>({ _tag: "Loading" })
  const snapshot: Accessor<Snapshot> = (): Snapshot => {
    const current: View = view()
    return current._tag === "Ready" ? current.snapshot : { agents: [], cost: 0 }
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
    commands: [{ bind: "escape", title: "Close agents status", run: props.close }],
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
        <text fg={ctx.theme.text.base}>
          <b>Agents status</b>
        </text>
        <text fg={ctx.theme.text.muted} onMouseDown={props.close}>×</text>
      </box>
      <scrollbox flexGrow={1} flexBasis={0} minHeight={0} focused={props.focused}>
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
        <For each={snapshot().agents}>
          {(agent: AgentSummary): JSX.Element => (
            <AgentCard agent={agent} theme={ctx.theme} status={status} />
          )}
        </For>
      </scrollbox>
      <text fg={ctx.theme.text.base} flexShrink={0} height={1}>
        Total reported spend: {money.format(snapshot().cost)}
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
