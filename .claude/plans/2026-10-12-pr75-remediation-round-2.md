# PR #75 remediation, round 2: amend a v2 Requirement trace in place

- **Branch:** `feat/amend-spec-trace` (PR #75)
- **Scope:** `all`, 21 frozen files at `51b942ee`. This includes the macOS CI fix to the guard leading-dot property oracle, committed before this round.
- **Review run:** `.claude/reviews/review-and-fix-runs/pr75-review-r2-20261012T111518Z`. The pr-test-analyzer and comment-analyzer first attempts failed schema admission; both were admitted on retry.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr75-policy-r2-20261012T113500Z`, revision `initial`, with disposition digest `0a0158778ff0fba68970d5f16b2c8ea2cae8f51d36af4c96e53579c49056c921`

## Adjudication

- Emitted and admitted: 0 critical, 10 advisory. The code-reviewer and silent-failure-hunter returned no findings.
- After refutation: 0 surviving critical, 0 refuted critical, 10 advisory.
- `defectFamily` is `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | The registry parity suites iterate whatever is registered, so nothing pinned this helper. A new registration test pins `KNOWN_HANDLERS.helper`, `WHITELISTED_HELPERS`, the Pi handshake route, and the guard allowing the helper invocation. |
| type-design-analyzer-1 | accepted (partly) | The load boundary now requires each Task's successive amendment changes to chain: a change starts, as sets, where the previous one ended. Changes are not tied to `wave_gate_history`, because an amended Wave later completes legitimately. `retiredRunId` has no retirement history to bind to. |
| comment-analyzer-1 | accepted | `docs/operations.md` now names the refusal of a legacy terminal registration and its migrate-first recovery. |
| comment-analyzer-2 | accepted | The residue comment no longer claims that proximity prevents drift. Each residue field has its own test row. |
| architecture-tech-lead-1 | accepted | `parseOwnershipInput`, `rosterError` and `OwnershipParse` moved to `core/spec-trace.ts`, with a required label. The upgrade module now imports them like the amendment does. |
| architecture-tech-lead-2 | accepted | One `retireWaveReviewAuthority(graph, wave)` owns the tombstone-versus-residue branch, the Wave roster and the reset. It throws on a live gate, which is the caller's precondition. |
| code-simplifier-1 | accepted | Same fix as architecture-tech-lead-2. |
| code-simplifier-2 | accepted | The precondition checks consume `amendedTraces`. The non-empty change list is built only at the audit. |
| code-simplifier-3 | accepted | One `traceOf` in `core/spec-trace.ts` serves the amendment core and the load boundary. |
| code-simplifier-4 | accepted | The helper suite builds its Tasks with `taskFixture`. |

## Also corrected

These come from findings in two first attempts the engine refused for schema reasons. They are not in the inventory, and are recorded here so the change is traceable.

- The plan no longer claims that an amended Task's hash keys are exactly its claims. A retained claim that never had a hash (for example, after a legacy upgrade) stays hashless, so the keys are a subset. The property test title says when equality holds.
- The `unchanged` outcome comment is reworded. The plan's stale `spec-trace-migration.ts:173-177` citation now names the symbol.

## Validation

- `npm run typecheck`, plus the amendment, registration and migration suites
- full `npm run verify`

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan.
