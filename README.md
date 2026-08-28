# My OpenCode configuration

## Installation

**1)** Clone the repository into OpenCode's global configuration directory:

```sh
git clone https://github.com/alexandru/opencode-config.git ~/.config/opencode
```

`Orchestrator` is configured as the default agent in `opencode.common.jsonc`.

**2)** Install the shared third-party skills globally:

```sh
cd ~/.config/opencode
make install-skills
```

The skills are installed under `~/.agents/skills`, where OpenCode, Copilot CLI,
and Codex can share them.

**3)** Choose a model preset before first use and whenever you want to switch profiles:

```sh
# Example
./bin/oc-switch p-openai
```

**WARN:** must run `oc-switch` at least once, otherwise `opencode.jsonc` is missing. The switcher generates `opencode.jsonc` from:

- `opencode.common.jsonc`
- `opencode.presets.jsonc`

## Defined agents

Main agents:

- `Orchestrator` (default agent): implements changes; delegates review, evidence, research, and checks.

Sub-agents:

- `Reviewer`: read-only code review against explicit standards, specifications, or acceptance criteria.
- `Junior`: bounded execution and shell-assisted exploration.
- `Explorer`: read-only codebase evidence gathering.
- `Librarian`: read-only external documentation and dependency-source research.

## Defined commands

Commands use currently selected primary agent and do not override it.

- `/plan`: prepare a detailed implementation plan and save it as a Markdown specification file.
- `/grill-me`: stress-test a plan or decision.
- `/grill-with-docs`: sharpen a plan or design while creating domain documentation.
- `/handoff`: prepare context for another agent or session.
- `/implement`: implement work from a specification or set of tickets.
- `/improve-codebase-architecture`: find and work through codebase architecture improvements.
- `/setup-matt-pocock-skills`: configure the repository for Matt Pocock's engineering skills.
- `/simplify`: simplify code without changing its behavior.
- `/to-spec`: turn the current conversation into a published specification.
- `/to-tickets`: break a plan or specification into tracer-bullet tickets.

## Shared skills

- [alexandru/skills](https://github.com/alexandru/skills/)
  - `code-review`: review changed code for bugs, structural problems, performance issues, and unintended behavior.
  - `simplify`: behavior-preserving code cleanup.
- [mattpocock/skills](https://github.com/mattpocock/skills/tree/v1.2.3)
  - `codebase-design`: deep-module design vocabulary and principles.
  - `diagnosing-bugs`: disciplined diagnosis for hard bugs and regressions.
  - `domain-modeling`: domain language and architectural decisions.
  - `grill-with-docs`: sharpen a plan or design while creating domain documentation.
  - `grilling`: structured decision-tree interviews.
  - `handoff`: prepare context for another agent or session.
  - `implement`: implement work from a specification or set of tickets.
  - `improve-codebase-architecture`: find and work through codebase architecture improvements.
  - `resolving-merge-conflicts`: merge and rebase conflict resolution.
  - `setup-matt-pocock-skills`: configure a repository for the engineering skills.
  - `tdd`: test-first development guidance.
  - `to-spec`: turn the current conversation into a published specification.
  - `to-tickets`: break a plan or specification into tracer-bullet tickets.
- [VirtusLab/cellar](https://github.com/VirtusLab/cellar/)
  - `cellar`: query the APIs of JVM dependencies (Scala, Java).
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)
  - `caveman`: token-efficient response modes with preserved technical accuracy.
- [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop)
  - `unslop`: remove AI writing patterns and add a human voice.

### Cellar

Install [Coursier](https://get-coursier.io/docs/cli-installation) first:

```sh
## MacOS
brew install coursier/formulas/coursier
cs setup

## Linux x86-64 (aka AMD64)
curl -fL "https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz" | gzip -d > cs

## Linux ARM64
curl -fL "https://github.com/VirtusLab/coursier-m1/releases/latest/download/cs-aarch64-pc-linux.gz" | gzip -d > cs
```

Install [Cellar](https://github.com/VirtusLab/cellar) for JVM dependency API lookup:

```sh
cs install --contrib cellar
cellar --version

# Disable telemetry
cellar telemetry disable
```

## Updating shared skills

```sh
make update-skills
```

This reinstalls the configured global skill roster from its upstream sources.
