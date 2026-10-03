/**
 * The real reviewer v2 request-to-ingestion vertical slice (T7; FR-032's
 * runtime half, AD-8/AD-9/AD-10, AS-022): ONE issued reviewer request travels
 * the whole production path —
 *
 *   authenticated issuance (the frozen registry, certified against the
 *     registered wave-gate v2 protocol)
 *   → the REAL Pi child loop running the PRODUCTION emission tool definition
 *     (`pi/emission-tool.ts`'s `emissionToolDefinition`, terminating execute)
 *   → the REAL request-bound transcript observations (`pi/transcript-adapter`'s
 *     `piEmissionCallFrames` scan and `piResultFinalPayloadCandidates` fallback
 *     projection over the loop's actual messages)
 *   → the engine capture seam's ONE canonical selection
 *     (`captureHarnessResult`'s emission arm, against the ISSUED authority the
 *     run directory itself certifies)
 *   → the existing issued admission (bind/context/receipt) and the bounded
 *     accepted-source record published BEFORE acceptance is declared.
 *
 * Nothing here is a test twin of production: the child runs the real
 * registration surface (with the suite's observation record wrapping the
 * PRODUCTION execute, exactly as emission-tool.test.ts does), the transcript
 * is scanned by the production adapters, and the capture crosses the same
 * runtime the Pi and Claude adapters call. The model transport is scripted
 * (the same counting posture as emission-tool.test.ts), so "real" means the
 * real harness surfaces and real run directory, never a real provider dial.
 *
 * The discriminating controls (AD-10/AS-022) run against the SAME production
 * path: a bypassed selection (candidates-only arm) fails the tool-only
 * acceptance; an always-accept seam would ingest what the binding check
 * refuses; an always-reject posture terminalises what production accepts.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type StreamFn } from "@earendil-works/pi-agent-core";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
} from "../../src/core/emission-tool";
import {
  issuedReviewerPayloadClaim,
} from "../../src/core/spawn-admission";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_PAYLOAD_SCHEMA_V2, reviewerPayloadV2Schema, CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import { sha256Hex } from "../../src/core/review-packet";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { buildContextPacket, encodeByteSection } from "../../src/orchestration/context-packets";
import { createRunDirectory, openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { captureEmissionObservation, captureHarnessResult } from "../../src/orchestration/harness-capture-runtime";
import { emissionToolDefinition } from "../../../pi/emission-tool";
import { piEmissionCallFrames, piResultFinalPayloadCandidates } from "../../../pi/transcript-adapter";
import type { EmissionCallFrame } from "../../src/core/harness-capture";
import type { IssuedEmissionBinding } from "../../src/core/emission-tool";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The issued request and its durable wave-gate v2 authority
// ---------------------------------------------------------------------------

const V2_SPEC = EMISSION_TOOL_SPECS["reviewer-payload"];
const V2_DIGEST = sha256Hex(V2_SPEC.schemaVersions["v2"]!.schemaBytes);

interface StagedRun {
  readonly runsRoot: string;
  readonly directory: string;
  readonly nativeId: string;
  readonly request: AgentRequestAuthority;
  readonly handle: RunDirHandle;
  /** The child's binding, minted from the ISSUED claim the registration
   *  carries — the same identity the capture runtime independently
   *  certifies from the same durable authority. */
  readonly issued: IssuedEmissionBinding;
}

