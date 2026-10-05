# feat/grammar-constrained-decoding delta-review remediation

- **Branch:** `feat/grammar-constrained-decoding`, reviewed at `c87af014`.
- **Why a delta review:** whole-branch run `review-fix-20261005T192613Z-` (508 paths) produced 47.8 MB Context Packets. That exceeds the 16 MiB bound on lineage and remediation source reads, so `inspect --lineage` failed with `malformed-result-boundary`, the same failure as `raf-grammar-20261005T1` (see `2026-10-05-grammar-partitioned-remediation.md`). The branch up to `96603e4c` was already partition-reviewed and remediated in slices s1–s4. The oversized run is abandoned with `--superseded-by raf-grammar-20261005-delta-96603e4c`, and the operator chose a delta review instead of a fresh four-slice re-review. Its 5 advisories belong to the abandoned run and are not carried over.
- **Exact scope:** the 92 paths in `git diff --name-only 96603e4c..HEAD` (including the deleted `engine/tests/core/scope-classification-path.test.ts`), with kind `all`. That is 2.5 MB of source and 9.4 MB packets.
- **Review Run:** `.claude/reviews/review-and-fix-runs/raf-grammar-20261005-delta-96603e4c`, `result.json` sha256 `c865a89771008eae12d41116e76f4fd2fa859722f4bfc9c174bcae09f6f6d499`.
  - Emitted and admitted: 1 critical, 5 advisory.
  - After refutation: 1 surviving critical, 0 refuted, 5 advisory.

## Surviving critical — disposition

- **`pr-test-analyzer-1`** (`engine/tests/handlers/helpers/programs/legacy-panel.test.ts:94`): **repaired**, Declared Repair Group `group.each-table-row-shape`.
  - Panel vote: upheld by reproduction and intent, refuted by test-coverage. Strict majority, so it survives.
  - The refuting lens was right that vitest, the project runner, leaves a mixed table unspread, so the row asserted `[]` under `project:verify`. Under `bun test` the `[]` row spreads into zero arguments and the case times out.
  - Either way the test's meaning depended on the runner. Reproduced in this session: bun gave 19 pass / 1 fail (5000 ms timeout), vitest gave 20 / 20 pass.

### Declared Repair Group `group.each-table-row-shape` (DECLARED)

- **Root cause:** `.each` tables mixed array rows with non-array rows. Vitest spreads rows only when every row is an array, while bun (like Jest) spreads each array row. So a mixed table hands different inputs to the callback depending on the runner, and a bare `[]` row becomes bun's `done` callback.
- **Invariant:** no `.each` table under `engine/tests` mixes array-literal rows with other rows. Single-argument tables whose inputs include arrays are written as explicit one-element tuples (`it.each<[unknown]>([[null], [[]], ...])`). `engine/tests/test-table-rows.test.ts` enforces this as an AST scan.
- **Siblings:** found by an AST scan of every `engine/tests/**/*.ts`. All are **repaired**:
  - `engine/tests/state-manager-load-guards.test.ts:487` and `:493`: two bun timeouts, reproduced.
  - `engine/tests/core/reviewer-protocol.test.ts:130`: a bun failure, reproduced.
  - These lie outside the frozen scope and are registered as support paths.
- **Selected check:** `project:verify` (`npm run verify`, required report `.loom/completion-reports/verify.junit.xml`).
- **Historical RED (DECLARED):** I copied the new guard test unchanged into a detached worktree at the reviewed `HEAD` (`c87af014`) and ran it under vitest. It fails with 1 failed / 1 passed and lists exactly `tests/core/reviewer-protocol.test.ts:130`, `tests/handlers/helpers/programs/legacy-panel.test.ts:94`, `tests/state-manager-load-guards.test.ts:487` and `:493`. The reviewed test file itself passed under vitest and failed only under `bun test`.

## Advisory dispositions

These are published immutably as policy Run `raf-grammar-20261005-delta-96603e4c-policy`, revision `initial`, disposition digest `ba55043085265f9434316da7c6613b3b2aa9d77d76920e5d440b6f658f6f8228`. All are DECLARED.

| ID | Decision | Fix |
| --- | --- | --- |
| `type-design-analyzer-1` | accepted | The corpus check passed: all 35 distinct stored Finding ids across every run in the runs root conform to `parseFindingId`, and `attributeFindings` mints through it. Three fast-check properties in `standalone-lineage.test.ts` (seeds 5141–5143) pin that minted ids round-trip through `standaloneLineageInventorySchema` and that colon, whitespace and unsafe-suffix ids refuse. |
| `architecture-tech-lead-1` | accepted | The legacy panel's pure decisions move to `engine/src/core/legacy-panel-decisions.ts`, where the core boundary linter applies: no handler, orchestration or `node:` imports, with `createHash` replaced by `sha256Bytes`. `legacy-panel.ts` keeps only the Run Directory adapters (687 → ~140 lines). See the scope note after this table. |
| `architecture-tech-lead-2` | accepted, scoped | Guards that exactly match `isRecord` now reuse it: `parseRegisteredPanelProgram`, the `wave-gate.ts` checkpoint guard, and `review-authority-bridge.ts`'s local `isRecord`. The remediation-events and remediation-registration parsers are unchanged, because their own-data-descriptor and symbol checks and their "must contain exactly" wording are persisted and differ from `parseExactRecord`. |
| `code-simplifier-1` | accepted | `exactRecordErrors` (with a per-caller noun) and `toElementResult` now live in `plain-record.ts` and are used by completion-suite, verification-manifest and implementation-completion. Error text is byte-stable. Direct tests are in `plain-record.property.test.ts`. |
| `code-simplifier-2` | accepted | `RemediationFacadeAction` is now derived from `FacadeBlockedAction`/`FacadeBlockedDiagnostic` and `FacadeDoneAction`/`RemediationInstalledOutcome`. The change is type-only. |

**`architecture-tech-lead-1` scope note:** the new module is **not** enrolled in `DEFAULT_PURE_MODULES` or the machine-purity closure. Enrolling it would also mean enrolling `emission-ingestion`, `emission-tool`, `harness-capture` and `legacy-archive`, and widening the audited `zod/v4` grant to `emission-tool`. That conflicts with the documented rule that declared pure modules never import the emission modules. ADR-0018 already records that `emission-ingestion.ts` is not enrolled for the same reason, and ADR-0018 plus the `panel-verdict-source.ts` port docs are updated to name the adapter's new home.

## Refuted findings

None.

## Validation (development; not P3 evidence)

- `npm run verify` from the repository root: typecheck clean, vitest 380 files / 10776 passed / 1 skipped, and all smoke suites green.
- `bun test` on the four affected test files plus the guard: 302 pass / 0 fail.

## Remediation support paths

`.claude/plans/2026-10-05-grammar-delta-remediation.md`, `engine/src/core/legacy-panel-decisions.ts`, `engine/src/core/panel-verdict-source.ts`, `engine/src/handlers/helpers/programs/review-authority-bridge.ts`, `engine/tests/core/reviewer-protocol.test.ts`, `engine/tests/state-manager-load-guards.test.ts`, `engine/tests/test-table-rows.test.ts`.

## Follow-ups

- Not related to this branch's code: the loaded main runtime (`d83084b8`) still lacks this branch's `2cda3379` start guard. Until this branch merges, an oversized whole-branch standalone review is accepted at start and fails only at lineage or remediation.
