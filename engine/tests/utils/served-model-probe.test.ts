/**
 * The served-model shell (`utils/served-model-probe.ts`): a served routing
 * target's provider is read from Pi's `models.json`, its key picked and
 * resolved as Pi picks it (a credential `auth.json` stores, else the
 * `apiKey`), and its `/models` listing requested with that key —
 * synchronously, by a child process that follows no redirect. The key reaches
 * the configured server and nothing else: no cause, refusal or context
 * carries it, and a key no header can carry is never sent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveAgentLaunchBinding, type ServedModel, type ServedModels } from "../../src/core/model-routing";
import type { RouteProbe } from "../../src/core/route-reachability";
import { describeServedModelUnknown } from "../../src/core/served-model-cause";
import { readPiRouteGateFacts } from "../../src/utils/emission-environment";
import { buildPiRoutingContext } from "../../src/utils/model-routing-context";
import {
  childProcessListModels,
  LIVE_SERVED_PROBE_PORTS,
  memoizedProbePorts,
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

/** The operator-facing reason a served model is unknown, rendered from its cause. */
const reasonOf = (served: ServedModel | undefined): string => {
  if (served?.kind !== "unknown") throw new Error(`expected an unknown served model, got ${JSON.stringify(served)}`);
  return describeServedModelUnknown(PROVIDER, served.cause);
};

/**
 * A loopback `/v1/models` server in its OWN process: the probe is a
 * `spawnSync` child, which blocks this worker's event loop, so a server in
 * the worker could never answer it. `/v1` lists one model to the right key
 * and refuses any other; `/hang/v1` never answers.
 */
async function modelServer(redirectTo = ""): Promise<string> {
  const script = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      if (request.url === "/hang/v1/models") return;
      if (request.url === "/redirect/v1/models") { response.writeHead(302, { location: process.env.REDIRECT_TO }); return response.end(); }
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
  const child: ChildProcess = spawn(process.execPath, ["-e", script], { env: { EXPECTED_KEY: SECRET, REDIRECT_TO: redirectTo }, stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(() => child.kill("SIGKILL"));
  const port = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
  });
  return `http://127.0.0.1:${port}`;
}

/**
 * A loopback server, in its own process, that counts every request it is
 * sent (answering each with a one-model listing) and reports the count, and
 * every Authorization header it saw, at `/__seen`.
 */
const seenSchema = z.object({ hits: z.number(), authorizations: z.array(z.string()) });

async function recordingServer(): Promise<Readonly<{ base: string; seen: () => Promise<z.infer<typeof seenSchema>> }>> {
  const script = `
    const http = require("node:http");
    const authorizations = [];
    const server = http.createServer((request, response) => {
      if (request.url === "/__seen") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ hits: authorizations.length, authorizations }));
      }
      authorizations.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "warmind-1017", object: "model" }] }));
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
  `;
  const child: ChildProcess = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(() => child.kill("SIGKILL"));
  const port = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
  });
  const base = `http://127.0.0.1:${port}`;
  return { base, seen: async () => seenSchema.parse(await (await fetch(`${base}/__seen`)).json()) };
}

