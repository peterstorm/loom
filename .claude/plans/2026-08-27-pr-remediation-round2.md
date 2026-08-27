# PR Remediation Round 2 — Deterministic Task Completion Oracle

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `190833d6a568233694fdadd482886268b8db540c`
- Source review: `review-20260827T135113Z-deterministic-task-completion-oracle-post-remediation`
- Source digest: `96a8b5f0d0cdaeab49fe241d96dea39c3a89d554f7252650ace3edb2c39ec2fd`

## Mandatory critical remediation

1. `code-reviewer-1`: make duplicate Claude SubagentStart pointer ownership idempotent. Persist detects and proves an existing live same-agent binding; the surplus lease is released without touching the original sidecar, roster, or machine binding. Add duplicate lifecycle coverage.
2. `silent-failure-hunter-1`: make missing/mismatched anchored lock ownership a release error so the enclosing operation surfaces or aggregates ownership loss.
3. `silent-failure-hunter-2`: replace nullable evidence-line parsing with a typed result and make one corrupt ledger line invalidate the entire ledger read. Update ledger and dispatcher regressions.
4. `comment-analyzer-1`: remove `pi/reserved-results.ts`'s transitive import-time config I/O by deriving reviewer membership from the pure Agent Catalog module.
5. `comment-analyzer-2`: remove `pi/subagent-result.ts`'s transitive config import by deriving implementation/reviewer membership from the pure Agent Catalog module, making the extension's import-isolation claim true.

## Advisory dispositions

### Accepted

- `pr-test-analyzer-2`: add malformed persisted pointer-binding release coverage; prove corruption retains the live lease.
- `comment-analyzer-3`: support Pi's `filePath` write-target spelling and extend the behavior test.
- `code-simplifier-2`: replace the three mutable store-test-evidence outcome flags with one closed local outcome union after the critical paths are green.
- `code-simplifier-3`: share the duplicated invalid Task-suite fixture if it remains a local behavior-preserving edit after validation.

### Deferred

- `pr-test-analyzer-1`: macOS `O_NOFOLLOW_ANY` requires a Darwin CI/runtime; Linux cannot truthfully execute that kernel branch.
- `type-design-analyzer-1`: redesigning `WaveGateLifecycleEvidence` is a separate LC-1 interface deepening, broader than this remediation.
- `type-design-analyzer-2`: `TaskExecutionAuthorityPlan` is parser/registration guarded today; removing the duplicated convenience field is a separate interface migration.
- `architecture-tech-lead-1`: a repository-wide pure/runtime config split is a dedicated architecture slice; the two critical transitive imports are removed directly here.
- `architecture-tech-lead-2`: extracting the Trusted Review Witness aggregate is a separate Pi adapter deepening.
- `code-simplifier-1`: the missing-result manager-state refactor is unrelated to the surviving criticals and should be handled with the Pi runtime aggregate deepening.

### Dismissed

- `silent-failure-hunter-3`: ADR-0006 explicitly decides that LC-1 advisory projection failure degrades to the prior usable status path rather than replacing it with an error. The reported fallback is the accepted architecture, not hidden failure.

## Refuted audit

- No critical Finding was refuted in this source run.

## Validation

- Focused duplicate-start, pointer sidecar, no-follow lock, evidence ledger, dispatcher, Pi review/result tests.
- Typecheck + unused checks.
- Full bounded Vitest with 15s per-test timeout and four workers.
- Full smoke suite.
- Changed-production full-tier lint and `git diff --check`.
- Registered remediation with exact support paths, verified index installation, commit, and push.
- Fresh canonical Standalone Review after push.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-27-pr-remediation-round2.md`
- `engine/src/machine/ledger.ts` — required shell consumer for typed evidence-line failure.
- `engine/tests/machine/ledger.test.ts` — regression for whole-ledger fail-closed behavior.
