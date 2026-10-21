# PR #126 remediation

**Branch:** `fix/repilot-findings`

**Scope:** the PR's frozen diff, 26 files. It covers the four re-pilot findings: N3, N4, N5 and N6.

**Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261021-pr126`, result `a7c1b465…99fc`. It captured 7 of 7 slots: 0 critical, 8 advisory, 0 refuted.

**Advisory policy:** `policy-20261021-pr126`, initial revision, disposition digest `955cf3c9…68ca`, DECLARED.

## Surviving criticals

None. `defectFamily` is `{"kind":"not-required"}`.

## Refuted criticals

None.

## Advisory dispositions (all accepted)

| ID | Fix |
|---|---|
| pr-test-analyzer-1 | New CLI tests: an active `active_wave_gate` refusal names the run; a pre-existing archive leaf makes `completeOrchestration` throw, and both the live graph and the earlier archive keep their exact bytes. |
| pr-test-analyzer-2 | New sweep test: a graph-bound session `s.bound` keeps its machine binding, its implementation-attempt sidecar and its stop-check note, which is filed under the differing sidecar key `s_bound`. |
| architecture-tech-lead-1 | `STOP_CHECK_NOTE_SUFFIX`, `sidecarKey`, `sessionGroupKeys` and `sessionOfTrackingFile` now live in the pure `machine/evidence.ts`, beside `SESSION_SUFFIXES`. The sweep and the sidecar module both consume them. Graph-bound sessions are protected under both key forms. |
| architecture-tech-lead-2 | `StateManager.archiveAndRemove` reads the graph bytes once and parses those same bytes through the new `parseGraphBytes`, so the archived bytes are the judged bytes. The refusal text moved into the pure `renderCompletionRefusal`. |
| code-simplifier-1 | `normalizeAbsolute` now folds segments with early returns instead of a nested ternary. |
| code-simplifier-2 | Dropped the unread `taskCount`. The non-empty `reasons` tuple is built by a typed binding, with no cast. |
| code-simplifier-3 | The pointer's session is derived by slicing the `.task_graph` suffix, with no `sessionOfEntry` round trip. |
| code-simplifier-4 | `tests/fixtures/repository-roots.ts` exports `ENGINE` and `REPOSITORY`. The six cwd-free tests import them instead of computing their own depths. |

## Support paths (outside the frozen scope)

- `engine/src/machine/evidence.ts`
- `engine/src/machine/index.ts`
- `engine/tests/fixtures/repository-roots.ts`
- `.claude/plans/2026-10-21-pr126-remediation.md`

## Validation

- `bun scripts/typecheck.ts` (engine): exit 0.
- Root-started full suite (`npx --prefix <abs>/engine vitest run --root <abs>/engine`): 552 files, 13,511 passed, 1 skipped.
