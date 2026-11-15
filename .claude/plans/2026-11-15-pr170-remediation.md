# PR #170 post-merge remediation: review-and-fix

**Created:** 2026-11-15
**Branch:** `fix/pr170-review-advisories` (base `main` at `ce407816`)
**Reviewed change:** PR #170 (`fix/exclusion-gaps-and-deferred-advisories`, merged as `1c750440`), reviewed after the merge.
**Status:** Implemented; installed through the two registered remediations named below.

## Scope and review runs

PR #170 merged before a registered review ran over it (see `.claude/plans/2026-11-13-pr-remediation.md`,
"Not done when written"). It was reviewed post-merge in two explicit slices of the files it changed:

| Run | Slice | Reviewers | Findings |
|---|---|---|---|
| `run.pm170-src-review-20261115` | source, docs and scripts (34 files) | code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier | 10 advisory, 0 critical |
| `run.pm170-tests-review-20261115` | `engine/tests/` (49 files) | code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-tech-lead, code-simplifier | 9 advisory, 0 critical |

Result digests: source `064f024d510d3c01f9c98a19517114cf48e8a5d87e16714ef2c3c4357f5c1f9c`, tests
`ce2e81ec407116d54744b447228acbdae56488a34adc4621e47af89958a2f0ee`.

**Surviving criticals:** none. **Refuted criticals:** none. Both remediations therefore declare
`defectFamily: not-required`.

## Advisory decisions (DECLARED, published)

Published by `run.pm170-src-policy-20261115` (disposition digest
`30f7042abc0bd74681b59755a3b118d3ac846d56381693e958c5e2b57c70ebcc`) and `run.pm170-tests-policy-20261115`
(disposition digest `9129ab8967522acc918dcca0b2fab3e4839c9c6fe513b625c0f63e7727583506`). Each record's reasons
are the authority; they are summarized here.

### Source slice: 7 accepted, 1 deferred, 2 dismissed

| Advisory | Where | Decision | Reason |
|---|---|---|---|
| architecture-tech-lead-1 | `engine/src/linter/index.ts:67` | accepted | `pathInProjectFrame` and `framed` each spelled the frame rule as `isAbsolutePath(projectRelative(…))`; one predicate states it once. |
| architecture-tech-lead-2 | `engine/src/core/loom-cli-command.ts:78` | accepted | Each renderer takes only the spelling it reads, as `renderLensSelection` already did. |
| code-simplifier-1 | `engine/src/linter/loader.ts:334` | accepted | Three loaders repeated parse-then-throw; one helper keeps the wording identical. |
| comment-analyzer-1 | `.claude/plans/2026-11-13-pr-remediation.md:103` | accepted | The "Not done" list stated a pre-merge fact as current. |
| comment-analyzer-2 | `.claude/plans/2026-11-14-pr-remediation.md:66` | accepted | "result in the final report" pointed at a transient report. |
| comment-analyzer-3 | `docs/development.md:144` | accepted | "it" was ambiguous between the helper and the lookup. |
| pr-test-analyzer-1 | `pi/extension.ts:655` | accepted | Nothing drove Pi's post-edit lint, so reverting it to the session root's rules passed the suite. |
| type-design-analyzer-1 | `engine/src/linter/programmatic/config.ts:83` | deferred | A per-family Configured/Declined/Unset ADT is an interface change read at about 80 sites. The one producer from disk refuses the combination today, so this belongs with a rule-schema change. |
| type-design-analyzer-2 | `engine/src/linter/exclude-pattern.ts:62` | dismissed | `DomainResult` lives in the orchestration kernel, which the linter's boundary does not allow it to import; the shapes are structurally identical. |
| code-simplifier-2 | `engine/src/core/wire-contract.ts:238` | dismissed | Taste at the margin: the reduce is correct and keeps the immutable accumulator. |

### Tests slice: 9 accepted

