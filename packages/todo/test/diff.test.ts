import { expect, test } from "bun:test"
import { Schema } from "effect"
import { diffTodos } from "../src/diff.ts"
import { type Todo, Todos } from "../src/model.ts"

type Entry = readonly [content: string, status: Todo["status"], priority: Todo["priority"]]

const list = (entries: ReadonlyArray<Entry>): Todos =>
  Schema.decodeUnknownSync(Todos)(
    entries.map(
      ([content, status, priority]): {
        content: string
        status: Todo["status"]
        priority: Todo["priority"]
      } => ({ content, status, priority }),
    ),
  )

test("identical lists produce an empty diff", (): void => {
  const todos: Todos = list([["Alpha", "pending", "high"]])
  expect(diffTodos(todos, todos)).toBe("")
})

test("an added task appears as a plus line", (): void => {
  const previous: Todos = list([["Alpha", "pending", "high"]])
  const next: Todos = list([["Alpha", "pending", "high"], ["Beta", "pending", "medium"]])
  expect(diffTodos(previous, next)).toBe("+ [pending|medium] Beta")
})

test("a removed task appears as a minus line", (): void => {
  const previous: Todos = list([["Alpha", "pending", "high"], ["Beta", "pending", "medium"]])
  const next: Todos = list([["Alpha", "pending", "high"]])
  expect(diffTodos(previous, next)).toBe("- [pending|medium] Beta")
})

test("a status change reports the old line then the new line", (): void => {
  const previous: Todos = list([["Alpha", "pending", "high"]])
  const next: Todos = list([["Alpha", "in_progress", "high"]])
  expect(diffTodos(previous, next)).toBe("- [pending|high] Alpha\n+ [in_progress|high] Alpha")
})

test("a reorder reports the unmatched line as removed then added", (): void => {
  const previous: Todos = list([["Alpha", "pending", "high"], ["Beta", "pending", "medium"]])
  const next: Todos = list([["Beta", "pending", "medium"], ["Alpha", "pending", "high"]])
  expect(diffTodos(previous, next)).toBe("- [pending|high] Alpha\n+ [pending|high] Alpha")
})

test("rotating three tasks reports only the moved task", (): void => {
  const previous: Todos = list([
    ["Alpha", "pending", "high"],
    ["Beta", "pending", "medium"],
    ["Gamma", "pending", "low"],
  ])
  const next: Todos = list([
    ["Beta", "pending", "medium"],
    ["Gamma", "pending", "low"],
    ["Alpha", "pending", "high"],
  ])
  expect(diffTodos(previous, next)).toBe("- [pending|high] Alpha\n+ [pending|high] Alpha")
})

test("clearing the list removes every line", (): void => {
  const previous: Todos = list([["Alpha", "pending", "high"], ["Beta", "completed", "low"]])
  expect(diffTodos(previous, list([]))).toBe("- [pending|high] Alpha\n- [completed|low] Beta")
})

test("lists too large for the search fall back to whole-list replacement", (): void => {
  const count: number = 1025
  const removed: Entry[] = []
  const added: Entry[] = []
  for (let index: number = 0; index < count; index += 1) {
    removed.push([`Old ${index}`, "pending", "high"])
    added.push([`New ${index}`, "pending", "high"])
  }
  const lines: string[] = diffTodos(list(removed), list(added)).split("\n")
  expect(lines).toHaveLength(count * 2)
  expect(lines[0]).toBe("- [pending|high] Old 0")
  expect(lines[count - 1]).toBe("- [pending|high] Old 1024")
  expect(lines[count]).toBe("+ [pending|high] New 0")
  expect(lines[lines.length - 1]).toBe("+ [pending|high] New 1024")
})
