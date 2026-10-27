# Agent reminders

The local `agent-reminders` server plugin recalls an agent's prompt obligations at deterministic intervals. It does not block tools, force delegation, or assess whether a task should be delegated.

## Configuration

No agent receives reminders until explicitly configured. Add the following object as an entry in the active OpenCode configuration's `plugins` array. Replace the package path with the absolute path to this package directory:

```json
{
  "package": "/absolute/path/to/agents-config/harnesses/opencode/plugins/agent-reminders",
  "options": {
    "agents": {
      "Orchestrator": [
        {
          "message": "Remember your prompt. Respect its delegation requirements.",
          "resetTools": ["subagent"],
          "condition": {
            "type": "any",
            "conditions": [
              { "type": "toolCalls", "count": 5 },
              { "type": "contextGrowth", "tokens": 20000 },
              { "type": "contextUtilizationGrowth", "percentagePoints": 5 }
            ]
          }
        }
      ]
    }
  }
}
```

The thresholds above are examples, not an automatically enabled policy. Every configured agent type maps to an array of entries; each entry carries its own message, reset tools, and root condition, and runs a fully independent interval. Agent names match the configured OpenCode role names.

| Field | Type | Meaning |
| --- | --- | --- |
| `message` | nonempty string | Reminder text injected into the system prompt. |
| `resetTools` | array of tool references, optional | Tools whose invocation resets this entry's interval. Defaults to `["subagent"]`; an explicit `[]` disables tool-based resets for the entry. |
| `condition` | condition | The delivery condition; see the table below. |

| Condition type | Fields | Meaning |
| --- | --- | --- |
| `toolCalls` | `count`, optional `tools` | Matching tool invocations since reset. Outer tool calls count once; calls nested inside `execute` count under their own registered tool names when selected. Failed calls count. `tools` accepts exact names or trailing-`*` prefix patterns and defaults to `["shell"]`. The `execute` wrapper is excluded by default; select it explicitly to count wrapper calls. |
| `elapsedTime` | `seconds` | Wall-clock time since reset. Idle sessions are not awakened; the condition is checked when the agent next continues. |
| `contextGrowth` | `tokens` | Growth in reported occupied context since the baseline. |
| `contextUtilizationGrowth` | `percentagePoints` | Token growth divided by the current model's context limit, multiplied by 100. Five percentage points means growth from 10% to 15%, not a 5% relative increase. |
| `all` | `conditions` | Every child condition must match. |
| `any` | `conditions` | At least one child condition must match. |

Thresholds are inclusive and positive. Tool-call counts are integers. Composite conditions have nonempty child lists and may nest arbitrarily. Unknown types, fields, and malformed expressions are configuration errors.

For example, require both ten minutes and either five matching tool calls or 20,000 additional context tokens:

```json
{
  "type": "all",
  "conditions": [
    { "type": "elapsedTime", "seconds": 600 },
    {
      "type": "any",
      "conditions": [
        { "type": "toolCalls", "count": 5 },
        { "type": "contextGrowth", "tokens": 20000 }
      ]
    }
  ]
}
```

### Tool references

Tool references in `tools` and `resetTools` are exact tool names or prefix patterns ending in `*`, matched case-sensitively (a `*` never appears in real tool names). Prefix characters are letters, digits, underscores, and hyphens: `["mcp-metals_*"]`, `["browser_*"]`.

A tool or pattern may not be both counted and reset within one entry; such a configuration is rejected when the plugin loads.

## Intervals and delivery

- Each entry runs a fully independent interval with its own tool counters, context baseline, and elapsed-time clock.
- First observation establishes the current timestamp and context baseline. Existing context and initial instructions do not count toward growth.
- An entry's `resetTools` reset only that entry: fresh counters, and the context baseline moves to the latest known sample. Delivering a reminder resets only the matched entry.
- Switching agent types resets all entries and discards known context samples. The first usable context sample for the new agent establishes its baseline; switching back also starts fresh.
- Successful compaction clears the context baseline and latest sample across entries while preserving tool counts and elapsed time; measurements rebase on the first usable post-compaction sample.
- Counters are in memory only. Plugin reloads and service restarts establish fresh intervals.
- Delivery attaches the reminder only to the system prompt of the next ordinary model request, exactly once. It does not interrupt tools, add user turns, publish a session notice, or start another model run.
- Every delivery logs an `Agent reminder injected` info log annotated with sessionID, agent, providerID, modelID, and firedAt.
- Loading the plugin with no agents configured logs a warning and disables all reminders.

Context measurements use reported assistant token usage, including cache usage, rather than cumulative session billing totals. They lag the next outgoing request. Missing usage or model limits cannot establish a match for conditions requiring those measurements. Percentage-point growth uses the current model's configured context limit; switching models does not itself add context tokens.

### Tool names

Built-in tools: `read`, `edit`, `write`, `patch` (GPT models only), `glob`, `grep`, `shell`, `webfetch`, `websearch` (needs a configured search provider), `question`, `skill`, `subagent`, and the Code Mode wrapper `execute`. `shell`, `read`, and `subagent` are direct built-ins and do not run inside `execute`. OpenCode's built-in `opencode_*` tools are `opencode_session_rename`, `opencode_session_move`, `opencode_worktree_create`, `opencode_worktree_list`, `opencode_worktree_remove`, `opencode_models`, `opencode_list_mcp_resources`, and `opencode_read_mcp_resource`. MCP tools are named `<server-key>_<tool>` with characters outside `a-zA-Z0-9_-` replaced by `_`. Custom tools use their registered names. MCP and custom tools can run nested inside `execute` (code mode); nested calls report their own registered names and count when those names or matching patterns are selected in `tools`.

## Registration and development checks

OpenCode loads the registered local package directory directly. The plugin uses the `effect` and `@opencode/plugin` modules provided by the OpenCode host; installing dependencies is not required to use it.

For development checks, run `bun install` from this package directory, then run:

```sh
bun test
bun run check
bun run format:check
```
