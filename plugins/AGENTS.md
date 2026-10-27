# Plugin Development

Applies to harness-authored TypeScript plugin source, tests, fixtures, and helpers in this directory and its descendants. These are development instructions, not runtime agent prompting.

## TypeScript and type safety

- MUST use strict TypeScript and preserve the package's strict compiler checks. Never weaken compiler settings or suppress diagnostics to make code pass.
- MUST give every function an explicit parameter and return contract, including helpers, callbacks, and generators; declare field types. Use checked `satisfies` contracts where inference should be preserved.
- MUST NOT use `any`, type assertions (`as T`, angle-bracket casts, or double casts), non-null assertions, or diagnostic-suppression directives. Do not fabricate implementations or proofs with uninitialized `declare` members.
- MUST treat external values as `unknown` and parse them with Effect Schema before use. Derive domain types from schemas; preserve validated invariants with brands, nonempty collections, and discriminated unions rather than widening them back to primitives.
- MUST make missing values and failures explicit with `Option`, `Result`, or typed Effect errors. No unchecked indexing, partial collection operations, unchecked unwraps, or non-exhaustive matches.
- MUST reuse the published SDK's types and narrow capabilities to what a function actually needs. Use type-only imports for type-only dependencies; declare directly imported packages explicitly.

## Functional design

- SHOULD keep domain logic pure and compose small functions over readonly data and algebraic data types rather than class hierarchies.
- MUST model invalid states out of the domain instead of maintaining their invariants through scattered guards, parallel flags, sentinels, or comments.
- MUST keep mutation local and non-escaping, or manage it explicitly through Effect state. No hidden mutable globals or singleton state.
- SHOULD define each concept once, remove forwarding-only abstractions, and keep modules cohesive. Do not create extra files or generic frameworks without demonstrated leverage.

## Effect

- MUST use Effect for asynchronous work, I/O, clocks, concurrency, resource lifetimes, and shared state; keep the pure core separate from those effects.
- MUST represent expected failures in typed error channels and handle them deliberately. Do not swallow failures or convert them into defects except at a host boundary whose contract requires it.
- MUST scope resources and background fibers so interruption, unload, and failure release them. No unmanaged fire-and-forget work or timer-based synchronization.
- MUST use the host's Effect/plugin interfaces and runtime instances. Keep Promise/native-framework adapters thin, and keep runtime execution such as `runPromise` at actual application, host, or test boundaries.
