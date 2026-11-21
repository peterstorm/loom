# ADR-0096: Each panel has one driver, and the manual review helpers retire

## Status
Accepted (2026-11-20). Partly supersedes ADR-0030: its premise that `/loom --panel` runs the registered
driver. Amends ADR-0029 (the registered panel bullet, its crash-window test, and the threshold rule's
mention of the review-panel tally), ADR-0018 (the legacy panel verdict path) and ADR-0004 (its consequence that
historical helpers and formats remain behind `core/legacy-archive.ts`).

## Context
Panels had more than one driver each. Only one driver per panel had a caller.

**The architecture panel.** Two drivers existed:

- `references/loom/panel-runbook.md` drives it: `/loom --panel` sends the parent there (`commands/loom.md`).
  The parent appends each `spawn-outcome`/`engine-outcome` event to the panel run's journal and replays it
  through the stateless `helper panel-program architecture`. `helper panel-contract` validates every artifact.
  The runbook says not to also drive it through `helper orchestration start`.
- The registered driver (`helper orchestration start architecture|refutation` with the `complete` operation,
  in programs/legacy-panel.ts and core/legacy-panel-decisions.ts) also existed. No command, skill, reference,
  agent, hook or Pi file starts it. The one persisted architecture panel run in this repository
  (`.claude/specs/2026-08-09-orchestration-automation/panel-runs/run.RIzvYedN0m`) has the stateless journal
  (panel-program.json) and no façade registration. No façade run under `.claude/reviews/` has an
  architecture or refutation registration.

ADR-0030 said the opposite. It deleted the persistent architecture program because the registered driver was
live, and read the registered driver's tests as proof. The deletion test it applied was right, but it
pointed the wrong way.

**The Refutation Panel** runs inside the Wave Gate and standalone review on the persistent program
(`core/persistent-panel`). Three more drivers existed beside it:

- The registered `start refutation`, a second, unused entry to the same program.
- The manual helper `helper review-panel brief|manifest|verdict|tally`. It ran a panel over a
  reviews/panel-runs directory in its own v1 formats (`brief.json`, `manifest.json`, `outcomes.json`) and
  wrote the TaskGraph directly. No command, skill, reference, agent, hook or Pi file calls it; its own source
  required that the skill prose name none of its operations. Its callers were two smoke scripts and its
  tests. The eleven run directories it left in this repository's .claude/reviews/panel-runs (untracked) all date from
  2026-08-10, before the persistent program existed.
- `helper panel-program refutation`, the refutation half of the stateless dispatch reducer. Nothing
  replays a refutation journal: the persistent program records its own.

The architecture journal's reader lived in `core/legacy-archive` as a "legacy panel journal" translator,
although the runbook writes that format today.

**The manual standalone review.** `helper standalone-review init|aggregate|finalize` ran a standalone
review by hand, beside the registered `helper orchestration start standalone-review` that `/review-pr`
drives. It aggregated through legacy-archive Section A, re-read its aggregate through Section B, and wrote
an unversioned result through its own serializer. Its callers were the standalone-review smoke script and
its tests; the runbook contract already forbids the prose from naming its operations. In this repository's
untracked .claude/reviews/review-and-fix-runs, all 127 result files carry a schema version and no run holds
the helper's review plan, so no persisted run needs the unversioned reader.

## Options Considered

1. **Delete every driver without a caller (chosen)**
   - Pros:
     - one driver per panel; "how does this panel resume" has one answer;
     - the façade loses a registration kind, a submission binding arm, a deterministic operation and a
       per-attempt verdict source record that only the dead driver read.
   - Cons: a run directory written by the registered driver can no longer be resumed. None exists here.
2. **Move `/loom --panel` onto the registered driver**
   - Pros: matches what ADR-0030 believed.
   - Cons: rewrites the live runbook to reach behaviour it already has: exact slots, journal replay and
     complete-roster parsing. Rejected by the same argument ADR-0030 used.
3. **Keep both**
   - Cons: two designs of one panel, with tests that prove the unused one. Rejected under the deletion test.

## Decision
**Each panel has exactly one driver. The architecture panel's is the runbook over
`helper panel-program architecture` and `helper panel-contract`. The Refutation Panel's is the persistent
program inside the Wave Gate and standalone review.**

- **What goes:**
  - `start architecture`, `start refutation` and the `complete` operation of `helper orchestration`;
  - the registered driver, its decisions module and their tests;
  - the façade's panel registration translation and its panel submission binding;
  - the panel verdict source record and its replay (`foldVerdictSubmission` stays and serves the persistent
    program);
  - the journal-replay half of `core/panel-program` that only the registered driver called
    (`helper panel-program` replays its own way);
  - the manual `helper review-panel` route, its v1 brief, manifest and outcomes formats, the run policy
    only it applied, and the `review-panel` and `standalone-review` smoke scripts that drove it;
  - the refutation half of `core/panel-program` and the `refutation` mode of `helper panel-program`;
  - the manual `helper standalone-review` route, legacy-archive Sections A (legacy aggregation) and B
    (the unversioned result parser), the unversioned result serializer, and what only they used: the
    text-based capture and decode helpers, the canonical-transcript aggregation, and the panel-run write
    preparation and no-follow re-exports. Its pass-through capture entry point goes too; harness capture
    calls `captureStandaloneReviewerBytes` in core.
- **What moves:** the architecture journal reader leaves `core/legacy-archive` for `core/panel-program`,
  beside the reducer it feeds. It is the live format, not a historical one. Its wire spelling
  (`format: "legacy-panel-program"`, `schemaVersion: 1`) and its error messages are unchanged, so every
  journal on disk still reads.
- **What stays:** the stateless architecture dispatch program, `helper panel-program architecture`, the panel
  contract, the kernel, ranking, and the persistent Refutation Panel. The pieces of `core/review-panel` the
  persistent program uses stay: the lens catalogue, the critical finding projection, the verdict parser and
  the refutation threshold. `core/legacy-archive` keeps Section C, the Wave Gate compatibility migration,
  unchanged.

## Consequences

**Positive:**
- The façade's registered programs are the ones a runbook drives: standalone review, standalone disposition,
  Wave Gate, remediation and security verification.
- The capture-rejection carry-past that existed only for registered panels is gone with them.

**Negative:**
- A registered architecture or refutation run started by hand, outside every runbook, is no longer
  resumable. `resume` reports the registration as malformed.
- `helper review-panel`, `helper standalone-review` and `helper panel-program refutation` now fail. A v1
  reviews/panel-runs directory and an unversioned standalone result are inert history: nothing reads them,
  and nothing rewrites them.
