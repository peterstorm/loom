---
name: review-and-fix
version: "3.0.0"
description: "Review a PR, adjudicate critical findings, remediate, validate, and install an exact verified Git index."
---

# Review and Fix

Canonical workflow: registered standalone review → engine-owned refutation →
plan → remediation → validation → verified index installation → commit/push.

## Arguments

```text
/review-and-fix [code|errors|tests|types|comments|architecture|simplify|all]
  [--files file1,file2] [--no-push] [--dry-run] [--commit-msg "..."]
```

`all` is the default. Resolve `LOOM_DIR` once from the active plugin package.

## Invariants

- The orchestration façade owns scope derivation, reviewer/model/Skill policy,
  request authority, transcript capture, retries, aggregation, adjudication,
  publication, path audit, temporary-index staging, verification, and install.
- Execute only `spawn-batch`, `await-user`, `blocked`, or `done` actions.
- Never hand-build findings, verdicts, manifests, transcript files, Git
  pathspecs, or protected-state mutations.
- Refuted criticals are audited and never fixed. Advisories require explicit
  operator disposition. Validation must pass before remediation installation.
- Never force-push.

## Phase 1 — Registered standalone review

Create one fresh direct-child Run Directory and start the façade with user
policy only:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start standalone-review \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-review-run-directory>" <<'JSON'
{"kind":"all","files":null,"dryRun":false}
JSON
```

Spawn the exact returned batch. After harness completion, resume until `done`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-directory>"
```

The registered Standalone Review Program automatically routes non-empty
critical sets through its registered Refutation Panel and publishes canonical
`result.json`. Read remediation inputs only from that authoritative result:

- `surviving_critical_findings` — mandatory fixes
- `advisory_findings` — explicit triage
- `refuted_critical_findings` — report, never fix

## Phase 2 — Plan

If nothing survives, report a clean adjudicated review and stop. If only
advisories survive, ask whether to remediate them.

Write `.claude/plans/YYYY-MM-DD-pr-remediation.md` containing branch, exact
scope, review Run Directory, each surviving finding and concrete fix, accepted
advisories, refuted-finding audit, and validation commands. `--dry-run` stops
here.

## Phase 3 — Implement and validate

Read `rules/architecture.md` and relevant language rules. Apply only planned
surviving findings. Register every necessary support path in the remediation
start input. Run typecheck/build and full relevant tests; iterate to a real fix.
Stop without staging or committing if validation cannot pass.

## Phase 4 — Registered remediation

Create a fresh remediation Run Directory. The source review run remains
immutable authority:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start remediation \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-remediation-run-directory>" <<'JSON'
{
  "sourceRunsRoot":".claude/reviews/review-and-fix-runs",
  "sourceRun":"<review-run-directory>",
  "supportPaths":["<plan-or-regression-path-not-in-reviewed-scope>"]
}
JSON
```

Resume until `done`. The engine proves observed dirty paths are authorized,
rejects excluded Run evidence and unrelated staged work, stages literal paths
in a temporary index, proves `audited == staged`, rechecks the repository
witness under the real index lock, and atomically installs the verified index.
The parent must not run its own staging recipe.

Commit the installed index and push unless `--no-push`. A push failure leaves
the valid local commit intact and is reported with its SHA.

## Phase 5 — Report

Report found/refuted/surviving/fixed/advisory counts, both Run Directories,
plan, changed files, validation evidence, installation receipt, commit SHA,
branch, and push status. Include every refuted finding with panel reasoning.
