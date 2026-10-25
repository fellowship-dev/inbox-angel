---
description: Generate a custom checklist for the current feature based on user requirements.
scripts:
  sh: scripts/bash/check-prerequisites.sh --json
  ps: scripts/powershell/check-prerequisites.ps1 -Json
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Run `hooks.before_checklist` from `.specify/extensions.yml` if present.

## Concept: "Unit tests for English"

Checklists validate **requirements writing quality** — not implementation.

- ✅ "Is 'prominent display' quantified with sizing/positioning?" (clarity)
- ✅ "Are visual hierarchy requirements defined for all card types?" (completeness)
- ✅ "Are hover-state requirements consistent across interactive elements?" (consistency)
- ❌ "Verify the button clicks correctly" (that's a test, not a checklist)
- ❌ "Confirm API returns 200" (testing implementation, not the spec)

## Steps

1. **Setup**: run `{SCRIPT}`. Parse `FEATURE_DIR`. Escape quotes in args: `'I'\''m Groot'`.

2. **Derive domain** from user input:
   - If user named a domain (ux, security, accessibility, performance, data-model, api), use it.
   - Else infer one from spec.md content.

3. **Load spec.md** from `FEATURE_DIR`. Extract requirements, success criteria, user stories relevant to the domain.

4. **Generate checklist** at `FEATURE_DIR/checklists/<domain>.md`:
   - Start from `templates/checklist-template.md`.
   - 10–20 items grouped by quality dimension. Use these six:
     - **Completeness**: are all needed requirements present?
     - **Clarity**: are they unambiguous and specific?
     - **Consistency**: do they agree with each other?
     - **Measurability**: can each be objectively verified?
     - **Coverage**: are all flows / scenario classes addressed?
     - **Edge Cases**: are boundary and failure conditions defined?
   - Each item is a yes/no question targeting requirement quality.
   - Tie each question to specific spec sections where possible (`[Spec §X.Y]` or `[Gap]`).

5. **Report**: path to checklist file, item count, grouping summary.

6. Run `hooks.after_checklist` if present.

## Rules

- Questions must be answerable with yes/no against the spec alone.
- Never generate implementation-validation items.
- Skip trivial items — favor ones that catch real ambiguity.
