import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../engine/src/core/reviewer-contract";
import { LOOM_EMISSION_BINDING_ENV } from "../../pi/emission-tool";
import { EMISSION_READINESS_COMMAND, EMISSION_READINESS_ENTRY_TYPE } from "../../pi/emission-readiness-protocol";
import { parseSampleObservation, type AttemptObservation } from "./pilot-observation";
import { contentDigest, type CellKey, type PilotArm } from "./pilot-vocabulary";
import { mintCellBinding, pilotRequestId, type CellBinding } from "./pilot-binding";
import {
  classifyAttemptTranscript,
  importRpcLauncher,
  piArmDispatch,
  type ArmRequest,
  type PiDispatchConfig,
  type ReadinessClient,
  type RpcLauncher,
  type RunRpcAgent,
} from "./pilot-dispatch";

/**
 * The live Pi adapter of the dispatch port (`piArmDispatch`) against plain
 * fakes, so the emission arm's readiness barrier and the launch-class mapping
 * of both arms are pinned without a model:
 *
 * - emission-enabled: a fake `runRpcAgent` that drives the adapter's own
 *   `verifyReadiness` against a fake `ReadinessClient` (command presence, the
 *   bound readiness entry through the loom-owned gate, the route bind and
 *   re-observation) and then streams a scripted transcript;
 * - extraction-only: a fake `pi` executable printing a scripted JSON stream.
 *
 * The adapter's pure half, transcript classification through the engine's own
 * selection kernel, is pinned directly at the end.
 */

const CELL = "judge-verdict/v1" as const;
const STAGED = "sha256:staged";
const PAYLOAD = { criterion: "correctness", rankings: [{ candidate: "a.md", score: 7, fatal_flaw: null, strongest_idea: "reuse the budget" }] };

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function request(arm: PilotArm): ArmRequest {
  const minted = mintCellBinding(CELL, pilotRequestId("w", `${CELL}#c#r1`, arm, 1), "the task prompt");
  if (!minted.ok) throw new Error(minted.error);
  return { cell: CELL, arm, attempt: 1, prompt: "the task prompt", cellBinding: minted.value };
}

const config = (overrides: Partial<PiDispatchConfig> = {}): PiDispatchConfig => ({
  repoRoot: "/repo",
  piCommand: "pi",
  loadLauncher: async () => ({ kind: "unavailable", reason: "no launcher configured" }),
  provider: "desktop-vllm",
  model: "glm",
  thinking: "high",
  tools: ["read", "grep"],
  stagedRevision: STAGED,
  timeoutMs: 5_000,
  readinessTimeoutMs: 1_000,
  ...overrides,
});

/** The child's honest readiness report for a binding. */
const readinessEntry = ({ binding, contextDigest }: CellBinding, overrides: Readonly<Record<string, unknown>> = {}) => ({
  customType: EMISSION_READINESS_ENTRY_TYPE,
  data: {
    requestId: binding.requestId, contextDigest, kind: binding.kind.kind, version: binding.version,
    toolName: binding.toolName, schemaDigest: binding.schemaDigest, revision: STAGED, active: true,
    childPid: 4242, registeredTools: ["read", "grep", binding.toolName], ...overrides,
  },
});

type ClientScript = Readonly<{
  commands?: readonly Readonly<{ name: string; source?: string }>[];
  entries?: (binding: CellBinding) => readonly unknown[];
  boundModel?: Readonly<{ provider?: string; id?: string }> | null;
}>;

function fakeClient(binding: CellBinding, script: ClientScript = {}): ReadinessClient & { routes: string[] } {
  const routes: string[] = [];
  return {
    routes,
    getCommands: async () => script.commands ?? [{ name: EMISSION_READINESS_COMMAND, source: "extension" }],
    invokeReadiness: async () => (script.entries ?? ((bound) => [readinessEntry(bound)]))(binding),
    setModel: async (provider, modelId) => { routes.push(`${provider}/${modelId}`); },
    getState: async () => ({ model: script.boundModel === undefined ? { provider: "desktop-vllm", id: "glm" } : script.boundModel }),
  };
}

