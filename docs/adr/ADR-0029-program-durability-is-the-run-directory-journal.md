# ADR-0029: Program durability is the Run Directory journal; Fugue leaves the engine

## Status
Accepted (2026-10-18). Amends ADR-0004 ("Fugue used directly; no AuthoredDag sidecar", "What shipped") and
ADR-0005 (which names `fugue-program-runtime` as the owner of durable persistence). Closes the residue of the
issue #19 audit.

## Context
ADR-0004 adopted the type-driven candidate and chose to run Loom's domain programs through Fugue 0.4.0. It
planned two things: `orchestration/fugue-program-runtime.ts`, to drive reducers through `runStateMachine` and
`replayEvents`, and four static operation DAG families under `orchestration/dags/`. It also planned a panel
persistence planner in the pure core. The planner turned each recorded step into an append effect and a
replace effect, each keyed by dedup, plus a receipt.

The issue #19 audit (2026-10-18) traced every one of these against the production call graph. None of them has
a production caller:

- `runProgram`, `resumeProgram`, `createProgramJob`, `replayProgram` and the checkpoint codec are called only by
  their own test. The one export production used was `parseProgramEventRecord`, together with the
  `ProgramEventRecord` type and a `ProgramJournal` port whose only adapter was `RunDirHandle`.
- `createWavePreparationDag`, `createRemediationAuditDag`, `createRemediationStagedSetDag` and the panel and
  standalone DAG factories are called only by `fugue-operation-dags.test.ts`.
- `planPanelProgramPersistence` and its per-panel wrappers `plan*PanelPersistence`, along with
  `parsePanelPersistenceReceipt` and the history parsers whose proof they consumed, were reachable only through
  `helpers/panel-program.ts` `prepare*` functions. Only a test called those.

