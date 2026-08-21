# PR Remediation — 2026-08-20 (Round 2)

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed head:** `41f955ed35be58880ee2920d179a085ecd3bde89`
- **Merge base:** `eda64237336193dac66843323b4c69dd4bafcd32`
- **Standalone Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260820T174006Z-446021314`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/review-20260820T174006Z-446021314/result.json`
- **Result digest:** `5250d91d04562526296172cac1e628db02f13cbd004db6b00ac2ebafc1a7f91f`
- **Exact frozen scope:** the canonical 485-path array at `result.json#/scope`; remediation reads this authority directly and neither reconstructs nor broadens it.
- **Support paths outside frozen scope:** `.claude/plans/2026-08-20-pr-remediation-round2.md` only.
- **Baseline:** `cd engine && npm run test:unit` — 188 files and 4,840 tests passed before remediation.

## Surviving critical Findings — mandatory

1. **`code-reviewer-1` — a late stale observer can displace a newly born live lock**
   - Replace unique, disposable stale tombs with generation-bound retirement fences. Each new lock birth writes one atomic owner record containing PID and a unique generation; stale observers all target the same non-empty retirement path for that generation.
   - The first stale observer can atomically retire that exact generation. Its persistent fence makes every delayed contender's rename fail after a fresh generation is born, so no stale observation can move a live holder.
   - Preserve fail-closed behavior for unreadable owner records and backward-compatible observation of legacy PID-only locks.
   - Add a deterministic three-contender regression proving contender A retires the stale generation, contender B acquires a fresh generation, and delayed contender C cannot move B.

2. **`silent-failure-hunter-1` — Pi post-edit lint silently omits inaccessible project rules**
   - Replace the `existsSync` project-rules probe with the extension's fail-closed path probe. Only absence yields `null`; access/path/I/O failures continue into rule loading and become a caller-visible lint-engine error.
   - Add an extension-level `ELOOP` regression proving an inaccessible project rules path blocks rather than silently falling back to shipped defaults.

3. **`comment-analyzer-1` — filesystem-backed lint helpers are mislabeled pure**
   - Rename the section to describe testable helper logic without claiming purity. Keep the genuinely pure transformations and filesystem shell helpers at their current established interface.