| Advisory | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `engine/tests/linter/exclude-pattern.test.ts:233` | accepted | The generated file sat directly in the root, so the property could not see a matcher reading above it. |
| code-reviewer-2 | `engine/tests/core/loom-cli-command.test.ts:172` | accepted | A point-free `map` passed index and array to `securityLens`. |
| pr-test-analyzer-1 | `engine/tests/handlers/security-audit-command-contract.test.ts:99` | accepted | `isOperationsTable` was only shown returning nothing, so the one-owner guard could pass vacuously. |
| pr-test-analyzer-2 | `engine/tests/support/compact-schema.test.ts:1` | accepted | No case reached `compactSchemaOf`'s markdown error arm. |
| pr-test-analyzer-3 | `engine/tests/docs/adr-index.test.ts:38` | accepted | `statedStatusOf`'s unreadable and no-word arms ran only on live ADRs. |
| type-design-analyzer-1 | `engine/tests/support/compact-schema.ts:22` | accepted | A brand minted only by `compactSchemaOf` makes the invariant hold for every suite that compares schemas. |
| architecture-tech-lead-1 | `engine/tests/stamp-wire-contract-script.test.ts:37` | accepted | The script's only seam was its file location, forcing copied trees and a subprocess per case. |
| code-simplifier-1 | `engine/tests/security/security-reports.test.ts:130` | accepted | `loomCommandsAt("/loom")` was rebuilt at every call site. |
| code-simplifier-2 | `engine/tests/core/loom-cli-command.test.ts:121` | accepted | The apostrophe-root literal pin restated the `AWKWARD` fixture's root. |

## Accepted fixes

- **One frame rule.** `inProjectFrame(filePath, projectRoot)` in `programmatic/baseline.ts` returns the
  project-relative path, or null for a path outside the root or any absolute path with no root.
  `spelledUnderRoot`, `pathInProjectFrame` (`linter/index.ts`), `framed` (`exclude-pattern.ts`) and, as a
  distill move, `relativeToProjectOrBoundaries` (`no-cross-boundary-imports.ts`) all read it.
  `isAbsolutePath` is now private to `baseline.ts`.
- **One parse-then-throw.** `parseExcludePatternListOrThrow(entries, key, prefix, refuse?)` in
  `exclude-pattern.ts`, used by `loader.ts`, `programmatic/config.ts` (with its own `ConfigError` channel) and
  the `max-function-lines` defaults.
- **Narrow command parameters.** `renderDispositionHandoff`, `renderVerificationStart` and the report input take
  `Pick<LoomCommands, "orchestrationStart">`. The implementation brief and `observeTaskMutation` take
  `Pick<LoomCommands, "mutationCheck">`.
- **One edit-hook lint for both harnesses.** `lintEditedFile(filePath, defaultRulesDir, base?)` in
  `handlers/post-tool-use/lint-file.ts`. The Claude Code hook and Pi's `tool_result` closure in
  `pi/extension.ts` both call it. `engine/tests/pi/post-edit-lint.test.ts` covers a nested project, the session
  project, and a source pin on the Pi closure.
- **Docs.** The 2026-11-13 plan's list is the status at the time it was written, with the runs that later
  covered it. The 2026-11-14 plan records the CI `verify` outcome on PR #173. `docs/development.md` names
  `editedFileRulesDir` and `lintEditedFile`.
- **Tests.**
  - `inProjectFrame` cases.
  - The exclusion property places the file in generated subdirectories, and `parseExcludePatternListOrThrow`
    has its own cases.
  - `isOperationsTable` has a positive case per arm and a negative case.
  - `CompactSchema` is branded, with a `@ts-expect-error` forgery case and an unclosed-fence case.
  - `statedStatusOf` and `indexRowOf` are pure over Markdown, with cases for:
    - no Status heading;
    - an empty Status section;
    - a non-letter Status line;
    - non-link ADR cells.
  - `scripts/stamp-wire-contract.ts` exports `runStamping(root, args)`. Its shell cases run in process, and
    two cases still run the script as CI does, pinning the `--check` exit code.
  - One `COMMANDS` per security suite, and the apostrophe pin folded into `AWKWARD`.

