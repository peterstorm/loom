# ADR-0021: Measure useful acceptance, not only syntactic success

## Status
Accepted

## Context
Grammar-constrained decoding (tool-based structured emission for `reviewer-payload`
v2/v3, `judge-verdict` v1 and `refutation-verdict` v1) is meant to cut structural
retries without making reviews slower or worse. Whether it does cannot be read off
"the payload parsed". A syntactically valid payload can still arrive late. It can
come after Pi's in-child validation re-prompts, an extra model turn or a semantic
attempt 2. It can also miss a known defect that the extraction-only path would have
reported. The spec's acceptance scenarios therefore bound latency (AS-015: p95 no
more than 25% above extraction-only, with terminal failures not increased),
quality (AS-016: escaped-defect severity no worse than baseline) and structural
retries on a capable route (AS-004). AS-017 requires that a missing measurement
blocks a done claim.

Several forces make a naive comparison misleading:

- **Confounded baselines.** Timing an old checkout against the new runtime mixes
  in unrelated engine, launcher and Pi changes.
- **Survivorship.** Reporting only completed samples hides timeouts, startup
  refusals and exhausted retries. These are exactly the outcomes a regression
  would produce.
- **Mixed failure causes.** "Retries" lumps together provider-enforced structural
  failures, harness JSON Schema refusals, engine-only refusals (zod refinements,
  byte bounds and issuance joins that the emitted JSON Schema cannot express),
  duplicate-call ambiguity and extraction failures. These have different
  remedies.
- **Unqualified routes.** The only qualified live route (`desktop-vllm`,
  `glm-5.3-flash-spark-tp2-v14`) accepts the frozen schemas but does not enforce
  them (vLLM ignores the tool-level `strict` flag). It is *unconstrained
  emission*, not a capable route. Sampling it cannot show that constrained
  decoding works.
- **Window shopping.** Without a preregistration, a run that looks bad can be
  re-run until a favorable window appears.
- **Unobservable facts.** Pi exposes parsed tool arguments only, so properties
  of the raw generated JSON, such as duplicate keys, cannot be measured.

## Options Considered

1. **Matched, preregistered paired pilot on one frozen runtime (chosen)**
   - Pros: the two arms differ only in the wire section (tool-primary vs.
     final-message instructions), so measured differences are attributable to
     emission. Dispatch-to-ingestion timing includes startup, the readiness
     barrier, tool acknowledgments, follow-up turns, in-child re-prompts and
     attempt 2. Terminal failures are retained and ranked +infinity, so they
     cannot be dropped. Guardrails, seeds and pair counts are fixed before the
     window, which removes window shopping. Unsupported cells and blocked
     windows are recorded rather than invented.
   - Cons: expensive. It needs at least 100 pairs per route/schema cell, which is
     more than 400 paired requests. It needs a reachable live route and an
     independent blinded assessor. It can legitimately end `incomplete` for a
     long time. It is a minimum operational pilot, not a statistical proof of
     universal non-regression.

2. **Compare against an unrelated older checkout or historical calibration runs**
   - Pros: cheap; reuses existing data; no new runner work.
   - Cons: confounds emission with every other change between revisions (engine,
     launcher, Pi version, prompts). Historical runs used different models,
     budgets and reasoning settings. Any latency or quality delta is
     uninterpretable. Rejected in the architecture plan.

3. **Report syntactic success only (parse rate / structural retry count on completed samples)**
   - Pros: trivially measurable from unit and qualification tests; looks
     favorable.
   - Cons: says nothing about latency, follow-up turns, fallback or quality.
     Hides terminal failures and timeouts, and conflates provider-enforced
     structural failures with engine-only refusals. It would let an
     unconstrained route pass as "constrained". Rejected in the architecture plan
     (completed-only samples).

