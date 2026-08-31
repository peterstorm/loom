# PR remediation — 2026-08-31

## Authority

- Branch: `main` (three commits ahead of `origin/main` at review freeze)
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260831T104041Z-9397`
- Frozen scope (20 paths):
  - `.claude/plans/2026-08-29-pr-remediation-round36.md`
  - `.claude/plans/2026-08-29-round36-progress.md`
  - `2n`
  - `engine/src/core/harness-capture.ts`
  - `engine/src/core/legacy-archive.ts`
  - `engine/src/core/review-packet.ts`
  - `engine/src/handlers/subagent-stop/advance-phase.ts`
  - `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`
  - `engine/src/orchestration/effect-runner.ts`
  - `engine/src/orchestration/harness-capture-runtime.ts`
  - `engine/src/orchestration/run-directory-handle.ts`
  - `engine/src/utils/agent-transcript-path.ts`
  - `engine/tests/core/legacy-panel-capture-refusal.test.ts`
  - `engine/tests/handlers/subagent-stop/advance-phase.test.ts`
  - `engine/tests/orchestration/capture-slot-authority.test.ts`
  - `engine/tests/orchestration/orchestration-acceptance.test.ts`
  - `engine/tests/pi/subagent-result.test.ts`
  - `helper.py`
  - `pi/extension.ts`
  - `pi/subagent-result.ts`

## Mandatory surviving criticals and fixes

1. `code-reviewer-1` and duplicate `architecture-tech-lead-1`: Claude `transcript-locator`/`transcript-json` refusals bypass durable terminalization.
   - Move harness observation behind request/correlator resolution in the shared capture runtime. Represent adapter observation refusal as a typed terminal refusal and terminalize it exactly once against the resolved reservation. Add missing-transcript/malformed-transcript marker and journal assertions.
2. `code-reviewer-2`: the prior receipt falsely claims a clean typecheck.
   - Remove every reported unused import, rerun the exact compiler gate, and replace the prior receipt with truthful fresh evidence.
3. `silent-failure-hunter-1`: `ensureFixedLayout` can throw outside `openRunDirectory`'s typed boundary.
   - Catch layout failures and return a `runDirectory` `DomainResult` failure. Add a filesystem-fault regression.
4. `silent-failure-hunter-2`: a staged-file unlink failure after successful hard-link publication is reported as capture failure.
   - Split publication from cleanup. Once the final hard link lands, return captured evidence; staged cleanup failure is diagnostic-only and never reverses the committed outcome.
5. `silent-failure-hunter-3` and advisory duplicate `type-design-analyzer-2`: rejection-marker replay compares only request id.
   - Parse a typed exact marker and accept replay only when request id and diagnostic are structurally identical; conflicting replay fails closed. Add identical/conflicting replay tests.
6. `pr-test-analyzer-1`: no rejection-persistence fault test.
   - Fault the `rejectCapture` port and assert the original refusal plus persistence cause survive in a typed retriable outcome.
7. `pr-test-analyzer-2`: no audit-append fault test.
   - Fault `appendEvent` and assert the helper never throws and reports the tombstoned-but-unsynchronized state.
8. `pr-test-analyzer-3`: no integrated repeated-refusal exactly-once proof.
   - Repeat one refusal through the shared protocol and assert one marker and one `request-capture-rejected` journal record.
9. `type-design-analyzer-1`: transient run-directory failures are collapsed with terminal refusals and burn attempts.
   - Replace the collapsed rejection arm with explicit terminal-rejection and retriable-failure states. Permit `terminalizeCaptureRejection` to accept only a terminal-refusal value. Classify run-directory reads/writes as retriable and semantic payload/identity/context refusals as terminal. Ensure callers never tombstone a retriable outcome.
10. `comment-analyzer-2`: `readCaptureRejection` promises whole-authority byte equality but intentionally verifies marker-address fields.
    - Rewrite the comment to state the actual request-id/slot-id/attempt invariant and retry-recovery rationale.

## Advisory dispositions

### Accepted

- `code-reviewer-3`: recheck phase-result eligibility inside the locked `StateManager.update`; express the guarded transition as a pure state function and test stale completion behavior.
- `code-reviewer-4`: parse request and slot ids in `isCaptureRejectionAuditRecord`; malformed journal identities remain corruption rather than being skipped.
- `code-reviewer-5`, `code-simplifier-1`: delete accidental shell-error artifact `2n`.
- `code-reviewer-6`: delete orphan placeholder `helper.py`.
- `pr-test-analyzer-4`: pin no-correlator ordering before adapter observation; no reservation must not become a locator refusal.
- `pr-test-analyzer-5`: cover the exported Pi adapter path after it delegates typed observation to the shared terminalizer.
- `pr-test-analyzer-6`: test `PortThrew.from` preservation of `Error.name` and `Error.cause`.
- `pr-test-analyzer-7`: test canonical program-registration replay across key order and non-JSON refusal.
- `comment-analyzer-3`: correct the adapter/shared rejection-reason comment.
- `comment-analyzer-4`: describe `legacy-archive` as compatibility-only instead of claiming canonical code never calls it.
- `code-simplifier-2`: reuse one internal read-side reservation-address verifier for transcript and rejection reads while preserving their distinct unreserved outcomes.
- `code-simplifier-3`: replace hand-rolled digest-shaped test strings and dynamic crypto imports with one standard helper.

### Deferred

- `architecture-tech-lead-2`: splitting the complete fixed-layout `RunDirHandle` into consumer capability views is sound but is a broad interface migration, not necessary to fix the reviewed capture defects. ADR-0004 deliberately established this fixed-operation handle; a separate deepen session must inventory consumers and introduce real production/test capability adapters without widening this remediation.
- `architecture-tech-lead-3`: separating phase artifact discovery from pure transition policy is sound, but changing the full transition interface is broader than the TOCTOU fix. This remediation extracts only the pure guarded state application and leaves filesystem snapshot design to a focused deepen session.

No advisory is dismissed.

## Refuted-finding audit — never fix

- `comment-analyzer-1`: refuted by intent and blast-radius lenses. “Original file bytes” names the raw, pre-encoding postimage bytes; the field name and adjacent head-deletion sentence already establish revision semantics. No edit will be made for this finding.

## Support paths outside frozen review scope

The registered remediation must authorize these paths before any temporary-index installation:

- `.claude/plans/2026-08-31-pr-remediation.md`
- `engine/tests/orchestration/publication-faults.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-completion-suite.integration.test.ts`
- `engine/tests/handlers/helpers/quality-programs.test.ts`
- `engine/tests/handlers/helpers/repair-task-graph.test.ts`
- `engine/tests/handlers/helpers/wave-completion-suite.test.ts`
- `engine/tests/handlers/implementation-attempt-sidecar.test.ts`
- `engine/tests/handlers/populate-task-graph.test.ts`
- `engine/tests/orchestration/no-follow-fs.test.ts`
- `engine/tests/utils/workspace-digest.test.ts`

## Validation

```bash
bun run --cwd engine typecheck
(cd engine && bunx vitest run \
  tests/orchestration/orchestration-acceptance.test.ts \
  tests/orchestration/capture-slot-authority.test.ts \
  tests/orchestration/publication-faults.test.ts \
  tests/handlers/subagent-stop/advance-phase.test.ts \
  tests/pi-extension-review-events.test.ts)
