# PR #167 remediation — 2026-11-13

- **Branch:** `chore/consolidate-163-165-166` (PR #167)
- **Reviewed scope:** code only, by operator choice. Two runs, because the code scope's frozen diff (306,644 units) exceeded the 240,000-unit read budget:
  - `run.pr167-src-review-20261113` — 26 source files and 61 renames (87 files)
  - `run.pr167-tests-review-20261113` — 40 files under `engine/tests/`
- **Not reviewed:** the 155 added or modified markdown files and the 256 deleted files of the PR. Nothing here covers them.
- **Runs root:** `.claude/reviews/review-and-fix-runs/`

## Critical findings

None. Both runs report 0 surviving and 0 refuted criticals (engine inspection), so the Refutation Panel did not run and no Declared Repair Group exists. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

Published as `run.pr167-src-policy-20261113` (disposition digest `b3537537…`) and `run.pr167-tests-policy-20261113` (`5d890cac…`).

### Source run (10)

| Finding | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | `max-function-lines` was rewired to the shared matcher with no directory-form case. |
| type-design-analyzer-1 | deferred | Branding `LoomPackageRoot` / `SandboxScript` changes six renderers, `derivePublication` and every caller; no wrong-root path exists today. |
| type-design-analyzer-2 | deferred | A parsed `ExcludePattern` union changes the `Rule` type; belongs with a rule-schema change. |
| comment-analyzer-1 | accepted | `engine/src/config.ts` defines no `REVIEW_AGENTS`; section 7 of the design note contradicted its own table. |
| architecture-tech-lead-1 | accepted | A relative path (`src/infra/Db.java`) was not excluded by `src/infra/`; the "ONE matcher" wording overclaimed. Delegating `matchesModulePath` / `isUnderEntry` is left out: different entry grammars. |
| architecture-tech-lead-2 | deferred | Moving all printed-command builders behind `loom-cli-command.ts` is a cross-module interface redesign. |
| architecture-tech-lead-3 | deferred | Moving stamp composition into `core/wire-contract.ts` restructures the script and its tests; the script fails loudly today. |
| code-simplifier-1 | accepted | Whitespace slip, `securityLensPath`. |
| code-simplifier-2 | accepted | Whitespace slip, `RegionBounds`. |
| code-simplifier-3 | dismissed | The two wrappers are exported names tests use; the reviewer calls removal a judgment call. |

### Tests run (9)

| Finding | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | `statusWordOf` read the file's first line when an ADR had no Status heading. |
| pr-test-analyzer-2 | deferred | Existing assertions catch the drift; only the failure message would improve. |
| architecture-tech-lead-1 | deferred | Locality only; the tests keep an oracle independent of the production renderer. |
| architecture-tech-lead-2 | deferred | A shared doc-table parser is a new test module across three suites. |
| code-simplifier-1 | accepted | Seven near-identical `sandboxCommand` literals with spacing slips. |
| code-simplifier-2 | deferred | A shared `compactSchemaOf` spans four suites that extract from different renderings. |
| code-simplifier-3 | accepted | Stale byte counts in a comment. |
| code-simplifier-4 | accepted | Formatting slip, `const file =(`. |
| code-simplifier-5 | dismissed | Optional, predates the diff. |

## Accepted fixes

- `engine/src/linter/exclude-pattern.ts`: path and pattern are both anchored by a leading slash, so a relative path is excluded as its absolute spelling is; header comment states what the matcher covers.
- `engine/src/core/security-lens-select.ts`, `engine/src/core/wire-contract.ts`: whitespace.
- `docs/design-functional-evaluator.md`: section 7 names `AGENT_CATALOG`.
- `engine/tests/linter/exclude-pattern.test.ts`, `engine/tests/linter/programmatic/max-function-lines.test.ts`: relative-path and directory-form cases.
- `engine/tests/docs/adr-index.test.ts`: a missing Status heading yields no status word.
- `engine/tests/security/security-sandbox.test.ts`: local `sandboxArgs` helper; assertions unchanged.
- `engine/tests/core/reviewer-protocol.test.ts`, `engine/tests/wire-contract.test.ts`: comment and spacing.

## Outside the admitted findings

The source run's code-reviewer raised, on a first attempt the engine rejected for incomplete read coverage, that a directory pattern matches anywhere in an absolute path, so `apps/` also matches a checkout at `/home/u/apps/project/`. Its admitted second attempt reported nothing, so this is not a Finding and no remediation evidence covers it.

Fixed afterwards at the operator's request, outside the review run: `matchesAnyExcludePattern` takes the project root and compares the project-relative path (`projectRelative`). `lintFile` / `lintFiles` derive the root from the project rules directory (`projectRootOf`) and pass it through `executeRules`; `max-function-lines` receives it from `createProgrammaticRules`. With no project root, or for a file outside it, the path is compared as given. Covered by `engine/tests/linter/{exclude-pattern,executor,index}.test.ts` and `programmatic/max-function-lines.test.ts`; the `lintFile` cases fail against the unfixed source.

## Validation (my runs, not remediation evidence)

- `npm run typecheck`, `npm run lint`, `scripts/stamp-wire-contract.ts --check`
- `vitest run tests/linter tests/security/security-sandbox.test.ts tests/wire-contract.test.ts tests/core/reviewer-protocol.test.ts tests/docs`

## Remediation

Registered remediation against `run.pr167-src-review-20261113` with `defectFamily: not-required`; the test files and this plan are support paths.

## Follow-up — branch `fix/exclusion-gaps-and-deferred-advisories`

Done after PR #167 merged, at the operator's request. None of it is remediation evidence for the runs above.

### Exclusion gaps closed

- A directory pattern is matched only against a path known to be inside the project. With no project root, or for a file outside it, it excludes nothing and the rule reads the file. A suffix pattern matches wherever the file is.
- `lintFile` / `lintFiles` spell a file beneath the project root when the file and the rules directory reach one checkout through different symlinks (`spelledUnderRoot`), so exclusions, baselines and module scopes apply. A violation then reports the path beneath the root.

### Deferred advisories, now done

| Finding | What changed |
|---|---|
| src type-design-analyzer-2 | `ExcludePattern` is a parsed `suffix` / `directory` union, built where the rule or config loads. An empty entry, a bare `/` and a glob are refused by name; backslashes are normalized. |
| src type-design-analyzer-1 | `LoomPackageRoot` and `SandboxScript` are branded; `parseLoomPackageRoot` and `loomCommands` are the only minting points. |
| src architecture-tech-lead-2 | `loomCommands(root)` in `core/loom-cli-command.ts` owns every printed spelling. `taskMutationCommand`, `renderNonceCommand`, `renderVerificationImport`, `sandboxScriptPath` and `securityLensPath` are deleted; handlers use `LOOM_COMMANDS`. |
| src architecture-tech-lead-3 | `stampsFor` and `applyStamps` live in `core/wire-contract.ts`; `scripts/stamp-wire-contract.ts` is the shell. Output and exit codes compared equal to the old script on six trees. |
| tests architecture-tech-lead-1 | `PACKAGE_CLI` / `PRINTED_HELPER` in `tests/handlers/security-audit-harness.ts`, hand-spelled, used by the three suites. |
| tests architecture-tech-lead-2, pr-test-analyzer-2 | `tests/support/markdown.ts`: tables by column name, sections by heading, explicit not-found results. A template is declared only by its row in the table with a `Variables` column. |
| tests code-simplifier-2 | `tests/support/compact-schema.ts`, used by the four schema suites. |

### Behaviour changes to know about

- A rule file or `config.json` holding an empty exclusion entry, a bare `/` or a `*` now fails to load.
- A directory exclusion no longer applies to a file outside the project, or in a run whose rules directory is in neither layout.
- A Loom package installed at a path holding a control character, or not starting with `/`, stops at import.

### Not done

- The local Bun (1.4.4) still differs from `.bun-version` (1.4.2); `tests/verification-command.test.ts` fails locally for that reason only.
- Smoke tests were not run. The markdown and deleted files of PR #167 remain unreviewed.
