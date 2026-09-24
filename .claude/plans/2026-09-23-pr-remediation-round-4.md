# PR Remediation Round 4 — 2026-09-23 (review-and-fix v6.0.0)

## Branch and scope

- **Branch:** `fix/abandoned-gate-terminal-outcome` at HEAD `7f8308d20c10913ffba50b7428682cfac3ccaeac` (clean tree at plan time).
- **Review scope (frozen, 158 files):** changed-path union `9eacc301…..7f8308d2` — the round-3 remediation delta plus this branch's settlement/boundary work.
- **Review kind:** `all` (code/errors/tests/types/comments/architecture/simplify).

## Run Directories

| Role | Run Directory |
| --- | --- |
| Registered standalone review (authoritative) | `.claude/reviews/review-and-fix-runs/review-fix-20260923T142200Z-7f8308d2-r2` |
| Predecessor (terminally blocked, abandoned as superseded evidence) | `.claude/reviews/review-and-fix-runs/review-fix-20260923T131500Z-7f8308d2` — type-design-analyzer payload rejected twice (`Reviewer payload must be exactly one strict JSON object.`; missing brace / misplaced `evidence.reference`), bounded retry exhausted, `terminal-blocked`; abandoned with `--superseded-by` this run's id |
| Advisory disposition policy (P5 publication) | `.claude/reviews/review-and-fix-runs/policy-20260923T151200Z-r4`, disposition digest `152376b60b48bddd2974d9b2859216a1d74918caa4ea08ed4a17a753669d56fc`, revision `initial`, provenance `DECLARED` |
| Registered remediation (to be started in Phase 4) | `.claude/reviews/review-and-fix-runs/remediation-20260923T<fresh>-7f8308d2` |

Canonical review result: `result.json` digest `7f57c3032f74f04599c805009a570080b4605a4bcd57d5582fdf15b4f338739c` (77,463 bytes), published by the standalone-review program after Refutation Panel adjudication.

## Review outcome (engine-rendered counts)

- **Emitted/admitted:** 1 critical; 14 advisory (7 reviewer slots; one bounded attempt-2 retry on `type-design-analyzer` after an out-of-scope-location refusal — engine-owned fail-closed behavior, no synthetic findings).
- **Refutation Panel:** 3 lenses (reproduction, intent, security) — all three **upheld** the single critical.
- **After refutation:** 1 surviving critical; **0 refuted criticals**; 14 advisory.

## Surviving critical disposition (copied exactly once from canonical result.json)

### `architecture-tech-lead-1` — status: `repaired`

`resetRemediationReport` (engine/src/orchestration/completion-check-runner.ts:250) digests a single unobserved status-0/empty-stdout `git ls-files` success into destructive authorization: the tracked-file refusal arm is bypassed by the transient empty-success class, after which a tracked, ignore-matched enrolled report path has its worktree copy unlinked. The canonical bounded empty-retry (`observeGitProbe`, utils/git-probe.ts) enforced at the five Git-observing families is not applied at this destructive-guard site. Upheld unanimously by the reproduction, intent, and security panel lenses.

## Declared Repair Group

**Group ID:** `group.remediation-report-reset-empty-retry`
**Finding IDs:** `architecture-tech-lead-1`
**Provenance:** `DECLARED` (all of root cause, invariant, siblings, Historical RED)

- **Root cause (DECLARED):** the destructive guard digested a single status-0/empty-stdout `git ls-files` success into tracked/untracked authority, ingesting an unobserved empty into a destructive decision; the tracked-file refusal arm (`tracked.stdout.length !== 0`) is skipped by the field-observed transient empty-success class documented in utils/git-probe.ts.
- **Invariant (DECLARED):** the reset guard re-observes the ls-files probe through the canonical bounded empty-retry; only a **confirmed-empty** observation hands the "empty legitimately means untracked" decision to the reset; any non-empty stdout still refuses loudly (`report reset cannot prove exact path is untracked`); a failed observation throws with attribution. A single unobserved empty never authorizes the unlink.
- **Sibling accounting:** `none-declared` (DECLARED reason) — `resetRemediationReport` is the only destructive report-reset site; the five sibling Git-observing families (config boundary root, utils/git probes, git-remediation, workspace-digest, reviewer-scope derivation) already enforce the canonical policy.
- **Selected check:** `project:verify` (enrolled 2026-09-09: fixed `npm run verify`, root cwd, required report `.loom/completion-reports/verify.junit.xml`, 30-minute budget).
- **Historical RED (DECLARED):** the scripted regression rows in `engine/tests/orchestration/report-reset-empty-retry.test.ts` (transient status-0/empty-stdout `ls-files` responses discharging into a tracked answer, against a tracked+ignore-matched enrolled report path) fail against the reviewed vulnerable behavior — the single-probe reset proceeds to unlink instead of refusing — and pass against the repaired bounded-retry guard. Reference: canonical result.json finding `architecture-tech-lead-1`.