4. **Declare done on qualification probes plus unit/property tests, with no live pilot**
   - Pros: no dependency on route availability; deterministic.
   - Cons: qualification proves schema acceptance, not useful acceptance. ADR-0020
     already establishes that schema/kernel tests cannot show provider behavior,
     child startup or production selection. The spec forbids assigning measured
     completion to a unit-test-only Task.

## Decision
**Compare emission-enabled and extraction-only operation on the same frozen
runtime with matched requests, source snapshots, models, reasoning settings and
token budgets, under a preregistered route matrix, workload and guardrail set.
Any missing or inconclusive measurement, and any guardrail violation, blocks
done.**

**Location**
- Runner: `scripts/run-model-calibration.ts --pilot` (dispatch a window) and
  `--decide` (re-evaluate a retained window). No new provider serializer is
  added.
- Pure core, in `calibration/grammar-constrained-decoding/`:
  - `pilot-preregistration.ts`: preregistration parsing and the
    ABBA-counterbalanced seeded schedule; `pilot-observation.ts`,
    `pilot-preflight.ts` and `pilot-quality.ts`: the counters, the preflight
    and the blinded quality inputs.
  - `pilot-core.ts`: `evaluatePilot` — guardrails and the release-decision
    union.
  - `pilot-workload.ts`: fixtures, case-input resolution and matched prompts;
    `pilot-rubric.ts`: the deterministic `rubric-v1` assessor.
  - `pilot-dispatch.ts`: transcript classification through the engine's own
    selection, plus the live Pi adapter.
- Imperative shell: `pilot-window.ts` performs matched-arm dispatch and the
  attempt-2 retry behind the `ArmDispatch` port. It also derives the blinding
  key and the blinded assessment packet, which `pilot-retention.ts`
  (`recordWindow`) writes.
- Evidence: `preregistration.json`, `workload-fixtures.json` and `windows/<id>--<timestamp>/`.
  Results are documented in that directory's `README.md`.

**Preregistration (before any window)**
- **Route/schema matrix.** The record lists the intended deployment route and,
  for each required cell (reviewer v2, reviewer v3, judge v1, refutation v1), the
  tool name, frozen schema digest, qualification outcome and pair count.
- **Pair counts.** Each cell has at least 100 pairs, built from easy and hard
  cases. Hard cases include held-out known-defect cases.
- **Unsupported cells.** A cell the route does not support gets an explicit
  qualification-only outcome. Constrained samples are never fabricated for it.
- **Digest pinning.** The preregistration is SHA-256 pinned and every window
  records that digest. `--decide` refuses a changed preregistration. The
  preflight blocks the window if the workload digest or the recomputed registry
  schema digests differ.
- **Changes.** Any change needs a new preregistration `id`. Earlier windows stay
  retained.

**Matching**
- Both arms load the same staged checkout extension, whose content-addressed
  Runtime Revision is recorded per window.
- Both arms use the same model, provider, thinking level, tool set and source
  snapshot.
- Task bodies are byte-identical. Only the wire section differs.
- Each arm is launched as production launches it:
  - the emission arm goes through the launcher's RPC readiness barrier (plan
    ADR-0014);
  - the extraction arm runs in print-mode JSON.
- Where the route exposes no seed, inputs are fixed and repeats are independent
  samples. They are not claimed as seeded replays.

**Measurement**
- **Wall clock.** Timing runs from the first child spawn to accepted ingestion.
  Accepted ingestion means the engine's own selection (`observeEmissionCalls` →
  `selectCanonicalPayload` / `selectVerdictSource`) followed by the frozen
  registry parser for the issued kind and version. The cost of ADR-0019's shared
  attempt budget is therefore inside the measurement.
- **Terminal failures.** Semantic exhaustion, startup refusal, infrastructure
  failure and timeout are retained per arm and ranked +infinity.
- **Reported figures.** The window reports:
  - p50/p95 and paired sample counts;
  - tool-use, non-emission, fallback and duplicate-call rates;
  - semantic retries and in-child re-prompts as separate counts.
