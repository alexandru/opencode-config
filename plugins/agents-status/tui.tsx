/** @jsxImportSource @opentui/solid */
import type { TokenUsageInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
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
  emptySpend,
  type ModelSummary,
  type RequestFailure,
  type SessionSummary,
  type Snapshot,
  type SpendAmount,
  type SpendAttribution,
  type SpendRow,
  type SpendSource,
  type SpendTotal,
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
    onNone: () => unavailable,
    onSome: (value) =>
      `↑ ${compact.format(value.input)} · ↓ ${compact.format(value.output)} · ↺ ${
        compact.format(value.cache.read)
      }`,
  })

const usageLabel = (usage: Option.Option<Utilization>): string =>
  Option.match(usage, {
    onNone: () => "unknown",
    onSome: (value) =>
      Option.match(value.limit, {
        onNone: () => `${compact.format(value.tokens)} tokens (limit unknown)`,
        onSome: (limit) =>
          `${compact.format(value.tokens)} / ${compact.format(limit)} tokens (${
            contextPercent(value.tokens, limit)
          }%)`,
      }),
  })

const spendSourceLabel = (source: SpendSource): string =>
  source._tag === "Unattributed" ? "Unattributed" : `${source.model.providerID}/${source.model.id}`

const attributionMark = (attribution: SpendAttribution): string =>
  attribution._tag === "MixedModelSession" ? " (!)" : ""

const spendAmountLabel = (amount: SpendAmount, attribution: SpendAttribution): string =>
  amount._tag === "Estimated"
    ? `${money.format(amount.usd)}${attributionMark(attribution)}`
    : `unavailable · ${amount.reason}`

const spendTotalLabel = (total: SpendTotal, attribution: SpendAttribution): string => {
  switch (total._tag) {
    case "Estimated":
      return `${money.format(total.usd)}${attributionMark(attribution)}`
    case "Partial":
      return `${money.format(total.usd)}${attributionMark(attribution)} (recorded usage)`
    case "Unavailable":
      return "unavailable"
  }
}

interface ModelSpend {
  readonly model: ModelSummary
  readonly spend: Option.Option<SpendRow>
}

interface SpendLayout {
  readonly models: ReadonlyArray<ModelSpend>
  readonly unmatched: ReadonlyArray<SpendRow>
}

const spendRowKey = (row: SpendRow): Option.Option<string> =>
  row.source._tag === "Model"
    ? Option.some(`${row.source.model.providerID}/${row.source.model.id}`)
    : Option.none()

const matchesModelLabel = (label: string, key: string): boolean =>
  label === key || label.startsWith(`${key}#`)

const modelSpendLayout = (
  models: ReadonlyArray<ModelSummary>,
  rows: ReadonlyArray<SpendRow>,
): SpendLayout => {
  const assigned: Set<SpendRow> = new Set()
  const entries: ReadonlyArray<ModelSpend> = models.map((model): ModelSpend => {
    const available = rows.filter((row) => !assigned.has(row))
    const exact = available.find((row) =>
      Option.match(spendRowKey(row), {
        onNone: () => false,
        onSome: (key) => model.label === key,
      })
    )
    const match = exact ?? available.find((row) =>
      Option.match(spendRowKey(row), {
        onNone: () => false,
        onSome: (key) => matchesModelLabel(model.label, key),
      })
    )
    if (match === undefined) return { model, spend: Option.none() }
    assigned.add(match)
    return { model, spend: Option.some(match) }
  })
  return {
    models: entries,
    unmatched: rows.filter((row) => !assigned.has(row) && row.source._tag === "Model"),
  }
}

const SpendRowView = (
  props: {
    readonly row: SpendRow
    readonly theme: ResolvedTheme
  },
): JSX.Element => (
  <text
    fg={props.row.amount._tag === "Estimated"
      ? props.theme.text.muted
      : props.theme.text.feedback.warning.base}
  >
    ¤ {spendAmountLabel(props.row.amount, props.row.attribution)} ·{" "}
    {tokensLabel(Option.some(props.row.tokens), "tokens unavailable")}
  </text>
)

