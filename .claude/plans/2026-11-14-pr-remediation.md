# PR #170 remediation — 2026-11-14

- **Branch:** `fix/exclusion-gaps-and-deferred-advisories` (PR #170)
- **Reviewed scope:** `all`, the whole branch against `main`: 80 files, one run (inside the 240,000-unit read budget).
- **Review run:** `run.pr170-review-20261114b` (result digest `56481268…`).
- **Superseded run:** `run.pr170-review-20261114` — the comment-analyzer spent both attempts (a `basis: null` schema slip, then a retry that read no diff page), so the run went terminal-blocked with nothing admitted. Abandoned with `--superseded-by run.pr170-review-20261114b`; it stays as evidence.
- **Policy publication:** `run.pr170-policy-20261114b` (disposition digest `6734a275…`), a correction of `run.pr170-policy-20261114` (`0eb35f75…`). The first revision's reasons for type-design-analyzer-5, comment-analyzer-4 and architecture-tech-lead-1 said a type-only import is no cycle; the full suite's `orchestration-contract-acyclic` test showed the project forbids type-only cycles too. The decisions are unchanged; the corrected reasons name the leaf module that resolves it.
- **Runs root:** `.claude/reviews/review-and-fix-runs/`

## Critical findings

None. The engine reports 0 emitted, 0 surviving and 0 refuted criticals, so the Refutation Panel did not run and no Declared Repair Group exists. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

19 advisories: 16 accepted, 1 deferred, 2 dismissed.

| Finding | Decision | Reason |
|---|---|---|
| code-reviewer-1 | accepted | `//x/` parsed to segments `//x/`; the property's witness was then absolute and unframed. Fixed at the source: an empty directory segment is refused. |
| pr-test-analyzer-1 | accepted | `./src/`, `../x/`, `src//infra/`, `src/./infra/` parsed to directories no resolved path holds. |
| pr-test-analyzer-2 | accepted | `installedLoomPackageRoot`'s throwing branch had no test. |
| pr-test-analyzer-3 | accepted | The stamping script's shell (drift tally, `--check` exit code, refusal) had no automated test. |
| type-design-analyzer-1 | accepted | `ExcludePattern` was structural; `max-function-lines` built suffix literals around the parse. |
| type-design-analyzer-2 | accepted | Same defect as pr-test-analyzer-1. |
| type-design-analyzer-3 | deferred | Owner ids are minted by `freshOwnerId` from Agent Catalog names, so no metacharacter reaches `auditNonce`; a branded `OwnerId` threads through the security-coverage ledger, which this branch does not change. |
| type-design-analyzer-4 | dismissed | `LoomCommands`' authority-carrying members (root, sandbox script) are branded with one minting point each; the fixtures spell commands by hand on purpose, as oracles. |
| type-design-analyzer-5 | accepted | The renderer's seam differed from its siblings. The project forbids even a type-only cycle, so the lens list moves to a leaf both modules import, and `renderLensSelection` takes `Pick<LoomCommands, "securityLens">`. |
| comment-analyzer-1 | accepted | With no project root a relative path is still project-relative; the docs said a directory pattern then excludes nothing. |
| comment-analyzer-2 | accepted | "would exclude nothing" was wrong: an empty suffix would match every path. |
| comment-analyzer-3 | accepted | Comments narrated the earlier state of the code. |
| comment-analyzer-4 | accepted | The comment justified the bare callback by an import cycle; with the lens list in a leaf, no cycle and no callback remain, and the comment goes. |
| architecture-tech-lead-1 | accepted | Same seam as type-design-analyzer-5. |
| architecture-tech-lead-2 | accepted | The list-level parse was written in `loader.ts` and `config.ts`. |
| code-simplifier-1 | accepted | Same duplication, plus the test helper. |
| code-simplifier-2 | accepted | `FramedPath` named one string two ways. |
| code-simplifier-3 | accepted | The root spelling was normalized twice in `baseline.ts`. |
| code-simplifier-4 | dismissed | `success`/`failure` freeze null-prototype records and bound `message` fields (`boundDiagnosticMessage`): production wire semantics that would truncate `MarkdownError` text. |

## Accepted fixes

- `engine/src/linter/exclude-pattern.ts`
  - `ExcludePattern` is branded; `parseExcludePattern` is the only minting step.
  - New refusal `impossible-segment`: a directory with an empty, `.` or `..` segment, or a suffix with one after its first segment.
  - New `parseExcludePatternList` (first refused entry, by index) and `describeExcludePatternListError`.
  - Refusal sentences and the module docblock say what each refused entry would have meant.
  - `FramedPath` holds one `path` field.
  - The `matchesAnyExcludePattern` doc names the relative-path case.
- `engine/src/linter/loader.ts`, `engine/src/linter/programmatic/config.ts`: both loaders call the list parser and keep only their own failure channel (throw, refuse).
- `engine/src/linter/programmatic/max-function-lines.ts`: the defaults go through the list parse; the options doc names the relative-path case.
- `engine/src/linter/executor.ts`: the `projectRoot` doc names the relative-path case.
- `engine/src/linter/programmatic/baseline.ts`: one private `rootSpelling`, shared by `projectRelative` and `spelledUnderRoot`.
- `engine/src/core/security-lenses.ts` (new leaf): `SECURITY_LENSES` and `SecurityLens`, imported by `loom-cli-command`, `security-lens-select` and the four suites that read the list.
- `engine/src/core/security-lens-select.ts`, `engine/src/handlers/helpers/security-audit.ts`: `renderLensSelection(commands: Pick<LoomCommands, "securityLens">, …)`.
- `lint-rules/README.md`: the `excludePatterns` row lists the four refusals and what each means.
- `engine/tests/support/markdown.ts`, `engine/tests/support/markdown.test.ts`, `engine/tests/linter/exclude-pattern.test.ts`: present-tense comments and titles.
- Tests
  - `engine/tests/linter/exclude-pattern.test.ts`: impossible-segment refusals and acceptances; the list parser; a second witness property over a path alphabet that spells slash runs.
  - `engine/tests/linter/{loader,programmatic/config}.test.ts`: a refused segment through each loader.
  - `engine/tests/linter/exclude-patterns.ts`: the test helper uses the list parser.
  - `engine/tests/utils/loom-package-root.test.ts` (new): the package root's refusals at import.
  - `engine/tests/stamp-wire-contract-script.test.ts` (new): `--check` on the repository, then a scratch tree for drift with no writes, a restoring run, and an unstampable file.

## Refuted findings

None.

## Validation (my runs, not remediation evidence)

- `npm run typecheck`, `npm run lint`, `bun scripts/stamp-wire-contract.ts --check`
- `npm run test:unit`
- A hand-built `ExcludePattern` literal fails to compile (`TS2322`, property `[parsedExcludePattern]` missing).

## Remediation

Registered remediation against `run.pr170-review-20261114b` with `defectFamily: not-required`. Support paths (outside the frozen scope): this plan, `engine/src/core/security-lenses.ts`, `engine/tests/utils/loom-package-root.test.ts`, `engine/tests/stamp-wire-contract-script.test.ts`, `engine/tests/security/security-lens-manifest.test.ts`.
