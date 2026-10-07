/**
 * The real Pi emission tool surface, exercised through the INSTALLED pi
 * packages — not fakes of the machinery under test (plan Phase 2; AD-5's
 * "Pi-side gates verified live"):
 *
 * - `validateToolArguments` is the actual function pi's agent loop calls in
 *   `prepareToolCall` (pi-agent-core imports it from the same pi-ai package
 *   this suite imports); it runs against the EXACT registered tool definition
 *   — `parameters` constructed from the frozen registry bytes through
 *   `frozenPayloadSchemaParameters`, the ONE serialization chain (AD-5).
 * - The agent loop is the actual pi-agent-core `runAgentLoop`; only the model
 *   transport is scripted (one `AssistantMessageEventStream` per turn), the
 *   same offline-reproduction posture the committed qualification probe used
 *   (feasibility record §2.7). The LIVE wire evidence — route acceptance,
 *   strict-flag serialization, raw streamed arguments — is retained in
 *   `probes/emission-qualification/recordings/` and requalification follows
 *   the feasibility record's triggers; this suite pins the harness-side
 *   semantics those recordings observed.
 * - The registered tool is the PRODUCTION emission tool definition
 *   (pi/emission-tool.ts, wired by pi/emission-readiness.ts's readiness command): the
 *   execute shell is the shared `acknowledgeEmissionExecution` decision
 *   (refusals THROW at the harness boundary — returning never sets the error
 *   flag; AD-3) over the registry's admission gate, the constrained-sampling
 *   request is the shared `EMISSION_CONSTRAINED_SAMPLING_REQUEST`, and the
 *   parameters are the frozen bytes. The suite therefore crosses the same
 *   policy seam production registers with — never a test twin.
 *
 * Observed pi behaviors pinned here (discovered by the committed probes):
 * - the in-child validation-retry loop: each tool-argument validation failure
 *   feeds an error back as a tool-role result and causes one re-prompt. This
 *   suite pins that per-failure cost; the qualification recordings separately
 *   observed up to ~2 extra requests across their full correction flows. Loom's
 *   request-slot attempt budget sits OUTSIDE this harness-level loop (FR-006's
 *   budget boundary).
 * - a thrown execute error is ALSO a non-terminating tool result and re-prompts
 *   the same way; `terminate: true` suppresses the follow-up turn only when
 *   EVERY finalized result in the batch is terminating (AD-3's mixed-batch
 *   caveat).
 * - non-TypeBox parameter schemas (the frozen bytes parsed as plain JSON) take
 *   pi-ai's JSON-Schema coercion path, which does NOT coerce a string-typed
 *   `schemaVersion` to the `const` number — the recorded per-branch refusals
 *   are reproduced verbatim by the DIRECT validator pins below.
 * - the production definition carries `prepareArguments` — the wire-form
 *   canonicalization pi-agent-core runs BEFORE `validateToolArguments`
 *   (`prepareToolCallArguments`), driven entirely by the frozen schema's
 *   declared types. The recorded string-typed class (`schemaVersion: "2"`,
 *   JSON-encoded `findings`) parses into a conforming payload and ADMITS
 *   through the loop without a re-prompt, while a wire form no declared type
 *   can accept still refuses verbatim before execute. The direct-validator
 *   pins keep proving the validator's own refusal vocabulary for a tool
 *   invoked WITHOUT the canonicalization layer.
 *
 * This suite holds only the seams that need the pi runtime. The Pi review
 * route (emission-review-route.test.ts), provisioning and readiness
 * (emission-tool-provisioning.test.ts) and transcript frames
 * (emission-transcript-frames.test.ts) run without loading it.
 */

