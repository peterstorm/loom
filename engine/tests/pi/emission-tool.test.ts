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
 * - The registered tool is the PRODUCTION emission tool definition: the
 *   execute shell is the shared `acknowledgeEmissionExecution` decision
 *   (refusals THROW at the harness boundary — returning never sets the error
 *   flag; AD-3) over the registry's admission gate, the constrained-sampling
 *   request is the shared `EMISSION_CONSTRAINED_SAMPLING_REQUEST`, and the
 *   parameters are the frozen bytes. The suite therefore crosses the same
 *   policy seam production registers with — never a test twin.
 *
 * Observed pi behaviors pinned here (discovered by the committed probes):
 * - the in-child validation-retry loop: a tool-argument validation failure
 *   feeds the error back as a tool-role result and the loop re-prompts the
 *   model (~2 extra model requests per the qualification recordings); loom's
 *   request-slot attempt budget sits OUTSIDE this harness-level loop (FR-006's
 *   budget boundary).
 * - a thrown execute error is ALSO a non-terminating tool result and re-prompts
 *   the same way; `terminate: true` suppresses the follow-up turn only when
 *   EVERY finalized result in the batch is terminating (AD-3's mixed-batch
 *   caveat).
 * - non-TypeBox parameter schemas (the frozen bytes parsed as plain JSON) take
 *   pi-ai's JSON-Schema coercion path, which does NOT coerce a string-typed
 *   `schemaVersion` to the `const` number — the recorded per-branch refusals
 *   are reproduced verbatim.
 */

import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  validateToolArguments,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  acknowledgeEmissionExecution,
  EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  type EmissionToolAcknowledgment,
} from "../../src/core/harness-capture";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  frozenPayloadSchemaParameters,
  type EmissionSchemaVersion,
  type EmissionToolSpec,
} from "../../src/core/emission-tool";
import {
  REVIEWER_PAYLOAD_EXAMPLE_V2,
  reviewerPayloadV2Schema,
} from "../../src/core/reviewer-contract";
import { standaloneReviewerPayloadV3Schema } from "../../src/core/standalone-lineage-contract";

// ---------------------------------------------------------------------------
// Canonical and discriminating fixtures — minted from the real zod schemas
// ---------------------------------------------------------------------------

interface RegistryCell {
  readonly kind: keyof typeof EMISSION_TOOL_SPECS;
  readonly version: EmissionSchemaVersion;
  readonly spec: EmissionToolSpec;
}

const REGISTRY_CELLS: readonly RegistryCell[] = [
  { kind: "reviewer-payload", version: "v2", spec: EMISSION_TOOL_SPECS["reviewer-payload"] },
  { kind: "reviewer-payload", version: "v3", spec: EMISSION_TOOL_SPECS["reviewer-payload"] },
  { kind: "judge-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["judge-verdict"] },
  { kind: "refutation-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["refutation-verdict"] },
];

/** Canonical emission arguments per registry cell, minted through the real
 *  zod schemas (the qualification probe's fixture posture: a fixture exists
 *  only after `schema.parse` succeeds). */
const canonicalArguments = (kind: RegistryCell["kind"], version: EmissionSchemaVersion): unknown => {
  if (kind === "reviewer-payload" && version === "v2") {
    return reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "supported input bypasses the authorization check" }],
    });
  }
  if (kind === "reviewer-payload" && version === "v3") {
    return standaloneReviewerPayloadV3Schema.parse({
      schemaVersion: 3,
      kind: "standalone-successor-review",
      lineageDigest: "a".repeat(64),
      snapshotDigest: "b".repeat(64),
      priorAssessments: [],
      findings: [],
    });
  }
  if (kind === "judge-verdict") {
    return {
      criterion: "extensibility",
      rankings: [
        { candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the frozen registry" },
      ],
    };
  }
  return {
    criterion: "reproduction",
    verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "the failure cannot be triggered" }],
  };
};

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

/** Whitespace-only advisory prose: shape-valid under the frozen bytes (JSON
 *  Schema expresses minLength, never the zod refinements) — the AD-5
 *  disagreement's pi half. */
const whitespaceOnlyArguments = (kind: RegistryCell["kind"]): unknown => {
  if (kind === "reviewer-payload") {
    const finding = reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }],
    }).findings[0]!;
    return {
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...finding, claim: "   " }],
    };
  }
  if (kind === "judge-verdict") {
    return {
      criterion: "extensibility",
      rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "   " }],
    };
  }
  return {
    criterion: "reproduction",
    verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "   " }],
  };
};

// ---------------------------------------------------------------------------
// The production emission tool definition and the scripted transport
// ---------------------------------------------------------------------------

/** The minimal complete pi Model record — the readiness probe discovered a
 *  definition without `input`/`cost` crashes pi-ai client-side before any
 *  request; the scripted transport never dials `baseUrl`. */
