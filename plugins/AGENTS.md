# Plugin coding rules

These rules apply to every file in this repository.

## Implementation

- Write plugins with the OpenCode Effect API and the `effect` package.
- Use functional programming: immutable values, pure functions, typed effects, explicit error channels, and function composition.
- Define precise types for configuration, external responses, and domain values.
- Decode external input with Effect Schema at the boundary. Pass validated domain types to internal functions.

## Type safety

- Do not use `any` or `unknown`, explicitly or through a public or internal API.
- Do not use type assertions. This includes `as`, angle-bracket assertions, `as const`, and double assertions.
- Do not use non-null assertions.
- Do not bypass diagnostics with `@ts-ignore`, `@ts-expect-error`, disabled lint rules, ambient declaration shims, broad index signatures, or similar workarounds.
- Fix the type or API that caused a diagnostic. Do not hide the diagnostic.

## Compiler and linting

- Use TypeScript strict mode.
- Enable all applicable compiler checks, including unused code, implicit returns, unchecked indexed access, exact optional properties, switch fallthrough, and override checks.
- Treat every compiler and linter warning as an error.
- Do not weaken compiler or linter settings to make a check pass.
- Exclude dependency declaration internals from compiler and linter checks. Type-check plugin code against dependencies' published declarations without modifying those dependencies.
- Run the plugin's typecheck, unit tests, and integration tests before reporting completion.