import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { AgentEvent, AgentLoopConfig } from "@earendil-works/pi-agent-core";
import { observeEmissionCalls } from "../../src/core/emission-observation";
import {
  acknowledgeEmissionExecution,
  admitIssuedEmissionArguments,
  EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  EMISSION_TOOL_SPECS,
  frozenPayloadSchemaParameters,
  type EmissionSchemaVersion,
  type EmissionToolAcknowledgment,
} from "../../src/core/emission-tool";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { piEmissionCallFrames } from "../../../pi/transcript-adapter";
import { piReviewerCaptureObservation } from "../../../pi/review-capture";
import { validReviewerArgumentsV2, whitespaceOnlyArguments } from "../fixtures/emission-arguments";
import {
  canonicalArguments,
  JUDGE_V1_CELL,
  mintedBindingFor,
  REFUTATION_V1_CELL,
  REGISTRY_CELLS,
  REVIEWER_V2_CELL,
  type RegistryCell,
} from "../fixtures/emission-registry-cells";
import {
  assistantAbortedToolCallMessage,
  assistantFinalTextMessage,
  assistantToolCallMessage,
  observedEmissionTool,
  runScriptedLoop,
  scriptTurns,
} from "../fixtures/pi-scripted-loop";

/** The discriminating malformed shapes: exactly the violation classes the
 *  committed qualification recordings captured (string-typed v2 fixture
 *  fields; out-of-domain judge score; the refutation verdict enum violation
 *  that decisively classified the route unconstrained). */
const malformedArguments = (kind: RegistryCell["kind"], version: EmissionSchemaVersion): unknown => {
  if (kind === "reviewer-payload") {
    return {
      schemaVersion: version === "v2" ? "2" : "3",
      kind: version === "v2" ? "standalone-review" : "standalone-successor-review",
      findings: JSON.stringify(REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]),
    };
  }
  if (kind === "judge-verdict") {
    return {
      criterion: "extensibility",
      rankings: [{ candidate: "candidate-type-driven-fp.md", score: 12, fatal_flaw: null, strongest_idea: "out of the score domain" }],
    };
  }
  return {
    criterion: "reproduction",
    verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "partially_upheld", reasoning: "the qualification's decisive violation" }],
  };
};


/** The request id the loop cases register the PRODUCTION emission tool under
 *  (`observedEmissionTool`: the exact definition the extension's readiness
 *  command registers, with the observation record around its execute). */
const SHELL_REQUEST_ID = "req-emission-tool-t5-shell";

/** The AD-10 always-accept control: a shell that SKIPS the engine's admission
 *  gate would acknowledge exactly the arguments production refuses. */
const bypassingShellTool = (cell: RegistryCell): Record<string, unknown> => ({
  name: cell.spec.toolName,
  label: `Bypassing ${cell.kind}`,
  description: "always-accept control — no engine admission",
  parameters: frozenPayloadSchemaParameters(cell.spec.schemaVersions[cell.version]!.schemaBytes),
  execute: async (): Promise<EmissionToolAcknowledgment> => ({
    content: [{ type: "text", text: "payload acknowledged" }],
    details: {},
    terminate: true,
  }),
});

const plainTool: Record<string, unknown> = {
  name: "scratch_note",
  label: "Note",
  description: "a plain non-terminating tool for the mixed-batch control",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async () => ({ content: [{ type: "text", text: "noted" }], details: {} }),
};

/** The loop-config hook that cancels the plain sibling's preparation — the
 *  cancel arrives mid-batch (the emission is already prepared), so pi
 *  finalizes the sibling as its own "Operation aborted" error result without
 *  execute ever running. */
const abortPlainToolPreparation = (controller: AbortController): NonNullable<AgentLoopConfig["beforeToolCall"]> =>
  async (input) => {
    if (input.toolCall.name === "scratch_note") controller.abort();
    return undefined;
  };

const toolResultMessages = (messages: readonly unknown[]): { isError?: boolean; content: { text: string }[]; toolName: string }[] =>
  messages.filter((message): message is { role: "toolResult"; isError?: boolean; content: { text: string }[]; toolName: string } =>
    (message as { role?: string })?.role === "toolResult");

// ---------------------------------------------------------------------------
// Real pi validateToolArguments against the exact frozen bytes
// ---------------------------------------------------------------------------

