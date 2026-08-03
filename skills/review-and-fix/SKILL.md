---
name: review-and-fix
version: "2.0.0"
description: "Review a PR, adjudicate critical findings through Loom's refutation panel, plan and implement surviving fixes, validate, commit, and optionally push."
---

# Review and Fix — Adjudicated End-to-End Remediation

Canonical workflow: review → refutation panel → plan → implement → validate → commit → push.

## Arguments

```text
/review-and-fix [code|errors|tests|types|comments|architecture|simplify|all]
  [--files file1,file2] [--no-push] [--dry-run] [--commit-msg "..."]
```

`all` is the default. `--dry-run` performs review, adjudication, and planning but
makes no code or git changes.

## Non-negotiable invariants

- Every reviewer is a sub-agent with an explicitly resolved LLM Profile.
- Persist every expected reviewer transcript; missing evidence fails closed.
- Never hand-build or text-deduplicate the finding set.
- Every critical is adjudicated before planning. Refuted criticals are audited,
  never fixed. Advisories never enter the panel.
- A panel/helper failure stops before edits. Never fall back to unadjudicated fixes.
- Standalone review runs never read or mutate `active_task_graph.json`.
- Validation must pass before commit. Never force-push.

## Phase 1 — Review and adjudicate

### 1. Resolve Loom and scope

Resolve and verify `LOOM_DIR` once. Determine the exact scope from `--files` or
the union of unstaged, staged, and `main...HEAD` changed paths. Empty scope is a
hard stop. Record diff stats and languages.

Create a fresh run directory; never reuse one:

```bash
REVIEW_RUNS_DIR=".claude/reviews/review-and-fix-runs"
mkdir -p "$REVIEW_RUNS_DIR" || exit 1
REVIEW_RUN_DIR="$(mktemp -d "$REVIEW_RUNS_DIR/run.XXXXXXXXXX")" || exit 1
mkdir -p "$REVIEW_RUN_DIR/reviewers"
printf '%s\n' "$REVIEW_RUN_DIR"
```

Retain the concrete printed path across tool calls.

### 2. Select and spawn reviewers

Applicable Machine-Summary reviewers:

1. `code-reviewer` — always
2. `silent-failure-hunter` — except docs-only scope
3. `pr-test-analyzer` — source or test behavior changed
4. `type-design-analyzer` — types/interfaces changed
5. `comment-analyzer` — comments/docs changed
6. `architecture-tech-lead` — `architecture`/`all`, or >500 additions, >10 files,
   new service/package/migration
7. `code-simplifier` — only when `simplify` was explicitly requested; normal
   simplification happens after fixes

Do not use `architecture-agent`: it is the interactive plan-producing phase
agent and does not implement this review contract.

Before any reviewer spawns, write `<review-run-dir>/review-plan.json` with the
exact scope and selected batch:

```json
{
  "scope": ["repo/relative/path.ts"],
  "expected_agents": ["code-reviewer", "type-design-analyzer"]
}
```

Freeze that authority through the engine:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper standalone-review init \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run-dir "<review-run-dir>" \
  --input "<review-run-dir>/review-plan.json"
```

`session.json` is immutable. A timed-out or omitted reviewer cannot later be
removed from the expected set to make incomplete evidence look clean.

For every selected agent, resolve its binding before spawn:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper model-profiles agent --agent <agent>
```

Spawn the exact selected batch in one message. Begin every reviewer prompt with
this exact standalone lifecycle marker:

```text
LOOM_REVIEW_CONTEXT: standalone
```

The Claude Code and Pi completion hooks recognize it and leave any active Task
State File untouched. Then give each reviewer the exact file scope, diff stats,
and instruction to emit its mandatory Machine Summary and fenced `findings`
block. After completion, write each raw output unchanged to:

```text
<review-run-dir>/reviewers/<ordinal>-<agent>.md
```

Write `<review-run-dir>/review-input.json`:

```json
{
  "reviews": [
    { "agent": "code-reviewer", "transcript": "<review-run-dir>/reviewers/1-code-reviewer.md" }
  ]
}
```

`reviews` must match the pre-spawn `session.json.expected_agents` exactly, in
order, and every entry must reference a distinct physical transcript file.

