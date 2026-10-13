import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { type TodoError, Todos } from "../src/model.ts"
import { type Document, parse, render } from "../src/todotxt.ts"

test("priority prefixes, metadata, and defaults decode consistently", async (): Promise<void> => {
  const document: Document = await Effect.runPromise(parse(
    "(A) High\nMedium\nLow pri:C\nx Done pri:B\nExplicit pri:A status:pending\n",
  ))
  const expected: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "High", status: "pending", priority: "high" },
    { content: "Medium", status: "pending", priority: "medium" },
    { content: "Low", status: "pending", priority: "low" },
    { content: "Done", status: "completed", priority: "medium" },
    { content: "Explicit", status: "pending", priority: "high" },
  ])
  expect(document.todos).toEqual(expected)
})

test("duplicate metadata and unsupported priorities retain their errors", async (): Promise<void> => {
  const cases: readonly { readonly line: string; readonly message: string }[] = [
    { line: "(A) Task pri:B", message: "Duplicate priority" },
    { line: "Task pri:B pri:C", message: "Duplicate priority" },
    { line: "Task status:pending status:pending", message: "Duplicate status: token" },
    { line: "Task status: status:pending", message: "Duplicate status: token" },
    { line: "(D) Task", message: "Supported todo.txt priorities are A, B, and C" },
    { line: "Task pri:D", message: "Supported todo.txt priorities are A, B, and C" },
  ]
  for (const { line, message } of cases) {
    const error: TodoError = await Effect.runPromise(Effect.flip(parse(line)))
    expect(error.message).toBe(`todo.txt line 1: ${message}`)
  }
})

test("duplicate task text preserves dates in occurrence order without mutating previous records", async (): Promise<void> => {
  const previous: Document = await Effect.runPromise(parse(
    "(A) 2026-10-01 Repeated\n"
      + "(B) 2026-10-02 Other\n"
      + "x 2026-10-04 2026-10-03 Repeated pri:C\n"
      + "(B) 2026-10-05 Repeated\n",
  ))
  const todos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Repeated", status: "pending", priority: "high" },
    { content: "Other", status: "pending", priority: "medium" },
    { content: "Repeated", status: "completed", priority: "low" },
    { content: "Repeated", status: "cancelled", priority: "medium" },
    { content: "Repeated", status: "pending", priority: "low" },
  ])
  const expected: string = "(A) 2026-10-01 Repeated\n"
    + "(B) 2026-10-02 Other\n"
    + "x 2026-10-04 2026-10-03 Repeated pri:C\n"
    + "x 2026-10-13 2026-10-05 Repeated pri:B status:cancelled\n"
    + "(C) Repeated\n"
  expect(render(todos, previous.records, "2026-10-13")).toBe(expected)
  expect(render(todos, previous.records, "2026-10-13")).toBe(expected)
  expect(previous.records).toHaveLength(4)
})

test("rendering an empty list produces no newline", (): void => {
  const todos: Todos = Schema.decodeUnknownSync(Todos)([])
  expect(render(todos, [], "2026-10-13")).toBe("")
})

test("completion-only dates survive closed transitions but not reopening", async (): Promise<void> => {
  const previous: Document = await Effect.runPromise(parse("x 2026-10-04 Task pri:A\n"))
  const cases: readonly {
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly text: string
  }[] = [
    { status: "pending", text: "(A) Task\n" },
    { status: "in_progress", text: "(A) Task status:in_progress\n" },
    { status: "completed", text: "x 2026-10-04 Task pri:A\n" },
    { status: "cancelled", text: "x 2026-10-04 Task pri:A status:cancelled\n" },
  ]
  for (const { status, text } of cases) {
    const todos: Todos = Schema.decodeUnknownSync(Todos)([
      { content: "Task", status, priority: "high" },
    ])
    expect(render(todos, previous.records, "2026-10-13")).toBe(text)
  }
})
