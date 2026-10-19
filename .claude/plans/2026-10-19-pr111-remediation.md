# PR #111 remediation: what the deletion left behind

- **Branch:** `refactor/delete-persistent-architecture-panel` (base `main`)
- **Scope:** the PR's 15 files (`kind: all`), one registered review run. The frozen diff (208 KB) fits one
  reviewer's budget, so the scope was not sliced.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261019-pr111`
  (`result.json` digest `c152e44a7ee9510ce6cd4d61dd6992c8046e854db78ad52ee8d778ba979d0e66`)
- **Counts (inspection renderer):** 0 critical and 10 advisory emitted and admitted. After refutation: 0 critical
  surviving, 0 refuted, 10 advisory. 7 slots issued, 7 captured.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261019-pr111`, revision
  `initial`, `disposition.json` sha256 `5acbb178718a8de7f94d3f9e5c27e8ed22819c42d9273dfbacc33ad9dc7a5eca`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| comment-analyzer-1 | accepted | The lens-disjointness comment claimed the pin holds wherever either vocabulary is parsed. It is a type-level assertion over two literal unions and constrains no parser. |
| comment-analyzer-2 | accepted | The `boundEntryForSlot` doc was edited by deletion into broken wrapping. Fixed with code-simplifier-2. |
| comment-analyzer-3 | accepted | The catch comment in `parseCanonicalRefutation` pointed at "the reducers" and a deleted judge sibling. It now names the kernel's `reducePanelProgram`. |
| comment-analyzer-4 | accepted | The property-test header was not reflowed and did not say where the moved coverage lives. |
| architecture-tech-lead-1 | accepted | `PanelKind` has one value, so the kernel's `P` type parameter has one value everywhere. It collapses into `PanelKind`. The error helper is taken as code-simplifier-1. |
| code-simplifier-1 | accepted | 38 sites passed the one-value literal `"refutation"` to `panelError`. A module-private `refutationError` binds it once, and the exported `panelError` is unchanged. |
| code-simplifier-2 | accepted | `boundEntryForSlot` was a single-caller generic. It is inlined into `boundRefutationLens` with a reflowed doc. Behaviour is unchanged. |
| code-simplifier-3 | accepted | The fold test had a duplicated section banner and a derived `RefutationPanelState` alias. The banner is deleted and the type is imported. |
| code-simplifier-4 | accepted | The property test's `Step`/`AnyStep` generics had one instantiation. The test uses `PersistentRefutationStep` and inline literals. |
| code-simplifier-5 | dismissed | The reviewer recommends no change. The slot helpers' `Result` parameter keeps them payload-agnostic at no cost. The broader seam question is ADR-0030's, and architecture-tech-lead-1 is the accepted step on it. |

## Accepted fixes

- `engine/src/core/persistent-panel-program.ts`:
  - `P extends PanelKind` is gone from every kernel generic;
  - `PanelProgramDefinition<Authority, AuthorityInput, State, Action, Event>` has `panel: PanelKind`;
  - `PanelCheckpoint<I, E>` has kind `` `${PanelKind}-panel-checkpoint` ``.
- `engine/src/core/persistent-panel.ts`:
  - `refutationError(kind, message, request?)` replaces the 38 `panelError("refutation", …)` sites;
  - the catch comment names `reducePanelProgram`;
  - the program and checkpoint types follow the collapsed kernel.
- `engine/src/core/panel-authority.ts`:
  - `boundEntryForSlot` is inlined into `boundRefutationLens`, whose doc now carries the positional-pairing
    rationale;
  - the disjointness comment says exactly what fails to compile.
- `engine/tests/core/panel-verdict-fold.test.ts`: the duplicate banner is gone, and `RefutationPanelState` is
  imported.
- `engine/tests/core/persistent-panel-kernel.property.test.ts`:
  - the header is reflowed and names the exhaustive and sampled cases;
  - the single-instantiation generics and `PanelPersistence` are collapsed, and the driver's stage and action
    literals are inline.
- `engine/tests/core/persistent-panel-program.test.ts`: the `TALLY` type follows the collapsed kernel.
- `docs/adr/ADR-0030-…md`: "What narrows" records the kernel parameter collapse.

## Support paths (outside the frozen scope)

- this plan

## Validation

- `bun scripts/typecheck.ts`: clean
- focused suites: the panel, persistent-panel, fixture, standalone-review and `handlers/helpers/programs`
  suites (36 files, 604 passed)
- `npm run verify` (root): exit 0, 540 files, 13,284 tests passed (1 skipped)

---

# Round 2

- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261019-pr111-r2`, over the branch at `119d1395`
  (16 files, including this plan). `result.json` digest
  `265d7f35a258053ce8845e6c2974393223219e1e43a305de322ccf2b7cb2f267`.
