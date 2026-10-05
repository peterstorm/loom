# feat/grammar-constrained-decoding partitioned-review remediation

- **Branch:** `feat/grammar-constrained-decoding`
- **Reviewed snapshot:** `96603e4c` (474 changed paths against `main`).
- **Why partitioned:** the first whole-branch review run `raf-grammar-20261005T1` produced 45.8 MB Context Packets. That is over the 16 MiB bound that lineage authentication and remediation source reads accept, so `inspect --lineage` failed with `malformed-result-boundary`. The loaded runtime (main checkout `bf9549ca`) predates this branch's `2cda3379` start guard, so the oversized run was not refused at start. That run is abandoned with `--superseded-by raf-grammar-20261005-s1-engine-core`. Its 4 advisories are not carried over: they belong to an abandoned run and were not reproduced by the partitioned review.
- **Partition:** the 424 reviewable paths are split into four slices of 2.0-2.6 MB each (largest packet 9.7 MB). The 50 recorded evidence files (`calibration/**/windows/**`, `probes/emission-qualification/recordings/**`) are excluded from review scope because they are audit evidence, not code. This follows the PR #66 precedent.
- **Result:** all four Standalone Review runs published. 1 surviving critical (Refutation Panel 3/3 upheld), 0 refuted, 12 advisories (11 accepted, 1 dismissed, 0 deferred).

## Review runs and published policies (DECLARED, initial revisions)

| Slice | Review run | Result digest | Policy run | Disposition digest |
|---|---|---|---|---|
| s1 | `raf-grammar-20261005-s1-engine-core` | `489ff74136e4` | `raf-grammar-20261005-s1-engine-core-policy` | `ffa3b9d672c4` |
| s2 | `raf-grammar-20261005-s2-handlers-orchestration` | `f02e741ae607` | `raf-grammar-20261005-s2-handlers-orchestration-policy` | `e12814b34cce` |
| s3 | `raf-grammar-20261005-s3-engine-tests` | `cf1368574e80` | `raf-grammar-20261005-s3-engine-tests-policy` | `928ae1bb2322` |
| s4 | `raf-grammar-20261005-s4-pi-calibration-docs` | `fae1dd3afcdd` | `raf-grammar-20261005-s4-pi-calibration-docs-policy` | `7142e3a584c9` |

Remediation is registered per slice, because a remediation run authorizes only its own source's scope plus its declared support paths. Each slice is implemented, verified, installed and committed before the next slice starts.

## Surviving critical (s4)

- **code-reviewer-1** (`calibration/grammar-constrained-decoding/pilot-dispatch.ts:493`): **repaired** in Declared Repair Group `group.pilot-dispatch-process-group-timeout`.
  - Root cause (DECLARED): the extraction-only arm's timeout sent SIGKILL to the direct Pi child only, and the attempt resolved only on `close`. A descendant that inherited stdout/stderr kept the pipes open, so the attempt outlived `timeoutMs` until that descendant exited.
  - Invariant (DECLARED): an extraction-only attempt that times out resolves to `timeout` within a bounded margin of `timeoutMs`, whatever descendants the child spawned.
  - Fix: the child is spawned `detached: true` as its own process-group leader. The timeout kills the whole group (`process.kill(-pid, "SIGKILL")`) and falls back to the direct child if the group cannot be signalled.
  - Siblings (DECLARED): `probes/emission-qualification/probe.mjs` and `probes/emission-readiness/probe.mjs` are checked-unmodified. They kill their child during cleanup and then continue on a fixed sleep; nothing waits on `close`, so no descendant can extend them. Out of review scope and also checked: `pi/interactive-subagent.ts`'s `stopInteractiveChild` force timer resolves regardless of `close`.
  - Selected check: `project:verify`.
  - Historical RED (DECLARED): the new test `bounds the attempt by its timeout even when a descendant holds the child's pipes` asserts `elapsedMs < 2000`. Against the reviewed `pilot-dispatch.ts` it failed at 5018 ms under `--testTimeout=15000`. The older test passed only because verify's 15 s timeout exceeded the 5 s orphan.

## Advisory dispositions

