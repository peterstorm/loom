# PR #191 remediation (review-and-fix)

- **Branch:** `feat/doc-reference-external-names` (peterstorm/loom#191)
- **Scope:** `kind: all`, the 18 files of the PR diff
- **Review run:** `.claude/reviews/review-and-fix-runs/loom191-review` (0 surviving, 0 refuted criticals; 12 advisories)
- **Policy publication:** `.claude/reviews/review-and-fix-runs/loom191-policy`

## Advisory dispositions (DECLARED)

| Finding | Decision | Change |
|---|---|---|
| silent-failure-hunter-1 | accepted | A governed file whose extraction fails withholds every "unreferenced" verdict, and the drift line names the unreadable file(s) |
| pr-test-analyzer-1 | accepted | Drift tests for a name referenced only from a governed source comment, and for an unclosed-fence file (governed and ungoverned) |
| type-design-analyzer-1 | accepted | `externalNameIndex` refuses a duplicate name as a Result; the config parse calls it |
| type-design-analyzer-2 / architecture-tech-lead-3 | accepted | `DocReferenceScope.externalNames` is the branded `ExternalNameIndex`, built once at the parse |
| type-design-analyzer-3 | dismissed | Plain brand is acceptable; `parseExternalName` is the only minting point |
| type-design-analyzer-4 | accepted | Group reason stored trimmed |
| comment-analyzer-1 | accepted | Property generator now produces dashed segments |
| architecture-tech-lead-1 | accepted | `resolveWordInSource` seam in `resolve.ts`, used by `resolveReference` and the decay check; dummy frame gone |
| architecture-tech-lead-2 / code-simplifier-2 | accepted | The engine owns governed-file selection and the nothing-to-judge short-circuit; the shell lists files and reads the ones the engine asks for |
| code-simplifier-1 | accepted | Shared `external-name-fixtures.ts` test helper |

Also added: a CLI test that `--no-baseline-check` skips external-name drift.

## Validation (operator runs, not remediation evidence)

- `bun scripts/typecheck.ts` (engine): clean
- `npm run lint` (engine): no violations
- `bun test engine/tests/linter`: 2153 pass, 3 fail. None of the three is caused by this change. `starter-config.test.ts › turns every family on…` fails alone on the unchanged base `cb653f98` too. `fsProjectSnapshot › broken repository` fails on the base. `executeRules — timeout` is timing-dependent; it failed on the base and passed here.
