# PR #89 remediation (round 1)

- **Branch:** `feat/pre-freeze-advisories`, reviewed at `2c1b296d`
- **Scope:** `all`, the full branch diff against `main` (12 files)
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261014T150125Z-2c1b296d`
  - result digest `f1f34e5bdfe60f70f692beb284d2f1f454896503dee9e98f9036582ed5bb9be3`
- **Counts (engine inspection):** 0 critical and 5 advisories emitted and admitted; after refutation, 0 surviving criticals, 0 refuted, 5 advisories.

## Criticals

None survived; none were refuted. `defectFamily: {"kind":"not-required"}`.

## Advisory policy (published)

- **Policy run:** `.claude/reviews/review-and-fix-runs/policy-20261014T1510Z-pr89`
- **Revision:** initial
- **Disposition digest:** `959ed2b22b2dfde2b3608c54a43c8ca85e7b645bb619b6b6499cb07dd3cd0375`
- **Provenance:** DECLARED

All 5 advisories were accepted.

| ID | Fix |
| --- | --- |
| pr-test-analyzer-1 | A status case where the same graph's advisories are already approved, so the run is past the pause: no `acceptance-freeze-pending` reason. |
| type-design-analyzer-1 | `FreezeNoticeFinding.severity` is now `FindingSeverity`. `renderPendingFreezeAdvisories` takes a `NonEmpty` list, so a zero-advisory notice cannot be rendered. |
| architecture-tech-lead-1 | `nextActionReasons` returns each branch's own `NonEmpty` reason list. The advisory branch adds the freeze notice itself, so the stage check and the projection live in one place. |
| code-simplifier-1 | An early return narrows `file`, which removes the non-null assertion. |
| code-simplifier-2 | No mutable `freezeReasons` binding remains in `deriveNextAction`; this is the same change as architecture-tech-lead-1. |

## Support paths outside the review scope

- `.claude/plans/2026-10-14-pr89-remediation.md`

## Validation

`npm run verify`, run from the repository root.