const ModelCard = (
  props: {
    readonly model: ModelSummary
    readonly spend: Option.Option<SpendRow>
    readonly theme: ResolvedTheme
    readonly multiple: boolean
  },
): JSX.Element => {
  const sample = () =>
    props.model._tag === "Context" ? Option.some(props.model.usage) : props.model.usage
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
      <text fg={props.theme.text.muted}>◇ {usageLabel(sample())}</text>
      <Show when={props.model.unavailable}>
        <text fg={props.theme.text.feedback.warning.base}>Context data unavailable</text>
      </Show>
      <Show when={Option.getOrUndefined(props.spend)}>
        {(row: Accessor<SpendRow>): JSX.Element => <SpendRowView row={row()} theme={props.theme} />}
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
  const running = createMemo(() =>
    props.agent.sessions.reduce(
      (total, id) => total + Number(props.status(id) === "running"),
      0,
    )
  )
  const color = () =>
    running() > 0
      ? props.theme.text.feedback.warning.base
      : props.agent.failed > 0
      ? props.theme.text.feedback.error.base
      : props.agent.succeeded === props.agent.sessions.length
      ? props.theme.text.feedback.success.base
      : props.theme.text.muted
  const spendLayout = createMemo(() => modelSpendLayout(props.agent.models, props.agent.spend.rows))
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
            <b>{Option.getOrElse(session().title, () => session().id)}</b>
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
                : Option.getOrElse(session().outcome, () => "idle")}
            </text>
          </>
        )}
      </Show>
      <For each={spendLayout().models}>
        {(entry: ModelSpend): JSX.Element => (
          <ModelCard
            model={entry.model}
            spend={entry.spend}
            theme={props.theme}
            multiple={props.agent.models.length > 1}
          />
        )}
      </For>
      <For each={spendLayout().unmatched}>
        {(row: SpendRow, index: Accessor<number>): JSX.Element => (
          <box
            flexDirection="column"
            flexShrink={0}
            marginTop={props.agent.models.length > 0 || index() > 0 ? 1 : 0}
          >
            <text fg={props.theme.text.base}>Model: {spendSourceLabel(row.source)}</text>
            <SpendRowView row={row} theme={props.theme} />
          </box>
        )}
      </For>
      <Show when={props.agent.spend.usedModels > 1}>
        <text fg={props.theme.text.base} marginTop={1}>
          Estimated total: {spendTotalLabel(props.agent.spend.total, props.agent.spend.attribution)}
        </text>
      </Show>
    </box>
  )
}

const StatusPanel = (props: PanelInput & { readonly context: Context }): JSX.Element => {
  const ctx = props.context
  const status = (id: string) => ctx.data.session.status(id)
  const [view, setView] = createSignal<View>({ _tag: "Loading" })
  const [tab, setTab] = createSignal<StatusTab>("agents")
  const switchTab = () => {
    setTab((current) => current === "agents" ? "sessions" : "agents")
  }
  const snapshot = (): Snapshot => {
    const current = view()
    return current._tag === "Ready"
      ? current.snapshot
      : { agents: [], sessions: [], spend: emptySpend, tokens: Option.none() }
  }
  const error = (): Option.Option<RequestFailure> => {
    const current = view()
    switch (current._tag) {
      case "Loading":
        return Option.none()
      case "Failed":
        return Option.some(current.error)
      case "Ready":
        return current.error
    }
  }
  ctx.keymap.layer(() => ({
    mode: "global",
    enabled: props.focused,
    commands: [
      { bind: "escape", title: "Close agents status", run: props.close },
      { bind: "left", title: "Previous status tab", run: switchTab },
      { bind: "right", title: "Next status tab", run: switchTab },
      {
        bind: "a",
        title: "Show agent totals",
        run: () => {
          setTab("agents")
        },
      },
      {
        bind: "s",
        title: "Show agent sessions",
        run: () => {
          setTab("sessions")
        },
      },
    ],
  }))
  createEffect(() => {
    setView({ _tag: "Loading" })
    const fiber = Effect.runFork(
      watch(
        () => ctx.client,
        props.sessionID,
        (result) => {
          setView((current) =>
            Result.match(result, {
              onSuccess: (value) => ({
                _tag: "Ready",
                snapshot: value,
                error: Option.none(),
              }),
              onFailure: (failure) =>
                current._tag === "Ready"
                  ? { ...current, error: Option.some(failure) }
                  : { _tag: "Failed", error: failure },
            })
          )
        },
      ),
    )
    onCleanup(() => {
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
                onMouseDown={() => {
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
        Estimated API spend: {spendTotalLabel(snapshot().spend.total, snapshot().spend.attribution)}
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
    const release = ctx.ui.slot({
      append: "session.panel",
      render: (props: PanelInput): JSX.Element => (
        <Show when={props.name === "agents-status"}>
          <StatusPanel {...props} context={ctx} />
        </Show>
      ),
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "agents-status",
        title: "Agents status",
        group: "Session",
        palette: true,
        slash: { name: "agents-status" },
        enabled: ctx.ui.router.current().type === "session",
        run: () => {
          if (ctx.ui.panel.current()?.name === "agents-status") ctx.ui.panel.close()
          else ctx.ui.panel.open("agents-status")
        },
      }],
    }))
    return release
  },
})
