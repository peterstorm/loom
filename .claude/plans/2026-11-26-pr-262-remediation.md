# PR #262 remediation — multiline runner-call counting

- **Branch:** `fix/multiline-test-call-count` (PR peterstorm/loom#262)
- **Scope reviewed:** `engine/src/utils/git.ts`, `engine/tests/utils/git.test.ts`, `docs/feature-guard-map.md` (frozen branch diff, `kind: all`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/rf-262-review-1`
  (result digest `01e2fd4eae4f340bf88adc92461f5de1945da46976dd952c05612b262c6cbe00`)
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/rf-262-policy-1`
  (disposition digest `28c9e6b7f4491340949d526c2d7682e500e51c86fc156f43aa26a6a5823e81dd`)

## Surviving criticals

None (0 surviving, 0 refuted). Defect family: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | The shared awaiting-title path had no wrapped `test.each(...)(` case and no hunk-boundary case; both rows added. |
| type-design-analyzer-1 | accepted | The carry was not tied to diff position, so an open call could pair with a later hunk's first line. Added lines now record `followsAdded`; the carry crosses only that adjacency, held in a tagged `RunnerCallCarry` state. |
| architecture-tech-lead-1 | accepted | The carry moved into one pure step function, `stepTypeScriptRunnerCalls`, which owns every reset; `countNewTests` only dispatches per language. A path-keyed carry folded per line gives the structural file-boundary reset without regrouping lines by path. |
| code-simplifier-1 | accepted | The same step function replaces the three conditionals plus `else` with one named transition. |

## Accepted advisory fixes

- `engine/src/utils/git.ts`:
  - `AddedExecutableLine.followsAdded`, set by `executableAddedLines`: true only when the previous postimage line in the same entry and hunk was added. A context line, a hunk header or a new `diff --git` entry resets it. Removed lines are not in the postimage, so they neither break nor make adjacency.
  - `RunnerCallCarry` = `idle | awaiting-title(path)` and `stepTypeScriptRunnerCalls(carry, path, line)`, a pure step that returns `{calls, carry}`.
  - `countNewTests` folds that step over TypeScript test-source lines and resets the carry to `idle` for every other line.
- `engine/tests/utils/git.test.ts`:
  - A wrapped `test.each(rows)(` row.
  - No carry across a hunk header, or across an unchanged context line.
  - A carry over a removed line.
- `docs/feature-guard-map.md`: derived engine line counts, if `docs/facts.test.ts` requires them.

## Refuted findings

None.

## Validation commands (operator runs, not remediation evidence)

- `vitest run tests/utils/git.test.ts`: 76 passed.
- `vitest run tests/docs/facts.test.ts`: 6 passed.
- `bun scripts/typecheck.ts`: no diagnostics in the changed files. Every remaining diagnostic is a missing optional module in this worktree's borrowed `node_modules` (`java-parser`, `ts-pattern`, `@earendil-works/pi-*`).
- The full suite runs in CI on the pushed branch.
