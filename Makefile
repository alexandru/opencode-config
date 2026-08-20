MATTPOCOCK_SKILLS_TAG := v1.2.3
SKILLS_AGENT := opencode
SKILLS_INSTALL_FLAGS := -g -a $(SKILLS_AGENT) -y

.PHONY: install-skills update-skills check-mattpocock-skills-tag

check-mattpocock-skills-tag:
	@latest=$$(git ls-remote --tags --refs --sort=-version:refname https://github.com/mattpocock/skills.git 'v*' 2>/dev/null | sed -n '1s#.*refs/tags/##p'); \
	if [ -z "$$latest" ]; then \
		echo "WARN: unable to check the latest mattpocock/skills tag"; \
	elif [ "$$latest" != "$(MATTPOCOCK_SKILLS_TAG)" ]; then \
		echo "WARN: mattpocock/skills is pinned to $(MATTPOCOCK_SKILLS_TAG); latest tag is $$latest"; \
	fi

install-skills:
	npx skills add https://github.com/alexandru/skills/ $(SKILLS_INSTALL_FLAGS) --skill \
		simplify
	npx skills add https://github.com/mattpocock/skills/tree/$(MATTPOCOCK_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		codebase-design \
		code-review \
		diagnosing-bugs \
		domain-modeling \
		grill-with-docs \
		grilling \
		handoff \
		implement \
		improve-codebase-architecture \
		resolving-merge-conflicts \
		setup-matt-pocock-skills \
		tdd \
		to-spec \
		to-tickets
	npx skills add https://github.com/VirtusLab/cellar/ $(SKILLS_INSTALL_FLAGS)
	npx skills add https://github.com/JuliusBrussee/caveman $(SKILLS_INSTALL_FLAGS) --skill caveman
	@echo "Shared skills installed in ~/.agents/skills."

update-skills: check-mattpocock-skills-tag
	$(MAKE) install-skills
