# PR #174 remediation: one meaning of "configured", typed ignore entries, a pure session reminder

- **Branch:** `fix/lint-hook-project-root`
- **Scope:** `all`. The frozen diff covers the 36 files of commit `945238d0` (lineage source of
  `run.pr174-review-20261114`): the lint-coverage core, shell, helper and hooks, the edit hooks' project
  lookup, `lint-project --init`, the Pi twin, and ADR-0075 with its operations, architecture, development and
  runner docs.
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr174-review-20261114`, result digest
  `75b6926e…6e4c`. All seven reviewers ran.
- **Policy run:** `.claude/reviews/review-and-fix-runs/run.pr174-policy-20261114`, disposition digest
  `4441b353…836cd`, receipt `standalone-disposition-published`.

## Engine counts (inspection)

- Emitted and admitted: 0 critical, 24 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 24 advisory. No Refutation Panel ran.

## Surviving criticals

None, so there are no Declared Repair Groups or Historical RED declarations. Remediation starts with
`defectFamily: {"kind":"not-required"}`.

## Refuted findings

None.

## Advisory dispositions (DECLARED; published in the policy run)

| Finding | Decision | Reason |
| --- | --- | --- |
| code-reviewer-1 | accepted | `parseOptionalDeclined` tested `obj[key] !== undefined` while coverage treats an empty list as off, so the gap line's advice to decline was refused. The parser now reads the same on/off test. |
| silent-failure-hunter-1 | accepted | `--json` had no field for the no-setup state. The report gains `coverage`. |
| silent-failure-hunter-2 | accepted | `writeCoverageIgnoreList` threw raw and left its staged file. It returns a typed failure, removes the staged file, and the helper reports it. |
| pr-test-analyzer-1 | accepted | Same root cause as code-reviewer-1; the fix lands with a test for an empty list plus a decline. |
| pr-test-analyzer-2 | accepted | The Pi `session_start` / `before_agent_start` wiring and the post-edit lookup had no test. The wiring is extracted and tested; the lookup is `editedFileRulesDir`, tested on the filesystem. |
| pr-test-analyzer-3 | accepted | `helper lint-coverage status` refused-config and unreadable-list branches, and ignore/unignore on a broken list, were untested. Tests added. |
| pr-test-analyzer-4 | accepted | The both-layouts refusal before `--init` had no test. One added. |
| pr-test-analyzer-5 | accepted | `lint-coverage.sh` fail-open and the `hooks.json` SessionStart registration were untested. Tests added. |
| type-design-analyzer-1 | accepted | `withIgnored` took raw strings. A smart constructor, shared by the parser and `withIgnored`, is the only way to build an entry. |
| type-design-analyzer-2 | accepted | `inferStarterConfig` took a stored and a parsed form that could disagree. It takes one branded `StoredConfig`, minted only by `parseStoredConfig`. |
| type-design-analyzer-3 | accepted | `IgnoreListRead` duplicated `IgnoreListParse`. The core type is reused. |
| comment-analyzer-1 | accepted | The Pi comment contradicted the post-edit lint change in the same diff. Rewritten. |
| comment-analyzer-2 | accepted | A paragraph split `lint-project.ts`'s options list. Moved below the list. |
| comment-analyzer-3 | accepted | The ADR and `operations.md` said "every session start" while Claude Code registers `startup\|clear` only. Wording corrected. |
| comment-analyzer-4 | accepted | The IS_ON comment overgeneralised the empty-list rule. Narrowed. |
| comment-analyzer-5 | accepted | A garbled test comment. Reworded. |
| architecture-tech-lead-1 | accepted | The reminder's precedence and wording lived in the shell. It moves into a pure `sessionReminder` that the shell feeds. |
| architecture-tech-lead-2 | accepted | Same as type-design-analyzer-2; one fix. |
| architecture-tech-lead-3 | accepted | Project-discovery glue was repeated across callers, and `findProjectRoot` lived in the config parser. One shell resolver (`projectAt`), and discovery moves to its own module. |
| code-simplifier-1 | accepted | Same as type-design-analyzer-3; one fix. |
| code-simplifier-2 | accepted | A pass-through lambda. `withoutIgnored` is passed directly. |
| code-simplifier-3 | accepted | A string sentinel with two filters. The smart constructor returns a result union and the parse stops at the first refusal. |
| code-simplifier-4 | accepted | Three passes over the gaps. Partitioned once. |
| code-simplifier-5 | accepted | The coverage-check failure note was written in both harnesses. One shared function. |

## Accepted fixes

1. **One meaning of "configured"** (`engine/src/linter/programmatic/config.ts`): `isFamilyOn` is the one
   on/off test; `parseOptionalDeclined` judges a decline against the parsed families, so an empty
   `boundaries` / `pureModules` list may be declined. `linter/lint-coverage.ts` reads the same function.
2. **Typed ignore entries** (`engine/src/core/lint-coverage-ignore.ts`): branded `IgnoredProject`, the smart
   constructor `ignoredProject` returning `IgnoredProjectParse`, `describeIgnoredProjectError`, a parse that
   returns the first refusal, `withIgnored` taking an `IgnoredProject`.
3. **Shell failures said** (`engine/src/handlers/lint-coverage-shell.ts`, `handlers/helpers/lint-coverage.ts`):
   `IgnoreListWrite`; a failed write removes its staged file and the helper reports it.
4. **Pure session reminder** (`engine/src/linter/lint-coverage.ts`): `ProjectCoverage`,
   `sessionReminder`, `messageOf`, `coverageCheckFailedNote`; the shell and both harnesses feed it.
5. **One project lookup** (`engine/src/linter/project-root.ts`, new; `engine/src/config.ts`): `findProjectRoot`
   moves out of the config parser; `projectAt` and `editedFileRulesDir` are the shell's resolvers, used by
   the Claude Code edit hook, Pi's post-edit lint and the coverage shell. The linter boundary in
   `.claude/linter/rules/config.json` grants the two new imports with reasons.
6. **Pi wiring** (`pi/lint-coverage.ts`, `pi/extension.ts`): `registerPiLintCoverage` owns the two handlers
   and is tested on a fake Pi.
7. **`--init` and `--json`** (`engine/src/linter/starter-config.ts`, `scripts/lint-project.ts`): `StoredConfig`
   and `parseStoredConfig`; a single partition of the gaps; a malformed config exits 2 by name; the JSON
   report gains `coverage`.
8. **Tests:** every advisory above has a test; `tests/linter/programmatic/project-root.test.ts` moves to
   `tests/linter/project-root.test.ts` beside its module and gains `projectAt` / `editedFileRulesDir` cases.
9. **Docs:** ADR-0075, `docs/operations.md`, `skills/lint-project/references/runner.md`, `lint-rules/README.md`.
10. **Distill (apply mode):** one move. `parseEntry` states its wrong-type refusals through
    `describeIgnoredProjectError`, so each error kind has one wording.

## Deviation

type-design-analyzer-2's disposition said "take the stored document only and parse inside". The fix keeps
the parse at the shell (`lint-project` already parses to refuse a malformed config with exit 2) and passes
the pair as one branded `StoredConfig`, minted only by `parseStoredConfig`. The invariant the finding asked
for holds: the document and its parse cannot disagree.

## Validation

- `npm --prefix engine run typecheck`
- `npm --prefix engine exec -- vitest run tests/core/lint-coverage-ignore.test.ts tests/linter tests/handlers/session-start/lint-coverage.test.ts tests/pi/lint-coverage.test.ts`
- `bun scripts/lint-project.ts`
- `npm run verify` at the repo root. Four tests fail on this host because of
  `~/.pi/agent/model-routing.json` (`tests/handlers/helpers/orchestration.test.ts`,
  `tests/pi-extension-review-events.test.ts` ×2, `tests/pi/interactive-subagent.test.ts`), and the smoke
  stage's façade smoke for the same reason. None touches this change.

## Remediation

- Fresh run `run.pr174-remediation-20261114`.
- `supportPaths`: this plan, `engine/src/linter/project-root.ts` and `engine/tests/linter/project-root.test.ts`.
  Every other changed path is inside the reviewed scope.
