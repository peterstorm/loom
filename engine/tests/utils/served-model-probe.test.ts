/**
 * The served-model shell (`utils/served-model-probe.ts`): a served routing
 * target's provider is read from Pi's `models.json`, its `apiKey` resolved as
 * Pi resolves it, and its `/models` listing requested with that key — once
 * per routing context, synchronously, by a child process. The key reaches the
 * server and nothing else: no reason, refusal or context carries it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentLaunchBinding, type ServedModels } from "../../src/core/model-routing";
import type { RouteProbe } from "../../src/core/route-reachability";
import { readPiRouteGateFacts } from "../../src/utils/emission-environment";
import { buildPiRoutingContext } from "../../src/utils/model-routing-context";
import {
  childProcessListModels,
  LIVE_SERVED_PROBE_PORTS,
  observeServedModels,
  resolveProviderApiKey,
  type ServedProbePorts,
} from "../../src/utils/served-model-probe";
import { deadLoopbackPort } from "../fixtures/dead-loopback-port";

const SECRET = "sk-SECRET-served-probe-7f3a";
const PROVIDER = "desktop-vllm";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function agentDir(files: Readonly<Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-served-probe-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const modelsJson = (provider: Readonly<Record<string, unknown>>): unknown => ({ providers: { [PROVIDER]: provider } });
const declaredProvider = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  baseUrl: "http://vllm.test/v1",
  api: "openai-completions",
  apiKey: SECRET,
  models: [{ id: "warmind-1017" }, { id: "glm-5" }],
  ...overrides,
});

/** Fake ports recording every listing request; `answer` decides each response. */
function fakePorts(answer: RouteProbe, commandOutput: string | null = null): ServedProbePorts & { readonly requests: { url: string; apiKey: string }[]; readonly commands: string[] } {
  const requests: { url: string; apiKey: string }[] = [];
  const commands: string[] = [];
  return {
    requests,
    commands,
    runKeyCommand: (command) => {
      commands.push(command);
      return commandOutput;
    },
    listModels: (url, apiKey) => {
      requests.push({ url, apiKey });
      return answer;
    },
  };
}

const listing = (models: readonly string[] | null, status = 200): RouteProbe => ({ kind: "answered", status, servedModels: models });

/**
 * A loopback `/v1/models` server in its OWN process: the probe is a
 * `spawnSync` child, which blocks this worker's event loop, so a server in
 * the worker could never answer it. `/v1` lists one model to the right key
 * and refuses any other; `/hang/v1` never answers.
 */
async function modelServer(): Promise<string> {
  const script = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      if (request.url === "/hang/v1/models") return;
      if (request.url !== "/v1/models") { response.writeHead(404); return response.end(); }
      if (request.headers.authorization !== "Bearer " + process.env.EXPECTED_KEY) {
        response.writeHead(401, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: { message: "missing or invalid API key" } }));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "warmind-1017", object: "model" }] }));
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
  `;
  const child: ChildProcess = spawn(process.execPath, ["-e", script], { env: { EXPECTED_KEY: SECRET }, stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(() => child.kill("SIGKILL"));
  const port = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
  });
  return `http://127.0.0.1:${port}`;
}

describe("resolving a provider's apiKey as Pi does", () => {
  const never = (): string | null => {
    throw new Error("no command expected");
  };

  it("takes a literal as the key", () => {
    expect(resolveProviderApiKey("sk-literal", {}, never)).toEqual({ ok: true, key: "sk-literal" });
  });

  it("interpolates environment variables, and names every unset one", () => {
    expect(resolveProviderApiKey("$VLLM_KEY", { VLLM_KEY: "abc" }, never)).toEqual({ ok: true, key: "abc" });
    expect(resolveProviderApiKey("${A}-${B}", { A: "1" }, never)).toEqual({ ok: false, missing: { kind: "unset-variables", names: ["B"] } });
    expect(resolveProviderApiKey("$VLLM_KEY", { VLLM_KEY: "" }, never)).toEqual({ ok: false, missing: { kind: "unset-variables", names: ["VLLM_KEY"] } });
  });

  it("runs a ! command, and treats a failed or empty one as no key", () => {
    const ports = fakePorts(listing([]), "sk-from-command");
    expect(resolveProviderApiKey("!pass show vllm", {}, ports.runKeyCommand)).toEqual({ ok: true, key: "sk-from-command" });
    expect(ports.commands).toEqual(["pass show vllm"]);
    expect(resolveProviderApiKey("!false", {}, () => null)).toEqual({ ok: false, missing: { kind: "command-failed" } });
  });

  it("treats an absent or empty key as no key", () => {
    expect(resolveProviderApiKey(null, {}, never)).toEqual({ ok: false, missing: { kind: "absent" } });
    expect(resolveProviderApiKey("", {}, never)).toEqual({ ok: false, missing: { kind: "absent" } });
  });

  it("runs a real command through the shell, trimming its stdout, and reports a failing one as no key", () => {
    expect(LIVE_SERVED_PROBE_PORTS.runKeyCommand("printf '  sk-live \\n'")).toBe("sk-live");
    expect(LIVE_SERVED_PROBE_PORTS.runKeyCommand("exit 3")).toBeNull();
    expect(LIVE_SERVED_PROBE_PORTS.runKeyCommand("true")).toBeNull();
  });
});