type AfterPrompt = "settle" | "exit-after-prompt" | "fail-before-prompt" | "hang";

/** A launcher that holds the task prompt behind the adapter's own readiness verification, like the real barrier. */
function fakeLauncher(client: ReadinessClient, transcript: readonly unknown[], after: AfterPrompt = "settle") {
  const calls: Parameters<RunRpcAgent>[0][] = [];
  const runRpcAgent: RunRpcAgent = async (input) => {
    calls.push(input);
    if (after === "fail-before-prompt") return { ok: false, kind: "spawn", phase: "before-task-prompt", reason: "child never answered", stderr: "" };
    const ready = await input.directive.verifyReadiness(client);
    if (!ready.ok) return { ok: false, kind: "readiness-refused", phase: "before-task-prompt", reason: ready.reason, stderr: "" };
    transcript.forEach(input.onMessage);
    if (after === "hang") {
      await new Promise((resolve) => input.signal?.addEventListener("abort", resolve));
      return { ok: false, kind: "aborted", phase: "task-prompt-sent", reason: "aborted", stderr: "" };
    }
    if (after === "exit-after-prompt") return { ok: false, kind: "exit", phase: "task-prompt-sent", reason: "child exited 1", stderr: "" };
    return { ok: true, stderr: "" };
  };
  const loadLauncher = async (): Promise<RpcLauncher> => ({ kind: "loaded", runRpcAgent });
  return { calls, loadLauncher };
}

const emitted = (toolName: string) => [
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: toolName, arguments: PAYLOAD }] },
  { role: "toolResult", toolCallId: "c1", toolName, isError: false, content: [{ type: "text", text: "accepted" }] },
];

async function emissionAttempt(script: ClientScript = {}, after: AfterPrompt = "settle", overrides: Partial<PiDispatchConfig> = {}) {
  const arm = request("emission-enabled");
  const client = fakeClient(arm.cellBinding, script);
  const launcher = fakeLauncher(client, emitted(arm.cellBinding.binding.toolName), after);
  const result = await piArmDispatch(config({ loadLauncher: launcher.loadLauncher, ...overrides }))(arm);
  return { arm, client, calls: launcher.calls, result, outcome: result.observation.outcome };
}

const expectArmSample = (arm: PilotArm, observation: AttemptObservation): void => {
  const sample = parseSampleObservation({
    pairId: "p", cell: CELL, caseId: "c", arm, dispatchToIngestionMs: 1, attempts: [observation], rawArgumentObservation: "unavailable",
  });
  if (!sample.ok) throw new Error(sample.error.join("; "));
};

