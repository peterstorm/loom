# PR #35 remediation — round 9

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Reviewed head: `3d92b99b98506a3b5d9e623d3ac9dda7161b9463`
- Standalone Review Run: `review-20260901T040912Z-9201`
- Frozen scope: the exact 135 paths in that run's authoritative `result.json`
- Result digest: `436f45634b89a5ead9fe70d2f3a2a50d68ca284c7f5b7ba8967544ec7ffc0102`
- Findings: 4 surviving criticals, 24 advisories, 1 refuted critical
- Capture audit: silent-failure-hunter attempt 1 was terminally rejected for malformed Bash transcript shape; engine-issued attempt 2 supplied its authoritative evidence.

## Surviving criticals — mandatory fixes

### 1. Contradictory spec-check verdicts can mint passing evidence

Findings: `code-reviewer-1` and its regression counterpart `pr-test-analyzer-1` (reproduction/security upheld; intent refuted under the previous first-verdict interpretation).

Fix:

- Continue bounding finding/count/override extraction at the first terminal verdict so trailing transcript prose cannot alter the selected footer.
- Independently inspect the selected final Wave footer for every complete verdict marker; more than one concrete verdict is contradictory evidence even when one follows the selected terminal line.
- Feed duplicate verdict identity through the existing `duplicateMarkers` evidence-failure path.
- Extend example and `fast-check` coverage to contradictory and identical duplicate verdict markers.

### 2. Pi session shutdown reports success after capability cleanup failure

Finding: `silent-failure-hunter-1`, upheld by reproduction, intent, and security.

Fix:

- Continue attempting every revocation, roster release, and pointer rollback independently.
- Preserve process-local cleanup authority on any failure as today.
- After logging every cause, reject shutdown completion with an aggregate failure so the host cannot interpret a cleanup-failed session as cleanly retired or discard retry authority silently.
- Add regressions for both grant-revocation and roster-cleanup failures, proving failed shutdown rejects, retains retry state, and succeeds after the fault clears.

### 3. Phase eligibility documentation contradicts executable policy

Finding: `comment-analyzer-2`, upheld by reproduction and intent; security was uncertain.

Fix:

