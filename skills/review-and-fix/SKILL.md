---
name: review-and-fix
version: "3.1.0"
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
- Refuted criticals are audited and never fixed. Every surviving critical is
  mandatory. By default, the parent autonomously dispositions each advisory as
  accepted, deferred, or dismissed; it does not ask the operator to choose IDs.
  Validation must pass before remediation installation.
- Never force-push.

## Phase 1 — Registered standalone review

Name one fresh Run Directory and start the façade with user policy only. The
engine creates the Run Directory; `--run` takes either its bare run id or a full
path to that same direct child of `--runs-root`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start standalone-review \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-review-run-id>" <<'JSON'
{"kind":"all","files":null,"dryRun":false}
JSON
```

Spawn the exact returned batch. Each reviewer's exact raw bytes must then reach
its reserved slot. On a harness that captures transcripts itself this already
happened at spawn completion and a repeat submit is an idempotent confirmation;
on any other harness the parent performs it, once per issued request:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration submit \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>" \
  --request "<exact-request-id>" --slot "<exact-slot-id>" --attempt 1 \
  < "<reviewer-raw-output>"
```

Then resume until `done`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>"
```

The registered Standalone Review Program automatically routes non-empty
critical sets through its registered Refutation Panel and publishes canonical
`result.json`. Read remediation inputs only from that authoritative result:

- `surviving_critical_findings` — mandatory fixes
- `advisory_findings` — autonomous parent triage by default
- `refuted_critical_findings` — report, never fix

## Phase 2 — Plan

Every surviving critical Finding is mandatory. Independently disposition every
advisory as `accepted`, `deferred`, or `dismissed`. By default, make this choice
autonomously from the evidence, correctness impact, risk, and reviewed scope;
do not ask the operator to choose advisory IDs. Accept an advisory when its
claim is sound and a complete in-scope fix is practical. Defer or dismiss only
with a concrete evidence-based reason. An explicit user instruction about a
specific advisory overrides this default.

If neither criticals nor accepted advisories survive, report the clean review
or advisory dispositions and stop.

Write `.claude/plans/YYYY-MM-DD-pr-remediation.md` containing branch, exact
scope, review Run Directory, every surviving critical and concrete fix, every
advisory disposition and reason, accepted advisory fixes, refuted-finding
audit, and validation commands. `--dry-run` stops here.

## Phase 3 — Implement and validate

Read `rules/architecture.md` and relevant language rules. Apply only planned
surviving findings. Register every necessary support path in the remediation
start input. Run typecheck/build and full relevant tests; iterate to a real fix.
Stop without staging or committing if validation cannot pass.

## Phase 4 — Registered remediation

Name a fresh remediation Run Directory. The source review run remains immutable
authority, and `sourceRun` names it the same way `--run` does — bare run id or
full path, resolved against `sourceRunsRoot`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start remediation \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-remediation-run-id>" <<'JSON'
{
  "sourceRunsRoot":".claude/reviews/review-and-fix-runs",
  "sourceRun":"<review-run-id>",
  "supportPaths":["<plan-or-regression-path-not-in-reviewed-scope>"]
}
JSON
```

Every path the remediation touches that is NOT inside the frozen review scope —
the plan file, a regression pin added for an accepted fix — must be named in
`supportPaths` **here**, at start. The start input is registered exclusively and
admits only a byte-identical re-registration, so a run cannot authorize a path
its own start input never named.

A `blocked` start reports the exact cause and leaves the run registered. Never
delete a run directory to retry: the run holds the evidence of why it blocked.
Recovery depends on the cause:

- **source review is not `done`** — finish or fix the source run, then `resume`
  the SAME run.
- **unrelated staged work** — unstage it, then `resume` the SAME run.
- **unauthorized dirty paths** — resume the same run only if the dirty state is
  genuinely unrelated and can be reverted or committed away. If the path belongs
  to the remediation (the case `supportPaths` exists for), the same run can
  never authorize it: start a **fresh** remediation run whose start input adds
  the path to `supportPaths`. The blocked run stays in place as evidence.

When a fresh run supersedes a blocked one, say so in the retired run rather
than only in this session, so the next operator reading the runs root can tell
which of the two is live:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration abandon \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<blocked-run-id>" --superseded-by "<fresh-run-id>" \
  --reason "<why it was replaced>"
```

`helper orchestration inspect --runs-root <root> --run <run-id>` reads any
run's program, state, per-slot capture, and rejection diagnostics in one
command — use it instead of hand-reading `checkpoint.json` and `events/`.

Resume until `done`. The engine proves observed dirty paths are authorized,
rejects excluded Run evidence and unrelated staged work, stages literal paths
in a temporary index, proves `audited == staged`, rechecks the repository
witness under the real index lock, and atomically installs the verified index.
The parent must not run its own staging recipe.

Commit the installed index and push unless `--no-push`. A push failure leaves
the valid local commit intact and is reported with its SHA.

## Phase 5 — Report

Report found/refuted/surviving/fixed/advisory counts, every advisory disposition
and reason, both Run Directories, plan, changed files, validation evidence,
installation receipt, commit SHA, branch, and push status. Include every
refuted finding with panel reasoning.
