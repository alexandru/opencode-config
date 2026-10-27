# Agent reminders

The local `agent-reminders` server plugin recalls an agent's prompt obligations at deterministic intervals. It does not block tools, force delegation, or assess whether a task should be delegated.

## Configuration

No agent receives reminders until explicitly configured. Add the following object as an entry in the active OpenCode configuration's `plugins` array. Replace the package path with the absolute path to this package directory:

```json
{
  "package": "/absolute/path/to/agents-config/harnesses/opencode/plugins/agent-reminders",
  "options": {
    "agents": {
      "Orchestrator": {
        "message": "Remember your prompt. Respect its delegation requirements.",
        "condition": {
          "type": "any",
          "conditions": [
            { "type": "toolCalls", "count": 5 },
            { "type": "contextGrowth", "tokens": 20000 },
            { "type": "contextUtilizationGrowth", "percentagePoints": 5 }
          ]
        }
      }
    }
  }
}
```

The thresholds above are examples, not an automatically enabled policy. Every configured agent type has its own message and one root condition. Agent names match the configured OpenCode role names.

| Condition type | Fields | Meaning |
| --- | --- | --- |
| `toolCalls` | `count`, optional `tools` | Matching outer tool invocations since reset. `tools` defaults to `["shell", "execute"]`. Failed calls count. A single `execute` containing several nested tool calls counts only once. |
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

## Intervals and delivery

- First observation establishes the current timestamp and context baseline. Existing context and initial instructions do not count toward growth.
- Any subagent delegation or delivered reminder resets all measurements together. Delegation inside `execute` resets the interval too.
- Switching agent types discards the old interval and known context sample. The first usable context sample for the new agent establishes its baseline; switching back also starts fresh.
- Successful compaction rebases context measurements on the first usable post-compaction sample, preserving tool counts and elapsed time.
- Counters are in memory only. Plugin reloads and service restarts establish fresh intervals.
- Reminders are attached to the next ordinary model request after foreground work finishes. They do not interrupt tools, add user turns, or start another model run.

Context measurements use reported assistant token usage, including cache usage, rather than cumulative session billing totals. They lag the next outgoing request. Missing usage or model limits cannot establish a match for conditions requiring those measurements. Percentage-point growth uses the current model's configured context limit; switching models does not itself add context tokens.

## Registration and development checks

OpenCode loads the registered local package directory directly. The plugin uses the `effect` and `@opencode/plugin` modules provided by the OpenCode host; installing dependencies is not required to use it.

For development checks, run `bun install` from this package directory, then run:

```sh
bun test
bun run check
bun run format:check
```
