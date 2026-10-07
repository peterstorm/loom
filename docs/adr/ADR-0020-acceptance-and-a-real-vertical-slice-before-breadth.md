# ADR-0020: Acceptance and a real vertical slice before breadth

## Status
Accepted

## Context
Grammar-constrained decoding gives Loom's structured producers (reviewer payload v2 and standalone-successor v3, judge verdict v1, refutation verdict v1) a per-kind emission tool whose parameters are the exact frozen schema bytes, alongside the unchanged final-message extraction. The original plan scheduled the work breadth-first: every kind's schema, registry entry and selection helper first, then all integration. Its first Wave produced a pure core (catalog-derived producer kinds, frozen registry, source selectors) with 58 passing unit tests. Those tests showed the core's internal consistency. They did not show that the parts that carry the risk work.

The feasibility review on 2026-09-19 found that the feature's main assumptions sat outside anything a schema or kernel unit test can reach. Did a provider route accept the frozen schemas (v2 has a root `oneOf`), and did it enforce `strict: "prefer"` or ignore it? Could the installed Pi subagent launcher, which starts `pi --mode json -p` with the prompt already supplied, hold model execution until the child had activated the right tool? Did Pi's real validation agree with the engine parser? A local probe showed whitespace-only advisory text passing Pi's JSON Schema validation and failing `admitEmissionArguments`. Did terminating tool execution actually suppress the follow-up turn? And did the production transcript scan and capture seam pick the emission source at all? Under a breadth-first order, a wrong answer to any of these would surface only after all four kinds had been built on top of it.

A second pressure came from how acceptance is proved. A test asserting that a fabricated port succeeds, or a RED caused by a missing import or an empty file, passes or fails without saying anything about behavior. Implementation briefs written as long prose skeletons of every internal helper also invite agents to build the brief instead of the behavior. The plan needed an order and an acceptance discipline in which each later Wave builds on behavior already shown through the production path.

## Options Considered

1. **Breadth-first: all kinds through each layer, integrate last (the original schedule)**
   - Pros: Uniform layers; every kind's registry entry and parser is ready early; parallel Tasks per kind are easy to schedule.
   - Cons: Provider acceptance, child readiness, transcript capture and production selection go unproven until the end. One wrong assumption (for example, a launcher with no pre-prompt seam) invalidates work across all four kinds. Unit-green layers create false confidence. Contract corrections arrive after consumers have frozen against them.

2. **Feasibility probes only, then breadth**
   - Pros: Retires the provider and launcher unknowns early and cheaply, with standalone probes. Keeps the uniform per-kind schedule.
   - Cons: A probe proves a mechanism in isolation, not that Loom's own issuance, transcript adapter, capture runtime, admission joins and provenance publication compose correctly. Selection-contract defects (call identity, replay, a misbound kind, retained refusal diagnostics) would still surface only in breadth integration.

3. **A full skeleton of every internal helper frozen up front, then fill in**
   - Pros: Clear interfaces for parallel Tasks; little cross-Task negotiation.
   - Cons: Freezes guesses before the vertical slice validates them. The skeleton becomes a second specification that drifts from behavior. Empty or stubbed files give a non-behavioral RED. Redundant brief prose duplicates what existing production exemplars already show.

4. **Phased: feasibility plus behavior-first acceptance, then one real reviewer v2 vertical slice, then breadth (chosen)**
   - Pros: Every risky assumption is retired, or explicitly blocked, before code depends on it. One end-to-end production path proves the composition before three more kinds reuse it. Contract corrections land while only one consumer exists. Negative controls show that the acceptance tests can detect broken behavior.
   - Cons: Less parallelism early. Reviewer v2 is treated as representative, and the verdict kinds' panel joins still need their own integration. More upfront probe work, part of which sits outside this repository.

## Decision
**Phase 2 retires the risky assumptions and sets focused behavior-first acceptance. Phase 3 wires one real reviewer v2 request-to-ingestion path. Phase 4 then expands to successor v3, judge, refutation and the degraded harness paths through the same seams.**

Phase ordering (plan `.claude/plans/2026-09-16-grammar-constrained-decoding.md`, Implementation Phases 2-4):

