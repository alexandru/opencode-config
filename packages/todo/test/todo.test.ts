import { afterEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Snapshot, type TodoError, Todos } from "../src/model.ts"
import { makeTodoStore, SessionDirectory, type TodoStore, type WriteResult } from "../src/store.ts"

const directories: Set<string> = new Set()

const temporary = async (): Promise<string> => {
  const directory: string = await mkdtemp(join(tmpdir(), "opencode-todo-"))
  directories.add(directory)
  return directory
}

afterEach(async (): Promise<void> => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

const newStore = async (): Promise<TodoStore> => Effect.runPromise(makeTodoStore)

const failureOf = async (
  effect: Effect.Effect<unknown, TodoError>,
): Promise<TodoError | undefined> =>
  Effect.runPromise(
    Effect.flip(effect).pipe(
      Effect.catch((): Effect.Effect<undefined> => Effect.succeed(undefined)),
    ),
  )

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

const priorityFor = (index: number): "high" | "medium" | "low" => {
  const remainder: number = index % 3
  if (remainder === 0) return "high"
  if (remainder === 1) return "medium"
  return "low"
}

const letterFor = (index: number): "A" | "B" | "C" => {
  const priority: "high" | "medium" | "low" = priorityFor(index)
  if (priority === "high") return "A"
  if (priority === "medium") return "B"
  return "C"
}

const listFor = (index: number, label: string): Todos =>
  Schema.decodeUnknownSync(Todos)([
    {
      content: `${label} ${index} +p${index} @c${index}`,
      status: "pending",
      priority: priorityFor(index),
    },
  ])

const validTodos = (content: string): Todos =>
  Schema.decodeUnknownSync(Todos)([{ content, status: "pending", priority: "high" }])

const emptyTodos: Todos = Schema.decodeUnknownSync(Todos)([])

const sessionDirectory = (directory: string, name: string): SessionDirectory =>
  Schema.decodeUnknownSync(SessionDirectory)({ directory, name })

test("a session can replace and reopen its list as standard todo.txt", async (): Promise<void> => {
  const directory: string = await mkdtemp(join(tmpdir(), "opencode-todo-"))
  directories.add(directory)
  const store = await Effect.runPromise(makeTodoStore)
  const session = sessionDirectory(directory, "ses_example")
  const todos = Schema.decodeUnknownSync(Todos)([
    { content: "Ship +plugin @opencode", status: "in_progress", priority: "high" },
    { content: "Read the docs", status: "completed", priority: "low" },
  ])
  await Effect.runPromise(store.write(session, todos))
  expect(await readFile(join(directory, ".agents/sessions/ses_example/todo.txt"), "utf8")).toBe(
    "(A) Ship +plugin @opencode status:in_progress\nx Read the docs pri:C\n",
  )
  const reopened = await Effect.runPromise(makeTodoStore)
  expect((await Effect.runPromise(reopened.read(session))).todos).toEqual(todos)
})

test("write reports the replaced list as previous", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_previous")
  const first: WriteResult = await Effect.runPromise(store.write(session, validTodos("First")))
  expect(first.path).toBe(join(directory, ".agents", "sessions", "ses_previous", "todo.txt"))
  expect(first.todos).toEqual(validTodos("First"))
  expect(first.previous).toEqual(emptyTodos)
  const second: WriteResult = await Effect.runPromise(store.write(session, validTodos("Second")))
  expect(second.todos).toEqual(validTodos("Second"))
  expect(second.previous).toEqual(validTodos("First"))
})

