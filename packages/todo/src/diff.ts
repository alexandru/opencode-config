import type { Todo, Todos } from "./model.ts"

const lineFor = (todo: Todo): string => `[${todo.status}|${todo.priority}] ${todo.content}`

const MAX_CELLS: number = 1 << 20

const replaced = (previous: readonly string[], next: readonly string[]): readonly string[] => [
  ...previous.map((line: string): string => `- ${line}`),
  ...next.map((line: string): string => `+ ${line}`),
]

const advance = (cursor: Iterator<string>): string | undefined => {
  const step: IteratorResult<string> = cursor.next()
  return step.done ? undefined : step.value
}

const diffLines = (previous: readonly string[], next: readonly string[]): readonly string[] => {
  if (
    previous.length === 0 || next.length === 0
    || previous.length * next.length > MAX_CELLS
  ) return replaced(previous, next)
  const width: number = next.length + 1
  const lengths: Int32Array = new Int32Array((previous.length + 1) * width)
  const cell = (index: number): number => lengths[index] ?? 0
  previous.reduceRight<void>((_, prevLine: string, i: number): void => {
    next.reduceRight<void>((_, nextLine: string, j: number): void => {
      lengths[i * width + j] = prevLine === nextLine
        ? cell((i + 1) * width + j + 1) + 1
        : Math.max(cell((i + 1) * width + j), cell(i * width + j + 1))
    }, undefined)
  }, undefined)
  const lines: string[] = []
  const previousCursor: Iterator<string> = previous[Symbol.iterator]()
  const nextCursor: Iterator<string> = next[Symbol.iterator]()
  let i: number = 0
  let j: number = 0
  let previousLine: string | undefined = advance(previousCursor)
  let nextLine: string | undefined = advance(nextCursor)
  while (previousLine !== undefined || nextLine !== undefined) {
    if (previousLine === nextLine) {
      i += 1
      j += 1
      previousLine = advance(previousCursor)
      nextLine = advance(nextCursor)
      continue
    }
    if (
      previousLine !== undefined
      && (nextLine === undefined || cell((i + 1) * width + j) >= cell(i * width + j + 1))
    ) {
      lines.push(`- ${previousLine}`)
      i += 1
      previousLine = advance(previousCursor)
    } else if (nextLine !== undefined) {
      lines.push(`+ ${nextLine}`)
      j += 1
      nextLine = advance(nextCursor)
    }
  }
  return lines
}

export const diffTodos = (previous: Todos, next: Todos): string =>
  diffLines(previous.map(lineFor), next.map(lineFor)).join("\n")
