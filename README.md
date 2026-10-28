# My OpenCode configuration

Part of [alexandru/agents-config](https://github.com/alexandru/agents-config).

## Installation

<details>
<summary>STEP 1 — Install</summary>

### Install

```bash
curl -fsSL https://alexandru.github.io/opencode-config/install.sh | bash
```

The skills are installed under `~/.agents/skills`, where OpenCode, Copilot CLI,
Codex, and Pi can share them.
</details>

<details>
<summary>STEP 2 — Choose a configuration preset (optional)</summary>

### Choose a configuration preset (optional)

The [oc-switch](./bin/oc-switch.py) utility is for quickly switching between multiple setting presets (e.g., multiple sets of models assigned to your agents).

```sh
# Example
~/.config/opencode/bin/oc-switch p-openai
```

The switcher generates `opencode.jsonc` (OpenCode's configuration file) from:

- [opencode.common.jsonc](./opencode.common.jsonc)
- [opencode.presets.jsonc](./opencode.presets.jsonc)
</details>

## Defined agents

Main agents:

- [Orchestrator](./agents/Orchestrator.md) (default agent): designs and implements changes; delegates evidence, research, and execution to Junior.
- [Solo](./agents/Solo.md): designs and implements changes; works directly.

Sub-agents:

- [Junior](./agents/Junior.md): codebase and external evidence gathering, bounded execution, mechanical work.

## Defined commands

- `/grill-me`: stress-test a plan or decision.
- `/grill-with-docs`: sharpen a plan or design while creating domain documentation.
- `/handoff`: prepare context for another agent or session.
- `/implement`: implement work from a specification or set of tickets.
- `/improve-codebase-architecture`: find and work through codebase architecture improvements.
- `/code-refine`: refine code without changing its behavior.
- `/review`: review uncommitted changes, a commit, a branch, or a pull request.
- `/setup-matt-pocock-skills`: configure the repository for Matt Pocock's engineering skills.
- `/teach`: teach the user a topic through a stateful learning workspace.
- `/to-spec`: turn the current conversation into a published specification.
- `/to-tickets`: break a plan or specification into tracer-bullet tickets.

## Shared skills

- [alexandru/skills](https://github.com/alexandru/skills/tree/v13.3.0)
  - `code-review`: user-invoked adapter for `code-reviewing`.
  - `code-reviewing`: review changed code for bugs, structural problems, performance issues, and unintended behavior.
  - `code-refine`: behavior-preserving refinement using the `code-refinements` lenses.
  - `code-refinements`: refinement lenses of constraints, simplicity, and parametricity.
  - `external-research`: research external documentation, public repositories, and dependency artifacts with a persistent cache.
- [mattpocock/skills](https://github.com/mattpocock/skills/tree/v1.3.1)
  - `codebase-design`: deep-module design vocabulary and principles.
  - `diagnosing-bugs`: disciplined diagnosis for hard bugs and regressions.
  - `domain-modeling`: domain language and architectural decisions.
  - `grill-me`: user-invoked adapter for `grilling`.
  - `grill-with-docs`: sharpen a plan or design while creating domain documentation.
  - `grilling`: structured decision-tree interviews.
  - `handoff`: prepare context for another agent or session.
  - `implement`: implement work from a specification or set of tickets.
  - `improve-codebase-architecture`: find and work through codebase architecture improvements.
  - `setup-matt-pocock-skills`: configure a repository for the engineering skills.
  - `tdd`: test-first development guidance.
  - `teach`: teach the user a topic through a stateful learning workspace with lessons and reference documents.
  - `to-spec`: turn the current conversation into a published specification.
  - `to-tickets`: break a plan or specification into tracer-bullet tickets.
- [VirtusLab/cellar](https://github.com/VirtusLab/cellar/)
  - `cellar`: query the APIs of JVM dependencies (Scala, Java).
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)
  - `caveman`: token-efficient response modes with preserved technical accuracy.

## Updating shared skills

```sh
make update-skills
```

This reinstalls the configured global skill roster from its upstream sources.
