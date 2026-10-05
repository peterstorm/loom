# ADR-0012: Preferred strict sampling, with exact-route qualification

## Status
Accepted

## Context

Grammar-constrained decoding lets a Pi child Agent send its structured payload (reviewer v2/v3, judge verdict v1, refutation verdict v1) through a per-kind emission tool whose parameters are the exact frozen JSON Schema bytes. Pi's `constrainedSampling` request asks the provider to enforce that schema while sampling. Providers differ a lot in what they do with the request. Some honour OpenAI-style `strict: true`. Some accept the tool but ignore the flag; the qualified local vLLM route behaves this way. Some reject schema shapes the frozen bytes depend on, such as `$defs`/`$ref` and reviewer v2's root `oneOf`. Pi's resolver (`resolveJsonSchemaStrictSampling` in pi-ai, verified on installed Pi 0.83.0) also responds to the two strictness modes in different ways. A *preferred* request on a strict-incapable route resolves to "no strict flag", and the request still goes out. A *required* request throws, which fails the child's request before Loom's final-message extraction fallback can engage.

That leaves three forces in tension. First, the feature must add no new failure modes (FR-010/NFR-011): a provider that cannot enforce the schema must not turn a working extraction-only review into a hard failure. Second, preferring strictness does not make a provider-incompatible schema acceptable, and an accepted schema is not proof of enforcement. Valid-looking output can be model compliance and not provider constraint, and qualification probes on the local route showed schema-invalid arguments (`score: 12`, `verdict: "partially_upheld"`) passing at HTTP 200. Third, the frozen schemas are Loom's issued protocol contract (ADR-0015). They cannot be reshaped per provider without breaking byte identity and issued protocol authority.

Operators configure provider capability flags (strict sampling, tool-call parser, served model) outside Loom. Loom therefore needs a way to tell, for each exact route, whether a tool may be advertised and how much of the output the provider guarantees. It also needs to tell when that knowledge goes stale. It must do this without trusting flags, provider names, or a local schema round-trip as evidence.

## Options Considered

1. **Preferred strict sampling with exact-route qualification (chosen)**
   - Pros: lack of strict support alone cannot fail a request, so the extraction fallback stays reachable. Uses Pi's existing resolver and adds no provider serializer. The frozen schema bytes go on the wire unchanged. Each qualification outcome (constrained, unconstrained, extraction-only) is an explicit, recorded classification tied to provider/model/API, Pi revision, and schema digest. The engine parser stays authoritative on every route.
   - Cons: on unconstrained routes, preferring strictness gives no structural guarantee, and the benefit is limited to tool-call ergonomics and provenance. Each route needs live qualification evidence that someone must collect and renew when a requalification trigger fires. Routes without access stay unqualified and therefore extraction-only.

2. **Strict-required sampling (`strict: "require"`)**
   - Pros: when the request succeeds, provider-side enforcement is guaranteed. Simple to explain.
   - Cons: the resolver throws on every decline path, including strict-incapable routes and schemas it cannot strictify (pi-ai 0.84 or later), so the child fails before extraction can engage. That is a new failure mode, which FR-010/NFR-011 forbids. The checkable invariant INV-1 rules it out.

3. **Treat every grammar-capable provider as JSON-schema-capable, keyed on capability flags or provider name**
   - Pros: no qualification work, and emission turns on everywhere straight away.
   - Cons: a flag or provider name is operator configuration, not proof. Grammar support does not imply acceptance of `$defs`/`$ref` or a root `oneOf`. Routes that reject the schema would be advertised a tool they cannot serve, and routes that ignore `strict` would be wrongly reported as constrained.

4. **Rewrite frozen schemas into a provider-specific mirror (for example TypeBox definitions or a strictified variant)**
   - Pros: more providers could accept the schema and strict mode could apply more often.
   - Cons: breaks byte identity between the issued protocol and the tool parameters (ADR-0015). Optionality or root shape could change without anyone noticing. Adds a second schema source and a provider-specific payload builder that drift from the engine parser. Rejected in ADR-0011 and ADR-0015.

5. **Automatically upgrade a route when its output looks valid**
   - Pros: no explicit qualification step, and capability is "discovered" from use.
   - Cons: model compliance looks the same as provider enforcement. Adversarial forced-`tool_choice` probes show conforming direct calls are inconclusive. A route could be promoted to constrained on luck, and its guarantees would then be overstated in calibration and documentation.

## Decision

**Every emission tool requests `constrainedSampling: { type: "json_schema", strict: "prefer" }` through Pi's existing resolver, never strict-required. Emission tools are advertised only on routes qualified against the exact provider/model/API, Pi revision, and frozen schema digest. Each qualified route is classified as constrained, unconstrained, or extraction-only.**

### Sampling request

