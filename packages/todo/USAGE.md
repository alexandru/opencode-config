# Session TODOs

## Setup

```sh
make install-todo
opencode reload
```

Reopen the TUI after configuration changes. Plugin entry in `opencode.jsonc`:

```json
{ "package": "./packages/todo", "options": { "sidebarLimit": 5 } }
```

`sidebarLimit` is a positive integer, default **5**.

## Tools

- `todoread({})` reads the current session's tasks and file path. Missing files return an empty list.
- `todowrite({ previous, todos })` replaces the ordered list only when the stored list still equals `previous`; take `previous` from the latest `todoread` or `todowrite` result. A mismatch fails with an instruction to `todoread` and retry. The result reports a before/after diff. An empty `todos` array clears the list.

```json
{
  "previous": [],
  "todos": [
    { "content": "Run the tests", "status": "in_progress", "priority": "high" }
  ]
}
```

Statuses: `pending`, `in_progress`, `completed`, `cancelled`. Priorities: `high`, `medium`, `low`.
At most one task may be `in_progress`. Content must be one nonempty trimmed line,
cannot begin with a priority/date, and cannot contain `status:` or `pri:` tokens.

## TUI

- Click **TODO** or its `▼` / `▶` arrow to expand or collapse the sidebar list.
- Above `sidebarLimit` total tasks, the sidebar shows only unfinished tasks, capped at the limit,
  with the active task first.
- **Show all …**, `/todos`, or **Ctrl+P → Toggle session todos** opens the full scrollable panel.
- Close with **Close ×**, **Esc** while focused, or the same command-palette action.
- Each `todowrite` pops a toast with the before/after diff of the change.
- Manual file edits appear within two seconds. Collapsing does not change the tasks.

## Storage

```text
<project/worktree>/.agents/sessions/<session-id>/todo.txt
```

```text
(A) Run the tests status:in_progress
(B) Review the changes
x Read the docs pri:C
x Superseded approach pri:B status:cancelled
```

`A` / `B` / `C` map to high / medium / low; other priority letters are unsupported.
Add `.agents/sessions/` to your project's ignore rules to keep these files out of version control.

## Permissions

Both tools use `todowrite`. Writes require agent/session rules resolving to `allow`; `ask` and
`deny` are rejected. Approval prompts, saved approvals, and experimental policies are unsupported.
Read-only agents should deny `todowrite`.

## Commands

From `packages/todo`:

```sh
bun run check
bun test
bun run format       # dprint fmt
bun run format:check # dprint check
```
