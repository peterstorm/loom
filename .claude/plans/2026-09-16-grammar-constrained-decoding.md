# Plan: Grammar-Constrained Decoding for Loom's Structured Agent Payloads

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md`
**Created:** 2026-09-16

## Summary

Payload-producing agents emit structured payloads through a per-kind emission tool whose parameters ARE the exact frozen payload schema bytes; the ingestion seam additively prefers emission-tool arguments over final-message extraction via one pure total function whose discriminated-union result carries provenance at construction. PR #52's fail-closed extraction is retained verbatim as the deterministic fallback (containment invariant); US4 admission rides the found pure spawn-admission seam; the constrained-sampling constraint is a provider request (`strict: "prefer"`), never an enforcement.

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
**Why:** The panel-recommended candidate placed the US4 admission in a parallel module (`emission-tool.ts emissionToolAdmission` + child `session_start`) — the codebase-fit judge's verified fatal flaw. The found pure spawn-admission seam (`admitPiSpawnBatch` / `SpawnAdmissionPorts` / `SpawnGuardName` / `block()`) is the authoritative gate: it provably covers the extension-not-loaded / stale-revision class from the content-addressed revision (exactly what the revision handshake exists to catch) and blocks the batch before any state mutation with an actionable error naming the missing capability and the `/reload` remediation (AS-010; AS-011 idempotent). The capability declaration is data: Pi declares `provided` when the loaded runtime revision contains the emission-tool module and the pi package supports the registration seam; Claude Code declares `not-provided` (no Loom extension seam — those spawns are the US2 capability-aware-degradation class and behave exactly as today; hard-failing them would regress providers that currently work via extraction). The child-side self-check catches registration failure at the edge where registration actually happens (defense that mostly cannot fire — the spawn-side revision proof mostly covers the class; named honestly as the residual over-fortification risk). Scoping note (stakeholder-confirm): Claude Code child sessions are the US2 degradation class — the registration seam is Loom's Pi extension per the spec's own dependency list.
**Rejected:**
- `emissionToolAdmission` in `emission-tool.ts` + child `session_start` only — a parallel module diverging from the found pure spawn-admission seam (verified fatal flaw); "extension not loaded" is unobservable at the child (the `session_start` handler IS the extension — it cannot fire when the extension is absent).

### AD-5: One schema, no second contract — the frozen bytes ARE the emission tool's parameter schema

**Choice:** `frozenPayloadSchemaParameters(schemaBytes)` — the ONE constructor of an emission tool's `parameters` object, parsing the frozen zod-derived bytes once; plus a deterministic JSON.stringify byte-match guard against the frozen bytes per kind and version.
**Why:** Byte-identity by construction (FR-021/AS-013, SC-006): one schema, one serialization chain, no TypeBox mirror, no drift, zero new dependency. pi-ai passes `tool.parameters` verbatim into provider requests and its `validateToolArguments` explicitly handles plain JSON-schema parameters. The byte-match guard extends the existing "two contracts" test (`engine/tests/wire-contract.test.ts`), proven through a different serialization chain than the stamper writes with.
**Rejected:**
- TypeBox `Type.Object` mirror — a second serialization chain violating FR-021's one-schema rule.
- Hand-frozen schema bytes separate from zod — forbidden by the interview's tech preferences (no hand-frozen schema bytes separate from zod).

---

## File Structure

### Emission core (engine/src/core)

```
engine/src/core/emission-tool.ts            — NEW: PayloadProducerKind ADT, EMISSION_TOOL_SPECS registry, EmissionToolSpec, admitEmissionArguments, PayloadSource, EmissionToolCapability, frozenPayloadSchemaParameters (pure leaf, no I/O)
engine/src/core/emission-ingestion.ts       — NEW: selectCanonicalPayload, IngestionSelection union (pure leaf, reuses the DomainResult kernel)
engine/src/core/spawn-admission.ts          — MODIFY: emissionToolCapability port + "emission-tool-capability" SpawnGuardName + guard in the admission sequence
engine/src/core/harness-capture.ts          — MODIFY: + EmissionToolCallRecord type beside FinalPayloadCandidate, + "emission-ambiguous" CaptureRejectionReason (additive; parseFinalPayload byte-verbatim untouched)
engine/src/core/reviewer-contract.ts        — MODIFY: REVIEWER_OUTPUT_CONTRACT tool-primary wording (FR-020; schema bytes + digest untouched, so CURRENT_REVIEWER_PROTOCOL is unchanged)
engine/src/core/reviewer-protocol.ts        — MODIFY: renderReviewerWireContract embeds the new wording (re-stamp via the existing script)
```

### Ingestion seam (engine/src/handlers + engine/src/orchestration)

```
engine/src/handlers/subagent-stop/capture-orchestration-result.ts  — MODIFY: Claude payload reader gains parseEmissionToolCallRecords (JSONL tool_use blocks); pass into the runtime
engine/src/orchestration/harness-capture-runtime.ts                — MODIFY: captureHarnessResult folds observed emission records through selectCanonicalPayload (the FR-003 seam change at the existing parseFinalPayload call site); publish the provenance sidecar; journal fallback engagement + emission-retry consumption
```

### Pi surface (pi/)

```
pi/emission-tool.ts          — NEW: registerEmissionTools (pi.registerTool surface), execute shell over admitEmissionArguments
pi/extension.ts              — MODIFY: kind-scoped registration at before_agent_start + child-side registration self-check + emissionToolCapability gathered into the spawn-admission ports
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
engine/tests/core/emission-ingestion.test.ts       — NEW: selectCanonicalPayload property tests (fast-check)
engine/tests/core/emission-tool-contract.test.ts   — NEW: byte-match guard vs frozen schema bytes per kind and version
engine/tests/core/spawn-admission.test.ts          — MODIFY: capability gate + hard fail + AS-011 idempotency
engine/tests/pi/emission-tool.test.ts              — NEW: pi execute shell tests (registerTool + harness validation path)
engine/tests/wire-contract.test.ts                 — MODIFY: extend the two-contracts guard to the emission tool's parameter schema
engine/tests (harness-capture suites)              — MODIFY: emission-path capture outcomes (selector + sidecar + journal events)
```

---

## Component Design

### Emission tool registry

**Responsibility:** The frozen registry + ADTs mapping each payload-producer kind to its emission tool spec — the one place kind→schema knowledge lives.
**Files:** `engine/src/core/emission-tool.ts`
**Interface:**

```ts
type PayloadProducerKind = Readonly<{ kind: "reviewer-payload" }>;
// today exactly one payload kind is expressible — the reviewer payload, serving the
// cataloged reviewer and review-verifier kinds and the wave-review roster
// (isStandaloneReviewAgent spans both; both receive frozen-schema reviewer packets).
// A tool without a cataloged producer kind is unrepresentable.

