# My OpenCode configuration

Part of [alexandru/agents-config](https://github.com/alexandru/agents-config).

## Installation

<details>
<summary>STEP 1 — Clone the repository</summary>

### Clone the repository

```sh
git clone https://github.com/alexandru/opencode-config.git ~/.config/opencode
```
</details>

<details>
<summary>STEP 2 — Install dependencies</summary>

### Install dependencies

```sh
cd ~/.config/opencode && make
```

The skills are installed under `~/.agents/skills`, where OpenCode, Copilot CLI,
Codex, and Pi can share them.

The TODO plugin is installed from `alexandru/opencode-todo` into
`../plugins/opencode-todo-tool` when that directory is missing. In an
`agents-config` checkout, the existing plugin submodule is used instead.
</details>

<details>
<summary>STEP 3 — Choose a configuration preset (optional)</summary>

### Choose a configuration preset (optional)

The [oc-switch](./bin/oc-switch.py) utility is for quickly switching between multiple setting presets (e.g., multiple sets of models assigned to your agents). It's built with Python 🐍, so you need [pipx](https://pipx.pypa.io/) installed (`make install-pipx`).

```sh
# Example
./bin/oc-switch p-openai
```

The switcher generates `opencode.jsonc` (OpenCode's configuration file) from:

- [opencode.common.jsonc](./opencode.common.jsonc)
- [opencode.presets.jsonc](./opencode.presets.jsonc)
</details>

<details>
<summary>STEP 4 — Install Cellar (optional)</summary>

### Install Cellar (optional)

[Cellar](https://github.com/VirtusLab/cellar) is useful for JVM dependency API lookup, and this repo's [Makefile](./Makefile) also installs its associated skill.

Install [Coursier](https://get-coursier.io/docs/cli-installation) first:

```bash
## MacOS
brew install coursier/formulas/coursier && cs setup
```

```bash
(
  set -eo pipefail
  ## Linux x86-64 (aka AMD64)
  curl -fL "https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz" | gzip -d > cs
)
```

```bash
(
  set -eo pipefail
  ## Linux ARM64
  curl -fL "https://github.com/VirtusLab/coursier-m1/releases/latest/download/cs-aarch64-pc-linux.gz" | gzip -d > cs
)
```

Then install Cellar via Coursier:

```bash
(
  set -e
  cs install --contrib cellar
  cellar --version

  # Disable telemetry
  cellar telemetry disable
)
```
</details>

## Defined agents

Main agents:

- [Orchestrator](./agents/Orchestrator.md) (default agent): designs and implements changes; delegates evidence, research, and checks.
- [Solo](./agents/Solo.md): designs and implements changes with direct tool use and no delegation.

Sub-agents:

- [Junior](./agents/Junior.md): bounded execution, mechanical work.
- [Explorer](./agents/Explorer.md): read-only codebase evidence gathering.
- [Librarian](./agents/Librarian.md): read-only external documentation and dependency-source research.

## Defined commands

- `/plan`: prepare a detailed implementation plan and save it as a Markdown specification file.
- `/grill-me`: stress-test a plan or decision.
- `/grill-with-docs`: sharpen a plan or design while creating domain documentation.
- `/handoff`: prepare context for another agent or session.
- `/implement`: implement work from a specification or set of tickets.
- `/improve-codebase-architecture`: find and work through codebase architecture improvements.
- `/review`: review uncommitted changes, a commit, a branch, or a pull request.
- `/setup-matt-pocock-skills`: configure the repository for Matt Pocock's engineering skills.
- `/simplify`: simplify code without changing its behavior.
- `/teach`: teach the user a topic through a stateful learning workspace.
- `/to-spec`: turn the current conversation into a published specification.
- `/to-tickets`: break a plan or specification into tracer-bullet tickets.

## Shared skills

- [alexandru/skills](https://github.com/alexandru/skills/tree/v10.2.0)
  - `code-review`: user-invoked adapter for `code-reviewing`.
  - `code-reviewing`: review changed code for bugs, structural problems, performance issues, and unintended behavior.
  - `simplicity`: simplification lenses of constraints, simplicity, and parametricity.
  - `simplify`: behavior-preserving simplification using the `simplicity` lenses.
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
- [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop)
  - `unslop`: remove AI writing patterns and add a human voice.

## Updating shared skills

```sh
make update-skills
```

This reinstalls the configured global skill roster from its upstream sources.