- **Phase 2 (feasibility and minimal acceptance).** Exact-route qualification through the real harness serialization: `probes/emission-qualification/`, with wire recordings kept. All four frozen schemas were accepted on the local vLLM route, which is classified as unconstrained emission. The launcher readiness mechanism was proved with `pi --mode rpc` and a counting provider substitute (`probes/emission-readiness/`, zero model requests for each negative case). Results, commands and evidence limits are recorded in `.claude/specs/2026-09-16-grammar-constrained-decoding/feasibility.md`. The minimal shared observation/selection contract lives in `engine/src/core/emission-ingestion.ts` and `engine/src/core/harness-capture.ts`. Its behavior-first acceptance in `engine/tests/core/emission-ingestion.test.ts`, `engine/tests/core/emission-tool.test.ts`, `engine/tests/pi/emission-tool-runtime.test.ts` and `engine/tests/pi/emission-startup.test.ts` covers these cases: whitespace-only schema-vs-parser disagreement, invalid call plus valid final text accepted as extraction, invalid-then-corrected duplicates rejected, exact replay, and wrong-kind/version refusal. Missing provider access or a missing launcher seam keeps this phase blocked. A fabricated port that succeeds is not readiness evidence.
- **Phase 3 (one reviewer v2 vertical slice).** `engine/tests/pi/emission-vertical-slice.test.ts` drives one issued reviewer v2 request through the real Pi agent loop, using the production `emissionToolDefinition` from `pi/emission-tool.ts` with terminating execute. It continues through the production transcript scans `piEmissionCallFrames` and `piResultFinalPayloadCandidates` in `pi/transcript-adapter.ts`, then the single canonical selection in `captureHarnessResult` (`engine/src/orchestration/harness-capture-runtime.ts`) against the issued authority the run directory certifies, and ends in existing issued admission and the bounded accepted-source record published before acceptance. Cases: tool-only success, final-message fallback, duplicate-emission ambiguity, wrong-kind refusal before schema selection, exact replay with a byte-identical source record, unavailable capture seam as retriable infrastructure, and an engine-refused single call accepted as extraction with the refusal retained.
- **Phase 4 (breadth).** Reviewer v3, judge v1 and refutation v1 reuse the proven seams. The persistent and legacy panel submission paths (`engine/src/core/panel-program.ts`, `engine/src/handlers/helpers/orchestration.ts`, `engine/tests/core/panel-verdict-fold.test.ts`) keep their criterion/lens/roster joins. Claude Code, unsupported historical protocols and schema-incompatible routes are verified as explicit extraction-only paths.

Invariants of the approach:

- **Discriminating negative controls are required.** For this feature, a RED from a missing import or an empty file does not count. The vertical slice runs three controls against the same production path. With selection bypassed (candidates-only arm), tool-only acceptance fails with `no-final-payload`. An always-accept seam would ingest schema-valid arguments for the wrong kind, which production refuses as `unexpected-kind`. An always-reject posture ends the attempt as `unusable-observation` where production accepts.
- **Reuse exemplars replace brief prose.** Implementation briefs point to `harness-capture-runtime.ts`, the issued reviewer protocol path and the existing panel submission seams, together with their tests and the ADR-0019 behavior matrix. Pi's installed `examples/extensions/structured-output.ts` is a usage reference for terminating success and is never a second schema source.
- **Freeze only what consumers need.** Shared inputs and results (issued binding, closed emission observation, selection result) are frozen. Internal helpers are not skeletonized in advance.
- **Scope stays fixed.** No new default reviewer roster, no general mutation-testing platform and no G5 work is selected under this decision.

## Consequences

**Positive:**
- The two assumptions most likely to sink the feature were settled before dependent code existed: provider schema acceptance on the intended route, and a real pre-model readiness barrier. The launcher finding (no pre-prompt seam in print mode, but an RPC-mode seam that works) changed the design rather than invalidating finished breadth work.
- Selection-contract corrections from the revision (call identity, replay idempotency, misbound-kind refusal, retained single-call refusal diagnostics) were fixed with one consumer. Successor v3, judge and refutation inherited the corrected seams.
- Acceptance tests are shown to discriminate: the bypass, always-accept and always-reject controls fail them, so a green suite says something about production behavior.
- Briefs got shorter and more accurate by pointing at working exemplars instead of restating them.

**Negative:**
- Less early parallelism. Phase 3 serializes on a single reviewer v2 path, and Phase 4 cannot start until it is green.
- The vertical slice uses a scripted model transport (the same counting posture as `engine/tests/pi/emission-tool-runtime.test.ts`). "Real" means the real harness surfaces, registration, transcript adapters, capture runtime and run directory, not a live provider dial. Live provider behavior rests on the separate qualification probes and the ADR-0021 calibration.
- Reviewer v2 stands in for the other kinds only up to the shared seams. Verdict kinds still need their own panel-join integration and tests, and a v2-specific assumption could still surface in Phase 4.
- Part of the proven readiness mechanism depends on an externally owned launcher change (`~/.dotfiles/pi/extensions/subagent/index.ts`) on its own delivery path. Until that change ships, the repository's readiness behavior is proven against the mechanism, not the installed launcher.
- Qualification covers one local route (vLLM, unconstrained emission). No cloud route was qualified, so constrained-emission behavior on other routes is unproven and requires requalification before anyone claims it.