test("completing and reopening an externally dated task preserves its creation date", async (): Promise<void> => {
  const directory: string = await mkdtemp(join(tmpdir(), "opencode-todo-"))
  directories.add(directory)
  const path: string = join(directory, ".agents/sessions/ses_dated/todo.txt")
  await mkdir(join(directory, ".agents/sessions/ses_dated"), { recursive: true })
  await writeFile(path, "(A) 2026-10-01 Ship +plugin @opencode\n")
  const store = await Effect.runPromise(makeTodoStore)
  const session = sessionDirectory(directory, "ses_dated")
  const done = Schema.decodeUnknownSync(Todos)([
    { content: "Ship +plugin @opencode", status: "completed", priority: "high" },
  ])
  await Effect.runPromise(store.write(session, done))
  expect(await readFile(path, "utf8")).toMatch(
    /^x \d{4}-\d{2}-\d{2} 2026-10-01 Ship \+plugin @opencode pri:A\n$/,
  )
  const reopened = Schema.decodeUnknownSync(Todos)([
    { content: "Ship +plugin @opencode", status: "pending", priority: "high" },
  ])
  await Effect.runPromise(store.write(session, reopened))
  expect(await readFile(path, "utf8")).toBe("(A) 2026-10-01 Ship +plugin @opencode\n")
})

test("a missing list reads as empty without creating project directories", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_missing")
  const snapshot: Snapshot = await Effect.runPromise(store.read(session))
  expect(snapshot.path).toBe(join(directory, ".agents", "sessions", "ses_missing", "todo.txt"))
  expect(snapshot.todos).toEqual(emptyTodos)
  expect(await readdir(directory)).toEqual([])
  expect(await pathExists(join(directory, ".agents"))).toBe(false)
})

test("all statuses and priorities round-trip through todo.txt bytes", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_statuses")
  const todos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Ship +plugin @work", status: "pending", priority: "high" },
    { content: "Review @team", status: "in_progress", priority: "medium" },
    { content: "Read docs", status: "completed", priority: "low" },
    { content: "Old plan", status: "completed", priority: "high" },
    { content: "Dropped idea", status: "cancelled", priority: "medium" },
    { content: "Backlog +later", status: "pending", priority: "low" },
  ])
  await Effect.runPromise(store.write(session, todos))
  expect(
    await readFile(join(directory, ".agents", "sessions", "ses_statuses", "todo.txt"), "utf8"),
  ).toBe(
    "(A) Ship +plugin @work\n"
      + "(B) Review @team status:in_progress\n"
      + "x Read docs pri:C\n"
      + "x Old plan pri:A\n"
      + "x Dropped idea pri:B status:cancelled\n"
      + "(C) Backlog +later\n",
  )
  expect((await Effect.runPromise(store.read(session))).todos).toEqual(todos)
})

test("writes replace the list in input order and an empty list clears the file", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_replace")
  const path: string = join(directory, ".agents", "sessions", "ses_replace", "todo.txt")
  const first: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "First", status: "pending", priority: "high" },
    { content: "Second", status: "pending", priority: "medium" },
    { content: "Third", status: "pending", priority: "low" },
  ])
  await Effect.runPromise(store.write(session, first))
  expect(await readFile(path, "utf8")).toBe("(A) First\n(B) Second\n(C) Third\n")
  const second: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Third", status: "completed", priority: "low" },
    { content: "First", status: "pending", priority: "high" },
  ])
  await Effect.runPromise(store.write(session, second))
  expect(await readFile(path, "utf8")).toBe("x Third pri:C\n(A) First\n")
  const empty: Todos = Schema.decodeUnknownSync(Todos)([])
  await Effect.runPromise(store.write(session, empty))
  expect(await readFile(path, "utf8")).toBe("")
  expect((await Effect.runPromise(store.read(session))).todos).toEqual(emptyTodos)
})

