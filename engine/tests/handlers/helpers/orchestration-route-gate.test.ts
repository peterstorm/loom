/**
 * The Pi route gate at the façade's emission seam (`emitRunAction`): which
 * actions it gates, that a refusal publishes nothing, and that it probes the
 * route the child will actually launch on. The route probe port is
 * substituted by a recording fake keyed by provider; everything else — the
 * agent directory's `models.json` and `model-routing.json`, the session
 * binding registry — is real files in a scratch directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_VLLM_ROUTE, type PiBinding } from "../../../src/core/model-profiles";
import {
  parseArtifactRef,
  parseFixedArtifactSlot,
  parseStoredAgentRequestAuthority,
  type AgentRequestAuthority,
} from "../../../src/core/orchestration-contract";
import type { RouteProbe } from "../../../src/core/route-reachability";
import { createRunDirectory, type RunDirHandle } from "../../../src/orchestration/run-directory-handle";
import { readSessionRunBindings } from "../../../src/orchestration/session-run-bindings";
import type { FacadeAction } from "../../../src/handlers/helpers/programs/program-result";
import type { RouteProbePort } from "../../../src/utils/route-endpoint";
import { agentRequestAuthority } from "../../fixtures/agent-request-authority";

const LOCAL_ROUTE = `${DESKTOP_VLLM_ROUTE.provider}/${DESKTOP_VLLM_ROUTE.model}`;
const MUSE = { provider: "desktop-muse", model: "qwen3.8-27b" } as const;
const RETIRED_SOL: PiBinding = { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };
const RUN_ID = "run.route-gate";

const scratch = mkdtempSync(join(tmpdir(), "loom-route-gate-"));
const bindingDir = join(scratch, "session-bindings");
mkdirSync(bindingDir);
let emitRunAction: typeof import("../../../src/handlers/helpers/orchestration").emitRunAction;

beforeAll(async () => {
  // SUBAGENT_DIR is frozen from the environment when config.ts loads.
  vi.stubEnv("LOOM_SUBAGENT_DIR", bindingDir);
  vi.resetModules();
  ({ emitRunAction } = await import("../../../src/handlers/helpers/orchestration"));
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
let stdout: string[];
let stderr: string[];
let handle: RunDirHandle;
let agentDir: string;

beforeEach(() => {
  counter += 1;
  const caseDir = join(scratch, `case-${counter}`);
  agentDir = join(caseDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  // A hermetic home: the routing loader falls back to ~/.pi/agent, which must
  // never be the operator's.
  vi.stubEnv("HOME", join(caseDir, "home"));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [DESKTOP_VLLM_ROUTE.provider]: { baseUrl: "http://vllm.test/v1", api: "openai-completions", models: [{ id: DESKTOP_VLLM_ROUTE.model }] },
      [MUSE.provider]: { baseUrl: "http://muse.test/v1", api: "openai-completions", models: [{ id: MUSE.model }] },
    },
  }));
  const runsRoot = join(caseDir, "runs");
  mkdirSync(runsRoot);
  const created = createRunDirectory(runsRoot, join(runsRoot, RUN_ID));
  if (!created.ok) throw new Error(created.error.message);
  handle = created.value;
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("LOOM_SUBAGENT_DIR", bindingDir);
});

const sessionId = (): string => `019ff290-ffee-7e86-8ed0-${String(counter).padStart(12, "0")}`;

function piParent(parent: Readonly<{ provider: string; model: string }> | null = null): string {
  const id = sessionId();
  vi.stubEnv("PI_CODING_AGENT", "true");
  vi.stubEnv("PI_SESSION_ID", id);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("CLAUDECODE", undefined);
  vi.stubEnv("PI_PROVIDER", parent?.provider);
  vi.stubEnv("PI_MODEL", parent?.model);
  return id;
}

function claudeCodeParent(): string {
  const id = "8a510c9a-c1fb-4b89-b61f-08ef6a007c7b";
  vi.stubEnv("PI_CODING_AGENT", undefined);
  vi.stubEnv("PI_SESSION_ID", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", id);
  return id;
}

/** A recording probe fake: each provider answers as configured; unlisted providers refuse. */
function probeFake(answers: Readonly<Record<string, RouteProbe>>): Readonly<{ probe: RouteProbePort; probed: readonly string[] }> {
  const probed: string[] = [];
  return {
    probed,
    probe: async (endpoint) => {
      probed.push(endpoint.provider);
      return answers[endpoint.provider] ?? { kind: "refused", reason: "fetch failed (connect ECONNREFUSED)" };
    },
  };
}