async function stagedReviewerRequest(nativeId: string): Promise<StagedRun> {
  const runsRoot = canonicalTempDir("loom-emission-vertical-");
  cleanup.push(runsRoot);
  const directory = join(runsRoot, "run.emission-vertical");
  const created = createRunDirectory(runsRoot, "run.emission-vertical");
  if (!created.ok) throw new Error(created.error.message);
  const registered = {
    schemaVersion: 2 as const,
    kind: "wave-gate" as const,
    input: { wave: 1 },
    taskIds: ["T1"],
    authorityDigest: "c".repeat(64),
    reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  };
  const program = await created.value.registerProgram(registered);
  if (!program.ok) throw new Error(program.error.message);
  const base = {
    runId: "run.emission-vertical" as AgentRequestAuthority["runId"],
    requestId: "request:reviewer:1" as AgentRequestAuthority["requestId"],
    slotId: "slot-1",
    program: "wave-gate" as const,
    role: "code-reviewer" as const,
    attempt: 1 as const,
    modelProfile: "qualified-local-review" as const,
    harnessBinding: {
      pi: { harness: "pi" as const, provider: "desktop-vllm" as const,
        model: "glm-5.3-flash-spark-tp2-v14" as const, thinking: "high" as const },
      claude: { harness: "claude-code" as const, model: "sonnet" as const },
    },
    requiredSkill: null,
    contextDigest: "a".repeat(64),
    outputSlot: { kind: "fixed-artifact-slot" as const, path: "transcripts/slot-1/attempt-1.raw" },
  } as unknown as AgentRequestAuthority;
  const section = encodeByteSection("test", "emission vertical slice context");
  if (!section.ok) throw new Error(section.error.message);
  const packet = buildContextPacket({
    requestId: base.requestId,
    role: base.role,
    requiredSkill: "none",
    outputContract: "test output",
    fixedContext: [section.value],
    variableContext: [],
  });
  if (!packet.ok) throw new Error(packet.error.message);
  if (!(await created.value.publishContext(packet.value)).ok) throw new Error("context publication failed");
  const request = { ...base, contextDigest: packet.value.digest } as AgentRequestAuthority;
  const reserved = await created.value.reserveRequest(request);
  if (!reserved.ok) throw new Error(reserved.error.message);
  const correlated = await created.value.recordHarnessCorrelator({
    schemaVersion: 1,
    harness: "pi",
    nativeId,
    requestId: request.requestId,
    role: request.role,
    attempt: request.attempt,
  });
  if (!correlated.ok) throw new Error(correlated.error.message);
  // The child's binding is minted from the ISSUED producer claim —
  // `issuedReviewerPayloadClaim` over the registration's own protocol
  // projection — never from defaults or task text.
  const claim = issuedReviewerPayloadClaim(
    { schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL },
    request,
  );
  const issued = issueEmissionBinding({
    requestId: claim.requestId,
    kind: claim.producerKind,
    version: claim.version,
    schemaDigest: claim.schemaDigest,
  });
  if (!issued.ok) throw new Error(`${issued.error.code}: ${issued.error.message}`);
  const reopened = openRunDirectory(runsRoot, directory);
  if (!reopened.ok) throw new Error(reopened.error.message);
  return { runsRoot, directory, nativeId, request, handle: reopened.value, issued: issued.value };
}

// ---------------------------------------------------------------------------
// The real Pi child loop with the PRODUCTION emission tool (scripted transport)
// ---------------------------------------------------------------------------

const scriptedModel: Model<"openai-completions"> = {
  id: "scripted-vertical-model",
  name: "scripted-vertical-model",
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
  readonly streamFn: StreamFn;
  readonly callCount: () => number;
}

const scriptTurns = (responses: readonly AssistantMessage[]): ScriptedTurn => {
  let call = 0;
  const streamFn: StreamFn = (_model, _context, options) => {
    const message: AssistantMessage | undefined = options?.signal?.aborted ? undefined : responses[call];
    if (message === undefined) {
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
  return { streamFn, callCount: () => call };
};

const asAgentContext = (tools: readonly Record<string, unknown>[]): AgentContext =>
  ({ systemPrompt: "loom reviewer agent", messages: [], tools }) as unknown as AgentContext;

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

/** The PRODUCTION emission tool definition over the issued binding, with the
 *  suite's observation record wrapping the PRODUCTION execute — the exact
 *  registration surface the extension registers, never a test twin. */
const productionEmissionTool = (issued: IssuedEmissionBinding, observed: unknown[]): Record<string, unknown> => {
  const definition = emissionToolDefinition(issued);
  return {
    ...definition,
    execute: async (toolCallId: string, params: unknown) => {
      observed.push(params);
      return definition.execute(toolCallId, params);
    },
  } as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Canonical fixtures
// ---------------------------------------------------------------------------

const reviewerV2Arguments = (): unknown => reviewerPayloadV2Schema.parse({
  schemaVersion: 2,
  kind: "standalone-review",
  findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "the vertical slice carried the frozen schema" }],
});

const whitespaceV2Arguments = (): unknown => {
  const finding = reviewerPayloadV2Schema.parse({
    schemaVersion: 2,
    kind: "standalone-review",
    findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }],
  }).findings[0]!;
  return { schemaVersion: 2, kind: "standalone-review", findings: [{ ...finding, claim: "   " }] };
};

/** The production transcript projection over a settled child transcript: the
 *  REAL `piEmissionCallFrames` scan (request-bound, successful-execution-only)
 *  beside the REAL `piResultFinalPayloadCandidates` fallback projection. */
function productionObservation(messages: readonly unknown[], issued: IssuedEmissionBinding): {
  readonly frames: readonly EmissionCallFrame[];
  readonly candidates: readonly { readonly origin: string; readonly text: string }[];
} {
  const scanned = piEmissionCallFrames(messages, issued);
  if (!scanned.ok) throw new Error(scanned.errors.join("; "));
  const candidates = piResultFinalPayloadCandidates(messages);
  return {
    frames: scanned.value,
    candidates: candidates.ok ? candidates.value : [],
  };
}

