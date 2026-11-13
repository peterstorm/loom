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

The source run's code-reviewer raised, on a first attempt the engine rejected for incomplete read coverage, that a directory pattern matches anywhere in an absolute path, so `apps/` also matches a checkout at `/home/u/apps/project/`. Its admitted second attempt reported nothing, so this is not a Finding and is not fixed here. It is real as far as the code reads: the matcher is given no project root.

## Validation (my runs, not remediation evidence)

- `npm run typecheck`, `npm run lint`, `scripts/stamp-wire-contract.ts --check`
- `vitest run tests/linter tests/security/security-sandbox.test.ts tests/wire-contract.test.ts tests/core/reviewer-protocol.test.ts tests/docs`

## Remediation

Registered remediation against `run.pr167-src-review-20261113` with `defectFamily: not-required`; the test files and this plan are support paths.