const listing = (...served: string[]): RouteProbe => ({ kind: "answered", status: 200, servedModels: served });
const DOWN: RouteProbe = { kind: "refused", reason: "fetch failed (connect ECONNREFUSED)" };

function storedAuthority(overrides: Record<string, unknown> = {}): AgentRequestAuthority {
  const parsed = parseStoredAgentRequestAuthority(agentRequestAuthority(RUN_ID, overrides));
  if (!parsed.ok) throw new Error(parsed.error.violations.map(({ message }) => message).join("; "));
  return parsed.value;
}

function spawnBatch(authorities: readonly AgentRequestAuthority[]): FacadeAction {
  const first = authorities[0];
  if (first === undefined) throw new Error("a spawn batch needs a request");
  return {
    kind: "spawn-batch",
    runId: first.runId,
    requests: authorities.map((authority) => {
      const slot = parseFixedArtifactSlot({ kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` });
      if (!slot.ok) throw new Error(slot.error.message);
      return { authority, context: { digest: authority.contextDigest, slot: slot.value }, task: `task for ${authority.requestId}` };
    }),
  };
}

const retiredAuthority = (): AgentRequestAuthority => storedAuthority({
  requestId: "request:reviewer:retired",
  harnessBinding: { pi: RETIRED_SOL, claude: { harness: "claude-code", model: "sonnet" } },
});

const piBindings = (id: string) => readSessionRunBindings(bindingDir, id, "pi");

function routeConfig(use: unknown, targets: Readonly<Record<string, unknown>> = {}): void {
  writeFileSync(join(agentDir, "model-routing.json"), JSON.stringify({
    schemaVersion: 1,
    defaultClass: "cloud",
    modelClasses: { local: ["desktop-vllm/*", "desktop-muse/*"] },
    targets,
    rules: [{ id: "local-parent-routing", when: { parentClass: "local" }, use }],
  }));
}

describe("emitRunAction: Pi route gate wiring", () => {
  it("refuses a Pi spawn batch whose route is down and publishes nothing", async () => {
    const id = piParent();
    const { probe, probed } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: DOWN });

    const result = await emitRunAction(handle, spawnBatch([storedAuthority()]), probe);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining(`refusing to spawn: route ${LOCAL_ROUTE} is unreachable at http://vllm.test/v1/models`) });
    expect(probed).toEqual([DESKTOP_VLLM_ROUTE.provider]);
    expect(stdout).toEqual([]);
    expect(piBindings(id)).toEqual({ ok: true, value: [] });
  });

  it("admits a Pi spawn batch whose route lists the model, then publishes the binding and prints the action", async () => {
    const id = piParent();
    const { probe } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: listing(DESKTOP_VLLM_ROUTE.model) });
    const authority = storedAuthority();

    expect(await emitRunAction(handle, spawnBatch([authority]), probe)).toEqual({ kind: "allow" });

    expect(piBindings(id)).toMatchObject({ ok: true, value: [{ runId: RUN_ID, requestIds: [authority.requestId] }] });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ kind: "spawn-batch", runId: RUN_ID });
    expect(stderr.join("")).not.toContain("loom-route-unverified");
  });

  it("refuses a batch recorded on a retired route with the restart remedy, without probing it", async () => {
    const id = piParent();
    const { probe, probed } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: listing(DESKTOP_VLLM_ROUTE.model) });

    const result = await emitRunAction(handle, spawnBatch([retiredAuthority()]), probe);

    expect(result.kind).toBe("error");
    const message = result.kind === "error" ? result.message : "";
    expect(message).toContain("route openai-codex/gpt-5.6-sol (recorded under profile 'general-review') is retired");
    expect(message).toContain("start a fresh run");
    expect(message).not.toContain("unconfigured");
    expect(message).not.toContain("bring the route up");
    expect(probed).toEqual([]);
    expect(stdout).toEqual([]);
    expect(piBindings(id)).toEqual({ ok: true, value: [] });
  });

  it("admits a reachable route whose list is unobservable and reports it on stderr", async () => {
    const id = piParent();
    const { probe } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: { kind: "answered", status: 401, servedModels: null } });

    expect(await emitRunAction(handle, spawnBatch([storedAuthority()]), probe)).toEqual({ kind: "allow" });

    const events = stderr.join("").trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    expect(events).toEqual([{
      event: "loom-route-unverified", route: LOCAL_ROUTE, url: "http://vllm.test/v1/models", cause: "auth-refused", status: 401,
    }]);
    expect(piBindings(id)).toMatchObject({ ok: true, value: [{ runId: RUN_ID }] });
  });

  it("leaves an unparseable request authority to the binding publication, which reports it", async () => {
    piParent();
    const { probe, probed } = probeFake({});
    const action = spawnBatch([storedAuthority()]);
    // A stored authority the parser no longer admits: the in-memory type
    // cannot express it, which is exactly why the gate re-parses.
    const broken: FacadeAction = action.kind === "spawn-batch"
      ? { ...action, requests: action.requests.map((request) => ({ ...request, authority: { ...request.authority, modelProfile: "no-such-profile" } as unknown as AgentRequestAuthority })) }
      : action;

    const result = await emitRunAction(handle, broken, probe);

    expect(probed).toEqual([]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Pi orchestration spawn request 0") });
  });

  it("never gates a Claude Code parent, even when every route is down", async () => {
    const id = claudeCodeParent();
    const { probe, probed } = probeFake({});
    const authority = storedAuthority();

    expect(await emitRunAction(handle, spawnBatch([authority]), probe)).toEqual({ kind: "allow" });

    expect(probed).toEqual([]);
    expect(readSessionRunBindings(bindingDir, id, "claude-code"))
      .toMatchObject({ ok: true, value: [{ runId: RUN_ID, requestIds: [authority.requestId] }] });
  });

  it("leaves every non-spawn action under a Pi parent untouched", async () => {
    piParent();
    const { probe, probed } = probeFake({});
    const { runId } = storedAuthority();
    const artifact = parseArtifactRef({ runId, slot: { kind: "fixed-artifact-slot", path: "summary.json" }, digest: "b".repeat(64), byteLength: 2 });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const actions: readonly FacadeAction[] = [
      { kind: "blocked", runId, diagnostic: { kind: "wave-gate-blocked", message: "blocked for the test" } },
      { kind: "done", runId, outcome: artifact.value },
    ];
    for (const action of actions) {
      stdout.length = 0;
      expect(await emitRunAction(handle, action, probe)).toEqual({ kind: "allow" });
      expect(JSON.parse(stdout.join(""))).toMatchObject({ kind: action.kind });
    }
    expect(probed).toEqual([]);
  });
});

