# ADR-0019: One existing request-slot budget; no same-spawn correction protocol

## Status
Accepted

## Context
Grammar-constrained decoding gives a producer Agent (reviewer v2/v3, judge verdict, refutation verdict) a second way to hand its payload to the engine. It can call a per-kind emission tool, or it can write the existing final message that the unchanged extraction parser reads. Either path can fail. Engine argument admission can refuse a tool call: the live route is classified as *unconstrained emission*, and frozen JSON Schema does not enforce Zod refinements, byte bounds, canonical paths or issuance joins. Extraction can also fail on a malformed final message. The engine already bounds semantic failure with request-slot attempts: attempt 1, then one fresh engine-issued attempt-2 spawn, and attempt 2 is terminal.

The original Spec and Plan described a separate emission retry budget. That wording was never coherent with the rest of the design. The retained duplicate policy (FR-007) makes two distinct emission calls in one issued attempt an ambiguity rejection, whatever their validity or the final message. So a "correction" protocol that tells the child to call the tool again inside the same spawn guarantees a rejection rather than a recovery. A second counter would also need its own lifecycle: who issues it, how it is persisted, and how it interacts with attempt identity, publication and replay. None of that was specified or implemented. Pi's in-child validation-retry loop (tool-role error feedback, then a re-prompt) can still produce a second call on its own, so the engine cannot rely on the model to behave.

The engine needed one rule for how emission-path and extraction-path failures map onto retry consumption. The rule had to be deterministic and engine-authoritative, keep both causes for diagnostics, and never invent a successful fallback.

## Options Considered

1. **Separate emission retry budget (the original Spec/Plan wording)**
   - Pros: Emission failures do not spend the extraction attempt. In principle the model gets more chances to produce valid tool arguments.
   - Cons: Needs a second counter with its own issuance, persistence, replay and terminal semantics, and none of these exist. Two counters can each permit the other to continue, so the worst-case number of model requests is unclear. Calibration cannot attribute retries to a single cause. Same-spawn retries collide with the duplicate-ambiguity rule (FR-007).

2. **Same-spawn correction protocol (tell the child to re-call the tool after a refusal)**
   - Pros: Recovery is cheap, with no new spawn. It matches Pi's native validation-retry behavior.
   - Cons: A second distinct call in one issued attempt is ambiguity by the retained duplicate policy, so the instruction guarantees rejection. Relaxing the duplicate policy to allow "last call wins" would let an earlier refused or valid payload be silently superseded. It would also make source selection depend on call ordering, which the transport does not reliably guarantee.

3. **Treat any emission refusal as an attempt failure, with no extraction fallback**
   - Pros: Simplest selection policy. Exactly one source per attempt.
   - Cons: A usable final message gets discarded, so a recoverable situation becomes a consumed retry. This turns the unconstrained-emission route into a regression against extraction-only behavior. It also breaks the containment law (FR-010) for the single-refused-call case.

4. **One existing request-slot budget, with separate diagnostic causes (chosen)**
   - Pros: No new lifecycle. Attempts 1 and 2 already have issuance, persistence and terminal semantics. A single refused call can still be recovered through the unchanged final-message extraction at no retry cost. Both causes are kept in the typed outcome. The duplicate policy stays strict and unambiguous.
   - Cons: A model that ignores the "do not re-emit" instruction loses the attempt, even if its second call or final text was valid. Emission and extraction failures compete for the same two attempts.

## Decision
**Emission and extraction rejection share the existing semantic request-slot attempts 1 and 2, with separate diagnostic causes and no separate retry counter. This supersedes the original separate-emission-budget wording in the Spec and Plan (now FR-006/FR-007).**

The pure selection kernel in `engine/src/core/emission-ingestion.ts` applies this once per issued attempt. It works over a closed `EmissionObservation` (`absent` | `single-call` | `duplicate-emission-call` | `observation-refused`) bound to request/kind/version/schema digest and tool-call identity. `selectCanonicalPayload` (reviewer) and `selectVerdictSource` (judge/refutation) return one tagged outcome from the same decision. Callers never re-derive the policy.

| Observation in one issued attempt | Selection outcome | Attempt effect |
|---|---|---|
| Zero emission calls | `final-message-extraction`: existing extraction result unchanged | Accept if usable; otherwise one existing rejection |
| One complete, correctly bound call; engine admits arguments | `emission-tool-arguments`, regardless of final text | Existing issuance joins still decide admission |
| One complete, correctly bound call; engine refuses arguments; extraction usable | `extraction-over-refused-call`, retaining the emission refusal | Accept; no retry consumed |
| One refused call; extraction unusable | `refused-call-no-fallback`, carrying both causes | One rejection, not two |
| Two distinct calls (refused then corrected, or identical arguments under different call IDs) | `duplicate-emission-call` ambiguity, even with valid final text | One rejection |
| Exact replay of one transport call observation | Collapses to the same single observation | No additional consumption or publication |
| Wrong request/kind/version, contradictory or incomplete observation | `observation-refused`: typed refusal, never reclassified as absence | Existing evidence/infrastructure classification at the boundary; no invented fallback |
| Startup/transport infrastructure unavailable | No semantic payload decision | Existing infrastructure recovery at the same attempt |

Invariants:

- **Bounded attempts.** A semantic rejection at attempt 1 permits one fresh engine-issued attempt-2 spawn. A rejection at attempt 2 is terminal. No emission path mints an attempt.
- **No post-admission fallback.** A source selected as emission and then rejected by a downstream issuance join (reviewer protocol admission, verdict criterion/lens/roster bindings) does not fall back to final text.
- **Instruction is advisory, the engine is authoritative.** Emission-enabled instructions tell the Agent not to re-emit within a spawn. After one argument refusal, the Agent may finish with the documented final-message fallback. The engine still counts calls and judges validity if the model ignores this.
- **Containment law.** With zero emission calls, or with exactly one correctly bound complete call that the engine refuses and extraction selected, the extraction result equals the existing parser's result on the same final candidates. No no-op-equivalence claim is made for duplicate or misbound calls. Property tests in `engine/tests/core/emission-ingestion.test.ts` assert those rejection outcomes explicitly. They are not skipped under a universal containment test name.
- **Separate causes, one counter.** Diagnostics keep the emission refusal and the extraction failure as distinct typed causes for observability and calibration, while consumption is counted once.

## Consequences

**Positive:**
- There is no new lifecycle, persistence format or terminal state. The worst-case number of semantic attempts per request is still two.
- A single bad tool call on an unconstrained route is recoverable at zero retry cost when the final message is usable, so emission is never worse than extraction-only for that case.
- Selection is a total, pure function over a closed observation type. Every row above is a distinct tagged outcome that the reviewer and verdict paths consume, which keeps it testable with property tests and no mocks.
- The duplicate policy stays strict, so no silent "last call wins" supersession and no dependence on transport ordering.
- Calibration can attribute failures to emission versus extraction without double-counting attempts.

**Negative:**
- A model that re-emits within a spawn loses the attempt even when its corrected call or final text is valid. Pi's in-child validation-retry loop can cause this without any model intent. This is accepted: the instruction, the final-message fallback and the attempt-2 spawn are the mitigations.
- Emission and extraction failures compete for the same two attempts, so a flaky emission route reduces headroom for extraction-only recovery.
- The containment law covers only the zero-call and single-refused-call cases. Duplicate and misbound observations deliberately behave differently from extraction-only operation, and documentation must say so rather than claim universal equivalence.
- The Spec and Plan history carries superseded separate-budget wording. Readers have to follow the 2026-09-19 revision log and this ADR to find the current rule.
