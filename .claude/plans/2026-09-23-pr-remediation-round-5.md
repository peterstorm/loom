# PR Remediation Round 5 — 2026-09-23

## Branch, scope, authority

- Branch: `fix/abandoned-gate-terminal-outcome`; review-start HEAD `cd108877` (reviewer-emission hygiene committed separately); implementation candidate includes the round-4 work and its round-5 repairs.
- Review: `.claude/reviews/review-and-fix-runs/review-fix-20260923T192033Z-cd108877`; kind `all`, changed-path union, 169 frozen paths. Canonical `result.json` SHA-256: `f8a03a3088fc1c19920196e8afb7848e90eb54be0b26c51f67a1a1df624cd6a2`.
- Prior r3/r4 runs terminally blocked on reviewer evidence failures and retained as superseded; neither is remediation authority.
- Engine inspection: 2 emitted/admitted criticals, 5 advisories; after three-lens Refutation Panel, 2 surviving criticals, 0 refuted, 5 advisories. The panel's reproduction lens was uncertain (no live three-empty Git reproduction); intent refuted the *deliberate* earlier fallbacks, but blast-radius upheld the concrete scope/reviewer-selection consequences. No strict refutation majority formed.
- Advisory policy: `.claude/reviews/review-and-fix-runs/policy-20260923T201141Z-r5`, published initial revision, digest `9abb7399a0d70f77dc80aa76d1d04ece005fc4439acd73b42d47787989fe0e61`, provenance `DECLARED`. All five source inventory origins were published in order; 3 accepted, 2 deferred.

## Critical dispositions — copied once each from canonical result.json

| Finding ID | Disposition | Reason |
| --- | --- | --- |
| `silent-failure-hunter-1` | repaired → `group.git-review-authority-empty-refusal` | A status-0 `git merge-base` empty result after bounded retries is impossible for a valid merge base; the prior candidate-skip could freeze `committed: []` even with committed changes. Refuse before advancing to another candidate. Non-zero candidate failures still allow fallback. |
| `architecture-tech-lead-1` | repaired → `group.git-review-authority-empty-refusal` | `git diff --no-index --numstat` prints a row even for an empty untracked file; a confirmed-empty result must not become additions 0, which could omit the automatically selected architecture reviewer. Refuse with the path in the diagnostic. |

**Declared Repair Group** `group.git-review-authority-empty-refusal` (both original IDs above; IDs never merged or replaced):

- Root cause (`DECLARED`): two Git authority probes caught the bounded empty-success anomaly but then treated a confirmed-empty *impossible* answer as plausible review authority — no merge base and zero untracked additions.
- Invariant (`DECLARED`): only legitimately empty probes can yield an empty authority value; impossible confirmed-empty merge-base and no-index numstat results fail loudly after three attempts before freezing scope or reviewer metadata. Transient empties that recover retain real committed paths/additions. Non-zero merge-base candidates still permit normal fallback.
- Siblings (`none-declared`, `DECLARED`): both unsafe sites in this family are included in this group. The other Git scope siblings are `gitText` HEAD/status (already refuse), empty path listings and tracked numstat (legitimately empty after retry), and the report reset guard (repaired in round 4); none remains an unresolved sibling path in this family.
- Selected check: `project:verify` (fixed enrolled `npm run verify`, root-relative engine cwd, required fresh `.loom/completion-reports/verify.junit.xml`, zero executed failures).
- Historical RED (`DECLARED`): fault-injected rows in `engine/tests/handlers/helpers/programs/reviewer-scope-empty-retry.test.ts` show (1) three empty status-0 merge-base successes previously continue past the candidate and omit committed scope, and (2) three empty no-index numstat successes previously return zero metadata additions. Both fail against the frozen reviewed source and pass with the fail-closed guards; transient-then-real and legitimately empty tracked/path cases remain green. References: canonical findings `silent-failure-hunter-1` and `architecture-tech-lead-1`.

All declarations above are parent policy, not engine-observed repair proof. The registered remediation runner must freshly execute `project:verify`; report only `repair-checked` if it succeeds.

## Advisory dispositions (published, `DECLARED`)

| Finding ID | Decision | Reason and action |
| --- | --- | --- |
| `silent-failure-hunter-2` | accepted | Duplicate of the untracked numstat issue; the `architecture-tech-lead-1` critical repair makes it refuse rather than undercount. No advisory ID enters a critical repair group. |
| `pr-test-analyzer-1` | accepted | Added an actual successor CLI integration test shimming three status-0 empty `git status --porcelain=v2 --branch -z` results; it asserts refusal before Run creation and observes all three attempts. |
| `type-design-analyzer-1` | deferred | The required `GitEmptyDecision` already exposes each text-probe decision; replacing its exported interface with probe descriptors touches unrelated Git call sites and needs a separate reviewed API change. The two demonstrated unsafe decisions are repaired locally. |
| `type-design-analyzer-2` | deferred | `ActiveWaveGateRegistration` also represents durable terminal audit; splitting exported persistence/caller shapes without an evidenced live-authority misuse exceeds this targeted repair. Existing `terminalOutcome` guards remain. |
| `code-simplifier-1` | accepted | A test-local `activeGraph` fixture names common attempt setup while keeping each distinct load-guard assertion intact. |

Refuted critical audit: none (`refuted_critical_findings: []`); no refuted item is repaired.

## Changed paths and remediation input

All code/test paths here are in the frozen scope: `engine/src/handlers/helpers/programs/helpers.ts`, `engine/tests/handlers/helpers/programs/reviewer-scope-empty-retry.test.ts`, `engine/tests/handlers/helpers/programs/standalone-successor.integration.test.ts`, `engine/tests/state-manager-implementation-completion.test.ts`. Round-4 candidate support/test paths were already in this review's frozen scope. Only this new plan is out-of-scope and must be supplied at remediation registration as `supportPaths: [".claude/plans/2026-09-23-pr-remediation-round-5.md"]`.

Start a fresh schema-2 remediation using source run `review-fix-20260923T192033Z-cd108877` and both Finding IDs exactly once in the declared group, selecting only `project:verify`. Do not hand-stage or install; the engine stages an audited temporary index and installs it after fresh verification. Commit and push the installed index; no force-push.

## Validation

- Focused baseline: from `engine/`, pinned `bunx vitest run tests/handlers/helpers/programs/reviewer-scope-empty-retry.test.ts tests/handlers/helpers/programs/standalone-successor.integration.test.ts tests/state-manager-implementation-completion.test.ts` → 35/35 before round-5 changes (root `bunx vitest` mistakenly resolves v5 and is not this project's test runner).
- Historical RED: the new Git-probe tests failed at both sites before the fail-closed production change; their exact failure output is retained in `/tmp/r5-git-red.log` as development evidence, not registered authority.
- Post-fix focused tests: `reviewer-scope-empty-retry` 8/8, `standalone-successor` new fault-injection row 1/1, `state-manager-implementation-completion` 17/17. Full `cd engine && npm run verify` completed successfully: typecheck, 309 test files (9,134 passed, 1 skipped), all six smoke commands (review-panel 19/0, hooks 24/0, graph 23/23). The `@fuguejs` TS6133/TS6196 lines are intentional third-party unused-check boundary output, not owned-code failures. Separate `bun scripts/lint-project.ts` reports 67 pre-existing advisory violations in 24 files (console and max-function-lines); none of its output names a changed path in this round. This linter is not the enrolled remediation check and was not claimed green. The registered runner must independently fresh-produce its required JUnit report and verify an unchanged candidate.