### Mutation checks

Each mutant was applied, the named suite run, and the source restored.

| Mutant | Killed by |
|---|---|
| `inProjectFrame` keeps an outside-root path | `project-frame.test.ts` (2 cases) |
| `lintEditedFile` reads `projectRulesDir(base)` | `post-edit-lint.test.ts`, nested-project case |
| Pi closure drops the session base | `post-edit-lint.test.ts`, source pin |
| `framed` matches the absolute path | `exclude-pattern.test.ts`, including the subdirectory property |
| `parseExcludePatternListOrThrow` ignores `refuse` | `exclude-pattern.test.ts`, custom channel case |
| Markdown scan drops an unclosed fence | `compact-schema.test.ts`, unclosed-fence case |
| `isOperationsTable` without the code-span arm, without the Operation arm, with any code span | one case each |
| `statedStatusOf` blind to a missing heading, any leading token, whole section, first raw line | one or more cases each |
| `indexRowOf` reads an unanchored link | both non-link cell cases |
| `runStamping` drift tally off by one; entry point drops the exit code; `--check` writes | in-process and CLI cases |

Two mutants survived the first draft of the tests and were closed before the run:
- The Operation-column arm survived because the first positive case also had a code-span first column.
- Reading the whole Status section survived because every inline case had only one line.

## Remediation

`run.pm170-src-remediation-20261115` installs from the source review and
`run.pm170-tests-remediation-20261115` from the tests review. Each names, as `supportPaths`, the changed
files outside its own review scope.

## Validation (OBSERVED by this session, not remediation evidence)

All on 2026-11-15, at the branch's final head, from `engine/`:

- `npm run typecheck`: clean.
- `npm run lint`: 1,761 files, no violations.
- `bun ../scripts/stamp-wire-contract.ts --check`: stamped regions match their sources.
- `env -u PI_CODING_AGENT npx vitest run`: 749 files, 19,288 passed, 2 skipped, 4 failed.
  - The 4 failures are environment failures, in `tests/handlers/helpers/orchestration.test.ts`,
    `tests/pi-extension-review-events.test.ts` (2) and `tests/pi/interactive-subagent.test.ts`.
  - They read the operator's `~/.pi/agent/model-routing.json`, whose `served` target has no exact model ref.
  - With `HOME` set to an empty directory, those three files pass: 291 tests.
- `npm run test:smoke`: passes with `HOME` set to an empty directory. Under the operator's home it stops at the
  orchestration façade smoke on the same routing config.

## Follow-up: consolidated review (supersedes PRs #175 and #176)

This branch was reviewed again, with PR #175's markdown fixes, before it merged as one PR.

- **Pi closure, made behavioural.** Pi's `tool_result` sets `projectRoot = process.cwd()`, which is
  `lintEditedFile`'s default base. So "Pi closure drops the session base" in the mutation table above is an
  equivalent mutant, and PR #176's "behaviour change" note describes no observable change. The source pin on
  `pi/extension.ts` is replaced by a case in `post-edit-lint.test.ts` that drives the real extension's
  `tool_result` handlers from a session directory. An edit in a nested project is refused under that
  project's rules, and an edit in the session's own project passes. A mutant that lints a session-root file
  in the Pi closure fails it.
- **No wire cast in that test.** The shipped rule file is narrowed with `isRecord`, not cast `as object`.
- **Stale purity comments.** `core/emission-ingestion.ts` and `core/legacy-panel-decisions.ts` named
  DEFAULT_PURE_MODULES, which ADR-0043's 2026-11-10 amendment says no longer exists. They now name the
  project's `pureModules`.
- **Java process wrapper** (`skills/security-expert/references/command-injection.md`). The polling loop called
  `Files.size` and `waitFor` with no cleanup, so an `IOException` or an interrupt left the process running.
  The loop now sits in `try`/`finally` with `destroyForcibly()`. The deadline is compared overflow-safely
  (`nanoTime() - deadline > 0`).