DECLARED facts above are parent declarations. The engine's registered remediation runner must **freshly observe** the selected check (`repair-checked`, never proven closure).

## Advisory dispositions (autonomous triage; published via P5)

Policy publication: run `policy-20260923T151200Z-r4`, disposition digest `152376b60b48bddd2974d9b2859216a1d74918caa4ea08ed4a17a753669d56fc`, revision `{kind:"initial"}`, provenance `DECLARED`, complete 14-entry coverage of `advisoryInventory` in engine order. **11 accepted, 3 deferred, 0 dismissed.**

**Correction revision (pending publication):** implementation falsified the accepted premise of advisory 11 (`architecture-tech-lead-3`): enrolling `state-file-wire.ts` in `DEFAULT_PURE_MODULES` breaks the machine-purity closure audit — `state-file-wire.ts` transitively imports `config.ts`, which probes the filesystem through `spawnSync`/`fs` and can never join the pure closure — so the enrollment was reverted (closure test green again, `machine-purity.test.ts` 534 passed) and the disposition moves to **deferred** via a published `correction` revision naming the initial digest. Final round counts: **10 accepted, 4 deferred, 0 dismissed.**

| # | Finding ID | Disposition | Reason (DECLARED, published) |
| --- | --- | --- | --- |
| 1 | `code-reviewer-1` | accepted | Round-3 accepted advisory promised pin+append; grep shows no test touches the raced spawn-failed arm; one focused row closes the silent-revert gap. |
| 2 | `code-reviewer-2` | accepted | Reviewer-reproduced: `--branch` status probe can never legitimately answer empty; confirmed-empty decision must be `refuse` per GitEmptyDecision contract (small fail-closed change + comment fix). |
| 3 | `silent-failure-hunter-1` | deferred | Narrow single-operator race, no downstream safety consequence; stability re-observation changes registered v2 start behavior — its own reviewed change, not a rider. |
| 4 | `pr-test-analyzer-1` | accepted | Three live load-guard refusals lack the established per-guard pins; mechanical mutation rows close a regression-detection gap at the State File load boundary. |
| 5 | `pr-test-analyzer-2` | accepted | Same raced spawn-failed arm as code-reviewer-1; pin both trigger spellings. |
| 6 | `type-design-analyzer-1` | accepted | Replace `as never`/tuple casts at the request-id mint with the parseRequestId proof and a structurally built attempts pair — local, behavior-identical. |
| 7 | `type-design-analyzer-2` | deferred | Parity convention is correct and roster digest fails closed; typed per-role pair refactor ripples through packet build + four publication sites — its own reviewed change. |
| 8 | `comment-analyzer-1` | accepted | Zero-additions decision is deliberate and pinned; only the stated rationale is false (reviewer-executed numstat reproduction) — comment correction. |
| 9 | `comment-analyzer-2` | accepted | "Only occurrence" quantifier falsified by the in-scope plan document; scope the exhaustiveness claim. |
| 10 | `architecture-tech-lead-2` | deferred | Attribution-only gap; normal no-base path must keep its null shape; reshaping the frozen scope authority surface deserves its own change. |
| 11 | `architecture-tech-lead-3` | deferred (correction) | Initial premise falsified: the reviewer verified the linter rule, but the machine-purity closure audit refuses the enrollment — state-file-wire transitively imports I/O-bearing config; enrollment reverted, split purity stays enforced by the module's own unit suite; a dependency diet is its own reviewed change. |
| 12 | `code-simplifier-1` | accepted | One file-local adapter for five private spawnSync→probe wraps; behavior-preserving by construction, pinned by reviewer-scope-empty-retry.test.ts. |
| 13 | `code-simplifier-2` | accepted | Two inline module-qualified import-types → one plain `import type` (erased type positions, no cycle). |
| 14 | `code-simplifier-3` | accepted | Hoist the token-identical `changed` fixture shared by the two numstat rows; no assertion weakened. |

**Refuted-finding audit:** none — `refuted_critical_findings` is empty; no refuted critical is repaired or added to the defect family.

## Accepted advisory fix map (files, all inside frozen review scope)

