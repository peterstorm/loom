import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMISSION_READINESS_COMMAND, EMISSION_READINESS_ENTRY_TYPE, LOOM_EMISSION_BINDING_ENV } from "../../pi/emission-tool";
import { parseSampleObservation, type AttemptObservation, type PilotArm } from "./pilot-core";
import {
  importRpcLauncher,
  mintCellBinding,
  piArmDispatch,
  type ArmRequest,
  type CellBinding,
  type PiDispatchConfig,
  type ReadinessClient,
  type RpcLauncher,
  type RunRpcAgent,
} from "./pilot-dispatch";
import { pilotRequestId } from "./pilot-workload";

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
    expect(malformed.observation.outcome).toMatchObject({ kind: "infrastructure-failure", reason: expect.stringContaining("1 malformed line(s)") });
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