describe("observing what a served provider serves", () => {
  it("lists the provider's models at {baseUrl}/models with its key, once per provider", () => {
    const dir = agentDir({ "models.json": modelsJson(declaredProvider()) });
    const ports = fakePorts(listing(["warmind-1017"]));
    expect(observeServedModels([PROVIDER], dir, {}, ports)).toEqual({
      [PROVIDER]: { kind: "served", ref: { provider: PROVIDER, model: "warmind-1017" } },
    });
    expect(ports.requests).toEqual([{ url: "http://vllm.test/v1/models", apiKey: SECRET }]);
  });

  it("probes nothing for no providers", () => {
    const ports = fakePorts(listing(["warmind-1017"]));
    expect(observeServedModels([], agentDir(), {}, ports)).toEqual({});
    expect(ports.requests).toEqual([]);
  });

  it.each([
    ["no models.json", {}, /declares no baseUrl for provider 'desktop-vllm'/],
    ["a provider without a baseUrl", { "models.json": modelsJson(declaredProvider({ baseUrl: undefined })) }, /declares no baseUrl/],
    ["a provider without an apiKey", { "models.json": modelsJson(declaredProvider({ apiKey: undefined })) }, /declares no apiKey/],
    ["an apiKey naming an unset variable", { "models.json": modelsJson(declaredProvider({ apiKey: "$LOOM_TEST_UNSET_KEY" })) }, /unset environment variable LOOM_TEST_UNSET_KEY/],
    ["a malformed models.json", { "models.json": "{not json" }, /cannot parse .*models\.json/],
  ])("refuses, without probing, a provider with %s", (_label, files, reason) => {
    const ports = fakePorts(listing(["warmind-1017"]));
    const served = observeServedModels([PROVIDER], agentDir(files), {}, ports);
    expect(served[PROVIDER]).toMatchObject({ kind: "unknown", reason: expect.stringMatching(reason) });
    expect(ports.requests).toEqual([]);
  });

  it("refuses a served model outside the provider's models.json catalog", () => {
    const served = observeServedModels([PROVIDER], agentDir({ "models.json": modelsJson(declaredProvider()) }), {}, fakePorts(listing(["mystery"])));
    expect(served[PROVIDER]).toMatchObject({ kind: "unknown", reason: expect.stringContaining("serves 'mystery'") });
  });
});

describe("the provider key never leaves the probe", () => {
  const failures: readonly (readonly [string, RouteProbe])[] = [
    ["the server rejects the key", listing(null, 401)],
    ["the server is down", { kind: "refused", reason: "connect ECONNREFUSED 127.0.0.1:9" }],
    ["the server lists several models", listing(["warmind-1017", "glm-5"])],
    ["the server serves a model outside the catalog", listing(["mystery"])],
    ["the server answers an error status", listing(null, 500)],
  ];

  it.each(failures)("not in the reason, the routing context, or the launch refusal when %s", (_label, answer) => {
    const dir = agentDir({ "models.json": modelsJson(declaredProvider()) });
    const served: ServedModels = observeServedModels([PROVIDER], dir, {}, fakePorts(answer));
    expect(JSON.stringify(served)).not.toContain(SECRET);
    const launch = resolveAgentLaunchBinding("code-reviewer", {
      config: {
        schemaVersion: 1,
        defaultClass: "cloud",
        modelClasses: {},
        targets: { served: { kind: "served", provider: PROVIDER, thinking: "max" } },
        rules: [{ id: "cloud-served", when: { parentClass: "cloud" }, use: { kind: "named", target: "served" } }],
      },
      parentRef: { provider: "openai-codex", model: "gpt-5.6-sol" },
      served,
    });
    expect(launch.ok).toBe(false);
    expect(JSON.stringify(launch)).not.toContain(SECRET);
  });

  it("not in what a real probe answers when the server rejects the key", async () => {
    const base = await modelServer();
    const probe = childProcessListModels()(`${base}/v1/models`, "sk-wrong-key");
    expect(probe).toEqual({ kind: "answered", status: 401, servedModels: null });
    expect(JSON.stringify(probe)).not.toContain("sk-wrong-key");
  });
});

