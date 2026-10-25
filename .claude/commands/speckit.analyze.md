---
description: Perform a non-destructive cross-artifact consistency and quality analysis across spec.md, plan.md, and tasks.md.
---

## User Input

```text
$ARGUMENTS
```

## Outline

1. Read `.specify/feature.json` to get the feature directory path. Abort if `spec.md`, `plan.md`, or `tasks.md` is missing.

2. **Load**: `spec.md` (requirements, success criteria), `plan.md` (architecture, phases), `tasks.md` (task IDs, phases, file paths), `.specify/memory/constitution.md` (principles). **READ-ONLY — do not modify any file.**

3. **Detect issues** (max 50; severity: CRITICAL/HIGH/MEDIUM/LOW):
   - Duplication — near-duplicate requirements
   - Ambiguity — vague terms without metrics; TODO/placeholder markers
   - Underspecification — stories missing acceptance criteria; tasks referencing undefined components
   - Constitution alignment — any MUST conflict (always CRITICAL)
   - Coverage gaps — requirements with 0 tasks; tasks with no mapped requirement
   - Inconsistency — terminology drift; entity in plan but not spec; conflicting choices

4. **Emit report** with stable IDs (e.g. `D1`, `A2`):
   - Table: `ID | Category | Severity | Location | Summary | Recommendation`
   - Coverage summary: `Requirement | Has Task? | Task IDs | Notes`
   - Metrics: total requirements / tasks / coverage % / critical count

5. If CRITICAL findings exist, recommend resolving before `__SPECKIT_COMMAND_IMPLEMENT__`. Otherwise list improvements and offer "Suggest concrete edits for top N?" — never apply automatically.
