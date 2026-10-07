# ADR-0011: Retain the selected type-driven FP approach and panel provenance

## Status
Accepted

## Context
Grammar-constrained decoding moves Loom's structured agent payloads (reviewer v2,
standalone-successor reviewer v3, judge verdict v1, refutation verdict v1) from
"parse whatever the model wrote in its final message" toward "the model calls a
per-kind emission tool whose parameters are the payload schema". The work touches
three seams that already carry strong invariants: the frozen zod-derived payload
schema bytes, the pure spawn-admission decision in
`engine/src/core/spawn-admission.ts`, and PR #52's fail-closed final-message
extraction with its bounded retry. The brainstorm closed a determinism thesis:
the engine never chooses between interpretations, so any new preference must be
additive and deterministic.

The architecture was chosen through a `/loom --panel` run
(`.claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run.zOVEfIJzSl/manifest.json`).
Three lens-specific candidates were scored by three adversarial judges on
extensibility, pure functional core, and codebase fit + effort. The user selected
`candidate-type-driven-fp`. On 2026-09-19 a user-authorized revision of the plan
corrected feasibility and behavior contracts that the candidate had gotten wrong,
most visibly the "codebase fit" judge's two flagged flaws: `strict: "require"`
sampling (which throws in Pi 0.83.0 on constraint-ignoring providers) and a US4
admission decision placed in a parallel module instead of the existing pure
spawn-admission seam.

That revision raised a provenance question: did correcting those contracts reopen
the architectural selection, and should the panel artifacts be rewritten to
reflect the revised design? Future readers need to know which architecture is the
base, why, what the recorded panel scores do and do not mean, and which
alternatives remain rejected.

## Options Considered