type EmissionToolSpec = Readonly<{
  toolName: "loom_emit_reviewer_payload";            // literal union — no branded newtype
  schemaVersions: Readonly<{
    v2: { schemaBytes: string; parsePayload: (raw: Uint8Array) => DomainResult<ReviewerPayloadV2, ReviewerProtocolFailure> };            // CURRENT_REVIEWER_PROTOCOL
    v3: { schemaBytes: string; parsePayload: (raw: Uint8Array) => DomainResult<StandaloneReviewerPayloadV3, ReviewerProtocolFailure> };  // standalone-successor
  }>;
}>;

const EMISSION_TOOL_SPECS: Readonly<Record<"reviewer-payload", EmissionToolSpec>>; // frozen; a new producer kind is one entry + compiler-guided wiring

function frozenPayloadSchemaParameters(schemaBytes: string): unknown;
// the ONE constructor of an emission tool's parameters object: parses the frozen
// payload schema bytes once and injects the typebox brand pi's
// ToolDefinition<TParams extends TSchema> demands. The compile-time lie is
// confined to this one function — the byte-identity invariant's price (AD-5).

type EmissionArgumentAdmission =
  | Readonly<{ kind: "valid"; payload: unknown }>
  | Readonly<{ kind: "invalid-schema"; code: string; message: string }>;   // never-ingestable, FR-006

function admitEmissionArguments(spec: EmissionToolSpec, version: "v2" | "v3", rawArgs: unknown): EmissionArgumentAdmission;
// the parse IS the gate: serializes the raw tool arguments deterministically and
// runs the registry's parsePayload — the SAME parser the fallback uses — so the
// emission path and the fallback path share one parse and one rejection vocabulary.

