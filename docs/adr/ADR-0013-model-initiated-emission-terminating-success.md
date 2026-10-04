# ADR-0013: Model-initiated emission, terminating success

## Status
Accepted

## Context
Grammar-constrained decoding gives each producer Agent a per-kind emission tool.
The kinds are reviewer-payload v2/v3, judge-verdict v1 and refutation-verdict v1.
The tool's parameters are the exact frozen schema bytes, so the payload can travel
as tool arguments instead of being scraped from the final assistant message. Two
things in that path cost time and can be misread.

First, the model has to call the tool. Pi 0.83.0 exposes the tool to the model, but
nothing in Loom's request path forces the model to pick it. The JSON Schema limits
the arguments of a call that happens. It does not make the call happen. The routes
we qualified make this concrete: the local vLLM route
(`desktop-vllm`, `glm-5.3-flash-spark-tp2-v14`) accepts the frozen schemas but
ignores the tool-level `strict` flag, so it is classified as unconstrained emission
(ADR-0012, ADR-0015). Any design that treats "the tool exists" as "the payload will
arrive through the tool" overstates what the harness guarantees. The final-message
extraction path has to stay authoritative as the fallback.

Second, a successful tool call normally ends with another model turn. In Pi's agent
loop, a tool result is fed back to the model and the model is prompted again. For a
structured-output tool, that turn adds latency and tokens, and it gives the model a
chance to write prose, call the tool a second time, or make the transcript
ambiguous. ADR-0021's latency budget measures dispatch through accepted ingestion,
follow-up turns included, so an extra turn on every successful emission counts
against the +25% p95 bound. Pi 0.83.0 documents terminating structured-output tools
(`examples/extensions/structured-output.ts`): a tool result can carry
`terminate: true`. That flag has exact semantics we have to respect. The follow-up
turn is skipped only when every finalized result in the tool batch is terminating.
A refusal signaled the wrong way would look like a successful result: Pi sets
`isError` only when `execute` throws, not when it returns an object labeled as an
error. Some argument failures never reach `execute`, because Pi validates arguments
against the tool schema first. Those failures still have to be observable.

## Options Considered

1. **Force tool selection per request (`tool_choice` = the emission tool), relying on schema constraints for correctness**
   - Pros: On routes that honor forced tool choice, the payload almost always arrives through the tool. Extraction is exercised less.
   - Cons: Pi's extension surface does not offer per-request forced tool choice to Loom, so this would need a second provider serializer, which ADR-0011 rejects. Support for forced choice and strict schemas varies by route. The qualified vLLM route ignored `strict` even when tool choice was forced, and adversarial calls passed out-of-range values through. The engine would still have to own validity, so forcing adds wire-level coupling without removing extraction. It also takes away the model's documented fallback when the tool refuses its arguments.

2. **Model-initiated emission, non-terminating success (plain tool result, then a final message)**
   - Pros: Simplest tool shape. The model always gets a turn to confirm. A final text message usually exists for extraction.
   - Cons: Every successful emission pays an extra model round trip, which counts against ADR-0021's latency guardrail. The follow-up turn invites re-emission, which ADR-0019 refuses as duplicate-call ambiguity, and prose that competes with the emitted payload. It also violates FR-013, which forbids requiring an additional final assistant message.

3. **Model-initiated emission, with prompt instructions alone telling the model to stop after the call**
   - Pros: No tool-result changes. Works on any harness that can show the tool.
   - Cons: An instruction cannot stop the harness from prompting again. Pi's loop still sends the tool result back and requests another turn. The cost and ambiguity of option 2 remain, and the model's compliance decides the outcome.

4. **Model-initiated emission, terminating acknowledgment on success, throw on refusal (chosen)**
   - Pros: Uses Pi's documented terminating-tool mechanism, so a successful lone emission settles with no follow-up model request. The design does not claim that the tool call is guaranteed, so extraction stays the documented fallback. Refusals use Pi's real error channel. The acknowledgment is a fixed, bounded string, so the transcript does not grow with the payload.
   - Cons: Termination is batch-scoped. A mixed or partly cancelled batch still causes a follow-up turn. The model can still ignore the tool, so both paths must be maintained and tested. A run that ends with only a tool call can have no final text, so the capture path cannot assume a final message.

## Decision
**Leave the emission call to the model (no forced tool choice). Name the exact tool in new emission-enabled instructions. On successful `execute`, return a minimal acknowledgment with `terminate: true`. On a core refusal, throw at the shell boundary.**

Concrete shape:

- **No forced tool choice.** The emission tool is registered with the frozen schema
  bytes as `parameters` and the shared `constrainedSampling: { type: "json_schema",
  strict: "prefer" }` request (INV-1, ADR-0012). Nothing sets per-request tool
  choice. Schema constraints are described only as limits on the arguments of a call
  that happens, never as forcing the call.
