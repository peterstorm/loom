# Review-and-fix remediation — 2026-09-23

- Branch: `fix/abandoned-gate-terminal-outcome` at reviewed HEAD `53e520a7`.
- Exact scope: `all` derived by the registered standalone review, as frozen in its `result.json.scope` (141 changed paths against the branch base; no parent-authored pathspec).
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-fix-20260923T055046Z-`; source result digest `d690a5729f06746f53ca47ca7da665c1b06f8710385fe77d600ad2c6447adb96`.
- DECLARED advisory policy: initial revision published in `.claude/reviews/review-and-fix-runs/policy-20260923T061119Z-19036`, disposition digest `a2a706e13e50883ac2b2b105a763279929ea6bb31e2c760dd2c1b130c4f8f565`.

## Mandatory critical accounting (DECLARED)

- `code-reviewer-1`: **repaired** by `group.claude-taskgraph-boundary` (pending implementation and fresh checks). Root cause: Claude SubagentStop reads the runtime's ambient checkout in two repository-observation paths rather than the authoritative TaskGraph's project root. Invariant: paths reported by the transcript and all exact/legacy settlement byte comparisons use one observed boundary from `mgr.getPath()`; a divergent worktree cannot certify or reject bytes by observing its sibling checkout. Siblings: `engine/src/handlers/subagent-stop/update-task-status.ts` covers both modern settlement and legacy baseline comparison; `engine/src/handlers/helpers/task-local-completion.ts` already supplies `realDiffDepsAt(root)`; the previously ambient legacy new-test collection in the handler now uses it. No other sibling paths are declared. Selected fixed check: `project:verify` (`bun run verify`), plus focused linked-worktree tests. Historical RED (DECLARED, no observed historical execution): before repair, a SubagentStop routed to worktree B with `CLAUDE_PROJECT_DIR=A` would canonicalize transcript paths and compare Task bytes against A or falsely accept unchanged attestation while B drifts. Reference: the source Finding basis and the new linked-worktree regression test; no claim of a prior executed RED run.

## Advisory decisions (DECLARED, published)

- `silent-failure-hunter-1`: **accepted** — the abandon CLI prints a run marker before attempting the Wave Gate stamp; a not-targeted stamp now emits a diagnostic distinguishing marker publication from protected registration retirement. Covered for mismatched registration.
- `type-design-analyzer-1`: **deferred** — a TS-only brand does not authenticate a runtime State File path; the parser already observes containment and Git failures. Changing every consumer without a runtime provenance contract would add casts without strengthening the check.
- `architecture-tech-lead-1`: **deferred** — production artifact classification already supplies the TaskGraph root; removing the legacy cwd default changes test and spec-directory parser interfaces without closing the Claude settlement defect. A separate explicit-baseDir migration needs compatibility tests.
- `code-simplifier-1`: **accepted** — one local CLI value-token predicate removes two identical grammar implementations without changing interfaces. Empty/flag/ordinary values are covered by a shared-grammar test.

## Refuted critical audit

None: the three panel lenses upheld `code-reviewer-1` (reproduction: static linked-worktree trace; intent: State File root is documented authority; security: shared HEAD cannot detect wrong-checkout observations). No refuted critical was repaired.

## Validation and installation

Focused settlement, CLI and abandonment tests passed; `bun run verify` passed with 305 test files and 9,105 tests passed, one skipped, plus smokes. For registered P3, start a fresh schema-v2 remediation with exact source IDs, Declared Repair Group and selected `project:verify`, and immutable supportPaths containing this Plan, the two new regression tests and the two changed existing tests outside the frozen review scope. Only the runner's fresh structured report and exact verified-index installation are ENGINE_OBSERVED; the declarations above remain DECLARED. Commit the installed index and push on success.
