# ADR-0096: Each panel has one driver, and the manual review helpers retire

## Status
Accepted (2026-11-20). Partly supersedes ADR-0030: its premise that `/loom --panel` runs the registered
driver. Amends ADR-0029 (the registered panel bullet and its crash-window test) and ADR-0018 (the legacy
panel verdict path).

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
(`core/persistent-panel`). The registered `start refutation` was a second, unused entry to it.

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
    (`helper panel-program` replays its own way).
- **What stays:** the stateless architecture dispatch program, `helper panel-program architecture`, the panel
  contract, the kernel, ranking, and the persistent Refutation Panel. They are unchanged.

## Consequences

**Positive:**
- The façade's registered programs are the ones a runbook drives: standalone review, standalone disposition,
  Wave Gate, remediation and security verification.
- The capture-rejection carry-past that existed only for registered panels is gone with them.

**Negative:**
- A registered architecture or refutation run started by hand, outside every runbook, is no longer
  resumable. `resume` reports the registration as malformed.