type EmissionToolCapability =
  | Readonly<{ kind: "provided"; schemaDigest: ArtifactDigest }>
  | Readonly<{ kind: "not-provided"; reason: string }>;

type PayloadSource = "emission-tool" | "extraction";   // FR-009 vocabulary
```

**Depends on:** `engine/src/core/reviewer-contract.ts` (frozen bytes + digest), `engine/src/core/reviewer-protocol.ts` (the same parsers the fallback uses), `engine/src/core/model-profiles.ts` (AgentKind ADT vocabulary), `engine/src/core/orchestration-contract/identity.ts` (DomainResult kernel). No pi-package import — dependency direction stays pi → engine.

### Canonical-payload selection

**Responsibility:** The deterministic canonical-payload selection — additive preference, fallback preservation, and duplicate rejection each a discriminated-union member; provenance constructed at the same deterministic seam that selects the source.
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

### Spawn-admission capability gate

**Responsibility:** The authoritative US4 (FR-008) decision — refuse payload-agent spawns when the constrained path cannot be provided, blocking the batch before any state mutation.
**Files:** `engine/src/core/spawn-admission.ts` (modified minimally)
**Interface:**

```ts
// SpawnAdmissionPorts gains:
emissionToolCapability: (kind: AgentKind["kind"]) => EmissionToolCapability;

// SpawnGuardName gains:
| "emission-tool-capability"

