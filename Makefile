# Bootstrap and manage the local OpenCode configuration.
# The default target installs missing pipx, generates the
# default configuration when missing, and installs the shared skills globally.
# Never run automatically (no CI, no hooks); review upstream skill content before installation.

.NOTPARALLEL:

ALEXANDRU_SKILLS_TAG := v13.2.2
MATTPOCOCK_SKILLS_TAG := v1.3.1
SKILLS_AGENT := opencode
SKILLS_INSTALL_FLAGS := -g -a $(SKILLS_AGENT) -y
COURSIER_LINUX_X86_64_URL := https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz
COURSIER_LINUX_AARCH64_URL := https://github.com/VirtusLab/coursier-m1/releases/latest/download/cs-aarch64-pc-linux.gz
# Coursier installs launchers outside the default PATH of a non-login shell.
COURSIER_BIN_PATHS := $(HOME)/.local/bin:$(HOME)/.local/share/coursier/bin:$(HOME)/Library/Application Support/Coursier/bin

.PHONY: all install-pipx generate-config check-mattpocock-skills-tag install-skills update-skills install-coursier install-cellar test test-oc-switch test-agents-status

all: install-pipx generate-config install-skills install-cellar

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
		code-refine \
		code-refinements \
		external-research
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
	@echo "Shared skills installed in ~/.agents/skills."

update-skills: check-mattpocock-skills-tag
	$(MAKE) install-skills

# The cellar skill shells out to the cellar CLI, installed through Coursier.
install-coursier:
	@set -e; \
	export PATH="$(COURSIER_BIN_PATHS):$$PATH"; \
	if command -v cs >/dev/null 2>&1; then \
		echo "coursier already installed: $$(cs version)"; exit 0; \
	elif command -v coursier >/dev/null 2>&1; then \
		echo "coursier already installed: $$(coursier version)"; exit 0; \
	fi; \
	case "$$(uname -s)" in \
		Darwin) \
			brew install coursier; \
			coursier setup --yes ;; \
		Linux) \
			case "$$(uname -m)" in \
				x86_64|amd64) url="$(COURSIER_LINUX_X86_64_URL)" ;; \
				aarch64|arm64) url="$(COURSIER_LINUX_AARCH64_URL)" ;; \
				*) echo "Unsupported architecture: $$(uname -m)" >&2; exit 1 ;; \
			esac; \
			mkdir -p "$$HOME/.local/bin"; \
			archive=$$(mktemp); \
			trap 'rm -f "$$archive"' 0; \
			curl -fL "$$url" -o "$$archive"; \
			gzip -dc "$$archive" > "$$HOME/.local/bin/cs"; \
			chmod +x "$$HOME/.local/bin/cs"; \
			"$$HOME/.local/bin/cs" setup --yes ;; \
		*) echo "Unsupported platform: $$(uname -s)" >&2; exit 1 ;; \
	esac

install-cellar: install-coursier
	@set -e; \
	export PATH="$(COURSIER_BIN_PATHS):$$PATH"; \
	if command -v cellar >/dev/null 2>&1; then \
		echo "cellar already installed: $$(cellar --version)"; \
	else \
		if command -v cs >/dev/null 2>&1; then cs=cs; else cs=coursier; fi; \
		"$$cs" install --contrib cellar; \
		cellar --version; \
		cellar telemetry disable --global; \
	fi; \
	./bin/utils/setup-path; \
	echo "Cellar PATH updated; new shells will pick it up."

test: test-oc-switch test-agents-status

test-oc-switch:
	./tests/oc-switch-test.py

test-agents-status:
	cd plugins/agents-status && bun install && bun test
