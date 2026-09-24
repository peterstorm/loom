# PR remediation — registered round 2

- Branch: `fix/abandoned-gate-terminal-outcome`; reviewed HEAD: `45ca14ac6c591aba2fcf81ff18ad18b729797ab9`.
- Scope: the frozen `all` review scope in `.claude/reviews/review-and-fix-runs/review-fix-20260923T071950Z-1125/result.json`; no manually derived source Findings.
- Emitted/admitted: 1 critical, 6 advisories. After Refutation Panel: 1 surviving critical, 0 refuted, 6 advisories. Reproduction lens uncertain (no execution), intent and security upheld. Refuted-finding audit: empty; no refuted critical to fix.
- Advisory policy: `policy-20260923T073534Z-21007`, initial `DECLARED` publication digest `32fa6a993305b40fb433fcb1b2622e468c6a30717607296714555a22d022237e`; complete reasons are in its published disposition.

## Declared critical accounting

- `architecture-tech-lead-1`: **repaired** (planned) in group `group.taskgraph-reconciliation-boundary`.
- Root cause (`DECLARED`): proof reconciliation loads the authoritative State File but resolves Git and new-test evidence from ambient process state instead of its TaskGraph boundary.
- Invariant (`DECLARED`): all packet, artifact, Git, and new-test observations used to reconcile a selected TaskGraph come from the repository owning that TaskGraph; a non-Git boundary is refused without altering the State File.
- Siblings (`DECLARED`): `engine/src/handlers/subagent-stop/update-task-status.ts` and `engine/src/handlers/helpers/exact-implementation-settlement.ts` checked-unmodified: their existing root-explicit paths implement this invariant. `pi/subagent-result.ts` repaired in the same project-boundary family for the two accepted legacy-Pi advisories; legacy new-test evidence uses root-explicit diff dependencies. `engine/src/handlers/helpers/task-local-completion.ts` checked-unmodified: `realDiffDepsAt(root)` already provides the required root-explicit Git/filesystem port.
- Selected operator check: `project:verify`. Historical RED (`DECLARED`): with a TaskGraph in linked worktree B and the CLI in same-HEAD checkout A, pre-repair reconciliation reads A's artifact/test bytes and can change B's proof or Wave Gate. A divergent-checkout regression discriminates this behavior. This is not an engine-observed historical test execution.

## Advisory decisions

- `code-reviewer-1` **accepted**: pass root-explicit diff deps to legacy Pi settlement; current default inspects the process checkout.
- `silent-failure-hunter-1` **accepted**: same Pi legacy path can silently report the wrong checkout's tests; add regression.
- `type-design-analyzer-1` **accepted**: narrow `additionalValues` to the literal flags admitted by the supplied grammar rather than falsely total `Record<string,string>`.
- `comment-analyzer-1` **accepted**: explain that whole-argv parsing retains empty leftovers even though `argumentValue` returns absent.
- `code-simplifier-1` **accepted**: consolidate attempt-2 terminal block without changing audit-before-checkpoint sequencing.
- `code-simplifier-2` **accepted**: consolidate duplicate parent-close wait without changing process containment outcomes.

## Validation and installation

1. Regress divergent linked worktrees for proof reconciliation and Pi legacy observation; pin grammar and terminal/wait behavior with focused tests.
2. Run relevant focused suites, compiler/typecheck and `bun run verify`. Perform distill apply-mode pass on a green baseline.
3. Register fresh schema-v2 remediation with this Plan and every new/changed path outside frozen scope named in `supportPaths` at start. Only the registered runner's fresh structured `project:verify` result may be `ENGINE_OBSERVED`; report its `repair-checked` outcome and verified-index receipt without claiming proven closure. Commit the exact installed index and push.