1. `engine/src/orchestration/completion-check-runner.ts` — nothing for advisories here beyond the critical repair itself (advisories 1/5 are test-side).
2. `engine/tests/orchestration/raced-spawn-failed-arm.test.ts` (**new, out-of-scope**) — raced spawn-failed arm pins for both trigger spellings (timeout + cancelled; assert `…had failed to start: <cause>` termination-unconfirmed; fake pid outside every pid space keeps the group probes at a provable ESRCH).
3. `engine/tests/orchestration/report-reset-empty-retry.test.ts` (**new, out-of-scope**) — the critical's Historical RED regression rows: scripted status-0/empty-stdout transient empties discharging into the observed tracked truth refuse the reset (file and index intact, full retry budget consumed); confirmed-empty after the full budget proceeds; a failed probe attributes `could not observe tracked state` instead of a generic untracked refusal.
3. `engine/src/handlers/helpers/programs/standalone.ts` — `successorGitAuthorityWitness` GitEmptyDecision `legitimate` → `refuse` + truthful comment (advisory 2).
4. `engine/src/handlers/helpers/programs/helpers.ts` — parseRequestId mint + structural attempts pair (advisory 6); five probe wraps → one file-local adapter (advisory 12); untrackedAdditions comment correction (advisory 8).
5. `engine/src/state-file-wire.ts` — plain `import type` for LegacyWaveGateCompatibilityAuthority (advisory 13).
6. `engine/src/linter/programmatic/no-io-in-pure-modules.ts` — ~~enroll `engine/src/state-file-wire.ts`~~ **REVERTED during implementation**: the machine-purity closure audit (`tests/linter/programmatic/machine-purity.test.ts`) refuses the enrollment because `state-file-wire.ts` transitively imports `config.ts` (filesystem probes via `spawnSync`/`fs`); the advisory is deferred by policy correction instead (advisory 11).
7. `engine/src/linter/programmatic/no-cross-boundary-imports.ts` — scope the inert-grant exhaustiveness comment (advisory 9).
8. `engine/tests/state-manager-implementation-completion.test.ts` — three Task-attempt load-guard pin rows (advisory 4): identity/Wave mismatch, escalated lineage carrying an active attempt, and semantic attempt contradicting settlement history.
9. `engine/tests/handlers/helpers/programs/reviewer-scope-empty-retry.test.ts` — shared `changed` fixture (advisory 14).

## Deferred advisories (not implemented)

`silent-failure-hunter-1`, `type-design-analyzer-2`, `architecture-tech-lead-2`, and (by correction revision) `architecture-tech-lead-3` — published as deferred with the DECLARED reasons in the table above.

## Remediation start input (schema v2)

```json
{
  "sourceRunsRoot": ".claude/reviews/review-and-fix-runs",
  "sourceRun": "review-fix-20260923T142200Z-7f8308d2-r2",
  "supportPaths": [
    ".claude/plans/2026-09-23-pr-remediation-round-4.md",
    "engine/tests/orchestration/report-reset-empty-retry.test.ts",
    "engine/tests/orchestration/raced-spawn-failed-arm.test.ts"
  ],
  "defectFamily": { "…declared-defect-family-accounting for architecture-tech-lead-1, group.remediation-report-reset-empty-retry, check project:verify…" }
}
```

`supportPaths` names every remediation-touched path outside the frozen review scope: the plan file plus the two new regression-pinning test files (the raced-arm pins and the reset-guard RED rows landed in new files rather than inside the already-large integration suite). All remaining code/test targets above are inside the reviewed scope. If any further out-of-scope path becomes necessary, a **fresh** remediation run with an extended `supportPaths` input is required; the immutable start input cannot be amended.

## Validation commands (development runs — not P3 evidence)

- `cd engine && bun run typecheck` (expect exit 0; documented node_modules-boundary TS6133/6192/6196 diagnostics from `@fuguejs` fixtures are intentional compiler-boundary test output, not failures)
- Focused: `bunx vitest run engine/tests/orchestration/completion-check-runner.integration.test.ts engine/tests/orchestration/report-file-boundary.test.ts engine/tests/orchestration/report-reset-empty-retry.test.ts engine/tests/orchestration/raced-spawn-failed-arm.test.ts engine/tests/handlers/helpers/programs/reviewer-scope-empty-retry.test.ts engine/tests/state-manager-load-guards.test.ts engine/tests/state-manager-implementation-completion.test.ts` (from repo root, per vitest workspace)
- Linter: `bun scripts/lint-project.ts` (expect the state-file-wire enrollment to pass with zero violations; pre-existing max-function-lines advisories unchanged)
- The registered remediation's `project:verify` check must **freshly** produce `.loom/completion-reports/verify.junit.xml` with zero failures — that engine-observed run is the only `repair-checked` evidence.

## Commit / push

Commit the installed verified index on `fix/abandoned-gate-terminal-outcome` and push to origin (no `--no-push` in arguments). Push failure leaves the local commit intact and is reported with its SHA.
