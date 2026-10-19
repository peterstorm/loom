# PR #112 remediation: the skew check observes exactly what the linter loads

- **Branch:** `fix/issue-57-lint-runtime-skew` (base `main`). The PR closes the last open piece of #57 (D6).
- **Scope:** the PR's 7 files (`kind: all`), one registered review run.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261019-pr112`
  (`result.json` digest `22edf99a49a1f3ecad69f1b28217586339e96961e25a5a36273842de066cd8b0`)
- **Counts (inspection renderer):** 0 critical and 5 advisory emitted and admitted. After refutation: 0 critical
  surviving, 0 refuted, 5 advisory. 7 slots issued, 7 captured.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261019-pr112`, revision
  `initial`, `disposition.json` sha256 `5120b4d48358af5f8d91f57f0db82cbeaea37f46103ec095508c7e0b7084444c`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| comment-analyzer-1 | accepted | The test title said the skew note is appended, but `withRuntimeSkewNote` leads the refusal with it. |
| comment-analyzer-2 | accepted | This was more than wording. The loader reads `lint-rules/*.json` with `readFileSync`, which follows symlinks, and programmatic rules are imported modules, which follow them too. Skipping symlinks could hide skew. Fixed with architecture-tech-lead-1. |
| architecture-tech-lead-1 | accepted | Which files are rule code was restated in the lint shell instead of beside the loader, so a new rule location would silently under-report skew. It now lives in the linter package, and both the loader and the observer use it. |
| code-simplifier-1 | accepted | `LINT_RUNTIME_ROOT` was exported with no importer. |
| code-simplifier-2 | accepted | Two hand-written ENOENT blocks expressed one rule. Resolved by the move: one `unlessAbsent` helper in the rule-source module. |

## Accepted fixes

- `engine/src/linter/rule-sources.ts` (new) is the single definition of rule code:
  - `isDeclarativeRuleFile` (top-level `*.json`, except the reserved `config.json`);
  - `DECLARATIVE_RULES_DIRECTORY` and `PROGRAMMATIC_RULES_DIRECTORY`;
  - `lintRuleSourceFiles(root)`, which follows symlinks as the loader and imports do, visits each real directory
    once, and is `null` for a non-Loom repository.
- `engine/src/linter/loader.ts`: filters declarative rule files with `isDeclarativeRuleFile`, the same predicate
  the observer uses.
- `engine/src/handlers/helpers/lint-wave-gate.ts`:
  - `observeLintRuleDigests` digests exactly `lintRuleSourceFiles(root)`;
  - the local tree list, the extension filter and the duplicated ENOENT handling are gone;
  - `LINT_RUNTIME_ROOT` is no longer exported.
- `engine/tests/handlers/helpers/lint-wave-gate.test.ts`:
  - the observer test now pins that symlinked rules count, through their target;
  - it also pins that nested `lint-rules/` files and `config.json` do not;
  - the misnamed test is retitled "leads … with the skew note".

## Support paths (outside the frozen scope)

- this plan
- `engine/src/linter/rule-sources.ts`
- `engine/src/linter/loader.ts`

## Validation

- `bun scripts/typecheck.ts`: clean
- focused: `lint-wave-gate`, `wave-completion-suite`, `lint-runtime-skew` and `tests/linter` (21 files, 1,095 passed)
- `npm run verify` (root): exit 0, 541 files, 13,301 tests passed (1 skipped)
