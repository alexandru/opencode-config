import { Schema } from "effect"

export const Content = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isPattern(/^[^\r\n\x00]+$/),
  Schema.makeFilter(
    (value: string): boolean =>
      !/^(?:\([A-Z]\) |\d{4}-\d{2}-\d{2}(?: |$))/.test(value)
      && !/(?:^|\s)(?:status|pri):/.test(value),
    {
      message:
        "Task text must not start with a priority/date or contain reserved status:/pri: tokens",
    },
  ),
).pipe(Schema.brand("TodoContent"))

export const Status = Schema.Literals(["pending", "in_progress", "completed", "cancelled"])
export const Priority = Schema.Literals(["high", "medium", "low"])
export const Todo = Schema.Struct({ content: Content, status: Status, priority: Priority })
export type Todo = typeof Todo.Type

export const Todos = Schema.Array(Todo)
  .check(
    Schema.makeFilter(
      (todos: readonly Todo[]): boolean => {
        let active: boolean = false
        for (const todo of todos) {
          if (todo.status !== "in_progress") continue
          if (active) return false
          active = true
        }
        return true
      },
      { message: "At most one todo may be in_progress" },
    ),
  )
  .pipe(Schema.brand("TodoList"))
export type Todos = typeof Todos.Type

export const SessionName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
).pipe(Schema.brand("TodoSessionName"))
export type SessionName = typeof SessionName.Type

export const Snapshot = Schema.Struct({ path: Schema.String, todos: Todos })
export type Snapshot = typeof Snapshot.Type

export class TodoError extends Schema.TaggedError<TodoError>()("TodoError", {
  message: Schema.String,
}) {}