The behaviour FR-021 asks for ("a panel session MUST persist its current state, accepted result identities,
retry consumption, and terminal outcome across process and parent-session interruption") is nonetheless met,
by a different route that grew up beside the plan:

- **Registered panels** (`engine/src/handlers/helpers/programs/legacy-panel.ts`) append dedup-keyed `spawn-outcome` and `engine-outcome`
  events to the Run Directory journal (`RunDirHandle.appendEvent`). Resume rebuilds the panel by replaying that
  journal.
- **The standalone and wave refutation panels** accumulate their events in memory while the panel completes.
  They then persist through `refutationPanelCheckpoint`: an event prefix that must replay exactly to the recorded
  state. It is embedded in the program's own checkpoint and re-proved by `parseRefutationPanelCheckpoint` on
  every read. (`refutationPanelCheckpoint` and `parseRefutationPanelCheckpoint` are the refutation panel's
  wrappers over the kernel's generic `panelProgramCheckpoint` and `parsePanelProgramCheckpoint`.)
- **Remediation** stages through `git-remediation.ts` called directly from its façade. It uses a temporary index
  and installs only on a verified witness, so the DAGs that were meant to describe it add nothing.

Two parallel designs of one concern violate locality. A reader looking for "how does a panel survive a crash"
finds a runtime, a planner and a set of DAGs, all tested and none of them true. The FR-021 test that existed
proved the planner, not the path a real crash takes.

## Options Considered

1. **Delete the unused machinery and record the journal route as the decision (chosen)**
   - Pros:
     - one durability mechanism, the one production already runs;
     - every remaining durability test exercises a path a real crash takes;
     - the `@fuguejs/framework` dependency, its type-check noise and ADR-0004's Fugue constraints all leave the
       engine.
   - Cons:
     - ADR-0004's "substantially more Fugue" direction, which the user chose over the panel's recommendation, is
       reversed in substance. The reducers stay pure and closed; only the unused execution substrate goes.
2. **Wire production through the Fugue runtime and DAGs**
   - Pros: matches the original plan literally.
   - Cons:
     - rewrites five hardened, heavily reviewed drive paths (wave gate, standalone, remediation, both panels) to
       reach a behaviour they already have;
     - re-introduces Fugue's documented constraints (optional-source envelopes, the `.` id ban, unconditional
       output reachability) into code that does not need them;
     - no spec requirement asks for Fugue, so it is pure risk for no observable gain. Rejected.
3. **Keep both and document which is live**
   - Pros: no deletion.
   - Cons: keeps two designs of one concern and tests that prove the wrong one. Rejected under the deletion
     test, because deleting the unused design concentrates complexity instead of moving it.

## Decision
**A program's durable record is the Run Directory: an append-only, dedup-keyed event journal plus a checkpoint
projection that never outranks it. Panels persist either as journal events replayed on resume or as a checkpoint
whose event prefix re-proves its state. Fugue is not part of the engine.**

- **What stays.** `orchestration/program-journal.ts` keeps the event record format `ProgramEventRecord` and its
  parser `parseProgramEventRecord`. The storage operations (`appendEvent`, idempotent on `dedupKey`;
  `readEvents`; `readCheckpoint`; `writeCheckpoint`) belong to `RunDirHandle` itself. The `ProgramJournal` port
  is folded into it: with the in-memory and file journals gone it had one adapter and no fake, a hypothetical
  seam.

  The persistent panel kernel keeps replay, checkpoint and checkpoint-parse (`panelProgramCheckpoint` and
  `parsePanelProgramCheckpoint`).
- **What goes:**
  - `orchestration/fugue-program-runtime.ts`, every file under `orchestration/dags/`, and their tests;
  - `planPanelProgramPersistence`, `plan*PanelPersistence`, `parsePanelPersistenceReceipt` and the panel history
    parsers;
  - the `prepare*PanelPersistenceOperations` and `translateLegacyPanelJournalBytes` helpers;
  - the `malformed-history` and `persistence-receipt-mismatch` panel error kinds;
  - the journal's `writeProgress` and the `progress.json` slot that only the Fugue job wrote;
  - the `@fuguejs/framework` dependency and its orchestration-boundary allowance.
- **The crash windows FR-021 names are tested where they occur:**
  - `legacy-panel-driver.test.ts`: a process dies after an engine operation publishes its artifacts and before
    its success event is journalled. Resume republishes byte-identical artifacts and journals the success exactly
    once.
  - `panel-program.test.ts`: a crash between event append and checkpoint resumes from the journalled prefix.
  - `publication-faults.test.ts` and `run-directory-journal-budget.test.ts`: the journal's own dedup, corruption
    and budget refusals.
- **The refutation threshold is one rule** (folded into the same cleanup, issue #19 item T2).
  `defaultRefutationThreshold(lenses)`, the strict majority, is the only bar. Every producer derives it, and
  every persisted reader requires exactly it:
  - the persistent tally;
  - the standalone panel authority and outcomes parsers;
  - lineage history.

  `review-panel tally` refuses `--threshold` by name. Before this change three readers enforced only a floor,
  and the legacy tally let a caller raise the bar. A scan of all 207 persisted threshold records found none off
  the majority, so equality rejects no real history.

## Consequences

**Positive:**
- One answer to "how does a program survive interruption", and every durability test exercises a path
  production takes.
- About 2,000 lines of production code and 1,800 of tests leave the engine, along with a pinned third-party
  runtime. `bun scripts/typecheck.ts` no longer reports `@fuguejs` fixture diagnostics.
- A refutation panel's bar can no longer depend on which entry point tallied it.

**Negative:**
- ADR-0004's Fugue direction is reversed. Its executable-model reasoning (no AuthoredDag sidecar) still holds;
  its runtime choice does not. A future need for a DAG runtime is a new decision, not a restoration of this
  code.
- The persistent architecture panel's own program (`startPersistentArchitecturePanel` and the architecture half
  of `core/persistent-panel`) is also unused in production. Live architecture panels run on the registered
  legacy driver. It is not removed here because the refutation half shares its kernel and is live. Whether to
  migrate the registered architecture panel onto it, or delete it, needs its own design session.
