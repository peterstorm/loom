# PR Remediation Round 4 — Anchored TaskGraph Authority

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `d6b01017507f5ab89d085b89103d432a0e3d015c`
- Source review: `review-20260827T173540Z-deterministic-task-completion-oracle-post-remediation-7`
- Source digest: `c1a6a0c5c5cfa3ca17cf2828a219ed9428a110ebccff03f70f4ab9fdbb29c756`
- Exact frozen scope: the 125 paths in the source review's immutable `result.json.scope`.

## Mandatory critical remediation

1. Replace session TaskGraph pathname authority with an immutable anchored file authority: a canonical display path, safe leaf, and captured parent device/inode. Open every ancestor with `O_NOFOLLOW`; each StateManager operation must reopen and verify that parent identity before side effects, then lock, read, stage, mode, and rename through one retained descriptor. Add symlink-ancestor and post-resolution parent-replacement regressions.
2. Return an error for malformed SubagentStop JSON so corrupted stop events cannot report successful passthrough while settlement and cleanup are skipped. Update the focused dispatch regression.
3. Add a Pi bridge regression that mutates captured transcript bytes after Pi witnesses them and proves trusted review verification rejects the changed slot, then restore the exact bytes and prove verification recovers.
4. Correct the `repositoryContext` comment: root and HEAD are two fixed-argv Git observations collected into one typed result, not one atomic `execFileSync` observation.

## Advisory dispositions

- `code-reviewer-2` — accepted: retain Pi spawn reservation/pointer cleanup authority until release succeeds so normal result handling or session shutdown can retry.
- `silent-failure-hunter-2` — accepted and subsumed by item 1: the new anchored atomic publisher unlinks its exact temp directly and ignores only `ENOENT`; it does not use `existsSync`.
- `pr-test-analyzer-2` — accepted: add missing/malformed marker coverage for store-test-evidence.
- `type-design-analyzer-1` — accepted: verify the supplied Task completion suite digest equals the canonical digest of parsed checks.
- `comment-analyzer-2` — accepted: include architecture-panel collisions in the `reviewPanelOverlap` contract comment.
- `comment-analyzer-3` — accepted: remove obsolete Darwin prose from the Linux-only no-follow removal contract.
- `architecture-tech-lead-1` — deferred: transport-neutral phase-order decisions require an independent interface migration unrelated to these correctness fixes.
- `architecture-tech-lead-2` — deferred: extracting the SubagentStart registration saga is a substantial independent deepening; changing that seam during pointer-authority remediation would raise risk.
- `code-simplifier-1` — deferred: workspace-readiness deduplication is behavior-preserving cleanup outside the authority defects and should not share this security-sensitive change.

## Refuted audit

No critical was refuted. Reproduction, intent, and security lenses unanimously upheld all four criticals.

## Validation

Typecheck/unused; focused StateManager/pointer/dispatch/Pi/store-evidence/completion tests; full bounded Vitest; smoke suite; changed-production lint; `git diff --check`; distill apply-mode pass; registered remediation; verified-index installation; commit/push; fresh canonical review/refutation.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-28-pr-remediation-round4.md`