bun run --cwd engine test:unit
bun run --cwd engine test:smoke
git diff --check
```

## Validation receipt

Validated against the remediated working tree:

- `bun run --cwd engine typecheck` — clean, including unused locals and parameters.
- Focused capture/phase/publication/Pi suites — 317 tests passed before the full run.
- `env -u PI_CODING_AGENT bun run --cwd engine test:unit` — 226 files, 5651 tests, 0 failures.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — every smoke suite passed.
- `git diff --check` — clean.

`PI_CODING_AGENT` was unset only for validation subprocesses so smoke fixtures did not inherit this live Pi session's runtime handshake; no mutation authority was bypassed.

## Distill apply-mode receipt

Green baseline: full unit and smoke suites above.

Moves applied one at a time:

1. Reused one read-side reservation-address verifier for transcript and rejection reads.
2. Replaced hand-rolled digest-shaped test data and dynamic crypto imports with one SHA-256 helper.
3. Deleted `helper.py`, `2n`, and all compiler-proven dead imports.
4. Corrected the stale write-verifier comment after the read helper split; typecheck and 77 covering capture tests remained green.

Skipped opportunities:

- `RunDirHandle` capability-interface splitting — interface migration, deferred to `deepen` and constrained by ADR-0004.
- Pure phase artifact snapshot extraction — broader seam redesign, deferred to `deepen`.
- No other behavior-preserving simplification survived the reader test without weakening explicit terminal/retriable states or fault diagnostics.
