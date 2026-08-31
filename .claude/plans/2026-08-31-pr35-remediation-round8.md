# PR #35 remediation — round 8

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Reviewed head: `2f3209a99bad639f8a2174bbaf956aea4fb3d76b`
- Standalone Review Run: `review-20260831T212546Z-26714`
- Frozen scope: the exact 133 paths in that run's authoritative `result.json`
- Result digest: `203f622cd99008e9fb89662749bf2ca9a2664798cb89bdbfc6231713dac9a017`
- Findings: 2 surviving criticals, 20 advisories, 0 refuted criticals

## Surviving criticals — mandatory fixes

### 1. Corrupt binding authority is misclassified as benign contention

Finding: `code-reviewer-1`, upheld by reproduction, intent, and blast-radius.

Fix:

- Preserve `null` exclusively for genuine absence/contention at the existing `soleActiveBinding` seam.
- Surface malformed binding rows as a typed evaluation failure rather than collapsing corruption into `null`.
- Let the existing PreToolUse catch boundary convert that failure into a blocking gate result.
- Add an end-to-end gate regression with one valid binding, one malformed row, and the matching sole active roster entry.
- Update the direct ledger regression to distinguish corruption from contention.

### 2. Duplicate spec-check scalar markers can mint contradictory passing evidence

Finding: `pr-test-analyzer-1`, upheld by reproduction, intent, and blast-radius.

Fix:

- Parse each authoritative scalar marker only when exactly one complete marker line exists inside the selected final footer.
- Treat duplicate count, verdict, wave, and override markers as unavailable/corrupt evidence rather than selecting the first.
- Preserve final-footer bounding and stale-footer supersession.
- Add example and `fast-check` regressions proving duplicate scalar markers cannot reconcile to captured evidence.

## Advisory dispositions

### Accepted

1. `comment-analyzer-1` — add the durable `transcripts/<slot>/attempt-<n>.rejected` terminal marker to the Run Directory layout documentation.
2. `comment-analyzer-2` — state that Pi result reconciliation is positional and reordered results become missing/mismatched rather than being re-associated by identity.
3. `comment-analyzer-3` — remove the `isGitRepo` comment that only restates the function name.
4. `code-simplifier-3` — consolidate the shared advisory/clean complete-roster transitions behind one private pure mapper while preserving state-specific rejection diagnostics.

### Deferred

1. `pr-test-analyzer-2` — deterministic RunDirHandle close-only and operation-plus-close injection still requires consumer-owned capability projections; global filesystem mocking would reinforce the reviewed god port.
2. `pr-test-analyzer-3` — deterministic shadow-Git cleanup-only and operation-plus-cleanup injection requires a temporary-administration capability; global `node:fs` mocking would test implementation detail.
3. `type-design-analyzer-1` — the `ReviewRun` legacy/engine-owned ADT changes persisted TaskGraph schema and every review lifecycle constructor and requires an atomic migration.
4. `type-design-analyzer-2` — the `PiReviewAttemptAuthority` variant migration spans reservation, durable recovery, and settlement and belongs in the dedicated Pi authority migration.
5. `type-design-analyzer-3` — a discriminated `ReservedSlot` changes Pi spawn, reconciliation, and cleanup across all authority categories and requires an atomic migration.
6. `type-design-analyzer-4` — ordered `WaveGateLifecycleEvidence` variants change the projection interface and persisted event interpretation and require a dedicated lifecycle migration.
7. `type-design-analyzer-5` — `WaveSpecCheckDocumentAuthority` ADT migration changes persisted TaskGraph and Context Packet schemas and requires compatibility parsing.
8. `architecture-tech-lead-1` — Pi spawn compensation extraction requires a dedicated transaction module and failure-at-every-acquisition property suite.
9. `architecture-tech-lead-2` — decomposing `RunDirHandle` requires consumer-owned capability ports and real in-memory fakes across multiple callers.
10. `architecture-tech-lead-3` — replacing locked arbitrary observations with TaskGraph compare-and-swap requires a state persistence protocol migration.
11. `architecture-tech-lead-4` — Pi configuration and trusted-review witnesses require an extension-instance composition-root migration and concurrent isolation tests.
12. `architecture-tech-lead-5` — separating the TaskGraph codec from StateManager persistence changes type ownership across engine and Pi and requires a dedicated module migration.
13. `architecture-tech-lead-6` — separating Git execution from pure diff-evidence interpretation changes a broad utility interface and belongs in a focused FC/IS migration.
14. `architecture-tech-lead-7` — deleting the Context Packet compatibility re-export requires an atomic consumer import migration and curated-surface update.
15. `code-simplifier-1` — decomposing the 622-line Wave façade driver changes durable phase seams and should be paired with the deferred Wave authority ADTs rather than performed as incidental cleanup.
16. `code-simplifier-2` — decomposing the Pi extension initializer changes dependency ownership and should be performed with the deferred composition-root and spawn-transaction migrations.

### Dismissed

None.

## Refuted-finding audit

No critical Finding met the strict-majority refutation threshold. Both surviving Findings were upheld by all three refutation lenses; no refuted code will be changed.

## Planned files outside frozen scope

Only this plan is outside the frozen review scope and must be registered as a remediation support path. All implementation and regression files are already in the authoritative scope.

## Validation receipt

- Focused spec-check parsing/reconciliation, binding ledger, phase-tool gate, Wave Gate lifecycle, Pi reserved-result, and Git suites: **6 files, 302 passed, 0 failures**.
- Post-distill Wave Gate lifecycle suite: **118 passed, 0 failures**; TypeScript and unused-code gates remained clean.
- `bun run --cwd engine typecheck`: passed, including unused locals and parameters.
- Final `env -u PI_CODING_AGENT bun run --cwd engine test:unit`: **231 files, 6004 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check`: clean.

`PI_CODING_AGENT` was unset only inside validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green implementation baseline: **231 files, 6004 passed, 1 platform skip**.

Move applied:

1. Compressed `completeRosterTransition` from the entire `WaveGateState` union to exactly its two legal destination variants (`awaiting-advisory-decision | ready-to-complete`). The Wave Gate lifecycle suite remained green with 118/118 tests, and type/unused gates passed.

Opportunities deliberately skipped:

- RunDirHandle and shadow-Git cleanup fault injection remain coupled to deferred capability-port migrations; no global filesystem mocks were introduced.
- Persisted Review Run, Pi authority, Reserved Slot, Wave lifecycle evidence, and Wave document ADTs remain atomic schema migrations rather than local cleanup.
- The Wave façade and Pi extension drivers are large, but splitting their durable phase/resource seams without the paired authority and composition-root migrations would reduce locality rather than improve it.
- TaskGraph codec/persistence, Git FC/IS separation, Context Packet compatibility deletion, and TaskGraph compare-and-swap remain interface-bound deepenings.
- No other local move reduced concepts or representable states without changing public error, ordering, or durable-evidence semantics.
