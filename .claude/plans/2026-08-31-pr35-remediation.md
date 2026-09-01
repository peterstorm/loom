# PR #35 remediation — consolidated main review

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- PR: [#35](https://github.com/peterstorm/loom/pull/35)
- Consolidation merge: `083c7e8042f22c6e84a9eebb6cfef49edc85ec97`
- Base: `origin/main` at `48483ba25ccacd87cb386df7d33f177573de99f1`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260831T123406Z-962`
- Frozen scope: the 121 paths recorded in that run's authoritative `result.json`
- Review totals: 7 reviewers emitted 2 critical and 10 advisory Findings. A three-lens Refutation Panel upheld both criticals; 0 criticals were refuted.

## Mandatory surviving criticals

1. `silent-failure-hunter-1` — `engine/src/handlers/helpers/review-packet.ts` rechecks a parser-proven artifact with `existsSync`, which converts a post-inspection EACCES/ELOOP/ENOTDIR fault into absence.
   - Use `inspectRepositoryPath(...).exists` as the parsed existence fact. If the path was observed present, read its postimage directly and let a race/read fault fail packet creation. Preserve null postimages only for a path proven absent, including staged deletions.
   - Add a fault-injected post-inspection read regression proving a present artifact's ELOOP is propagated rather than represented as a deletion.
2. `silent-failure-hunter-2` — the local Git helper accepts every `git diff --no-index` exit status 1 as a successful patch.
   - Accept status 1 only when stdout contains a real `diff --git` patch header. Otherwise throw an operator-facing error carrying stderr/stdout and preserve the original cause.
   - Add a fake-Git CLI regression where `diff --no-index` exits 1 with an access diagnostic and no patch; packet creation must fail and publish nothing.

## Advisory dispositions

### Accepted

1. `code-reviewer-1` — Wave review installation can accept packet context stale only in proof/test-result fields.
   - Re-run the pure `prepareWaveReviewBatch` against locked Task state using the pre-observed workspace/document facts, and require the complete prepared batch to equal the batch being installed. Add a race regression that mutates proof/test evidence without changing scope, generation, or bytes.
2. `code-reviewer-2` — three root-only Pi failure tests return as passing.
   - Express them as `it.skipIf(runningAsRoot)` so CI reports the coverage gap explicitly.
3. `pr-test-analyzer-1` — sparse staged byte arrays pass `Array.prototype.every` and are coerced to zero bytes.
   - Copy arrays before validation so holes become `undefined`, reuse that byte-copy rule for staged artifacts and decision contexts, and add a sparse-array regression.
4. `type-design-analyzer-3` — issued Review Packet registrations widen packet/base/head identities to plain strings.
   - Carry `PacketId`, `BaseSha`, and `HeadSha` in the registration type; parse each field with its domain-specific constructor and register the parsed head value. Add compile-time type assertions.
5. `code-simplifier-3` — legacy-archive bindings in `state-manager.ts` are imported/re-exported through duplicate declarations and an alias.
   - Import the local bindings once, explicitly re-export those bindings, and use the unaliased type internally without changing the Public Surface.

### Deferred

1. `type-design-analyzer-1` — making `ReviewRun.slot_authority` structurally inseparable from `expected_agents` is sound, but `ReviewRun` intentionally spans legacy unbound runs and engine-owned Wave runs without a persisted discriminant. A correct fix requires a parsed legacy/engine ADT and migration of every review-run reducer, not an optional-field tweak inside this remediation.
2. `type-design-analyzer-2` — `ReservedSlot` should be a category-discriminated authority union. This changes the Pi extension/applier interface and every reservation constructor. It is a worthwhile `deepen` migration, but not required for the two reviewed Review Packet defects.
3. `architecture-tech-lead-1` — removing Git/filesystem observations from every `StateManager.update` closure requires a two-phase observation/compare-and-swap commit API across implementation settlement and Review Packet creation. That seam redesign is broader than this remediation and should be handled as a dedicated architecture change.

### Dismissed

1. `code-simplifier-1` — a private unknown-error formatter in `pi/extension.ts` would replace an idiomatic one-line expression with another concept while preserving the same 25 domain-specific catch sites; it does not reduce representable states or control flow.
2. `code-simplifier-2` — the same formatter suggestion in `no-follow-fs.ts` is dismissed for the same reason. The repeated expression is local and transparent; a wrapper would add indirection without consolidating any filesystem decision.

## Refuted-finding audit

No critical Finding was refuted. `silent-failure-hunter-1` was upheld by reproduction and blast-radius and refuted only by intent. `silent-failure-hunter-2` was upheld unanimously. Both are mandatory and will be fixed.

## Support paths outside frozen review scope

The registered remediation must authorize:

- `.claude/plans/2026-08-31-pr35-remediation.md`

All regression suites selected above are already inside the frozen 121-path scope.

## Validation

```bash
bun run --cwd engine typecheck
(cd engine && env -u PI_CODING_AGENT bunx vitest run \
  tests/handlers/helpers/quality-programs.test.ts \
  tests/handlers/helpers/wave-spec-check-scope.test.ts \
  tests/orchestration/publication-faults.test.ts \
  tests/core/review-packet.test.ts \
  tests/state-manager.test.ts \
  tests/pi-extension-review-events.test.ts \
  --testTimeout=120000)
env -u PI_CODING_AGENT bun run --cwd engine test:unit
env -u PI_CODING_AGENT bun run --cwd engine test:smoke
git diff --check
```

## Validation receipt

Validated against the remediated working tree:

- `bun run --cwd engine typecheck` — clean, including unused locals and parameters.
- Focused Review Packet, Wave context, publication, branded-registration, Pi, and StateManager suites — green.
- `bun run --cwd engine test:unit` — **229 files, 5931 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — panel mode 22/22, review panel 19/19, standalone review, all six façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check` — clean.

The uncapped full unit command passed every assertion twice but both times exited nonzero after Vitest reported `Timeout calling onTaskUpdate`. A four-worker full run completed cleanly, so `test:unit` now carries `--maxWorkers=4`; the exact updated package command was then rerun successfully. `PI_CODING_AGENT` was unset only for validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green baseline: the four-worker full suite above.

Moves applied:

1. Reused one defensive byte copier for staged artifacts and decision contexts, shrinking two hole-prone byte-contract implementations to one.
2. Consolidated legacy-archive imports/re-exports in `state-manager.ts` and removed the obsolete alias.
3. Removed the orphaned deprecation comment left after that consolidation; typecheck and 173 covering StateManager tests stayed green.

Skipped opportunities:

- Unknown-error formatter wrappers in `pi/extension.ts` and `no-follow-fs.ts` — add indirection without reducing state space or control flow.
- `ReviewRun` legacy/engine ADT, category-discriminated `ReservedSlot`, and two-phase StateManager observation/commit — interface and seam migrations deferred to `deepen` as recorded above.
- No further behavior-preserving simplification passed the reader test without weakening explicit authority diagnostics.