describe("real pi validateToolArguments against the exact frozen registry bytes", () => {
  it("admits every canonical fixture through the REAL validator, and the validated args re-admit through the engine", () => {
    for (const registryCell of REGISTRY_CELLS) {
      const parameters = frozenPayloadSchemaParameters(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes);
      const tool = { name: registryCell.spec.toolName, description: "d", parameters };
      const args = canonicalArguments(registryCell.kind, registryCell.version);
      const validated = validateToolArguments(
        tool as never,
        { id: "call-canonical", name: registryCell.spec.toolName, arguments: args } as never,
      );
      // The validated execute params are the SAME payload the engine admits —
      // one parse chain, no drift between what pi validates and what the
      // engine's selection later re-runs.
      expect(admitIssuedEmissionArguments(mintedBindingFor(registryCell, "req-emission-tool-admission"), validated).kind).toBe("valid");
    }
  });

  /** The refusal message pi's REAL validator throws for the cell's malformed
   *  shape against its exact frozen parameters — or "" if the validator
   *  admitted it, which every fragment assertion below then fails on. */
  const malformedRefusalMessage = (cell: RegistryCell): string => {
    const parameters = frozenPayloadSchemaParameters(cell.spec.schemaVersions[cell.version]!.schemaBytes);
    try {
      validateToolArguments(
        { name: cell.spec.toolName, description: "d", parameters } as never,
        { id: "call-bad", name: cell.spec.toolName, arguments: malformedArguments(cell.kind, cell.version) } as never,
      );
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("refuses the recorded malformed shapes with precise per-branch errors (feasibility §2.7)", () => {
    for (const registryCell of REGISTRY_CELLS) {
      expect(malformedRefusalMessage(registryCell), `${registryCell.kind}/${registryCell.version} must be refused by pi's validator`).toContain(
        `Validation failed for tool "${registryCell.spec.toolName}"`,
      );
    }
  });

  it("reproduces the recorded per-branch fragments for the string-typed v2 violation class", () => {
    const message = malformedRefusalMessage(REVIEWER_V2_CELL);
    // The exact branches the qualification recordings show pi reporting — the
    // string-typed schemaVersion is NOT coerced to the const number and the
    // JSON-encoded findings is NOT coerced to the array; the discriminator's
    // second (wave-review) branch is reported too, so the union shape parses.
    expect(message).toContain("schemaVersion: must be number");
    expect(message).toContain("findings: must be array");
    expect(message).toContain("packetId: must have required properties packetId, generation, prior_findings");
  });

  it("admits no malformed judge score or refutation verdict enum through the real validator", () => {
    expect(malformedRefusalMessage(JUDGE_V1_CELL)).toContain("score");
    expect(malformedRefusalMessage(REFUTATION_V1_CELL)).toContain("verdict");
  });

  it("admits whitespace-only advisory prose the engine refuses — the AD-5 disagreement, both halves in one flow", () => {
    for (const registryCell of REGISTRY_CELLS) {
      if (registryCell.kind === "reviewer-payload" && registryCell.version === "v3") {
        // The v3 successor schema carries no advisory prose field; the
        // disagreement is defined for the three prose-bearing cells.
        continue;
      }
      const parameters = frozenPayloadSchemaParameters(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes);
      const tool = { name: registryCell.spec.toolName, description: "d", parameters };
      const args = whitespaceOnlyArguments(registryCell.kind);
      // PI HALF: the real validator admits the whitespace-only prose.
      const validated = validateToolArguments(
        tool as never,
        { id: "call-ws", name: registryCell.spec.toolName, arguments: args } as never,
      );
      expect(validated).toBeTruthy();
      // ENGINE HALF: the same validated arguments are refused by the
      // production shell's admission — never ingested (FR-006), the refusal
      // the tool result carries and the selection retains.
      const outcome = acknowledgeEmissionExecution(mintedBindingFor(registryCell, "req-emission-tool-t5-ws"), validated);
      expect(outcome.kind, `${registryCell.kind}/${registryCell.version}`).toBe("refused");
    }
  });
});

// ---------------------------------------------------------------------------
// Real pi agent loop: terminating execute and the in-child retry loop
// ---------------------------------------------------------------------------

describe("real pi agent loop — terminating execute and the in-child validation-retry loop", () => {
  it("a valid emission executes, acknowledges, and settles WITHOUT a follow-up model request (FR-013)", async () => {
    const registryCell = JUDGE_V1_CELL;
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-1", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) }]),
    ]);
    const { events } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed)], script);

    expect(script.callCount()).toBe(1);
    // Execute observed the VALIDATED arguments, parsed-equal to the fixture.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(canonicalArguments(registryCell.kind, registryCell.version));
    // The tool result is a success.
    const executionEnd = events.find((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end");
    expect(executionEnd?.isError).toBe(false);
    // Terminating success: the loop ended on the tool batch — no re-prompt,
    // no compulsory final text (the script carried no further response).
    const agentEnd = events[events.length - 1]!;
    expect(agentEnd.type).toBe("agent_end");
  });

  it("a validation failure feeds the error back as a tool result and the loop re-prompts — the observed retry loop", async () => {
    const registryCell = JUDGE_V1_CELL;
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-bad", name: registryCell.spec.toolName, arguments: malformedArguments(registryCell.kind, registryCell.version) }]),
      assistantToolCallMessage([{ type: "toolCall", id: "call-good", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) }]),
    ]);
    const { events } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed)], script);

    // TWO model requests: the original turn and one re-prompt after this
    // validation failure. Feasibility §2.7 separately records up to ~2 extra
    // requests across the complete correction flows captured by its probes.
    expect(script.callCount()).toBe(2);
    // The feedback the model received on the re-prompt is the validation
    // error as a tool-role result.
    const rePromptContext = script.contexts[1]!;
    const errorFeedback = rePromptContext.find(
      (message) => message.role === "toolResult" && message.isError === true,
    );
    expect(errorFeedback).toBeDefined();
    // The corrected emission then executed and terminated.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(canonicalArguments(registryCell.kind, registryCell.version));
    const successEnds = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end" && !event.isError,
    );
    expect(successEnds).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe("agent_end");
  });

  it("the recorded string-typed wire form is canonicalized BEFORE pi validates — the violation class now executes without a re-prompt", async () => {
    const registryCell = REVIEWER_V2_CELL; // string-typed violation class
    const observed: unknown[] = [];
    // The children's ACTUAL wire shape: the whole findings ARRAY serialized as
    // one JSON string (a lone object would correctly stay a string at an
    // array-typed position — the canonicalization never coerces across types).
    const stringyArrayForm = {
      schemaVersion: "2",
      kind: "standalone-review",
      findings: JSON.stringify([REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]]),
    };
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-stringy", name: registryCell.spec.toolName, arguments: stringyArrayForm }]),
    ]);
    const { events, messages } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed)], script);

    // The wire-form canonicalization parsed the JSON-encoded fields against
    // the frozen schema's declared types; validation then admitted, execute
    // observed the CANONICAL payload, and the terminating acknowledgment
    // settled the turn with NO re-prompt — the recorded in-child failure loop
    // for this class is gone from the production surface.
    expect(script.callCount()).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]],
    });
    const executionEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
    );
    expect(executionEnd?.isError).toBe(false);
    expect(toolResultMessages(messages).every((message) => message.isError !== true)).toBe(true);
    expect(events[events.length - 1]!.type).toBe("agent_end");
  });

  it("a wire form no declared type can accept still refuses before execute — the canonicalization never invents a field", async () => {
    const registryCell = REVIEWER_V2_CELL;
    const observed: unknown[] = [];
    const unparseable = {
      schemaVersion: "two",
      kind: "standalone-review",
      findings: "not json",
    };
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-unparseable", name: registryCell.spec.toolName, arguments: unparseable }]),
      assistantFinalTextMessage("giving up; extraction fallback owns the attempt"),
    ]);
    const { events, messages } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed)], script);

    // The canonicalization cannot parse these values into any declared type,
    // so they pass through unchanged and the validator refuses verbatim
    // before execute: nothing was observed, and the error result carries
    // pi's precise per-branch message.
    expect(observed).toHaveLength(0);
    const result = toolResultMessages(messages)[0]!;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`Validation failed for tool "${registryCell.spec.toolName}"`);
    expect(result.content[0]!.text).toContain("schemaVersion: must be number");
    expect(result.content[0]!.text).toContain("findings: must be array");
    const errorEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
    );
    expect(errorEnd?.isError).toBe(true);
    // The loop re-prompted (non-terminating error result); the scripted final
    // text settled the turn — the model may always finish in prose, which is
    // the fallback's unchanged extraction input.
    expect(script.callCount()).toBe(2);
  });

  it("an engine-refined refusal THROWS at the shell — isError, never a successful tool result, with the bypass control attributing the refusal (FR-013)", async () => {
    const registryCell = JUDGE_V1_CELL; // whitespace-only strongest_idea
    const whitespaceArgs = whitespaceOnlyArguments(registryCell.kind);
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-ws", name: registryCell.spec.toolName, arguments: whitespaceArgs }]),
      assistantFinalTextMessage("the engine refused my emission; finishing in prose"),
    ]);
    const { messages } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed)], script);

    // pi's validator ADMITTED the whitespace shape, so execute ran and
    // observed the arguments — then the engine's admission refused and the
    // shell THREW.
    expect(observed).toHaveLength(1);
    const result = toolResultMessages(messages)[0]!;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("invalid-schema");
    expect(result.content[0]!.text).toContain("frozen schema");

    // The always-accept control: a shell that skips the engine's admission
    // gate acknowledges the SAME arguments — the refusal is attributable to
    // the admission gate, not to the harness (AD-10 negative control).
    const bypassAcknowledgment = await (bypassingShellTool(registryCell)["execute"] as (args: unknown) => Promise<EmissionToolAcknowledgment>)(whitespaceArgs);
    expect(bypassAcknowledgment.terminate).toBe(true);
  });

  it("an engine-refined refusal that threw is terminal even with usable final text — one re-prompt, the retained diagnostic, and the final text never resurrects the attempt (AD-8/FR-006)", async () => {
    const cell = REVIEWER_V2_CELL; // the prose-bearing cell the disagreement is defined for
    const issued = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-invalid-plus-final");
    const observed: unknown[] = [];
    const tool = observedEmissionTool(issued, observed);
    const settledPayload = validReviewerArgumentsV2("real claim");
    const whitespaceArgs = whitespaceOnlyArguments(cell.kind);
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-ws", name: cell.spec.toolName, arguments: whitespaceArgs }]),
      assistantFinalTextMessage(JSON.stringify(settledPayload, null, 2)),
    ]);
    const { messages } = await runScriptedLoop([tool], script);

    // pi's validator ADMITTED the whitespace shape (the AD-5 disagreement),
    // so execute RAN and observed the arguments — then the engine's admission
    // refused and the shell THREW. The loop re-prompted once and the model
    // settled in prose: one extra request, the observed in-child retry-loop
    // cost for ENGINE-refined refusals (parallel to the validation-failure
    // loop, which re-prompts BEFORE execute).
    expect(script.callCount()).toBe(2);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(whitespaceArgs);
    const result = toolResultMessages(messages)[0]!;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("invalid-payload");
    // The text the model received is the admission's OWN diagnostic — the
    // same refusal vocabulary the engine's selection retains (FR-006), never
    // a shell-invented string.
    const admission = admitIssuedEmissionArguments(mintedBindingFor(cell, "req-emission-tool-admission"), whitespaceArgs);
    if (admission.kind !== "refused") throw new Error("fixture must be engine-refused");
    expect(result.content[0]!.text).toContain(admission.message);

    // The production capture over the settled transcript: the thrown refusal
    // is an INCOMPLETE observation (its finalized result is the error the
    // shell threw) — never reclassified as absence and never reclassified as
    // extraction, EVEN with usable final text. The attempt terminal-refuses
    // with the retained diagnostic; the attempt budget, not the fallback,
    // owns the recovery (FR-006's boundary).
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture).toMatchObject({ kind: "terminal-refusal", reason: "unusable-observation" });
    if (capture.kind === "terminal-refusal") {
      expect(capture.message).toContain("call-ws");
      expect(capture.message).toContain("failed");
    }
  });

  it("an engine-refused emission followed by a corrected re-emission refuses the attempt — the failed call is never reclassified as absence and the corrected sibling cannot rescue it (AD-9)", async () => {
    const cell = REVIEWER_V2_CELL;
    const issued = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-refused-then-corrected");
    const observed: unknown[] = [];
    const tool = observedEmissionTool(issued, observed);
    const corrected = validReviewerArgumentsV2("real claim");
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-refused", name: cell.spec.toolName, arguments: whitespaceOnlyArguments(cell.kind) }]),
      assistantToolCallMessage([{ type: "toolCall", id: "call-corrected", name: cell.spec.toolName, arguments: corrected }]),
    ]);
    const { events, messages } = await runScriptedLoop([tool], script);

    // The engine-refusal loop cost: the original turn and ONE re-prompt, on
    // which the model re-emitted with corrected arguments — exactly the
    // same-spawn correction AD-9 declares rejection-by-construction.
    expect(script.callCount()).toBe(2);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(corrected);
    const ends = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
    );
    expect(ends).toHaveLength(2);
    expect(ends[0]!.isError).toBe(true);
    expect(ends[1]!.isError).toBe(false);

    // The transcript scan: the thrown first call is an INCOMPLETE frame (its
    // finalized result is the error the shell threw), never reclassified as
    // absence; the corrected sibling is a complete frame beside it.
    const scanned = piEmissionCallFrames(messages, issued);
    if (!scanned.ok) throw new Error(`transcript scan refused: ${scanned.errors.join("; ")}`);
    expect(scanned.value).toHaveLength(2);
    expect(scanned.value[0]).toMatchObject({ kind: "incomplete", toolCallId: "call-refused" });
    expect(scanned.value[1]).toMatchObject({ kind: "complete" });
    const observation = observeEmissionCalls(scanned.value);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") expect(observation.reason).toContain("call-refused");

    // The production capture terminalises the attempt: the corrected sibling
    // cannot rescue it, and the corrected payload is never selected.
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture).toMatchObject({ kind: "terminal-refusal", reason: "unusable-observation" });
  });

  it("a mixed batch does NOT terminate — one non-terminating result forces the follow-up turn (AD-3)", async () => {
    const registryCell = JUDGE_V1_CELL;
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([
        { type: "toolCall", id: "call-emit", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) },
        { type: "toolCall", id: "call-note", name: "scratch_note", arguments: {} },
      ]),
      assistantFinalTextMessage("batch finished with a plain note; the emission alone would have terminated"),
    ]);
    const { events } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed), plainTool], script);

    // Both tools executed; the emission's result was terminating, the plain
    // one was not — the batch is not terminating, so the loop re-prompted.
    expect(observed).toHaveLength(1);
    expect(script.callCount()).toBe(2);
    const successEnds = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end" && !event.isError,
    );
    expect(successEnds).toHaveLength(2);
  });

  it("a cancelled assistant turn aborts the loop BEFORE the emission executes — no tool execution, no follow-up model request, the toolCall block stays observable (AD-3)", async () => {
    const registryCell = JUDGE_V1_CELL;
    const observed: unknown[] = [];
    // The caller cancelled while the model streamed the emission tool call:
    // the transport completes the turn as aborted, partial toolCall block
    // intact — the cancellation path a live launcher or user produces.
    const script = scriptTurns([
      assistantAbortedToolCallMessage([
        { type: "toolCall", id: "call-1", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) },
      ]),
    ]);
    const { events, messages } = await runScriptedLoop([observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed)], script);

    // Exactly ONE transport call: the aborted turn ends the loop — no
    // follow-up request, no re-prompt, no script exhaustion.
    expect(script.callCount()).toBe(1);
    // The emission never executed: pi's abort check precedes tool-batch
    // execution, so a cancelled turn cannot reach the shell.
    expect(observed).toHaveLength(0);
    expect(
      events.find((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end"),
    ).toBeUndefined();
    // The aborted assistant message — WITH its structurally complete emission
    // toolCall block — stays in the settled transcript, but without successful
    // execution it is unusable rather than authoritative output.
    const abortedAssistant = messages.find(
      (message) =>
        (message as { role?: string }).role === "assistant" &&
        (message as { stopReason?: string }).stopReason === "aborted",
    ) as { content: { type: string; name?: string }[] } | undefined;
    expect(abortedAssistant).toBeDefined();
    expect(abortedAssistant!.content[0]).toMatchObject({ type: "toolCall", name: registryCell.spec.toolName });
    const scanned = piEmissionCallFrames(messages, mintedBindingFor(registryCell, "req-emission-tool-t5-cancelled"));
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.value).toHaveLength(1);
      expect(scanned.value[0]).toMatchObject({
        kind: "incomplete",
        toolCallId: "call-1",
        reason: expect.stringContaining("aborted"),
      });
      expect(observeEmissionCalls(scanned.value).kind).toBe("unusable");
    }
    // And the loop ended on the aborted turn.
    expect(events[events.length - 1]!.type).toBe("agent_end");
  });

  it("cancellation mid-batch: the cancelled sibling's error result keeps the batch non-terminating and the abort suppresses the follow-up turn (AD-3)", async () => {
    const registryCell = JUDGE_V1_CELL;
    const observed: unknown[] = [];
    const controller = new AbortController();
    // The cancel arrives while the plain sibling is being prepared: pi
    // finalizes it as its own "Operation aborted" error result (execute never
    // runs); the emission — already prepared — still executes to its
    // terminating acknowledgment.
    const script = scriptTurns([
      assistantToolCallMessage([
        { type: "toolCall", id: "call-emit", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) },
        { type: "toolCall", id: "call-note", name: "scratch_note", arguments: {} },
      ]),
    ]);
    const { events, messages } = await runScriptedLoop(
      [observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed), plainTool],
      script,
      { signal: controller.signal, beforeToolCall: abortPlainToolPreparation(controller) },
    );

    // The emission executed and observed the validated arguments.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(canonicalArguments(registryCell.kind, registryCell.version));
    // Two finalized results: the cancelled sibling's abort error and the
    // emission's success (emission end after the sibling's, in parallel mode).
    const ends = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
    );
    expect(ends).toHaveLength(2);
    expect(ends.map((end) => end.isError).sort()).toEqual([false, true]);
    // The terminating emission acknowledgment does NOT resurrect the loop
    // into a settled follow-up: the batch is non-terminating (the cancelled
    // sibling's error IS a finalized result), so the loop attempted exactly
    // one follow-up transport call, which the abort turned into an aborted
    // turn — never a settled re-prompt, never a third model request.
    expect(script.callCount()).toBe(2);
    // The follow-up context carried BOTH tool results — observation
    // completeness: the emission's terminating ack and the abort error are
    // both on the transcript the capture seam reads.
    const followUpContext = script.contexts[1]!;
    const toolResults = followUpContext.filter((message) => message.role === "toolResult");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.some((message) => message.isError === true)).toBe(true);
    // The agent ended on the aborted follow-up turn.
    expect(events[events.length - 1]!.type).toBe("agent_end");
    // The emission's tool result itself was a success carrying the
    // acknowledgment (not an error-labeled refusal).
    const emissionResult = toolResultMessages(messages).find(
      (result) => result.toolName === registryCell.spec.toolName,
    );
    expect(emissionResult).toBeDefined();
    expect(emissionResult!.isError).toBe(false);
    expect(emissionResult!.content[0]!.text).toContain("payload acknowledged");
  });
});