describe("piArmDispatch emission-enabled arm (readiness barrier)", () => {
  it("binds the issued route after a verified readiness entry, then accepts the emission", async () => {
    const { arm, client, calls, result, outcome } = await emissionAttempt();
    expect(outcome).toMatchObject({ kind: "accepted", source: "emission-tool", fallbackOverRefusal: false });
    expect(result.acceptedPayload).toEqual(PAYLOAD);
    expect(result.observation.readinessMs).not.toBeNull();
    expect(client.routes).toEqual(["desktop-vllm/glm"]);
    const [call] = calls;
    expect(call?.task).toBe("the task prompt");
    expect(call?.args).toEqual(expect.arrayContaining(["--mode", "rpc", "-ne", "-e", "/repo/pi/extension.ts", "--tools", `read,grep,${arm.cellBinding.binding.toolName}`]));
    expect(JSON.parse(call?.env[LOOM_EMISSION_BINDING_ENV] ?? "null")).toMatchObject({
      requestId: arm.cellBinding.binding.requestId, contextDigest: arm.cellBinding.contextDigest, toolName: arm.cellBinding.binding.toolName,
    });
    expectArmSample("emission-enabled", result.observation);
  });

  it("refuses startup when the child lists no extension readiness command", async () => {
    const { client, outcome, result } = await emissionAttempt({ commands: [{ name: EMISSION_READINESS_COMMAND, source: "prompt" }] });
    expect(outcome).toEqual({ kind: "startup-refused", reason: `Required extension command /${EMISSION_READINESS_COMMAND} is unavailable` });
    expect(client.routes).toEqual([]);
    expect(result.observation.readinessMs).toBeNull();
    expect(result.observation.modelRequests).toBe(0);
  });

  it("refuses startup unless the readiness invocation yields exactly one bound entry", async () => {
    for (const entries of [() => [], (bound: CellBinding) => [readinessEntry(bound), readinessEntry(bound)], () => [{ customType: "other", data: {} }]]) {
      const { outcome } = await emissionAttempt({ entries });
      expect(outcome).toEqual({ kind: "startup-refused", reason: `readiness invocation did not produce exactly one ${EMISSION_READINESS_ENTRY_TYPE} entry` });
    }
  });

  it("refuses startup through the loom-owned gate when the child is bound to another request or revision", async () => {
    const wrongRequest = await emissionAttempt({ entries: (bound) => [readinessEntry(bound, { requestId: "someone-else" })] });
    expect(wrongRequest.outcome).toMatchObject({ kind: "startup-refused", reason: expect.stringContaining("bound to another request") });
    const staleRevision = await emissionAttempt({ entries: (bound) => [readinessEntry(bound, { revision: "sha256:old" })] });
    expect(staleRevision.outcome).toMatchObject({ kind: "startup-refused", reason: expect.stringContaining("revision sha256:old") });
    expect(staleRevision.client.routes).toEqual([]);
  });

  it("refuses startup when the re-observed route is not the preregistered one", async () => {
    const { client, outcome } = await emissionAttempt({ boundModel: { provider: "desktop-vllm", id: "other-model" } });
    expect(client.routes).toEqual(["desktop-vllm/glm"]);
    expect(outcome).toEqual({ kind: "startup-refused", reason: "the child route desktop-vllm/other-model does not match desktop-vllm/glm" });
  });

  it("maps launcher failures by phase: before the prompt is startup, after it is infrastructure", async () => {
    expect((await emissionAttempt({}, "fail-before-prompt")).outcome).toEqual({ kind: "startup-refused", reason: "child never answered" });
    expect((await emissionAttempt({}, "exit-after-prompt")).outcome).toEqual({ kind: "infrastructure-failure", reason: "child exited 1" });
  });

  it("maps an attempt that outlives its timeout to timeout, not to a launcher failure", async () => {
    const { outcome, result } = await emissionAttempt({}, "hang", { timeoutMs: 50 });
    expect(outcome).toEqual({ kind: "timeout", afterMs: 50 });
    expect(result.observation.readinessMs).not.toBeNull();
  });

  it("is an infrastructure failure when the installed launcher exports no runRpcAgent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-gcd-launcher-"));
    temps.push(dir);
    const module = join(dir, "rpc-launcher.mjs");
    writeFileSync(module, "export const somethingElse = 1;\n");
    expect(await importRpcLauncher(module)()).toEqual({ kind: "unavailable", reason: `${module} exports no runRpcAgent` });
    const result = await piArmDispatch(config({ loadLauncher: importRpcLauncher(module) }))(request("emission-enabled"));
    expect(result.observation.outcome).toEqual({ kind: "infrastructure-failure", reason: `${module} exports no runRpcAgent` });
  });

  it("is an infrastructure failure of the attempt, not a thrown window abort, when the launcher cannot be imported", async () => {
    const missing = join(tmpdir(), "loom-gcd-no-such-launcher", "rpc-launcher.mjs");
    const result = await piArmDispatch(config({ loadLauncher: importRpcLauncher(missing) }))(request("emission-enabled"));
    expect(result.observation.outcome).toMatchObject({
      kind: "infrastructure-failure", reason: expect.stringMatching(/^the installed launcher could not be loaded: /),
    });
    expect(result.observation.readinessMs).toBeNull();
    expectArmSample("emission-enabled", result.observation);
  });

  it("is an infrastructure failure of the attempt when runRpcAgent rejects mid-run", async () => {
    const arm = request("emission-enabled");
    const client = fakeClient(arm.cellBinding);
    const runRpcAgent: RunRpcAgent = async (input) => {
      await input.directive.verifyReadiness(client);
      throw new Error("child pipe closed");
    };
    const result = await piArmDispatch(config({ loadLauncher: async () => ({ kind: "loaded", runRpcAgent }) }))(arm);
    expect(result.observation.outcome).toEqual({ kind: "infrastructure-failure", reason: "the installed launcher's runRpcAgent rejected: child pipe closed" });
    expectArmSample("emission-enabled", result.observation);
  });

  it("refuses to record a settled sample when the launcher skipped the readiness barrier", async () => {
    const arm = request("emission-enabled");
    const runRpcAgent: RunRpcAgent = async (input) => {
      emitted(arm.cellBinding.binding.toolName).forEach(input.onMessage);
      return { ok: true, stderr: "" };
    };
    const result = await piArmDispatch(config({ loadLauncher: async () => ({ kind: "loaded", runRpcAgent }) }))(arm);
    expect(result.observation.outcome).toEqual({
      kind: "infrastructure-failure", reason: "the launcher reported success, but the readiness barrier never verified the child",
    });
    expect(result.observation.readinessMs).toBeNull();
    expect(result.acceptedPayload).toBeNull();
  });
});

