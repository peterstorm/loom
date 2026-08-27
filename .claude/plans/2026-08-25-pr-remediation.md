# Slice 3 Completion Oracle — PR Remediation

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `92c99338dbfaa06db1a9b5b62b33ec4796992b1b`
- Review run: `review-20260825T004852Z-deterministic-task-completion-oracle`
- Result digest: `765a1fdd7dec14d174e68e48d707289610bff2bb5cd3d0800d2a3c807dc4cf42`
- Frozen scope: the exact 75 paths in the authoritative `result.json`
- Refutation panel: reproduction, intent, blast-radius; threshold 2
- Surviving criticals: 3
- Refuted criticals: 0

This plan is the only anticipated remediation support path outside frozen scope.

## Mandatory critical remediation

1. **Malformed Claude JSONL can become positive completion** (`code-reviewer-1`, upheld 2–1).
   - Add a strict complete-transcript integrity parser that rejects any malformed/truncated nonblank JSONL record before evidence extraction.
   - For an exact modern attempt, integrity failure settles through `settleUnavailableImplementation`, creates a non-consuming infrastructure receipt, and releases only matching authority.
   - Add a regression with valid prompt/tool evidence followed by malformed/truncated JSONL and prove it cannot implement.
2. **SubagentStart shim fails open on unobservable TaskGraph** (`silent-failure-hunter-1`, upheld 3–0).
   - Remove the shell `-f` authority decision. Invoke the engine whenever runtime exists; the engine's ENOENT-only `pathExistsFailClosed` probe decides absent versus unobservable.
   - Add an early no-graph passthrough inside the handler so ad-hoc agents retain behavior without roster/sidecar writes.
   - Runtime or graph-observation uncertainty blocks.
3. **Schema-root comment overstates dependency direction** (`comment-analyzer-1`, upheld 3–0).
   - Rewrite it to describe only the Finding-shape cycle it avoids; do not claim `types.ts` has no runtime dependencies.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-2`: preserve sidecar publication's primary error and aggregate a temp-cleanup failure instead of masking it.
2. `type-design-analyzer-1`: make settlement receipt types transition-refined so `ImplementationCompletionTransition.kind` and `receipt.transition` cannot disagree.
3. `type-design-analyzer-2`: remove the unproducible `authority-blocked` arm from `WaveGateNextAction` unless a real producer is discovered.
4. `comment-analyzer-2`: clarify infrastructure settlement consumes/releases the execution reservation but not semantic retry budget.
5. `comment-analyzer-3`: say Pi derives transcript text from in-memory result messages outside the lock.
6. `architecture-tech-lead-1`: move newly shared Slice 3 implementation cleanup/evidence rules out of the Claude handler into neutral shared core/shell modules. The older pure phase `resolveTransition` import is deferred to the phase-lifecycle module migration rather than widening this remediation.
7. `architecture-tech-lead-3`: return a transport-neutral Task execution decision ADT from core and map it to `HookResult` in the handler.
8. `code-simplifier-1`: consolidate repeated branded SHA-256 parsing behind one private helper.
9. `code-simplifier-2`: build the common retry/escalation pending Task projection once; vary only revalidation state.
10. `code-simplifier-3`: consolidate repeated required Wave completion-suite readiness records behind one private helper.

### Deferred

1. `silent-failure-hunter-3`: advisory-status projection `null` redesign remains assigned to the planned atomic Wave Gate lifecycle/status interface slice. A local patch would add a second status failure vocabulary.
2. `architecture-tech-lead-2`: Wave Gate WeakSet proof authority requires the planned atomic Wave Gate authority redesign; replacing hidden capabilities piecemeal risks weakening protected completion.

### Dismissed

None.

## Constraints

- Do not weaken exact attempt, Task-suite, StateManager, sidecar, or result schemas.
- No Task/project subprocess commands.
- Preserve Pi finalization ordering and exact reserved-slot settlement.
- Legacy/inferred completion remains cleanup/quarantine-only.
- Slice 4 alone dispatches semantic attempt 2 or escalation.
- Remediation changes stay within frozen review scope plus this plan.
- Apply `distill` after a green focused baseline, one move at a time.

## Validation

Executed after remediation (no staging or commit):

1. Strict transcript parser examples/property totality and malformed-tail production regression: `implementation-completion.property` + `implementation-attempt-sidecar` — **46 passed**.
2. SubagentStart absent/EACCES/ELOOP/ENOTDIR/runtime-unavailable and handler regression coverage: shim/roster/sidecar focused run — **50 passed** (EACCES is conditionally skipped only when uid 0).
3. Final focused Oracle/application/registration/sidecar/Claude/Pi/StateManager/reconciliation/shim run — **389 passed** across 17 files.
4. `npm run typecheck` — strict typecheck and scoped unused checks passed.
5. Full-tier lint over all 12 changed production TypeScript files — **0 violations**.
6. Bounded full Vitest suite — **222 files passed; 5,444 tests passed; 1 intentional platform-conditional test skipped**.
7. Every smoke gate (`npm run test:smoke`) passed: panel **22/22**, review panel **19/19**, standalone review PASS, orchestration façade PASS (6 scenarios), Pi resources PASS, TaskGraph validation **23/23**.
8. `git diff --check` passed after the final plan and fail-closed SubagentStart edits.
9. Deferred Wave advisory-projection and WeakSet authority redesigns were not changed. Registered remediation, exact verified-index installation, commit, push, fresh rereview, and PR follow this validated candidate.
