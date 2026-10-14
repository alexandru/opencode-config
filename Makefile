# Bootstrap and manage the local OpenCode configuration.
# The default target installs missing pipx and plugin dependencies, generates the
# default configuration when missing, and installs the shared skills globally.
# Never run automatically (no CI, no hooks); review upstream skill content before installation.

.NOTPARALLEL:

ALEXANDRU_SKILLS_TAG := v11.1.0
MATTPOCOCK_SKILLS_TAG := v1.3.1
SKILLS_AGENT := opencode
SKILLS_INSTALL_FLAGS := -g -a $(SKILLS_AGENT) -y

.PHONY: all install-pipx generate-config check-mattpocock-skills-tag install-skills update-skills test-oc-switch install-todo test-todo

all: install-pipx install-todo generate-config install-skills

# oc-switch runs through pipx.
install-pipx:
	@set -e; \
	if command -v pipx >/dev/null 2>&1; then \
		echo "pipx already installed: $$(pipx --version)"; exit 0; \
	fi; \
	case "$$(uname -s)" in \
		Darwin) brew install pipx ;; \
		Linux) sudo apt-get install -y pipx ;; \
		*) echo "Unsupported platform: $$(uname -s)" >&2; exit 1 ;; \
	esac

generate-config:
	@if [ ! -f opencode.jsonc ]; then \
		./bin/oc-switch default; \
	else \
		echo "opencode.jsonc already exists; leaving it untouched"; \
	fi

check-mattpocock-skills-tag:
	@latest=$$(git ls-remote --tags --refs --sort=-version:refname https://github.com/mattpocock/skills.git 'v*' 2>/dev/null | sed -n '1s#.*refs/tags/##p'); \
	if [ -z "$$latest" ]; then \
		echo "WARN: unable to check the latest mattpocock/skills tag"; \
	elif [ "$$latest" != "$(MATTPOCOCK_SKILLS_TAG)" ]; then \
		echo "WARN: mattpocock/skills is pinned to $(MATTPOCOCK_SKILLS_TAG); latest tag is $$latest"; \
	fi

install-skills:
	npx skills add https://github.com/alexandru/skills/tree/$(ALEXANDRU_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		code-review \
		code-reviewing \
		refine \
		refinements
	npx skills add https://github.com/mattpocock/skills/tree/$(MATTPOCOCK_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		codebase-design \
		diagnosing-bugs \
		domain-modeling \
		grill-me \
		grill-with-docs \
		grilling \
		handoff \
		implement \
		improve-codebase-architecture \
		setup-matt-pocock-skills \
		tdd \
		teach \
		to-spec \
		to-tickets
	npx skills add https://github.com/VirtusLab/cellar/ $(SKILLS_INSTALL_FLAGS)
	npx skills add https://github.com/JuliusBrussee/caveman $(SKILLS_INSTALL_FLAGS) --skill caveman
	npx skills add https://github.com/cursor/plugins/tree/main/pstack/skills/unslop $(SKILLS_INSTALL_FLAGS) --skill unslop
	@echo "Shared skills installed in ~/.agents/skills."

update-skills: check-mattpocock-skills-tag
	$(MAKE) install-skills

test-oc-switch:
	./bin/oc-switch-test.py

install-todo:
	@command -v bun >/dev/null 2>&1 || { echo "Bun >=1.4.2 is required; install it from https://bun.sh" >&2; exit 1; }
	@if [ ! -d ../plugins/opencode-todo-tool ]; then \
		mkdir -p ../plugins; \
		git clone git@github.com:alexandru/opencode-todo.git ../plugins/opencode-todo-tool; \
	fi
	cd ../plugins/opencode-todo-tool && bun install --frozen-lockfile

test-todo:
	cd ../plugins/opencode-todo-tool && make test