describe("piArmDispatch extraction-only arm (print-mode JSON child)", () => {
  /** A stand-in `pi` executable: prints the scripted lines, then exits. */
  function fakePi(lines: readonly string[], exit = 0, delaySeconds = 0): string {
    const dir = mkdtempSync(join(tmpdir(), "loom-gcd-pi-"));
    temps.push(dir);
    const path = join(dir, "pi");
    const body = lines.map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`).join("\n");
    writeFileSync(path, `#!/usr/bin/env bash\n${delaySeconds > 0 ? `sleep ${delaySeconds}\n` : ""}${body}\necho "stderr tail" >&2\nexit ${exit}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const messageEnd = (message: unknown): string => JSON.stringify({ type: "message_end", message });
  const finalText = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
  const extraction = async (piCommand: string, timeoutMs = 5_000) =>
    piArmDispatch(config({ repoRoot: tmpdir(), piCommand, timeoutMs }))(request("extraction-only"));

  it("accepts the final message and never counts emission activity", async () => {
    const result = await extraction(fakePi([JSON.stringify({ type: "agent_start" }), messageEnd(finalText(JSON.stringify(PAYLOAD)))]));
    expect(result.observation).toMatchObject({
      readinessMs: null, emissionCalls: 0, toolErrors: [], toolAcknowledged: false, modelRequests: 1,
      outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false },
    });
    expect(result.acceptedPayload).toEqual(PAYLOAD);
    expectArmSample("extraction-only", result.observation);
  });

  it("is an infrastructure failure on a malformed stream line or a non-zero exit", async () => {
    const malformed = await extraction(fakePi([messageEnd(finalText(JSON.stringify(PAYLOAD))), "{not json"]));
    expect(malformed.observation.outcome).toMatchObject({
      kind: "infrastructure-failure", reason: expect.stringMatching(/^Pi JSON stream contained 1 malformed line\(s\): line 2: /),
    });
    // The decoded messages still feed the counters of the failed attempt.
    expect(malformed.observation.modelRequests).toBe(1);
    // Valid JSON that is not an event object is malformed too: a dropped event could be the answer.
    const notAnEvent = await extraction(fakePi(["42", messageEnd(finalText(JSON.stringify(PAYLOAD)))]));
    expect(notAnEvent.observation.outcome).toEqual({
      kind: "infrastructure-failure", reason: "Pi JSON stream contained 1 malformed line(s): line 1: not a JSON event object",
    });
    const crashed = await extraction(fakePi([], 3));
    expect(crashed.observation.outcome).toEqual({ kind: "infrastructure-failure", reason: "stderr tail" });
    const missing = await extraction(join(tmpdir(), "no-such-pi-binary"));
    expect(missing.observation.outcome).toMatchObject({ kind: "infrastructure-failure", reason: expect.stringMatching(/^spawn .*no-such-pi-binary: /) });
  });

  it("kills a child that outlives its timeout, records the timeout, and bounds the attempt even when a descendant holds the child's pipes", async () => {
    // The fake's `sleep 5` is a grandchild (more script follows, so bash does
    // not exec it) that inherits stdout/stderr. Killing only the direct child
    // would leave the pipes open until the sleep exits, about 5 s later.
    const result = await extraction(fakePi([], 0, 5), 100);
    expect(result.observation.outcome).toEqual({ kind: "timeout", afterMs: 100 });
    expect(result.observation.elapsedMs).toBeLessThan(2_000);
  });
});
describe("transcript classification through the engine's own selection", () => {
  const judgePayload = { criterion: "correctness", rankings: [{ candidate: "a.md", score: 7, fatal_flaw: null, strongest_idea: "reuse the budget" }] };
  const cellBinding = (cell: CellKey): CellBinding => {
    const minted = mintCellBinding(cell, pilotRequestId("w", `${cell}#c#r1`, "emission-enabled", 1), "prompt");
    if (!minted.ok) throw new Error(minted.error);
    return minted.value;
  };
  const toolCall = (id: string, name: string, args: unknown) => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] });
  const toolResult = (id: string, name: string, isError: boolean, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });
  const finalText = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
  const classify = (cell: CellKey, messages: readonly unknown[], launch: Parameters<typeof classifyAttemptTranscript>[0]["launch"] = { kind: "settled" }) =>
    classifyAttemptTranscript({ arm: "emission-enabled", cell, cellBinding: cellBinding(cell), messages, attempt: 1, elapsedMs: 1234, readinessMs: 80, launch });

  it("accepts one successful emission call (tool-only completion, no final text)", () => {
    const result = classify("judge-verdict/v1", [toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "accepted")]);
    expect(result.observation).toMatchObject({ emissionCalls: 1, toolAcknowledged: true, followUpTurnsAfterAck: 0, modelRequests: 1, outcome: { kind: "accepted", source: "emission-tool" } });
    expect(result.acceptedPayload).toEqual(judgePayload);
  });

  it("accepts a reviewer v2 emission and counts a follow-up turn after the acknowledgment", () => {
    const result = classify("reviewer-payload/v2", [
      toolCall("c1", "loom_emit_reviewer_payload", REVIEWER_PAYLOAD_EXAMPLE_V2),
      toolResult("c1", "loom_emit_reviewer_payload", false, "accepted"),
      finalText("done"),
    ]);
    expect(result.observation).toMatchObject({ followUpTurnsAfterAck: 1, outcome: { kind: "accepted", source: "emission-tool" } });
  });

  it("falls back to final-message extraction when the model never emits", () => {
    const result = classify("judge-verdict/v1", [finalText(JSON.stringify(judgePayload))]);
    expect(result.observation).toMatchObject({ emissionCalls: 0, outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false } });
  });

  it("records Pi's validation re-prompt and refuses the incomplete observation (no silent recovery)", () => {
    const result = classify("judge-verdict/v1", [
      toolCall("c1", "loom_emit_judge_verdict", { ...judgePayload, rankings: [{ ...judgePayload.rankings[0], score: 12 }] }),
      toolResult("c1", "loom_emit_judge_verdict", true, "Validation failed for tool \"loom_emit_judge_verdict\":\n  - score: must be <= 10"),
      toolCall("c2", "loom_emit_judge_verdict", judgePayload),
      toolResult("c2", "loom_emit_judge_verdict", false, "accepted"),
    ]);
    expect(result.observation.toolErrors).toEqual([{ class: "harness-schema-validation" }]);
    expect(result.observation.emissionCalls).toBe(2);
    expect(result.observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "observation-refused" } });
  });

  it("rejects two distinct successful calls as duplicate-call ambiguity, even with valid final text", () => {
    const result = classify("judge-verdict/v1", [
      toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "ok"),
      toolCall("c2", "loom_emit_judge_verdict", judgePayload), toolResult("c2", "loom_emit_judge_verdict", false, "ok"),
      finalText(JSON.stringify(judgePayload)),
    ]);
    expect(result.observation.outcome).toEqual({ kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } });
  });

  it("rejects an unusable final message and a frozen-parser refusal separately", () => {
    // PR #52's fail-closed admission: no final text, or two candidate text blocks, is an extraction failure.
    expect(classify("judge-verdict/v1", []).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "extraction-failure" } });
    expect(classify("judge-verdict/v1", [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }]).observation.outcome)
      .toMatchObject({ kind: "rejected", cause: { kind: "extraction-failure" } });
    // Admitted text that the frozen parser refuses is an ingestion refusal, not an extraction failure.
    expect(classify("judge-verdict/v1", [finalText("no json here")]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
    expect(classify("judge-verdict/v1", [finalText(JSON.stringify({ criterion: "c", rankings: [{ candidate: "a", score: 12, fatal_flaw: null, strongest_idea: "x" }] }))]).observation.outcome)
      .toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
  });

  it("classifies the extraction-only arm by its final message alone, with no emission counters", () => {
    const extraction = (messages: readonly unknown[]) => classifyAttemptTranscript({
      arm: "extraction-only", cell: "judge-verdict/v1", cellBinding: cellBinding("judge-verdict/v1"), messages, attempt: 1, elapsedMs: 5, launch: { kind: "settled" },
    });
    // A call to the tool the arm was never offered is not an emission call: the baseline extracts.
    const result = extraction([
      toolCall("c1", "loom_emit_judge_verdict", judgePayload),
      toolResult("c1", "loom_emit_judge_verdict", true, "Tool loom_emit_judge_verdict not found"),
      finalText(JSON.stringify(judgePayload)),
    ]);
    expect(result.observation).toEqual({
      attempt: 1, elapsedMs: 5, readinessMs: null, modelRequests: 2, emissionCalls: 0, toolErrors: [], toolAcknowledged: false, followUpTurnsAfterAck: 0,
      outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false, payloadDigest: contentDigest(JSON.stringify(judgePayload)) },
    });
    expect(extraction([]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "extraction-failure" } });
    expect(extraction([finalText("no json here")]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
  });

  it("canonicalizes an accepted payload identically for both arms, whatever the model's key order", () => {
    const reordered = `{"rankings":[{"strongest_idea":"reuse the budget","fatal_flaw":null,"score":7,"candidate":"a.md"}],"criterion":"correctness"}`;
    const emission = classify("judge-verdict/v1", [toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "accepted")]);
    const extraction = classifyAttemptTranscript({
      arm: "extraction-only", cell: "judge-verdict/v1", cellBinding: cellBinding("judge-verdict/v1"), messages: [finalText(reordered)],
      attempt: 1, elapsedMs: 5, launch: { kind: "settled" },
    });
    expect(JSON.stringify(extraction.acceptedPayload)).toBe(JSON.stringify(emission.acceptedPayload));
    expect(extraction.observation.outcome).toMatchObject({ payloadDigest: (emission.observation.outcome as { payloadDigest: string }).payloadDigest });
  });

  it("reads a provider error ending the last model turn as an infrastructure failure on both arms, never as a semantic rejection", () => {
    // What a Pi child records when its route refuses the connection mid-window (gcd-ad11-pilot-2's outage).
    const providerError = { role: "assistant", stopReason: "error", errorMessage: "Connection error.", content: [] };
    const reason = "the provider ended the model turn with an error: Connection error.";
    expect(classify("judge-verdict/v1", [providerError]).observation.outcome).toEqual({ kind: "infrastructure-failure", reason });
    const extraction = classifyAttemptTranscript({
      arm: "extraction-only", cell: "judge-verdict/v1", cellBinding: cellBinding("judge-verdict/v1"), messages: [providerError],
      attempt: 1, elapsedMs: 5, launch: { kind: "settled" },
    });
    expect(extraction.observation).toMatchObject({ modelRequests: 1, outcome: { kind: "infrastructure-failure", reason } });
    expect(classify("judge-verdict/v1", [{ ...providerError, errorMessage: "  " }]).observation.outcome)
      .toEqual({ kind: "infrastructure-failure", reason: "the provider ended the model turn with an error: no error message" });
    // Only the LAST model turn decides: a provider error Pi recovered from is not a failure of the attempt.
    expect(classify("judge-verdict/v1", [providerError, finalText(JSON.stringify(judgePayload))]).observation.outcome)
      .toMatchObject({ kind: "accepted", source: "extraction" });
    // A launch that already failed keeps its own class.
    expect(classify("judge-verdict/v1", [providerError], { kind: "timeout", afterMs: 9 }).observation.outcome).toEqual({ kind: "timeout", afterMs: 9 });
  });

  describe("an accepted payload stands over a trailing provider error (classify first, then the provider-error rule)", () => {
    const providerError = { role: "assistant", stopReason: "error", errorMessage: "Connection error.", content: [] };
    const infrastructure = { kind: "infrastructure-failure", reason: "the provider ended the model turn with an error: Connection error." };

    it("keeps an emission the engine accepted at the tool call when the turn after it errors", () => {
      const result = classify("judge-verdict/v1", [
        toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "accepted"), providerError,
      ]);
      expect(result.observation).toMatchObject({
        emissionCalls: 1, toolAcknowledged: true, followUpTurnsAfterAck: 1, modelRequests: 2,
        outcome: { kind: "accepted", source: "emission-tool", payloadDigest: contentDigest(JSON.stringify(judgePayload)) },
      });
      expect(result.acceptedPayload).toEqual(judgePayload);
    });

    it("reads an attempt with nothing usable before its errored last turn as an infrastructure failure on both arms", () => {
      // A refused emission call (no accepted payload) and then the provider error.
      const refused = classify("judge-verdict/v1", [
        toolCall("c1", "loom_emit_judge_verdict", { criterion: "c" }), toolResult("c1", "loom_emit_judge_verdict", true, "Validation failed"), providerError,
      ]);
      expect(refused.observation).toMatchObject({ emissionCalls: 1, toolAcknowledged: false, outcome: infrastructure });
      expect(refused.acceptedPayload).toBeNull();
      const extraction = classifyAttemptTranscript({
        arm: "extraction-only", cell: "judge-verdict/v1", cellBinding: cellBinding("judge-verdict/v1"),
        messages: [toolCall("c1", "read", { path: "a.md" }), toolResult("c1", "read", false, "text"), providerError],
        attempt: 1, elapsedMs: 5, launch: { kind: "settled" },
      });
      expect(extraction.observation.outcome).toEqual(infrastructure);
      expect(extraction.acceptedPayload).toBeNull();
    });

    it("decides a final message by the LAST model turn, as the production extraction does: an earlier answer the errored turn superseded is not accepted", () => {
      expect(classify("judge-verdict/v1", [finalText(JSON.stringify(judgePayload)), providerError]).observation.outcome).toEqual(infrastructure);
    });

    it("never overrides a rejection the last turn did not end in a provider error", () => {
      expect(classify("judge-verdict/v1", [finalText("no json here")]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
    });
  });

  it("passes launch failures through as their own terminal classes", () => {
    expect(classify("judge-verdict/v1", [], { kind: "startup-refused", reason: "readiness refused" }).observation.outcome).toEqual({ kind: "startup-refused", reason: "readiness refused" });
    expect(classify("judge-verdict/v1", [], { kind: "timeout", afterMs: 900_000 }).observation.outcome).toEqual({ kind: "timeout", afterMs: 900_000 });
    expect(classify("judge-verdict/v1", [], { kind: "infrastructure-failure", reason: "spawn" }).observation.outcome).toEqual({ kind: "infrastructure-failure", reason: "spawn" });
  });
});