- **Counts (inspection renderer):** 0 critical and 7 advisory emitted and admitted. After refutation: 0 critical
  surviving, 0 refuted, 7 advisory. 7 slots issued, 7 captured.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261019-pr111-r2`, revision
  `initial`, `disposition.json` sha256 `871d61162380ed2931eb14e823f95b293254442f5e308e8de2a4ec781c724f87`
  (DECLARED).
- **Surviving / refuted criticals:** none. Defect-family accounting: `{"kind":"not-required"}`.

## Round-2 advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| type-design-analyzer-1 | accepted | `PersistentPanelError.panel` and `panelError`'s first argument carried a one-value discriminator that no `src` module reads. Both are dropped, and the round-1 `refutationError` helper is no longer needed. |
| comment-analyzer-1 | accepted | Each lens-disjointness assignment pins one sample literal. The comment now says exactly which literals it samples, and that it proves nothing beyond them. |
| comment-analyzer-2 | accepted | ADR-0030 claimed the only persistent-program tests exercise the refutation path, while the kernel suite drives a test program. The claim is now scoped to tests of the real panel program. |
| architecture-tech-lead-1 | accepted | The lens pin was the only reason `panel-authority` imported the design-lens vocabulary. It moves to `panel-contract`, beside `PanelLens`, with a type-only `ReviewLens` import; there is no cycle. |
| architecture-tech-lead-2 | accepted | The kernel no longer knows any panel kind. Each program definition names itself with a plain `name`, which prefixes its diagnostics and its checkpoint kind. Proof tags are role-only, and `PanelKind` is gone. The refutation program is still named `refutation`, so its durable checkpoint kind and its messages are byte-identical. The kernel's tally test program is now named `tally`. |
| code-simplifier-1 | accepted | `CanonicalPanelSlotBinding` was a pure alias of `RefutationVerifierBinding`. The alias is gone. |
| code-simplifier-2 | accepted | The four `panelError("refutation", …)` sites in `panel-authority` repeated the literal. Resolved by type-design-analyzer-1. |

## Round-2 accepted fixes

- `engine/src/core/persistent-panel-program.ts`:
  - `PanelKind` is gone, and `PanelProofTag` is `"state" | "event" | "recorded-step"`;
  - `PanelProgramDefinition` names its program with `name: string`;
  - diagnostics read `${name} …`, and the checkpoint kind is `` `${name}-panel-checkpoint` ``;
  - `panelError` no longer takes a panel.
- `engine/src/core/panel-authority.ts`:
  - `PersistentPanelError` has no `panel` field, and `panelError(kind, message, request?)` takes none;
  - the `CanonicalPanelSlotBinding` alias and the lens pin are gone, along with the pin's `PanelLens` import.
- `engine/src/core/persistent-panel.ts`:
  - `refutationError` is removed, so call sites use `panelError` directly;
  - proof tags are role-only;
  - `REFUTATION_PROGRAM` is named `refutation`, keeping the durable kind `refutation-panel-checkpoint`.
- `engine/src/core/panel-contract.ts`: holds the lens-disjointness pin, with an accurate comment.
- `engine/tests/core/persistent-panel-program.test.ts`: the tally program is named `tally`, and its tags,
  messages and checkpoint kind follow. "Another program's kind" is now the real `refutation-panel-checkpoint`.
- `docs/adr/ADR-0030-…md`: "What narrows", "What stays", the Option 1 cons and the Consequences reflect the
  above.

## Round-2 support paths (outside the round-2 frozen scope)

- `engine/src/core/panel-contract.ts`

## Round-2 validation

- `bun scripts/typecheck.ts`: clean
- focused: `tests/core`, `tests/handlers/helpers/programs`, `panel-program`, `orchestration`,
  `tests/orchestration` and `tests/fixtures` (238 files, 6,331 passed, 1 skipped)
- `npm run verify` (root): exit 0, 540 files, 13,284 tests passed (1 skipped)
