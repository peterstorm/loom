# Plan: Grammar-Constrained Decoding for Loom's Structured Agent Payloads

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md`
**Created:** 2026-09-16
**Amended:** 2026-09-16 (gap-report re-run, round 2 — AD-6/AD-7/AD-8; AD-4 stakeholder-confirm resolved)

## Summary

Payload-producing agents — the three cataloged producer payload kinds (reviewer-payload, judge-verdict, refutation-verdict) — emit structured payloads through per-kind emission tools whose parameters ARE the exact frozen payload schema bytes (three kinds, three zod-derived frozen schemas); the ingestion seams additively prefer emission-tool arguments over final-message extraction via pure total functions whose discriminated-union results carry provenance at construction — the reviewer payload path through the harness-capture seam, the panel verdict paths through the submission seams. PR #52's fail-closed extraction is retained verbatim as the deterministic fallback (containment invariant); US4 admission rides the found pure spawn-admission seam with the hard fail scoped to Pi payload-producer spawns (Claude Code degrades via extraction — AD-7); the constrained-sampling constraint is a provider request (`strict: "prefer"`), never an enforcement.

---

## Architectural Decisions

### AD-1: Approach selection (panel)

**Choice:** `candidate-type-driven-fp` as the base, with grafts from the losing candidates (below).
**Manifest:** `.claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run.zOVEfIJzSl/manifest.json` — run `run.zOVEfIJzSl`, lenses: `simplicity-first`, `type-driven-fp`, `risk-security-first`.

**Verdict summary per criterion** (validated attempt verdicts; canonical verdict files remain in the run directory):
- **extensibility:** type-driven-fp 8 — the frozen per-kind registry (EMISSION_TOOL_SPECS) makes a new producer kind a one-entry addition with compiler-guided wiring and centralizes kind→schema knowledge the other designs scatter; risk-security-first 7 — the closed capability ADT per harness × kind makes capability-aware degradation data-driven; simplicity-first 5 — the frozen bytes as parameter schema.
- **pure functional core:** type-driven-fp 9 — IngestionSelection discriminated union reusing the existing DomainResult/canonicalRecord kernel (identity.ts), with provenance constructed at the same deterministic seam that selects the source (the provenance-drift risk closed by construction); simplicity-first 8 — the frozen bytes BE the emission tool's parameters, byte-identity by construction; risk-security-first 7 — the harness's tool-argument validation is convenience, never authority.
- **codebase fit + effort:** risk-security-first 8 — the auditable containment property (fallback byte-for-byte identical in every input combination, testable as fast-check); simplicity-first 7 — the frozen bytes ARE the parameter schema (fatal flaw: under-covers the review-verifier kind and standalone-successor V3 payloads); type-driven-fp 6 — fatal flaw: `strict:"require"` throws on constraint-ignoring providers (verified in pi-ai), and the US4 admission lived in a parallel module instead of the pure spawn-admission seam.

**Computed panel ranking** (authoritative, computed by `helper panel-contract aggregate`; not recomputed):
| Candidate | Rank | Total score |
|---|---|---|
| candidate-type-driven-fp.md | 1 | 23 |
| candidate-risk-security-first.md | 2 | 22 |
| candidate-simplicity-first.md | 3 | 20 |

**User's choice:** type-driven-fp ("type driven fp yes please, i agree with panel") — same as the panel recommendation.

**Grafted strongest_ideas (synthesis):**
1. **`strict: "prefer"` replaces `strict: "require"`** (from simplicity-first; fixes the codebase-fit judge's verified fatal flaw, independently confirmed by the extensibility judge against pi-ai's `resolveJsonSchemaStrictSampling`): the constraint is a provider request, never an enforcement; `require` throws on constraint-ignoring providers so the child's requests fail and the fallback never engages — the exact new-failure-mode class FR-010/NFR-011 forbid. Enforced by INV-1 (checkable lint rule). See AD-2.
2. **Frozen-bytes-as-parameter-schema, made byte-explicit** (from simplicity-first's strongest idea): `parameters = JSON.parse(<frozen bytes>)` per kind — the base's `frozenPayloadSchemaParameters` — plus a deterministic JSON.stringify byte-match guard against the frozen bytes per kind and version, extending the existing "two contracts" test. One schema, no second serialization chain, zero new dependency. See AD-5.
3. **Containment invariant** (from risk-security-first's codebase-fit strongest idea): the PR #52 fallback stays byte-for-byte identical to today in **every** input combination, so any behavioral divergence from the no-op baseline can only originate from the validated, deterministic emission path — testable as a fast-check containment property over all input combinations.
4. **US4 admission rides the pure spawn-admission seam** (from the codebase-fit judge's fatal flaw against the recommended candidate): the pure US4 spawn-admission decision moved from the base's parallel module (`emission-tool.ts emissionToolAdmission` + child `session_start`) into `engine/src/core/spawn-admission.ts` as a new port + `SpawnGuardName` member (data on the block result); the child-side keeps a fail-loud registration self-check at the edge where registration actually happens. See AD-4.

### AD-2: Constrained sampling is a provider request, never an enforcement (`strict: "prefer"`)

**Choice:** `constrainedSampling: { type: "json_schema", strict: "prefer" }` on the emission tool definition.
**Why:** pi-ai's `resolveJsonSchemaStrictSampling` throws (`Tool "..." requires JSON-schema constrained sampling, but strict tools are unsupported`) when `config.strict === "require"` and the provider does not support strict mode — verified in the installed pi 0.83.0 package and independently by two panel judges. With `require`, the child session's requests fail and the extraction fallback never engages, violating FR-010/NFR-011's zero-new-failure-modes. `prefer` returns `undefined` for constraint-ignoring providers: the request proceeds unconstrained, exactly as today. Disclosed deviation from FR-002's literal "requiring" wording, honored in substance — the constraint is carried and capable providers grammar-constrain the tool arguments by construction.
**Rejected:**
- `strict: "require"` — throws on constraint-ignoring providers (verified twice); the fallback never engages.
- No constraint — fails FR-002 (no grammar constraining at all).

### AD-3: toolChoice (spec Open Question 1): NOT reachable from the extension seam

**Choice:** Prompt-level tool availability — FR-002's strict-sampling constraint on the tool is the closing mechanism; per-request forced selection is recorded as a pi-side future direction.
**Why:** pi 0.83.0's extension seam has no per-request tool-selection plumbing (verified: no `toolChoice`/`tool_choice` anywhere in pi's dist, docs, or engine/src; `ConstrainedSamplingConfig` is per-tool, resolution per-provider; `pi.setActiveTools()` toggles availability but cannot force selection). Reaching it would mean a custom provider wrapper — a second provider serialization surface FR-030 forbids. This resolves the spec's Open Question 1 ([NEEDS CLARIFICATION] marker): tool-call *arguments* are deterministic (fully closing the syntax-level class) while the tool call itself remains model-initiated; the arguments trust boundary is re-validated at the engine edge regardless, so determinism of the tool *call* is defense-in-depth convenience, not a security property the design depends on.

### AD-4: US4 admission rides the pure spawn-admission seam

**Choice:** The authoritative US4 (FR-008) decision lives in `engine/src/core/spawn-admission.ts` as a new port + guard (data on the block result); the child-side `before_agent_start` keeps a fail-loud registration self-check.
**Why:** The panel-recommended candidate placed the US4 admission in a parallel module (`emission-tool.ts emissionToolAdmission` + child `session_start`) — the codebase-fit judge's verified fatal flaw. The found pure spawn-admission seam (`admitPiSpawnBatch` / `SpawnAdmissionPorts` / `SpawnGuardName` / `block()`) is the authoritative gate: it provably covers the extension-not-loaded / stale-revision class from the content-addressed revision (exactly what the revision handshake exists to catch) and blocks the batch before any state mutation with an actionable error naming the missing capability and the `/reload` remediation (AS-010; AS-011 idempotent). The capability declaration is data, per harness × producer kind: Pi declares `provided` when the loaded runtime revision contains the emission-tool module and the pi package supports the registration seam (provable at spawn time from the content-addressed revision — exactly the class the revision handshake exists to catch); Claude Code declares `not-provided` with degradation `extraction` (no Loom extension seam — the capture handler's Claude JSONL payload reader keeps extraction working). The guard blocks only not-provided capabilities whose degradation class is `refuse` (Pi's declaration on a failed revision proof — US4 hard fail, `/reload` remediation); Claude Code payload-producer spawns are therefore admitted and behave exactly as today — the pi-only `/reload` remediation does not apply to them, so hard-failing them would regress providers that currently work via extraction with no remediation path (gap-report re-run ruling — see AD-7). The child-side self-check catches registration failure at the edge where registration actually happens (defense that mostly cannot fire — the spawn-side revision proof mostly covers the class; named honestly as the residual over-fortification risk).
**Gap-report re-run resolution (stakeholder-confirm, resolved):** Claude Code child sessions are the US2 capability-aware-degradation class — the US4 hard fail is scoped to Pi payload-producer spawns; the capability declaration is per-harness with the degradation class explicit on the not-provided member (see AD-7).
**Rejected:**
- `emissionToolAdmission` in `emission-tool.ts` + child `session_start` only — a parallel module diverging from the found pure spawn-admission seam (verified fatal flaw); "extension not loaded" is unobservable at the child (the `session_start` handler IS the extension — it cannot fire when the extension is absent).
- Blocking all harnesses (FR-008's letter) — hard-fails currently-working Claude Code extraction with no remediation path; rejected by the gap-report re-run ruling (AD-7).

### AD-5: One schema, no second contract — the frozen bytes ARE the emission tool's parameter schema

**Choice:** `frozenPayloadSchemaParameters(schemaBytes)` — the ONE constructor of an emission tool's `parameters` object, parsing the frozen zod-derived bytes once; plus a deterministic JSON.stringify byte-match guard against the frozen bytes per kind and version.
**Why:** Byte-identity by construction (FR-021/AS-013, SC-006): one schema, one serialization chain, no TypeBox mirror, no drift, zero new dependency. pi-ai passes `tool.parameters` verbatim into provider requests and its `validateToolArguments` explicitly handles plain JSON-schema parameters. The byte-match guard extends the existing "two contracts" test (`engine/tests/wire-contract.test.ts`), proven through a different serialization chain than the stamper writes with.
**Rejected:**
- TypeBox `Type.Object` mirror — a second serialization chain violating FR-021's one-schema rule.
- Hand-frozen schema bytes separate from zod — forbidden by the interview's tech preferences (no hand-frozen schema bytes separate from zod).

### AD-6: Judge and refutation-verdict payload production is in scope (gap-report re-run ruling)

**Choice:** Scope up — per-kind emission tools for every cataloged producer payload kind: the `"reviewer-payload"` kind (the base design, unchanged) plus new `"judge-verdict"` and `"refutation-verdict"` kinds, each with a new frozen schema (`JUDGE_VERDICT_SCHEMA_V1`, `REFUTATION_VERDICT_SCHEMA_V1` — zod-derived via the reviewer-protocol codec pattern beside their parsers) and ingestion folds for the panel/refutation paths.
**Why:** The user ruled scope-up at the gap-report re-run (round 2). The spec's summary/US1/glossary read as deliberate — the authors explicitly excluded other structured-payload paths in OOS-003 but not this one — and US1's actor explicitly includes judge and verifier kinds, so AS-004's zero-retry audit (SC-001) covers judge-kind spawns only if the design provides their emission tools. Engine-catalog verified: `isStandaloneReviewAgent` spans the reviewer and review-verifier kinds (both receiving frozen-schema reviewer packets through the subagent-stop capture path); the panel judge (`arch-judge-agent`, profile `panel-judge`) emits `JudgeVerdict` through the `capturedPanelRaw`/panel-contract ingestion path; the review-verifier kind's refutation verdict (`RefutationVerdict`, `/review-pr` panel) flows through the submission/verdict path. The producer-kind vocabulary (`PayloadProducerKind` + `producerKindsOfAgent`) lives in `model-profiles.ts` beside the catalog it derives from: the review-verifier agent is genuinely dual-payload (reviewer-payload for standalone/wave reviews, refutation-verdict for panel verdicts) and a kind-keyed-only scoping cannot express it — the `arch-panel` kind spans judges and non-judge designers, so only a catalog-derived projection (kind + profile) scopes the judge-verdict kind correctly.
**Rejected:**
- Scope-down (amend the spec so judges/verifiers are explicitly out) — the user ruled against it at the re-run; accepted without argument.
- Kind-keyed-only scoping keyed on `arch-panel` — unrepresentable: the kind spans `arch-designer-agent`/`arch-interviewer-agent` (no verdicts) and `arch-judge-agent`; only a catalog-derived projection scopes the judge-verdict kind correctly.

### AD-7: Claude Code payload-producer spawns degrade via extraction; US4 hard fail scoped to Pi (gap-report re-run ruling)

**Choice:** The proceeding reading. The spawn-admission guard blocks only not-provided capabilities whose degradation class is `refuse` (Pi's declaration on a failed revision proof — where the `/reload` remediation exists); Claude Code payload-producer spawns are declared `not-provided` with degradation `extraction` and proceed exactly as today (no Loom extension seam — the capture handler's Claude JSONL payload reader keeps extraction working; the ingestion scanner ordinarily finds zero emission records on Claude Code).
**Why:** The user ruled the proceeding reading at the gap-report re-run (round 2). The spec summary and US2 guarantee "no provider or model regresses"; hard-failing currently-working Claude Code extraction would regress functionality with no remediation path — the pi-only `/reload` remediation does not apply to Claude Code, so the actionable-error requirement (AS-010) could not be satisfied there. The degradation class is declared data on the not-provided member, making capability-aware degradation data-driven per harness (the extensibility judge's panel verdict on the closed capability ADT).
**Rejected:**
- The blocking reading (FR-008's letter) — hard-fails Claude Code spawns too, regressing currently-working extraction; the user ruled against it; the no-regression guarantee wins.

### AD-8: One emission kernel, per-path ingestion folds — the authoritative verdict parse with issuance-join stays at the submission seam

**Choice:** The shared emission kernel (`EMISSION_TOOL_SPECS`, `admitEmissionArguments`, `parseEmissionToolCallRecords`, the frozen schemas, the capability ADT, and the additive-preference / duplicate-fail-closed semantics) with per-path ingestion folds in the one module: `selectCanonicalPayload` (reviewer payload path — FinalPayload construction at the seam; the authoritative engine-side gate is the registry's schema-level parse at the selection and the tool's execute) and `selectVerdictSource` (panel verdict paths — returns the rawJson to parse; the authoritative engine-side gate is `parseJudgeVerdict`/`parseRefutationVerdict` with the panel authority's bindings at the submission seam).
**Why:** The reviewer payload path's authoritative engine-side gate is the registry's parse at the selection; the panel verdict paths' issuance-join (criterion/lens binding, candidate/finding coverage, non-increasing scores) is not expressible in a standalone schema and must stay at ingress per FR-012 — the child session cannot evaluate it. Two genuinely different pipeline shapes; two thin selection functions in the same module with the same union vocabulary is the honest structure — not a divergent parallel module (the codebase-fit judge's fatal flaw was a parallel module diverging from a found pure seam; here the emission kernel IS the shared seam and there is no single pre-existing seam covering both payload types).
**Rejected:**
- Forcing the panel verdict paths through `selectCanonicalPayload`'s FinalPayload construction — verdicts are `VerdictEnvelope` payloads, not `FinalPayload`; a type-mismatched graft.
- One over-generalized generic selection parameterized by parse — hides the two authoritative-gate placements from the type system and couples both paths to one signature.

---

## File Structure

### Emission core (engine/src/core)

```
engine/src/core/model-profiles.ts           — MODIFY: PayloadProducerKind ADT + producerKindsOfAgent projection (derived from AGENT_CATALOG — the single declarative registry)
engine/src/core/emission-tool.ts            — NEW: EMISSION_TOOL_SPECS registry (three producer kinds), EmissionToolSpec, admitEmissionArguments, PayloadSource, EmissionToolCapability, frozenPayloadSchemaParameters (pure leaf, no I/O)
engine/src/core/emission-ingestion.ts       — NEW: selectCanonicalPayload (reviewer payload path) + selectVerdictSource (panel verdict paths), IngestionSelection + VerdictSourceSelection unions (pure leaf, reuses the DomainResult kernel)
engine/src/core/spawn-admission.ts          — MODIFY: emissionToolCapability port + "emission-tool-capability" SpawnGuardName + guard in the admission sequence (blocks only degradation-"refuse" capabilities; per-harness degradation explicit)
engine/src/core/harness-capture.ts          — MODIFY: + EmissionToolCallRecord type beside FinalPayloadCandidate, + "emission-ambiguous" CaptureRejectionReason (additive; parseFinalPayload byte-verbatim untouched)
engine/src/core/panel-contract.ts           — MODIFY: + zod-derived JUDGE_VERDICT_SCHEMA_V1 frozen bytes + digest (mirrors the reviewer-protocol codec pattern beside the judge parsers)
engine/src/core/review-panel.ts             — MODIFY: + zod-derived REFUTATION_VERDICT_SCHEMA_V1 frozen bytes + digest (beside parseRefutationVerdict/serializeRefutationVerdict)
engine/src/core/panel-program.ts            — MODIFY: verdict-source fold in submitArchitectureJudgeResult / submitRefutationVerdict (the issuance-join stays before the parse, untouched); + additive `source` field on the accepted-verdict journal events; + "emission-ambiguous" rejection category; panel prompt rendering tool-primary wording
engine/src/core/reviewer-contract.ts        — MODIFY: REVIEWER_OUTPUT_CONTRACT tool-primary wording (FR-020; schema bytes + digest untouched, so CURRENT_REVIEWER_PROTOCOL is unchanged)
engine/src/core/reviewer-protocol.ts        — MODIFY: renderReviewerWireContract embeds the new wording (re-stamp via the existing script)
```

### Ingestion seam (engine/src/handlers + engine/src/orchestration)

```
engine/src/handlers/subagent-stop/capture-orchestration-result.ts  — MODIFY: Claude payload reader gains parseEmissionToolCallRecords (JSONL tool_use blocks); pass into the runtime
engine/src/orchestration/harness-capture-runtime.ts                — MODIFY: captureHarnessResult folds observed emission records through selectCanonicalPayload (the FR-003 seam change at the existing parseFinalPayload call site); publish the provenance sidecar; journal fallback engagement + emission-retry consumption
engine/src/handlers/helpers/orchestration.ts                       — MODIFY: executeDeterministicPanelOperation folds the captured panel transcript bytes through selectVerdictSource before parseJudgeVerdict/parseRefutationVerdict (capturedPanelRaw byte-verbatim untouched); additive provenance record on the operation artifacts
```

### Spawn-side emission-tool descriptor (engine/src/handlers)

```
engine/src/handlers/helpers/programs/helpers.ts    — MODIFY: + stampEmissionToolDescriptor (shared pure stamp: the LOOM_PI_EMISSION_TOOL descriptor for cataloged payload producers — producer kind + schema version, derived from the catalog projection + the spawn's payload kind, never prompt text); applied at the same spawn prompt assembly call sites that stamp the request/context digest markers (programs/standalone.ts, programs/wave-gate.ts, orchestration.ts)
```

### Pi surface (pi/)

```
pi/emission-tool.ts          — NEW: registerEmissionTools (pi.registerTool surface), execute shell over admitEmissionArguments
pi/extension.ts              — MODIFY: kind-scoped registration at before_agent_start from the engine-stamped emission-tool descriptor + child-side registration self-check + emissionToolCapability gathered into the spawn-admission ports
pi/transcript-adapter.ts     — MODIFY: parseEmissionToolCallRecords extraction (pure Pi scan for toolCall blocks)
```

### Agents, docs, protocol

```
agents/_shared/wire-contract.md   — MODIFY: tool-primary wording (FR-020); re-stamp shims via scripts/stamp-wire-contract.ts
docs/                             — MODIFY: agent README + model-profile docs (FR-022: emission-tool flow; capability flags user-side)
CONTEXT.md                        — MODIFY: "Emission tool", "Payload source", "Constrained sampling" glossary terms
scripts/stamp-wire-contract.ts    — re-run to re-stamp fragments (no code change)
```

### Tests (engine/tests)

```
engine/tests/core/emission-tool.test.ts            — NEW: registry + admission unit tests (mock-free)
engine/tests/core/emission-ingestion.test.ts       — NEW: selectCanonicalPayload + selectVerdictSource property tests (fast-check)
engine/tests/core/emission-tool-contract.test.ts   — NEW: byte-match guard vs frozen schema bytes per kind and version (three kinds)
engine/tests/core/spawn-admission.test.ts          — MODIFY: capability gate + per-harness degradation + hard fail + AS-011 idempotency
engine/tests/core/panel-verdict-fold.test.ts       — NEW: submission-seam fold tests (emission wins / extraction byte-verbatim / duplicate fail-closed) + additive source field + "emission-ambiguous" category
engine/tests/pi/emission-tool.test.ts              — NEW: pi execute shell tests (registerTool + harness validation path)
engine/tests/wire-contract.test.ts                 — MODIFY: extend the two-contracts guard to the emission tools' parameter schemas (three kinds)
engine/tests (harness-capture suites)              — MODIFY: emission-path capture outcomes (selector + sidecar + journal events)
```

---

## Component Design

### Emission tool registry

**Responsibility:** The frozen registry + ADTs mapping each of the three cataloged producer payload kinds to its emission tool spec — the one place kind→schema knowledge lives.
**Files:** `engine/src/core/emission-tool.ts` (registry + admission), `engine/src/core/model-profiles.ts` (PayloadProducerKind + producerKindsOfAgent)
**Interface:**

```ts
// model-profiles.ts — the producer-kind vocabulary lives beside the catalog it
// derives from (the single declarative registry), because the review-verifier
// agent is genuinely dual-payload and a kind-keyed-only scoping cannot express it.
type PayloadProducerKind =
  | Readonly<{ kind: "reviewer-payload" }>      // reviewer + review-verifier kinds (standalone/wave reviews)
  | Readonly<{ kind: "judge-verdict" }>         // the panel judge (arch-judge-agent, profile "panel-judge")
  | Readonly<{ kind: "refutation-verdict" }>;   // review-verifier kind (/review-pr panel verdicts)

// Derived projection of AGENT_CATALOG — never a second source. The panel-judge
// profile is unique to arch-judge-agent, so the projection composes
// isStandaloneReviewAgent + the catalog entry (kind + profile); a non-producer
// agent (arch-designer/arch-interviewer) produces an empty list.
function producerKindsOfAgent(agent: LoomAgentName): readonly PayloadProducerKind[];

// emission-tool.ts
type EmissionToolSpec = Readonly<{
  toolName: "loom_emit_reviewer_payload" | "loom_emit_judge_verdict" | "loom_emit_refutation_verdict";  // literal union — no branded newtype
  schemaVersions: Readonly<{
    // reviewer-payload:    v2 (CURRENT_REVIEWER_PROTOCOL) + v3 (standalone-successor) — unchanged from the base design
    // judge-verdict:       v1 (JUDGE_VERDICT_SCHEMA_V1 — the current external snake_case contract of serializeJudgeVerdict)
    // refutation-verdict:  v1 (REFUTATION_VERDICT_SCHEMA_V1 — the current external contract of serializeRefutationVerdict)
    [version: string]: { schemaBytes: string; parsePayload: (raw: Uint8Array) => DomainResult<unknown, ProtocolFailure> };
  }>;
}>;

const EMISSION_TOOL_SPECS: Readonly<Record<"reviewer-payload" | "judge-verdict" | "refutation-verdict", EmissionToolSpec>>; // frozen; a new producer kind is one entry + compiler-guided wiring

function frozenPayloadSchemaParameters(schemaBytes: string): unknown;
// the ONE constructor of an emission tool's parameters object (AD-5, unchanged);
// the confined TSchema cast's price is paid once per kind — the byte-identity invariant.

function admitEmissionArguments(spec: EmissionToolSpec, version: "v2" | "v3" | "v1", rawArgs: unknown): EmissionArgumentAdmission;
// the parse IS the gate at the emission edge. For reviewer-payload this is the
// SAME full schema-level parser the fallback uses; for the verdict kinds it is
// the pure schema-conformance parse of the frozen verdict schema (shape, score
// domain, prose sanitization) — the authoritative engine-side gate for verdicts
// is the submission seam's parse with the panel authority's bindings (AD-8, FR-012).

type EmissionArgumentAdmission =
  | Readonly<{ kind: "valid"; payload: unknown }>
  | Readonly<{ kind: "invalid-schema"; code: string; message: string }>;   // never-ingestable, FR-006

type EmissionToolCapability =
  | Readonly<{ kind: "provided"; schemaDigest: ArtifactDigest }>
  | Readonly<{ kind: "not-provided"; reason: string; degradation: "refuse" | "extraction" }>;
  // per harness × producer kind: Pi's declaration returns degradation "refuse"
  // on a failed revision proof (US4 hard fail — the /reload remediation exists);
  // Claude Code's declaration returns not-provided with degradation "extraction"
  // (no Loom extension seam — the US2 degradation class; the guard therefore
  // admits those spawns — AD-7).

type PayloadSource = "emission-tool" | "extraction";   // FR-009 vocabulary
```

**Depends on:** `engine/src/core/model-profiles.ts` (AGENT_CATALOG, isStandaloneReviewAgent, the panel-judge profile), `engine/src/core/panel-contract.ts` (JUDGE_VERDICT_SCHEMA_V1), `engine/src/core/review-panel.ts` (REFUTATION_VERDICT_SCHEMA_V1), `engine/src/core/reviewer-contract.ts` (frozen bytes + digest), `engine/src/core/reviewer-protocol.ts` (the same parsers the fallback uses), `engine/src/core/orchestration-contract/identity.ts` (DomainResult kernel). No pi-package import — dependency direction stays pi → engine.

### Canonical-payload selection (reviewer payload path)

**Responsibility:** The deterministic canonical-payload selection for the reviewer payload path — additive preference, fallback preservation, and duplicate rejection each a discriminated-union member; provenance constructed at the same deterministic seam that selects the source.
**Files:** `engine/src/core/emission-ingestion.ts`
**Interface:**

```ts
type IngestionSelection =
  | Readonly<{ kind: "emission-tool-arguments"; payload: FinalPayload; source: "emission-tool" }>
  | Readonly<{ kind: "final-message-extraction"; payload: FinalPayload; source: "extraction" }>
  | Readonly<{ kind: "duplicate-emission-call" }>;   // ambiguity → fail-closed to the emission-tool budget (FR-007)

function selectCanonicalPayload(
  emissionRecords: readonly EmissionToolCallRecord[],
  finalMessageCandidates: readonly FinalPayloadCandidate[],
): IngestionSelection;
```

Semantics (each a union member, testable mock-free):
- exactly one emission record with arguments valid per the registry's parsePayload → wins deterministically over final-message extraction (FR-003/AS-003); extraction is not consulted.
- zero records, or invalid records → PR #52's `parseFinalPayload` engages exactly as today (FR-004/FR-005/AS-006); invalid records are never-ingestable and one observable round of the emission-tool bounded-retry budget is consumed (FR-006) — the fallback still engages exactly as today on the same observation (containment: the new path only adds, never alters).
- more than one emission record → ambiguity → fail-closed (never ingested), observable round consumed (FR-007/AS-007).
- The "both sources present and valid" state's deterministic winner is encoded in the union, not a caller convention — the engine never chooses between interpretations; provenance cannot drift (the spec's named risk closed by construction).

**Depends on:** `engine/src/core/harness-capture.ts` (EmissionToolCallRecord, FinalPayloadCandidate, parseFinalPayload — consumed, never modified), `engine/src/core/emission-tool.ts` (parsePayload + PayloadSource), `engine/src/core/orchestration-contract/identity.ts` (DomainResult/canonicalRecord kernel).

### Verdict-source selection (panel verdict paths)

**Responsibility:** The deterministic verdict-source selection for the panel verdict paths — additive preference, fallback preservation, and duplicate rejection each a discriminated-union member; the authoritative parse with the panel authority's bindings stays at the submission seam.
**Files:** `engine/src/core/emission-ingestion.ts`
**Interface:**

```ts
type VerdictSourceSelection =
  | Readonly<{ kind: "emission-tool-arguments"; rawJson: string; source: "emission-tool" }>
  | Readonly<{ kind: "final-message-extraction"; source: "extraction" }>   // the caller's existing rawJson stands byte-verbatim
  | Readonly<{ kind: "duplicate-emission-call" }>;                          // ambiguity → fail-closed to the emission-tool budget (FR-007)

function selectVerdictSource(
  transcriptText: string,
  emissionRecords: readonly EmissionToolCallRecord[],
): VerdictSourceSelection;
```

Semantics (each a union member, testable mock-free):
- exactly one emission record with arguments valid per the registry's parsePayload for the verdict kind → its deterministically serialized arguments become the rawJson the submission seam parses (the kernel's `parseVerdictEnvelope` with the panel bindings — the authoritative engine-side gate with the issuance-join inside, FR-012 retained verbatim); final-message extraction is not consulted (FR-003/AS-003).
- zero records, or invalid records → the caller's existing rawJson stands byte-verbatim: the kernel's fail-closed extraction (`parseJudgeVerdict`/`parseRefutationVerdict`'s prose/fence admission) engages exactly as today (FR-004/FR-005/AS-006); invalid records are never-ingestable and one observable round of the emission-tool bounded-retry budget is consumed (FR-006); the capture-rejection path (no final payload) still engages exactly as today on the same observation (containment).
- more than one emission record → ambiguity → fail-closed (never ingested), observable round consumed (FR-007/AS-007).
- Provenance is constructed at the same deterministic seam that selects the source: the submit functions' fold records the selected source on the accepted-verdict journal event.

**Depends on:** `engine/src/core/emission-tool.ts` (parsePayload + PayloadSource), `engine/src/core/harness-capture.ts` (EmissionToolCallRecord — consumed, never modified), `engine/src/core/orchestration-contract/identity.ts` (DomainResult kernel).

### Spawn-admission capability gate

**Responsibility:** The authoritative US4 (FR-008) decision — refuse Pi payload-producer spawns when the constrained path cannot be provided, blocking the batch before any state mutation; Claude Code spawns degrade via extraction (AD-7).
**Files:** `engine/src/core/spawn-admission.ts` (modified minimally)
**Interface:**

```ts
// SpawnAdmissionPorts gains:
emissionToolCapability: (kind: PayloadProducerKind) => EmissionToolCapability;

// SpawnGuardName gains:
| "emission-tool-capability"

// guard in the admission sequence (itemAdmission): for each of the spawn item's
// cataloged producer kinds (producerKindsOfAgent), the capability is consulted;
// the item blocks when a not-provided capability's degradation class is "refuse",
// with an actionable error naming the missing capability and the remediation (/reload).
// A not-provided capability with degradation "extraction" (Claude Code's declaration)
// never blocks — those spawns are the US2 capability-aware-degradation class (AD-7).
```

The block is data on the result — idempotent on retry, no residual state (AS-011). The capability declaration is per-harness data: Pi declares `provided` when the loaded runtime revision contains the emission-tool module and the pi package supports the registration seam (provable at spawn time from the content-addressed revision — exactly the class the revision handshake exists to catch); Claude Code declares `not-provided` with degradation `extraction` (no Loom extension seam — the spawn-admission gate covers Pi spawns; Claude Code spawns are recorded via `engine/src/handlers/post-tool-use/record-orchestration-spawn.ts` without an admission gate and proceed exactly as today, their degradation observable via recorded provenance — US3).

**Depends on:** `engine/src/core/emission-tool.ts` (EmissionToolCapability), `engine/src/core/model-profiles.ts` (producerKindsOfAgent).

### Pi emission-tool surface

**Responsibility:** Register the per-kind emission tool; execute shell over admitEmissionArguments.
**Files:** `pi/emission-tool.ts` (NEW)
**Interface:**

```ts
registerEmissionTools(pi: ExtensionAPI, kind: PayloadProducerKind, schemaVersion: "v2" | "v3" | "v1"): void;
// registers via pi.registerTool() with:
//   parameters = frozenPayloadSchemaParameters(spec.schemaVersions[version].schemaBytes)  // AD-5
//   constrainedSampling: { type: "json_schema", strict: "prefer" }                        // AD-2, INV-1
//   executionMode: "parallel"                                                             // NFR-002
// execute calls admitEmissionArguments; a valid payload returns as the tool result
// (arguments conform by construction at the syntax level, AS-002); an invalid-schema
// refusal returns an error result the model sees and re-emits within the bounded
// budget (FR-006). For the verdict kinds the tool's execute is the syntax-level gate
// only — the authoritative engine-side gate is the submission seam's parse with the
// panel authority's bindings (AD-8, FR-012): the trust boundary is re-validated at
// the engine edge regardless, so the difference is defense-in-depth placement, not a
// security property the design depends on.
// No fs writes, no command execution, no uploads — least privilege; the transcript
// is the transport, so the tool cannot bypass the child's armed guards.
```

**Depends on:** `engine/src/core/emission-tool.ts` (registry + admission), `pi/extension.ts` (registration surface).

### Spawn-side emission-tool descriptor

**Responsibility:** The engine-stamped descriptor for cataloged payload producers — producer kind + schema version, per spawn.
**Files:** `engine/src/handlers/helpers/programs/helpers.ts` (modified; applied at the spawn prompt assembly call sites in `programs/standalone.ts`, `programs/wave-gate.ts`, `orchestration.ts`)
- `stampEmissionToolDescriptor(agent, spawnPayloadKind)` — a pure function producing the `LOOM_PI_EMISSION_TOOL` marker text from `producerKindsOfAgent(agent)` + the spawn's payload kind; a non-producer agent produces no marker (the spawn prompt is byte-identical to today — containment).
- Applied at the same engine-owned spawn prompt assembly seam that stamps the request/context digest markers into the spawn task — one mechanism family, engine-owned, never prompt text (FR-001). The descriptor disambiguates the review-verifier agent's dual payload kinds per spawn (standalone/wave review vs `/review-pr` panel verdict slot) and binds the schema version explicitly.

**Depends on:** `engine/src/core/model-profiles.ts` (producerKindsOfAgent), `engine/src/core/emission-tool.ts` (the schema-version vocabulary).

### Child-side registration self-check

**Responsibility:** Kind-scoped registration at before_agent_start + fail-loud self-check at the edge where registration actually happens.
**Files:** `pi/extension.ts` (modified minimally)
- At `before_agent_start`, the child scans its spawn context for the engine-stamped emission-tool descriptor (`LOOM_PI_EMISSION_TOOL:<producer-kind>:<schema-version>` — exposed as `event.prompt`, pi 0.83.0) and registers **only** that producer kind's tool at that schema version — per-kind scoping derived from the catalog via the engine-stamped descriptor, never minted by prompt text.
- A pure self-check verifies the tool actually registered (present in the child's tool list, schema digest matches the frozen bytes); failure surfaces an actionable error through the existing startup-sweep reporting protocol — fail loud at the edge.
- An absent descriptor (ad-hoc child, non-producer) registers nothing: the ordinary case, not an error.
- The schema version rides the descriptor for all three kinds: for reviewer-payload spawns the engine derives it from the reviewer context packet it issues (the v2-vs-v3 admission seam stays untouched — so the tool, the packet, and the ingestion seam cannot disagree about which schema bytes apply); for panel slots it is the panel verdict schema version (v1) derived from the registered panel program.

**Depends on:** `pi/emission-tool.ts`, the spawn-side descriptor stamp (`engine/src/handlers/helpers/programs/helpers.ts`), `engine/src/core/emission-tool.ts` (registry + capability).

### Panel verdict ingestion folds

**Responsibility:** Fold observed emission-tool calls in the panel transcripts through the deterministic verdict-source selection; record provenance.
**Files:** `engine/src/core/panel-program.ts` (the persistent submission seams), `engine/src/handlers/helpers/orchestration.ts` (the legacy deterministic path) — modified additively
- `submitArchitectureJudgeResult` / `submitRefutationVerdict` gain the fold: the transcript text (the captured attempt bytes the handlers already submit as `rawJson`) folds through `selectVerdictSource` BEFORE the parse; the issuance-join (resolvePanelRequest → roster → slot binding → bound criterion/lens) stays before the parse regardless (FR-012) — untouched. On the emission path the winning rawJson is the serialized arguments; on extraction the rawJson stands byte-verbatim (containment); on duplicate the existing rejection path engages with the new additive `"emission-ambiguous"` category — one mechanism (rejectionEvent → attempt advance), magnitude unchanged.
- The legacy deterministic path (`executeDeterministicPanelOperation` → `capturedPanelRaw`) gains the same fold on the captured panel transcript bytes before `parseJudgeVerdict`/`parseRefutationVerdict` (`capturedPanelRaw` byte-verbatim untouched); the duplicate case fails closed with the legacy path's existing diagnostic vocabulary.
- The helpers' `verdict`/`tally` commands (`engine/src/handlers/helpers/review-panel.ts`) read caller-attested stdin and canonical-disk bytes — not transcript ingestion — and stay untouched (named honestly).
- The accepted-verdict journal events (`architecture-judge-accepted` / `refutation-verdict-accepted`) gain the additive `source: PayloadSource` field, recorded by the same deterministic seam that selects the source; pre-feature journals (no field) read as `"extraction"` — the only path that existed. The legacy path's operation artifacts gain an additive provenance record via the existing `operationArtifact` seam (the same bounded record shape; retention inherited verbatim, FR-011).

**Depends on:** `engine/src/core/emission-ingestion.ts` (selectVerdictSource), `engine/src/core/emission-tool.ts` (the registry), `engine/src/core/panel-contract.ts` / `engine/src/core/review-panel.ts` (the frozen verdict schemas + the same parsers).

### Frozen verdict schemas

**Responsibility:** The zod-derived frozen schema bytes + digests for the two new payload kinds — one schema per verdict, no second contract (FR-021).
**Files:** `engine/src/core/panel-contract.ts` (JUDGE_VERDICT_SCHEMA_V1), `engine/src/core/review-panel.ts` (REFUTATION_VERDICT_SCHEMA_V1)
- The judge verdict schema is derived from the current external snake_case contract of `serializeJudgeVerdict` (`{ criterion, rankings: [{ candidate, score, fatal_flaw, strongest_idea }] }`); the refutation verdict schema from `serializeRefutationVerdict` (`{ criterion, verdicts: [{ finding_id, verdict, reasoning }] }`) — the SAME serialization chains the panel writes with, so the byte-match guard is proven through a different chain than the stamper writes with.
- The frozen bytes are derived via the reviewer-protocol codec pattern (`z.toJSONSchema` + `sha256Hex` digest) beside their parsers.
- The issuance-join constraints (criterion binding, candidate/finding coverage, non-increasing scores) stay in `parseJudgeVerdict`/`parseRefutationVerdict` at ingress — not expressible in a standalone schema (the spec's own glossary).

**Depends on:** `engine/src/core/panel-kernel.ts` (the envelope vocabulary the parsers validate against), `engine/src/core/reviewer-contract.ts` (the codec pattern).

### Ingestion seam extension (reviewer payload path)

**Responsibility:** Observe emission-tool calls in each harness's transcript and fold them through the deterministic selection; persist provenance.
**Files:** `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/orchestration/harness-capture-runtime.ts`, `pi/transcript-adapter.ts` (all modified additively)
- Both adapters gain one new pure extraction: `parseEmissionToolCallRecords` (Pi: `PiContentBlock` toolCall blocks; Claude: the equivalent from its JSONL `tool_use` blocks). Emission-tool arguments are OBSERVED from the transcript at ingestion time — the transcript stays immutable audit evidence; the child writes nothing to the run directory. The seam is harness-agnostic from day one; on Claude Code the scanner ordinarily finds zero records (Claude child sessions are the US2 degradation class — AD-7).
- `captureHarnessResult` gains the fold: observed emission records fold through `selectCanonicalPayload` alongside the final-message candidates (the one-line FR-003 seam change at the existing `parseFinalPayload` call site); the selected source becomes the persisted provenance.
- The duplicate case rides the existing rejection path (`terminalizeCaptureRejection` → journal → attempt advance, `SemanticAttempt` 1|2) with the new `"emission-ambiguous"` reason — one mechanism, magnitude unchanged, no second state model.
- The issuance-join checks (frozen scope, packet/generation binding, prior-assessment ordering) stay at ingress regardless of emission-tool availability (FR-012) — untouched.

**Depends on:** `engine/src/core/emission-ingestion.ts`, `engine/src/core/harness-capture.ts`, `engine/src/orchestration/run-directory-handle.ts` (publishArtifactSet / readArtifactBytes / readRunBytesNoFollow).

### Emission provenance sidecar (reviewer payload path)

**Responsibility:** One bounded sidecar record beside the transcript evidence per ingested payload: the recorded source plus the captured arguments when the emission path won, and the schema digest.
**Files:** published from `engine/src/orchestration/harness-capture-runtime.ts` via the existing `handle.publishArtifactSet` (precedent: `native-capture-observations/<requestId>.json`); record shape `{ kind, source, origin, arguments?, schemaDigest }`. Written at ingestion time by the same deterministic seam that selects the source — provenance cannot drift; read via the `readRunBytesNoFollow` no-follow convention; retention inherited verbatim (FR-011); no new retention, expiration, or deletion policy; no new fields on existing artifacts.
- Observability: the required-by-spec floor is provenance + `captureAuditLine` (existing stderr audit pattern); the design adds structured journal events for fallback engagement and emission-tool retry consumption (matching the existing `appendEvent` schemaVersion/dedupKey/recordedAtMs pattern) plus retry-round / fallback-engagement counters surfaced through `scripts/run-model-calibration.ts` — the interview's maximal interpretation, flagged honestly as intent beyond the required floor.

**Depends on:** `engine/src/core/harness-capture.ts`, `engine/src/orchestration/run-directory-handle.ts`.

### Wire contract + docs

**Responsibility:** One schema, one contract, tool-primary wording (FR-020/FR-021/FR-022).
- `REVIEWER_OUTPUT_CONTRACT` wording replaced with tool-primary wording ("Call the emission tool as the primary emission path; final-message extraction is the deterministic fallback only."), regenerating the shared fragment through the existing stamp seam (`renderReviewerWireContract()` + `scripts/stamp-wire-contract.ts`). `REVIEWER_PAYLOAD_SCHEMA_V2` bytes and their digest untouched, so `CURRENT_REVIEWER_PROTOCOL` is unchanged and issued v1/v2/v3 contracts stay valid.
- The panel prompt rendering (`engine/src/core/panel-program.ts`) gains tool-primary wording for the judge verdict and refutation verdict instructions — judges do not receive the reviewer wire contract (only reviewer roles may receive a reviewer packet), so the engine-rendered panel prompts are the verdict paths' protocol text; the toolName literal appears in the wording from the registry, never hand-minted.
- The byte-match guard extends to the emission tools' parameter schemas per kind and version, three kinds (SC-006/AS-013).
- Agent README and model-profile docs describe the emission-tool flow and state that provider capability flags remain user-side configuration (loom contributes documentation only, FR-022).
- CONTEXT.md gains the "Emission tool", "Payload source", and "Constrained sampling" glossary terms from the spec's appendix.

**Depends on:** `engine/src/core/emission-tool.ts` (the toolName literals appear in the wording), `engine/src/core/panel-program.ts` (the panel prompt rendering).

---

## Data Flow

```
Parent → spawn-admission (emission-tool-capability gate — blocks only degradation-"refuse"; correlator stamping → write grants)
       → spawn prompt assembly (the engine-stamped LOOM_PI_EMISSION_TOOL descriptor for cataloged payload producers)
       → child session (pi extension registers the descriptor's per-kind emission tool at before_agent_start; child-side self-check)
       → model calls the emission tool (pi validates args against the registered schema — fast feedback;
         execute re-parses through the registry's parsePayload — the syntax-level gate;
         minimal ack, no fs writes)
       → child transcript records the toolCall block (the transport — the child holds no run-directory authority)
       → child stops → engine ingestion:
           reviewer payload → subagent-stop (emission-tool scan → selectCanonicalPayload → sidecar + journal + audit)
           panel verdict    → submission seams (selectVerdictSource → the authoritative parse with issuance-join → accepted event + source + operation artifacts)
```

1. Spawn side (unchanged): `spawn-admission` admits the batch (the new capability gate runs before any state mutation; a not-provided capability with degradation `extraction` — Claude Code — never blocks); the spawn task carries request/context digest markers + the emission-tool descriptor; correlators are recorded into their reserved slots as today. FR-012's issuance-join checks stay untouched.
2. Child session startup: the extension loads; `before_agent_start` scans for the emission-tool descriptor (absent → registers nothing); the child-side self-check fails fast and loud (US4) through the existing startup-sweep reporting protocol if registration failed. Admitted → `pi.registerTool()` registers the per-kind tool with frozen schema bytes + `strict: "prefer"`.
3. Capable provider: the harness's constrained-sampling capability grammar-constrains the tool arguments by construction. The model calls the emission tool → pi validates args against `parameters` → the tool's `execute` re-parses through the registry's parsePayload (`admitEmissionArguments` — the syntax-level gate; for reviewer-payload the authoritative engine-side gate) → valid payload returns as the tool result; the emission record later folds into ingestion from the transcript.
4. Constraint-ignoring provider: the model emits prose/fence payloads instead of calling the tool → the ingestion seams see no emission records → deterministic fail-closed extraction engages exactly as today (US2/AS-006); observed behavior is indistinguishable from today's pipeline (FR-010/NFR-011) — the containment property.
5. Emission args fail schema validation (degraded provider): `admitEmissionArguments` refuses — never-ingestable; the tool result is an error; one observable round of the separate emission-tool bounded-retry budget is consumed (AS-007), riding the request-bound attempt tracking; the ingestion seams journal the retry consumption (FR-006); the fallback still engages exactly as today on the same observation.
6. Stop side, reviewer payload: the capture handler resolves the correlator as today; the adapters hand over every candidate final AND every emission record; `selectCanonicalPayload` folds deterministically; the selected payload's provenance is recorded in the sidecar record beside the transcript evidence (FR-009/FR-011, SC-004).
7. Stop side, panel verdicts: the panel handlers hand over the captured attempt bytes as today; `selectVerdictSource` folds deterministically before the parse; the authoritative parse with the panel authority's bindings (issuance-join) ingests the verdict; the selected source is recorded on the accepted-verdict journal event (additive `source` field) and the legacy path's operation artifacts (FR-009/FR-011, SC-004).

---

## Invariants

### INV-1: No tool constraint may demand strict sampling via `strict: "require"`

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-strict-require-constraint.json`
**Statement:** No TypeScript source may carry `strict: "require"` on a constrained-sampling constraint — pi-ai's `resolveJsonSchemaStrictSampling` throws on constraint-ignoring providers when `config.strict === "require"` (verified against pi 0.83.0), failing the child session's request so the extraction fallback never engages (FR-010/NFR-011 violation). The constraint is a provider request, never an enforcement; use `strict: "prefer"`.

(Validated: `bun /home/peterstorm/dev/claude-plugins/loom/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` → "Lint rules valid: 17 rules loaded (1 project rules)".)

Byte-identity (SC-006/AS-013 — now three kinds), selection determinism (both selection functions), the containment property, and provenance-at-construction are enforced deterministically by the test suite (named in Testing Strategy) — the spec's own measurement approach tiers them as "deterministic checks verified by tests", so they are deliberately NOT declared here as lint rules: a regex rule cannot test runtime JSON equality, and only the tests test the real property.

---

## Implementation Phases

### Phase 1: Pure emission core + verdict schemas (no dependencies)

- `engine/src/core/model-profiles.ts`: PayloadProducerKind ADT + producerKindsOfAgent projection (catalog-derived; three kinds; the dual-payload review-verifier agent).
- `engine/src/core/emission-tool.ts`: EMISSION_TOOL_SPECS registry (three producer kinds; toolName literals; per-version schemaVersions carrying the frozen bytes + the same parsers the fallback uses), EmissionArgumentAdmission + admitEmissionArguments, PayloadSource, EmissionToolCapability (degradation class explicit), frozenPayloadSchemaParameters (the ONE constructor, confined TSchema cast documented).
- `engine/src/core/panel-contract.ts` + `engine/src/core/review-panel.ts`: zod-derived JUDGE_VERDICT_SCHEMA_V1 / REFUTATION_VERDICT_SCHEMA_V1 frozen bytes + digests, mirroring the reviewer-protocol codec pattern beside their parsers.
- `engine/src/core/emission-ingestion.ts`: selectCanonicalPayload + selectVerdictSource + the two unions, reusing the DomainResult/canonicalRecord kernel.
- Byte-match guard test: `engine/tests/core/emission-tool-contract.test.ts` — the emission tools' parameter schemas byte-match the frozen payload schema bytes per kind and version (three kinds; extends the "two contracts" guard pattern).
- Unit tests (registry + admission, mock-free) and fast-check property tests (selection determinism, additive preference, containment, fallback preservation — both selection functions).
- **Files:** `engine/src/core/model-profiles.ts`, `engine/src/core/emission-tool.ts`, `engine/src/core/emission-ingestion.ts`, `engine/src/core/panel-contract.ts`, `engine/src/core/review-panel.ts`, `engine/tests/core/emission-tool.test.ts`, `engine/tests/core/emission-ingestion.test.ts`, `engine/tests/core/emission-tool-contract.test.ts`

### Phase 2: US4 gate + pi tool surface (depends on Phase 1)

- `engine/src/core/spawn-admission.ts`: `emissionToolCapability` port + `"emission-tool-capability"` SpawnGuardName + guard in the admission sequence (blocks only degradation-"refuse" capabilities, before any state mutation, names the missing capability + `/reload` remediation; degradation "extraction" never blocks).
- Spawn-side descriptor: `stampEmissionToolDescriptor` in `engine/src/handlers/helpers/programs/helpers.ts`, applied at the spawn prompt assembly call sites (`engine/src/handlers/helpers/programs/standalone.ts`, `engine/src/handlers/helpers/programs/wave-gate.ts`, `engine/src/handlers/helpers/orchestration.ts`).
- `pi/emission-tool.ts`: `registerEmissionTools` (pi.registerTool surface, `strict: "prefer"`, `executionMode: "parallel"`) + `execute` shell over `admitEmissionArguments` (no fs writes, no command execution).
- `pi/extension.ts`: kind-scoped registration at `before_agent_start` from the engine-stamped descriptor (absent descriptor registers nothing) + child-side registration self-check (fail loud through the existing startup-sweep reporting protocol) + `emissionToolCapability` gathered into the spawn-admission ports.
- Pi surface tests: registerTool + execute over the real harness validation path (including the plain-JSON-schema coercion branch).
- **Files:** `engine/src/core/spawn-admission.ts`, `engine/tests/core/spawn-admission.test.ts`, `engine/src/handlers/helpers/programs/helpers.ts`, `engine/src/handlers/helpers/programs/standalone.ts`, `engine/src/handlers/helpers/programs/wave-gate.ts`, `engine/src/handlers/helpers/orchestration.ts`, `pi/emission-tool.ts`, `pi/extension.ts`, `engine/tests/pi/emission-tool.test.ts`

### Phase 3: Reviewer payload ingestion seam + sidecar (depends on Phase 1+2)

- Both adapters gain `parseEmissionToolCallRecords` (Pi: toolCall blocks in `pi/transcript-adapter.ts`; Claude: JSONL `tool_use` blocks in `capture-orchestration-result.ts`) — pure extractions, additive.
- `engine/src/core/harness-capture.ts`: + `EmissionToolCallRecord` beside `FinalPayloadCandidate`, + `"emission-ambiguous"` CaptureRejectionReason (additive; `parseFinalPayload` byte-verbatim untouched).
- `engine/src/orchestration/harness-capture-runtime.ts`: `captureHarnessResult` folds observed emission records through `selectCanonicalPayload` (the FR-003 seam change at the existing call site); publish the provenance sidecar via `handle.publishArtifactSet`; journal fallback engagement + emission-tool retry consumption (existing `appendEvent` pattern).
- Harness-capture suites extended with emission-path capture outcomes (selector + sidecar + journal events).
- **Files:** `pi/transcript-adapter.ts`, `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/core/harness-capture.ts`, `engine/src/orchestration/harness-capture-runtime.ts`, harness-capture test suites

### Phase 4: Panel verdict ingestion folds + provenance (depends on Phase 1+2; parallel with Phase 3)

- `engine/src/core/panel-program.ts`: verdict-source fold in `submitArchitectureJudgeResult` / `submitRefutationVerdict` (the issuance-join stays before the parse, untouched); + additive `source` field on the accepted-verdict journal events; + `"emission-ambiguous"` rejection category.
- `engine/src/handlers/helpers/orchestration.ts`: `executeDeterministicPanelOperation` folds the captured panel transcript bytes through `selectVerdictSource` before `parseJudgeVerdict`/`parseRefutationVerdict` (`capturedPanelRaw` byte-verbatim untouched); additive provenance record on the operation artifacts.
- Panel verdict fold tests: submission-seam outcomes (emission wins / extraction byte-verbatim / duplicate fail-closed) + additive source field + `"emission-ambiguous"` category.
- **Files:** `engine/src/core/panel-program.ts`, `engine/src/handlers/helpers/orchestration.ts`, `engine/tests/core/panel-verdict-fold.test.ts`

### Phase 5: Wire contract + panel prompts + docs (depends on Phase 1-4)

- `REVIEWER_OUTPUT_CONTRACT` tool-primary wording (FR-020) — schema bytes + digest untouched; `renderReviewerWireContract()` re-rendered and re-stamped via `scripts/stamp-wire-contract.ts`.
- Panel prompt rendering (`engine/src/core/panel-program.ts`) tool-primary wording for the judge verdict and refutation verdict instructions (the toolName literal from the registry).
- Agent README + model-profile docs updated (FR-022: emission-tool flow; capability flags user-side).
- CONTEXT.md gains the "Emission tool", "Payload source", "Constrained sampling" glossary terms.
- `engine/tests/wire-contract.test.ts`: extend the two-contracts guard to the emission tools' parameter schemas; `engine/tests/core/reviewer-protocol-docs.test.ts` extended for the new wording.
- **Files:** `engine/src/core/reviewer-contract.ts`, `engine/src/core/reviewer-protocol.ts`, `engine/src/core/panel-program.ts`, `agents/_shared/wire-contract.md`, re-stamped shims, `docs/`, `CONTEXT.md`, `engine/tests/wire-contract.test.ts`, `engine/tests/core/reviewer-protocol-docs.test.ts`

### Phase 6: Calibration counters + calibration gate (depends on Phase 1-5)

- Retry-round / fallback-engagement counters surfaced through `scripts/run-model-calibration.ts` so US6/SC-001 evidence is collected directly — across reviewer, judge-kind, and verdict-slot spawns.
- US6 calibration window on a capable provider: p95 +25% bound (SC-002) and escaped-defect severity (SC-003) recorded as evidence before done — a gate before done, not a design driver.
- **Files:** `scripts/run-model-calibration.ts`, calibration evidence records

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| emission-tool registry | producerKindsOfAgent projection (three kinds; the dual-payload review-verifier); admitEmissionArguments valid/invalid-schema (three specs); EmissionToolCapability degradation class; frozenPayloadSchemaParameters purity (mock-free) | — | — |
| emission-ingestion selections | the three IngestionSelection union members; the three VerdictSourceSelection union members; duplicate rejection | — | fast-check: determinism (same inputs → same selection), additive preference (a valid emission record wins whenever present), containment (fallback behavior identical to the no-op baseline in every input combination where the selection is not emission-tool-arguments), fallback preserves the rejection vocabulary verbatim |
| spawn-admission gate | capability gate, per-harness degradation (refuse blocks; extraction never blocks), hard fail, AS-011 idempotency (in-memory fakes, existing ports pattern) | — | — |
| pi emission-tool surface | execute shell over admitEmissionArguments | registerTool + execute over the real harness validation path (including the plain-JSON-schema coercion branch) | — |
| ingestion seam (reviewer payload) | parseEmissionToolCallRecords extraction (both adapters, pure) | existing harness-capture suites extended: emission-path capture outcomes (selector + sidecar + journal events) | — |
| panel verdict folds | selectVerdictSource members; submitArchitectureJudgeResult/submitRefutationVerdict fold outcomes; additive source field; "emission-ambiguous" category | legacy deterministic path: executeDeterministicPanelOperation fold outcomes (selector + operation artifacts) | — |
| frozen verdict schemas | byte-match guard: the verdict emission tools' parameter schemas byte-match JUDGE_VERDICT_SCHEMA_V1 / REFUTATION_VERDICT_SCHEMA_V1, proven through a different serialization chain than the stamper writes with | — | — |
| wire contract | byte-match guard: parameter schema bytes byte-match the frozen payload schema bytes per kind/version | existing two-contracts suite (`engine/tests/wire-contract.test.ts`) | — |

---

## Security & NFR Notes

- **Security:** every trust boundary explicit and fail-closed — the harness's tool-argument validation is convenience, never authority: the tool's `execute` re-validates untrusted model input with the engine's own parser (`admitEmissionArguments` — the SAME parser the fallback uses) before any ingestion; for the verdict kinds the authoritative engine-side gate is the submission seam's parse with the panel authority's bindings (issuance-join, FR-012) — the tool's execute is the syntax-level gate only, and the trust boundary is re-validated at the engine edge regardless (defense-in-depth placement, not a security property the design depends on); the tool's execute performs no fs writes, no command execution, no uploads (least privilege — the transcript is the transport, so a compromised child cannot cascade into new write authority and the child's armed guards are not bypassable through the tool); the spawn-side capability gate blocks before any state mutation; the sidecar is bounded and no-follow-read. Disclosed residual for the `/security-expert` review the spec flags: the duplicate-key grammar class — pi collapses duplicate keys before the engine sees them, so the engine's grammar on the emitted arguments catches bytes/depth/strict-schema conformance but not duplicate keys; closing it would require a raw-args-text transport pi's tool-call plumbing does not offer, and building a second provider payload serialization is forbidden (FR-030). The verdict emission path's syntax-level gate also cannot catch cross-entry ordering (non-increasing scores) or the issuance bindings — the submission seam's parse with the panel authority's bindings catches everything (FR-012).
- **Performance:** NFR-002 holds by construction — `executionMode: "parallel"`, stateless per-child-session tool execute; concurrently spawned payload agents (now including judges and verdict slots) are not serialized beyond today's behavior. NFR-001/SC-002 (+25% p95) is the P2 calibration gate (US6).
- **Over-fortification (named):** the child-side registration self-check is a second validation layer against the stale-global-package class the spawn-side revision proof mostly covers — it mostly cannot fire; kept because it catches registration failure at the edge where registration actually happens.

---

## Verification

1. `npm --prefix engine run verify` (typecheck + unit + smoke) — all new suites pass; the worktree's typecheck has pre-existing errors (peer deps never installed in this worktree) identical before/after, zero new.
2. `bun /home/peterstorm/dev/claude-plugins/loom/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` — proves INV-1 loads (already proven: "Lint rules valid: 17 rules loaded (1 project rules)").
3. Re-stamp: `scripts/stamp-wire-contract.ts` re-run after the wording change; agent shims re-stamped byte-identical except the fragment.
4. Manual: `/reload` cutover required after merge (content-addressed revision handshake, FR-031); US6 calibration window on a capable provider recorded as evidence (SC-001 zero syntax-level retry rounds across reviewer, judge-kind, and verdict-slot spawns, SC-002 p95 +25% bound, SC-003 escaped-defect severity) before the feature is declared done — if the p95 bound is violated, the feature is not done and the design is revisited before shipping (AS-017).
