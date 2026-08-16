---
description: Create an implementation plan and todo list
---

Create an implementation plan for:

---

Input: $ARGUMENTS

---

## Workflow

1. **Analyze and clarify**

   - Read the user's request and any referenced files carefully.
   - Inspect relevant existing code, tests, configuration, documentation, and conventions before asking questions.
   - Ask targeted questions only to resolve material uncertainty about success criteria, constraints, scope boundaries, technical preferences, or assumptions — use the vendored `grilling` skill.
   - Proceed without questions when available context makes the request sufficiently clear.

2. **Present the plan**

   Present a concise but actionable implementation plan:

   - **Goal**: 1-3 sentences describing the desired outcome.
   - **Context**: existing behavior, relevant files, and important conventions discovered.
   - **Approach**: ordered implementation steps with effort estimates (`S` < 30 min, `M` < 2 h, `L` > 2 h).
   - **Testing Strategy**: how to validate the implementation.
   - **Risks**: what could go wrong or block progress.
   - **Assumptions**: what you assumed.
   - **Open questions**: decisions still unresolved, if any.

   Plan should be detailed enough for less-capable agents to have enough context and execute the plan successfully. If the work has more than 8 steps, split it into phases.

3. **Save the plan**

   Add a TODO item to write the plan to a descriptive markdown file at `./specs/<descriptive-kebab-case-name>/plan.md`.

   The markdown plan must include:

   - **Overview**: what needs to be done and why.
   - **Current Context**: relevant existing files, behavior, dependencies, and constraints.
   - **Architecture / Design**: high-level approach and important design decisions.
   - **Implementation Steps**: detailed, ordered steps with file paths and code locations where possible.
   - **Testing Strategy**: how to validate the implementation.
   - **Risks & Mitigations**: potential issues and how to address them.
   - **Success Criteria**: how to know the task is complete.
   - **Open Questions**: any remaining decisions or unknowns.

4. **Hand off**

   If you have file writing permission for `./specs/`, then write the plan to the file.
   Otherwise, end with:

> **Ready to execute?** Switch to **Builder** or assign to the appropriate agent to save the plan.