test("session names isolate lists within a project and across projects", async (): Promise<void> => {
  const first: string = await temporary()
  const second: string = await temporary()
  const store: TodoStore = await newStore()
  const alpha: SessionDirectory = sessionDirectory(first, "ses_alpha")
  const beta: SessionDirectory = sessionDirectory(first, "ses_beta")
  const alphaElsewhere: SessionDirectory = sessionDirectory(second, "ses_alpha")
  const alphaTodos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Alpha in first project", status: "pending", priority: "high" },
  ])
  const betaTodos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Beta in first project", status: "pending", priority: "low" },
  ])
  const elsewhereTodos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Alpha in second project", status: "in_progress", priority: "medium" },
  ])
  await Effect.runPromise(store.write(alpha, alphaTodos))
  await Effect.runPromise(store.write(beta, betaTodos))
  await Effect.runPromise(store.write(alphaElsewhere, elsewhereTodos))
  expect(await readFile(join(first, ".agents", "sessions", "ses_alpha", "todo.txt"), "utf8")).toBe(
    "(A) Alpha in first project\n",
  )
  expect(await readFile(join(first, ".agents", "sessions", "ses_beta", "todo.txt"), "utf8")).toBe(
    "(C) Beta in first project\n",
  )
  expect(await readFile(join(second, ".agents", "sessions", "ses_alpha", "todo.txt"), "utf8")).toBe(
    "(B) Alpha in second project status:in_progress\n",
  )
  expect((await Effect.runPromise(store.read(alpha))).todos).toEqual(alphaTodos)
  expect((await Effect.runPromise(store.read(beta))).todos).toEqual(betaTodos)
  expect((await Effect.runPromise(store.read(alphaElsewhere))).todos).toEqual(elsewhereTodos)
})

test("the Todos schema rejects malformed lists", (): void => {
  expect(
    Schema.decodeUnknownSync(Todos)([{ content: "Valid", status: "pending", priority: "medium" }]),
  ).toHaveLength(1)
  const rejects = (input: unknown): void => {
    expect((): Todos => Schema.decodeUnknownSync(Todos)(input)).toThrow()
  }
  rejects([
    { content: "One", status: "in_progress", priority: "high" },
    { content: "Two", status: "in_progress", priority: "low" },
  ])
  rejects([{ content: "", status: "pending", priority: "high" }])
  rejects([{ content: "  padded  ", status: "pending", priority: "high" }])
  rejects([{ content: "Line\nbreak", status: "pending", priority: "high" }])
  rejects([{ content: "Valid", status: "blocked", priority: "high" }])
  rejects([{ content: "Valid", status: "pending", priority: "urgent" }])
  rejects([{ content: "Ship status:done", status: "pending", priority: "high" }])
  rejects([{ content: "Ship pri:A", status: "pending", priority: "high" }])
  rejects([{ content: "Discuss status:", status: "pending", priority: "high" }])
  rejects([{ content: "Discuss pri:", status: "pending", priority: "high" }])
  rejects([{ content: "(A) Smuggled", status: "pending", priority: "high" }])
  rejects([{ content: "2026-01-01 Smuggled", status: "pending", priority: "high" }])
})

test("the SessionDirectory schema rejects relative directories and unsafe names", async (): Promise<void> => {
  const directory: string = await temporary()
  expect(
    (): SessionDirectory =>
      Schema.decodeUnknownSync(SessionDirectory)({ directory, name: "ses_valid" }),
  ).not.toThrow()
  const rejects = (input: unknown): void => {
    expect((): SessionDirectory => Schema.decodeUnknownSync(SessionDirectory)(input)).toThrow()
  }
  rejects({ directory: "relative/path", name: "ses_valid" })
  rejects({ directory, name: "../escape" })
  rejects({ directory, name: "." })
  rejects({ directory, name: "/" })
})

