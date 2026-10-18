# PR #110 remediation: the persistent tally derives its own bar

- **Branch:** `refactor/issue-19-residue` (base `main`)
- **Scope:** the PR diff exceeds the 240k-unit review budget, so it was reviewed as file slices:
  - `review-fix-20261018-pr110-s1` (5 files): `result.json` digest
    `bb50d17d4ba64fdd81010d0ca946783b5d51dbaeb87fe206dbe3373d1f507687`. 0 critical, 0 refuted, 0 advisory.
  - `review-fix-20261018-pr110-s2`: abandoned, superseded by `-s2b`. A reviewer cited a doc outside the frozen
    slice, which terminal-blocks the run, so the slice was re-cut to include those docs.
  - `review-fix-20261018-pr110-s2b` (21 files): `result.json` digest
    `0c4a3c6f7e6f67145ee1e4235c09fe2318c79f4266f23dcf24765a20fd0728db`. 0 critical, 0 refuted, 5 advisory.
  - `review-fix-20261018-pr110-s3` (20 files): `result.json` digest
    `acc4c8d381691d4bafc0fab0b12e0b81f00608e66fc8285464996da572780c79`. 0 critical, 0 refuted, 6 advisory.
- **Advisory policy publications (DECLARED, revision `initial`):**
  - `disposition-20261018-pr110-s3`: `disposition.json` sha256
    `45f108b3cb8207b88b45522ec2817ad6d29f23b5020b83e670bbd571d1ff2cd2`
  - `disposition-20261018-pr110-s2b`: `disposition.json` sha256
    `73e893a8bbb2e464f0a2a4d4013e60941990544e91f1887d751e9a570797b15f`
- **Remediations (one per slice with accepted advisories):**
  - `remediation-20261018-pr110-s3` against `-s3`: installed, verified index
    `be74ec850f990307d362affa87a861f22fde6766b2d27903fcc4e0af27737d9b`, committed as `86eeba44`.
  - `remediation-20261018-pr110-s2b` against `-s2b`: installs the s2b fixes below.

## Surviving / refuted criticals

None in any slice. Defect-family accounting: `{"kind":"not-required"}`.

## s3 advisory dispositions

| ID | Decision | Reason |
| --- | --- | --- |
| silent-failure-hunter-1 | dismissed | The stricter lineage parse is the intended single-rule change and fails loudly (`invalid-history`), pinned by a test. All 207 persisted threshold records were scanned before the change; none differs from the strict majority. ADR-0029 records the scan. |
| type-design-analyzer-1 | accepted | `tallyRefutationPanel` is module-private and its `requestedThreshold` has one legal value. Drop it so the bar is derived inside the tally. |
| comment-analyzer-1 | accepted | The review-panel helper comment named the deleted `thresholdError` "threshold floor" as `panelSizeConflict`'s sibling. |
| comment-analyzer-2 | accepted | `commands/loom.md` said the wave Refutation Panel is driven by the `review-panel` helper, contradicting the same runbook's lines 755/757. |
| architecture-tech-lead-1 | accepted (scoped) | `completePersistentRefutationPanel` loses its optional threshold and its three program callers stop threading one. `tallyRefutations` in `core/review-panel` keeps its explicit parameter: it is the pure k-of-n primitive, both callers pass the derived value, and its property tests range over thresholds. |
| code-simplifier-1 | accepted | Same defect as type-design-analyzer-1. A persisted decision with a raised threshold is still refused, because it no longer equals the deterministic tally. |

## Accepted s3 fixes

- `engine/src/core/persistent-panel.ts`:
  - `tallyRefutationPanel(authority, complete)` takes no threshold. The strict majority is its only bar.
  - `completePersistentRefutationPanel(state, resolver)` takes no threshold.
  - `refutation-tally-completed` replay no longer reads `decision.threshold` from the record. It re-derives the
    decision and requires `jsonEqual` with the persisted one. A raised persisted threshold fails as
    `invalid-aggregate` / "persisted decision does not equal the deterministic complete-roster tally".
- `engine/src/handlers/helpers/programs/wave-refutation.ts`, `standalone.ts`, `standalone-evidence.ts`:
  - the three program callers stop threading `preparation.threshold`;
  - the preparations stop returning it. `standalone-evidence` still freezes its standalone panel authority
    with the derived strict majority.
- `engine/src/handlers/helpers/review-panel.ts`: the dangling "threshold floor" reference is removed.
- `commands/loom.md`: the registered Wave Gate drives its Refutation Panel through the persistent program,
  never the parent.