- **Retry causes.** These are separate series: provider-structural,
  unenforced-schema-violation, engine-only-refusal, unclassified-tool-error,
  extraction-failure, duplicate-call, observation-refused and payload-refused.
- **Raw-observation limit.** Every emission call is recorded as
  `rawArgumentObservation: unavailable`. Duplicate keys are reported as
  `not-claimed`, never as zero.
- **Uncertainty.** Effect sizes carry seeded percentile-bootstrap intervals.

**Guardrails (per cell)**
- `measurement-complete`
- `latency-p95`:
  - passes when the upper confidence bound of the p95 ratio is at most 1.25;
  - is violated when the point ratio exceeds 1.25;
  - otherwise it is inconclusive, which is not a pass.
- `terminal-failure-non-increase`
- `provider-structural-retries`:
  - must be 0 on a constrained cell;
  - is `not-applicable` on an unconstrained cell, where schema violations are
    reported as unenforced rather than as a provider guarantee.
- `escaped-defect-severity`:
  - uses the same rubric (minor 1, major 2, critical 3) for both arms;
  - needs at least two blinded assessors, the deterministic `rubric-v1` plus one
    independent assessor scoring the blinded packet;
  - retains disagreements and adjudicates by maximum severity;
  - fails closed on unresolvable entries.

**Release decision (closed union, precedence in order)**
- `blocked-guardrail-violated`: any violation. This triggers design
  reconsideration, not another window.
- `incomplete-missing-measurement`: anything missing, not measured or
  inconclusive. This includes the absence of a qualified *capable* route
  (`no-qualified-capable-route`).
- `done-allowed`: only a complete record on a capable route where every guardrail
  is `pass` or `not-applicable`. The types
  make a done decision that carries a non-passing guardrail unrepresentable.

## Consequences

**Positive:**
- Latency and quality claims can be attributed to emission itself. Arm
  differences are limited to the wire section on one recorded Runtime Revision.
- Failures cannot be hidden. Terminal outcomes, blocked windows and
  `not-measured` cells are retained, and survivor-only reporting is structurally
  impossible.
- Distinct failure causes stay visible. Provider-enforced and engine-only
  refusals are separate series, so the residual value of engine gates on an
  unconstrained route is observable.
- Preregistration plus digest pinning prevents re-running for a favorable window
  or quietly retuning thresholds.
- Unobservable facts (raw duplicate keys, sampling seeds) are recorded as
  limitations rather than claimed.
- The decision logic is pure and property-testable (`pilot.test.ts`,
  `runner.test.ts`). The I/O sits behind the `ArmDispatch` port.

**Negative:**
- The feature cannot currently be declared measured or done. Both retained
  windows (`gcd-ad11-pilot-1`, 2026-10-03) were blocked at preflight with
  `route-unreachable` and no samples were dispatched. Even a complete
  all-passing window on the only qualified route stays `incomplete`, because
  that route is unconstrained emission.
- Reaching done needs one of two things outside this feature's control:
  - a route that qualifies as constrained emission, such as pi-ai gaining vLLM
    `structured_outputs`/`guided_json` for tools or a cloud route passing
    qualification, followed by a new preregistration and window;
  - an explicit spec-owner amendment of AS-004 or of this ADR.
- The pilot is expensive and slow: at least 408 paired requests and a 900 s
  per-attempt timeout. It also depends on a human or independent assessor for
  the second blinded score.
- About 100 pairs per cell is an operational minimum. A pass is not a
  statistical proof of universal non-regression, and narrow effects may remain
  inconclusive. That outcome blocks done rather than passing.
- The child-level harness does not exercise the run-directory issuance joins
  (roster, scope, prior-origin, criterion/lens bindings). Those stay covered by
  engine tests, not by the pilot.
- Any `engine/src` change after a window invalidates that window's
  runtime-identity vouching. Windows must be re-run on the delivered revision.