test("externally edited CRLF, BOM, blank lines, and metadata survive read and write", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_external")
  const path: string = join(directory, ".agents", "sessions", "ses_external", "todo.txt")
  await mkdir(join(directory, ".agents", "sessions", "ses_external"), { recursive: true })
  await writeFile(
    path,
    "\uFEFF(A) Alpha +project @context due:2026-01-05\r\n\r\n(B) Beta +other @home due:2026-02-01\r\n",
  )
  const todos: Todos = Schema.decodeUnknownSync(Todos)([
    { content: "Alpha +project @context due:2026-01-05", status: "pending", priority: "high" },
    { content: "Beta +other @home due:2026-02-01", status: "pending", priority: "medium" },
  ])
  expect((await Effect.runPromise(store.read(session))).todos).toEqual(todos)
  await Effect.runPromise(store.write(session, todos))
  expect(await readFile(path, "utf8")).toBe(
    "(A) Alpha +project @context due:2026-01-05\n(B) Beta +other @home due:2026-02-01\n",
  )
  expect((await Effect.runPromise(store.read(session))).todos).toEqual(todos)
})

test("a disk status mismatch fails read and write without touching the file", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_mismatch")
  const sessionPath: string = join(directory, ".agents", "sessions", "ses_mismatch")
  const path: string = join(sessionPath, "todo.txt")
  await mkdir(sessionPath, { recursive: true })
  await writeFile(path, "(A) Disagrees status:completed\n")
  const readError: TodoError | undefined = await failureOf(store.read(session))
  expect(readError?._tag).toBe("TodoError")
  expect(readError?.message).toContain("todo.txt line 1")
  expect(readError?.message).toContain("disagree")
  const writeError: TodoError | undefined = await failureOf(
    store.write(session, validTodos("Replacement")),
  )
  expect(writeError?._tag).toBe("TodoError")
  expect(writeError?.message).toContain("disagree")
  expect(await readFile(path, "utf8")).toBe("(A) Disagrees status:completed\n")
  expect(await readdir(sessionPath)).toEqual(["todo.txt"])
})

test("a duplicate disk status token fails read and write without touching the file", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_duplicate")
  const sessionPath: string = join(directory, ".agents", "sessions", "ses_duplicate")
  const path: string = join(sessionPath, "todo.txt")
  await mkdir(sessionPath, { recursive: true })
  await writeFile(path, "(A) Repeated status:pending status:pending\n")
  const readError: TodoError | undefined = await failureOf(store.read(session))
  expect(readError?._tag).toBe("TodoError")
  expect(readError?.message).toContain("Duplicate status:")
  const writeError: TodoError | undefined = await failureOf(
    store.write(session, validTodos("Replacement")),
  )
  expect(writeError?._tag).toBe("TodoError")
  expect(writeError?.message).toContain("Duplicate status:")
  expect(await readFile(path, "utf8")).toBe("(A) Repeated status:pending status:pending\n")
  expect(await readdir(sessionPath)).toEqual(["todo.txt"])
})

test("read and write reject a symlinked todo file", async (): Promise<void> => {
  const directory: string = await temporary()
  const outside: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_link")
  const sessionPath: string = join(directory, ".agents", "sessions", "ses_link")
  const path: string = join(sessionPath, "todo.txt")
  const outsidePath: string = join(outside, "outside.txt")
  await mkdir(sessionPath, { recursive: true })
  await writeFile(outsidePath, "(A) Outside secret\n")
  await symlink(outsidePath, path)
  const readError: TodoError | undefined = await failureOf(store.read(session))
  expect(readError?._tag).toBe("TodoError")
  expect(readError?.message).toContain("must be a regular file")
  const writeError: TodoError | undefined = await failureOf(
    store.write(session, validTodos("Replacement")),
  )
  expect(writeError?._tag).toBe("TodoError")
  expect(writeError?.message).toContain("must be a regular file")
  expect(await readFile(outsidePath, "utf8")).toBe("(A) Outside secret\n")
  expect((await lstat(path)).isSymbolicLink()).toBe(true)
  expect(await readdir(sessionPath)).toEqual(["todo.txt"])
})