const scriptedModel: Model<"openai-completions"> = {
  id: "scripted-emission-model",
  name: "scripted-emission-model",
  api: "openai-completions",
  provider: "scripted",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const zeroUsage = () => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantToolCallMessage = (calls: readonly { type: "toolCall"; id: string; name: string; arguments: unknown }[]): AssistantMessage =>
  ({
    role: "assistant",
    content: calls,
    api: "openai-completions",
    provider: "scripted",
    model: scriptedModel.id,
    usage: zeroUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  }) as AssistantMessage;

const assistantFinalTextMessage = (text: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "scripted",
    model: scriptedModel.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  }) as AssistantMessage;

interface ScriptedTurn {
  /** The transport for one assistant turn — the ONLY scripted part. */
  readonly streamFn: StreamFn;
  /** What the model saw on each request — the tool-role error feedback the
   *  re-prompt loop carries is asserted from these. */
  readonly contexts: readonly { readonly role: string; readonly isError?: boolean }[][];
  readonly callCount: () => number;
}

/** Script ONLY the model transport: one AssistantMessageEventStream per turn,
 *  shaped exactly as pi-ai's real streams are consumed (`start`, then the
 *  completing `done`). */
const scriptTurns = (responses: readonly AssistantMessage[]): ScriptedTurn => {
  let call = 0;
  const contexts: { role: string; isError?: boolean }[][] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(structuredClone(context.messages) as { role: string; isError?: boolean }[]);
    const message = responses[call];
    if (message === undefined) {
      // A script exhausted by an unexpected follow-up turn is a test defect,
      // never a silent empty stream: pi would treat an immediately-ended
      // stream as an error turn, masking the behavior under test.
      throw new Error(`scripted transport exhausted after ${call} response(s)`);
    }
    call += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    return stream;
  };
  return { streamFn, contexts, callCount: () => call };
};

/** What the production execute shell observes beside its decision: the
 *  arguments pi validated, appended as the observable record (the probe's
 *  execute contract — the complete request-bound transcript observation the
 *  capture adapters fold is T5/T7's; this record pins what execute SAW). */
const executeShellTool = (cell: RegistryCell, observed: unknown[]): Record<string, unknown> => ({
  name: cell.spec.toolName,
  label: `Emission ${cell.kind} ${cell.version}`,
  description: `Emit the frozen ${cell.kind} ${cell.version} payload. Parameters ARE the frozen schema.`,
  parameters: frozenPayloadSchemaParameters(cell.spec.schemaVersions[cell.version]!.schemaBytes),
  constrainedSampling: EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  execute: async (_toolCallId: string, params: unknown) => {
    observed.push(params);
    // The production shell's decision, minted once — refusals THROW at the
    // harness boundary (returning never sets the harness error flag, AD-3).
    const outcome = acknowledgeEmissionExecution(cell.spec, cell.version, params);
    if (outcome.kind === "refused") throw new Error(`${outcome.code}: ${outcome.message}`);
    return outcome.acknowledgment;
  },
});

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

const asAgentContext = (tools: readonly Record<string, unknown>[]): AgentContext =>
  ({ systemPrompt: "loom producer agent", messages: [], tools }) as unknown as AgentContext;

const asLoopConfig = (): AgentLoopConfig =>
  ({ model: scriptedModel, convertToLlm: (messages: readonly unknown[]) => messages }) as unknown as AgentLoopConfig;

