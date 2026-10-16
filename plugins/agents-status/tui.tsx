/** @jsxImportSource @opentui/solid */
import type { ModelInfo, ModelRef, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

interface Entry {
  readonly session: SessionInfo
  readonly depth: number
  readonly model: ModelRef | undefined
  readonly selected: ModelRef | undefined
  readonly context: Usage | undefined
  readonly usageUnavailable: boolean
}

interface Usage {
  readonly model: ModelRef
  readonly tokens: number
  readonly limit: number | undefined
  readonly percent: number | undefined
}

interface ModelGroup {
  readonly label: string
  readonly entries: readonly Entry[]
  readonly selected: readonly string[]
  readonly context: Usage | undefined
  readonly usageUnavailable: boolean
}

interface AgentGroup {
  readonly name: string
  readonly entries: readonly Entry[]
  readonly main: boolean
  readonly cost: number
  readonly models: readonly ModelGroup[]
}

const number = new Intl.NumberFormat("en-US")
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

function contextUsage(
  messages: readonly SessionMessageInfo[],
  models: readonly ModelInfo[],
  boundary: string | undefined,
): Usage | undefined {
  const end = boundary ? messages.findIndex((message) => message.id === boundary) : messages.length
  if (end < 0) return undefined
  const compaction = messages.findLastIndex(
    (message, index) =>
      index < end && message.type === "compaction" && message.status === "completed",
  )
  const last = messages.findLast(
    (message, index) =>
      index < end && index > compaction && message.type === "assistant"
      && message.tokens !== undefined,
  )
  if (last?.type !== "assistant" || last.tokens === undefined) return undefined
  const usage = last.tokens
  const tokens = usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
  if (tokens <= 0) return undefined
  const limit = models.find((model) =>
    model.providerID === last.model.providerID && model.id === last.model.id
  )?.limit.context
  return {
    model: last.model,
    tokens,
    limit,
    percent: limit && limit > 0 ? Math.round(tokens / limit * 100) : undefined,
  }
}

function usageLabel(usage: Usage | undefined): string {
  if (!usage) return "unknown"
  return usage.percent !== undefined && usage.limit !== undefined
    ? `${number.format(usage.tokens)} / ${number.format(usage.limit)} tokens (${usage.percent}%)`
    : `${number.format(usage.tokens)} tokens (limit unknown)`
}

function usageBar(percent: number): string {
  const filled = Math.max(0, Math.min(12, Math.round(percent / 100 * 12)))
  return "━".repeat(filled) + "╌".repeat(12 - filled)
}

function modelLabel(model: ModelRef | undefined): string {
  return model
    ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
    : "unknown"
}

function peakUsage(entries: readonly Entry[]): Usage | undefined {
  return entries.reduce<Usage | undefined>((peak, entry) => {
    const usage = entry.context
    if (!usage) return peak
    if (!peak) return usage
    const rank = usage.percent ?? -1
    const previous = peak.percent ?? -1
    return rank > previous || rank === previous && usage.tokens > peak.tokens ? usage : peak
  }, undefined)
}

function groupAgents(entries: readonly Entry[]): readonly AgentGroup[] {
  const agents = new Map<string, Entry[]>()
  for (const entry of entries) {
    const name = entry.session.agent ?? "Unknown agent"
    const group = agents.get(name)
    if (group) group.push(entry)
    else agents.set(name, [entry])
  }
  return Array.from(agents, ([name, sessions]): AgentGroup => {
    const models = new Map<string, Entry[]>()
    const contexts = new Map<string, Entry[]>()
    for (const entry of sessions) {
      const label = modelLabel(entry.model)
      const group = models.get(label)
      if (group) group.push(entry)
      else models.set(label, [entry])
      if (entry.context) {
        const source = modelLabel(entry.context.model)
        const samples = contexts.get(source)
        if (samples) samples.push(entry)
        else contexts.set(source, [entry])
      }
    }
    return {
      name,
      entries: sessions,
      main: sessions.some((entry) => entry.depth === 0),
      cost: sessions.reduce((total, entry) => total + entry.session.cost, 0),
      models: Array.from(new Set([...models.keys(), ...contexts.keys()]), (label): ModelGroup => {
        const members = models.get(label) ?? []
        const samples = contexts.get(label) ?? []
        return {
          label,
          entries: members,
          selected: Array.from(
            new Set(members.flatMap((entry) => entry.selected ? [modelLabel(entry.selected)] : [])),
          ),
          context: peakUsage(samples),
          usageUnavailable: [...members, ...samples].some((entry) => entry.usageUnavailable),
        }
      }),
    }
  })
}

async function loadMessages(
  ctx: Context,
  session: SessionInfo,
  signal: AbortSignal,
): Promise<readonly SessionMessageInfo[]> {
  let messages: SessionMessageInfo[] = []
  let cursor: string | undefined
  do {
    const page = await ctx.client.message.list({
      sessionID: session.id,
      limit: 100,
      order: "desc",
      cursor,
    }, { signal })
    messages = [...page.data.toReversed(), ...messages]
    const boundary = session.revert?.messageID
    const end = boundary
      ? messages.findIndex((message) => message.id === boundary)
      : messages.length
    if (
      end >= 0 && messages.some((message, index) =>
        index < end && (
          message.type === "assistant" && message.tokens !== undefined
          || message.type === "compaction" && message.status === "completed"
        )
      )
    ) return messages
    cursor = page.cursor.next ?? undefined
  } while (cursor && !signal.aborted)
  return messages
}

function StatusPanel(props: PanelInput & { readonly context: Context }): JSX.Element {
  const ctx = props.context
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  const groups = createMemo(() => groupAgents(entries()))
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()

  ctx.keymap.layer(() => ({
    mode: "global",
    enabled: props.focused,
    commands: [{ bind: "escape", title: "Close agents status", run: props.close }],
  }))

  createEffect(() => {
    const sessionID = props.sessionID
    const controller = new AbortController()
    const options = { signal: controller.signal }
    let refreshing = false
    setEntries([])
    setLoading(true)
    setError(undefined)

    const refresh = async (): Promise<void> => {
      if (refreshing || controller.signal.aborted) return
      refreshing = true
      try {
        const root = await ctx.client.session.get({ sessionID }, options)
        const tree: Array<{ session: SessionInfo; depth: number }> = [{ session: root, depth: 0 }]
        const seen = new Set([root.id])
        for (let index = 0; index < tree.length; index++) {
          const parent = tree[index]
          if (!parent) continue
          let cursor: string | undefined
          do {
            const page = await ctx.client.session.list({
              parentID: parent.session.id,
              limit: 200,
              order: "asc",
              cursor,
            }, options)
            for (const child of page.data) {
              if (child.parentID !== parent.session.id || seen.has(child.id)) continue
              seen.add(child.id)
              tree.push({ session: child, depth: parent.depth + 1 })
            }
            cursor = page.cursor.next ?? undefined
          } while (cursor && !controller.signal.aborted)
        }
        const catalogs = new Map<
          string,
          Promise<{ data: readonly ModelInfo[]; unavailable: boolean }>
        >()
        const next = await Promise.all(tree.map(async ({ session, depth }): Promise<Entry> => {
          const key = session.location.directory
          let catalog = catalogs.get(key)
          if (!catalog) {
            catalog = ctx.client.model.list({ location: session.location }, options)
              .then((page) => ({ data: page.data, unavailable: false }))
              .catch(() => ({ data: [], unavailable: true }))
            catalogs.set(key, catalog)
          }
          const [page, models] = await Promise.all([
            loadMessages(ctx, session, controller.signal)
              .then((data) => ({ data, unavailable: false }))
              .catch(() => ({ data: [], unavailable: true })),
            catalog,
          ])
          const messages = page.data
          const assistant = messages.findLast((message) => message.type === "assistant")
          return {
            session,
            depth,
            model: assistant?.type === "assistant"
              ? assistant.model
              : page.unavailable
              ? undefined
              : session.model,
            selected: session.model && (page.unavailable || assistant?.type === "assistant"
                  && modelLabel(assistant.model) !== modelLabel(session.model))
              ? session.model
              : undefined,
            context: contextUsage(messages, models.data, session.revert?.messageID),
            usageUnavailable: page.unavailable || models.unavailable,
          }
        }))
        if (!controller.signal.aborted) {
          setEntries(next)
          setError(undefined)
        }
      } catch (cause: unknown) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        refreshing = false
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    onCleanup(() => {
      controller.abort()
      clearInterval(timer)
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
        <Show when={loading()}>
          <text fg={ctx.theme.text.muted}>Loading agents…</text>
        </Show>
        <Show when={error()}>
          <text fg={ctx.theme.text.feedback.error.base}>
            Refresh failed (values may be stale): {error()}
          </text>
        </Show>
        <For each={groups()}>
          {(group): JSX.Element => {
            const running = (): number =>
              group.entries.filter((entry) =>
                ctx.data.session.status(entry.session.id) === "running"
              ).length
            const failed = (): number =>
              group.entries.filter((entry) =>
                entry.session.outcome === "failed" || entry.session.outcome === "interrupted"
              ).length
            const statusColor = () =>
              running() > 0
                ? ctx.theme.text.feedback.warning.base
                : failed() > 0
                ? ctx.theme.text.feedback.error.base
                : group.entries.every((entry) => entry.session.outcome === "succeeded")
                ? ctx.theme.text.feedback.success.base
                : ctx.theme.text.muted
            return (
              <box
                flexDirection="column"
                flexShrink={0}
                marginTop={1}
                border={["left"]}
                borderColor={statusColor()}
                paddingLeft={1}
                paddingRight={1}
              >
                <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                  <text fg={ctx.theme.text.base}>
                    <span style={{ fg: statusColor() }}>{"● "}</span>
                    <b>{group.name}</b>
                    <span style={{ fg: ctx.theme.text.muted }}>
                      {group.main ? " · main" : ""}
                    </span>
                  </text>
                  <text fg={ctx.theme.text.muted} flexShrink={0}>
                    Spent: {money.format(group.cost)}
                  </text>
                </box>
                <text fg={statusColor()}>
                  {running()} running · {group.entries.length}{" "}
                  {group.entries.length === 1 ? "session" : "sessions"}
                  {failed() > 0 ? ` · ${failed()} failed/interrupted` : ""}
                </text>
                <For each={group.models}>
                  {(model): JSX.Element => {
                    const usageColor = () =>
                      (model.context?.percent ?? 0) >= 90
                        ? ctx.theme.text.feedback.error.base
                        : (model.context?.percent ?? 0) >= 75
                        ? ctx.theme.text.feedback.warning.base
                        : ctx.theme.text.feedback.info.base
                    return (
                      <box
                        flexDirection="column"
                        flexShrink={0}
                        marginTop={group.models.length > 1 ? 1 : 0}
                      >
                        <text fg={ctx.theme.text.base}>
                          {model.entries.length > 0 ? "Model: " : "Context model: "}
                          {model.label}
                        </text>
                        <Show when={group.models.length > 1 && model.entries.length > 0}>
                          <text fg={ctx.theme.text.muted}>
                            {model.entries.length}{" "}
                            {model.entries.length === 1 ? "session" : "sessions"}
                          </text>
                        </Show>
                        <Show when={model.selected.length > 0}>
                          <text fg={ctx.theme.text.muted}>
                            Selected: {model.selected.join(", ")}
                          </text>
                        </Show>
                        <text fg={ctx.theme.text.muted}>
                          Peak context: {usageLabel(model.context)}
                        </text>
                        <Show when={model.usageUnavailable}>
                          <text fg={ctx.theme.text.feedback.warning.base}>
                            Context data unavailable
                          </text>
                        </Show>
                        <Show when={model.context?.percent !== undefined}>
                          <text fg={usageColor()}>{usageBar(model.context?.percent ?? 0)}</text>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )
          }}
        </For>
      </scrollbox>
      <text fg={ctx.theme.text.base} flexShrink={0} height={1}>
        Total reported spend:{" "}
        {money.format(entries().reduce((total, entry) => total + entry.session.cost, 0))}
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "agents-status",
  setup(ctx): () => void {
    const release = ctx.ui.slot({
      append: "session.panel",
      render: (props): JSX.Element => (
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
        run: (): void => {
          if (ctx.ui.panel.current()?.name === "agents-status") ctx.ui.panel.close()
          else ctx.ui.panel.open("agents-status")
        },
      }],
    }))
    return release
  },
})
