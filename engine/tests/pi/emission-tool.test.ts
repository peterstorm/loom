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
 *   (pi/emission-tool.ts, wired by pi/extension.ts's readiness command): the
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
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
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
  observeEmissionCalls,
  type EmissionCallFrame,
  type EmissionToolAcknowledgment,
} from "../../src/core/harness-capture";
import { selectCanonicalPayload } from "../../src/core/emission-ingestion";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  frozenPayloadSchemaParameters,
  issueEmissionBinding,
  type EmissionSchemaVersion,
  type EmissionToolSpec,
  type IssuedEmissionBinding,
} from "../../src/core/emission-tool";
import {
  REVIEWER_PAYLOAD_EXAMPLE_V2,
  reviewerPayloadV2Schema,
} from "../../src/core/reviewer-contract";
import { standaloneReviewerPayloadV3Schema } from "../../src/core/standalone-lineage-contract";
import { sha256Hex } from "../../src/core/review-packet";
import {
  decideEmissionToolRegistration,
  describeEmissionRegistrationContradiction,
  emissionReadinessReport,
  emissionToolDefinition,
  EMISSION_HOLD_ENTRY_TYPE,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  emissionToolFamily,
  LOOM_EMISSION_BINDING_ENV,
  parseEmissionChildProvisioning,
  type EmissionToolRegistration,
} from "../../../pi/emission-tool";
import { piEmissionCallFrames } from "../../../pi/transcript-adapter";
import {
  associatePiSpawnLifecycle,
  classifyPiIssuedReviewRequest,
  piIssuedReviewerCaptureObservation,
  piReviewerCaptureObservation,
  qualifyPiIssuedReviewRequest,
  type PiIssuedReviewRequestClass,
} from "../../../pi/extension";
import {
  expectedSpawnEmissionCapability,
  renderEmissionDescriptor,
  type AdmittedSpawnItem,
  type IssuedSpawnEmissionAuthority,
} from "../../src/core/spawn-admission";
import { planPiWriteGrants } from "../../src/core/pi-write-grant-plan";

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

/** The transport's aborted-turn result: the final AssistantMessage carries
 *  stopReason "aborted" (pi-ai's cancellation contract — the final message of
 *  an aborted assistant turn) and whatever partial content had streamed when
 *  the cancel arrived — here, nothing. */
const assistantAbortedTurnMessage = (): AssistantMessage =>
  ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "scripted",
    model: scriptedModel.id,
    usage: zeroUsage(),
    stopReason: "aborted",
    errorMessage: "aborted by the caller",
    timestamp: Date.now(),
  }) as AssistantMessage;

/** The caller's cancellation arrived while the model streamed the emission
 *  tool call: the aborted turn's partial message still carries a structurally
 *  complete toolCall block. Because execute never ran, the transcript adapter
 *  classifies the call as incomplete and unusable rather than authoritative. */
const assistantAbortedToolCallMessage = (calls: readonly { type: "toolCall"; id: string; name: string; arguments: unknown }[]): AssistantMessage =>
  ({
    ...assistantToolCallMessage(calls),
    stopReason: "aborted",
    errorMessage: "aborted by the caller",
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
  const streamFn: StreamFn = (_model, context, options) => {
    contexts.push(structuredClone(context.messages) as { role: string; isError?: boolean }[]);
    // The transport honours the caller's cancellation signal the way real
    // pi-ai streams do: a request whose signal fires before its response
    // completes finishes as an aborted turn — it never consumes a scripted
    // response.
    const message: AssistantMessage = options?.signal?.aborted
      ? assistantAbortedTurnMessage()
      : responses[call];
    if (message === undefined) {
      // A script exhausted by an unexpected follow-up turn is a test defect,
      // never a silent empty stream: pi would treat an immediately-ended
      // stream as an error turn, masking the behavior under test.
      throw new Error(`scripted transport exhausted after ${call} response(s)`);
    }
    call += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "aborted") {
      // pi-ai's stream contract: an aborted turn completes through the
      // stream's `error` event, whose extracted result is the aborted
      // AssistantMessage the agent loop reads.
      stream.push({ type: "error", reason: "aborted", error: message });
    } else {
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
    }
    return stream;
  };
  return { streamFn, contexts, callCount: () => call };
};

/** The PRODUCTION registration surface (pi/emission-tool.ts) over a minted
 *  issued binding: the exact tool definition production registers, with the
 *  suite's observation record wrapping the PRODUCTION execute — the
 *  arguments pi validated, seen beside the same admission decision. The suite
 *  crosses the same seam the extension's readiness command registers with —
 *  never a test twin. */
const mintedBindingFor = (cell: RegistryCell, requestId: string): IssuedEmissionBinding => {
  const minted = issueEmissionBinding({
    requestId,
    kind: cell.kind,
    version: cell.version,
    toolName: cell.spec.toolName,
    schemaDigest: sha256Hex(cell.spec.schemaVersions[cell.version]!.schemaBytes),
  });
  if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
  return minted.value;
};

const executeShellTool = (cell: RegistryCell, observed: unknown[]): Record<string, unknown> => {
  const definition = emissionToolDefinition(mintedBindingFor(cell, "req-emission-tool-t5-shell"));
  return {
    ...definition,
    execute: async (toolCallId: string, params: unknown) => {
      observed.push(params);
      return definition.execute(toolCallId, params);
    },
  } as Record<string, unknown>;
};

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

const asAgentContext = (tools: readonly Record<string, unknown>[]): AgentContext =>
  ({ systemPrompt: "loom producer agent", messages: [], tools }) as unknown as AgentContext;

const asLoopConfig = (extra?: { beforeToolCall?: AgentLoopConfig["beforeToolCall"] }): AgentLoopConfig =>
  ({ model: scriptedModel, convertToLlm: (messages: readonly unknown[]) => messages, ...extra }) as unknown as AgentLoopConfig;