describe("resolving a provider's key as Pi does", () => {
  const never = (): string | null => {
    throw new Error("no command expected");
  };

  it("takes a models.json literal as the key", () => {
    expect(resolveProviderApiKey(null, "sk-literal", {}, never)).toEqual({ ok: true, key: "sk-literal" });
  });

  it("interpolates environment variables, and names every unset one with the file it came from", () => {
    expect(resolveProviderApiKey(null, "$VLLM_KEY", { VLLM_KEY: "abc" }, never)).toEqual({ ok: true, key: "abc" });
    expect(resolveProviderApiKey(null, "${A}-${B}", { A: "1" }, never))
      .toEqual({ ok: false, unusable: { kind: "unset-variables", source: "models-json", names: ["B"] } });
    expect(resolveProviderApiKey(null, "$VLLM_KEY", { VLLM_KEY: "" }, never))
      .toEqual({ ok: false, unusable: { kind: "unset-variables", source: "models-json", names: ["VLLM_KEY"] } });
  });

  it("runs a ! command, and treats a failed or empty one as no key", () => {
    const ports = fakePorts(listing([]), "sk-from-command");
    expect(resolveProviderApiKey(null, "!pass show vllm", {}, ports.runKeyCommand)).toEqual({ ok: true, key: "sk-from-command" });
    expect(ports.commands).toEqual(["pass show vllm"]);
    expect(resolveProviderApiKey(null, "!false", {}, () => null)).toEqual({ ok: false, unusable: { kind: "command-failed", source: "models-json" } });
  });

  it("treats an absent or empty key as no key", () => {
    expect(resolveProviderApiKey(null, null, {}, never)).toEqual({ ok: false, unusable: { kind: "absent" } });
    expect(resolveProviderApiKey(null, "", {}, never)).toEqual({ ok: false, unusable: { kind: "absent" } });
  });

  it("prefers a stored auth.json key, reading the entry's env before the process environment", () => {
    expect(resolveProviderApiKey({ type: "api_key", key: "$K", env: { K: "stored" } }, "sk-models", { K: "process" }, never))
      .toEqual({ ok: true, key: "stored" });
    expect(resolveProviderApiKey({ type: "api_key", key: "$K", env: { K: "" } }, "sk-models", { K: "process" }, never))
      .toEqual({ ok: true, key: "process" });
    expect(resolveProviderApiKey({ type: "api_key", key: "$MISSING", env: {} }, "sk-models", {}, never))
      .toEqual({ ok: false, unusable: { kind: "unset-variables", source: "auth-json", names: ["MISSING"] } });
    expect(resolveProviderApiKey({ type: "api_key", key: "!pass show vllm", env: {} }, null, {}, () => null))
      .toEqual({ ok: false, unusable: { kind: "command-failed", source: "auth-json" } });
  });

  it("sends no key for a stored credential without one, never the models.json apiKey", () => {
    expect(resolveProviderApiKey({ type: "oauth" }, "sk-models", {}, never))
      .toEqual({ ok: false, unusable: { kind: "stored-credential-keyless", credential: "oauth" } });
    expect(resolveProviderApiKey({ type: "api_key", key: null, env: {} }, "sk-models", {}, never))
      .toEqual({ ok: false, unusable: { kind: "stored-credential-keyless", credential: "api_key" } });
  });

  it("refuses a key no HTTP header can carry, from either file, without returning it", () => {
    const multiLine = resolveProviderApiKey(null, "sk-line-one\nsk-line-two", {}, never);
    expect(multiLine).toEqual({ ok: false, unusable: { kind: "not-a-header-value", source: "models-json" } });
    expect(resolveProviderApiKey({ type: "api_key", key: "!cat key", env: {} }, null, {}, () => "sk-bell\u0007"))
      .toEqual({ ok: false, unusable: { kind: "not-a-header-value", source: "auth-json" } });
    expect(JSON.stringify(multiLine)).not.toContain("sk-line");
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
    ["a provider without an apiKey", { "models.json": modelsJson(declaredProvider({ apiKey: undefined })) }, /neither Pi's auth.json nor its models.json holds a key/],
    ["an apiKey naming an unset variable", { "models.json": modelsJson(declaredProvider({ apiKey: "$LOOM_TEST_UNSET_KEY" })) }, /unset environment variable LOOM_TEST_UNSET_KEY/],
    ["a multi-line apiKey", { "models.json": modelsJson(declaredProvider({ apiKey: `${SECRET}\nsecond-line` })) }, /an HTTP header cannot carry/],
    ["a malformed models.json", { "models.json": "{not json" }, /cannot parse .*models\.json/],
    ["an oauth login stored in auth.json", {
      "models.json": modelsJson(declaredProvider()),
      "auth.json": { [PROVIDER]: { type: "oauth", access: "a", refresh: "r", expires: 1 } },
    }, /auth.json stores an oauth credential for provider 'desktop-vllm' that holds no key/],
    ["a keyless api_key entry stored in auth.json", {
      "models.json": modelsJson(declaredProvider()),
      "auth.json": { [PROVIDER]: { type: "api_key" } },
    }, /stores an api_key credential .* holds no key/],
    ["an auth.json that is not JSON", { "models.json": modelsJson(declaredProvider()), "auth.json": "{not json" }, /cannot parse .*auth\.json: it is not JSON/],
    ["an auth.json that is not an object", { "models.json": modelsJson(declaredProvider()), "auth.json": [] }, /invalid .*auth\.json: expected an object keyed by provider/],
    ["an auth.json entry Pi would refuse", {
      "models.json": modelsJson(declaredProvider()),
      "auth.json": { other: { type: "api_key", key: 42 } },
    }, /invalid .*auth\.json: the credential for provider "other" is not an api_key or oauth entry Pi accepts \(field key\)/],
  ])("refuses, without probing, a provider with %s", (_label, files, reason) => {
    const ports = fakePorts(listing(["warmind-1017"]));
    const served = observeServedModels([PROVIDER], agentDir(files), {}, ports);
    expect(reasonOf(served[PROVIDER])).toMatch(reason);
    expect(ports.requests).toEqual([]);
  });

  it("refuses a served model outside the provider's models.json catalog", () => {
    const served = observeServedModels([PROVIDER], agentDir({ "models.json": modelsJson(declaredProvider()) }), {}, fakePorts(listing(["mystery"])));
    expect(served[PROVIDER]).toEqual({ kind: "unknown", cause: { kind: "undeclared-model", model: "mystery" } });
  });

  it("lists with the key auth.json stores, not the models.json apiKey", () => {
    const dir = agentDir({
      "models.json": modelsJson(declaredProvider({ apiKey: "sk-models-json-key" })),
      "auth.json": `\uFEFF${JSON.stringify({ [PROVIDER]: { type: "api_key", key: "$STORED", env: { STORED: SECRET } } })}`,
    });
    const ports = fakePorts(listing(["warmind-1017"]));
    expect(observeServedModels([PROVIDER], dir, {}, ports)[PROVIDER]).toEqual({ kind: "served", ref: { provider: PROVIDER, model: "warmind-1017" } });
    expect(ports.requests).toEqual([{ url: "http://vllm.test/v1/models", apiKey: SECRET }]);
  });

  it("uses the models.json apiKey when auth.json stores a credential only for another provider", () => {
    const dir = agentDir({
      "models.json": modelsJson(declaredProvider()),
      "auth.json": { "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } },
    });
    const ports = fakePorts(listing(["warmind-1017"]));
    observeServedModels([PROVIDER], dir, {}, ports);
    expect(ports.requests).toEqual([{ url: "http://vllm.test/v1/models", apiKey: SECRET }]);
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

  it.each([
    ["models.json", { "models.json": `{"providers":{"${PROVIDER}":{"baseUrl":"http://vllm.test/v1","apiKey": ${SECRET}}}}` }],
    ["auth.json", { "models.json": modelsJson(declaredProvider({ apiKey: undefined })), "auth.json": `{"${PROVIDER}":{"type":"api_key","key": ${SECRET}}}` }],
  ])("not in the cause when a malformed %s holds it", (_file, files) => {
    const served = observeServedModels([PROVIDER], agentDir(files), {}, fakePorts(listing(["warmind-1017"])));
    expect(served[PROVIDER]).toMatchObject({ kind: "unknown", cause: { kind: "unreadable-config" } });
    expect(JSON.stringify(served)).not.toContain("sk-SECRET");
  });

  it("not in what a real probe answers when the server rejects the key", async () => {
    const base = await modelServer();
    const probe = childProcessListModels()(`${base}/v1/models`, "sk-wrong-key");
    expect(probe).toEqual({ kind: "answered", status: 401, servedModels: null });
    expect(JSON.stringify(probe)).not.toContain("sk-wrong-key");
  });
});

describe("what the child-process listing sends", () => {
  it.each([
    ["a multi-line key", `${SECRET}\nsecond-line`],
    ["a key with a control character", `${SECRET}\u0000`],
    ["a key outside Latin-1", `${SECRET}\u20ac`],
  ])("refuses %s without a request, and without quoting it", async (_label, key) => {
    const server = await recordingServer();
    const probe = childProcessListModels()(`${server.base}/v1/models`, key);
    expect(probe).toEqual({ kind: "refused", reason: "the key is not a valid HTTP header value; it was not sent" });
    expect(await server.seen()).toEqual({ hits: 0, authorizations: [] });
  });

  it("follows no redirect: the key never reaches the redirect's target", async () => {
    const target = await recordingServer();
    const base = await modelServer(`${target.base}/v1/models`);
    const probe = childProcessListModels()(`${base}/redirect/v1/models`, SECRET);
    expect(probe.kind).toBe("refused");
    expect(JSON.stringify(probe)).not.toContain(SECRET);
    expect(await target.seen()).toEqual({ hits: 0, authorizations: [] });
  });

  it("sends the key to the configured server", async () => {
    const server = await recordingServer();
    expect(childProcessListModels()(`${server.base}/v1/models`, SECRET)).toEqual({ kind: "answered", status: 200, servedModels: ["warmind-1017"] });
    expect(await server.seen()).toEqual({ hits: 1, authorizations: [`Bearer ${SECRET}`] });
  });
});

describe("reusing observations for a bounded window", () => {
  const clock = () => {
    const state = { now: 1_000 };
    return { now: () => state.now, advance: (ms: number) => { state.now += ms; } };
  };

  it("reuses a listing per URL and key within the window, and lists afresh after it", () => {
    const time = clock();
    const inner = fakePorts(listing(["warmind-1017"]));
    const ports = memoizedProbePorts(inner, time.now, 30_000);
    ports.listModels("http://a/v1/models", "k1");
    ports.listModels("http://a/v1/models", "k1");
    ports.listModels("http://a/v1/models", "k2");
    ports.listModels("http://b/v1/models", "k1");
    expect(inner.requests).toHaveLength(3);
    time.advance(29_999);
    ports.listModels("http://a/v1/models", "k1");
    expect(inner.requests).toHaveLength(3);
    time.advance(1);
    ports.listModels("http://a/v1/models", "k1");
    expect(inner.requests).toHaveLength(4);
  });

  it("sees a model switch once the window ends", () => {
    const time = clock();
    const answers = [listing(["glm-5"]), listing(["warmind-1017"])];
    const ports = memoizedProbePorts({ runKeyCommand: () => null, listModels: () => answers.shift() ?? listing([]) }, time.now, 30_000);
    expect(ports.listModels("http://a/v1/models", "k")).toEqual(listing(["glm-5"]));
    expect(ports.listModels("http://a/v1/models", "k")).toEqual(listing(["glm-5"]));
    time.advance(30_000);
    expect(ports.listModels("http://a/v1/models", "k")).toEqual(listing(["warmind-1017"]));
  });

  it("reuses a key command's output within the window, but runs a failing command again", () => {
    const time = clock();
    const outputs: (string | null)[] = [null, "sk-1", "sk-2", "sk-3"];
    const runs: string[] = [];
    const ports = memoizedProbePorts({ runKeyCommand: (command) => { runs.push(command); return outputs.shift() ?? null; }, listModels: () => listing([]) }, time.now, 30_000);
    expect(ports.runKeyCommand("pass show vllm")).toBeNull();
    expect(ports.runKeyCommand("pass show vllm")).toBe("sk-1");
    expect(ports.runKeyCommand("pass show vllm")).toBe("sk-1");
    time.advance(30_000);
    expect(ports.runKeyCommand("pass show vllm")).toBe("sk-2");
    expect(runs).toHaveLength(3);
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