### s1 — raf-grammar-20261005-s1-engine-core
- **pr-test-analyzer-1** (`engine/src/core/wave-status-facts.ts`) — **accepted**: direct tests for wave-status-facts, wave-reviewer-transcript and utils/git-leaves.
- **type-design-analyzer-1** (`engine/src/core/findings.ts:133`) — **accepted**: a branded `FindingId`, minted only by `parseFindingId`.
- **architecture-tech-lead-1** (`engine/src/core/implementation-completion.ts:107`) — **accepted**: one shared exact-parse module for the copied isRecord/exactRecord kernels; caller error text unchanged.
- **code-simplifier-1** (`engine/src/core/scope-classification.ts:110`) — **accepted**: `posix.extname` replaces the hand-ported extname after a table test pins edge-case equivalence.

### s2 — raf-grammar-20261005-s2-handlers-orchestration
- **pr-test-analyzer-1** (`engine/src/handlers/helpers/programs/remediation-registration.ts:131`) — **accepted**: direct parser tests.
- **type-design-analyzer-1** (`engine/src/handlers/helpers/programs/program-result.ts:6`) — **accepted**: a closed `FacadeAction` union replaces `action: unknown`.
- **architecture-tech-lead-1** (`engine/src/handlers/helpers/orchestration.ts:1684`) — **accepted**: the panel verdict-source subsystem moves out of the dispatcher into its own module, with a pure core and an I/O adapter.
- **code-simplifier-1** (`engine/src/handlers/helpers/programs/changed-paths.ts:54`) — **dismissed**: the reviewer calls the current form clear and idiomatic; moving the single freeze gives readers nothing.

### s3 — raf-grammar-20261005-s3-engine-tests
- **architecture-tech-lead-1** (`engine/tests/orchestration/remediation-candidate.test.ts:29`) — **accepted**: the private git fixtures migrate to `fixtures/git-repository.ts`.
- **code-simplifier-1** (`engine/tests/orchestration/stored-context-packets.test.ts:21`) — **accepted**: the hand-rolled realpath(mkdtemp) stragglers migrate to `canonicalTempDir`.
- **code-simplifier-2** (`engine/tests/orchestration/claude-standalone-review-acceptance.test.ts:49`) — **accepted**: same root as architecture-tech-lead-1.

### s4 — raf-grammar-20261005-s4-pi-calibration-docs
- **code-simplifier-1** (`calibration/grammar-constrained-decoding/pilot-retention.ts:43`) — **accepted**: `pilot-core` exports `ok`/`err` once and `pilot-retention` imports them.

## Refuted findings

None. The only critical was upheld by all three panel lenses (reproduction, intent, blast-radius).

## Engine defect hit during remediation

The s1 and s2 remediation starts were refused with "candidate input paths are not Git-visible tracked or non-ignored untracked paths". Each source review's frozen scope names a path this branch deleted (`engine/src/utils/artifact-baseline.ts`, `engine/src/handlers/helpers/programs/helpers.ts`), and such a path is absent from HEAD, the index and the worktree.

`0c00f83b` (with a regression test that fails without it) admits a reviewed path that is absent from the worktree. Support, sibling and input-source paths keep the strict rule. The loaded runtime is the main checkout, so `96603e4c` and `0c00f83b` were cherry-picked onto its branch `fix/artifact-baseline-directory-artifacts` as `0e74223b` and `d83084b8`.

## Outcome

| Slice | Remediation run | Assessment | Installed index | Commit |
|---|---|---|---|---|
| s4 | `raf-grammar-20261005-s4-remediation` | repair-checked | `3682c0825d27` | `1587e519` |
| s1 | `raf-grammar-20261005-s1-remediation` | not-required | `cdd3bcf596fd` | `a9ee52fd` |
| s2 | `raf-grammar-20261005-s2-remediation` | not-required | `48695858cfef` | `5388e501` |
| s3 | `raf-grammar-20261005-s3-remediation` | not-required | recorded in its commit | this plan's commit |

Follow-ups, out of scope and not changed:
- `remediation-registration.ts` parsers throw on hostile Proxy inputs (revoked or trapping proxies) instead of returning their typed refusal. Stored input comes from `JSON.parse`, so this is low impact.
- `completion-suite` `canonicalAuthorizedChecks` skips array holes via `raw.map`.
- Other private `exactRecord`/`isRecord` copies (remediation-machine, remediation-events, session-run-bindings, …) could move onto the `plain-record` kernel.
- Remaining inline git helpers in other test files (quality-programs, git.test, task-local-completion, …).

## Validation

- `npm run verify` (root, which runs `engine` typecheck, unit tests with the JUnit report, and smokes) before every registered remediation run.
- Each registered remediation run (`helper orchestration start remediation`) must observe the selected check afresh and install the verified index before its commit.