// guard in the admission sequence (itemAdmission): a spawn item whose cataloged
// producer kind is a payload producer blocks when the capability is not-provided,
// with an actionable error naming the missing capability and the remediation (/reload).
```

The block is data on the result — idempotent on retry, no residual state (AS-011). The capability declaration is data: Pi declares `provided` when the loaded runtime revision contains the emission-tool module and the pi package supports the registration seam (provable at spawn time from the content-addressed revision — exactly the class the revision handshake exists to catch); Claude Code declares `not-provided` (US2 degradation class — behaves exactly as today).

**Depends on:** `engine/src/core/emission-tool.ts` (EmissionToolCapability), `engine/src/core/model-profiles.ts` (cataloged producer kinds via the AgentKind ADT).

### Pi emission-tool surface

**Responsibility:** Register the per-kind emission tool; execute shell over admitEmissionArguments.
**Files:** `pi/emission-tool.ts` (NEW)
**Interface:**

```ts
registerEmissionTools(pi: ExtensionAPI, kind: PayloadProducerKind, protocolVersion: "v2" | "v3"): void;
// registers via pi.registerTool() with:
//   parameters = frozenPayloadSchemaParameters(spec.schemaVersions[version].schemaBytes)  // AD-5
//   constrainedSampling: { type: "json_schema", strict: "prefer" }                        // AD-2, INV-1
//   executionMode: "parallel"                                                             // NFR-002
// execute calls admitEmissionArguments; a valid payload returns as the tool result
// (arguments conform by construction, AS-002); an invalid-schema refusal returns an
// error result the model sees and re-emits within the bounded budget (FR-006).
// No fs writes, no command execution, no uploads — least privilege; the transcript
// is the transport, so the tool cannot bypass the child's armed guards.
```

**Depends on:** `engine/src/core/emission-tool.ts` (registry + admission), `pi/extension.ts` (registration surface).

### Child-side registration self-check

**Responsibility:** Kind-scoped registration at before_agent_start + fail-loud self-check at the edge where registration actually happens.
**Files:** `pi/extension.ts` (modified minimally)
- At `before_agent_start`, the child derives its producer kind from the engine-stamped system-prompt marker (`piSystemAgentIdentity`) and registers **only** its cataloged producer kind's tool — per-kind scoping derived from the catalog via the identity, never minted by prompt text.
- A pure self-check verifies the tool actually registered (present in the child's tool list, schema digest matches the frozen bytes); failure surfaces an actionable error through the existing startup-sweep reporting protocol — fail loud at the edge.
- An absent identity marker (ad-hoc child) registers nothing: the ordinary case, not an error.
- The protocol version rides the engine-issued spawn context packet (`reviewerProtocol` descriptor + `schemaVersion` 2 vs 3), mirroring the v2-vs-v3 admission seam which stays untouched — so the tool and the ingestion seam cannot disagree about which schema bytes apply.

**Depends on:** `pi/emission-tool.ts`, `engine/src/core/emission-tool.ts` (registry + capability), `engine/src/core/context-packets.ts` (spawn-context packet vocabulary).

### Ingestion seam extension

**Responsibility:** Observe emission-tool calls in each harness's transcript and fold them through the deterministic selection; persist provenance.
**Files:** `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/orchestration/harness-capture-runtime.ts`, `pi/transcript-adapter.ts` (all modified additively)
- Both adapters gain one new pure extraction: `parseEmissionToolCallRecords` (Pi: `PiContentBlock` toolCall blocks; Claude: the equivalent from its JSONL `tool_use` blocks). Emission-tool arguments are OBSERVED from the transcript at ingestion time — the transcript stays immutable audit evidence; the child writes nothing to the run directory. The seam is harness-agnostic from day one; on Claude Code the scanner ordinarily finds zero records (Claude child sessions are the US2 degradation class).
- `captureHarnessResult` gains the fold: observed emission records fold through `selectCanonicalPayload` alongside the final-message candidates (the one-line FR-003 seam change at the existing `parseFinalPayload` call site); the selected source becomes the persisted provenance.
- The duplicate case rides the existing rejection path (`terminalizeCaptureRejection` → journal → attempt advance, `SemanticAttempt` 1|2) with the new `"emission-ambiguous"` reason — one mechanism, magnitude unchanged, no second state model.
- The issuance-join checks (frozen scope, packet/generation binding, prior-assessment ordering) stay at ingress regardless of emission-tool availability (FR-012) — untouched.

**Depends on:** `engine/src/core/emission-ingestion.ts`, `engine/src/core/harness-capture.ts`, `engine/src/orchestration/run-directory-handle.ts` (publishArtifactSet / readArtifactBytes / readRunBytesNoFollow).

### Emission provenance sidecar

**Responsibility:** One bounded sidecar record beside the transcript evidence per ingested payload: the recorded source plus the captured arguments when the emission path won, and the schema digest.
**Files:** published from `engine/src/orchestration/harness-capture-runtime.ts` via the existing `handle.publishArtifactSet` (precedent: `native-capture-observations/<requestId>.json`); record shape `{ kind, source, origin, arguments?, schemaDigest }`. Written at ingestion time by the same deterministic seam that selects the source — provenance cannot drift; read via the `readRunBytesNoFollow` no-follow convention; retention inherited verbatim (FR-011); no new retention, expiration, or deletion policy; no new fields on existing artifacts.
- Observability: the required-by-spec floor is provenance + `captureAuditLine` (existing stderr audit pattern); the design adds structured journal events for fallback engagement and emission-tool retry consumption (matching the existing `appendEvent` schemaVersion/dedupKey/recordedAtMs pattern) plus retry-round / fallback-engagement counters surfaced through `scripts/run-model-calibration.ts` — the interview's maximal interpretation, flagged honestly as intent beyond the required floor.

**Depends on:** `engine/src/core/harness-capture.ts`, `engine/src/orchestration/run-directory-handle.ts`.

### Wire contract + docs

**Responsibility:** One schema, one contract, tool-primary wording (FR-020/FR-021/FR-022).
- `REVIEWER_OUTPUT_CONTRACT` wording replaced with tool-primary wording ("Call the emission tool as the primary emission path; final-message extraction is the deterministic fallback only."), regenerating the shared fragment through the existing stamp seam (`renderReviewerWireContract()` + `scripts/stamp-wire-contract.ts`). `REVIEWER_PAYLOAD_SCHEMA_V2` bytes and their digest untouched, so `CURRENT_REVIEWER_PROTOCOL` is unchanged and issued v1/v2/v3 contracts stay valid.
- The byte-match guard extends to the emission tool's parameter schema per kind and version (SC-006/AS-013).
- Agent README and model-profile docs describe the emission-tool flow and state that provider capability flags remain user-side configuration (loom contributes documentation only, FR-022).
- CONTEXT.md gains the "Emission tool", "Payload source", and "Constrained sampling" glossary terms from the spec's appendix.

**Depends on:** `engine/src/core/emission-tool.ts` (the toolName literal appears in the wording).

---

## Data Flow

```
Parent → spawn-admission (emission-tool-capability gate → correlator stamping → write grants)
       → child session (pi extension registers the per-kind emission tool at before_agent_start; child-side self-check)
       → model calls the emission tool (pi validates args against the registered schema — fast feedback;
         execute re-parses through the SAME parser the fallback uses — the authoritative engine-side gate;
         minimal ack, no fs writes)
       → child transcript records the toolCall block (the transport — the child holds no run-directory authority)
       → child stops → engine subagent-stop (request-bound capture; harness locator; no-follow reads;
         emission-tool scan → origin-tagged records)
       → selectCanonicalPayload (deterministic fold; provenance constructed at the same seam that selects the source)
       → sidecar provenance record + captureAuditLine stderr audit + journal events + calibration counters
