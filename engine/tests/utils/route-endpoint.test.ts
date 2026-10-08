import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiBinding } from "../../src/core/model-profiles";
import { httpRouteProbe, observeRouteReachability, readRouteEndpoint, type RouteProbePort } from "../../src/utils/route-endpoint";

const LOCAL: PiBinding = { harness: "pi", provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function agentDir(models: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-route-endpoint-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  if (models !== undefined) writeFileSync(join(dir, "models.json"), typeof models === "string" ? models : JSON.stringify(models));
  return dir;
}

/** A real HTTP server on loopback answering `/v1/models` as configured. */
async function server(status: number, body: unknown): Promise<string> {
  const instance: Server = createServer((request, response) => {
    response.writeHead(request.url === "/v1/models" ? status : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => instance.close(() => resolve())));
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("readRouteEndpoint", () => {
  it("reads only the provider's baseUrl", () => {
    const dir = agentDir({ providers: { "desktop-vllm": { baseUrl: "http://h:8000/v1", apiKey: "never-read", models: [] } } });
    expect(readRouteEndpoint(dir, "desktop-vllm")).toEqual({ ok: true, endpoint: { provider: "desktop-vllm", baseUrl: "http://h:8000/v1" } });
  });

  it("has no endpoint for an absent file, provider or baseUrl", () => {
    expect(readRouteEndpoint(agentDir(undefined), "desktop-vllm")).toEqual({ ok: true, endpoint: null });
    expect(readRouteEndpoint(agentDir({ providers: {} }), "desktop-vllm")).toEqual({ ok: true, endpoint: null });
    expect(readRouteEndpoint(agentDir({ providers: { "desktop-vllm": {} } }), "desktop-vllm")).toEqual({ ok: true, endpoint: null });
  });

  it("reports a malformed models.json instead of reading it as no endpoint", () => {
    expect(readRouteEndpoint(agentDir("{not json"), "desktop-vllm")).toMatchObject({ ok: false, error: expect.stringContaining("cannot parse") });
    expect(readRouteEndpoint(agentDir({ providers: { "desktop-vllm": { baseUrl: 7 } } }), "desktop-vllm"))
      .toMatchObject({ ok: false, error: expect.stringContaining("invalid") });
  });
});

describe("httpRouteProbe against a real loopback server", () => {
  it("returns the served model ids from a 2xx list", async () => {
    const baseUrl = await server(200, { object: "list", data: [{ id: LOCAL.model, object: "model" }] });
    expect(await httpRouteProbe()({ provider: "desktop-vllm", baseUrl }))
      .toEqual({ kind: "answered", status: 200, servedModels: [LOCAL.model] });
  });

  it("returns the status, without a list, when the server refuses authentication", async () => {
    const baseUrl = await server(401, { error: "Unauthorized" });
    expect(await httpRouteProbe()({ provider: "desktop-vllm", baseUrl })).toEqual({ kind: "answered", status: 401, servedModels: null });
  });

  it("is refused when nothing listens", async () => {
    // Port 9 (discard) on loopback: refused immediately, never a model server.
    expect(await httpRouteProbe()({ provider: "desktop-vllm", baseUrl: "http://127.0.0.1:9/v1" })).toMatchObject({ kind: "refused" });
  });
});

describe("observeRouteReachability", () => {
  it("probes each distinct route once and decides it", async () => {
    const baseUrl = await server(200, { data: [{ id: LOCAL.model }] });
    const probed: string[] = [];
    const probe: RouteProbePort = async (endpoint) => {
      probed.push(endpoint.baseUrl);
      return httpRouteProbe()(endpoint);
    };
    const observed = await observeRouteReachability([LOCAL, LOCAL], agentDir({ providers: { "desktop-vllm": { baseUrl } } }), probe);
    expect(probed).toEqual([baseUrl]);
    expect(observed).toMatchObject({ ok: true, decisions: [{ kind: "reachable", served: "listed" }] });
  });

  it("decides an unconfigured provider without probing", async () => {
    const probe: RouteProbePort = async () => { throw new Error("must not probe"); };
    expect(await observeRouteReachability([LOCAL], agentDir({ providers: {} }), probe))
      .toMatchObject({ ok: true, decisions: [{ kind: "unconfigured" }] });
  });

  it("reports a malformed models.json", async () => {
    const probe: RouteProbePort = async () => { throw new Error("must not probe"); };
    expect(await observeRouteReachability([LOCAL], agentDir("[]"), probe)).toMatchObject({ ok: false });
  });
});