test("read rejects a .agents symlink escaping the project", async (): Promise<void> => {
  const directory: string = await temporary()
  const outside: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_foreign")
  const outsideDirectory: string = join(outside, "sessions", "ses_foreign")
  const outsidePath: string = join(outsideDirectory, "todo.txt")
  await mkdir(outsideDirectory, { recursive: true })
  await writeFile(outsidePath, "(A) Foreign task\n")
  await symlink(outside, join(directory, ".agents"))
  const readError: TodoError | undefined = await failureOf(store.read(session))
  expect(await readFile(outsidePath, "utf8")).toBe("(A) Foreign task\n")
  expect(readError?._tag).toBe("TodoError")
  expect(readError?.message).toContain("must be a real directory")
})

test("write rejects a .agents symlink escaping the project", async (): Promise<void> => {
  const directory: string = await temporary()
  const outside: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_foreign")
  const outsideDirectory: string = join(outside, "sessions", "ses_foreign")
  const outsidePath: string = join(outsideDirectory, "todo.txt")
  await mkdir(outsideDirectory, { recursive: true })
  await writeFile(outsidePath, "(A) Foreign task\n")
  await symlink(outside, join(directory, ".agents"))
  const writeError: TodoError | undefined = await failureOf(
    store.write(session, validTodos("Replacement")),
  )
  expect(writeError?._tag).toBe("TodoError")
  expect(writeError?.message).toContain("must be a real directory")
  expect(await readFile(outsidePath, "utf8")).toBe("(A) Foreign task\n")
  expect((await lstat(join(directory, ".agents"))).isSymbolicLink()).toBe(true)
  expect(await readdir(outsideDirectory)).toEqual(["todo.txt"])
})

test("concurrent writes and reads expose only complete snapshots", async (): Promise<void> => {
  const directory: string = await temporary()
  const store: TodoStore = await newStore()
  const session: SessionDirectory = sessionDirectory(directory, "ses_concurrent")
  const sessionPath: string = join(directory, ".agents", "sessions", "ses_concurrent")
  const path: string = join(sessionPath, "todo.txt")

  const initial: Todos[] = []
  const initialExpected: string[] = []
  for (let index = 0; index < 16; index += 1) {
    initial.push(listFor(index, "Task"))
    initialExpected.push(`(${letterFor(index)}) Task ${index} +p${index} @c${index}\n`)
  }
  const firstRound: WriteResult[] = await Promise.all(
    initial.map(
      (todos: Todos): Promise<WriteResult> => Effect.runPromise(store.write(session, todos)),
    ),
  )
  expect(firstRound.map((result: WriteResult): Todos => result.todos)).toEqual(initial)
  expect(initialExpected).toContain(await readFile(path, "utf8"))
  expect(await readdir(sessionPath)).toEqual(["todo.txt"])

  const updated: Todos[] = []
  const updatedExpected: string[] = []
  for (let index = 0; index < 16; index += 1) {
    updated.push(listFor(index, "Updated"))
    updatedExpected.push(`(${letterFor(index)}) Updated ${index} +p${index} @c${index}\n`)
  }
  const writes: Promise<WriteResult>[] = updated.map(
    (todos: Todos): Promise<WriteResult> => Effect.runPromise(store.write(session, todos)),
  )
  const reads: Promise<Snapshot>[] = []
  for (let index = 0; index < 32; index += 1) {
    reads.push(Effect.runPromise(store.read(session)))
  }
  const [written, observed]: [WriteResult[], Snapshot[]] = await Promise.all([
    Promise.all(writes),
    Promise.all(reads),
  ])
  expect(written.map((result: WriteResult): Todos => result.todos)).toEqual(updated)
  const possible: Todos[] = [...initial, ...updated]
  for (const snapshot of observed) {
    expect(possible).toContainEqual(snapshot.todos)
  }
  const final: Snapshot = await Effect.runPromise(store.read(session))
  expect(updated).toContainEqual(final.todos)
  expect(updatedExpected).toContain(await readFile(path, "utf8"))
  expect(await readdir(sessionPath)).toEqual(["todo.txt"])
})
