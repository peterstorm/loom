# ADR-0015: One frozen schema; explicit limits on its guarantees

## Status
Accepted

## Context
Grammar-constrained decoding gives each Loom producer Agent (reviewer v2, standalone-successor reviewer v3, judge v1, refutation v1) a per-kind emission tool whose `parameters` a provider may use to constrain sampling. Those payload contracts already exist as frozen, zod-generated schema bytes. The issued reviewer protocol records their digests, and the engine parsers re-validate every payload at ingestion. Adding a tool surface creates a second place a schema can live. If the tool parameters drift from the issued bytes, the provider constrains against one contract while the engine admits against another. Archived requests and issued protocol identity (ADR-0009) would also stop describing what the model actually saw.

Two forces pull against a naive "the tool schema is the contract" design. First, a JSON Schema is not the engine parser. Zod refinements (for example, rejecting whitespace-only advisory claims or reasons), UTF-8 and global byte bounds, canonical-path rules, and cross-field or issuance joins are not all expressible in, or enforced by, the emitted JSON Schema. A direct local probe confirmed this: whitespace-only prose passed Pi's frozen-schema `validateToolArguments` but was refused by `admitEmissionArguments`. Second, provider acceptance of a schema is a property of the route, not of the bytes. Reviewer v2 has a root `oneOf`, and Pi's Responses serializer forwards it unchanged with `strict: true`. Whether a given provider accepts and enforces it can only be established by testing it live.

A third limit concerns observation. Pi hands the harness parsed tool arguments, not the generated JSON text. Facts about the raw bytes, such as duplicate keys, cannot be recovered after parsing. The decision therefore has to say exactly what one frozen schema guarantees, and what it does not, so later work does not treat it as a correctness, compatibility or measurement claim.

## Options Considered

1. **Construct tool parameters from the exact issued frozen schema bytes, keep every engine gate, and state the limits explicitly (chosen)**
   - Pros: there is one serialization chain from zod to the frozen bytes to the tool `parameters`, so drift is impossible by construction. A byte round-trip guard re-proves identity for every kind and version. The issued protocol digest describes the registered tool exactly. No new dependency is added, and no v2/v3 schema bytes or protocol identities change. The engine parser remains authoritative, so schema-vs-parser gaps cannot admit bad payloads.
   - Cons: the schema's shape is whatever zod emits, including v2's root `oneOf`, so provider compatibility must be qualified per route rather than designed in. Pi registration types `parameters` as a TypeBox `TSchema`, which forces one confined cast at the registration surface. Engine-only refinements surface as refusals after the model has already emitted, not as sampling constraints.

2. **TypeBox mirror definitions for the tool surface**
   - Pros: native typing for Pi's `registerTool`, with no cast. The schema could be authored idiomatically for the harness.
   - Cons: a second hand-maintained schema that can drift from the zod source and the issued digests. Two contracts must be kept equal by discipline rather than by construction. This was rejected in ADR-0011 as a hand-authored schema mirror.

3. **Provider-specific payload builder / strictified schema rewrite**
   - Pros: each provider's strict-mode dialect could be targeted, for example by removing a root `oneOf` or forcing all properties to be required, which might raise acceptance on strict-only routes.
   - Cons: it silently changes optionality or root shape, so the constrained contract is no longer the issued one. It adds a second provider serializer that belongs in Pi's resolver, not in Loom (FR-030). Issued protocol identity would require new versions. Every provider change would turn into a Loom change.

4. **Treat schema-constrained sampling as the validation guarantee and slim engine gates**
   - Pros: less re-validation code and a simpler ingestion path.
   - Cons: false. JSON Schema cannot express the zod refinements, byte bounds, canonical paths or issuance joins. Many routes, including the qualified vLLM route, do not enforce strict sampling at all. Removing gates would admit payloads the engine currently refuses.

## Decision
**Tool `parameters` are the exact issued frozen schema bytes, parsed once. The byte round-trip guard and every existing engine parser stay authoritative. Existing v2/v3 schema bytes and issued protocol identity are unchanged. What this guarantees, and what it does not, is stated explicitly.**

Details:

