MATTPOCOCK_SKILLS_TAG := v1.2.3

.PHONY: update-skills check-mattpocock-skills-tag

check-mattpocock-skills-tag:
	@latest=$$(git ls-remote --tags --refs --sort=-version:refname https://github.com/mattpocock/skills.git 'v*' 2>/dev/null | sed -n '1s#.*refs/tags/##p'); \
	if [ -z "$$latest" ]; then \
		echo "WARN: unable to check the latest mattpocock/skills tag"; \
	elif [ "$$latest" != "$(MATTPOCOCK_SKILLS_TAG)" ]; then \
		echo "WARN: mattpocock/skills is pinned to $(MATTPOCOCK_SKILLS_TAG); latest tag is $$latest"; \
	fi

update-skills: check-mattpocock-skills-tag
	npx skills add https://github.com/alexandru/skills/ -y --skill \
		simplify
	npx skills add https://github.com/mattpocock/skills/tree/$(MATTPOCOCK_SKILLS_TAG) -y --skill \
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
	npx skills add https://github.com/VirtusLab/cellar/ -y 
	npx skills add https://github.com/JuliusBrussee/caveman -y --skill caveman
