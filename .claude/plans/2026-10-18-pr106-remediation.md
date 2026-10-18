# PR #106 remediation: the write-target scanner joins its twin in core

- **Branch:** `refactor/extract-evidence-shims` (base `main`)
- **Scope:** the review's frozen diff was the PR's 18 files at `6f79984c` (`kind: all`). This remediation
  edits files inside that scope and adds the support paths listed below.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261018-pr106`
  (`result.json` digest `1bc56b7bb9612f7ee2767f2d59a8e8d86250d919cd507e4bb545ed677bac5ba6`)
- **Counts (inspection renderer):** 0 critical and 2 advisory emitted and admitted. After refutation:
  0 critical surviving, 0 refuted, 2 advisory.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261018-pr106`,
  revision `initial`, disposition digest `a6e831f6af8304e711935498555439167ee2f61a04780ad3ac374b018ab402a3`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| comment-analyzer-1 | accepted | ADR-0027 still describes `extractShellWriteTargets` beside the `extract-evidence.ts` minting rule. The ADR stays a historical record; a one-line pointer to the scanner's current home is a complete, in-scope fix. |
| architecture-tech-lead-1 | accepted | The scanner imports only core shell modules and no machine types, and its twin (the guard's redirect scanner) and the shared tokenizer live in `core/`. Moving it to `core/shell-write-targets.ts` puts the twin scanners in one layer and stops core tests reaching into `machine/`. |

## Accepted fixes

- **architecture-tech-lead-1.** `engine/src/machine/shell-write-targets.ts` moves to
  `engine/src/core/shell-write-targets.ts` (imports become core-relative). `extract-evidence.ts` imports it from
  core, and the machine barrel keeps re-exporting `extractShellWriteTargets`. The purity list, the spawn-seam
  guard's git-word allowlist, the five importing suites, the two core comments, `docs/architecture.md` and
  `machines/README.md` follow the new path. Order keeps the live hooks importable at every step: create the
  core file, repoint the importers, then delete the machine file.
- **comment-analyzer-1.** ADR-0027's minting-rule bullet gains a pointer to the scanner's current home.

The comment-analyzer's note that three comments name `readRedirectTarget` without a module path
(`shell-normalize.ts` twice, `shell-ansi-c.ts` once) is not a defect: each sits beside a module-qualified mention
in the same file's header.

## Support paths (outside the frozen scope)

- `engine/src/core/shell-write-targets.ts`
- `docs/adr/ADR-0027-pi-ledger-capture-through-one-shared-minting-rule.md`
- this plan

## Validation

- `npm run typecheck` (engine) and `tsc --noEmit --noUnusedLocals --noUnusedParameters`: nothing in `src/` or `tests/`
- the covering suites: `extract-evidence`, `improvement-proof`, `extract-shell-write-targets`, `changed-files`,
  `shell-normalize`, `i6-settlement.matrix`, `git-spawn-seam-guard`, the linter suites
- `npm run verify` (root)
