# PR remediation — registered round 3

- Branch: `fix/abandoned-gate-terminal-outcome`; reviewed HEAD: `38e7cbf1aadad228afd79fd5eafa520fa75bf4bd`.
- Scope: the frozen `all` review scope in `.claude/reviews/review-and-fix-runs/review-fix-20260923T090224Z-38e7cbf1-r2/result.json`; no manually derived source Findings.
- Provenance note: a first review run `review-fix-20260923T082224Z-38e7cbf1` was **abandoned as superseded** (`--superseded-by review-fix-20260923T090224Z-38e7cbf1-r2`): silent-failure-hunter failed strict-JSON payload admission at both bounded attempts (prose wrapped an inline `{ kind: "allow" }` fragment → two JSON candidates; admission fails closed on ambiguity), and `restart` is Wave-Gate-only, so the honest recovery was a fresh standalone review run.
- Emitted/admitted: 1 critical + 20 advisories from 7 reviewers (attempt-1 aborts consumed one bounded retry across all slots; pr-test-analyzer's first admitted capture also failed JSON admission and its final attempt was admitted). After the Refutation Panel (reproduction/intent/security, threshold 2): **1 surviving critical, 0 refuted**, 20 advisories.
- Refuted-finding audit: **empty** — no refuted critical to report or fix.
- Advisory policy: `policy-20260923T092247Z-38e7cbf1`, initial `DECLARED` publication digest `efdf9a3faa4a8e17c93060b80c9537a3435f2444c501c856fca1a6c35e81302b` (20/20 accepted, 0 deferred, 0 dismissed; complete reasons in its published disposition).

## Declared critical accounting

- `architecture-tech-lead-1` (subject `standalone-review`): **repaired** (planned) in group `group.reviewer-scope-empty-retry`.
- Root cause (`DECLARED`): `engine/src/handlers/helpers/programs/helpers.ts` `gitPaths`/`gitText` ingest status-0/empty-stdout Git output unconditionally, so a single transient empty probe during scope derivation freezes a silently reduced review scope, while the branch's canonical bounded empty-retry policy (`utils/git-probe.ts`) is enforced at the four other Git-observing families.
- Invariant (`DECLARED`): every Git observation digested into review scope authority is either re-observed through the canonical bounded empty-retry or, on confirmed-empty, handed to an explicit caller decision — never ingested silently; a confirmed-empty observation for an output that cannot legitimately be empty (e.g. `rev-parse HEAD`) refuses loudly.
- Siblings (`DECLARED`): `engine/src/config.ts` (boundary root probe), `engine/src/utils/git.ts` (`probeGitWithEmptyRetry` root/HEAD/diff probes), `engine/src/orchestration/git-remediation.ts`, `engine/src/utils/workspace-digest.ts` — the four policy-enforced families, checked-unmodified; they already implement the invariant and are the repair's reference pattern. `engine/src/core/standalone-review.ts` `parseStandaloneReviewScope` checked-unmodified: its all-empty refusal remains the downstream guard; the repair closes the partial-omission class at the observation site.
- Selected operator check: `project:verify` (enrolled; required report `.loom/completion-reports/verify.junit.xml`).
- Historical RED (`DECLARED`): with a scripted transient Git child (first invocation status-0/empty stdout, second normal), pre-repair `gitPaths` returns an empty family and `deriveChangedPaths` freezes a reduced scope with no diagnostic, and a confirmed-empty `rev-parse HEAD` freezes `head: ""`-shaped authority; post-repair the bounded retry recovers the family's paths and confirmed-empty `rev-parse HEAD` refuses loudly. A scripted-fake-Git regression discriminates both arms. This is not an engine-observed historical test execution.

## Accepted advisory fixes (all 20 accepted; none deferred, none dismissed)

1. `code-reviewer-1` — `phase-artifact-paths.ts:56`: align the state-layout fallback with its documented contract (grandparent only when basename is `.claude`/`.pi`, refuse otherwise); pin with unit rows.
2. `silent-failure-hunter-1` — `completion-check-runner.ts:751`: append the raced spawn-failed errno cause to the termination-unconfirmed diagnostic; pin.
3. `pr-test-analyzer-1` — consumer-level empty-retry pin for the boundary root probe (`config.ts` `gitRepositoryRootFrom`): scripted transient + confirmed-empty attribution rows.
4. `pr-test-analyzer-2` — pin the SubagentStop boundary-observation failure arms (structured authority-preserving error; non-consuming infrastructure receipt) with throw-mock rows.
5. `pr-test-analyzer-3` — pin the non-Git refusal of the reconcile CLI (refusal message + byte-identical State File).
6. `type-design-analyzer-1` — carry the parsed `NewTestEvidence` ADT through `UntrustedStopResolution`/`IncomingImplementationEvidence`; remove the coercing re-parse; retype the three flatten sites.
7. `comment-analyzer-1` — disclose the inert cross-branch status of the block-direct-edits `node:path` grant comment.
8. `comment-analyzer-2` — disclose the inert cross-branch status of the absent emission-ingestion `node:crypto` grant entry.
9. `comment-analyzer-3` — add `attest` to the orchestration header Usage block.
10. `architecture-tech-lead-2` — make `baseDir` required in `phase-artifact-paths.ts` and retire the zero-production-caller cwd-defaulted `resolveTransition` compatibility shell.
11. `architecture-tech-lead-3` — extract one pure closed-group classifier shared by the parent-trigger and leader-reaped arms of `runProjectCommand`.
12. `architecture-tech-lead-4` — split `state-manager.ts` into a pure at-rest wire-grammar module plus the authority machine, re-exporting for an unchanged import surface.
13. `architecture-tech-lead-5` — delete the two verified-empty untracked scratch files (`remaining.txt`, `standalone-review-authority`).
14. `code-simplifier-1` — one shared plain-record type-guard replacing ~25 logic-identical hand-rolled guards (state-manager, core/findings, pi/extension, core/context-packets), per-site error labels kept.
15. `code-simplifier-2` — one-line failure constructors in `wave-gate-machine.ts` replacing 10 inline canonical-failure literals.
16. `code-simplifier-3` — delete the dead exported `isGitRepo` (zero consumers verified).
17. `code-simplifier-4` — one local `isEnoent` predicate replacing ten copies of the cast in `no-follow-fs.ts`.
18. `code-simplifier-5` — collapse `reconcileTaskFromStoredEvidence`'s duplicated final ternary arms to one return with conditional `revalidation_required`.
19. `code-simplifier-6` — delete the dead `(reconciled as TaskGraph)` assertion after the null guard.
20. `code-simplifier-7` — same two scratch files as `architecture-tech-lead-5`.

## Validation and installation

1. Implement the critical repair first with its scripted-fake-Git regression; then the accepted advisories in clusters (each cluster followed by its covering focused suites).
2. Compiler/typecheck, then `bun run verify` in development (not P3 evidence); distill apply-mode pass on a green baseline.
3. Register a fresh schema-v2 remediation run naming this Plan and every new/changed path outside the frozen scope in `supportPaths` at start. Only the registered runner's fresh structured `project:verify` result is `ENGINE_OBSERVED`; report its `repair-checked` outcome and verified-index receipt without claiming proven closure. Commit the exact installed index and push.
4. Runtime note: engine-source edits change the checkout revision; before any further CLI mutation (remediation start/resume) the running Pi extension must be reloaded so `LOOM_PI_EXTENSION_RUNTIME_REVISION` matches the checkout, or the skew gate blocks the mutation.
