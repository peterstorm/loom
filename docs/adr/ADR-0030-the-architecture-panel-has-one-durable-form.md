# ADR-0030: The architecture panel has one durable form: the registered driver's journal

## Status
Accepted (2026-10-18). Resolves the question ADR-0029 left open in its Consequences ("the persistent
architecture panel's own program ... needs its own design session").

## Context
The August 2026 plan (`.claude/plans/2026-08-09-orchestration-automation.md`, Task 2) put both panels behind
persistent, authority-bound programs. Those programs were separate architecture and refutation reducers in
`core/persistent-panel`, with the older journal-based panel code as a "legacy journal compatibility adapter".
Both landed in #17 (2026-08-21). Production then grew up on the adapter:

- `/loom --panel` runs the registered driver in `engine/src/handlers/helpers/programs/legacy-panel.ts` over the
  dispatch program in `core/panel-program` and the decisions in `core/legacy-panel-decisions`. That driver
  includes the interactive interview and finalization steps.
- The persistent refutation program was adopted by standalone review and the wave gate. They embed its
  checkpoint and re-prove it inside their own.
- The persistent architecture program (`startPersistentArchitecturePanel`, its submit, complete, replay and
  checkpoint functions, and `ArchitecturePanelAuthority`) never gained a production caller. It covered only
  candidates → judges → ranking, so serving the live flow would have meant wrapping it in the interactive
  steps the registered driver already runs. Later review rounds kept hardening it all the same, including the
  kernel extraction (`0d760d54`), which made it look live.

Reading both paths showed that the registered driver already carries each guarantee the persistent program was
written to supply:

- **Judge criterion binding:** each judge slot's criterion is minted through the closed interview vocabulary
  (`legacy-panel-decisions.ts`).
- **Ranking:** both paths call the same `aggregateVerdicts`.
- **Crash durability (FR-021):** the registered driver resumes by replaying its dedup-keyed Run Directory
  journal. `legacy-panel-driver.test.ts` exercises the crash window.

## Options Considered

1. **Delete the persistent architecture program (chosen)**
   - Pros:
     - one design per panel: architecture panels are the registered driver, refutation panels are the
       persistent program;
     - the panel vocabulary narrows to the one persistent program that exists, so an architecture-panel error
       or proof tag becomes unrepresentable;
     - the tests that proved an unused path are gone, and the kernel contracts they pinned now run on the
       refutation panel.
   - Cons: a second instantiation of the shared program kernel is lost. The kernel's own suite still drives a
     trivial test program, so the seam keeps a second adapter.
2. **Migrate the registered architecture panel onto the persistent program**
   - Pros: matches the August plan literally.
   - Cons:
     - rewrites a working, reviewed live path to reach behaviour it already has;
     - the program would first have to grow the interactive interview and finalization steps.

     Rejected, by the same argument ADR-0029 made against wiring production through Fugue.
3. **Keep both**
   - Cons: two designs of one panel, with tests that prove the unused one. Rejected under the deletion test.

## Decision
**An architecture panel's durable form is the registered driver's Run Directory journal. The persistent panel
program is the refutation panel's alone.**

- **What goes:**
  - the architecture half of `core/persistent-panel` (its state, events, actions, submissions,
    complete-roster proof, aggregate, replay and checkpoint);
  - `ArchitecturePanelAuthority`, `parseArchitecturePanelAuthority`, `boundJudgeCriterion` and
    `boundCandidateEntry` from `core/panel-authority`;
  - the architecture fixture in `tests/fixtures/panel-authority.ts`.
- **What narrows:**
  - `PersistentPanelError.panel`, and with it the kernel's `PanelKind`, is `"refutation"`;
  - roster authority checks (`rosterAuthorityErrors`, the legacy ordinal binding) take only the verifier
    shape;
  - one-value panel parameters inside `core/persistent-panel` collapse.
- **What stays:**
  - the generic program kernel (`core/persistent-panel-program`), whose suite drives a test program;
  - the compile-time pin that design and refutation lens vocabularies stay disjoint;
  - every durable byte the refutation panel writes.
- **Coverage that moved rather than vanished:**
  - the verdict-fold AD-9 matrix, the misbinding rows, the exact-replay row, the baseline row and
    the historical source-arm projection now run through `submitRefutationVerdict`;
  - the submission contract, the compile-time slot-progress authority, reduction totality, the FR-021
    append→checkpoint crash window and the registration-divergence refusals are pinned on the refutation
    panel;
  - the exhaustive two-slot kernel enumeration now drives a two-verifier panel.

## Consequences

**Positive:**
- "How does an architecture panel survive a crash" has one answer. The only persistent-program tests that
  remain exercise the live refutation path.
- About 670 net lines of production code leave `core/persistent-panel` and `core/panel-authority`, and about
  650 net lines of tests go with them.

**Negative:**
- The August plan's "persistent architecture panel" (US2) is now met by the registered driver rather than the
  planned program. A future need for authority-bound architecture slot binding beyond what the driver does
  is a new decision, not a restoration of this code.
