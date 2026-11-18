# ADR-0087: The spec is amended by an audited operation

## Status
Accepted (2026-11-18). Implements loom#199, Cause 4.

## Context
In the fugue-dags host-memory run, paging forced a specification change in the middle of execute. It added
FR-064, AS-039 and AS-040, rewrote NFR-004 and FR-061, and removed a plan exemption. Loom had no operation for
it. `amend-spec-trace` re-assigns Requirement ids between Tasks but cannot change what a Requirement says. So the
only route was to list `spec.md` as a file of a fix Task, as if requirement text were sealed code. Nothing
recorded that the text had changed, and nothing made the completed Tasks that claimed the rewritten Requirements
answer for the new text. The completed-claim drift that Wave Gate spec-check reports is advisory by
construction.

## Options Considered

1. **An audited `amend-spec` operation (chosen).** It writes new spec bytes through the engine, records the
   Requirement diff, re-anchors open claims, and owes rewritten completed claims a re-judgement at the next gate.
   - Pros: requirement text has its own operation and history. The change is reviewed where requirements are
     reviewed, in spec-check, and no completed Wave is reopened.
   - Cons: a completed claim's re-judgement rides on the current Wave's gate. That gate's spec-check now judges
     a Task outside its Wave.
2. **Keep spec text in fix Tasks.**
   - Cons: requirement changes stay invisible as such, and completed claims are never judged against the new
     text.
3. **Reopen the completed Waves whose claims changed.**
   - Cons: this rewinds `current_wave` and retires later progress, as ADR-0077 already rejected for judgements.

## Decision
- `helper amend-spec --from <proposed spec> --reason <text>` (`core/spec-amendment.ts`) indexes the protected
  `spec_file` and the proposed bytes, both under the `spec_file` path. It refuses unless all of these hold:
  - the graph is trace v2 and the Wave-reopening precondition holds;
  - both texts parse;
  - the path still matches;
  - no Task that has not completed still claims or contributes to a withdrawn id. The operator moves such a
    claim first, with `amend-spec-trace`.
- `specAmendmentDiff` classifies each Requirement id as one of:
  - **rewritten:** its text hash changed;
  - **added:** only the new spec defines it;
  - **withdrawn:** it is gone, or now Out of Scope.
- One locked commit does four things:
  - it appends a `spec-amended` audit to `spec_amendments`: the reason, both Spec Index observations, the three
    disjoint id lists, the completed claims it changed (a rewritten one is judged again, a withdrawn one is only
    recorded), and the retired run;
  - it re-anchors every rewritten claim of a Task that has not completed to the new text;
  - it leaves completed Tasks' recorded hashes alone;
  - it retires the current Wave's review authority and spec-check.
- The shell then writes the new spec bytes atomically. If a crash lands between the commit and the write, the
  same command answers `bytes-pending` and writes only the bytes. If the spec already holds the proposed bytes,
  it answers `unchanged`.
- The audits form one chain. An amendment whose current spec is not the text the last amendment wrote is
  refused, because the spec changed outside `amend-spec`. The shell observes the current spec under the lock.
- **Re-judgement.** `coverageTasks` carries each Task's `rejudgeClaims`. While such a claim still drifts from the
  current text, the Requirement Coverage Projection lists it among the current Wave's rows instead of as advisory
  completed-claim drift, so spec-check judges it with the same verdicts as the Wave's own claims. When the Wave
  Gate completes, `reanchorVerifiedClaims` re-anchors those claims to the reviewed text, which discharges them.
  One rule, `rejudgeClaimsOf` (`core/spec-rejudgement.ts`), names those claims for both.
- A withdrawn completed claim has no text to be judged against. It stays completed-claim drift until
  `amend-spec-trace` drops it, which that operation allows because the id is no longer completable.
- An added Requirement is assigned with `amend-spec-trace`.

## Consequences
- A requirement change is an audited event with a reason, not a file in a fix Task.
- A completed Task's claim that the spec rewrote is judged again by the next Wave Gate. Until it passes, that
  gate cannot complete.
- Re-population drops `spec_amendments` with the rest of the earlier plan's history.
