# My OpenCode configuration

## Installation

**1)** Clone the repository into OpenCode's global configuration directory:

```sh
git clone https://github.com/alexandru/opencode-config.git ~/.config/opencode
```

`Orchestrator` is configured as the default agent in `opencode.common.jsonc`.

**2)** Choose a model preset before first use and whenever you want to switch profiles:

```sh
./bin/oc-switch p-openai
# or
./bin/oc-switch p-mix-go
./bin/oc-switch p-deepseek

# Docker-oriented profiles
./bin/oc-switch w-copilot
./bin/oc-switch w-openai
./bin/oc-switch w-mix-go
```

**WARN:** must run `oc-switch` at least once, otherwise `opencode.jsonc` is missing. The switcher generates `opencode.jsonc` from:

- `opencode.common.jsonc`
- `opencode.presets.jsonc`

## Defined agents

Main agents:

- `Orchestrator`: implements changes; delegates evidence, research, and checks.
- `Solo`: independently performs reasoning, research, changes, and verification without delegation.

Sub-agents:

- `Junior`: bounded execution and shell-assisted exploration.
- `Explorer`: read-only codebase evidence gathering.
- `Librarian`: read-only external documentation and dependency-source research.

## Defined commands

Commands use currently selected primary agent and do not override it; selecting Solo lets `/review` run as Solo.

- `/plan`: prepare a detailed implementation plan and save it as a Markdown specification file.
- `/grill-me`: stress-test a plan or decision.
- `/handoff`: prepare context for another agent or session.
- `/review`: review uncommitted changes, a commit, a branch, or a pull request.
- `/simplify`: simplify code without changing its behavior.

## Defined skills

- `caveman`: token-efficient response modes with preserved technical accuracy.
- `cellar`: query the APIs of JVM dependencies (Scala, Java).
- `codebase-design`: deep-module design vocabulary and principles.
- `diagnosing-bugs`: disciplined diagnosis for hard bugs and regressions.
- `domain-modeling`: domain language and architectural decisions.
- `grilling`: structured decision-tree interviews.
- `handoff`: prepare context for another agent or session.
- `resolving-merge-conflicts`: merge and rebase conflict resolution.
- `simplify`: behavior-preserving code cleanup.
- `tdd`: test-first development guidance.

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

## Updating Skills

```
make update-skills
```
