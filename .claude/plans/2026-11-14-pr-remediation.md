# PR #173 remediation: review-and-fix

**Created:** 2026-11-14
**Branch:** `feat/doc-reference-resolver` (PR #173, base `main`)
**Status:** Implemented; installed through the registered remediation named below.

## Scope and review runs

The whole-PR scope (297,019 read units) was over the 240,000-unit review budget, so it was reviewed in two
explicit `--files` slices that together cover every changed file:

| Run | Slice | Reviewers | Findings |
|---|---|---|---|
| `run.pr173-code-20261114` | `engine/` and `scripts/` (47 files) | code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-tech-lead, code-simplifier | 19 advisory, 0 critical |
| `run.pr173-docs-20261114` | `.claude/linter/rules/config.json`, the A4 plan, `docs/`, `lint-rules/`, `skills/` (17 files) | code-reviewer, silent-failure-hunter, comment-analyzer, architecture-tech-lead | 6 advisory, 0 critical |

`run.pr173-review-20261114`, the refused whole-PR start, is abandoned and superseded by the code run.

**Surviving criticals:** none. **Refuted criticals:** none. The remediation therefore declares
`defectFamily: not-required`.

## Advisory decisions (DECLARED, published)

Published by `run.pr173-code-policy-20261114` and `run.pr173-docs-policy-20261114`; each record's reasons are
the authority, summarized here.

**Code slice:** 17 accepted, 1 deferred, 1 dismissed.

- **Accepted:**
  - The corrupted module header of `extract.ts` (code-reviewer-1, type-design-analyzer-1, architecture-tech-lead-2, code-simplifier-1).
  - A git that cannot run inside a working tree fails the lint closed (silent-failure-hunter-1).
  - A link with an invalid percent-escape is resolved as written, not dropped (silent-failure-hunter-2).
  - CLI tests for a governed plan beneath `.claude/` and for an ungoverned Markdown file (pr-test-analyzer-1).
  - The wall-clock budget test is replaced by a counted one (pr-test-analyzer-2).
  - The fail-closed test pins the contract, not git's wording, and the git-cannot-run arms are tested (pr-test-analyzer-4).
  - A directory path reference carries no anchor, in the type (type-design-analyzer-2).
  - One definition of the tree `lint-project` reads, `lintedProjectFiles` in `project-walk.ts`, called by the script and the baseline guard (architecture-tech-lead-1).
  - Distill moves: a shared span-to-reference helper, the spec-header arm extracted, `once` and `remembered` shared through `memo.ts`, the `corpusRoleOf` comment, the `docReferenceOptions` signature, the single scope check in `findings` (code-simplifier-2 to code-simplifier-7).
- **Deferred:** a branded project-relative path type (type-design-analyzer-3). It changes the snapshot, index and resolver interfaces, so it belongs to a deepen session. There is no live defect.
- **Dismissed:** the runtime-skew regex (pr-test-analyzer-3). The first named file depends on the runtime checkout, and `lint-runtime-skew.test.ts` pins the order.

**Docs slice:** 5 accepted, 1 deferred.

- **Accepted:**
  - The Wave Gate is touch-scoped, so the README, the rule header and the plan now say `lint-project` reads the whole tree (comment-analyzer-1).
  - ADR-0047's sentence is in the past tense (comment-analyzer-2).
  - The plan's Status line and deviations are updated (comment-analyzer-3, architecture-tech-lead-3).
  - ADR-0074 names the two new linter dependencies against ADR-0001 (architecture-tech-lead-1).
- **Deferred:** a declared runtime-location vocabulary (architecture-tech-lead-2). It is the operator's configuration decision, already recorded in ADR-0074 as separate.

## Remediation

One registered remediation from the code run installs every change. The docs slice's accepted fixes and the
files outside the code slice are named in its `supportPaths`:

- `.claude/plans/2026-11-14-e-track-a4-doc-reference-resolver.md`
- `.claude/plans/2026-11-14-pr-remediation.md` (this plan)
- `docs/adr/ADR-0047-the-wave-review-roster-is-derived-per-task-from-owner-map-presence.md`
- `docs/adr/ADR-0074-every-doc-reference-resolves-against-the-project.md`
- `lint-rules/README.md`
- `engine/src/linter/doc-references/memo.ts` (new)

## Validation (OBSERVED by this session, not remediation evidence)

All on 2026-11-14, at the branch's final head:

- `tsc --noEmit` on the engine: clean.
- Linter suite (`engine/tests/linter`): 42 files, all passing after the last move.
- `bun scripts/lint-project.ts`: 1,743 files, no violations, no stale entries.
- `npm run verify`: passed in CI on PR #173 (`verify` on ubuntu-24.04 and macos-15) before the merge, `e4250889`.
