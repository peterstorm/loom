# PR Remediation — Deterministic Task Completion Oracle Round 15

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T141757Z-deterministic-task-completion-oracle-post-remediation-19`
- Result digest: `3482a12d85079e3e0d8000985f585ff79cf04662be3478799f64432c86fe2f88`
- Frozen scope: the exact `scope` array in that immutable result.

## Mandatory critical remediations

1. `engine/src/handlers/helpers/programs/wave-gate.ts`: apply attempt-1 spec-check capture rejection only when the locked TaskGraph still grants the exact run/Wave/epoch/slot/attempt authority. A stale callback returns unchanged state. Add an attempt-2-wins interleaving regression.
2. `engine/src/handlers/subagent-start/mark-subagent-active.ts`: contain TaskGraph path discovery, fail-closed existence probing, manager construction, and loading in one observation boundary; path-discovery uncertainty blocks before any capability publication. Add direct path-resolution failure coverage.
3. `pi/extension.ts`: establish `failResumeContext` before TaskGraph discovery and contain discovery, probing, manager construction, and loading in that boundary so Pi aborts with a visible context error. Add discovery failure coverage.
4. `engine/tests/handlers/update-task-status.test.ts`: remove ambiguity in the allegedly failing unreadable-transcript regression by explicitly constructing its proof-bearing precondition and retaining the quarantine assertions. Re-run the focused suite and full suite; the pre-remediation focused baseline was already green at 64/64.

## Advisory dispositions

### Accepted

- `pr-test-analyzer-2`: add a direct locked artifact-persistence phase-race regression.
- `type-design-analyzer-2`: reject non-finite, fractional, and unsafe Pi `exitCode` values at the parse boundary.
- `comment-analyzer-1`: qualify the Agent Catalog comment as Loom-owned identity policy.
- `comment-analyzer-2`: describe `REVIEW_AGENTS` as finding-producing review Agents plus spec-check, not all review-related Agents.
- `comment-analyzer-3`, `comment-analyzer-4`: qualify failed-result persistence comments by exact/current reserved authority.
- `code-simplifier-1`: reuse the already parsed empty findings instead of reparsing an empty transcript.
- `code-simplifier-3`: let the shared spec-check authority diagnostic own the absent-authority case.

### Deferred

- `type-design-analyzer-1`: a non-empty tuple migration for Wave completion rejection changes a shared type interface and is broader than this authority remediation.
- `architecture-tech-lead-1`: extracting Phase artifact observation from transition policy changes a cross-harness seam; pursue as a dedicated deepening after Slice 3 converges.
- `architecture-tech-lead-2`: splitting config policy/runtime discovery is a broad module-interface migration unrelated to surviving correctness findings.
- `architecture-tech-lead-3`: a `ReviewRun` ADT migration affects parser, recovery, and Wave Gate interfaces; defer to a dedicated independently reviewed refactor.
- `code-simplifier-2`: consolidating Pi review mutation is wider than the critical authority paths and risks obscuring this remediation.
- `code-simplifier-4`: extracting missing-result patch construction is useful but touches a separate result-settlement path.
- `code-simplifier-5`: one-pass status counting is cosmetic and unrelated to correctness.

## Refuted finding audit

Review 19 recorded no refuted critical findings. All four surviving criticals are dispositioned above.

## Validation

1. Focused Vitest suites for Wave Gate orchestration, SubagentStart, Pi extension events, phase advancement, Pi result parsing, spec-check storage, and update-task-status.
2. `npm run typecheck` and `npm run typecheck:unused`.
3. Full bounded Vitest (`--maxWorkers=3 --minWorkers=1`).
4. Smoke suite (`23/23` expected).
5. Changed-production lint and `git diff --check`.
6. Registered remediation installation sourced from review 19, exact index commit, and push without force.
7. Fresh canonical standalone review and three-lens refutation; do not open a PR unless zero criticals survive.
