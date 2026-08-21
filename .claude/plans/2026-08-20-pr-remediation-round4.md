# PR Remediation — Round 4

## Authority

- Branch: `feat/architecture-panel-mode-plan`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260820T202631Z-01a020d9`
- Canonical result: `result.json`, SHA-256 `485f2cdbdeeaac9ffef6e583d766349c9dab20144361ba71394e5c5d8a86c458`
- Exact frozen review scope: the 488 paths in canonical `result.json.scope`; compact JSON SHA-256 `78926129b1795faffe92c2efc37bc5655b0067ffdee7510a0b343c84dba17fa6`
- Remediation-only support paths outside that frozen scope:
  - `.claude/plans/2026-08-20-pr-remediation-round4.md`
  - `engine/src/core/test-evidence.ts`

## Surviving critical findings — mandatory

### `code-reviewer-1` — acquisition does not revisit stale generation claims

`engine/src/utils/lock.ts:321` checks stale-lock recovery only on the first failed birth. If a live claimant exits after that check, the waiter retries birth until timeout without reaping the now-orphaned claim.

Fix:
- attempt stale generation recovery after every failed birth in both async and synchronous acquisition;
- retain generation/token rechecks so a waiter cannot retire a replacement generation;
- add a subprocess regression where acquisition begins while the claimant is alive and succeeds after the claimant exits.

### `silent-failure-hunter-1` — recovery-guard cleanup failures are swallowed

`engine/src/orchestration/no-follow-fs.ts:334` catches every recovery-guard read/unlink failure. Recovery can therefore return success while leaving the guard behind and hiding the filesystem failure.

Fix:
- treat `ENOENT` and a byte-proven foreign guard as benign non-ownership outcomes;
- throw contextual errors for all other recovery-guard read/unlink failures;
- add a regression that makes an owned guard cleanup fail and proves recovery cannot report success silently.

### `pr-test-analyzer-1` — relaxed-pipe strict-summary guard lacks a supported-pipe regression

`pi/transcript-adapter.ts:371` correctly requires an explicit zero-failure marker before a relaxed `tail`/`tee` pipeline can mint green evidence, but no test reaches that guard using a supported relaxed pipe with pass-looking output and no zero-failure marker.

Fix:
- add a `cd engine && bun test | tail -n 1` regression with pass-looking output lacking `0 fail`;
- assert `piStructuredTestResult` returns `null` and diagnostics report `strict-summary-refused`.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-2` — log unreadable `.active` roster entries before `anyActiveSubagent` returns fail-closed `true`. The behavior remains fail-closed; the hidden I/O cause becomes actionable.
2. `pr-test-analyzer-2` — add a regression proving an unexpired generation claim owned by a live process remains contended. This directly pins mutual exclusion while the critical lock fix increases stale checks.
3. `comment-analyzer-1` — replace stale “two smoke scripts”/“Both scripts” prose with “smoke suite”/five-check wording matching `engine/package.json`.
4. `architecture-tech-lead-2` — move `TestEvidence`, runner tallies, and `extractTestEvidence` out of the filesystem-heavy SubagentStop handler into pure `engine/src/core/test-evidence.ts`; import that seam from Pi, the handler, and focused tests.
5. `code-simplifier-1` — share one private agent-collision helper between `reviewPanelOverlap` and `panelExecuteOverlap`, preserving both exported interfaces.
6. `code-simplifier-2` — derive each task’s substantive critical findings once in `checkCriticalFindings`, eliminating repeated filters and the non-null assertion.
7. `code-simplifier-3` — share one private `BatchPublicationIdentity` constructor while preserving both exported entry points.

### Deferred

1. `type-design-analyzer-1` — coupling each `StandaloneReviewMachineState` variant to only its admissible events requires a caller-visible reducer/interface redesign across the persisted lifecycle. Runtime rejection already fails closed; no incorrect transition was demonstrated. Defer to a dedicated lifecycle-type design change with migration and compile-time negative tests.
2. `type-design-analyzer-2` — deep immutability for arbitrary Fugue `unknown` event payloads requires first defining the accepted serializable value model and whether cloning/freezing is part of the `ProgramJournal` contract. Shallow-freezing the outer record alone would not establish the claimed invariant, while changing arbitrary event identity can affect adapters. Defer to a journal-value contract change with round-trip and mutation tests.
3. `architecture-tech-lead-1` — separating phase-transition evidence gathering from `resolveTransition` spans both Pi and Claude shells, artifact discovery, and the transition interface. The finding is sound but materially broader than the adjudicated correctness fixes; defer to a dedicated FC/IS refactor with parity tests for both harnesses.

### Dismissed

None.

## Refuted-finding audit

No critical findings were refuted. All three critical findings were upheld by the `reproduction`, `intent`, and `blast-radius` panel lenses.

## Operator-request audit

Generated review evidence is already ignored by `.gitignore` via `.claude/reviews/review-and-fix-runs/`. `git check-ignore` proves nested `result.json` files match that rule. No `.gitignore` edit is required; plans remain intentionally trackable.

## Validation

Baseline before remediation:

```text
11 test files passed; 374 tests passed
```

Run after implementation:

```bash
cd engine
env -u PI_CODING_AGENT bunx vitest run \
  tests/utils/lock.test.ts \
  tests/orchestration/no-follow-fs.test.ts \
  tests/pi-test-evidence.test.ts \
  tests/handlers/update-task-status.test.ts \
  tests/handlers/subagent-stop/update-task-status.property.test.ts \
  tests/machine/ledger.test.ts \
  tests/panel-config.test.ts \
  tests/review-panel-config.test.ts \
  tests/handlers/complete-wave-gate.test.ts \
  tests/core/orchestration-contract-public-surface.test.ts \
  tests/runbook-contract.test.ts \
  --testTimeout=15000
npm run typecheck
env -u LOOM_PI_EXTENSION_RUNTIME_REVISION -u LOOM_PI_EXTENSION_RUNTIME_ROOT npm test
```

After the green implementation baseline, run the `distill` apply-mode pass one move at a time and re-run each affected focused test before final full validation.
