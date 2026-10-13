import { Effect, Schema } from "effect"
import type { Todo, Todos } from "./model.ts"

export const SidebarLimit = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("TodoSidebarLimit"),
)
export type SidebarLimit = typeof SidebarLimit.Type

export const SidebarOptions = Schema.Struct({
  sidebarLimit: SidebarLimit.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
})

export type TodoProjection =
  | { readonly kind: "all"; readonly items: readonly Todo[]; readonly remaining: number }
  | {
    readonly kind: "limited"
    readonly items: readonly Todo[]
    readonly remaining: number
    readonly total: number
  }

const incomplete = (todo: Todo): boolean =>
  todo.status === "pending" || todo.status === "in_progress"

export const projectTodos = (todos: Todos, mode: "full" | SidebarLimit): TodoProjection => {
  if (mode === "full" || todos.length <= mode) {
    return {
      kind: "all",
      items: todos,
      remaining: todos.reduce((count, todo): number => count + Number(incomplete(todo)), 0),
    }
  }
  const items: Todo[] = []
  let remaining: number = 0
  for (const todo of todos) {
    if (!incomplete(todo)) continue
    remaining += 1
    if (todo.status === "in_progress") {
      if (items.length === mode) items.pop()
      items.unshift(todo)
    } else if (items.length < mode) items.push(todo)
  }
  return { kind: "limited", items, remaining, total: todos.length }
}