describe("the synchronous child-process listing", () => {
  it("lists the served model when the server accepts the key", async () => {
    const base = await modelServer();
    expect(childProcessListModels()(`${base}/v1/models`, SECRET)).toEqual({ kind: "answered", status: 200, servedModels: ["warmind-1017"] });
  });

  it("is refused by a port nothing listens on", async () => {
    const port = await deadLoopbackPort();
    const probe = childProcessListModels()(`http://127.0.0.1:${port}/v1/models`, SECRET);
    expect(probe.kind).toBe("refused");
  });

  it("gives up on a server that never answers, within its timeout", async () => {
    const base = await modelServer();
    const started = Date.now();
    const probe = childProcessListModels(300)(`${base}/hang/v1/models`, SECRET);
    expect(probe.kind).toBe("refused");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("resolves a served target end to end: models.json, a ! command key, the real listing", async () => {
    const base = await modelServer();
    const dir = agentDir({ "models.json": modelsJson(declaredProvider({ baseUrl: `${base}/v1`, apiKey: `!printf %s ${SECRET}` })) });
    expect(observeServedModels([PROVIDER], dir, {}, LIVE_SERVED_PROBE_PORTS)).toEqual({
      [PROVIDER]: { kind: "served", ref: { provider: PROVIDER, model: "warmind-1017" } },
    });
  });
});

describe("every routing reader resolves a served target from one probe", () => {
  const routingConfig = {
    schemaVersion: 1,
    defaultClass: "cloud",
    modelClasses: { local: ["desktop-vllm/*"] },
    targets: { "served-max": { served: PROVIDER, thinkingLevel: "max" } },
    rules: [{ id: "cloud-children-use-served", when: { parentClass: "cloud" }, use: { kind: "named", target: "served-max" } }],
  };
  const env = { PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" };

  it("the render/validator context probes the parent's reachable served providers", () => {
    const dir = agentDir({ "model-routing.json": routingConfig, "models.json": modelsJson(declaredProvider()) });
    const ports = fakePorts(listing(["warmind-1017"]));
    const built = buildPiRoutingContext(env, dir, null, ports);
    expect(built.configError).toBeNull();
    expect(built.context.served).toEqual({ [PROVIDER]: { kind: "served", ref: { provider: PROVIDER, model: "warmind-1017" } } });
    const launch = resolveAgentLaunchBinding("code-reviewer", built.context);
    expect(launch.ok && launch.value.effective).toEqual({ provider: PROVIDER, model: "warmind-1017", thinking: "max" });
    expect(ports.requests).toHaveLength(1);
  });

  it("the spawn route gate reads the same served model", () => {
    const dir = agentDir({ "model-routing.json": routingConfig, "models.json": modelsJson(declaredProvider()) });
    const ports = fakePorts(listing(["warmind-1017"]));
    const facts = readPiRouteGateFacts({ env: { ...env, PI_CODING_AGENT_DIR: dir }, home: agentDir() }, ports);
    expect(facts.routing).toEqual({
      ok: true,
      value: expect.objectContaining({ served: { [PROVIDER]: { kind: "served", ref: { provider: PROVIDER, model: "warmind-1017" } } } }),
    });
  });

  it("probes nothing when no parent is known", () => {
    const dir = agentDir({ "model-routing.json": routingConfig, "models.json": modelsJson(declaredProvider()) });
    const ports = fakePorts(listing(["warmind-1017"]));
    expect(buildPiRoutingContext({}, dir, null, ports).context.served).toEqual({});
    expect(ports.requests).toEqual([]);
  });
});