### 3. Aggregate through the engine

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper standalone-review aggregate \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run-dir "<review-run-dir>" \
  --input "<review-run-dir>/review-input.json"
```

This is the only transcript → finding path. It parses/reconciles Machine
Summaries, attributes stable ids, preserves duplicates, and writes
`aggregate.json`. Stop on any failure.

If `aggregate.json` has zero critical findings, skip directly to finalization:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper standalone-review finalize \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run-dir "<review-run-dir>"
```

Otherwise run the refutation panel.

### 4. Refutation panel for criticals

Build the engine-authored brief and fixed manifest:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel brief \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run-dir "<review-run-dir>" \
  --standalone "<review-run-dir>/aggregate.json"

bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel manifest \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run-dir "<review-run-dir>"

bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel lenses \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --manifest "<review-run-dir>/manifest.json"
```

Read `commands/templates/review-verify.md` and `references/review-lenses.md`.
Drive `helper panel-program refutation` with the exact manifest finding ids and
ordered lenses. Execute only its returned actions. Spawn the exact
`review-verifier-agent` batch in one message, using each request's resolved
`refutation` model profile. Each verifier covers every critical through one lens.

Validate each raw verifier output into its exact ordered slot:

```bash
printf '%s' "$RAW_OUTPUT" | bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel verdict \
  --lens "<exact-lens>" \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --manifest "<review-run-dir>/manifest.json" \
  > "<review-run-dir>/verdicts/verdict-N.json"
```

Retry only an invalid verifier once with the diagnostics. Stop after a second
failure. After every slot succeeds:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel tally \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --manifest "<review-run-dir>/manifest.json"
```

For critical-bearing runs, `tally` re-reads the manifest and canonical verdict
slots, recomputes the decision, and atomically publishes both run-scoped
`outcomes.json` and authoritative `result.json`. A hand-authored outcomes file
cannot be finalized. Read remediation inputs only from `result.json`:

- `surviving_critical_findings` — mandatory fixes
- `advisory_findings` — advisory triage
- `refuted_critical_findings` — report with lenses/reasons, never fix

## Phase 2 — Remediation plan

If there are no surviving criticals and no advisories, report a clean
adjudicated review and stop. If only advisories survive, ask whether to fix them.

Write `.claude/plans/YYYY-MM-DD-pr-remediation.md` with:

- branch, exact scope, and standalone run directory
- surviving critical fixes, then accepted advisories
- source finding id/agent/file/line/claim
- concrete minimal fix and validation command per finding
- a separate `Refuted Findings (not fixing)` audit section with every lens and reason
- project typecheck/test commands

Priority: build/type failures → silent failures → bugs → tests/types → architecture
→ comments/style. `--dry-run` stops after writing this plan.

## Phase 3 — Implement

Read `rules/architecture.md` and the relevant language rule files. Apply only
planned surviving findings, sequentially and minimally. Never implement an item
from `refuted_critical_findings`. Preserve semantics except where the surviving
finding identifies a bug.

After fixes, optionally run `code-simplifier` over the changed scope if requested.

## Phase 4 — Validate, commit, push

Run the detected typecheck/build and full relevant tests. Iterate failures to a
real fix; do not silently revert and call the finding resolved. If validation
cannot pass, stop without committing and report the blocker.

Before Phase 3, initialize an audited remediation path set with
`result.json.scope`. Every Edit/Write performed during remediation must add its
target path to that set, including newly created regression tests and support
files. When green, stage only that audited set plus the remediation plan—never
an unrestricted `git add -A`:

```bash
git add -A -- <each audited remediation path> <remediation-plan-path>
git diff --cached --name-only
```

Fail if the staged path set differs from that audited allowlist, then commit and push unless
`--no-push`. Run evidence under `.claude/reviews/review-and-fix-runs/` is ignored
and must never enter the commit. Do not force-push. A push failure leaves the valid local commit intact and is
reported with its SHA.

## Phase 5 — Summary

Report found, refuted, surviving, fixed, advisory, and deferred counts; the run
directory; plan; changed files; validation evidence; commit SHA; branch; and push
status. List refuted findings with their lenses and reasoning—a refutation nobody
can see is a deletion.