const captureThroughSeam = (
  staged: StagedRun,
  observation: { readonly frames: readonly EmissionCallFrame[]; readonly candidates: readonly { readonly origin: string; readonly text: string }[] },
) =>
  captureHarnessResult({
    harness: "pi",
    runsRoot: staged.runsRoot,
    runDirectory: staged.directory,
    nativeId: staged.nativeId,
    observe: () => captureEmissionObservation(observation.frames, observation.candidates),
  });

const sourceRecord = (staged: StagedRun): Record<string, unknown> | null => {
  const read = staged.handle.readArtifactBytes(`capture-sources/${staged.request.requestId}.json`, 16_384);
  if (!read.ok) throw new Error(read.error.message);
  return read.value === null ? null : JSON.parse(Buffer.from(read.value).toString("utf-8")) as Record<string, unknown>;
};

const capturedBytes = (staged: StagedRun): string =>
  readFileSync(join(staged.directory, "transcripts", staged.request.slotId, `attempt-${staged.request.attempt}.raw`), "utf-8");

// ---------------------------------------------------------------------------
// The vertical slice
// ---------------------------------------------------------------------------

describe("the real reviewer v2 request-to-ingestion vertical slice", () => {
  it("carries a successful tool-only completion from the real child loop through selection to published ingestion", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-emission");
    expect(staged.issued.schemaDigest).toBe(V2_DIGEST);
    expect(staged.issued.toolName).toBe(V2_SPEC.toolName);

    // The REAL child: the production emission tool executes the canonical
    // payload and returns the minimal terminating acknowledgment, so the loop
    // settles with NO follow-up model request and NO final text.
    const observed: unknown[] = [];
    const canonical = reviewerV2Arguments();
    const script = scriptTurns([
      assistantToolCallMessage([{ type: "toolCall", id: "call-vertical-1", name: V2_SPEC.toolName, arguments: canonical }]),
    ]);
    const { events, messages } = await runScriptedLoop([productionEmissionTool(staged.issued, observed)], script);
    expect(script.callCount()).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(canonical);
    const endEvents = events.filter((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      event.type === "tool_execution_end");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]!.isError).toBe(false);

    // The REAL production observation over the settled transcript, then the
    // engine capture seam's ONE selection.
    const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;

    // The accepted bytes are the canonical emission payload, encoded ONCE.
    expect(capturedBytes(staged)).toBe(JSON.stringify(canonical, null, 2));
    expect(outcome.receipt.digest).toBe(createHash("sha256").update(capturedBytes(staged)).digest("hex"));
    expect(outcome.receipt.harness).toBe("pi");
    expect(outcome.receipt.requestId).toBe(staged.request.requestId);

    // The accepted source is durable BEFORE acceptance is declared, carrying
    // the accepted call identity, the ISSUED schema digest and the payload
    // identity — never reconstructed from the transcript later.
    expect(sourceRecord(staged)).toMatchObject({
      schemaVersion: 1,
      kind: "capture-source",
      requestId: staged.request.requestId,
      slotId: staged.request.slotId,
      attempt: staged.request.attempt,
      harness: "pi",
      source: "emission-tool",
      toolCallId: "call-vertical-1",
      producerKind: "reviewer-payload",
      emissionSchemaVersion: "v2",
      schemaDigest: staged.issued.schemaDigest,
      payloadDigest: outcome.receipt.digest,
    });
  });

  it("captures the final-message fallback when the model never calls the tool, recording the extraction source", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-fallback");
    const finalPayload = reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "fallback extraction" }],
    });
    const script = scriptTurns([assistantFinalTextMessage(JSON.stringify(finalPayload, null, 2))]);
    const { messages } = await runScriptedLoop([productionEmissionTool(staged.issued, [])], script);

    const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;
    // The extraction baseline is unchanged: exactly the final-message bytes.
    expect(capturedBytes(staged)).toBe(JSON.stringify(finalPayload, null, 2));
    const record = sourceRecord(staged);
    expect(record).toMatchObject({ source: "extraction" });
    expect(record).not.toHaveProperty("toolCallId");
    expect(record).not.toHaveProperty("emissionRefusal");
  });

  it("refuses a semantic duplicate-emission ambiguity through the production scan and selection", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-duplicate");
    // Two DISTINCT successfully executed calls in one settled transcript (the
    // ambiguity the retained duplicate policy forbids), projected through the
    // production transcript scan.
    const args = reviewerV2Arguments();
    const messages: readonly unknown[] = [
      assistantToolCallMessage([{ type: "toolCall", id: "call-a", name: V2_SPEC.toolName, arguments: args }]),
      { role: "toolResult", toolCallId: "call-a", toolName: V2_SPEC.toolName, isError: false,
        content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
      assistantToolCallMessage([{ type: "toolCall", id: "call-b", name: V2_SPEC.toolName, arguments: args }]),
      { role: "toolResult", toolCallId: "call-b", toolName: V2_SPEC.toolName, isError: false,
        content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
      assistantFinalTextMessage(JSON.stringify(reviewerV2Arguments(), null, 2)),
    ];
    const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    expect(outcome.reason).toBe("ambiguous-emission-call");
    expect(outcome.message).toContain("call-a");
    expect(outcome.message).toContain("call-b");
    // Valid final text cannot rescue the ambiguity: nothing landed, and the
    // attempt is durably rejected.
    expect(() => capturedBytes(staged)).toThrow();
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toContain("ambiguous-emission-call");
  });

  it("refuses an emission call bound to the wrong producer kind before schema selection", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-misbound");
    const judgeSpec = EMISSION_TOOL_SPECS["judge-verdict"];
    const messages: readonly unknown[] = [
      assistantToolCallMessage([{ type: "toolCall", id: "call-judge", name: judgeSpec.toolName,
        arguments: { criterion: "extensibility",
          rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the frozen registry" }] } }]),
      { role: "toolResult", toolCallId: "call-judge", toolName: judgeSpec.toolName, isError: false,
        content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
    ];
    const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    expect(outcome.reason).toBe("unexpected-kind");
    expect(outcome.message).toContain("judge-verdict");
  });

  it("refuses an exact replayed capture as duplicate while the published source record stays byte-identical", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-replay");
    const canonical = reviewerV2Arguments();
    const messages: readonly unknown[] = [
      assistantToolCallMessage([{ type: "toolCall", id: "call-replay", name: V2_SPEC.toolName, arguments: canonical }]),
      { role: "toolResult", toolCallId: "call-replay", toolName: V2_SPEC.toolName, isError: false,
        content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
    ];
    const observation = productionObservation(messages, staged.issued);
    const first = await captureThroughSeam(staged, observation);
    expect(first.kind).toBe("captured");
    const published = sourceRecord(staged);
    expect(published).not.toBeNull();

    const replay = await captureThroughSeam(staged, observation);
    expect(replay.kind).toBe("terminal-rejection");
    if (replay.kind !== "terminal-rejection") return;
    expect(replay.reason).toBe("duplicate-capture");
    expect(sourceRecord(staged)).toEqual(published);
  });

  it("reports an unavailable capture seam as retriable infrastructure that preserves the attempt", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-infra");
    mkdirSync(staged.directory, { recursive: true });
    writeFileSync(join(staged.directory, "program.json"), "{corrupt");
    const canonical = reviewerV2Arguments();
    const messages: readonly unknown[] = [
      assistantToolCallMessage([{ type: "toolCall", id: "call-infra", name: V2_SPEC.toolName, arguments: canonical }]),
      { role: "toolResult", toolCallId: "call-infra", toolName: V2_SPEC.toolName, isError: false,
        content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
    ];
    const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
    expect(outcome.kind).toBe("retriable-failure");
    if (outcome.kind !== "retriable-failure") return;
    // Infrastructure, never a consumed attempt: the reservation is unfilled
    // and untombstoned, so environment repair may safely retry it.
    expect(["registration", "emission-authority"]).toContain(outcome.reason);
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toBeNull();
  });

  it("accepts extraction over a single engine-refused complete call with the refusal retained in the source record", async () => {
    const staged = await stagedReviewerRequest("pi-vertical-refusal");
    // A COMPLETE correctly bound call whose arguments the engine refuses, with
    // usable final text: extraction is accepted, no retry is consumed, and the
    // retained single-call refusal is published beside the accepted source
    // (FR-006/AD-9). The real Pi child classifies a THROWN execute refusal as
    // an incomplete observation (its own terminal posture, proven in
    // emission-tool.test.ts); this case exercises the kernel's complete-call
    // row through the same production scan and seam.
    const refusalArgs = whitespaceV2Arguments();
    const finalPayload = reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "settled after the refusal" }],
    });
    const messages: readonly unknown[] = [
      assistantToolCallMessage([{ type: "toolCall", id: "call-refused", name: V2_SPEC.toolName, arguments: refusalArgs }]),
      { role: "toolResult", toolCallId: "call-refused", toolName: V2_SPEC.toolName, isError: false,
        content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
      assistantFinalTextMessage(JSON.stringify(finalPayload, null, 2)),
    ];
    const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;
    expect(capturedBytes(staged)).toBe(JSON.stringify(finalPayload, null, 2));
    const expected = admitEmissionArguments(V2_SPEC, "v2", refusalArgs);
    if (expected.kind !== "refused") throw new Error("fixture must be engine-refused");
    const record = sourceRecord(staged);
    expect(record).toMatchObject({
      source: "extraction",
      emissionRefusal: { code: expected.code, message: expected.message },
    });
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toBeNull();
  });

  describe("the AD-10 controls against the production slice path", () => {
    it("the bypassed-selection control fails the tool-only acceptance through the production candidates arm", async () => {
      const staged = await stagedReviewerRequest("pi-vertical-bypass");
      const canonical = reviewerV2Arguments();
      const messages: readonly unknown[] = [
        assistantToolCallMessage([{ type: "toolCall", id: "call-bypass", name: V2_SPEC.toolName, arguments: canonical }]),
        { role: "toolResult", toolCallId: "call-bypass", toolName: V2_SPEC.toolName, isError: false,
          content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
      ];
      // Selection bypassed: the runtime sees the candidates projection only,
      // and a tool-only transcript has no final payload — the acceptance
      // criterion the selection seam satisfies above fails without it.
      const candidates = piResultFinalPayloadCandidates(messages);
      expect(candidates.ok).toBe(true);
      const bypassed = await captureHarnessResult({
        harness: "pi",
        runsRoot: staged.runsRoot,
        runDirectory: staged.directory,
        nativeId: staged.nativeId,
        candidates: candidates.ok ? candidates.value : [],
      });
      expect(bypassed.kind).toBe("terminal-rejection");
      if (bypassed.kind !== "terminal-rejection") return;
      expect(bypassed.reason).toBe("no-final-payload");
    });

    it("the always-accept control would ingest exactly what the binding check refuses", async () => {
      const staged = await stagedReviewerRequest("pi-vertical-accept-control");
      // An always-accept seam (registry admission without the issued binding
      // check) would ingest these schema-valid arguments. Production refuses
      // the misbound kind before any schema selection.
      const judgeSpec = EMISSION_TOOL_SPECS["judge-verdict"];
      const admitted = admitEmissionArguments(judgeSpec, "v1", {
        criterion: "extensibility",
        rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the frozen registry" }],
      });
      expect(admitted.kind).toBe("valid");
      const messages: readonly unknown[] = [
        assistantToolCallMessage([{ type: "toolCall", id: "call-judge-control", name: judgeSpec.toolName,
          arguments: { criterion: "extensibility",
            rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the frozen registry" }] } }]),
        { role: "toolResult", toolCallId: "call-judge-control", toolName: judgeSpec.toolName, isError: false,
          content: [{ type: "text", text: "payload acknowledged" }], details: {}, timestamp: Date.now() },
      ];
      const outcome = await captureThroughSeam(staged, productionObservation(messages, staged.issued));
      expect(outcome.kind).toBe("terminal-rejection");
      if (outcome.kind !== "terminal-rejection") return;
      expect(outcome.reason).toBe("unexpected-kind");
    });

    it("the always-reject posture terminalises what production accepts", async () => {
      const staged = await stagedReviewerRequest("pi-vertical-reject-control");
      // Always-reject posture: every emission observation is reported unusable.
      // Through the production seam that posture terminalises the attempt with
      // the unusable-observation refusal — detectably different from the valid
      // observation's capture above.
      const alwaysReject = await captureHarnessResult({
        harness: "pi",
        runsRoot: staged.runsRoot,
        runDirectory: staged.directory,
        nativeId: staged.nativeId,
        observe: () => captureEmissionObservation(
          [{ kind: "incomplete", toolCallId: "call-reject-control", reason: "always-reject control: the observation is refused unconditionally" }],
          [],
        ),
      });
      expect(alwaysReject.kind).toBe("terminal-rejection");
      if (alwaysReject.kind !== "terminal-rejection") return;
      expect(alwaysReject.reason).toBe("unusable-observation");
    });
  });

  // Guard the schema identity the slice is defined against: the frozen v2
  // bytes the child registered are the bytes the issuance certified.
  it("binds the whole slice to ONE frozen schema identity", () => {
    expect(CURRENT_REVIEWER_PROTOCOL.schemaDigest).toBe(V2_DIGEST);
    expect(sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2)).toBe(V2_DIGEST);
  });
});
