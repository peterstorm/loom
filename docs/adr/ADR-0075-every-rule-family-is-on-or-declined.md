# ADR-0075: Every rule family is on or declined

## Status
Accepted (2026-11-14).

## Context
Four of the linter's rule families check nothing until a project configures them: import boundaries
(`boundaries`), the functional core (`pureModules`), governance (`requireGovernance`) and doc references
(`docReferences`). Leaving one out was silent. A project could run `lint-project` clean for months with
three of the four families off, and nobody would know the rules existed. The old `--init` wrote
`"boundaries": []`, which reads as configured and checks nothing.

A repository with no rules directory at all got only the shipped rules, also silently. The operator who
wants maximum linting on every project has to remember, in every repository, to turn it on.

## Options Considered

1. **Turn every family on by default.**
   - Cons: boundaries and purity roots are a project's architecture. A default would be wrong in most
     repositories, and blocking edits in one the user does not own is worse than checking nothing.

2. **Write a config into every repository a session opens.**
   - Cons: it changes repositories without being asked, including ones the user does not own.

3. **Make coverage an explicit decision, and remind until it is made (chosen).**

## Decision
**Every opt-in family of a set-up project is configured, or declined with its reason. A family that is
neither is a coverage gap, and a gap fails the full tier.**

- **Coverage** (`linter/lint-coverage.ts`, pure). A family is configured when its key turns it on; an empty
  `boundaries` or `pureModules` list checks nothing and does not count. A family is declined by an entry in
  `config.json`'s `declined` list: `[{ "key": "<family>", "reason": "<why>" }]`. The loader
  (`linter/programmatic/config.ts`) refuses a key both configured and declined, a key declined twice and a
  decline without a reason.
- **`lint-project`** (`scripts/lint-project.ts`) fails a full-tier run on each gap, naming the family, what
  it checks and both ways to decide it. The JSON output carries them as `coverageGaps`. A project with no rules
  directory is not failed: it prints a notice, because it never asked for Loom's linter.
- **`lint-project --init`** turns every family on that the layout allows (`linter/starter-config.ts`, pure):
  - the conventional functional-core roots;
  - the layered TypeScript boundaries of `typescript-patterns.md`, each layer allowing exactly what it
    imports today and denying the layers its arrows must not reach;
  - governance of src/ when the boundaries cover every source file there;
  - doc references over the project's documents and plans.

  It fills only gaps, so a re-run never changes a decision, then baselines the debt the baselined rules
  already flag. A deny an import already breaks is left out and reported, since boundary violations are not
  baselined. A family it cannot infer is listed for a decision.
- **The session reminder.** At each session start (Claude Code's SessionStart hook,
  `hooks/scripts/lint-coverage.sh` → `handlers/session-start/lint-coverage.ts`; Pi's session start,
  `pi/lint-coverage.ts`), a project with no setup or with gaps is named to the model, which offers to run
  `--init`, and to the user. The reminder never blocks a session and writes nothing to the repository.
- **The personal ignore list.** A repository the user does not want Loom in is silenced by
  `helper lint-coverage ignore --reason "<why>"` (`handlers/helpers/lint-coverage.ts`). The list lives in
  the user's config directory, outside every repository (`core/lint-coverage-ignore.ts`,
  `handlers/lint-coverage-shell.ts`); `LOOM_LINT_COVERAGE_IGNORE` names another file. A list that does
  not parse is reported, never read as "ignore everything".

## Consequences

- A project cannot forget a rule family: it is on, declined in writing, or the run fails.
- Every session in an unconfigured repository says so until the user acts, and acting takes one command.
- Declining is cheap and visible in review: one line with its reason in `config.json`.
- An existing set-up project that leaves a family out fails its next full run until it declines or
  configures it. Loom's own config configures all four.
