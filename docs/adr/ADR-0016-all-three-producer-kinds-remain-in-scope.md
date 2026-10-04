# ADR-0016: All three producer kinds remain in scope

## Status
Accepted

## Context
Grammar-constrained decoding gives Loom's structured Agent payloads a tool-call emission path that runs alongside the existing final-message extraction. Three payload families are produced today: reviewer payloads (`reviewer-payload`, which has the current v2 protocol and the standalone-successor v3 protocol), architecture-panel judge verdicts (`judge-verdict` v1), and `/review-pr` refutation-panel verdicts (`refutation-verdict` v1). Each has its own frozen schema, engine parser, and authoritative ingestion joins: reviewer protocol admission, and panel criterion/lens/roster coverage.

The user originally chose to scope up to all three kinds. The 2026-09-19 revision reordered the work. One real reviewer request-to-ingestion path has to be proven first (Phase 3). Breadth comes afterwards (Phase 4, ADR-0020). That reordering made it tempting to shrink scope to the reviewer path alone, or to leave successor v3 out of qualification and tests because it is "just another reviewer version". The user did not authorize either reduction.

Eligibility is the second force. A producer kind cannot be inferred from an Agent's catalog kind alone. The `arch-panel` catalog kind covers both the judge (`arch-judge-agent`, unique `panel-judge` profile) and non-judge designers. The `review-verifier` Agent produces two kinds: reviewer payloads in standalone and Wave reviews, and refutation verdicts in `/review-pr` panels. Prompt text, an emitted descriptor, or the shape of a model's output could each claim a kind. None of them is authenticated authority, and treating any of them as authority would let task text upgrade extraction-only spawns or choose the wrong decoder.

## Options Considered

1. **Keep all three kinds and both reviewer versions. Eligibility comes from the catalog, and issuance selects exactly one kind/version per request** (chosen)
   - Pros: Honors the user's scope decision. Every structured payload family gets the same emission/selection/provenance contract, so no single kind is left as the odd one out. The catalog projection scopes judges and the dual-payload verifier correctly. One registry cell per request makes the decoder an issuance fact rather than an output-shape guess.
   - Cons: The surface to qualify and calibrate is larger: four route/schema cells (reviewer v2, reviewer v3, judge v1, refutation v1), each needing qualification and ≥100 paired pilot requests. Phase 4 has to wire persistent and legacy panel submission paths as well as the successor path.

2. **Narrow to `reviewer-payload` only (v2, optionally v3) and defer the verdict kinds**
   - Pros: Less implementation and calibration work, and faster to a first measured result.
   - Cons: Reverses a scope decision the user made. The revision changed integration order, not scope. Panel verdicts would stay extraction-only with a different provenance story. Tool-primary instructions would be split by kind, and a verdict path added later would come without the shared selection kernel's proofs.

3. **Keep all kinds, but look up eligibility by catalog kind only (`arch-panel` → judge-verdict, `review-verifier` → one kind)**
   - Pros: A simpler lookup that needs no profile data.
   - Cons: Treats every `arch-panel` designer as a judge, which would hand non-judges an emission tool. It also cannot express the review-verifier's two payloads. Rejected.

4. **Keep all kinds, but select the kind/decoder from a prompt marker, the descriptor alone, or the emitted payload's shape; or activate every tool an Agent could possibly produce**
   - Pros: No issued-authority plumbing is needed.
   - Cons: An unverified marker or output shape is model- or task-controlled input, not authority. Activating every possible tool on the review-verifier makes cross-kind emission representable and makes it impossible to tell which decoder applies. Rejected under ADR-0017/ADR-0018.

5. **Keep all kinds, but omit successor v3 from qualification and tests**
   - Pros: One less schema cell to qualify and calibrate.
   - Cons: v3 is a separate frozen schema with its own parser, issuance selection, and prior-origin/coverage joins, so evidence from v2 says nothing about it. Shipping an unqualified, untested v3 emission path would claim coverage it does not have. Rejected.

## Decision
**Retain `reviewer-payload` (v2 and standalone-successor v3), `judge-verdict` v1, and `refutation-verdict` v1 in scope. Eligibility comes from the Agent Catalog, and each request's authenticated issuance selects exactly one eligible kind/version.**