```

1. Spawn side (unchanged): `spawn-admission` admits the batch (the new capability gate runs before any state mutation); the spawn task carries request/context digest markers; correlators are recorded into their reserved slots as today. FR-012's issuance-join checks stay untouched.
2. Child session startup: the extension loads; `before_agent_start` derives the payload-producer kind purely from the agent identity marker, protocol version from the engine-issued spawn context packet. Missing tool (registration failed) → fail fast and loud (US4) through the existing startup-sweep reporting protocol. Admitted → `pi.registerTool()` registers the per-kind tool with frozen schema bytes + `strict: "prefer"`.
3. Capable provider: the harness's constrained-sampling capability grammar-constrains the tool arguments by construction. The model calls the emission tool → pi validates args against `parameters` → the tool's `execute` re-parses through the registry's parsePayload (`admitEmissionArguments`) — the authoritative engine-side gate (FR-006) → valid payload returns as the tool result; the emission record later folds into ingestion from the transcript.
4. Constraint-ignoring provider: the model emits prose/fence payloads instead of calling the tool → `selectCanonicalPayload` sees no emission records → deterministic fail-closed extraction engages exactly as today (US2/AS-006); observed behavior is indistinguishable from today's pipeline (FR-010/NFR-011) — the containment property.
5. Emission args fail schema validation (degraded provider): `admitEmissionArguments` refuses — never-ingestable; the tool result is an error; one observable round of the separate emission-tool bounded-retry budget is consumed (AS-007), riding the request-bound attempt tracking; the ingestion seam journals the retry consumption (FR-006); the fallback still engages exactly as today on the same observation.
6. Stop side: the capture handler resolves the correlator as today; the adapters hand over every candidate final AND every emission record; `selectCanonicalPayload` folds deterministically; the selected payload's provenance is recorded in the sidecar record beside the transcript evidence (FR-009/FR-011, SC-004).

---

## Invariants

### INV-1: No tool constraint may demand strict sampling via `strict: "require"`

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-strict-require-constraint.json`
**Statement:** No TypeScript source may carry `strict: "require"` on a constrained-sampling constraint — pi-ai's `resolveJsonSchemaStrictSampling` throws on constraint-ignoring providers when `config.strict === "require"` (verified against pi 0.83.0), failing the child session's request so the extraction fallback never engages (FR-010/NFR-011 violation). The constraint is a provider request, never an enforcement; use `strict: "prefer"`.

(Validated: `bun /home/peterstorm/dev/claude-plugins/loom/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` → "Lint rules valid: 17 rules loaded (1 project rules)".)

Byte-identity (SC-006/AS-013), selection determinism, the containment property, and provenance-at-construction are enforced deterministically by the test suite (named in Testing Strategy) — the spec's own measurement approach tiers them as "deterministic checks verified by tests", so they are deliberately NOT declared here as lint rules: a regex rule cannot test runtime JSON equality, and only the tests test the real property.

---

## Implementation Phases

### Phase 1: Pure emission core (no dependencies)