- Tests:
  - `panel-program.test.ts`: the caller-threshold case is gone (it no longer compiles). The persisted
    raised-threshold case pins the new diagnostic.
  - fixtures/tests that passed `2` (`standalone-remediation-authority.ts`, `defect-family-accounting.test.ts`,
    `standalone-review.test.ts`) drop the argument.

## Support paths for the s3 remediation (outside the s3 frozen scope)

- this plan
- `engine/src/handlers/helpers/programs/wave-refutation.ts`
- `engine/src/handlers/helpers/programs/standalone.ts`
- `engine/src/handlers/helpers/programs/standalone-evidence.ts`
- `engine/tests/fixtures/standalone-remediation-authority.ts`
- `engine/tests/core/defect-family-accounting.test.ts`
- `engine/tests/core/standalone-review.test.ts`

## s2b advisory dispositions

| ID | Decision | Reason |
| --- | --- | --- |
| comment-analyzer-1 | accepted | `docs/deterministic-core.md`, `docs/operations.md` and the `run-inspection.ts` checkpoint-writer comment still described the deleted Fugue runtime and operation DAGs as live. |
| comment-analyzer-2 | accepted | ADR-0029 named `programs/legacy-panel.ts` without its `engine/src/handlers/helpers/` prefix. It also mixed `panelProgramCheckpoint` with the `refutationPanelCheckpoint` wrapper without saying one wraps the other. |
| architecture-tech-lead-1 | accepted | Deletion test: with the in-memory and file journals gone, `ProgramJournal` has one adapter (`RunDirHandle`) and no fake. Fold its operations into `RunDirHandle`, and keep `ProgramEventRecord` and its parser as the shared record contract. |
| architecture-tech-lead-2 | deferred | Removing or migrating the unused persistent architecture-panel program touches the kernel the live refutation panel shares. It needs its own deepen design session; ADR-0029 Consequences records it as the next decision. |
| code-simplifier-1 | accepted | ADR-0029 claims to amend ADR-0004 "What shipped", but that table and the hard-dependency consequence still listed the deleted runtime, DAGs and Fugue pin. |

## Accepted s2b fixes

- `engine/src/orchestration/program-journal.ts`:
  - keeps `PROGRAM_JOURNAL_SCHEMA_VERSION`, `ProgramEventRecord` and `parseProgramEventRecord`;
  - loses the `ProgramJournal` interface;
  - its header now describes the record contract alone.
- `engine/src/orchestration/run-directory-handle.ts`:
  - `RunDirHandle` no longer `extends ProgramJournal`;
  - it declares `writeCheckpoint` itself (previously inherited);
  - `appendEvent` carries the dedup-idempotency contract and the append→checkpoint crash-window rationale.
- `engine/src/core/run-inspection.ts`: the checkpoint-label comment says the panels' `data.state.stage`
  envelope is the removed Fugue codec's, carried only by pre-ADR-0029 Run Directories.
- `docs/deterministic-core.md`: internal programs persist through the Run Directory journal, not Fugue. Events
  and checkpoints are stored per Run Directory, and the narrow-capabilities section names the real adapters
  instead of operation DAGs. The user-project `AuthoredDag` and `fugue-generated-integrity` text is unchanged
  because that rule still exists.
- `docs/operations.md`: the source-tree line no longer lists a "Fugue runtime/DAGs".
- `docs/adr/ADR-0029-…md`:
  - the full `engine/src/handlers/helpers/programs/legacy-panel.ts` path;
  - one sentence that the refutation checkpoint functions wrap the kernel's generic ones;
  - "What stays" records the port fold.
- `docs/adr/ADR-0004-…md`: dated ADR-0029 removal notes on the "Fugue runtime" and "operation DAG" rows of
  "What shipped", and on the hard-dependency consequence.
- `docs/adr/ADR-0005-…md`, `docs/architecture.md`, `README.md`: they now name the record format and parser, not
  a "storage port".

## Support paths for the s2b remediation (outside the s2b frozen scope)

- this plan

## Validation

- s3:
  - `bun scripts/typecheck.ts` (project typecheck, unused-code gates included): clean
  - focused suites: `panel-program`, `persistent-panel-program`, `standalone-review`,
    `defect-family-accounting`, `runbook-contract` (213 passed)
  - `npm run verify` (root): exit 0
- s2b:
  - `bun scripts/typecheck.ts`: clean
  - focused suites: `tests/orchestration`, `run-inspection`, `runbook-contract` (556 passed, 1 skipped)
  - `npm run verify` (root): exit 0