- **Frozen registry.** `EMISSION_TOOL_SPECS` in `engine/src/core/emission-tool.ts` maps every `PayloadProducerKindName` to its tool (`loom_emit_reviewer_payload`, `loom_emit_judge_verdict`, `loom_emit_refutation_verdict`) and its per-version frozen schema bytes plus engine parser: reviewer v2 → `REVIEWER_PAYLOAD_SCHEMA_V2`/`parseReviewerPayloadV2`, reviewer v3 → `STANDALONE_REVIEWER_SCHEMA_V3`/`parseStandaloneReviewerPayloadV3`, and the verdict v1 schemas → `verdictArgsParser`. The `satisfies Record<PayloadProducerKindName, EmissionToolSpec>` check is exhaustive over the kind union, so a kind without a cell fails to compile.
- **Catalog-derived eligibility.** `producerKindsOfAgent` in `engine/src/core/model-profiles.ts` is a derived projection of `AGENT_CATALOG`, never a second source. Here is how it maps Agents to kinds:
  - `reviewer` and `review-verifier` produce `reviewer-payload`.
  - `review-verifier` additionally produces `refutation-verdict`, in that fixed order.
  - Only the `arch-panel` Agent carrying the `panel-judge` profile produces `judge-verdict`.
  - Every other Agent, including non-judge panel designers, produces nothing.

  `assertPanelJudgeProfileUnique` enforces at module load that `panel-judge` is unique, so a second judge Agent fails at import instead of mis-scoping the kind. The result is total over the catalog and frozen.
- **One kind per issued request.** The parent spawn admission in `engine/src/core/spawn-admission.ts` reads the issued request authority. It checks that the claimed `producerKind` is in the Agent's eligible set and that the independently issued route is not extraction-only. It then mints exactly one expected `IssuedEmissionBinding` from the issued claim through `issueEmissionBinding`, and requires both the issued route binding and the task's emission descriptor to equal it exactly. The descriptor is an untrusted projection, never a source of authority. `issueEmissionBinding` is the only mint. It refuses an unknown kind, an unsupported version, a mismatched tool name, or a mismatched schema digest. Version and digest come from the issued packet and the frozen bytes, never from current defaults or the model's arguments. An ineligible claim with an absent descriptor gets `no-emission-tool`. An ineligible claim that carries a descriptor is refused, because extraction-only authority cannot be upgraded by task text.
- **No multi-tool activation, no shape-based decoding.** The review-verifier's child registers only the tool of its issued kind, so it never gets both. `IssuedEmissionBindingOf<K>` makes the reviewer path (`selectCanonicalPayload`) and the verdict path (`selectVerdictSource`) separate at the type level, so a binding minted for one cannot be passed to the other. A call naming a different kind/version/request is a typed refusal before any schema is selected (ADR-0018).
- **Non-producers get no emission tool.** An Agent whose `producerKindsOfAgent` result is empty is never provisioned an emission tool and stays on unchanged extraction.
- **Qualification and tests cover all four cells.** Route qualification (`probes/emission-qualification/`) and the calibration pilot (`calibration/grammar-constrained-decoding/`) treat reviewer v2, reviewer v3, judge v1, and refutation v1 as separate required cells. Phase 4 wires v3 issuance selection with its prior-origin/coverage joins and the persistent and legacy panel submission paths through the same seams as the Phase 3 vertical slice. The tests behind this are `engine/tests/pi/emission-vertical-slice.test.ts`, `engine/tests/core/panel-verdict-fold.test.ts`, the reviewer successor/capture suites, and the `emission-tool`/`emission-ingestion` core suites.

## Consequences

**Positive:**
- The user's scope decision holds: every structured payload family shares one emission/selection/provenance contract (ADR-0018/ADR-0019) and one bounded request-slot retry budget.
- Eligibility is a catalog-derived fact enforced at load and at admission. Non-judge designers and non-producer Agents cannot obtain an emission tool, and the dual-payload verifier is modeled correctly.
- Decoder selection is an issuance fact. Output shape, prompt markers, and model-supplied versions cannot route a payload to the wrong parser.
- Adding a producer kind later means one registry entry plus compiler-guided wiring, because the exhaustive `satisfies` check and the closed kind union point to every site that needs it.

**Negative:**
- Qualification and calibration cost grows to four route/schema cells. Each served-model switch, schema-digest change, or Pi upgrade that changes tool serialization requires requalifying all four.
- Phase 4 breadth (successor v3 joins, persistent and legacy panel submission paths) adds integration risk after the Phase 3 slice. The reviewer v2 proof does not carry over automatically.
- `judge-verdict` scoping depends on the catalog fact that `panel-judge` is unique, which is enforced by a load-time assertion and tests rather than by the type system.
- The review-verifier needs per-request issued authority to pick its kind. Spawn paths that cannot supply that authority must stay extraction-only. They cannot fall back to a default kind.