const runScriptedLoop = async (
  tools: readonly Record<string, unknown>[],
  script: ScriptedTurn,
  loop?: { readonly signal?: AbortSignal; readonly beforeToolCall?: AgentLoopConfig["beforeToolCall"] },
): Promise<{ readonly events: AgentEvent[]; readonly messages: readonly unknown[] }> => {
  const events: AgentEvent[] = [];
  const messages = await runAgentLoop(
    [{ role: "user", content: "Emit the issued payload exactly once.", timestamp: Date.now() }],
    asAgentContext(tools),
    asLoopConfig(loop?.beforeToolCall ? { beforeToolCall: loop.beforeToolCall } : undefined),
    (event) => {
      events.push(event);
    },
    loop?.signal,
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
    const registryCell = REGISTRY_CELLS[0]!; // reviewer-payload v2, string-typed violation class
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
    const { events, messages } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

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
    const registryCell = REGISTRY_CELLS[0]!; // reviewer-payload v2
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
    const { events, messages } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

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

  /** The PRODUCTION tool definition over an explicit issued binding, with the
   *  suite's observation record around the PRODUCTION execute — the same
   *  posture as executeShellTool, parametrized by the binding so the settled
   *  transcript can be captured under the SAME issued request the tool was
   *  registered with. */
  const observedProductionTool = (issued: IssuedEmissionBinding, observed: unknown[]): Record<string, unknown> => {
    const definition = emissionToolDefinition(issued);
    return {
      ...definition,
      execute: async (toolCallId: string, params: unknown) => {
        observed.push(params);
        return definition.execute(toolCallId, params);
      },
    } as Record<string, unknown>;
  };

  /** The path-REFINED reviewer binding mint: the capture observation takes the
   *  reviewer-payload refinement, so the fixture mints the refined view
   *  directly (the path scoping is a type fact, never a runtime check). */
  const mintedReviewerBindingFor = (requestId: string): IssuedEmissionBindingOf<"reviewer-payload"> => {
    const minted = issueEmissionBinding({ requestId, kind: "reviewer-payload", version: "v2" });
    if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
    return minted.value;
  };

  it("an engine-refined refusal that threw is terminal even with usable final text — one re-prompt, the retained diagnostic, and the final text never resurrects the attempt (AD-8/FR-006)", async () => {
    const cell = REGISTRY_CELLS[0]!; // reviewer-payload v2 — the prose-bearing cell the disagreement is defined for
    const issued = mintedReviewerBindingFor("req-emission-invalid-plus-final");
    const observed: unknown[] = [];
    const tool = observedProductionTool(issued, observed);
    const settledPayload = reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }],
    });
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
    const admission = admitEmissionArguments(cell.spec, cell.version, whitespaceArgs);
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
    const cell = REGISTRY_CELLS[0]!; // reviewer-payload v2
    const issued = mintedReviewerBindingFor("req-emission-refused-then-corrected");
    const observed: unknown[] = [];
    const tool = observedProductionTool(issued, observed);
    const corrected = reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }],
    });
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

  it("a cancelled assistant turn aborts the loop BEFORE the emission executes — no tool execution, no follow-up model request, the toolCall block stays observable (AD-3)", async () => {
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1
    const observed: unknown[] = [];
    // The caller cancelled while the model streamed the emission tool call:
    // the transport completes the turn as aborted, partial toolCall block
    // intact — the cancellation path a live launcher or user produces.
    const script = scriptTurns([
      assistantAbortedToolCallMessage([
        { type: "toolCall", id: "call-1", name: registryCell.spec.toolName, arguments: canonicalArguments(registryCell.kind, registryCell.version) },
      ]),
    ]);
    const { events, messages } = await runScriptedLoop([executeShellTool(registryCell, observed)], script);

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
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1
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
      [executeShellTool(registryCell, observed), plainTool],
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

// ---------------------------------------------------------------------------
// T5: the production registration/readiness shell (pi/emission-tool.ts) and
// the complete request-bound transcript observations (pi/transcript-adapter.ts)
// ---------------------------------------------------------------------------

import {
  canonicalStructuralEquals,
  parseContextDigest,
} from "../../src/core/orchestration-contract/identity";
import type { IssuedEmissionBindingOf } from "../../src/core/emission-tool";
import type { FinalPayloadCandidate } from "../../src/core/harness-capture";

const REVIEWER_V2_CELL = REGISTRY_CELLS[0]!;
const REVIEWER_V3_CELL = REGISTRY_CELLS[1]!;
const JUDGE_V1_CELL = REGISTRY_CELLS[2]!;
const REFUTATION_V1_CELL = REGISTRY_CELLS[3]!;

const mintedRefusal = (minted: { ok: boolean; error?: { code: string; message: string } }): never => {
  throw new Error(`fixture binding refused: ${minted.error?.code} — ${minted.error?.message}`);
};

const mintedJudgeBinding = (): IssuedEmissionBinding => {
  const minted = issueEmissionBinding({ requestId: "req-emission-tool-t5-obs", kind: "judge-verdict", version: "v1" });
  return minted.ok ? minted.value : mintedRefusal(minted);
};

const mintedReviewerBinding = (): IssuedEmissionBindingOf<"reviewer-payload"> => {
  const minted = issueEmissionBinding({ requestId: "req-emission-tool-t5-obs", kind: "reviewer-payload", version: "v2" });
  return minted.ok ? minted.value : mintedRefusal(minted);
};

const issuedLookupContext = (() => {
  const parsed = parseContextDigest(sha256Hex("t5-issued-refutation-lookup"));
  if (!parsed.ok) throw new Error(`fixture context digest refused: ${parsed.error.message}`);
  return parsed.value;
})();

describe("Pi mixed-batch lifecycle association", () => {
  it("keeps each item paired with its guard, emission expectation, roster identity, and write-grant decision", () => {
    const emissionBinding = mintedReviewerBinding();
    const contextDigest = parseContextDigest(sha256Hex("t5-mixed-batch-context"));
    if (!contextDigest.ok) throw new Error(`fixture context digest refused: ${contextDigest.error.message}`);

    const admitted: readonly AdmittedSpawnItem[] = Object.freeze([
      Object.freeze({
        item: Object.freeze({ agent: "code-reviewer" as const, task: "review the issued payload" }),
        taskExecutionSpawn: Object.freeze({ kind: "non-implementation" as const }),
        emissionExpectation: Object.freeze({
          kind: "emission-enabled" as const,
          binding: emissionBinding,
          contextDigest: contextDigest.value,
          route: Object.freeze({ provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14" }),
        }),
      }),
      Object.freeze({
        item: Object.freeze({ agent: "code-implementer-agent" as const, task: "Task ID: T5\nimplement the shell" }),
        taskExecutionSpawn: Object.freeze({
          kind: "implementation" as const,
          prompt: "Task ID: T5\nimplement the shell",
          description: "",
        }),
        emissionExpectation: Object.freeze({ kind: "no-emission-tool" as const }),
      }),
      Object.freeze({
        item: Object.freeze({ agent: "review-verifier-agent" as const, task: "verify the prior finding" }),
        taskExecutionSpawn: Object.freeze({ kind: "standalone" as const }),
        emissionExpectation: Object.freeze({ kind: "no-emission-tool" as const }),
      }),
    ]);

    const associated = associatePiSpawnLifecycle(admitted, "tool-call-mixed-t5");
    expect(associated.map(({ slot, admission }) => ({
      slot,
      agent: admission.item.agent,
      guard: admission.taskExecutionSpawn.kind,
      expectation: admission.emissionExpectation.kind,
    }))).toEqual([
      { slot: 0, agent: "code-reviewer", guard: "non-implementation", expectation: "emission-enabled" },
      { slot: 1, agent: "code-implementer-agent", guard: "implementation", expectation: "no-emission-tool" },
      { slot: 2, agent: "review-verifier-agent", guard: "standalone", expectation: "no-emission-tool" },
    ]);
    expect(new Set(associated.map(({ rosterId }) => rosterId)).size).toBe(3);
    expect(Object.isFrozen(associated)).toBe(true);
    for (const [slot, association] of associated.entries()) {
      expect(association.admission).toBe(admitted[slot]);
      expect(Object.isFrozen(association)).toBe(true);
    }

    // The existing grant planner remains unchanged. The shell derives its two
    // positional inputs locally from these paired records, then immediately
    // rejoins each requirement to the same slot; the implementation child
    // keeps T5's session grant while reviewer/verifier guards keep no grant.
    const grantPlan = planPiWriteGrants(
      associated.map(({ admission }) => admission.item),
      associated.map(({ admission }) => admission.taskExecutionSpawn),
      true,
    );
    expect(grantPlan).toEqual({
      ok: true,
      requirements: [
        { kind: "none" },
        { kind: "session", taskId: "T5" },
        { kind: "none" },
      ],
    });
  });
});

describe("Pi issued-request classification under a registered review facade", () => {
  const runId = "run.t5-issued-refutation";
  const requestId = mintedReviewerBinding().requestId;
  const refutationRequest = {
    runId,
    requestId,
    contextDigest: issuedLookupContext,
    program: "refutation-panel",
    role: "review-verifier-agent",
  } as const;

  it("admits independently published refutation children of standalone and Wave programs as extraction-only until they carry their own descriptor", () => {
    const programs = [
      {
        kind: "standalone-review" as const,
        schemaVersion: 3 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V3_CELL.spec.schemaVersions.v3!.schemaBytes) },
      },
      {
        kind: "wave-gate" as const,
        schemaVersion: 2 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V2_CELL.spec.schemaVersions.v2!.schemaBytes) },
      },
    ];
    for (const program of programs) {
      const classified = classifyPiIssuedReviewRequest(runId, program, refutationRequest);
      expect(classified.ok, program.kind).toBe(true);
      if (!classified.ok) continue;
      expect(classified.value).toEqual({
        kind: "refutation-panel-extraction",
        claim: {
          requestId,
          contextDigest: issuedLookupContext,
          producerKind: "reviewer-payload",
          version: "v1",
        },
      });
    }
  });

  it("keeps a direct registered reviewer request on its exact issued emission protocol", () => {
    const schemaDigest = mintedReviewerBinding().schemaDigest;
    const classified = classifyPiIssuedReviewRequest(
      runId,
      { kind: "wave-gate", schemaVersion: 2, reviewerProtocol: { schemaDigest } },
      { ...refutationRequest, program: "wave-gate", role: "code-reviewer" },
    );
    expect(classified).toEqual({
      ok: true,
      value: {
        kind: "review-program-emission",
        claim: {
          requestId,
          contextDigest: issuedLookupContext,
          producerKind: "reviewer-payload",
          version: "v2",
          schemaDigest,
        },
      },
    });
  });

  it("fails closed for a forged run, a substituted refutation role, and a foreign child program", () => {
    for (const request of [
      { ...refutationRequest, runId: "run.forged" },
      { ...refutationRequest, role: "code-reviewer" },
      { ...refutationRequest, program: "architecture-panel" },
    ]) {
      const classified = classifyPiIssuedReviewRequest(
        runId,
        { kind: "standalone-review", schemaVersion: 1 },
        request,
      );
      expect(classified.ok).toBe(false);
      if (!classified.ok) expect(classified.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("the production issued-review capture decision", () => {
  const runId = "run.t5-capture-decision";
  const request = {
    runId,
    requestId: mintedReviewerBinding().requestId,
    contextDigest: issuedLookupContext,
    program: "wave-gate",
    role: "code-reviewer",
  } as const;
  const finalMessages = [{
    role: "assistant",
    content: [{ type: "text", text: '{"schemaVersion":2,"kind":"wave-review","packetId":"p","generation":1,"prior_findings":[],"findings":[]}' }],
  }];

  it.each([
    {
      version: "v2",
      program: {
        kind: "wave-gate" as const,
        schemaVersion: 2 as const,
        reviewerProtocol: { schemaDigest: sha256Hex("not-the-issued-frozen-schema-v2") },
      },
    },
    {
      version: "v3",
      program: {
        kind: "standalone-review" as const,
        schemaVersion: 3 as const,
        reviewerProtocol: { schemaDigest: sha256Hex("not-the-issued-frozen-schema-v3") },
      },
    },
  ])("makes a malformed current $version issued binding unavailable instead of falling through to final-message extraction", ({ program }) => {
    const classified = classifyPiIssuedReviewRequest(
      runId,
      program,
      { ...request, program: program.kind },
    );
    if (!classified.ok) throw new Error(classified.error.message);

    const observation = piIssuedReviewerCaptureObservation(classified.value, finalMessages);
    expect(observation.kind).toBe("unavailable");
    if (observation.kind === "unavailable") {
      expect(observation.reason).toBe("emission-binding");
      expect(observation.message).toContain("schema-digest-mismatch");
      expect(observation.message).toContain("issued reviewer emission binding is unavailable");
      expect(Buffer.byteLength(observation.message, "utf8")).toBeLessThan(1_000);
    }
  });

  it("keeps the explicit archived reviewer v1 final-message fallback", () => {
    const classified = classifyPiIssuedReviewRequest(
      runId,
      { kind: "wave-gate", schemaVersion: 1 },
      request,
    );
    if (!classified.ok) throw new Error(classified.error.message);

    const observation = piIssuedReviewerCaptureObservation(classified.value, finalMessages);
    expect(observation.kind).toBe("candidates");
    if (observation.kind === "candidates") {
      expect(observation.candidates).toEqual([{
        origin: "content[0].text",
        text: finalMessages[0]!.content[0]!.text,
      }]);
    }
  });
});

describe("qualified published Pi request routes bind descriptor admission independently of task text", () => {
  const reviewPrograms = [
    {
      version: "v2" as const,
      program: {
        kind: "wave-gate" as const,
        schemaVersion: 2 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V2_CELL.spec.schemaVersions.v2!.schemaBytes) },
      },
    },
    {
      version: "v3" as const,
      program: {
        kind: "standalone-review" as const,
        schemaVersion: 3 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V3_CELL.spec.schemaVersions.v3!.schemaBytes) },
      },
    },
  ] as const;

  const qualifiedAuthority = (
    classified: PiIssuedReviewRequestClass,
    role: "code-reviewer" | "review-verifier-agent",
    provider: string,
    model: string,
  ): IssuedSpawnEmissionAuthority => {
    const qualified = qualifyPiIssuedReviewRequest(classified, {
      role,
      harnessBinding: { pi: { provider, model } },
    });
    if (!qualified.ok) throw new Error(`fixture route qualification refused: ${qualified.error.message}`);
    return qualified.value;
  };

  const admissionFor = (
    authority: IssuedSpawnEmissionAuthority,
    agent: "code-reviewer" | "review-verifier-agent",
    descriptor = "",
  ) => expectedSpawnEmissionCapability({
    agent,
    task: `LOOM_REQUEST_ID: ${authority.claim.requestId}\n` +
      `LOOM_CONTEXT_DIGEST: ${authority.claim.contextDigest}\n${descriptor}`,
  }, () => ({ ok: true, value: authority }));

  it("admits v2/v3 cloud-pinned reviewers without a descriptor as no-tool, and a valid-looking descriptor cannot upgrade either route", () => {
    const previousAmbientModel = process.env["PI_MODEL"];
    process.env["PI_MODEL"] = "glm-5.3-flash-spark-tp2-v14";
    try {
      for (const { version, program } of reviewPrograms) {
        const request = {
          runId: `run.t5-cloud-${version}`,
          requestId: mintedBindingFor(version === "v2" ? REVIEWER_V2_CELL : REVIEWER_V3_CELL, `req-t5-cloud-${version}`).requestId,
          contextDigest: issuedLookupContext,
          program: program.kind,
          role: "code-reviewer",
        } as const;
        const classified = classifyPiIssuedReviewRequest(request.runId, program, request);
        if (!classified.ok) throw new Error(classified.error.message);
        const authority = qualifiedAuthority(classified.value, request.role, "openai-codex", "gpt-6-sol");
        expect(authority.route, version).toMatchObject({ kind: "extraction-only" });
        expect(admissionFor(authority, request.role), version).toEqual({
          ok: true,
          expectation: { kind: "no-emission-tool" },
        });

        const minted = issueEmissionBinding({
          requestId: authority.claim.requestId,
          kind: authority.claim.producerKind,
          version: authority.claim.version,
          schemaDigest: authority.claim.schemaDigest,
        });
        if (!minted.ok) throw new Error(minted.error.message);
        const forgedUpgrade = admissionFor(
          authority,
          request.role,
          renderEmissionDescriptor(minted.value, authority.claim.contextDigest),
        );
        expect(forgedUpgrade.ok, version).toBe(false);
        if (!forgedUpgrade.ok) expect(forgedUpgrade.reason).toContain("independently issued route is extraction-only");
      }
    } finally {
      if (previousAmbientModel === undefined) delete process.env["PI_MODEL"];
      else process.env["PI_MODEL"] = previousAmbientModel;
    }
  });

  it("requires the exact descriptor for qualified frozen v2/v3 desktop routes and refuses omitted or forged descriptors", () => {
    for (const { version, program } of reviewPrograms) {
      const request = {
        runId: `run.t5-qualified-${version}`,
        requestId: mintedBindingFor(version === "v2" ? REVIEWER_V2_CELL : REVIEWER_V3_CELL, `req-t5-qualified-${version}`).requestId,
        contextDigest: issuedLookupContext,
        program: program.kind,
        role: "code-reviewer",
      } as const;
      const classified = classifyPiIssuedReviewRequest(request.runId, program, request);
      if (!classified.ok) throw new Error(classified.error.message);
      const authority = qualifiedAuthority(
        classified.value,
        request.role,
        "desktop-vllm",
        "glm-5.3-flash-spark-tp2-v14",
      );
      if (authority.route?.kind !== "emission-enabled") {
        throw new Error(`expected an emission-enabled ${version} route`);
      }

      const omitted = admissionFor(authority, request.role);
      expect(omitted.ok, version).toBe(false);
      if (!omitted.ok) expect(omitted.reason).toContain("missing its required LOOM_EMISSION_DESCRIPTOR descriptor");

      const forgedContext = parseContextDigest(sha256Hex(`t5-forged-descriptor-${version}`));
      if (!forgedContext.ok) throw new Error(forgedContext.error.message);
      const forged = admissionFor(
        authority,
        request.role,
        renderEmissionDescriptor(authority.route.binding, forgedContext.value),
      );
      expect(forged.ok, version).toBe(false);
      if (!forged.ok) expect(forged.reason).toContain("differs from the descriptor");

      expect(admissionFor(
        authority,
        request.role,
        renderEmissionDescriptor(authority.route.binding, authority.route.contextDigest),
      ), version).toEqual({
        ok: true,
        expectation: {
          kind: "emission-enabled",
          binding: authority.route.binding,
          contextDigest: authority.route.contextDigest,
          route: {
            provider: "desktop-vllm",
            model: "glm-5.3-flash-spark-tp2-v14",
          },
        },
      });
    }
  });

  it("keeps an older refutation-panel request extraction-only even on the qualified desktop route", () => {
    const request = {
      runId: "run.t5-old-refutation-route",
      requestId: mintedBindingFor(REVIEWER_V2_CELL, "req-t5-old-refutation-route").requestId,
      contextDigest: issuedLookupContext,
      program: "refutation-panel",
      role: "review-verifier-agent",
    } as const;
    const program = reviewPrograms[0]!.program;
    const classified = classifyPiIssuedReviewRequest(request.runId, program, request);
    if (!classified.ok) throw new Error(classified.error.message);
    expect(classified.value.kind).toBe("refutation-panel-extraction");
    const authority = qualifiedAuthority(
      classified.value,
      request.role,
      "desktop-vllm",
      "glm-5.3-flash-spark-tp2-v14",
    );
    expect(authority.route).toMatchObject({ kind: "extraction-only" });
    expect(admissionFor(authority, request.role)).toEqual({
      ok: true,
      expectation: { kind: "no-emission-tool" },
    });

    const descriptorBinding = issueEmissionBinding({
      requestId: request.requestId,
      kind: "reviewer-payload",
      version: "v2",
    });
    if (!descriptorBinding.ok) throw new Error(descriptorBinding.error.message);
    const forgedUpgrade = admissionFor(
      authority,
      request.role,
      renderEmissionDescriptor(descriptorBinding.value, request.contextDigest),
    );
    expect(forgedUpgrade.ok).toBe(false);
    if (!forgedUpgrade.ok) expect(forgedUpgrade.reason).toContain("independently issued route is extraction-only");
  });
});

describe("the production emission tool definition — the exact registration surface (FR-001/FR-002/FR-013/FR-021/SC-006)", () => {
  it("carries the registry's exact name, the frozen bytes as parameters, and the ONE preferred sampling request, for every registry cell", () => {
    for (const registryCell of REGISTRY_CELLS) {
      const definition = emissionToolDefinition(mintedBindingFor(registryCell, "req-emission-tool-t5-def"));
      expect(definition.name, `${registryCell.kind}/${registryCell.version}`).toBe(registryCell.spec.toolName);
      expect(definition.label).toBe(`Emission ${registryCell.kind} ${registryCell.version}`);
      // SC-006 at the definition surface: the parameters ARE the frozen
      // payload schema bytes, parsed once — one schema, no second contract.
      expect(definition.parameters).toEqual(JSON.parse(registryCell.spec.schemaVersions[registryCell.version]!.schemaBytes));
      // INV-1: the ONE preferred-strict request — the same object every
      // emission tool registers with, minted in the engine core.
      expect(definition.constrainedSampling).toBe(EMISSION_CONSTRAINED_SAMPLING_REQUEST);
      // The wire-form canonicalization rides the definition, wired to the
      // SAME parameters object: the recorded string-typed class canonicalizes
      // into a payload the engine's admission gate admits.
      expect(typeof definition.prepareArguments).toBe("function");
      if (registryCell.kind === "reviewer-payload" && registryCell.version === "v2") {
        const stringy = {
          schemaVersion: "2",
          kind: "standalone-review",
          findings: JSON.stringify([
            { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "supported input bypasses the authorization check" },
          ]),
        };
        const canonicalized = definition.prepareArguments(stringy);
        expect(canonicalized).not.toBe(stringy);
        expect(admitEmissionArguments(registryCell.spec, registryCell.version, canonicalized).kind).toBe("valid");
      }
      expect(typeof definition.description).toBe("string");
    }
  });

  it("execute admits valid arguments into the minimal terminating acknowledgment with NO payload echo", async () => {
    const registryCell = JUDGE_V1_CELL;
    const definition = emissionToolDefinition(mintedBindingFor(registryCell, "req-emission-tool-t5-exec"));
    const args = canonicalArguments(registryCell.kind, registryCell.version);
    const acknowledgment = await definition.execute("call-exec-1", args);
    // FR-013: terminating, minimal, empty details — and never the payload.
    expect(acknowledgment.terminate).toBe(true);
    expect(acknowledgment.details).toEqual({});
    expect(acknowledgment.content).toHaveLength(1);
    expect(acknowledgment.content[0]!.type).toBe("text");
    expect(acknowledgment.content[0]!.text).toBe("payload acknowledged");
    expect(JSON.stringify(acknowledgment.content)).not.toContain("extensibility");
  });

  it("execute THROWS the engine's refusal verbatim for engine-refined arguments — never a returned error-labeled object (AD-3)", async () => {
    const registryCell = JUDGE_V1_CELL;
    const definition = emissionToolDefinition(mintedBindingFor(registryCell, "req-emission-tool-t5-throw"));
    const whitespaceArgs = whitespaceOnlyArguments(registryCell.kind);
    let thrown: unknown = null;
    try {
      await definition.execute("call-ws", whitespaceArgs);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The refusal is the admission's own code and message — the model's
    // correction surface is the parse's vocabulary, never a shell-invented
    // string (FR-006 retained diagnostics).
    expect(message).toContain("invalid-schema");
    expect(message).toContain("frozen schema");
  });

  it("the definition constructor refuses a binding whose registry cell is absent — the invariant guard over minted bindings", () => {
    // The mint refuses unsupported (kind, version) pairs, so the guard is
    // unreachable through the mint; this pins it against future construction
    // paths with a test-confined forged binding.
    const minted = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-guard");
    const forged = { ...minted, version: "v9" } as unknown as IssuedEmissionBinding;
    expect(() => emissionToolDefinition(forged)).toThrow(/invariant failed/);
  });
});

describe("the child's emission-tool registration state machine — idempotent only for the exact same request/kind/version/digest (AD-4)", () => {
  const registeredA = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-t5-reg-a");
  const registeredAReplay = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-t5-reg-a");
  const differentRequest = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-t5-reg-b");
  const differentVersion = mintedBindingFor(REVIEWER_V3_CELL, "req-emission-tool-t5-reg-a");
  const differentKind = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-reg-a");
  const differentDigestSource = REFUTATION_V1_CELL;

  it("registers on an unregistered child and is idempotent for the exact same binding", () => {
    const unregistered: EmissionToolRegistration = { kind: "unregistered" };
    expect(decideEmissionToolRegistration(unregistered, registeredA)).toEqual({ kind: "register" });
    const registered: EmissionToolRegistration = { kind: "registered", binding: registeredA };
    expect(decideEmissionToolRegistration(registered, registeredAReplay)).toEqual({ kind: "idempotent" });
  });

  it("refuses every contradictory re-registration, naming both bindings in the diagnostic", () => {
    const registered: EmissionToolRegistration = { kind: "registered", binding: registeredA };
    for (const [label, attempted] of [
      ["different request", differentRequest],
      ["different version", differentVersion],
      ["different kind", differentKind],
      ["different digest source", mintedBindingFor(differentDigestSource, "req-emission-tool-t5-reg-a")],
    ] as const) {
      const decision = decideEmissionToolRegistration(registered, attempted);
      if (decision.kind !== "contradictory") {
        throw new Error(`expected a contradictory decision for ${label}, received ${decision.kind}`);
      }
      expect(decision.registered.requestId).toBe(registeredA.requestId);
      expect(decision.attempted).toBe(attempted);
      const message = describeEmissionRegistrationContradiction(decision);
      expect(message, label).toContain(registeredA.requestId);
      expect(message, label).toContain(attempted.requestId);
      expect(message, label).toContain(registeredA.version);
      expect(message, label).toContain(registeredA.schemaDigest);
    }
  });
});

describe("the child's provisioning ADT — the issued binding certified against the frozen registry, never trusted (FR-008)", () => {
  const provisionedClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const binding = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-prov");
    return {
      requestId: binding.requestId,
      contextDigest: sha256Hex(`emission-startup-context:${binding.requestId}`),
      kind: binding.kind.kind,
      version: binding.version,
      toolName: binding.toolName,
      schemaDigest: binding.schemaDigest,
      ...overrides,
    };
  };

  const parseRaw = (raw: string | undefined) => parseEmissionChildProvisioning(raw);

  it("only an absent env is not-provisioned; present blank provisioning refuses instead of silently becoming extraction-only", () => {
    expect(parseRaw(undefined)).toEqual({ kind: "not-provisioned" });
    for (const raw of ["", "   "]) {
      const refused = parseRaw(raw);
      expect(refused.kind).toBe("provisioning-refused");
      if (refused.kind === "provisioning-refused") {
        expect(refused.code).toBe("invalid-json");
        expect(refused.reason).toContain("not valid JSON");
      }
    }
  });

  it("refuses non-JSON and non-object payloads with a bounded reason", () => {
    const notJson = parseRaw("{not json");
    expect(notJson.kind).toBe("provisioning-refused");
    if (notJson.kind === "provisioning-refused") {
      expect(notJson.code).toBe("invalid-json");
      expect(notJson.reason).toContain("not valid JSON");
    }
    const notObject = parseRaw("[]");
    expect(notObject.kind).toBe("provisioning-refused");
    if (notObject.kind === "provisioning-refused") {
      expect(notObject.code).toBe("non-object");
      expect(notObject.reason).toContain("not an object");
    }
  });

  it("refuses an out-of-contract context digest and a non-string kind before the mint is consulted", () => {
    const badDigest = parseRaw(JSON.stringify(provisionedClaims({ contextDigest: "sha256-not-hex" })));
    expect(badDigest.kind).toBe("provisioning-refused");
    if (badDigest.kind === "provisioning-refused") {
      expect(badDigest.code).toBe("invalid-context-digest");
      expect(badDigest.reason).toContain("context-digest");
    }
    const badKind = parseRaw(JSON.stringify(provisionedClaims({ kind: 42 })));
    expect(badKind.kind).toBe("provisioning-refused");
    if (badKind.kind === "provisioning-refused") {
      expect(badKind.code).toBe("invalid-claim-type");
      expect(badKind.reason).toContain("not a producer kind");
    }
  });

  it("refuses malformed present optional claims instead of silently deriving registry values", () => {
    for (const overrides of [{ toolName: 42 }, { schemaDigest: false }]) {
      const refused = parseRaw(JSON.stringify(provisionedClaims(overrides)));
      expect(refused.kind).toBe("provisioning-refused");
      if (refused.kind === "provisioning-refused") {
        expect(refused.code).toBe("invalid-claim-type");
        expect(refused.reason).toContain("present optional claims must be strings");
      }
    }
  });

  it("refuses every claim that does not select a frozen registry cell, carrying the mint's own code and message", () => {
    for (const [label, overrides, expectedCode] of [
      ["unknown kind", { kind: "no-such-kind" }, "unknown-producer-kind"],
      ["unsupported version", { version: "v9" }, "unsupported-schema-version"],
      ["wrong claimed digest", { schemaDigest: sha256Hex("stale-bytes") }, "schema-digest-mismatch"],
      ["wrong claimed tool name", { toolName: "loom_emit_refutation_verdict" }, "tool-name-mismatch"],
      ["empty request id", { requestId: "" }, "invalid-request-identity"],
    ] as const) {
      const refused = parseRaw(JSON.stringify(provisionedClaims(overrides)));
      expect(refused.kind, label).toBe("provisioning-refused");
      if (refused.kind === "provisioning-refused") {
        expect(refused.code, label).toBe(expectedCode);
        expect(refused.reason.length, label).toBeGreaterThan(0);
      }
    }
  });

  it("certifies valid claims into the minted binding and a canonical context digest", () => {
    const provisioned = parseRaw(JSON.stringify(provisionedClaims()));
    if (provisioned.kind !== "provisioned") throw new Error(`expected a provisioned child, received ${provisioned.kind}`);
    const expected = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-prov");
    expect(provisioned.binding).toEqual(expected);
    expect(provisioned.contextDigest).toBe(sha256Hex(`emission-startup-context:${expected.requestId}`));
  });

  it("derives absent claims from the ONE frozen source — never a second default (AD-7)", () => {
    const claims = provisionedClaims();
    const minimal = JSON.stringify({ requestId: claims.requestId, contextDigest: claims.contextDigest, kind: claims.kind, version: claims.version });
    const provisioned = parseRaw(minimal);
    if (provisioned.kind !== "provisioned") throw new Error(`expected a provisioned child, received ${provisioned.kind}`);
    const expected = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-prov");
    expect(provisioned.binding.toolName).toBe(expected.toolName);
    expect(provisioned.binding.schemaDigest).toBe(expected.schemaDigest);
  });
});

describe("the readiness protocol contract — command, entry type, hold marker, and the bound report the barrier parses (AD-4)", () => {
  it("carries the settled protocol names the wave-2 barrier suite and the probe pin", () => {
    expect(EMISSION_READINESS_COMMAND).toBe("loom-emission-readiness");
    expect(EMISSION_READINESS_ENTRY_TYPE).toBe("loom-emission-readiness");
    expect(EMISSION_HOLD_ENTRY_TYPE).toBe("loom-emission-hold");
    expect(LOOM_EMISSION_BINDING_ENV).toBe("LOOM_EMISSION_BINDING");
  });

  it("the readiness report carries exactly the ten contract fields, minted binding plus the child's honest observations", () => {
    const binding = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-report");
    const provisioned = parseEmissionChildProvisioning(JSON.stringify({
      requestId: binding.requestId,
      contextDigest: sha256Hex(`emission-startup-context:${binding.requestId}`),
      kind: binding.kind.kind,
      version: binding.version,
      toolName: binding.toolName,
      schemaDigest: binding.schemaDigest,
    }));
    if (provisioned.kind !== "provisioned") throw new Error(`expected a provisioned child, received ${provisioned.kind}`);
    const report = emissionReadinessReport(provisioned, {
      revision: "sha256:loom-emission-rev-t5",
      active: true,
      childPid: 4242,
      registeredTools: [binding.toolName, "read"],
    });
    expect(Object.keys(report).sort()).toEqual([
      "active", "childPid", "contextDigest", "kind", "registeredTools",
      "requestId", "revision", "schemaDigest", "toolName", "version",
    ]);
    expect(report.requestId).toBe(binding.requestId);
    expect(report.contextDigest).toBe(sha256Hex(`emission-startup-context:${binding.requestId}`));
    expect(report.kind).toBe("judge-verdict");
    expect(report.version).toBe("v1");
    expect(report.toolName).toBe("loom_emit_judge_verdict");
    expect(report.schemaDigest).toBe(sha256Hex(JUDGE_V1_CELL.spec.schemaVersions.v1!.schemaBytes));
    expect(report.revision).toBe("sha256:loom-emission-rev-t5");
    expect(report.active).toBe(true);
    expect(report.childPid).toBe(4242);
    expect(report.registeredTools).toEqual([binding.toolName, "read"]);
  });
});

describe("emissionToolFamily — the registry-projected family of a tool name (FR-014)", () => {
  it("maps every frozen registry tool name to its producer kind", () => {
    expect(emissionToolFamily("loom_emit_reviewer_payload")).toEqual({ kind: "registered", producerKind: "reviewer-payload" });
    expect(emissionToolFamily("loom_emit_judge_verdict")).toEqual({ kind: "registered", producerKind: "judge-verdict" });
    expect(emissionToolFamily("loom_emit_refutation_verdict")).toEqual({ kind: "registered", producerKind: "refutation-verdict" });
  });

  it("prefix-reserved names outside the registry are observed-but-unbindable, never unrelated", () => {
    expect(emissionToolFamily("loom_emit_gibberish")).toEqual({ kind: "unregistered-emission-name" });
  });

  it("everything else is unrelated — including non-string names", () => {
    expect(emissionToolFamily("bash")).toEqual({ kind: "unrelated" });
    expect(emissionToolFamily("loom")).toEqual({ kind: "unrelated" });
    expect(emissionToolFamily(undefined)).toEqual({ kind: "unrelated" });
    expect(emissionToolFamily(42)).toEqual({ kind: "unrelated" });
  });
});

// ---------------------------------------------------------------------------
// T5: complete, request-bound transcript observations (pi/transcript-adapter.ts)
// ---------------------------------------------------------------------------

const assistantWithCalls = (calls: readonly { id: string; name: string; arguments?: unknown }[], text = ""): unknown => ({
  role: "assistant",
  content: [
    ...(text.length > 0 ? [{ type: "text", text }] : []),
    ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
  ],
});

const framesOf = (messages: unknown, issued: IssuedEmissionBinding): readonly EmissionCallFrame[] => {
  const scanned = piEmissionCallFrames(messages, issued);
  if (!scanned.ok) throw new Error(`fixture transcript refused: ${scanned.errors.join("; ")}`);
  return scanned.value;
};

const asCompleteCalls = (frames: readonly EmissionCallFrame[]): readonly Extract<EmissionCallFrame, { kind: "complete" }>["call"][] =>
  frames.filter((frame): frame is Extract<EmissionCallFrame, { kind: "complete" }> => frame.kind === "complete")
    .map((frame) => frame.call);

describe("piEmissionCallFrames — complete, request-bound emission observations (FR-014/AD-8)", () => {
  const issued = mintedReviewerBinding();
  const reviewerTool = REVIEWER_V2_CELL.spec.toolName;
  const judgeTool = JUDGE_V1_CELL.spec.toolName;

  it("a transcript with no emission calls observes absence", () => {
    const messages = [
      userLike(),
      assistantWithCalls([{ id: "call-bash", name: "bash", arguments: { command: "bun test" } }], "working"),
      toolResultLike("call-bash", "bash"),
      assistantWithCalls([], "done in prose"),
    ];
    expect(framesOf(messages, issued)).toEqual([]);
    expect(observeEmissionCalls(framesOf(messages, issued))).toEqual({ kind: "absent" });
  });

  it("one emission call observes one complete frame, bound to the issued request, kind from the registry, arguments as observed", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const messages = [
      userLike(),
      assistantWithCalls([{ id: "call-emit-1", name: reviewerTool, arguments: args }]),
      toolResultLike("call-emit-1", reviewerTool),
    ];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    const [frame] = asCompleteCalls(frames);
    expect(frame!.toolCallId).toBe("call-emit-1");
    expect(frame!.requestId).toBe(issued.requestId);
    expect(frame!.kind).toEqual({ kind: "reviewer-payload" });
    expect(frame!.version).toBe(issued.version);
    expect(frame!.arguments).toEqual(args);
    // The fold classifies the frames the production adapter produced: one
    // complete call, and the engine re-admits the observed arguments.
    const observation = observeEmissionCalls(frames);
    expect(observation.kind).toBe("single-call");
    if (observation.kind === "single-call") {
      expect(admitEmissionArguments(REVIEWER_V2_CELL.spec, REVIEWER_V2_CELL.version, observation.call.arguments).kind).toBe("valid");
    }
  });

  it("a well-formed payload pasted as final assistant text with zero emission calls extracts through the existing parser — the adapter observes assistant tool calls, never pasted text (AD-8)", () => {
    const messages = [
      userLike(),
      assistantWithCalls([], JSON.stringify(REVIEWER_PAYLOAD_EXAMPLE_V2, null, 2)),
    ];
    // Pasted JSON in text is a FinalPayloadCandidate, never an emission frame:
    // the observation is absence even though the text IS a schema-valid payload.
    expect(framesOf(messages, issued)).toEqual([]);
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("candidates");
    if (capture.kind === "candidates") {
      expect(capture.candidates).toHaveLength(1);
      // The extraction candidate keeps its text origin — the existing parser's
      // provenance, not an emission-tool one.
      expect(capture.candidates[0]!.origin).toBe("content[0].text");
      expect(JSON.parse(capture.candidates[0]!.text)).toEqual(REVIEWER_PAYLOAD_EXAMPLE_V2);
    }
  });

  it("a successfully executed tool-only reviewer result reaches the production capture observation without assistant prose", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const messages = [
      assistantWithCalls([{ id: "call-tool-only", name: reviewerTool, arguments: args }]),
      toolResultLike("call-tool-only", reviewerTool),
    ];
    const observation = piReviewerCaptureObservation(messages, issued);
    expect(observation.kind).toBe("candidates");
    if (observation.kind === "candidates") {
      expect(observation.candidates).toHaveLength(1);
      expect(observation.candidates[0]!.origin).toBe("emission-tool-arguments");
      expect(JSON.parse(observation.candidates[0]!.text)).toEqual(args);
    }
  });

  it("a missing or failed finalized tool result makes valid-looking arguments unusable", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    for (const [label, messages] of [
      ["missing", [assistantWithCalls([{ id: "call-unexecuted", name: reviewerTool, arguments: args }])]],
      ["failed", [
        assistantWithCalls([{ id: "call-refused", name: reviewerTool, arguments: args }]),
        toolResultLike("call-refused", reviewerTool, true),
      ]],
    ] as const) {
      const frames = framesOf(messages, issued);
      expect(frames, label).toHaveLength(1);
      expect(frames[0], label).toMatchObject({ kind: "incomplete" });
      expect(observeEmissionCalls(frames).kind, label).toBe("unusable");
      const capture = piReviewerCaptureObservation(messages, issued);
      expect(capture.kind, label).toBe("terminal-refusal");
      if (capture.kind === "terminal-refusal") expect(capture.reason, label).toBe("unusable-observation");
    }
  });

  it("refuses duplicate finalized toolResult entries with one toolCallId instead of treating either as authoritative", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const messages = [
      assistantWithCalls([{ id: "call-duplicate-result", name: reviewerTool, arguments: args }]),
      toolResultLike("call-duplicate-result", reviewerTool),
      toolResultLike("call-duplicate-result", reviewerTool),
    ];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "incomplete",
      toolCallId: "call-duplicate-result",
      reason: expect.stringContaining("2 finalized tool results; exactly one is required"),
    });
    expect(observeEmissionCalls(frames).kind).toBe("unusable");
    expect(piReviewerCaptureObservation(messages, issued)).toMatchObject({
      kind: "terminal-refusal",
      reason: "unusable-observation",
    });
  });

  it("observes mismatched toolResult names and non-false isError for the emission call id as incomplete", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    for (const [label, toolName, isError, reason] of [
      ["wrong tool name", "bash", false, "mismatched tool result"],
      ["missing success flag", reviewerTool, undefined, "non-success isError"],
      ["non-boolean success flag", reviewerTool, "false", "non-success isError"],
    ] as const) {
      const messages = [
        assistantWithCalls([{ id: "call-mismatched-result", name: reviewerTool, arguments: args }]),
        { role: "toolResult", toolCallId: "call-mismatched-result", toolName, isError,
          content: [{ type: "text", text: "payload acknowledged" }] },
      ];
      const frames = framesOf(messages, issued);
      expect(frames, label).toHaveLength(1);
      expect(frames[0], label).toMatchObject({
        kind: "incomplete",
        toolCallId: "call-mismatched-result",
        reason: expect.stringContaining(reason),
      });
      expect(observeEmissionCalls(frames).kind, label).toBe("unusable");
      expect(piReviewerCaptureObservation(messages, issued).kind, label).toBe("terminal-refusal");
    }
  });

  it("an aborted turn finalizes every emission call in it as incomplete BEFORE argument shape — finalization is the causal reason (AD-8)", () => {
    // The cancellation path a live launcher produces: the transport finalizes
    // the turn as aborted while a partial toolCall block carries arguments the
    // wire never completed. The frame's reason is the FINALIZATION, not the
    // argument form — the call died with its turn regardless of how its
    // arguments look, and the diagnostic must say which.
    const registryCell = REGISTRY_CELLS[2]!; // judge-verdict v1
    const messages = [
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{
          type: "toolCall",
          id: "call-aborted-malformed",
          name: registryCell.spec.toolName,
          arguments: "not-an-object",
        }],
      },
    ];
    const frames = framesOf(messages, mintedBindingFor(registryCell, "req-emission-frames-aborted-malformed"));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "incomplete",
      toolCallId: "call-aborted-malformed",
      reason: expect.stringContaining("belongs to an assistant turn finalized as aborted"),
    });
    expect(observeEmissionCalls(frames).kind).toBe("unusable");
  });

  it("a failed singleton typed-block emission refuses the exact final-message fallback reproduction", () => {
    const messages = [
      {
        role: "assistant",
        content: {
          type: "toolCall",
          id: "call-1",
          name: reviewerTool,
          arguments: { schemaVersion: 2, kind: "standalone-review", findings: "bad" },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: reviewerTool,
        isError: true,
        content: [{ type: "text", text: "schema rejected" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: '{"schemaVersion":2,"kind":"standalone-review","findings":[]}' }],
      },
    ];

    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "incomplete",
      toolCallId: "call-1",
      reason: expect.stringContaining("failed"),
    });
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("terminal-refusal");
    if (capture.kind === "terminal-refusal") expect(capture.reason).toBe("unusable-observation");
  });

  it("normalizes array and singleton typed-block emissions to the same unusable observation (property)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{1,12}$/),
        fc.integer({ min: 0, max: 1_000 }),
        (suffix, sentinel) => {
          const id = `call-${suffix}`;
          const block = {
            type: "toolCall",
            id,
            name: reviewerTool,
            arguments: { schemaVersion: 2, kind: "standalone-review", findings: sentinel },
          };
          for (const content of [block, [block]]) {
            const frames = framesOf([
              { role: "assistant", content },
              toolResultLike(id, reviewerTool, true),
            ], issued);
            expect(frames).toHaveLength(1);
            expect(frames[0]).toMatchObject({ kind: "incomplete", toolCallId: id });
            expect(observeEmissionCalls(frames).kind).toBe("unusable");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("refuses accessor-backed native content without invoking it", () => {
    let accessorReads = 0;
    const assistant = Object.defineProperty({ role: "assistant" }, "content", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { type: "toolCall", id: "call-accessor", name: reviewerTool, arguments: {} };
      },
    });

    const scanned = piEmissionCallFrames([assistant], issued);
    expect(scanned.ok).toBe(false);
    expect(accessorReads).toBe(0);
    const capture = piReviewerCaptureObservation([assistant], issued);
    expect(capture.kind).toBe("terminal-refusal");
    expect(accessorReads).toBe(0);
  });

  it("does not collapse an arbitrary singleton object into a valid tool call or fallback", () => {
    const messages = [
      { role: "assistant", content: { id: "call-not-typed", name: reviewerTool, arguments: {} } },
      { role: "assistant", content: [{ type: "text", text: '{"schemaVersion":2,"kind":"standalone-review","findings":[]}' }] },
    ];
    expect(framesOf(messages, issued)).toEqual([]);
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("terminal-refusal");
    if (capture.kind === "terminal-refusal") {
      // The selection arm's own typed refusal is RETAINED, then composed with
      // the independent transcript scan's refusal — neither erases the other.
      expect(capture.reason).toBe("no-final-payload");
      expect(capture.message).toContain("result carried no final text payload;");
      expect(capture.message).toContain("the independent transcript scan also refused:");
      expect(capture.message.length).toBeGreaterThan("result carried no final text payload; the independent transcript scan also refused:".length);
    }
  });

  it("retains unknown argument keys in complete frames as unprojected enumerable snapshots", () => {
    const args = {
      ...(canonicalArguments("reviewer-payload", "v2") as Record<string, unknown>),
      adapterSentinel: { retained: true },
    };
    const [call] = asCompleteCalls(framesOf([
      assistantWithCalls([{ id: "call-raw", name: reviewerTool, arguments: args }]),
      toolResultLike("call-raw", reviewerTool),
    ], issued));
    expect(call!.arguments).toEqual(args);
    expect(call!.arguments).toHaveProperty("adapterSentinel", { retained: true });
  });

  it("a malformed unrelated entry does not hide a valid emission call from the independent scan", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const frames = framesOf([
      { role: "assistant", content: 42 },
      assistantWithCalls([{ id: "call-after-corruption", name: reviewerTool, arguments: args }]),
      toolResultLike("call-after-corruption", reviewerTool),
    ], issued);
    expect(asCompleteCalls(frames)).toHaveLength(1);
    expect(asCompleteCalls(frames)[0]!.toolCallId).toBe("call-after-corruption");
  });

  it("the production reviewer capture selects a successful emission after a malformed unrelated entry with no prose", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const observation = piReviewerCaptureObservation([
      { role: "assistant", content: 42 },
      assistantWithCalls([{ id: "call-after-unrelated-malformation", name: reviewerTool, arguments: args }]),
      toolResultLike("call-after-unrelated-malformation", reviewerTool),
    ], issued);

    expect(observation.kind).toBe("candidates");
    if (observation.kind === "candidates") {
      expect(observation.candidates).toHaveLength(1);
      expect(observation.candidates[0]!.origin).toBe("emission-tool-arguments");
      expect(JSON.parse(observation.candidates[0]!.text)).toEqual(args);
    }
  });

  it("a call to a DIFFERENT producer kind's tool is a complete frame carrying the OBSERVED kind — and the selection refuses it as unexpected-kind, never a self-selected decoder (FR-014)", () => {
    const messages = [
      assistantWithCalls([{ id: "call-wrong", name: judgeTool, arguments: { criterion: "extensibility", rankings: [] } }]),
      toolResultLike("call-wrong", judgeTool),
    ];
    const frames = framesOf(messages, issued);
    const [frame] = asCompleteCalls(frames);
    expect(frame!.kind).toEqual({ kind: "judge-verdict" });
    expect(frame!.version).toBe(issued.version);
    const observation = observeEmissionCalls(frames);
    expect(observation.kind).toBe("single-call");
    const selection = selectCanonicalPayload(issued, observation, [] satisfies readonly FinalPayloadCandidate[]);
    expect(selection.kind).toBe("observation-refused");
    if (selection.kind === "observation-refused") {
      expect(selection.refusal.code).toBe("unexpected-kind");
      expect(selection.refusal.message).toContain("judge-verdict");
    }
  });

  it("a prefix-reserved name outside the frozen registry refuses as an incomplete frame — never absorbed as absence (FR-014)", () => {
    const messages = [assistantWithCalls([{ id: "call-stale", name: "loom_emit_gibberish", arguments: { arbitrary: true } }])];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      kind: "incomplete",
      toolCallId: "call-stale",
      reason: expect.stringContaining("loom_emit_gibberish"),
    });
    expect(observeEmissionCalls(frames).kind).toBe("unusable");
  });

  it("an emission call without a recoverable identity, and one with non-object arguments, are incomplete frames with reasons", () => {
    const noIdentity = framesOf([assistantWithCalls([{ id: "", name: reviewerTool, arguments: { schemaVersion: 2 } }])], issued);
    expect(noIdentity).toHaveLength(1);
    expect(noIdentity[0]).toMatchObject({ kind: "incomplete", toolCallId: null });
    const badArguments = framesOf([
      { role: "assistant", content: [{ type: "toolCall", id: "call-bad", name: reviewerTool, arguments: "not-an-object" }] },
      toolResultLike("call-bad", reviewerTool, true),
    ], issued);
    expect(badArguments).toHaveLength(1);
    expect(badArguments[0]).toMatchObject({ kind: "incomplete", toolCallId: "call-bad" });
    for (const frames of [noIdentity, badArguments]) {
      const observation = observeEmissionCalls(frames);
      expect(observation.kind).toBe("unusable");
      if (observation.kind === "unusable") expect(observation.reason.length).toBeGreaterThan(0);
    }
  });

  it("an exact replay of one call identity folds idempotently; a contradictory replay refuses (FR-007)", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const replayed = framesOf([
      assistantWithCalls([{ id: "call-replay", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-replay", name: reviewerTool, arguments: args }]),
      toolResultLike("call-replay", reviewerTool),
    ], issued);
    expect(asCompleteCalls(replayed)).toHaveLength(2);
    expect(observeEmissionCalls(replayed)).toEqual(observeEmissionCalls(framesOf([
      assistantWithCalls([{ id: "call-replay", name: reviewerTool, arguments: args }]),
      toolResultLike("call-replay", reviewerTool),
    ], issued)));
    const contradictory = framesOf([
      assistantWithCalls([{ id: "call-contradicted", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-contradicted", name: reviewerTool, arguments: { schemaVersion: 2, kind: "standalone-review", findings: [] } }]),
      toolResultLike("call-contradicted", reviewerTool),
    ], issued);
    const observation = observeEmissionCalls(contradictory);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") expect(observation.reason).toContain("contradictory");
  });

  it("two distinct calls and an incomplete-beside-complete pair refuse exactly as the fold classifies them", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const doubled = observeEmissionCalls(framesOf([
      assistantWithCalls([{ id: "call-a", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-b", name: reviewerTool, arguments: args }]),
      toolResultLike("call-a", reviewerTool),
      toolResultLike("call-b", reviewerTool),
    ], issued));
    expect(doubled.kind).toBe("multiple-calls");

    const mixed = observeEmissionCalls(framesOf([
      assistantWithCalls([{ id: "call-good", name: reviewerTool, arguments: args }]),
      { role: "assistant", content: [{ type: "toolCall", id: "call-broken", name: reviewerTool, arguments: "nope" }] },
      toolResultLike("call-good", reviewerTool),
      toolResultLike("call-broken", reviewerTool, true),
    ], issued));
    expect(mixed.kind).toBe("unusable");
  });

  it("two distinct calls through the real adapter reach the duplicate arm carrying BOTH observed calls (FR-007)", () => {
    // The real transcript scan folds two distinct successfully executed calls
    // into multiple-calls, and the production selection's duplicate arm
    // carries the ambiguity's content — the observed calls in first-observed
    // order — so the terminal diagnostic names what was observed instead of a
    // bare count.
    const args = canonicalArguments("reviewer-payload", "v2");
    const messages = [
      assistantWithCalls([{ id: "call-a", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-b", name: reviewerTool, arguments: args }]),
      toolResultLike("call-a", reviewerTool),
      toolResultLike("call-b", reviewerTool),
    ];
    const observation = observeEmissionCalls(framesOf(messages, issued));
    expect(observation.kind).toBe("multiple-calls");
    const selection = selectCanonicalPayload(issued, observation, [] satisfies readonly FinalPayloadCandidate[]);
    expect(selection.kind).toBe("duplicate-emission-call");
    if (selection.kind === "duplicate-emission-call") {
      expect(selection.calls.map(({ toolCallId }) => toolCallId)).toEqual(["call-a", "call-b"]);
      expect(selection.calls.every((call) => call.requestId === issued.requestId)).toBe(true);
    }
    // The production capture terminalises the same ambiguity: the shared
    // decision's arm, translated at the adapter, is a terminal refusal — never
    // a silent pick of one of the two calls.
    expect(piReviewerCaptureObservation(messages, issued)).toMatchObject({
      kind: "terminal-refusal",
      reason: "ambiguous-emission-call",
    });
  });

  it("the production reviewer capture refuses contradictory duplicate frames with the fold's retained diagnostic (FR-007/AD-9)", () => {
    // Two finalized frames share one tool-call identity but disagree on the
    // arguments: the fold refuses the observation as unusable (naming the
    // differing contract field), and the production capture translation
    // carries that retained diagnostic — never a count, never absence, never
    // a silent pick of either frame.
    const args = canonicalArguments("reviewer-payload", "v2");
    const messages = [
      assistantWithCalls([{ id: "call-contradicted", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{
        id: "call-contradicted",
        name: reviewerTool,
        arguments: { schemaVersion: 2, kind: "standalone-review", findings: [] },
      }]),
      toolResultLike("call-contradicted", reviewerTool),
    ];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(2);
    const observation = observeEmissionCalls(frames);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") {
      expect(observation.reason).toContain("contradictory duplicate transport frames for emission tool call call-contradicted");
      expect(observation.reason).toContain("(differing: arguments)");
    }
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("terminal-refusal");
    if (capture.kind === "terminal-refusal") {
      expect(capture.reason).toBe("unusable-observation");
      expect(capture.message).toContain("differing: arguments");
    }
  });

  it("observes only ASSISTANT tool calls — user-carried and result-carried tool-call shapes are not emission observations (AD-8)", () => {
    const args = canonicalArguments("reviewer-payload", "v2");
    const messages = [
      { role: "user", content: [{ type: "toolCall", id: "call-user", name: reviewerTool, arguments: args }] },
      { role: "toolResult", toolCallId: "call-user", toolName: reviewerTool, content: [{ type: "text", text: JSON.stringify(args) }] },
    ];
    expect(framesOf(messages, issued)).toEqual([]);
  });

  it("refuses a non-array transcript — the scan fails closed, it never invents absence", () => {
    const scanned = piEmissionCallFrames({ role: "assistant" }, issued);
    expect(scanned.ok).toBe(false);
  });

  it("is deterministic over arbitrary transcripts and attributes every complete frame to the issued request (property)", () => {
    const nameArb = fc.constantFrom(JUDGE_V1_CELL.spec.toolName, "loom_emit_future_tool", "bash", "read");
    const idArb = fc.oneof(fc.stringMatching(/^call-[a-z0-9]{1,8}$/), fc.constant(""));
    const blockArb = fc.oneof(
      fc.record({ type: fc.constant("toolCall"), id: idArb, name: nameArb, arguments: fc.record({ n: fc.integer({ min: 0, max: 9 }) }) }),
      fc.record({ type: fc.constant("text"), text: fc.string({ maxLength: 8 }) }),
    );
    const messageArb = fc.record({
      role: fc.constantFrom("assistant", "user", "toolResult"),
      content: fc.array(blockArb, { maxLength: 4 }),
    });
    const judgeIssued = mintedJudgeBinding();
    fc.assert(
      fc.property(fc.array(messageArb, { maxLength: 5 }), (messages) => {
        const first = piEmissionCallFrames(messages, judgeIssued);
        const second = piEmissionCallFrames(messages, judgeIssued);
        expect(canonicalStructuralEquals(first, second)).toBe(true);
        if (first.ok) {
          for (const frame of first.value) {
            if (frame.kind === "complete") {
              expect(frame.call.requestId).toBe(judgeIssued.requestId);
              expect(frame.call.toolCallId.length).toBeGreaterThan(0);
              expect(frame.call.kind.kind).toBe("judge-verdict");
              expect(frame.call.version).toBe(judgeIssued.version);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

function userLike(): unknown {
  return { role: "user", content: [{ type: "text", text: "Emit the issued payload exactly once." }] };
}

function toolResultLike(id: string, name: string, isError = false): unknown {
  return { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: "payload acknowledged" }] };
}