const runScriptedLoop = async (
  tools: readonly Record<string, unknown>[],
  script: ScriptedTurn,
): Promise<{ readonly events: AgentEvent[]; readonly messages: readonly unknown[] }> => {
  const events: AgentEvent[] = [];
  const messages = await runAgentLoop(
    [{ role: "user", content: "Emit the issued payload exactly once.", timestamp: Date.now() }],
    asAgentContext(tools),
    asLoopConfig(),
    (event) => {
      events.push(event);
    },
    undefined,
    script.streamFn as StreamFn,
  );
  return { events, messages };
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
      expect(admitEmissionArguments(registryCell.spec, registryCell.version, validated).kind).toBe("valid");
    }
  });

  it("refuses the recorded malformed shapes with precise per-branch errors (feasibility §2.7)", () => {
    for (const registryCell of REGISTRY_CELLS) {
      const parameters = frozenPayloadSchemaParameters(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes);
      const tool = { name: registryCell.spec.toolName, description: "d", parameters };
      let message = "";
      try {
        validateToolArguments(
          tool as never,
          { id: "call-bad", name: registryCell.spec.toolName, arguments: malformedArguments(registryCell.kind, registryCell.version) } as never,
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `${registryCell.kind}/${registryCell.version} must be refused by pi's validator`).toContain(
        `Validation failed for tool "${registryCell.spec.toolName}"`,
      );
    }
  });

  it("reproduces the recorded per-branch fragments for the string-typed v2 violation class", () => {
    const v2 = REGISTRY_CELLS[0]!;
    const parameters = frozenPayloadSchemaParameters(v2.spec.schemaVersions[v2.version]!.schemaBytes);
    let message = "";
    try {
      validateToolArguments(
        { name: v2.spec.toolName, description: "d", parameters } as never,
        { id: "call-bad", name: v2.spec.toolName, arguments: malformedArguments("reviewer-payload", "v2") } as never,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    // The exact branches the qualification recordings show pi reporting — the
    // string-typed schemaVersion is NOT coerced to the const number and the
    // JSON-encoded findings is NOT coerced to the array; the discriminator's
    // second (wave-review) branch is reported too, so the union shape parses.
    expect(message).toContain("schemaVersion: must be number");
    expect(message).toContain("findings: must be array");
    expect(message).toContain("packetId: must have required properties packetId, generation, prior_findings");
  });

  it("admits no malformed judge score or refutation verdict enum through the real validator", () => {
    const judge = REGISTRY_CELLS[2]!;
    let judgeMessage = "";
    try {
      validateToolArguments(
        { name: judge.spec.toolName, description: "d", parameters: frozenPayloadSchemaParameters(judge.spec.schemaVersions.v1!.schemaBytes) } as never,
        { id: "c", name: judge.spec.toolName, arguments: malformedArguments("judge-verdict", "v1") } as never,
      );
    } catch (error) {
      judgeMessage = (error as Error).message;
    }
    expect(judgeMessage).toContain("score");

    const refutation = REGISTRY_CELLS[3]!;
    let refutationMessage = "";
    try {
      validateToolArguments(
        { name: refutation.spec.toolName, description: "d", parameters: frozenPayloadSchemaParameters(refutation.spec.schemaVersions.v1!.schemaBytes) } as never,
        { id: "c", name: refutation.spec.toolName, arguments: malformedArguments("refutation-verdict", "v1") } as never,
      );
    } catch (error) {
      refutationMessage = (error as Error).message;
    }
    expect(refutationMessage).toContain("verdict");
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
      const outcome = acknowledgeEmissionExecution(registryCell.spec, registryCell.version, validated);
      expect(outcome.kind, `${registryCell.kind}/${registryCell.version}`).toBe("refused");
    }
  });
});

// ---------------------------------------------------------------------------
// Real pi agent loop: terminating execute and the in-child retry loop
// ---------------------------------------------------------------------------

describe("real pi agent loop — terminating execute and the in-child validation-retry loop", () => {
  it("a valid emission executes, acknowledges, and settles WITHOUT a follow-up model request (FR-013)", async () => {
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-1", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) }]),
    ]);
    const { events } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

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
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-bad", name: registryCell.spec.toolName, arguments: malformedArguments(registryCell.kind, registryCell.version) }]),
      assistantToolCallMessage([{ type: "toolCall", id: "call-good", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) }]),
    ]);
    const { events } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

    // TWO model requests: the original turn and the re-prompt after the
    // tool-role error feedback (feasibility §2.7's observed ~2 extra requests).
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

  it("a pi-validation failure never reaches execute — the error message names the tool and the branch", async () => {
    const registryCell = REGISTRY_CELLS[0]!; // reviewer-payload v2, string-typed violation class
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-bad", name: registryCell.spec.toolName, arguments: malformedArguments(registryCell.kind, registryCell.version) }]),
      assistantFinalTextMessage("giving up; extraction fallback owns the attempt"),
    ]);
    const { events, messages } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

    // The validator refused before execute: nothing was observed, and the
    // error result carries pi's precise per-branch message.
    expect(observed).toHaveLength(0);
    const result = toolResultMessages(messages)[0]!;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`Validation failed for tool "${registryCell.spec.toolName}"`);
    expect(result.content[0]!.text).toContain("schemaVersion: must be number");
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
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1, whitespace-only strongest_idea
    const whitespaceArgs = whitespaceOnlyArguments(registryCell.kind);
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-ws", name: registryCell.spec.toolName, arguments: whitespaceArgs }]),
      assistantFinalTextMessage("the engine refused my emission; finishing in prose"),
    ]);
    const { messages } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

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

  it("a mixed batch does NOT terminate — one non-terminating result forces the follow-up turn (AD-3)", async () => {
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1
    const observed: unknown[] = [];
    const script = scriptTurns([
      assistantToolCallMessage([
        { type: "toolCall", id: "call-emit", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) },
        { type: "toolCall", id: "call-note", name: "scratch_note", arguments: {} },
      ]),
      assistantFinalTextMessage("batch finished with a plain note; the emission alone would have terminated"),
    ]);
    const { events } = await runScriptedLoop([executeShellTool(registryCell, observed), plainTool], script);

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
      const productionTool = executeShellTool(registryCell, observed);
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
