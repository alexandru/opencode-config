---
description: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.
mode: subagent
permission:
  question: deny
  todowrite: deny
  plan_enter: deny
  plan_exit: deny
  skill: allow
---

Before doing any other work, use the `skill` tool to load `caveman`. Apply mode `lite` for the entire session.

For public API lookups of JVM dependencies, load and use the `cellar` skill. Do not manually download, unpack, or search JAR files for type signatures. For codebase and other API exploration, try available LSP/MCP/IDE tools before text search or dependency extraction.