1. **Retain `candidate-type-driven-fp` as the base; apply the 2026-09-19 corrections on top; leave panel artifacts untouched**
   - Pros: honors the user's explicit selection; keeps the frozen per-kind
     registry (`EMISSION_TOOL_SPECS`), which the extensibility judge identified as
     the strongest idea across candidates; keeps `selectCanonicalPayload` as a
     total function returning a discriminated union with provenance constructed at
     the selection seam (the pure-core judge's strongest idea); both judge-flagged
     flaws are correctable without changing the candidate's shape (`strict:
     "prefer"` per ADR-0012, admission inside `spawn-admission.ts` per ADR-0014); panel
     history stays an honest, immutable record.
   - Cons: the recorded "codebase fit + effort" score (6, lowest of the three)
     reflects the uncorrected candidate, so the historical ranking can be misread
     as validating the revised design; the corrections carry real weight that the
     panel never scored.

2. **Switch to `candidate-risk-security-first` (22)**
   - Pros: best codebase-fit score (8); closed per-harness capability ADT;
     execute-time re-validation with the engine's own zod schema; an auditable
     byte-for-byte fallback containment property.
   - Cons: overrides the user's selection on the basis of a one-point score gap;
     its strongest ideas (engine parse as authority, capability ADT, containment
     law) were already absorbed into the revised plan (ADR-0015, ADR-0016/ADR-0017, ADR-0019), so
     switching buys little; weaker pure-core and extensibility scores.

3. **Switch to `candidate-simplicity-first` (20)**
   - Pros: smallest surface; frozen bytes used directly as tool parameters with a
     byte-match guard.
   - Cons: the codebase-fit judge recorded a fatal flaw: a reviewer-only, V2-only
     shape excludes the review-verifier kind and refuses V3 standalone-successor
     payloads, both of which already flow through the capture seam; it also cannot
     express the ADR-0016 three-kind scope without becoming the type-driven registry.

4. **Re-run the panel against the revised plan, or rewrite candidate/verdict artifacts to match it**
   - Pros: scores would reflect the corrected design.
   - Cons: the revision corrected feasibility, not the selection; re-running would
     spend panel effort on a decision the user already made; rewriting candidate or
     verdict files would falsify the historical record the scores came from.

Within the retained candidate, the architecture plan also rejects three implementation
shapes:

- **A second provider serializer** (e.g. rewriting the child's provider payload to
  add `response_format`): creates a second serialization chain outside Pi's
  resolver and cannot work for multi-turn reviewers without turn heuristics that
  reopen the determinism thesis.
- **A hand-authored schema mirror** (TypeBox or provider-specific definitions):
  invites drift from the frozen zod bytes that the stamper, wire contract and
  engine parsers already share.
- **A new generic orchestration/retry subsystem**: duplicates the existing
  request-slot budget and semantic attempts 1 and 2 (ADR-0019) and would need its own
  lifecycle, which was never specified coherently.

## Decision
**Keep `candidate-type-driven-fp` as the architectural base, with frozen-schema reuse and the existing pure spawn-admission seam; record the panel ranking as historical provenance only.**

- **Base shape.** A pure frozen registry in `engine/src/core/emission-tool.ts`
  (`EMISSION_TOOL_SPECS`) maps each producer kind/version to its exact tool name,
  frozen schema bytes and the same engine parser the fallback uses. The only
  constructor of tool parameters is `frozenPayloadSchemaParameters`, built from the
  issued frozen bytes. Argument admission is `admitIssuedEmissionArguments`; issued
  bindings come from `issueEmissionBinding`, and capability is the closed
  `EmissionToolCapability` (`providedEmissionCapability` /
  `notProvidedEmissionCapability`).
- **Selection.** `engine/src/core/emission-ingestion.ts` holds the pure
  `selectCanonicalPayload` and `selectVerdictSource`, returning
  `IngestionSelection` / `VerdictSourceSelection` with provenance. The module
  imports neither `panel-program.ts` nor I/O adapters.
- **Admission.** The parent-side expected-capability decision is consumed in
  `engine/src/core/spawn-admission.ts`, the existing pure seam, as its last
  per-item gate, rather than by a parallel admission path. The decision itself
  (descriptor grammar, issued claims, route qualification) lives in
  `engine/src/core/issued-emission-capability.ts`, which spawn admission
  composes. Child readiness is a separate launcher barrier (plan ADR-0014), not a
  second admission decision.
- **Corrections layered on the base (2026-09-19).** Preferred, never
  strict-required, sampling (`constrainedSampling: { type: "json_schema", strict:
  "prefer" }`, defined once as `EMISSION_CONSTRAINED_SAMPLING_REQUEST` in
  `engine/src/core/emission-tool.ts` and registered by `pi/emission-tool.ts`; INV-1); per-route qualification; one
  existing request-slot budget. These correct contracts; they do not change the
  selected architecture.
- **Provenance.** Panel manifest:
  `.claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run.zOVEfIJzSl/manifest.json`.
  Recorded ranking (`ranking.json`): type-driven-fp 23 (8/9/6),
  risk-security-first 22 (7/7/8), simplicity-first 20 (5/8/7). These are
  historical panel scores of the uncorrected candidates, not feasibility evidence
  for the revised design. Feasibility evidence lives in
  `.claude/specs/2026-09-16-grammar-constrained-decoding/feasibility.md` and the
  `probes/` and `calibration/grammar-constrained-decoding/` artifacts. The
  `candidates/`, `verdicts/`, `interview.*`, `ranking.json` and `manifest.json`
  files of the run are immutable and are not edited by this feature.
- **Rejected shapes stay rejected:** no second provider serializer, no
  hand-authored schema mirror, no new generic orchestration/retry subsystem.

## Consequences

**Positive:**
- One schema source: tool parameters, wire contract and engine parsers derive from
  the same frozen bytes, so schema drift is structurally prevented.
- Adding a producer kind is one registry entry with compiler-guided wiring,
  which is how all three kinds (ADR-0016) fit without a refactor.
- Selection and provenance are produced by one pure decision, so shells cannot
  recount validity or reconstruct the source after the fact.
- Spawn admission remains a single pure seam; no competing admission module
  exists.
- The panel record stays trustworthy: a reader can see exactly what was scored,
  by whom, and against which candidate text.

**Negative:**
- The recorded ranking is easy to misread as an endorsement of the revised plan.
  Its 6/10 codebase-fit score and both fatal-flaw notes describe the candidate
  before correction; readers must consult the plan's ADR-0012/ADR-0014 and feasibility
  evidence instead.
- The revised design was not re-scored. The selection rests on the user's choice
  plus the argument that the corrections preserved the candidate's shape, not on a
  fresh adversarial comparison.
- The registry and ADT layer cost more up-front structure than the
  simplicity-first shape would have needed for a single kind.
- `frozenPayloadSchemaParameters` confines a type-level cast (frozen JSON bytes
  presented as Pi's TypeBox-typed parameter). The byte round-trip guard and engine
  parsing remain the real enforcement, and the emitted JSON Schema does not
  express every engine refinement (ADR-0015).
- Refusing a second provider serializer leaves provider-native enforcement (for
  example vLLM `guided_json`) out of Loom's scope; routes that ignore the strict
  flag classify as unconstrained emission, with the engine parse authoritative.