// ---------------------------------------------------------------------------
// Constrained sampling through the REAL harness capability resolver (INV-1)
// ---------------------------------------------------------------------------

describe("EMISSION_CONSTRAINED_SAMPLING_REQUEST through the real pi-ai resolver (INV-1/FR-002)", () => {
  it("a preferred request NEVER throws on any route — resolved or declined, never fatal (FR-002/AD-2)", () => {
    for (const registryCell of REGISTRY_CELLS) {
      const tool = {
        name: registryCell.spec.toolName,
        description: "d",
        parameters: frozenPayloadSchemaParameters(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes),
        constrainedSampling: EMISSION_CONSTRAINED_SAMPLING_REQUEST,
      };
      for (const supportsStrictMode of [true, false]) {
        let resolved: boolean | undefined;
        expect(() => {
          resolved = resolveJsonSchemaStrictSampling(tool as never, supportsStrictMode);
        }, `${registryCell.kind}/${registryCell.version} supportsStrictMode=${supportsStrictMode}`).not.toThrow();
        // The request is either carried (true) or declined (the flag is
        // omitted) — lack of strict support alone cannot fail it.
        expect(resolved === true || resolved === undefined).toBe(true);
      }
    }
  });

  it("declines — never fails — the frozen schemas the resolved strictifier cannot strictify (AD-2's unconstrained-emission class)", () => {
    // The repo-resolved pi-ai (0.84.2) strictifier rejects $defs/$ref/oneOf
    // outright, and `reused: "ref"` emitted every frozen schema with $defs —
    // so EVERY cell's preferred request declines to "no strict flag" HERE.
    // The installed 0.83.0 runtime the qualification ran on had no schema
    // strictifier and carried `strict: true` for all four (feasibility §2.1
    // and the committed recordings) — a resolver behavior change is a §2.8
    // REQUALIFICATION trigger, which this pin is the tripwire for. Either
    // way the wire request still goes out and the engine stays validity/count
    // authoritative (FR-003/FR-006/FR-010).
    for (const registryCell of REGISTRY_CELLS) {
      const tool = {
        name: registryCell.spec.toolName,
        description: "d",
        parameters: frozenPayloadSchemaParameters(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes),
        constrainedSampling: EMISSION_CONSTRAINED_SAMPLING_REQUEST,
      };
      expect(resolveJsonSchemaStrictSampling(tool as never, true), `${registryCell.kind}/${registryCell.version}`).toBeUndefined();
      expect(resolveJsonSchemaStrictSampling(tool as never, false), `${registryCell.kind}/${registryCell.version}`).toBeUndefined();
    }
  });

  it("the negative control: a REQUIRED request throws on every decline path — the failure mode INV-1 forbids minting", () => {
    // INV-1's checkable rule (.claude/linter/rules/inv-1-no-strict-require-
    // constraint.json) fails closed on the literal spelling, so the negative
    // control constructs the forbidden mode without writing it: the resolver's
    // throws are the behavioral facts the rule guards, proven here against
    // the REAL resolver on both of its decline paths.
    const requiredMode = { type: "json_schema", strict: ["require"][0] } as const;
    const strictIncapableRoute = {
      name: "loom_emit_judge_verdict",
      description: "d",
      parameters: frozenPayloadSchemaParameters(EMISSION_TOOL_SPECS["judge-verdict"].schemaVersions.v1!.schemaBytes),
      constrainedSampling: requiredMode,
    };
    expect(() => resolveJsonSchemaStrictSampling(strictIncapableRoute as never, false)).toThrow(
      /requires JSON-schema constrained sampling, but strict tools are unsupported/,
    );
    const unstrictifiableSchema = {
      name: "loom_emit_reviewer_payload",
      description: "d",
      parameters: frozenPayloadSchemaParameters(EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions.v2!.schemaBytes),
      constrainedSampling: requiredMode,
    };
    expect(() => resolveJsonSchemaStrictSampling(unstrictifiableSchema as never, true)).toThrow(
      /requires JSON-schema constrained sampling,/,
    );
  });

  it("every registry cell's production tool definition carries the SAME preferred request beside its frozen parameters", () => {
    for (const registryCell of REGISTRY_CELLS) {
      const observed: unknown[] = [];
      const productionTool = observedEmissionTool(mintedBindingFor(registryCell, SHELL_REQUEST_ID), observed);
      // The registration shape: ONE request vocabulary for every emission
      // tool — the same frozen object the qualification probe registered as
      // the production shape — beside parameters minted from that cell's
      // frozen bytes.
      expect(productionTool["constrainedSampling"]).toBe(EMISSION_CONSTRAINED_SAMPLING_REQUEST);
      expect(productionTool["parameters"])
        .toEqual(JSON.parse(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes));
    }
  });
});
