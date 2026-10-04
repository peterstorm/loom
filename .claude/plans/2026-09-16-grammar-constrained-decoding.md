# Plan: Grammar-Constrained Decoding for Loom's Structured Agent Payloads

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md`
**Created:** 2026-09-16
**Amended:** 2026-09-19 — user-authorized quality/feasibility revision
**Status:** Architecture revision; feasibility prerequisites and fresh alignment/decomposition required. Not authorization to resume the old T2 brief.

## Summary

Keep the selected type-driven functional core: exact frozen schemas, per-kind emission tools, deterministic source selection, and unchanged final-message extraction. Correct the original plan's unsupported guarantees: provider schema support is qualified per route; JSON Schema is not the full engine parser; child readiness is demonstrated before model execution; emission and extraction failures use one existing bounded request-slot retry mechanism.

Prove one real reviewer request-to-ingestion path before expanding to the remaining kinds. Write discriminating acceptance before that integration, use minimal shared contracts and existing production exemplars, and keep the code's policy decisions in the pure core. This feature does not implement or modify the vault's G5 sequence.

### Execution checkpoint and revision boundary

At inspection on 2026-09-19, the existing TaskGraph was in execute/Wave 1 with T1 implemented, review pending, and no executing Tasks. The supported `helper set-phase --phase architecture --clear-artifact plan-alignment` loop-back was used for this revision; no guards were disabled. Implementation source files and existing T1 evidence are not rewritten by this document.

The old graph's descriptions, plan excerpts, requirement hashes, completion claims and wave schedule describe the previous plan. Do not dispatch its pending T2–T14 unchanged. Fresh alignment and supported decomposition/reconciliation must account for this revision. Preserve the previous T1 work and receipts as history; do not manufacture new completion evidence from them. Reassess the portions of T1 affected by the new selection contract before claiming the revised requirements complete.

## Architectural Decisions

### AD-1: Retain the selected type-driven FP approach and panel provenance

**Choice:** Keep `candidate-type-driven-fp` as the architectural base, with frozen-schema reuse and the existing pure spawn-admission seam.
**Why:** The user selected this candidate. The 2026-09-19 revision corrects feasibility and behavior contracts, not that selection.
**Panel manifest:** `.claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run.zOVEfIJzSl/manifest.json`.
**Recorded ranking:** type-driven-fp 23, risk-security-first 22, simplicity-first 20. These are historical panel scores, not new feasibility evidence. The candidate and verdict artifacts remain untouched.
**Rejected:** a second provider serializer, a hand-authored schema mirror, and a new generic orchestration/retry subsystem.

### AD-2: Preferred strict sampling, with exact-route qualification

**Choice:** `constrainedSampling: { type: "json_schema", strict: "prefer" }` through Pi's existing resolver. Never use strict-required sampling for this feature.
**Why:** Installed Pi 0.83.0 returns no strict flag for unsupported preferred sampling; required sampling throws. Preferred sampling does not, however, repair a provider-incompatible schema.

Qualify the exact provider/model/API, Pi revision and frozen schema digest. Distinguish:

- **Constrained emission:** the route accepts the tool schema and demonstrates the advertised JSON Schema constraints.
- **Unconstrained emission:** the route accepts the tool schema but does not enforce preferred strict sampling; engine parsing remains authoritative.
- **Extraction-only:** the harness or route cannot support the exact tool schema. Do not advertise the unsupported tool. Claude Code and unsupported historical reviewer protocols use this path explicitly.

Provider capability flags remain operator configuration. A flag, provider name or successful local schema round-trip is not live qualification. Qualification evidence is bound to the route/schema configuration; changed schema or capability configuration requires requalification. Missing access is a blocker to the corresponding evidence, never a pass. Qualification failure must not trigger a silent schema rewrite or unbounded request retries.
**Rejected:** treating all grammar-capable providers as JSON-schema-capable; rewriting frozen schemas into a provider-specific mirror; automatically upgrading a route based only on valid-looking output.

### AD-3: Model-initiated emission, terminating success

**Choice:** Do not force per-request tool selection. Use the exact tool name in new emission-enabled instructions and return `terminate: true` with a minimal acknowledgment on successful execute.
**Why:** Pi 0.83.0 documents terminating structured-output tools. This avoids an otherwise unnecessary follow-up model turn; it is not a guarantee that the model calls the tool. Extraction remains necessary.

Termination only suppresses the follow-up when every finalized result in the tool batch is terminating. Test mixed batches, cancellation and tool-only terminal capture. Do not echo large payloads in acknowledgment content. Error signaling uses the actual harness contract: execute throws at the shell boundary for a core refusal; returning an object labeled as an error does not set Pi's `isError` flag. Harness schema rejection may happen before execute and must still be observable.
**Rejected:** claiming schema constraints force tool choice; assuming a final text message always exists; relying on prompt instructions alone to remove the post-tool model turn.

### AD-4: Child readiness is a launcher barrier, not a notification

**Choice:** Parent spawn admission remains the pure batch decision. An emission-enabled child additionally needs a bounded, request-bound pre-model readiness barrier at the launcher. The launcher must not deliver/start the model prompt until the actual child's tool is registered, active, and matches the issued kind/version/schema digest.
**Why:** The parent's runtime revision proves which code the parent loaded, not what the child activated. Pi catches `before_agent_start` exceptions and continues; Loom's existing startup sweep explicitly continues after reported failures. Neither is a hard stop.

The readiness observation binds request ID, context digest, child/session identity, producer kind, schema version, schema digest and exact tool name. Missing, malformed, contradictory, inactive or wrong-request readiness fails startup before any model request. Timeout, cancellation and cleanup preserve existing infrastructure-failure semantics and release only matching reservations. No new semantic retry is minted. Error text names the actual remediation; stale resources may require `/reload`, unsupported provider schemas do not.

**Known prerequisite — RESOLVED 2026-09-19 (mechanism proven; integration allocated):** the inspected installed normal subagent launcher (`~/.pi/agent/extensions/subagent/index.ts`) starts `pi --mode json -p --no-session` with the prompt already supplied — no pre-prompt readiness exchange. The supported seam is `pi --mode rpc` with an extension-command readiness exchange: headless spawn with no prompt, `get_commands` discovery, the readiness command invoked via the RPC prompt command (no model request), the bound readiness payload (tool, schema digest, revision, child identity, active flag) through `entry_appended`, a pure gate decision plus a fail-closed `set_model` route binding, prompt delivery only on match. Missing/contradictory readiness and absent/stale extensions yield zero model requests; the in-child awaited `before_agent_start` hold is the defense-in-depth layer (throws are caught-and-continued; holds gate). Proven by `probes/emission-readiness/` (PROBE PASS 4/4 twice, counting provider substitute, installed pi 0.83.0). Owning package of the seam primitives: `@earendil-works/pi-coding-agent` (proven on installed 0.83.0; true upstream minimum unverified). The launcher edit remains a separately owned change in `~/.dotfiles/pi/extensions/subagent/index.ts` — not a hidden global-extension edit. Remaining allocated: the dotfiles launcher gate, the loom child-extension readiness command, the full AS-020 negative-control matrix through the production path. If the seam requires a change outside this repository, that change is a separately owned prerequisite: do not silently edit global extensions, add external files to this repository's Task scope, or build a second child runtime as an incidental workaround.
**Rejected:** `before_agent_start` throw/notify as a stop; declaring readiness from the parent's hash; treating absence of the extension that performs the check as successful startup.

### AD-5: One frozen schema; explicit limits on its guarantees

**Choice:** Construct tool parameters from the exact issued frozen schema bytes. Retain the byte round-trip guard and engine parsing. Do not change existing v2/v3 schema bytes or issued protocol identity in this feature.
**Why:** It prevents schema drift, not semantic mistakes or provider incompatibility.

The current reviewer v2 schema has root `oneOf`; Pi's Responses serializer forwards it unchanged with `strict: true`. Live acceptance must be tested, not inferred. A direct local probe also showed whitespace-only advisory claims/reasons passing Pi's frozen JSON Schema validation but failing `admitEmissionArguments`. Zod refinements, UTF-8/global byte bounds, canonical paths and cross-field/issuance requirements are not all enforced by the emitted JSON Schema. Keep every existing engine gate.

**Route qualification — RESOLVED for the live local route 2026-09-19:** route `(desktop-vllm (vLLM), glm-5.3-flash-spark-tp2-v14, <schema digest>)` qualified by `probes/emission-qualification/` (wire recordings retained). All four frozen schemas ACCEPTED (HTTP 200) with the production `strict: "prefer"` registration; the wire parameters are structurally equal to the frozen bytes for all four (the strictifier is a no-op — the zod bytes are already strict-compatible, including across v2's root `oneOf`). The route classifies **unconstrained emission**: vLLM ignores the OpenAI tool-level `strict` flag (decisive forced-`tool_choice` adversarial calls carried `score: 12` and `verdict: "partially_upheld"` through at HTTP 200; the v2/v3 direct calls conforming is model compliance, recorded inconclusive). The engine-authoritative design holds unchanged; no extraction-only classification. Pi-side gates verified live: canonical fixtures pass `validateToolArguments` against the exact wire parameters; malformed emissions refused with precise per-branch errors; execute round-trip proven (judge/refutation). Discovered: pi's in-child validation-retry loop (validation failure → tool-role error feedback → re-prompt, ~2 extra requests) — calibration counts it; FR-006's budget boundary notes it. vLLM-native enforcement (`guided_json`/`structured_outputs`) is a pi-ai resolver capability — FR-030 keeps it out of loom's scope. Requalification triggers: served-model switch, schema digest change, pi upgrade changing tool serialization or resolver behavior. No cloud route qualified (unspent, not claimed).

Parsed tool arguments cannot establish what duplicate keys existed in the original generated JSON. Record raw-argument observation as unavailable where the harness does not expose it. Never convert this limitation into a claimed zero-duplicate-key measurement.
**Rejected:** TypeBox mirror definitions, a provider-specific payload builder, silently changing optionality/root shape, or claiming all engine validation is now guaranteed by sampling.

### AD-6: All three producer kinds remain in scope

**Choice:** Retain `reviewer-payload` (v2 and standalone-successor v3), `judge-verdict` v1, and `refutation-verdict` v1.
**Why:** The user previously chose scope-up; this revision changes integration order, not that scope.

`producerKindsOfAgent` derives eligibility from the Agent Catalog. The issued request chooses exactly one eligible kind/version. The review-verifier Agent can produce different kinds in different issued contexts; do not activate all its possible tools or use output shape to select a decoder. Non-producer Agents receive no emission tool.
**Rejected:** kind-only lookup that conflates panel designers with judges; treating an unverified prompt marker as authority; omitting successor v3 from qualification or tests.

### AD-7: Issuance-aware instructions and honest degraded routes

**Choice:** Render new tool-primary instructions only for emission-enabled requests, naming the selected tool and one-call rule. Extraction-only requests retain appropriate final-message instructions.
**Why:** Telling Claude Code or a schema-incompatible route to call an unavailable tool is not degradation compatibility.

Keep archived v1/v2/v3 request/context bytes unchanged. The emitted descriptor is a convenience projection of authenticated request authority, not a standalone permission claim. Missing/malformed descriptors on an expected emission-enabled request fail; absence on a non-producer or explicitly extraction-only request is normal. Version and digest come from the issued packet, never from current defaults or the model's arguments.
**Rejected:** globally stamping tool-only wording into all historical/current contexts, or accepting the first marker found in prompt text.

### AD-8: One observation/selection decision with per-path payload construction

**Choice:** Normalize actual harness tool-call observations, bind them to one issued request attempt, then use one pure selection policy. Reviewer and verdict paths retain their distinct output construction and authoritative ingestion joins.
**Why:** Provenance and refusal diagnostics must be returned by the same decision, not reconstructed by callers from the input records.

The shared contract carries the expected kind/version/schema and a closed emission observation: absent, one complete call, multiple distinct calls, or unusable observation with a reason. Include tool-call identity. Adapters observe assistant tool calls, not JSON pasted in user/tool-result text. Replayed transport frames with the same identity and bytes are idempotent; contradictory duplicates refuse. Incomplete/failed tool-call observation is not silently reclassified as absence.

The selection returns either emission payload + source, extraction result + source + optional single-call refusal, or a typed rejection. Wrong kind/version/request and unusable observation reject before schema selection. Engine-only argument refusal from exactly one correctly bound complete call allows extraction as defined in AD-9. Retain the authoritative reviewer protocol admission after selection and the verdict parsers with their criterion/lens/roster bindings. No FinalPayload or serialized verdict bypasses those joins.

Keep the pure kernel in `emission-ingestion.ts`. It must not import `panel-program.ts` or I/O adapters. Shared schema definitions remain below the program layer, preventing a registry↔program import cycle. Use the existing DomainResult/immutable-record conventions; do not add branded wrappers that hide no invariant.
**Rejected:** filtering unexpected emission kinds away as though nothing happened, selecting a parser from a model-supplied version, recounting validity separately in every shell, or testing only a helper that production never calls.

### AD-9: One existing request-slot budget; no same-spawn correction protocol

**Choice:** Emission and extraction rejection use the existing semantic attempts 1 and 2. Separate diagnostic causes, not separate retry counters. This explicitly supersedes the original separate-emission-budget wording in the Spec and Plan.
**Why:** A second call is ambiguity by the retained duplicate policy. Instructing the child to correct arguments by calling again in the same spawn guarantees rejection. A second budget without a separate lifecycle was never implemented or specified coherently.

| Observation in one issued attempt | Selection / accepted source | Attempt effect |
|---|---|---|
| Zero emission calls | Existing extraction result unchanged | Accept if usable; otherwise one existing rejection |
| One complete, correctly bound call; engine arguments valid | Emission, regardless of final text | Existing issuance joins still decide admission |
| One complete, correctly bound call; engine arguments refused; final extraction usable | Extraction, retaining the emission refusal | Accept; no retry consumed |
| One refused call; extraction unusable | Typed rejection with both causes retained | One rejection, not two |
| Two distinct calls, including refused then corrected or identical arguments under different call IDs | Ambiguity, even with valid final text | One rejection |
| Exact replay of one transport call observation | Same single observation | No additional consumption/publication |
| Wrong request/kind/version or contradictory/incomplete observation | Typed refusal, never absence | Existing evidence/infrastructure classification at the boundary; no invented successful fallback |
| Startup/transport infrastructure unavailable | No semantic payload decision | Existing infrastructure recovery at the same attempt |

A semantic rejection at attempt 1 permits one fresh engine-issued attempt-2 spawn; rejection at attempt 2 is terminal. A source accepted as emission but rejected by an issuance join must not fall back to final text. Agents are instructed not to re-emit within a spawn; after one argument refusal they may finish with the documented final-message fallback. The engine remains validity/count authoritative even if the model ignores that instruction.

**Containment law:** when there are zero emission calls, or when exactly one correctly bound complete call is engine-refused and extraction is selected, the extraction result equals the existing parser's result on the same final candidates. There is deliberately no no-op-equivalence claim for duplicate or misbound calls. Property tests must assert those rejection outcomes rather than skip them under a misleading universal containment test name.

### AD-10: Acceptance and a real vertical slice before breadth

**Choice:** Phase 2 resolves risky assumptions and establishes focused behavior-first acceptance; Phase 3 wires one real reviewer path; Phase 4 expands to successor/judge/refutation and degraded harness paths.
**Why:** Schema/kernel unit tests alone cannot demonstrate provider acceptance, child startup, transcript capture or production selection.

Use `harness-capture-runtime.ts`, the issued reviewer protocol path and existing panel submission seams as reuse exemplars, with their tests. The installed Pi `examples/extensions/structured-output.ts` documents terminating success; it is a usage reference, not a second schema source. Replace redundant implementation-brief prose with these specific references and the behavior matrix. Freeze only minimal shared inputs/results needed by consumers; no automatic skeleton of every internal helper.

No new default reviewer roster, general mutation platform or G5 work is selected. Feature-local negative controls must show bypassing selection and always-accept/always-reject behavior fail the relevant acceptance cases. A missing import or an empty file is not the behavioral RED for this feature.

### AD-11: Measure useful acceptance, not only syntactic success

**Choice:** Compare emission-enabled and extraction-only operation on the same frozen runtime with matched requests, source snapshots, models, reasoning settings and token budgets.
**Why:** An unrelated old checkout or completed-only samples confound the latency and quality claims.

Before the window, record the intended deployment route matrix and a fixed workload: at least 100 paired requests per required route/schema cell (reviewer v2/v3, judge v1, refutation v1), with easy/hard cases and fixed input/seed policy where supported. Unsupported cells have explicit qualification outcomes, not fabricated constrained samples. This is a minimum operational pilot, not a statistical proof of universal non-regression. If the intended deployment has no qualified capable route, the constrained feature cannot be declared measured/done.

Measure initial dispatch through accepted ingestion, including startup, tool acknowledgments, follow-up model turns and retries. Retain terminal failures/timeouts separately and require their rate not to increase; do not hide them by reporting successful samples alone. Report p50/p95, paired sample counts, tool-use/non-emission/fallback rates, retry causes and raw-observation limits. Provider-enforced structural failures and engine-only refusals are separate series. Report effect sizes and uncertainty; inconclusive evidence is not a pass.

The p95 bound remains +25%. Use the same independent defect-severity rubric and blinded source/payload assessment for both arms, plus held-out known-defect cases; preserve disagreements and observed escapes. Required guardrail failure blocks done and triggers design reconsideration, not more retries until a favorable window appears.

## File Structure

All paths below are repository-relative unless explicitly identified as an external prerequisite. Reuse existing files before creating new abstractions.

### Pure emission and admission core

```text
engine/src/core/model-profiles.ts                 — retain catalog-derived producer kinds
engine/src/core/emission-tool.ts                  — retain frozen registry; explicit argument refusals
engine/src/core/emission-ingestion.ts             — issued binding + observation/selection result contract
engine/src/core/spawn-admission.ts                — gather-ready inputs, pure expected-capability decision
engine/src/core/harness-capture.ts                — additive emission observation/rejection vocabulary
engine/src/core/panel-contract.ts                — retain frozen judge schema and authoritative parser
engine/src/core/review-panel.ts                  — retain frozen refutation schema and authoritative parser
```

### Pi and capture shells

```text
pi/emission-tool.ts                              — register exact tool; execute parser; terminating acknowledgment
pi/emission-startup.ts                           — narrow readiness adapter once launcher prerequisite is proven
pi/extension.ts                                  — issued capability wiring, not a startup-notification substitute
pi/transcript-adapter.ts                         — complete, request-bound tool-call observations
engine/src/handlers/subagent-stop/capture-orchestration-result.ts — harness observation adapter
engine/src/orchestration/harness-capture-runtime.ts — selection, existing admission, provenance publication
engine/src/core/panel-program.ts                 — verdict selection before authoritative parse; accepted source
engine/src/handlers/helpers/orchestration.ts      — legacy panel path, same selection policy
engine/src/handlers/helpers/programs/helpers.ts  — descriptor/instruction projection from issued authority
engine/src/handlers/helpers/programs/standalone.ts — standalone/successor request integration
engine/src/handlers/helpers/programs/wave-gate.ts — Wave request integration
```

The installed external subagent launcher is not a repository artifact. Any required launcher hook must first have an identified owner, version and separate delivery plan. Do not introduce `pi/emission-startup.ts` as a pass-through if the supported launcher already exposes everything the extension needs; the adapter must earn its seam with a real startup test substitute.

### Contracts, docs and qualification

```text
engine/src/core/reviewer-contract.ts             — new-issuance wording only, schema/rubric bytes unchanged
engine/src/core/reviewer-protocol.ts             — route-aware rendered instructions and frozen issuance handling
agents/_shared/wire-contract.md                  — regenerate from the existing source
agents/README.md                                — producer flow and extraction-only behavior
agents/* reviewer shims                         — re-stamp through scripts/stamp-wire-contract.ts
CONTEXT.md                                      — emission source/readiness terminology, no G5 changes
docs/model-profiles-and-calibration.md           — exact-route qualification and operator configuration
docs/pi-usage.md                                — readiness dependency, errors and activation
scripts/run-model-calibration.ts                — matched end-to-end metrics; no new provider serializer
.claude/specs/2026-09-16-grammar-constrained-decoding/feasibility.md — measured assumptions and blockers
calibration/grammar-constrained-decoding/        — route matrix, raw observations, paired results and summary
```

### Tests

```text
engine/tests/core/emission-tool.test.ts          — engine-only refinements; frozen registry
engine/tests/core/emission-tool-contract.test.ts — byte identity for every supported kind/version
engine/tests/core/emission-ingestion.test.ts     — full selection matrix, identity/replay and exact fallback law
engine/tests/core/spawn-admission.test.ts        — expected capability and explicit extraction-only routes
engine/tests/pi/emission-tool.test.ts            — real Pi validation and terminating result semantics
engine/tests/pi/emission-startup.test.ts         — zero-request negative controls, cleanup and ready success
engine/tests/pi/emission-vertical-slice.test.ts  — real request→child→capture→ingestion path
engine/tests/core/panel-verdict-fold.test.ts      — real panel submission joins plus source selection
engine/tests/wire-contract.test.ts               — stamp/schema consistency
engine/tests/core/reviewer-protocol-docs.test.ts — new vs archived/extraction-only wording
```

Extend the existing harness-capture and transcript-adapter suites at their owning paths. Decompose must resolve their actual filenames and explicitly allocate shared-file edits; do not assign two concurrent Tasks overlapping production paths.

## Component Design

### Frozen registry and issued binding

**Responsibility:** Associate each allowed producer kind/version with its exact frozen schema and engine parser; select one through authenticated issuance.
**Files:** `model-profiles.ts`, `emission-tool.ts`, existing reviewer and verdict schema modules.
**Interface:** A parsed issued binding carries request/context/attempt identity, producer kind, supported version, exact tool name and schema digest. Reject invalid pairs at the boundary; use valid-pair types internally rather than independent string fields that allow unsupported combinations.
**Depends on:** Agent Catalog and issued request/context readers, existing schema parsers and DomainResult kernel. No Pi or provider import in the core.

### Observation and source selection

**Responsibility:** Apply AD-8/AD-9 once; return selected bytes and provenance, or a typed refusal with retained causes.
**Files:** `emission-ingestion.ts`, `harness-capture.ts`, harness adapters.
**Interface:** `selectCanonicalPayload(expected, observation, finalCandidates)` and `selectVerdictSource(expected, observation, existingRawJson)` share the observation decision, not a caller-maintained policy. The reviewer extraction arm carries its existing DomainResult; the verdict extraction arm preserves the existing raw input. Neither silently drops invalid observations or diagnostics.
**Depends on:** Issued binding, immutable observations, engine admission functions, unchanged extraction. No I/O.

### Child startup and tool execution

**Responsibility:** At the launcher seam, provision before prompt, prove actual readiness, then let model execution begin. Execute performs parser admission and returns terminating success or the harness's real error signal.
**Files:** `spawn-admission.ts`, `pi/emission-tool.ts`, `pi/extension.ts`, conditional narrow startup adapter.
**Interface:** Readiness success and startup unavailable are distinct outcomes. Timeout/cancel are infrastructure observations. Registration is idempotent only for the exact same request/kind/version/digest; a contradictory re-registration refuses. Provider exposure uses the frozen route decision.
**Depends on:** The Phase-2 proven launcher readiness hook. It is a prerequisite, not a presumed capability in today's print-mode launcher.

### Reviewer/panel ingestion and provenance

**Responsibility:** Observe → select in core → run existing issued-contract admission → persist accepted evidence and source.
**Files:** `harness-capture-runtime.ts`, capture adapters, `panel-program.ts`, legacy helper integration.
**Interface:** Record accepted source, request/call identity where applicable, schema digest and any single-call refusal that led to fallback. Do not reconstruct source in a later logger. Reuse bounded no-follow artifact publication and exact replay/idempotency patterns. Missing/corrupt required provenance is unavailable evidence, never an invented historical source.

For new reviewer captures, publish the bounded source record with the existing evidence publication/recovery mechanism before declaring acceptance complete. Panel acceptance events gain a source arm with a parser-compatible historical projection: genuinely pre-feature accepted events were extraction; malformed present-day source fields are not historical absence. Legacy deterministic operations record the same selected source through operation artifacts. No new retention policy or full payload copy in every journal event.
**Depends on:** Shared selection, issued reviewer/panel authority and existing publication/replay seams. Manual verdict/tally commands remain canonical-input parsers, not transcript scanners.

## Data Flow

```text
qualified route + authenticated issuance
→ pure parent admission
→ launcher provisions child without model prompt
→ actual child readiness (or bounded infrastructure failure)
→ model uses exact tool, or final-message fallback
→ complete request-bound transcript observations
→ pure canonical selection
→ existing issued-contract/roster/scope admission
→ immutable accepted evidence + source
```

This threads data through existing ingestion and request-slot programs; it introduces no independent lifecycle machine. The readiness barrier uses the launcher's startup/cancellation contract, not a second persisted retry lifecycle. The feature is not a Fugue pipeline; no AuthoredDag bridge is selected.

## Invariants

### INV-1: No tool constraint may demand strict sampling via strict-required mode

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-strict-require-constraint.json`
**Statement:** This feature requests JSON-schema strict sampling with `strict: "prefer"`, never strict-required mode, so lack of strict support alone cannot fail the request.

Retain the existing rule file. Its regex is a spelling guard, not proof of provider compatibility. Schema identity, selection outcomes, readiness and provenance are behavioral test obligations below, not mislabeled regex invariants. No G5 owner-map grammar is introduced here.

## Implementation Phases

### Phase 1: Existing pure-core foundation (original T1; historical baseline)

- Preserve and review the existing catalog, registry, frozen verdict schemas and source selectors. The 2026-09-19 focused run passed 58 tests across the three emission suites; this is development evidence, not a completed Wave Gate or provider/child integration proof.
- Identify the delta owed by AD-8/AD-9: explicit expected issuance, call identity, unexpected/incomplete observation refusal, and retained single-call refusal diagnostics. Do not label current kind-filtering and diagnostic-free fallback as the revised contract.
- **Files:** `engine/src/core/model-profiles.ts`, `engine/src/core/emission-tool.ts`, `engine/src/core/emission-ingestion.ts`, `engine/src/core/panel-contract.ts`, `engine/src/core/review-panel.ts`, their three emission test suites.

### Phase 2: Feasibility and minimal acceptance contract (depends on Phase 1)

- Probe every intended provider/schema route with exact bytes through the real harness serialization/validation path; record supported constraints and explicit degraded routes.
- Prove the real launcher can hold model execution until request-bound child readiness. Use a counting provider substitute to demonstrate zero calls for missing extension/tool, inactive tool, wrong version/digest/request, timeout and cancellation. Identify external ownership/version before any outside-repository prerequisite work.
- Establish minimal shared observation/selection contracts and behavior-first acceptance. Include whitespace-only schema-vs-parser disagreement, invalid-call-plus-valid-final acceptance, invalid-then-corrected duplicate rejection, exact replay, and wrong-kind/version refusal.
- Publish feasibility observations with exact commands, runtime/schema identity and evidence limits. If provider access or the launcher seam is missing, remain blocked here; tests asserting a fabricated port succeeds are not readiness proof.
- **Files:** `.claude/specs/2026-09-16-grammar-constrained-decoding/feasibility.md`, `engine/src/core/emission-ingestion.ts`, `engine/src/core/harness-capture.ts`, `engine/tests/core/emission-ingestion.test.ts`, `engine/tests/core/emission-tool.test.ts`, `engine/tests/pi/emission-tool.test.ts`, `engine/tests/pi/emission-startup.test.ts`.

### Phase 3: One reviewer v2 production vertical slice (depends on Phase 2)

- Integrate issued descriptor/route projection, pure parent capability admission, proven launcher readiness and exact tool registration.
- Execute parser admission with minimal terminating success; scan actual tool-call observations and select at the existing reviewer capture seam. Preserve existing issued reviewer admission and publish source consistently.
- Demonstrate standalone and Wave v2 binding cases, including successful tool-only completion, fallback, semantic rejection, infrastructure startup failure, and exact replay. A valid tool payload that fails issuance must not fall back to a different final message.
- Run relevant bypass/always-accept/always-reject controls against the production-path acceptance. Correct contract assumptions before breadth expansion.
- **Files:** `pi/emission-tool.ts`, `pi/emission-startup.ts` if needed, `pi/extension.ts`, `pi/transcript-adapter.ts`, `engine/src/core/spawn-admission.ts`, `engine/src/handlers/helpers/programs/helpers.ts`, `engine/src/handlers/helpers/programs/standalone.ts`, `engine/src/handlers/helpers/programs/wave-gate.ts`, `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/orchestration/harness-capture-runtime.ts`, the Pi/spawn-admission/capture suites.

### Phase 4: Remaining kinds and harness/legacy parity (depends on Phase 3)

- Add reviewer v3, judge v1 and refutation v1 through the same proven seams. Preserve v3 issuance selection and all prior-origin/coverage joins; panel parsers retain criterion/lens and complete candidate/finding coverage.
- Wire persistent and legacy panel submission paths before claiming all-kind provenance/preference. Retain exact-call identity across per-attempt scans; no selection based on output shape.
- Verify Claude Code, unsupported historical protocols and schema-incompatible routes remain explicit extraction-only, with unchanged extraction semantics. Verify unconstrained-tool routes honor the same selection matrix without strict-required failures.
- **Files:** `engine/src/core/panel-program.ts`, `engine/src/handlers/helpers/orchestration.ts`, shared request/capture adapters as needed, `engine/tests/core/panel-verdict-fold.test.ts`, reviewer successor/capture suites, `engine/tests/pi/emission-vertical-slice.test.ts`.

### Phase 5: Wire instructions, docs and complete deterministic verification (depends on Phase 4)

- Render tool-primary/new-issuance instructions and extraction-only instructions from the actual route/binding. Re-stamp shared fragments/shims through the existing script; never edit generated shims independently.
- Document capability configuration, exact-route qualification, readiness dependency/remediation, one-call semantics, shared retry budget and observability limits.
- Check all supported schema parameter byte matches at the registered tool surface, full ingestion/replay provenance, concurrency and negative controls. No unchanged-schema/unchanged-protocol claim without the exact before/after comparison.
- **Files:** `engine/src/core/reviewer-contract.ts`, `engine/src/core/reviewer-protocol.ts`, `engine/src/core/panel-program.ts`, `agents/_shared/wire-contract.md`, generated reviewer shims, `agents/README.md`, `CONTEXT.md`, `docs/model-profiles-and-calibration.md`, `docs/pi-usage.md`, wire-contract/docs suites.

### Phase 6: Preregistered calibration and release decision (depends on Phase 5)

- Add matched dispatch-to-ingestion counters to the existing calibration runner; retain per-route/schema outcomes rather than aggregate away unsupported or failed cells.
- Run AD-11's fixed pilot and record latency, retries, tool-use/fallback rate, terminal outcomes and independent quality. Missing or inconclusive measurements remain incomplete; p95 or quality/failure regression blocks done.
- Record final qualification/config/runtime identity and operator activation/reload steps. The final runtime must match the content-addressed handshake; staging/merge and loaded runtime remain distinct.
- **Files:** `scripts/run-model-calibration.ts`, `calibration/grammar-constrained-decoding/`, qualification/calibration documentation.

### Requirement completion ownership for fresh decomposition

- Phase 1/2 Tasks are foundations and generally make Requirement Contributions; earlier parser/unit evidence does not complete runtime tool requirements.
- Phase 3 completes AS-022/FR-032 only when both qualification prerequisites and the real vertical slice are demonstrated, not merely when a feasibility document exists.
- Phase 4 owns all-kind behavior completion for FR-001–FR-014 and FR-030–FR-031 and their runtime acceptance scenarios, subject to the Phase-5 exact registered-schema verification where relevant. Split contributors from one final completion Wave; do not claim cross-kind requirements complete in the reviewer-only Wave.
- Phase 5 owns FR-020–FR-022, exact registered-tool schema identity and docs requirements. Phase 6 owns the measured calibration criteria (including AS-004 and AS-015–AS-017); never assign measured completion to a unit-test-only Task.
- Decompose enumerates exact canonical FR/AS IDs from the revised Spec. NFR/SC/US remain explicit acceptance context, not invented Spec Index entries. Assign each canonical requirement one completion Wave and validate contributions/ownership normally.

## Testing Strategy

| Surface | Behavioral evidence | Discriminating control |
|---|---|---|
| Schema/engine boundary | Actual Pi validation versus engine parser for v2/v3/verdicts | Whitespace-only prose and other engine-only refinements pass shape checks but must not be ingested |
| Issued observation | Exact request/kind/version/call identity, complete/incomplete, replay | Wrong-kind/version and contradictory duplicate frames refuse rather than vanish |
| Selection | Every row of AD-9; same final input yields same extraction result in extraction-selected states | Duplicate plus valid final rejects; single invalid plus valid final accepts extraction |
| Child readiness | Real launcher/child handshake and counting provider substitute | Missing/inactive/misbound tool and failed startup produce zero model requests |
| Termination | Actual Pi tool validation/execute and tool-only settled transcript | No compulsory final text; mixed batches do not falsely promise termination |
| Reviewer integration | Real request→child→capture→issued admission | Bypassed selection, always-accept and always-reject controls are detected |
| Panel integration | Persistent and legacy submission with real criterion/lens/coverage joins | Valid shape with wrong roster/binding rejects; source cannot override issuance |
| Replay/publication | Exact accepted bytes/source survive repeat capture and recovery | Duplicate consumption, source mismatch and corrupt present-day provenance refuse |
| Degradation | Claude/extraction-only/constraint-ignoring route behavior | No unsupported tool advertised; zero-call extraction baseline remains unchanged |
| Calibration | Matched route/schema workloads and independent quality assessment | Failed/unsupported cells retained, never silently removed from the result |

Use structured valid generators plus targeted invalid mutations. Exercise both successful and rejected branches. Tests cross the same policy seam as production; pure core tests do not replace shell integration. Run focused checks during development and the complete configured suite on a quiescent workspace; do not overwrite another running Task's verification report with an unrelated partial run.

## Security & NFR Notes

- Tool arguments and prompt markers remain untrusted. Issuance selects authority and decoder; model output selects neither.
- Emission tools do no filesystem writes, commands or uploads. Transport/capture retain existing authority and no-follow publication rules.
- Readiness is bounded and tied to actual child state. Parent hashes and informative errors are not substitutes for a pre-model barrier.
- Concurrency remains per-child; do not serialize independent producer spawns globally to implement readiness or count duplicate calls. Mixed-batch behavior and cancellation are tested rather than claimed from an `executionMode` label.
- Provenance is constructed with selection and durably bound to acceptance, with honest historical absence handling and existing retention.
- Preserve route/schema evidence without logging credentials. Calibration is an experiment with limited scope, not a claim that all future payloads or code are correct.

## Verification

1. Parse the revised Spec with the real Spec Index parser and check all canonical FR/AS/OOS IDs are unique and retained. Validate executable-model declarations and the retained invariant rule through the existing helpers.
2. Independently rerun plan alignment after the Phase-2 feasibility/ownership questions have a supported resolution; the previous report is historical and cannot authorize fresh decomposition.
3. Fresh decomposition must use the revised Spec/Plan and supported TaskGraph helpers. Preserve original T1 history, allocate changed contracts explicitly, and do not reuse stale pending Task descriptions or completion claims.
4. Run focused emission/transport/capture suites during implementation. Before Wave completion/release, run `npm --prefix engine run verify` on the quiescent worktree with installed prerequisites; pre-existing or environment failures must be reported, not dismissed as success.
5. Re-stamp with the existing wire-contract script and verify schema/rubric bytes and archived request contracts remain unchanged. Exercise startup and complete ingestion through the actual installed launcher/harness, not only fakes.
6. Complete exact-route qualification and AD-11 calibration before declaring done. Retain blocked/failed observations. Activate the delivered compatible runtime through the normal reload/restart path; do not bypass the revision handshake.
