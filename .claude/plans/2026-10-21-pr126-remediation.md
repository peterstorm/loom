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

# Round 2

Source review `review-fix-20261021-pr126-r2` against head `705d71e8`: 0 critical, 10 advisory. Policy `policy-20261021-pr126-r2` (disposition `dfec2a01`): all 10 accepted.

| Finding | Change |
|---|---|
| silent-failure-hunter-1 | `startingSessionOf` returns a `StartingSession` ADT (`named`, `absent`, `unusable` with its cause). Non-empty SessionStart input with no usable `session_id` is reported as a `parse` diagnostic in the hook's message, and a malformed `<session>.task_graph` pointer is reported as a `parse` diagnostic instead of binding nothing silently. |
| pr-test-analyzer-1 | New `complete-orchestration-publish.test.ts` injects a live-graph removal failure at the no-follow-fs seam. The helper rejects with the failure, the live graph and the archive both hold the exact bytes, and no prepared name remains. |
| type-design-analyzer-1 | Every tracking file classifies to one branded `SessionGroupKey`, the session's sidecar key (`sessionGroupOfTrackingFile`, `sessionGroupKey`). `sessionGroupKeys` is gone; the two-spelling split cannot be represented. |
| comment-analyzer-1 | The `scanSubstitutions` docblock sits on the function again, and names the context argument. |
| architecture-tech-lead-1 | `archiveAndRemove` publishes through `publishDirectoryFileExclusiveNoFollow`, now exported: the bytes are prepared under a temporary name and hard-linked into place, so no partial archive is ever visible. |
| architecture-tech-lead-2, code-simplifier-1 | `TASK_GRAPH_POINTER_SUFFIX` is one named constant in `machine/evidence.ts`, used by `SESSION_SUFFIXES`, the sweep, `state-manager`, `task-graph-pointer` and `ledger`. |
| architecture-tech-lead-3, code-simplifier-2 | `SubstitutionContext` is a discriminated union: `known-word` with its literal, or `opaque`. The scanner parses each heredoc span once, and the guard reads one variant. |
| code-simplifier-3 | The `repository-roots` import joins each test file's import block. |

## Support paths (outside the round-2 frozen scope)

- `engine/src/orchestration/no-follow-fs.ts`
- `engine/src/machine/task-graph-pointer.ts`
- `engine/src/machine/ledger.ts`
- `engine/tests/handlers/helpers/complete-orchestration-publish.test.ts`

## CI follow-up

macOS CI failed the real-bash agreement test: `/bin/bash` there is 3.2, which cannot parse a heredoc holding an apostrophe inside `$(…)`. The test now runs against a bash >= 4 found by the shared `tests/fixtures/modern-bash.ts` (also used by the brace-expansion differential), and skips when none exists. The guard documents why 3.2 cannot exploit the known-word rule.

## Validation

- `bun scripts/typecheck.ts` (engine): exit 0.
- Root-started full suite: 554 files, 13,540 passed, 1 skipped.
- Project lint: 77 violations, the same set as before this round; none in changed code.