- **One registry, one chain.** `EMISSION_TOOL_SPECS` in `engine/src/core/emission-tool.ts` maps each producer kind and version to its frozen bytes (`REVIEWER_PAYLOAD_SCHEMA_V2`, `STANDALONE_REVIEWER_SCHEMA_V3`, `JUDGE_VERDICT_SCHEMA_V1`, `REFUTATION_VERDICT_SCHEMA_V1`) and its engine parser. `frozenPayloadSchemaParameters(schemaBytes)` is the only constructor of tool `parameters` (`JSON.parse` of the frozen bytes). The `satisfies Record<PayloadProducerKindName, EmissionToolSpec>` check makes the registry exhaustive over producer kinds.
- **Registration.** `emissionToolDefinition(binding)` in `pi/emission-tool.ts` builds the registered tool from the issued binding. The definition includes the registry tool name, the frozen `parameters`, the shared `constrainedSampling` request (`strict: "prefer"`, per ADR-0012 and INV-1), and a `prepareArguments` hook. The hook runs `canonicalizeEmissionWireArguments`, a pure transport parse driven only by the frozen schema's declared types. It decodes JSON-string-encoded fields that a declared non-string type can accept, and it never invents, defaults or drops a field. Pi then validates against the same frozen bytes. The TypeBox `TSchema` claim is a single confined cast at the `registerTool` surface.
- **Digest identity.** `issueEmissionBinding` derives `schemaDigest` as `sha256` of the frozen bytes and refuses any issued digest claim that does not certify the registry cell. The child readiness barrier (ADR-0014) binds the same digest. Byte identity for every supported kind and version is asserted in `engine/tests/core/emission-tool-contract.test.ts`.
- **Engine gates remain authoritative.** `execute` admits arguments through `admitEmissionArguments`, which serializes deterministically and runs the registry's `parsePayload`. For reviewer payloads, this is the same full parser the extraction fallback uses. A refusal throws at the shell boundary, so the harness's real error flag is set. After selection, the issued reviewer protocol admission and the panel criterion/lens/roster joins still run. Pi-side `validateToolArguments` is treated as a structural precheck only.
- **Route qualification, not inference.** Whether a route accepts and enforces the frozen schema is recorded per route `(provider, model, Pi revision, schema digest)`. The live local route `(desktop-vllm (vLLM), glm-5.3-flash-spark-tp2-v14)`, with each frozen schema's digest recorded as `schemaDigest` in `probes/emission-qualification/recordings/probe-report.json`, was qualified on 2026-09-19 by `probes/emission-qualification/`, and its wire recordings are retained. All four frozen schemas were accepted (HTTP 200) under the production `strict: "prefer"` registration. The wire parameters were structurally equal to the frozen bytes for all four, including v2's root `oneOf`, and Pi's strictifier was a no-op. The route classifies as **unconstrained emission**: vLLM ignores the tool-level `strict` flag, and forced-`tool_choice` adversarial calls carrying `score: 12` and `verdict: "partially_upheld"` were returned at HTTP 200. Engine parsing therefore remains the guarantee. Requalification is triggered by a served-model switch, a schema digest change, or a Pi upgrade that changes tool serialization or resolver behavior. No cloud route has been qualified, and none is claimed. vLLM-native enforcement (`guided_json`/`structured_outputs`) is a Pi resolver capability and out of Loom's scope (FR-030).
- **Observability limit.** The transcript adapter (`piEmissionCallFrames` in `pi/transcript-adapter.ts`) captures a frozen shallow snapshot of the parsed arguments. Pi does not expose the generated bytes or duplicate keys at this seam. Raw-argument observation is recorded as *unavailable* wherever the harness does not expose it. It is never reported as a zero-duplicate-key measurement.
- **Pi's in-child validation retry.** When Pi-side validation fails, Pi feeds a tool-role error back to the model and re-prompts, which adds about two requests. Calibration counts these requests. The budget boundary in FR-006 notes them. They do not mint Loom semantic attempts.

## Consequences

**Positive:**
- Schema drift between issued protocol, registered tool, readiness binding and engine parser is impossible by construction, and a byte-identity test pins it per kind and version.
- Archived and current v2/v3 request bytes and issued protocol identities are unchanged. Historical replay and ADR-0009's versioning remain valid.
- No TypeBox mirror, provider payload builder or new dependency. Provider dialect handling stays in Pi's resolver, where it belongs.
- Engine-only refinements (whitespace-only prose, byte bounds, canonical paths, issuance joins) keep refusing bad payloads, whether or not a route enforces constrained sampling.
- Claims stay honest. Route classification, the unavailable raw-argument observation and the unqualified cloud routes are recorded explicitly instead of being inferred from valid-looking output.

**Negative:**
- Sampling-time constraints, where a route enforces them at all, cover only the JSON-Schema-expressible subset of the contract. Engine-only failures are caught after emission and cost a fallback or a semantic attempt.
- The only qualified route is unconstrained, so in practice the model's own compliance carries structural conformance there. The latency and quality benefit of constrained decoding is unproven until a constraining route is qualified and calibrated (ADR-0021).
- v2's root `oneOf` and other zod-emitted shapes may be rejected by strict-only providers. Fixing that would require a new schema version and issued protocol identity, not a silent rewrite.
- Each change of model, schema digest or Pi serialization requires requalification work.
- One confined `TSchema` cast at the Pi registration surface is accepted. The round-trip guard backs it, but the type system does not prove it.
- Duplicate-key behavior in generated JSON cannot be measured on Pi until the harness exposes raw arguments.