- `engine/src/core/harness-capture.ts` holds one source for the request: the `EmissionConstrainedSamplingRequest` type and the frozen `EMISSION_CONSTRAINED_SAMPLING_REQUEST` constant. The literal types `type: "json_schema"` and `strict: "prefer"` make a required request impossible to represent in the engine's own contract. The frozen registry's tool specs carry no separate sampling request.
- The engine core imports no Pi package. The Pi registration surface claims the shape as pi-ai's `ConstrainedSamplingConfig` through a confined cast.
- INV-1 (`.claude/linter/rules/inv-1-no-strict-require-constraint.json`) blocks the spelling `strict: "require"` in `.ts`/`.tsx` sources and fails closed. It is a spelling guard. Behavioural acceptance runs against the real resolver in `engine/tests/pi/emission-tool.test.ts`.
- The resolver's strict-flag truth table is qualification evidence, not an engine contract. A resolver behaviour change triggers requalification.

### Route classification

- **Constrained emission:** the route accepts the exact frozen tool schema and demonstrates the advertised JSON Schema constraints under adversarial probes.
- **Unconstrained emission:** the route accepts the exact frozen tool schema but does not enforce preferred strict sampling. The engine parser (`admitEmissionArguments`, protocol admission, and the verdict parsers) stays authoritative. This is the recorded class of the one currently qualified route.
- **Extraction-only:** the harness or route cannot support the exact tool schema. The tool is not advertised, the schema is not rewritten, and final-message extraction runs unchanged. Claude Code, unsupported historical reviewer protocols, and non-qualified routes take this path explicitly, and the issued capability records the reason.

### Qualification binding

- Qualification evidence is bound to the exact route: provider, served model, and API, plus the Pi revision and the frozen schema digest. At runtime, admission enforces only the provider and model: the qualified route is module-local policy data (`QUALIFIED_EMISSION_ROUTE` in `engine/src/core/spawn-admission.ts`, which holds only `desktop-vllm` / `glm-5.3-flash-spark-tp2-v14`). Qualification stays separate policy from the model profiles, but the literal has one owner: `QUALIFIED_EMISSION_ROUTE` names the catalog's `DESKTOP_VLLM_ROUTE` (`engine/src/core/model-profiles.ts`), and a test pins that owner to the served model in the retained qualification recordings, so a catalog model switch cannot land without new evidence. The API, Pi revision and schema digest are bound by the retained qualification evidence and the requalification triggers below, not by a runtime check. Neither callers nor ambient parent state can select an enabled route. `decideRequestEmissionRoute` returns an `EmissionRouteDecision` of `emission`, `extraction-only`, or `refused`. Extraction-only authority cannot be upgraded by task text.
- Evidence lives in `probes/emission-qualification/` (wire recordings retained), is consolidated in `.claude/specs/2026-09-16-grammar-constrained-decoding/feasibility.md` §2, and is documented for operators in `docs/model-profiles-and-calibration.md` ("Emission routes and qualification").
- **Requalification triggers:** a served-model switch, a frozen schema digest change, a capability configuration change, or a Pi upgrade that changes tool serialization or resolver strict-sampling behaviour.
- A capability flag, provider name, or successful local schema round-trip is never live qualification. Missing access blocks the corresponding evidence and never counts as a pass. No cloud route is qualified, and none is claimed.
- A failed qualification never triggers a silent schema rewrite, a provider-specific payload builder, or unbounded request retries. Retries stay inside the existing request-slot budget (ADR-0019).

## Consequences

**Positive:**
- A route that cannot enforce strictness never makes strictness fail a request. The extraction fallback stays reachable, and the feature adds no new failure mode on strict-incapable routes.
- Frozen schema bytes reach the wire unchanged. One schema source and one sampling-request constant avoid drift between the issued protocol, the tool parameters, and the engine parser.
- Route guarantees are stated honestly. Calibration and documentation can tell provider-enforced structural failures apart from engine-only refusals and avoid over-claiming constraint on unconstrained routes.
- Qualification is reproducible and tied to configuration. A stale route is detectable from the explicit requalification triggers and is not assumed to still hold.
- INV-1 makes the main misuse (`strict: "require"`) a fail-closed lint error, and the literal type makes it unrepresentable in the engine contract.

**Negative:**
- On the only qualified route (vLLM, unconstrained), the provider enforces no structure. Schema-invalid arguments are representable and are caught only by engine parsing, sometimes after Pi's in-child validation-retry loop has spent about 2 extra requests. Latency and quality benefits must be shown by calibration (ADR-0021), not assumed.
- Providers that reject `$defs`/`$ref` or a root `oneOf` stay extraction-only for this feature. Loom accepts narrower coverage rather than reshaping schemas.
- Qualification is ongoing operational work. Every model switch, schema digest change, or relevant Pi upgrade needs a new live run, and unqualified cloud routes stay extraction-only until someone with access collects evidence.
- vLLM-native enforcement (`guided_json`/`structured_outputs`) belongs to the pi-ai resolver and is out of Loom's scope (FR-030), so a stronger guarantee on the local route depends on an upstream change.
- The qualified route is hard-coded policy data in `spawn-admission.ts`. Adding or changing a route needs a code change and new evidence, which is deliberate friction.
