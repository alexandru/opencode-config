---
description: Create an implementation plan and todo list
---

Create an implementation plan for:

---

Input: $ARGUMENTS

---

## Workflow

1. Clarify first

- Ask targeted questions to confirm understanding, especially for non-trivial or ambiguous requests.
- Ask about success criteria, constraints, scope boundaries, technical preferences, and assumptions.
- Only proceed without clarification if the request is truly self-explanatory and trivial.

2. Consider context

- Read the user's request and any referenced files carefully.
- Inspect relevant existing code, tests, configuration, documentation, and conventions.

3. Present the plan

Present a concise but actionable implementation plan:

- **Goal**: 1-3 sentences describing the desired outcome.
- **Context**: existing behavior, relevant files, and important conventions discovered.
- **Approach**: ordered implementation steps with effort estimates (`S` < 30 min, `M` < 2 h, `L` > 2 h).
- **Testing Strategy**: how to validate the implementation.
- **Risks**: what could go wrong or block progress.
- **Assumptions**: what you assumed.
- **Open questions**: decisions still unresolved, if any.

Prefer shorter plans. If the work has more than 8 steps, split it into phases.

4. Save the plan and write todos

Write the plan directly to a descriptive markdown file at `./.plans/<descriptive-kebab-case-name>.md`.

The markdown plan must include:

- **Overview**: what needs to be done and why.
- **Current Context**: relevant existing files, behavior, dependencies, and constraints.
- **Architecture / Design**: high-level approach and important design decisions.
- **Implementation Steps**: detailed, ordered steps with file paths and code locations where possible.
- **Testing Strategy**: how to validate the implementation.
- **Risks & Mitigations**: potential issues and how to address them.
- **Success Criteria**: how to know the task is complete.
- **Open Questions**: any remaining decisions or unknowns.

5. Hand off

End with:

> **Ready to execute?** Switch to **build** (Tab) or assign to the appropriate agent to begin implementation.
