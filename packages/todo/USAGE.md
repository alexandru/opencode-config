# OpenCode session TODOs

`todoread` / `todowrite` tools, a collapsible sidebar, and a scrollable `/todos` panel.

## Install

From this configuration repository:

```sh
make install-todo
```

Register the package in `opencode.jsonc`. Paths are relative to that configuration file:

```json
{
  "plugins": [
    { "package": "./packages/todo", "options": { "sidebarLimit": 5 } }
  ]
}
```

Run `opencode reload` and reopen the TUI. A string entry such as `"./packages/todo"`
uses the default options.

## Tools

`todoread({})` returns the current session's tasks and file path. A missing file means an empty list.
`todowrite` replaces the entire ordered list; an empty array clears it:

```json
{
  "todos": [
    { "content": "Implement +plugin @opencode", "status": "in_progress", "priority": "high" }
  ]
}
```

Statuses: `pending`, `in_progress`, `completed`, `cancelled`. Priorities: `high`, `medium`, `low`.
At most one task may be `in_progress`. Content must be one nonempty trimmed line,
cannot begin with a priority/date, and cannot contain `status:` or `pri:` tokens.

The plugin supplies RFC 2119 instructions to keep statuses current, verify work before marking it
complete, and reconcile the list before responding. Agents still have to call the tools; completion
is not automatic. Context instructions apply only when both tools are available.

## TUI

- Click the **TODO** heading or `▼` / `▶` arrow to expand or collapse the sidebar list.
- `sidebarLimit` is a positive integer, default **5**. Above that total list size, the sidebar shows
  only unfinished tasks, capped at the limit, with the active task first.
- **Show all …** opens the full scrollable panel. `/todos` or **Ctrl+P → Toggle session todos** also
  opens it.
- Close the panel with **Close ×**, **Esc** while focused, or the same command-palette action.
- Manual file edits appear within two seconds. Collapsing the sidebar does not change the tasks.

## Storage

```text
<project/worktree>/.agents/sessions/<session-id>/todo.txt
```

Each session has its own file. Session IDs are stable across title changes.
Add `.agents/sessions/` to your project's ignore rules if these files should stay out of version control.

```text
(A) Implement +plugin @opencode status:in_progress
(B) Run the tests
x Read the docs pri:C
x Superseded approach pri:B status:cancelled
```

`A` / `B` / `C` map to high / medium / low; unprioritized tasks default to medium.
Other priority letters are unsupported. Dates are retained for unchanged task content.
Malformed files and symlinked storage paths are rejected; writes atomically replace the file.
Concurrent whole-list updates are last-writer-wins. Session deletion does not remove the file.

## Permissions

Both tools use the `todowrite` catalog permission. Writes require agent/session rules resolving
to `allow`; `ask` and `deny` are rejected. OpenCode 2.0.27 does not expose approval prompts for custom
tools. Native saved approvals, approval hooks, and experimental policies are not evaluated by this
plugin. Read-only agents should explicitly deny `todowrite`.

## Development and extraction

From `packages/todo`:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run format       # dprint fmt
bun run format:check # dprint check
```

The package is self-contained. Copy this directory into a standalone repository and register its
path. It exports the server entrypoint, `./tui`, and `./rpc`. Before publishing, choose a package
name and license and remove `private: true` from `package.json`.
