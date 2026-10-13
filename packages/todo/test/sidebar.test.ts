import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Todos } from "../src/model.ts"
import { projectTodos, SidebarLimit, SidebarOptions, type TodoProjection } from "../src/sidebar.ts"

const decodeTodos = (input: unknown): Todos => Schema.decodeUnknownSync(Todos)(input)

const decodeOptions = (input: unknown): typeof SidebarOptions.Type =>
  Schema.decodeUnknownSync(SidebarOptions)(input)

const limit = (value: number): SidebarLimit => Schema.decodeUnknownSync(SidebarLimit)(value)

const rejects = (decode: () => unknown): void => {
  expect(decode).toThrow()
}

test("SidebarOptions defaults sidebarLimit to 5 and accepts a custom positive integer", (): void => {
  const fallback: number = decodeOptions({}).sidebarLimit
  expect(fallback).toBe(5)
  const custom: number = decodeOptions({ sidebarLimit: 3 }).sidebarLimit
  expect(custom).toBe(3)
})

test("the default limit bounds a six-task list to five rows", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Pending four", status: "pending", priority: "high" },
    { content: "Pending five", status: "pending", priority: "medium" },
    { content: "Pending six", status: "pending", priority: "low" },
  ])
  const visible: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Pending four", status: "pending", priority: "high" },
    { content: "Pending five", status: "pending", priority: "medium" },
  ])
  const projection: TodoProjection = projectTodos(todos, decodeOptions({}).sidebarLimit)
  expect(projection).toEqual({
    kind: "limited",
    items: visible,
    remaining: 6,
    total: 6,
  })
})

test("SidebarLimit and SidebarOptions reject zero, negative, fractional, string, and null limits", (): void => {
  const one: number = Schema.decodeUnknownSync(SidebarLimit)(1)
  const five: number = Schema.decodeUnknownSync(SidebarLimit)(5)
  expect(one).toBe(1)
  expect(five).toBe(5)
  rejects((): unknown => Schema.decodeUnknownSync(SidebarLimit)(0))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarLimit)(-2))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarLimit)(2.5))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarLimit)("3"))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarLimit)(null))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarOptions)(null))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarOptions)({ sidebarLimit: 0 }))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarOptions)({ sidebarLimit: -1 }))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarOptions)({ sidebarLimit: 1.5 }))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarOptions)({ sidebarLimit: "5" }))
  rejects((): unknown => Schema.decodeUnknownSync(SidebarOptions)({ sidebarLimit: null }))
})

test("an empty list projects as all with no remaining tasks", (): void => {
  const empty: Todos = decodeTodos([])
  expect(projectTodos(empty, limit(5))).toEqual({ kind: "all", items: [], remaining: 0 })
  expect(projectTodos(empty, "full")).toEqual({ kind: "all", items: [], remaining: 0 })
})

test("lists at or under the limit keep completed and cancelled tasks in original order", (): void => {
  const todos: Todos = decodeTodos([
    { content: "First pending", status: "pending", priority: "high" },
    { content: "Finished one", status: "completed", priority: "low" },
    { content: "Active task", status: "in_progress", priority: "medium" },
    { content: "Dropped one", status: "cancelled", priority: "high" },
    { content: "Second pending", status: "pending", priority: "low" },
  ])
  expect(projectTodos(todos, limit(5))).toEqual({ kind: "all", items: todos, remaining: 3 })
  expect(projectTodos(todos, "full")).toEqual({ kind: "all", items: todos, remaining: 3 })
  const under: Todos = decodeTodos([
    { content: "Only pending", status: "pending", priority: "medium" },
    { content: "Only completed", status: "completed", priority: "high" },
  ])
  expect(projectTodos(under, limit(5))).toEqual({ kind: "all", items: under, remaining: 1 })
})

test("one task over the limit filters terminal tasks and keeps unfinished order", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Finished one", status: "completed", priority: "low" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Dropped one", status: "cancelled", priority: "high" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Pending four", status: "pending", priority: "medium" },
  ])
  const visible: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Pending four", status: "pending", priority: "medium" },
  ])
  expect(projectTodos(todos, limit(5))).toEqual({
    kind: "limited",
    items: visible,
    remaining: 4,
    total: 6,
  })
})

