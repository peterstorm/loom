# ADR-0018: One observation/selection decision with per-path payload construction

## Status
Accepted

## Context
Grammar-constrained decoding (plan `.claude/plans/2026-09-16-grammar-constrained-decoding.md`) adds a second way for a structured-payload producer to deliver its payload: a per-kind emission tool call, alongside the existing final-message extraction (PR #52's `parseFinalPayload`). There are three producer kinds: `reviewer-payload` v2/v3, `judge-verdict` v1 and `refutation-verdict` v1. They enter the engine on two different ingestion paths. The reviewer path builds canonical `FinalPayload` bytes in the harness capture runtime and then passes them through authoritative reviewer protocol admission. The verdict paths hand `rawJson` to the panel submission seam, which parses it under the issuance's criterion, lens and roster bindings. On every path, one issued request attempt now has two candidate sources, and something has to choose between them.

Several forces make that choice harder than it looks. Harness transcripts are noisy: transport frames can be replayed, frames can arrive incomplete or failed, two frames can share a tool-call identity but carry different contents, a call can be bound to the wrong request, kind or version, and a model can call the tool more than once in one spawn. JSON that a model pastes into user or tool-result text is not an emission. Each of these must have exactly one outcome. That outcome must carry its own provenance (which source won, and which call) and its own refusal diagnostics (why emission was refused, and both causes when emission and extraction both fail). If callers rebuild that information from the input records, the shells drift apart. The pre-revision code filtered emission calls by kind and fell back without diagnostics, which hid misbound calls and lost the reason a call was refused.

The decision also feeds the retry budget (ADR-0019: one existing request-slot budget). The selection result decides whether an attempt is accepted, consumes one semantic rejection, or counts as an evidence/infrastructure refusal. If two shells interpreted the same observation differently, the same transcript could consume different budgets depending on the path. Finally, layering limits where this logic can live. `panel-program.ts` is a declared pure module and the shared schema registry sits below the program layer, so the decision must not create a registry-to-program import cycle and must not pull I/O into the core.

## Options Considered

1. **One pure observation fold plus one binding/count decision, shared by per-path selection functions (chosen)**
   - Pros: each transcript has exactly one interpretation; provenance and refusals come back from the same decision that made the choice; the ADR-0019 behavior matrix can be tested once, exhaustively, against the function production calls; replay idempotence and contradiction refusal live in one fold; and each path keeps its own output construction and authoritative joins.
   - Cons: two selection functions with slightly different result unions (the verdict path has no `refused-call-no-fallback` arm) need documentation and tests to keep them aligned; the kernel's closed unions must change whenever a new observation state appears; and the panel core has to mirror the kernel's result shapes structurally across an injected port.

2. **Per-shell selection (each ingestion shell interprets observations and counts validity itself)**
   - Pros: each path is fully local; no shared contract to version.
   - Cons: this is rejected as "recounting validity separately in every shell". Replay, contradiction, misbinding and duplicate handling would be implemented two or three times and drift apart; the same transcript could consume different budgets on different paths; and the diagnostics would be rebuilt from input records instead of returned by the decision.

3. **Kind-filtering selection (drop emission calls whose kind does not match and treat the rest as the observation)**
   - Pros: simple; it was the shape of the pre-revision code.
   - Cons: this is rejected as "filtering unexpected emission kinds away as though nothing happened". A misbound or unexpected call quietly becomes absence, so extraction can succeed over a call the engine should have refused. In verdict attempts the count spans both kinds inconsistently, and the misbinding never reaches diagnostics.

4. **Self-describing payload dispatch (choose the parser from the version or kind carried in the model's arguments)**
   - Pros: no issued binding has to be threaded through the call.
   - Cons: this is rejected as "selecting a parser from a model-supplied version". The model decides which decoder runs, which reverses the authority relationship. A judge-shaped payload in a reviewer attempt could select its own decoder.

5. **Unified payload construction (one selector that also builds the final artifact and bypasses the path-specific joins)**
   - Pros: a single function from transcript to admitted artifact.
   - Cons: it would merge reviewer protocol admission with the panel parsers' criterion, lens and roster bindings, or skip them. A selected `FinalPayload` or serialized verdict could then avoid the authoritative issuance joins, which the plan explicitly forbids. It would also couple the pure kernel to `panel-program.ts`.

## Decision
**Fold harness tool-call observations once, bind every observed call to the one issued request attempt, decide by distinct-call count in one pure kernel, and let each path build its own payload from that decision before its unchanged authoritative join.**

**Observation (`engine/src/core/emission-observation.ts`).**
- `observeEmissionCalls(frames)` is the single fold from transport frames to the closed `EmissionObservation`, which has four arms: `absent | single-call | multiple-calls | unusable{reason}`.
- The fold does not look at the binding. It groups frames by tool-call identity:
  - Exact replays are idempotent.
  - Contradictory frames that share an identity make the observation `unusable`, and the reason names the first differing field in order: request id, kind, version, arguments.
  - Any incomplete or failed frame makes the observation `unusable`. It is never reclassified as absence.
  - A call with an empty identity makes the observation `unusable`.
- Distinct identities are counted in first-observed order.
- Adapters supply only assistant tool-call frames. Text in user or tool-result content is never an observation.
- `canonicalCall` projects every call to its contract fields (`requestId`, `toolCallId`, `kind`, `version`, `arguments`), so selection never depends on how much provenance an adapter attached.
- The refusal vocabulary is closed. `EmissionObservationRefusalCode` has four values: `unusable-observation | wrong-request | unexpected-kind | unexpected-version`.

**Selection kernel (`engine/src/core/emission-ingestion.ts`).** The decision runs in a fixed order:
1. An unusable observation refuses.
2. Every observed call is checked against the issued binding, in order: request attempt, then producer kind, then schema version. A misbound call is never filtered out, never decoded with its own decoder, and never absorbed into an ambiguity count.
3. The distinct-call count decides: zero means extraction verbatim, one goes to schema admission, two or more is `duplicate-emission-call`, and that arm carries the observed calls.
4. Only the single-call state reaches `admitIssuedEmissionArguments`: the schema-driven wire-form canonicalization, then the parse through the issued binding's frozen registry cell. The Pi execute shell admits through the same function. The binding is nominal (only `issueEmissionBinding` mints it), so its registry cell is certified by type and the kernel does not re-verify it.

Wrong kind, version or request, and unusable observations, therefore reject before schema selection. They are refusals, not absence.

Two functions share this decision and differ only in how they build output:

- **`selectCanonicalPayload(expected: IssuedEmissionBindingOf<"reviewer-payload">, observation, finalMessageCandidates)`** returns `IngestionSelection`, which has six arms:
  - `emission-tool-arguments`: `FinalPayload` bytes encoded once, `source: "emission-tool"`, and the accepted `call`.
  - `final-message-extraction`: the verbatim `parseFinalPayload` result, with no refusal field.
  - `extraction-over-refused-call`: the verbatim extraction result plus a required `emissionRefusal`.
  - `duplicate-emission-call`: the observed `calls`.
  - `refused-call-no-fallback`: both causes, as one rejection.
  - `observation-refused`.
- **`selectVerdictSource(expected: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">, observation, existingRawJson)`** returns `VerdictSourceSelection`, which has the five arms of `IngestionSelection` other than `refused-call-no-fallback`, with these payloads:
  - On the emission arm, the payload is `rawJson` serialized from the admitted arguments.
  - On the extraction arms, the payload is the caller's existing `rawJson`, byte-verbatim.
  - There is no `refused-call-no-fallback` arm. The kernel cannot see whether verdict extraction is usable, because that is decided at the submission seam, so a single refused call always lands on `extraction-over-refused-call` with the refusal retained, and the submission seam holds both causes if it rejects.

**Invariants.**
- The binding parameter is refined to its path (`IssuedEmissionBindingOf<K>`), so the reviewer path can admit only through the reviewer parser and a verdict attempt is bound to exactly one verdict kind. A reviewer call in a verdict attempt refuses as `unexpected-kind`.
- An arm exists only when its data exists. For example, `emissionRefusal` is required on `extraction-over-refused-call` and absent from the baseline extraction arm. No nullable "maybe a refusal" fields exist.
- Containment law (ADR-0019): in the zero-call state, and in the single-engine-refused-call state where extraction is selected, the extraction result equals `parseFinalPayload` (or the existing raw input) on the same final candidates. There is deliberately no containment claim for duplicate or misbound calls. Those outcomes are asserted as rejections in `engine/tests/core/emission-ingestion.test.ts`.
- If a source is accepted as emission and then rejected by an issuance join, the path never falls back to final text.

**Per-path construction and authoritative joins (retained).**
- **Reviewer:** `engine/src/orchestration/harness-capture-runtime.ts` calls `selectCanonicalPayload(authority.binding, observeEmissionCalls(observation.frames), observation.candidates)` and folds the six arms exhaustively.
  - Accepted sources go through the existing `bindAndPersistCapture`, which performs reviewer protocol admission. Provenance (`source`, `toolCallId`, `producerKind`, `emissionSchemaVersion`, `schemaDigest`, retained `emissionRefusal`) is taken from the selection result.
  - Rejections map to `ambiguous-emission-call`, `emission-and-extraction-refused`, or the refusal code.
- **Verdict:** `engine/src/core/panel-verdict-source.ts` composes the kernel directly, for both panel paths (the persistent submissions and the legacy attempt resolution in `engine/src/core/legacy-panel-decisions.ts`):
  - `foldPanelVerdictEmission` is the one live fold, `selectVerdictSource` over the issued binding and observation.
  - `replayPanelVerdictSourceSelection` re-certifies a recorded emission claim through `issueEmissionBinding`, refuses a record whose schema digest does not certify the minted one, and re-folds the single accepted call.
  - *Amended 2026-10-07 (deepen pass).* The kernel used to reach the panel layer through an injected `PanelVerdictEmissionPort` whose only production adapter lived in `legacy-panel-decisions.ts`, with structural mirror types of the kernel's binding, call, observation and selection, because the emission modules were outside the purity closure and the panel modules are declared pure. Once `emission-tool.ts`, `harness-capture.ts`, `emission-ingestion.ts`, `legacy-archive.ts` and `legacy-panel-decisions.ts` were enrolled in `DEFAULT_PURE_MODULES` (their transitive closure audited by `engine/tests/linter/programmatic/machine-purity.test.ts`), the port protected no purity and had one adapter — the core tests carried a hand-written twin of it. The port, its adapter, the twin and the mirror types were removed; the panel layer imports the kernel downward, and the kernel still never imports the panel layer.
- The panel parsers keep their criterion, lens and roster bindings and their complete candidate/finding coverage. A selection chooses which bytes are parsed, never what those bytes must bind to.
- No `FinalPayload` or serialized verdict bypasses these joins.

**Layering.**
- `emission-ingestion.ts` is pure: no I/O, no clock, no randomness.
- It imports only `emission-tool.ts` (binding types, `admitIssuedEmissionArguments`), `emission-observation.ts` (observation vocabulary), `harness-capture.ts` (`finalPayloadOf`, `parseFinalPayload`), and `orchestration-contract/identity` (`DomainResult`, `canonicalRecord`, `parseRequestId`).
- It must not import `panel-program.ts`, the panel verdict modules (`panel-verdict-source.ts`, `persistent-panel.ts`), `legacy-panel-decisions.ts` or any I/O adapter. `machine-purity.test.ts` gates both halves: the emission modules' direct imports exclude the panel layer, and their transitive closure stays inside the declared pure modules.
- Shared schema definitions stay below the program layer, so no registry-to-program import cycle exists.
- Results use the existing `DomainResult` and `canonicalRecord` immutable-record conventions. No branded wrappers were added for values that carry no invariant.

## Consequences

**Positive:**
- Each transcript has exactly one interpretation on every path. Replay idempotence, contradiction refusal, misbinding refusal and ambiguity are each decided in one place, so two paths cannot consume different budgets for the same observation.
- Provenance (`source`, accepted `call`) and diagnostics (retained `emissionRefusal`, both causes on a double failure, the observed calls on ambiguity, the first differing field on a contradiction) are returned by the decision. Shells only translate them.
- Misbound and unusable observations can no longer pass silently as absence, and the model can never choose its own decoder.
- The full ADR-0019 matrix, including the containment law and the explicit duplicate/misbound rejection rows, is tested against the same functions production calls.
- Extraction behavior is byte-identical to the pre-feature baseline in the states where extraction is selected, so any behavioral divergence can come only from the validated emission path.
- Reviewer protocol admission and the verdict parsers' issuance joins are unchanged and remain authoritative.

**Negative:**
- Two selection functions with deliberately different unions (the verdict path has no `refused-call-no-fallback` arm) are a lasting maintenance cost. Anyone extending one must decide whether the asymmetry still holds.
- *(Superseded 2026-10-07.)* The panel core used to mirror the kernel's result shapes structurally behind an injected port to keep its purity, so kernel drift failed to compile at the adapter rather than at the core. The panel core now uses the kernel's own types; only the replayed extraction-over-refused-call arm widens its retained refusal code to the durable provenance string.
- *(Superseded 2026-10-07.)* The rule that `emission-ingestion.ts` does not import the panel layer or I/O adapters was enforced by review only. It is now an automated gate in `machine-purity.test.ts`, beside the module's enrolment in the purity closure.
- The closed observation and refusal unions mean any new harness observation state (for example, a new partial-frame shape) requires a deliberate kernel change and new matrix rows. It cannot be absorbed ad hoc in an adapter.
- Treating incomplete or contradictory observations as refusals rather than absence means some attempts that a lenient selector would have "rescued" through extraction now surface as evidence/infrastructure refusals at the boundary. This trade of availability for honesty is accepted.
