import { DateTime, Effect, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { SessionName, Snapshot, TodoError, Todos } from "./model.ts"
import { type Document, parse, render } from "./todotxt.ts"

export const SessionDirectory = Schema.Struct({
  directory: Schema.String.check(
    Schema.makeFilter((directory: string): boolean => isAbsolute(directory), {
      message: "The todo project directory must be absolute",
    }),
  ).pipe(Schema.brand("TodoProjectDirectory")),
  name: SessionName,
})
export type SessionDirectory = typeof SessionDirectory.Type

export interface WriteResult {
  readonly path: string
  readonly todos: Todos
  readonly previous: Todos
}

export interface TodoStore {
  readonly read: (session: SessionDirectory) => Effect.Effect<Snapshot, TodoError>
  readonly write: (session: SessionDirectory, todos: Todos) => Effect.Effect<WriteResult, TodoError>
}

const io = <A>(message: string, run: () => Promise<A>): Effect.Effect<A, TodoError> =>
  Effect.tryPromise({
    try: run,
    catch: (error): TodoError => new TodoError({ message: `${message}: ${String(error)}` }),
  })

const missing = (error: unknown): boolean =>
  Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)

const pathFor = (session: SessionDirectory): string =>
  join(session.directory, ".agents", "sessions", session.name, "todo.txt")

const load = Effect.fnUntraced(function*(path: string): Effect.fn.Return<Document, TodoError> {
  const text: string = yield* io(`Cannot read ${path}`, async (): Promise<string> => {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("todo.txt must be a regular file")
      }
      return await readFile(path, "utf8")
    } catch (error) {
      if (missing(error)) return ""
      throw error
    }
  })
  return yield* parse(text)
})

const checkDirectory = Effect.fnUntraced(function*(
  session: SessionDirectory,
): Effect.fn.Return<void, TodoError> {
  yield* io("Cannot access session directory", async (): Promise<void> => {
    let directory: string = await realpath(session.directory)
    for (const segment of [".agents", "sessions", session.name]) {
      directory = join(directory, segment)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(`${directory} must be a real directory`)
        }
      } catch (error) {
        if (missing(error)) return
        throw error
      }
    }
  })
})

const ensureDirectory = Effect.fnUntraced(function*(
  session: SessionDirectory,
): Effect.fn.Return<void, TodoError> {
  yield* io("Cannot prepare session directory", async (): Promise<void> => {
    let directory: string = await realpath(session.directory)
    for (const segment of [".agents", "sessions", session.name]) {
      directory = join(directory, segment)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${directory} must be a real directory`)
      }
    }
  })
})

export const makeTodoStore: Effect.Effect<TodoStore> = Effect.gen(
  function*(): Effect.fn.Return<TodoStore> {
    const lock: Semaphore.Semaphore = yield* Semaphore.make(1)
    const read: TodoStore["read"] = Effect.fnUntraced(function*(
      session: SessionDirectory,
    ): Effect.fn.Return<Snapshot, TodoError> {
      const path: string = pathFor(session)
      yield* checkDirectory(session)
      const document: Document = yield* load(path)
      return { path, todos: document.todos }
    })
    const write: TodoStore["write"] = (session, todos): Effect.Effect<WriteResult, TodoError> =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function*(): Effect.fn.Return<WriteResult, TodoError> {
            const path: string = pathFor(session)
            yield* ensureDirectory(session)
            const previous: Document = yield* load(path)
            const temporary: string = `${path}.${randomUUID()}.tmp`
            const today: string = DateTime.formatIsoDateUtc(yield* DateTime.now)
            yield* io(`Cannot write ${path}`, async (): Promise<void> => {
              try {
                await writeFile(temporary, render(todos, previous.records, today), {
                  encoding: "utf8",
                  mode: 0o600,
                  flag: "wx",
                })
                await rename(temporary, path)
              } finally {
                await rm(temporary, { force: true })
              }
            })
            return { path, todos, previous: previous.todos }
          }),
        ),
      )
    return { read, write }
  },
)