- **Exact tool name in new instructions only.**
  `emissionToolPrimaryInstruction(binding)` in `engine/src/core/spawn-admission.ts`
  renders the issued binding's exact `toolName`, the one-call rule ("never call it a
  second time in this spawn") and the final-message fallback for an unavailable or
  refusing tool. It is projected only onto emission-enabled requests (ADR-0017).
  Extraction-only and archived requests keep their final-message wording unchanged.
  `REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE` in `engine/src/core/reviewer-protocol.ts`
  carries the matching tool-primary wording for reviewers.
- **The acknowledgment decision is pure and in the core.**
  `acknowledgeEmissionExecution(spec, version, args)` in
  `engine/src/core/harness-capture.ts` admits the arguments through the same registry
  admission gate (`admitEmissionArguments`) that engine selection runs again later.
  It returns a closed `EmissionExecutionOutcome`:
  - `acknowledged`: an `EmissionToolAcknowledgment` whose content is exactly one text
    block, `"payload acknowledged"`, with empty `details` and `terminate: true`. The
    type fixes `terminate` to the literal `true` and leaves no room to echo the
    payload.
  - `refused`: the admission's own `code` and `message`, verbatim.
- **The shell throws refusals.** `emissionToolDefinition(binding).execute` in
  `pi/emission-tool.ts` returns the acknowledgment unchanged or throws
  `` new Error(`${code}: ${message}`) ``. It never returns an error-labeled object,
  because that would not set Pi's `isError` flag.
- **Pre-execute schema rejection stays observable.** When Pi's own argument
  validation rejects a call before `execute`, Pi feeds the failure back as an
  error tool result and re-prompts (the in-child validation-retry loop seen during
  qualification). That call stays in the transcript as an emission observation.
  The transcript adapter (`pi/transcript-adapter.ts`) records it as a complete,
  request-bound observation. It is never reclassified as absence. Selection under
  ADR-0018/ADR-0019 decides the attempt outcome.
- **Extraction stays required.** Termination is only an optimization. Zero emission
  calls fall through to the unchanged final-message extraction (ADR-0019 containment
  law). The capture path accepts a terminal tool-only transcript with no final
  text.
- **Invariants:**
  - The acknowledgment never contains payload bytes.
  - `terminate` on success is always the literal `true`.
  - A core refusal is always thrown, never returned.
  - Termination is never assumed for a batch that has any non-terminating or
    cancelled result.
- **Tests** (`engine/tests/pi/emission-tool.test.ts`, which drives the real Pi agent
  loop):
  - A valid emission settles without a follow-up model request.
  - A mixed batch does not terminate.
  - Cancellation before execute leaves no tool execution, no follow-up request, and
    an observable toolCall block.
  - Cancellation mid-batch stays non-terminating.
  - An engine-refined refusal throws and appears as `isError`, never as a successful
    result.
  - Pre-execute validation failure enters the observed re-prompt loop.
  - Execute returns the minimal acknowledgment with no payload echo.

## Consequences

**Positive:**
- A successful single emission ends the child's model loop at once, with no extra
  round trip, which helps ADR-0021's latency guardrail and meets FR-013.
- No follow-up turn means fewer chances to re-emit or write prose that competes
  with the payload. That lowers the rate of ADR-0019 duplicate-call ambiguity rejections.
- The design does not overclaim. The tool call is described as model-initiated, so
  operators and calibration count non-emission and fallback rates as a measured
  series, not as defects in a guarantee.
- Refusals reach Pi's real error channel. The model can see and act on them inside
  the turn, and engine diagnostics keep the admission's exact vocabulary.
- One pure decision (`acknowledgeEmissionExecution`) serves both the production
  shell and the acceptance suite. There is no test twin.
- The transcript stays small whatever the payload size.

**Negative:**
- Some emissions still pay for a follow-up turn: those in mixed batches, partly
  cancelled batches, and calls Pi's validation rejects before `execute`. Calibration
  has to count these, including the roughly two extra requests from the
  validation-retry loop.
- Two delivery paths, tool emission and final-message extraction, must be
  maintained, documented and tested indefinitely. The fallback cannot be removed
  later on the strength of this decision.
- A terminal tool-only transcript can have no final text. Every capture adapter has
  to handle that case, and an engine refusal after a terminating success (an
  issuance-join rejection) cannot fall back to final text that does not exist. The
  attempt is rejected and the existing attempt-2 slot is used (ADR-0019).
- The design depends on Pi 0.83.0's documented `terminate` semantics and its
  throw-to-`isError` contract. A Pi upgrade that changes either one needs
  requalification, and the tests that drive the real Pi loop are the tripwire.
- How often the tool is used depends on the model. On models that often ignore the
  tool, the feature's benefit drops back toward extraction-only behavior, and only
  ADR-0021 measurement shows that.