- `engine/src/core/emission-tool.ts`: PayloadProducerKind ADT, EMISSION_TOOL_SPECS registry (toolName, per-version schemaVersions carrying the frozen bytes + the same parsers the fallback uses), EmissionArgumentAdmission + admitEmissionArguments, PayloadSource, EmissionToolCapability, frozenPayloadSchemaParameters (the ONE constructor, confined TSchema cast documented).
- `engine/src/core/emission-ingestion.ts`: selectCanonicalPayload + IngestionSelection union, reusing the DomainResult/canonicalRecord kernel.
- Byte-match guard test: `engine/tests/core/emission-tool-contract.test.ts` — the emission tool's parameter schema byte-matches the frozen payload schema bytes per kind and version (extends the "two contracts" guard pattern).
- Unit tests (registry + admission, mock-free) and fast-check property tests (selection determinism, additive preference, containment, fallback preservation).
- **Files:** `engine/src/core/emission-tool.ts`, `engine/src/core/emission-ingestion.ts`, `engine/tests/core/emission-tool.test.ts`, `engine/tests/core/emission-ingestion.test.ts`, `engine/tests/core/emission-tool-contract.test.ts`

### Phase 2: US4 gate + pi tool surface (depends on Phase 1)

- `engine/src/core/spawn-admission.ts`: `emissionToolCapability` port + `"emission-tool-capability"` SpawnGuardName + guard in the admission sequence (blocks before any state mutation, names the missing capability + `/reload` remediation).
- `pi/emission-tool.ts`: `registerEmissionTools` (pi.registerTool surface, `strict: "prefer"`, `executionMode: "parallel"`) + `execute` shell over `admitEmissionArguments` (no fs writes, no command execution).
- `pi/extension.ts`: kind-scoped registration at `before_agent_start` (producer kind from `piSystemAgentIdentity`, protocol version from the spawn-context packet) + child-side registration self-check (fail loud through the existing startup-sweep reporting protocol; absent identity marker registers nothing) + `emissionToolCapability` gathered into the spawn-admission ports.
- Pi surface tests: registerTool + execute over the real harness validation path (including the plain-JSON-schema coercion branch).
- **Files:** `engine/src/core/spawn-admission.ts`, `engine/tests/core/spawn-admission.test.ts`, `pi/emission-tool.ts`, `pi/extension.ts`, `engine/tests/pi/emission-tool.test.ts`

### Phase 3: Ingestion seam + sidecar + observability (depends on Phase 1+2)

- Both adapters gain `parseEmissionToolCallRecords` (Pi: toolCall blocks in `pi/transcript-adapter.ts`; Claude: JSONL `tool_use` blocks in `capture-orchestration-result.ts`) — pure extractions, additive.
- `engine/src/core/harness-capture.ts`: + `EmissionToolCallRecord` beside `FinalPayloadCandidate`, + `"emission-ambiguous"` CaptureRejectionReason (additive; `parseFinalPayload` byte-verbatim untouched).
- `engine/src/orchestration/harness-capture-runtime.ts`: `captureHarnessResult` folds observed emission records through `selectCanonicalPayload` (the FR-003 seam change at the existing call site); publish the provenance sidecar via `handle.publishArtifactSet`; journal fallback engagement + emission-tool retry consumption (existing `appendEvent` pattern).
- Harness-capture suites extended with emission-path capture outcomes (selector + sidecar + journal events).
- **Files:** `pi/transcript-adapter.ts`, `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/core/harness-capture.ts`, `engine/src/orchestration/harness-capture-runtime.ts`, harness-capture test suites

### Phase 4: Wire contract + docs (depends on Phase 1-3)

- `REVIEWER_OUTPUT_CONTRACT` tool-primary wording (FR-020) — schema bytes + digest untouched; `renderReviewerWireContract()` re-rendered and re-stamped via `scripts/stamp-wire-contract.ts`.
- Agent README + model-profile docs updated (FR-022: emission-tool flow; capability flags user-side).
- CONTEXT.md gains the "Emission tool", "Payload source", "Constrained sampling" glossary terms.
- `engine/tests/wire-contract.test.ts`: extend the two-contracts guard to the emission tool's parameter schema; `engine/tests/core/reviewer-protocol-docs.test.ts` extended for the new wording.
- **Files:** `engine/src/core/reviewer-contract.ts`, `engine/src/core/reviewer-protocol.ts`, `agents/_shared/wire-contract.md`, re-stamped shims, `docs/`, `CONTEXT.md`, `engine/tests/wire-contract.test.ts`, `engine/tests/core/reviewer-protocol-docs.test.ts`

