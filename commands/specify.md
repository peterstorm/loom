---
name: specify
version: "1.0.0"
description: "This skill should be used when the user asks to 'specify a feature', 'write requirements', 'define what we're building', 'capture requirements', 'document the spec', or before invoking the architecture-tech-lead skill (`/skill:architecture-tech-lead` in Pi) for non-trivial features. Produces formal specifications (WHAT/WHY) that feed into architecture and planning phases."
argument-hint: "[$feature description] [--update] [--status]"
---

# Specify - Requirements Before Design

Write requirements as a structured specification before any architecture or planning. A spec says WHAT users need and WHY, never HOW.

**Arguments:** "$ARGUMENTS"

## Two ways this skill runs

- **Standalone (`/specify`).** Follow this whole file. The flow is `/specify` → `/clarify` (when the spec has more than 3 markers) → the `architecture-tech-lead` skill.
- **Inside `/loom`.** The specify-agent preloads this skill and its phase prompt sets the order of work, the interview and the output path. Use only [Writing the specification](#writing-the-specification) and [Quality checks](#quality-checks) from this file. The sections marked *standalone only* do not apply: `/loom` runs clarify and architecture as its own phases.

`/loom` runs its own brainstorm, specify and clarify phases. To have `/loom` use a spec written standalone, put it at `.claude/specs/{YYYY-MM-DD}-{slug}/spec.md` and start `/loom` with `--skip-specify`.

## Package resources

Resolve this command's owning package once. Claude Code expands the token in source; Loom's Pi adapter renders it from the extension module's `import.meta.url`:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/references/spec-template.md" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
printf 'LOOM_DIR=%s\n' "$LOOM_DIR"
```

Never infer the package from cwd or scan another harness's cache. Below, `{LOOM_DIR}` stands for the printed path.

## Arguments (standalone only)

- `/specify "feature description"`: create a new specification
- `/specify --update`: update the existing spec with new information
- `/specify --status`: report the spec's completeness against [Quality checks](#quality-checks) and its marker count

## Output

`.claude/specs/{YYYY-MM-DD}-{slug}/spec.md`. `/clarify` later adds a `clarifications/` directory beside it.

## Before writing (standalone only)

1. **Derive the slug** from the description: 2-4 words, action-noun (`user-auth`, `email-validation`, `payment-flow`), lowercase, hyphenated, technical terms preserved.
2. **Explore context.** Check existing specs (`ls .claude/specs/`), review the related code, and understand the current state.

## Writing the specification

Read `{LOOM_DIR}/references/spec-template.md` and fill in its sections. The template owns the format: section names, the canonical `FR-NNN:` / `AS-NNN:` / `OOS-NNN:` identifiers, the glossary table, RFC 2119 keywords and the examples of good and bad entries. The engine parses that grammar, so follow it exactly.

**No implementation detail.** A spec mentions no tech stack, API design, database schema, framework or code pattern. If you are tempted to write HOW, write `[NEEDS CLARIFICATION: technical approach TBD]` and move on.

**Mark every ambiguity** where it occurs:

```markdown
- FR-003: System MUST validate user input [NEEDS CLARIFICATION: validation rules undefined]
```

Uncertainty comes in five kinds: business logic (rules, thresholds, behaviors), scope boundaries, edge cases (error states, limits), user expectations (unclear acceptance criteria), and technical feasibility. Technical questions are settled in architecture, not here.

## Quality checks

Before finishing, verify:

| Check | Criteria |
|-------|----------|
| No HOW | Zero tech stack, API or implementation mentions |
| Testable | Every FR has a clear pass/fail condition |
| Measurable | Every SC has a specific metric, not "fast" or "reliable" |
| Scoped | Out of Scope section populated |
| Glossary | Appendix: Glossary populated with non-empty, unique term/definition rows |
| Prioritized | Every user scenario has P1, P2 or P3 |
| Uncertain marked | Every ambiguity carries `[NEEDS CLARIFICATION: ...]` |

## Counting markers and handing off (standalone only)

Count the markers in the spec you just wrote, and in no other:

```bash
SPEC=".claude/specs/<date>-<slug>/spec.md"
test -f "$SPEC" || { echo "FATAL: no spec at $SPEC" >&2; exit 1; }
# grep -c exits 1 when the count is 0 (a good state) and 2 on a real error.
grep -c "NEEDS CLARIFICATION" "$SPEC" || [ $? -eq 1 ]
```

- **More than 3:** invoke `/clarify` on that spec before going further.
- **3 or fewer:** leave them for the architecture step to settle.

Then:

1. Commit the spec: `git add .claude/specs/ && git commit -m "spec: {slug}"`
2. Invoke the `architecture-tech-lead` skill. It reads the spec and produces a plan with the technical decisions.