4. **`comment-analyzer-2` — `cd` is incorrectly documented as outcome-neutral**
   - Narrow the comment to the actual relaxed-evidence claim: a successful paired result and strict runner summary can preserve stdout attribution for an allowed `cd` preamble. Explicitly avoid claiming that `cd` cannot alter execution or test selection.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` — sparse byte arrays bypass `ByteSection` validation.** Materialize candidate bytes before validation so holes become `undefined`, reject them at both build and parse boundaries, and add sparse-array regressions.
2. **`silent-failure-hunter-2` — unreadable JUnit directories look empty.** Remove the `existsSync` preflight; treat only `ENOENT` as absent and log all other directory-read failures. Add an `ELOOP` diagnostic regression.
3. **`silent-failure-hunter-3` — unreadable call-start stamps look absent.** Read directly; return quiet absence only for `ENOENT`, while retaining fail-closed `null` plus a path-qualified diagnostic for every other failure. Add an `ELOOP` regression.
4. **`silent-failure-hunter-4` — unreadable Fugue checkpoints look absent.** Read directly, return `null` only for `ENOENT`, and propagate every other filesystem error. Add a file-journal `ELOOP` regression.
5. **`silent-failure-hunter-5` — dirty-path access failures look deleted.** Replace `existsSync` classification with an `lstatSync`-based result that distinguishes only `ENOENT` from real failures; propagate a typed Git boundary failure from `observeDirtyPaths`. Add an inaccessible-parent regression.
6. **`pr-test-analyzer-1` — foreign-owned release behavior lacks a pin.** Add a regression proving `releaseLock` preserves a foreign generation.
7. **`pr-test-analyzer-2` — ownership-inspection failure lacks a pin.** Add a root-independent symlink-loop regression proving `releaseLock` throws and preserves the lock.
8. **`type-design-analyzer-1` — built packets retain mutable caller aliases.** Canonicalize every validated section into frozen parser-owned copies before packet construction; assert caller mutation cannot change packet bytes or digest.
9. **`comment-analyzer-3` — `lintFiles` JSDoc omits `timeoutMs`.** Document the batch timeout contract.
10. **`comment-analyzer-4` — `countNewTests` says methods but counts suites.** Describe the function as a heuristic count of test/suite declarations.
11. **`comment-analyzer-5` — `readFileSync` is described as atomic.** Describe one buffered read, preserving the accurate no-second-read TOCTOU claim without overstating filesystem atomicity.
12. **`architecture-tech-lead-2` — legacy archive compatibility forms a value cycle.** Remove legacy re-exports from the canonical standalone module, point historical helpers/tests directly at `legacy-archive`, and add the relevant core volumes to an acyclicity regression. This is a complete one-way compatibility-seam correction within the frozen scope.
13. **`code-simplifier-1` — duplicated spec artifact discovery.** Extract one local readable-spec helper used by `specify` and `clarify`, preserving their distinct marker transitions.
14. **`code-simplifier-2` — pass-through Agent type aliases.** Use the already parsed roster values directly in guarded-machine binding.
15. **`code-simplifier-3` — repeated dynamic lock imports.** Statically import the test-only stale-reap API once.

### Deferred

1. **`architecture-tech-lead-1` — `config.ts` mixes pure policy with import-time filesystem/Git discovery.** The claim is sound, but a complete fix moves a seam used by seven core modules (`artifact-write-scope`, `guard-state-file`, `validate-task-execution`, `block-direct-edits`, `validate-template-substitution`, `pi-write-grant-plan`, and `validate-phase-order`) and must split catalog policy from runtime path discovery across all shell call sites. A partial extraction would leave hidden import-time I/O and the Finding true. Defer as a dedicated architecture migration; this remediation adds no new `core -> config` dependency.

### Dismissed

- None.

## Refuted critical Finding audit

- `result.json.refuted_critical_findings` is empty. No critical Finding was omitted or fixed as refuted.
- `code-reviewer-1`, `silent-failure-hunter-1`, and `comment-analyzer-1` were upheld by reproduction, intent, and blast-radius lenses.
- `comment-analyzer-2` survived reproduction and blast-radius. The intent lens refuted only the broad interpretation, reasoning that the surrounding comment concerned output contamination and that a failed canonical `cd && runner` cannot mint green evidence. The surviving correction therefore narrows the prose to that actual attribution contract without claiming outcome neutrality.

## Planned changed files

- `.claude/plans/2026-08-20-pr-remediation-round2.md` (support path)
- `engine/src/utils/lock.ts`
- `engine/tests/utils/lock.test.ts`
- `pi/extension.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `engine/src/handlers/helpers/lint-wave-gate.ts`
- `pi/transcript-adapter.ts`
- `engine/src/orchestration/context-packets.ts`
- `engine/tests/orchestration/uncovered-branches.test.ts`
- `engine/src/machine/report-discovery.ts`
- `engine/tests/machine/report-discovery.test.ts`
- `engine/src/machine/ledger.ts`
- `engine/tests/machine/ledger.test.ts`
- `engine/src/orchestration/fugue-program-runtime.ts`
- `engine/tests/orchestration/fugue-program-runtime.test.ts`
- `engine/src/orchestration/git-remediation.ts`
- `engine/tests/orchestration/remediation-faults.test.ts`
- `engine/src/linter/index.ts`
- `engine/src/utils/git.ts`
- `engine/src/core/standalone-review.ts`
- `engine/src/core/legacy-archive.ts`
- `engine/src/handlers/helpers/standalone-review.ts`
- `engine/tests/core/standalone-review.test.ts`
- `engine/tests/handlers/helpers/standalone-review.test.ts`
- `engine/tests/core/orchestration-contract-acyclic.test.ts`
- `engine/src/handlers/subagent-stop/advance-phase.ts`
- `engine/src/handlers/subagent-start/mark-subagent-active.ts`

## Validation

Focused gates after each coherent move:

```bash
cd engine
npm run test:unit -- --run tests/utils/lock.test.ts
npm run test:unit -- --run tests/pi-extension-review-events.test.ts tests/handlers/helpers/lint-wave-gate.test.ts tests/pi-test-evidence.test.ts
npm run test:unit -- --run tests/orchestration/uncovered-branches.test.ts tests/orchestration/fugue-program-runtime.test.ts tests/orchestration/remediation-faults.test.ts
npm run test:unit -- --run tests/machine/report-discovery.test.ts tests/machine/ledger.test.ts
npm run test:unit -- --run tests/core/standalone-review.test.ts tests/handlers/helpers/standalone-review.test.ts tests/core/orchestration-contract-acyclic.test.ts
npm run test:unit -- --run tests/handlers/subagent-stop/advance-phase.test.ts tests/handlers/subagent-start/mark-subagent-active-roster.test.ts tests/utils/git.test.ts tests/linter/index.test.ts
npm run typecheck
```

Final gates:

```bash
cd engine
npm run test:unit
npm test
```

After implementation is green, run `distill` in apply mode one behavior-preserving move at a time. Start registered remediation with `supportPaths: [".claude/plans/2026-08-20-pr-remediation-round2.md"]`; resume to `done`, accept only the engine-installed verified index, commit, and push without force.