### Phase 5: Calibration counters + calibration gate (depends on Phase 1-4)

- Retry-round / fallback-engagement counters surfaced through `scripts/run-model-calibration.ts` so US6/SC-001 evidence is collected directly.
- US6 calibration window on a capable provider: p95 +25% bound (SC-002) and escaped-defect severity (SC-003) recorded as evidence before done — a gate before done, not a design driver.
- **Files:** `scripts/run-model-calibration.ts`, calibration evidence records

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| emission-tool registry | PayloadProducerKind vocabulary; admitEmissionArguments valid/invalid-schema; EmissionToolCapability; frozenPayloadSchemaParameters purity (mock-free) | — | — |
| emission-ingestion selection | the three IngestionSelection union members; duplicate rejection | — | fast-check: determinism (same inputs → same selection), additive preference (a valid emission record wins whenever present), containment (fallback behavior identical to the no-op baseline in every input combination where the selection is not emission-tool-arguments), fallback preserves PR #52's rejection vocabulary verbatim |
| spawn-admission gate | capability gate, hard fail, AS-011 idempotency (in-memory fakes, existing ports pattern) | — | — |
| pi emission-tool surface | execute shell over admitEmissionArguments | registerTool + execute over the real harness validation path (including the plain-JSON-schema coercion branch) | — |
| ingestion seam | parseEmissionToolCallRecords extraction (both adapters, pure) | existing harness-capture suites extended: emission-path capture outcomes (selector + sidecar + journal events) | — |
| wire contract | byte-match guard: parameter schema bytes byte-match the frozen payload schema bytes per kind/version, proven through a different serialization chain than the stamper writes with | existing two-contracts suite (`engine/tests/wire-contract.test.ts`) | — |

---

## Security & NFR Notes

- **Security:** every trust boundary explicit and fail-closed — the harness's tool-argument validation is convenience, never authority: the tool's `execute` re-validates untrusted model input with the engine's own parser (`admitEmissionArguments` — the SAME parser the fallback uses) before any ingestion; the tool's execute performs no fs writes, no command execution, no uploads (least privilege — the transcript is the transport, so a compromised child cannot cascade into new write authority and the child's armed guards are not bypassable through the tool); the spawn-side capability gate blocks before any state mutation; the sidecar is bounded and no-follow-read. Disclosed residual for the `/security-expert` review the spec flags: the duplicate-key grammar class — pi collapses duplicate keys before the engine sees them, so the engine's grammar on the emitted arguments catches bytes/depth/strict-schema conformance but not duplicate keys; closing it would require a raw-args-text transport pi's tool-call plumbing does not offer, and building a second provider payload serialization is forbidden (FR-030).
- **Performance:** NFR-002 holds by construction — `executionMode: "parallel"`, stateless per-child-session tool execute; concurrently spawned payload agents are not serialized beyond today's behavior. NFR-001/SC-002 (+25% p95) is the P2 calibration gate (US6).
- **Over-fortification (named):** the child-side registration self-check is a second validation layer against the stale-global-package class the spawn-side revision proof mostly covers — it mostly cannot fire; kept because it catches registration failure at the edge where registration actually happens.

---

## Verification

1. `npm --prefix engine run verify` (typecheck + unit + smoke) — all new suites pass; the worktree's typecheck has pre-existing errors (peer deps never installed in this worktree) identical before/after, zero new.
2. `bun /home/peterstorm/dev/claude-plugins/loom/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` — proves INV-1 loads (already proven: "Lint rules valid: 17 rules loaded (1 project rules)").
3. Re-stamp: `scripts/stamp-wire-contract.ts` re-run after the wording change; agent shims re-stamped byte-identical except the fragment.
4. Manual: `/reload` cutover required after merge (content-addressed revision handshake, FR-031); US6 calibration window on a capable provider recorded as evidence (SC-001 zero syntax-level retry rounds, SC-002 p95 +25% bound, SC-003 escaped-defect severity) before the feature is declared done — if the p95 bound is violated, the feature is not done and the design is revisited before shipping (AS-017).