test("an in_progress task beyond the limit is shown first", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Active task", status: "in_progress", priority: "high" },
  ])
  const visible: Todos = decodeTodos([
    { content: "Active task", status: "in_progress", priority: "high" },
    { content: "Pending one", status: "pending", priority: "high" },
  ])
  expect(projectTodos(todos, limit(2))).toEqual({
    kind: "limited",
    items: visible,
    remaining: 4,
    total: 4,
  })
})

test("pending tasks keep their original order after the active task", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Active task", status: "in_progress", priority: "medium" },
    { content: "Pending two", status: "pending", priority: "low" },
    { content: "Pending three", status: "pending", priority: "medium" },
    { content: "Finished one", status: "completed", priority: "high" },
  ])
  const visible: Todos = decodeTodos([
    { content: "Active task", status: "in_progress", priority: "medium" },
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "low" },
  ])
  expect(projectTodos(todos, limit(3))).toEqual({
    kind: "limited",
    items: visible,
    remaining: 4,
    total: 5,
  })
})

test("an active first task reserves its row before later pending tasks", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Active task", status: "in_progress", priority: "high" },
    { content: "Pending one", status: "pending", priority: "medium" },
    { content: "Pending two", status: "pending", priority: "low" },
    { content: "Pending three", status: "pending", priority: "medium" },
  ])
  expect(projectTodos(todos, limit(2))).toEqual({
    kind: "limited",
    items: todos.slice(0, 2),
    remaining: 4,
    total: 4,
  })
})

test("the visible rows are capped at the limit while remaining counts hidden unfinished tasks", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Pending four", status: "pending", priority: "high" },
    { content: "Pending five", status: "pending", priority: "medium" },
  ])
  const visible: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "low" },
  ])
  expect(projectTodos(todos, limit(3))).toEqual({
    kind: "limited",
    items: visible,
    remaining: 5,
    total: 5,
  })
})

test("an all-terminal list over the limit yields a limited projection with no items", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Finished one", status: "completed", priority: "high" },
    { content: "Dropped one", status: "cancelled", priority: "medium" },
    { content: "Finished two", status: "completed", priority: "low" },
  ])
  expect(projectTodos(todos, limit(2))).toEqual({
    kind: "limited",
    items: [],
    remaining: 0,
    total: 3,
  })
})

test("full mode keeps every task in original order beyond the limit", (): void => {
  const todos: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Finished one", status: "completed", priority: "low" },
    { content: "Active task", status: "in_progress", priority: "medium" },
    { content: "Dropped one", status: "cancelled", priority: "high" },
    { content: "Pending two", status: "pending", priority: "low" },
    { content: "Finished two", status: "completed", priority: "medium" },
    { content: "Pending three", status: "pending", priority: "high" },
  ])
  expect(projectTodos(todos, "full")).toEqual({ kind: "all", items: todos, remaining: 4 })
})

test("projectTodos leaves its input list unchanged", (): void => {
  const input = [
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Finished one", status: "completed", priority: "low" },
    { content: "Pending two", status: "pending", priority: "medium" },
    { content: "Dropped one", status: "cancelled", priority: "high" },
    { content: "Pending three", status: "pending", priority: "low" },
    { content: "Pending four", status: "pending", priority: "medium" },
  ]
  const todos: Todos = decodeTodos(input)
  const pristine: Todos = decodeTodos(input)
  const limited: TodoProjection = projectTodos(todos, limit(2))
  const full: TodoProjection = projectTodos(todos, "full")
  expect(limited.kind).toBe("limited")
  expect(full.kind).toBe("all")
  expect(todos).toEqual(pristine)
  expect(todos).toHaveLength(6)
})

test("a limit of one shows only the active task when one exists", (): void => {
  const withActive: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Active task", status: "in_progress", priority: "medium" },
  ])
  const active: Todos = decodeTodos([
    { content: "Active task", status: "in_progress", priority: "medium" },
  ])
  expect(projectTodos(withActive, limit(1))).toEqual({
    kind: "limited",
    items: active,
    remaining: 2,
    total: 2,
  })
  const withoutActive: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
    { content: "Pending two", status: "pending", priority: "medium" },
  ])
  const firstPending: Todos = decodeTodos([
    { content: "Pending one", status: "pending", priority: "high" },
  ])
  expect(projectTodos(withoutActive, limit(1))).toEqual({
    kind: "limited",
    items: firstPending,
    remaining: 2,
    total: 2,
  })
})
