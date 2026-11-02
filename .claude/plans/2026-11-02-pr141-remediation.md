# PR 141 remediation: close #50 (set-phase execute guard, unpopulated-execute status)

Branch `fix/issue-50-execute-guard`, reviewed head `0229c18f`. The frozen diff (9 files, about 21 KB) fits one reviewer's budget, so one registered run reviewed it.

| Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|
| `review-fix-20261102T121938Z-0229c18f` | 0 critical, 4 advisory | 0 surviving, 0 refuted | `pr141-policy-bc425fdb` | `8253bcc3` |

All 7 reviewers were captured on attempt 1. There is no surviving or refuted critical. So there is no Declared Repair Group, no Historical RED and no selected check, and the remediation start declares `defectFamily: not-required`.

The advisory dispositions are `DECLARED` and published as the initial P5 revision. The policy run's `artifacts/disposition.json` holds the exact reasons.

## Advisories (4: 2 accepted, 2 dismissed)

- **comment-analyzer-1 (accepted):** `commands/loom.md` said the loop-back "can return to any earlier Phase". `parseSetPhaseArgs` accepts every Phase except `execute` and never compares against `current_phase`.
  - Fix: reworded to "it accepts any Phase except `execute`".
- **code-simplifier-1 (accepted):** the property "never writes execute: no parsed request can name it" was a third proof of one fact. The refusal property already covers every execute argument shape, and the type excludes execute.
  - Fix: deleted it.
- **architecture-tech-lead-1 (dismissed):** the three checks guard different facts.
  - The parse-time compare is the one runtime check that produces the `LoopBackPhase` narrowing.
  - The status check reports legacy graphs already stranded on disk.
  - No predicate is duplicated, and the reviewer itself marks it not needed now.
- **code-simplifier-2 (dismissed):** parsing each flag through `isPhase` inside the loop would need a third present-but-invalid state per flag. That state is required to keep the phase-first error precedence the tests pin, so the change adds more than it removes. The reviewer calls it taste-level.

## Validation

- Targeted vitest: `tests/core/set-phase.test.ts`, `tests/handlers/helpers/set-phase.test.ts`, `tests/core/unpopulated-execute-status.test.ts` (21 passed).
- Engine typecheck: clean.
- Root `npm run verify`: exit 0 (596 files; 14,639 passed, 1 skipped; all smokes pass).
- Registered remediation: one schema-v2 run against the review run with `defectFamily: not-required`. Its `supportPaths` name this plan.