- Document that an exact current-Phase completion is always eligible, including `init` for compatibility callers.
- Preserve the special `init` → `brainstorm` bootstrap eligibility and all executable behavior.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-2` — append partial child-roster cleanup failures to the actionable `before_agent_start` rejection instead of logging them only.
2. `silent-failure-hunter-3` — close the descriptor if Darwin's planted-symlink probe unexpectedly succeeds before failing unsupported-kernel startup.
3. `comment-analyzer-3` — remove the absolute “never reclaimed” latency claim; the grace is a conservative fixed bound, not an enforced dispatch upper bound.
4. `comment-analyzer-4` — assign packet construction/digest integrity to the pure Context Packet module and write-once immutability to the Run Directory adapter.
5. `comment-analyzer-5` — describe `revision` as option-delimited rather than parser-proven because the exported Git helper accepts an unbranded string.
6. `comment-analyzer-6` — describe all-slot failure as a shared-infrastructure hypothesis, matching the emitted diagnostic rather than a definitive classification.
7. `comment-analyzer-7` — name `reconcileWaveBlock` at callers as the writer that clears causeless blocks; `updateTaskFindings` only rewrites Task findings.

### Deferred

1. `pr-test-analyzer-2` — RunDirHandle close-fault injection requires consumer-owned anchor capabilities; global filesystem mocks would reinforce the reviewed god port.
2. `pr-test-analyzer-3` — shadow-Git cleanup injection requires a temporary-administration capability; global `node:fs` mocking would test implementation detail.
3. `type-design-analyzer-1` — `TaskCommonMetadata` review-state ADT changes persisted TaskGraph schema and all review lifecycle transitions.
4. `type-design-analyzer-2` — `ReviewRun` legacy/engine-owned ADT changes persisted authority and every review constructor.
5. `type-design-analyzer-3` — `PiReviewAttemptAuthority` variants span reservation, recovery, and settlement and require an atomic migration.
6. `architecture-tech-lead-1` — Pi spawn compensation extraction requires a transaction module and failure-at-every-acquisition properties.
7. `architecture-tech-lead-2` — RunDirHandle decomposition requires consumer-owned capability ports and in-memory fakes.
8. `architecture-tech-lead-3` — TaskGraph compare-and-swap requires a persistence protocol migration.
9. `architecture-tech-lead-4` — Pi path configuration requires an extension-instance composition root.
10. `architecture-tech-lead-5` — trusted review witnesses require extension-instance registry ownership and concurrent-instance tests.
11. `architecture-tech-lead-6` — TaskGraph codec extraction changes core/shell type ownership across engine and Pi.
12. `architecture-tech-lead-7` — Git execution/evidence separation changes a broad utility interface.
13. `architecture-tech-lead-8` — Context Packet compatibility deletion requires atomic consumer import migration and curated-surface updates.
14. `code-simplifier-1` — splitting the Pi tool-call transaction should occur with spawn-transaction and composition-root migrations so ordering/compensation remains local.
15. `code-simplifier-2` — splitting the Wave façade should occur with the deferred Wave authority/lifecycle migration.
16. `code-simplifier-3` — splitting update-task-status should occur with the TaskGraph persistence and settlement authority migration.
17. `code-simplifier-4` — a broad eleven-scenario fixture would hide scenario-specific authority; retain explicit setup until a domain fixture with invariant-enforcing constructors exists.

### Dismissed

None.

## Refuted-finding audit

`comment-analyzer-1` was refuted by intent and security. The same staleness documentation explicitly states that missing or unparseable `reserved_at` values remain immediately eligible for legacy/corrupt stranded-reservation recovery. The implementation matches that exception, so it is recorded and not changed.

Two surviving spec-check findings received one intent-lens refutation each: the old contract treated the first verdict as terminal. Reproduction and security established that contradictory complete verdict lines can still mint passing authority, so the strict-majority outcome requires the fail-closed fix.

## Planned files outside frozen scope

Only this plan is outside the frozen review scope and must be registered as a remediation support path. All planned implementation and regression files are already in the authoritative scope.

## Validation receipt

- Focused spec-check, Pi shutdown/grant, Darwin anchored-filesystem, and phase-eligibility suites: **4 files, 257 passed, 1 platform skip, 0 failures**.
- Post-distill exact cleanup-debt regressions: **3 passed**; TypeScript and unused-code gates remained clean.
- `bun run --cwd engine typecheck`: passed, including unused locals and parameters.
- Final authoritative `env -u PI_CODING_AGENT bun run --cwd engine test:unit`: **231 files, 6007 passed, 1 platform skip, 0 failures**.
- The first post-distill full run hit the pre-existing shared-directory isolation failure in `upgrade-spec-trace.test.ts`; its isolated suite passed 16/16, and the authoritative full command was rerun to green.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check`: clean.

`PI_CODING_AGENT` was unset only inside validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green implementation baseline: **231 files, 6007 passed, 1 platform skip**.

Move applied:

1. Normalized optional child cleanup authorities once before action construction, removing repeated null/undefined predicates while preserving the `active | roster-cleanup-pending | pointer-cleanup-pending` ADT and exact cleanup order. The three direct cleanup-debt regressions and type/unused gates remained green.

Opportunities deliberately skipped:

- RunDirHandle and shadow-Git cleanup fault injection remain coupled to deferred capability ports; no global filesystem mocks were introduced.
- Task review state, Review Run, and Pi attempt authority ADTs remain atomic persisted-schema migrations.
- Pi spawn transaction, RunDirHandle capabilities, TaskGraph compare-and-swap/codec, Pi composition root, Git FC/IS split, and Context Packet compatibility deletion remain interface-bound deepenings.
- Large Pi, Wave, and update-task-status driver splits were not performed without their paired authority migrations; splitting now would distribute ordering and compensation knowledge.
- The eleven-scenario orchestration fixture was retained because a generic structural builder would hide scenario-specific authority until invariant-enforcing domain fixtures exist.