describe("emitRunAction: the gate probes the route the child launches on", () => {
  const LOCAL_PARENT = { provider: DESKTOP_VLLM_ROUTE.provider, model: DESKTOP_VLLM_ROUTE.model };
  const MUSE_TARGET = { muse: { model: `${MUSE.provider}/${MUSE.model}`, thinkingLevel: "medium" } };

  it("admits when routing sends the child to a live target although the declared route is down", async () => {
    piParent(LOCAL_PARENT);
    routeConfig({ kind: "named", target: "muse" }, MUSE_TARGET);
    const { probe, probed } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: DOWN, [MUSE.provider]: listing(MUSE.model) });

    expect(await emitRunAction(handle, spawnBatch([storedAuthority()]), probe)).toEqual({ kind: "allow" });
    expect(probed).toEqual([MUSE.provider]);
  });

  it("refuses when routing sends the child to a down target although the declared route is up", async () => {
    const id = piParent(LOCAL_PARENT);
    routeConfig({ kind: "named", target: "muse" }, MUSE_TARGET);
    const { probe, probed } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: listing(DESKTOP_VLLM_ROUTE.model), [MUSE.provider]: DOWN });

    const result = await emitRunAction(handle, spawnBatch([storedAuthority()]), probe);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining(`route ${MUSE.provider}/${MUSE.model} is unreachable`) });
    expect(probed).toEqual([MUSE.provider]);
    expect(piBindings(id)).toEqual({ ok: true, value: [] });
  });

  it("probes the declared route when the parent is not local, so no rule applies", async () => {
    piParent({ provider: "openai-codex", model: "gpt-5.6-sol" });
    routeConfig({ kind: "named", target: "muse" }, MUSE_TARGET);
    const { probe, probed } = probeFake({ [DESKTOP_VLLM_ROUTE.provider]: listing(DESKTOP_VLLM_ROUTE.model) });

    expect(await emitRunAction(handle, spawnBatch([storedAuthority()]), probe)).toEqual({ kind: "allow" });
    expect(probed).toEqual([DESKTOP_VLLM_ROUTE.provider]);
  });
});
