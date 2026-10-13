import { Effect, Schema } from "effect"
import { Todo, TodoError, Todos } from "./model.ts"

export type Record =
  & Todo
  & (
    | { readonly status: "pending" | "in_progress"; readonly created: string | undefined }
    | {
      readonly status: "completed" | "cancelled"
      readonly created: string | undefined
      readonly completed: string | undefined
    }
  )

const Letters = Schema.Literals(["A", "B", "C"])
type Letter = typeof Letters.Type
const priorities: Readonly<{ A: "high"; B: "medium"; C: "low" }> = {
  A: "high",
  B: "medium",
  C: "low",
}
const letters: Readonly<{ high: "A"; medium: "B"; low: "C" }> = {
  high: "A",
  medium: "B",
  low: "C",
}

export interface Document {
  readonly records: readonly Record[]
  readonly todos: Todos
}

const parseLine = Effect.fnUntraced(function*(line: string): Effect.fn.Return<Record, TodoError> {
  const completed: boolean = line.startsWith("x ")
  let body: string = completed ? line.slice(2) : line
  let letter: Letter = "B"
  const priority: RegExpMatchArray | null = body.match(/^\(([A-Z])\) /)
  if (priority) {
    letter = yield* Schema.decodeUnknownEffect(Letters)(priority[1]).pipe(
      Effect.mapError(
        (): TodoError =>
          new TodoError({ message: "Supported todo.txt priorities are A, B, and C" }),
      ),
    )
    body = body.slice(priority[0].length)
  }
  const datePrefix: RegExpMatchArray | null = body.match(
    completed ? /^\d{4}-\d{2}-\d{2} (?:\d{4}-\d{2}-\d{2} )?/ : /^\d{4}-\d{2}-\d{2} /,
  )
  const dates: string = datePrefix?.[0] ?? ""
  body = body.slice(dates.length)
  let status: string = completed ? "completed" : "pending"
  let statusSeen: boolean = false
  let prioritySeen: boolean = false
  const words: string[] = []
  for (const word of body.split(" ")) {
    if (word.startsWith("status:")) {
      if (statusSeen) return yield* new TodoError({ message: "Duplicate status: token" })
      statusSeen = true
      status = word.slice(7)
    } else if (word.startsWith("pri:")) {
      if (prioritySeen || priority) return yield* new TodoError({ message: "Duplicate priority" })
      prioritySeen = true
      letter = yield* Schema.decodeUnknownEffect(Letters)(word.slice(4)).pipe(
        Effect.mapError(
          (): TodoError =>
            new TodoError({ message: "Supported todo.txt priorities are A, B, and C" }),
        ),
      )
    } else {
      words.push(word)
    }
  }
  if (completed !== (status === "completed" || status === "cancelled")) {
    return yield* new TodoError({ message: "The x marker and status: token disagree" })
  }
  const todo: Todo = yield* Schema.decodeUnknownEffect(Todo)({
    content: words.join(" ").trim(),
    status,
    priority: priorities[letter],
  }).pipe(Effect.mapError((error): TodoError => new TodoError({ message: error.message })))
  const [first, second] = dates.trim().split(" ")
  switch (todo.status) {
    case "pending":
    case "in_progress":
      return { ...todo, status: todo.status, created: dates ? first : undefined }
    case "completed":
    case "cancelled":
      return { ...todo, status: todo.status, completed: dates ? first : undefined, created: second }
  }
})

export const parse = Effect.fnUntraced(function*(
  text: string,
): Effect.fn.Return<Document, TodoError> {
  const records: Record[] = []
  let lineNumber: number = 0
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    lineNumber += 1
    if (!line.trim()) continue
    const record: Record = yield* parseLine(line).pipe(
      Effect.mapError(
        (error): TodoError =>
          new TodoError({ message: `todo.txt line ${lineNumber}: ${error.message}` }),
      ),
    )
    records.push(record)
  }
  const todos: Todos = yield* Schema.decodeUnknownEffect(Todos)(records).pipe(
    Effect.mapError((error): TodoError => new TodoError({ message: error.message })),
  )
  return { records, todos }
})

export const render = (todos: Todos, previous: readonly Record[], today: string): string => {
  const records: Map<string, Record[]> = new Map()
  for (const record of previous) {
    const existing: Record[] | undefined = records.get(record.content)
    if (existing) existing.push(record)
    else records.set(record.content, [record])
  }
  const lines: string[] = []
  for (const todo of todos) {
    const old: Record | undefined = records.get(todo.content)?.shift()
    const created: string | undefined = old?.created
    const completed: string | undefined = old?.status === "completed" || old?.status === "cancelled"
      ? old.completed
      : created
      ? today
      : undefined
    const openBody: string = created ? `${created} ${todo.content}` : todo.content
    const closedBody: string = completed ? `${completed} ${openBody}` : todo.content
    const letter: Letter = letters[todo.priority]
    switch (todo.status) {
      case "pending":
        lines.push(`(${letter}) ${openBody}`)
        break
      case "in_progress":
        lines.push(`(${letter}) ${openBody} status:in_progress`)
        break
      case "completed":
        lines.push(`x ${closedBody} pri:${letter}`)
        break
      case "cancelled":
        lines.push(`x ${closedBody} pri:${letter} status:cancelled`)
        break
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}
