# PR Remediation — macOS Anchored Filesystem Wave (round 6)

## Authority

- Branch: `main` (remediation applies on top of the uncommitted darwin wave; commit installs the engine-verified index)
- Reviewed HEAD: `3815f65bfab4351f49f0e21e7b7415cdab1fda86`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/run.review-and-fix-main-1` (result digest `c2957e01f72f24fb9d47465a3924acb4e113484f3d24718e81d13472d5ff2121`)
- Scope: the frozen 43-file changed-path union (unstaged working tree vs HEAD)
- Rules loaded: `rules/architecture.md`, `rules/typescript-patterns.md`; skills: deepen, distill

## Surviving critical findings (mandatory)

### C1 — `withAnchoredDirectoryLock` doc asserts a darwin-false guarantee (`comment-analyzer-1`, upheld 3/3 panel criteria)

- `engine/src/orchestration/no-follow-fs.ts:613-616` claims "The retained descriptor is the anchor, so no
  path swap after acquisition can redirect either the lock or the callback's I/O." On darwin the anchor
  is the proven-real path (`anchorFor` → `real-path`; `anchoredChildPath` → `join(path, child)`), which a
  post-acquisition component swap CAN redirect — exactly the module-header's documented darwin limit.
- Fix: rewrite the doc platform-split, mirroring the module header:
  "On Linux the retained descriptor is the anchor, so no path swap after acquisition can redirect either
  the lock or the callback's I/O. On darwin the anchor is the proven-real path; a component swapped after
  acquisition remains the documented accepted risk (see module header)."

### C2 — `blockedGateCauseError` doc misattributes the block-clearing writer and quotes a nonexistent comment (`comment-analyzer-2`, upheld 3/3 panel criteria)

- `engine/src/state-manager.ts:313-317` attributes clearing to `update-task-status` and quotes "the flag
  now tracks its causes, exactly like the load boundary's cross-field proof" — the quote exists nowhere in
  the source tree (only in a `.claude/plans/` document); clearing actually lives in
  `core/wave-gate-model.ts` `reconcileWaveBlock`, driven by `store-review-findings` /
  `store-spec-check-findings` via `updateTaskFindings`.
- Fix: attribute the clearing to the real writers and drop the phantom quote (quote the live comment at
  `store-review-findings.ts:203` instead if a quote is wanted).

## Advisory dispositions (autonomous parent triage)

| # | id | disposition | reason |
|---|----|-------------|--------|
| 1 | code-reviewer-1 | ACCEPTED | Sound: `O_NOFOLLOW_ANY` is macOS 13+; silently losing the guarantee on older kernels defeats the module's purpose. Add a one-time fail-closed runtime probe (planted symlink chain must yield ELOOP) in `assertAnchoredFilesystemPlatformSupported`, and document the macOS 13 floor in README.md + docs/operations.md. |
| 2 | silent-failure-hunter-1 | ACCEPTED | Claim verified: unguarded `closeSync`/`closeAnchoredDirectory` in `finally` masks primary errors and skips later closes (fd leak). Route every cleanup close through the module's own `closeFileDescriptor` aggregation pattern (new `closeAnchorGuarded` for directory anchors) in `writeAnchoredRunFile`, `readAnchoredRunFile`, `removeRunFileNoFollow`, `publishStagedRunFile`, `openDirectoryNoFollow`'s component walk, and `publishImplementationAttemptSidecar`'s finally. |
| 3 | silent-failure-hunter-2 | ACCEPTED | Narrow the three bare `catch {}` fixture-cleanup sites to the codebase's documented ENOENT-only tolerance. |
| 4 | pr-test-analyzer-1 | ACCEPTED | Add the missing regression test for the `run subdirectory escapes run directory` guard (drop-a-protection-must-fail-a-test convention). |
| 5 | pr-test-analyzer-2 | ACCEPTED | Add test: sidecar leaf whose contents bind a foreign (session, agent) identity is refused with `malformed-sidecar` "does not match its filename key". |
| 6 | pr-test-analyzer-3 | ACCEPTED | Add direct adversarial tests for `parseClaudeImplementationAttemptSidecar` rejection branches (extra key, wrong `kind`/`schemaVersion`, non-canonical path, bad authority). |
| 7 | pr-test-analyzer-4 | ACCEPTED | Add test: parsed sidecar whose stored graph path fails realpath at snapshot → `unreadable-sidecar` "TaskGraph path is unavailable". |
| 8 | pr-test-analyzer-5 | ACCEPTED | Add test: snapshot with garbage session/agent identity returns `invalid-sidecar-identity` instead of throwing. |
| 9 | pr-test-analyzer-6 | ACCEPTED | Add test for the `publishStagedRunFile` same-run-directory guard. |
| 10 | pr-test-analyzer-7 | ACCEPTED | Add test: planted live recovery guard forces 50 exhausted attempts → "Could not acquire anchored lock after 50 attempts". |
| 11 | type-design-analyzer-1 | ACCEPTED | Brand the anchor fd (`AnchoredDirectoryFd`) so only `anchorFor` can mint an `AnchoredDirectory`; verified zero external fabricators of the union. |
| 12 | type-design-analyzer-2 | ACCEPTED | `SidecarPublicationResult.cleanupFailure` becomes a structured `{ message, code } | null` so errno survives; the one consumer (mark-subagent-active.ts stderr line) is a registered support path. |
| 13 | type-design-analyzer-3 | DEFERRED | The complete fix requires restructuring the shared `ProofParseResult` error channel in `core/proof-obligations.ts` — a pre-existing module outside the frozen review scope. Current behavior still fails loudly; only the operator-facing diagnostic wording is at risk. Revisit when proof-obligations is next in a reviewed scope. |
| 14 | comment-analyzer-3 | ACCEPTED | Platform-neutral wording for the state-manager header and `atomicWrite` doc (anchored rename, not "retained parent descriptor"). |
| 15 | comment-analyzer-4 | ACCEPTED | `removeRunFileNoFollow` doc: leaf named through the anchored parent (descriptor on Linux, proven-real path on darwin). |
| 16 | comment-analyzer-5 | ACCEPTED | Test header: "anchor-then-no-follow dance (`O_NOFOLLOW` on Linux, `O_NOFOLLOW_ANY` on darwin)". |
| 17 | comment-analyzer-6 | ACCEPTED | Replace the self-contradictory SUBAGENT_DIR narrative with one sentence stating what the test pins (`parseTranscript` treats its argument as content). |
| 18 | architecture-tech-lead-1 | ACCEPTED | Verified dead residue: delete `PostCommitStateProtectionError`, `StateFilePermissionPort`, the `setPermissions` constructor seam, the `AnchoredFileModePort` param, the three `instanceof` branches + `postCommitProtectionFailureMessage`, and the fabricated-instance test; rework the `complete-wave-gate.test.ts` vi.fn seam assertion (support path). |
| 19 | code-simplifier-1 | ACCEPTED | Fold `ensureResolvedBaseDirectory` into mkdir + `resolveBaseDirectory` (byte-identical errors). |
| 20 | code-simplifier-2 | ACCEPTED | `removeImplementationAttemptSidecar` calls `removeDirectoryFileNoFollow` instead of hand-rolled unlink+ENOENT. |
| 21 | code-simplifier-3 | ACCEPTED | Extract `pointedTaskGraphAuthority` for the byte-identical capture catch/translate blocks. |
| 22 | code-simplifier-4 | ACCEPTED | Extract `waveNumberError` / `integerBoundError` helpers; all diagnostics byte-unchanged. |
| 23 | code-simplifier-5 | ACCEPTED | Unexport `noFollowFlag`, `directoryFlag`, `parseOrphanedWaveGateRetirement`, `parseSpecTraceWaveGateRetirement` (verified zero external importers). |
| 24 | code-simplifier-6 | ACCEPTED | Add `canonicalTempDir(prefix)` in `engine/tests/fixtures/canonical-temp-dir.ts` (support path) and rewire the in-scope test fixtures; standalone smoke script keeps its inline wrap (standalone-is-the-idiom). Out-of-scope repo-wide sites stay as-is — not part of this reviewed wave. |
| 25 | code-simplifier-7 | ACCEPTED | Add `graphFixture` beside `taskFixture` in `engine/tests/fixtures/task-lifecycle.ts` (support path) and rewire in-scope sites whose literal matches the canonical shape. |

Totals: 24 accepted, 1 deferred, 0 dismissed.

## Refuted-finding audit

`result.json.refuted_critical_findings` is empty. The Refutation Panel (reproduction / intent /
blast-radius criteria) **upheld** both criticals 6/6; nothing was refuted, so nothing is exempt from
fixing and no refuted finding is being fixed.

## Remediation support paths (out of frozen scope; registered at remediation start)

1. `.claude/plans/2026-08-28-darwin-pr-remediation-round6.md` (this plan)
2. `engine/src/handlers/helpers/complete-wave-gate.ts` (C-18 branch deletion)
3. `engine/src/handlers/helpers/reconcile-implementation-proof.ts` (C-18 branch deletion)
4. `engine/tests/handlers/complete-wave-gate.test.ts` (C-18 seam assertion rework)
5. `engine/src/handlers/subagent-start/mark-subagent-active.ts` (structured cleanupFailure formatting)
6. `engine/tests/fixtures/canonical-temp-dir.ts` (new shared fixture helper)
7. `engine/tests/fixtures/task-lifecycle.ts` (graphFixture)

## Validation commands

- `cd engine && npx tsc --noEmit` (typecheck)
- `cd engine && env -u PI_CODING_AGENT npx vitest run --testTimeout=15000` (full unit suite; target: green)
- `bash scripts/smoke-standalone-review.sh`, `bash scripts/smoke-panel-mode.sh` (portability shims still pass) — run if their code paths are touched
