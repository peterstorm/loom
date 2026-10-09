import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiBinding } from "../../src/core/model-profiles";
import {
  httpRouteProbe,
  observeRouteReachability,
  readRouteEndpoint,
  type RouteProbePort,
} from "../../src/utils/route-endpoint";
import { LOCAL_PI_BINDING } from "../fixtures/local-pi-binding";
import { deadLoopbackPort } from "../fixtures/dead-loopback-port";

const LOCAL: PiBinding = LOCAL_PI_BINDING;

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

/** A real HTTP server on loopback; `handle` decides how (and whether) it answers. */
async function rawServer(handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const instance: Server = createServer(handle);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    instance.closeAllConnections();
    instance.close(() => resolve());
  }));
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return `http://127.0.0.1:${address.port}/v1`;
}

/** A loopback server answering `/v1/models` with `status` and the raw `body`. */
const server = (status: number, body: string, contentType = "application/json"): Promise<string> =>
  rawServer((request, response) => {
    response.writeHead(request.url === "/v1/models" ? status : 404, { "content-type": contentType });
    response.end(body);
  });

const json = (body: unknown): string => JSON.stringify(body);

describe("readRouteEndpoint", () => {
  it("reads only the provider's baseUrl", () => {
    const dir = agentDir({ providers: { [LOCAL.provider]: { baseUrl: "http://h:8000/v1", apiKey: "never-read", models: [] } } });
    expect(readRouteEndpoint(dir, LOCAL.provider)).toEqual({ ok: true, endpoint: { provider: LOCAL.provider, baseUrl: "http://h:8000/v1" } });
  });

  it("has no endpoint for an absent file, provider or baseUrl", () => {
    expect(readRouteEndpoint(agentDir(undefined), LOCAL.provider)).toEqual({ ok: true, endpoint: null });
    expect(readRouteEndpoint(agentDir({ providers: {} }), LOCAL.provider)).toEqual({ ok: true, endpoint: null });
    expect(readRouteEndpoint(agentDir({ providers: { [LOCAL.provider]: {} } }), LOCAL.provider)).toEqual({ ok: true, endpoint: null });
  });

  it("reports a malformed models.json instead of reading it as no endpoint", () => {
    expect(readRouteEndpoint(agentDir("{not json"), LOCAL.provider)).toMatchObject({ ok: false, error: expect.stringContaining("cannot parse") });
    expect(readRouteEndpoint(agentDir({ providers: { [LOCAL.provider]: { baseUrl: 7 } } }), LOCAL.provider))
      .toMatchObject({ ok: false, error: expect.stringContaining("invalid") });
  });
});

describe("httpRouteProbe against a real loopback server", () => {
  it("returns the served model ids from a 2xx list", async () => {
    const baseUrl = await server(200, json({ object: "list", data: [{ id: LOCAL.model, object: "model" }] }));
    expect(await httpRouteProbe()({ provider: LOCAL.provider, baseUrl }))
      .toEqual({ kind: "answered", status: 200, servedModels: [LOCAL.model] });
  });

  it("returns the status, without a list, when the server refuses authentication", async () => {
    const baseUrl = await server(401, json({ error: "Unauthorized" }));
    expect(await httpRouteProbe()({ provider: LOCAL.provider, baseUrl })).toEqual({ kind: "answered", status: 401, servedModels: null });
  });

  it("answers without a list when a 2xx body is not JSON (a proxy or captive page)", async () => {
    const baseUrl = await server(200, "<html><body>Sign in to the network</body></html>", "text/html");
    expect(await httpRouteProbe()({ provider: LOCAL.provider, baseUrl })).toEqual({ kind: "answered", status: 200, servedModels: null });
  });

  it("answers without a list when a 2xx JSON body is not an OpenAI-style model list", async () => {
    for (const body of [json({ models: [LOCAL.model] }), json([{ id: LOCAL.model }]), json({ data: [{ name: LOCAL.model }] }), "null"]) {
      const baseUrl = await server(200, body);
      expect(await httpRouteProbe()({ provider: LOCAL.provider, baseUrl }), body)
        .toEqual({ kind: "answered", status: 200, servedModels: null });
    }
  });

  it("is refused when the server accepts the connection but never answers", async () => {
    const baseUrl = await rawServer(() => undefined);
    const started = Date.now();
    expect(await httpRouteProbe(150)({ provider: LOCAL.provider, baseUrl })).toMatchObject({ kind: "refused" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is refused when a 2xx starts its body and then stalls past the timeout", async () => {
    const baseUrl = await rawServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{\"data\": [");
    });
    expect(await httpRouteProbe(150)({ provider: LOCAL.provider, baseUrl }))
      .toMatchObject({ kind: "refused", reason: expect.stringContaining("HTTP 200 body did not arrive") });
  });

  it("is refused when nothing listens", async () => {
    const baseUrl = `http://127.0.0.1:${await deadLoopbackPort()}/v1`;
    expect(await httpRouteProbe()({ provider: LOCAL.provider, baseUrl })).toMatchObject({ kind: "refused" });
  });
});

describe("observeRouteReachability", () => {
  it("probes each distinct route once and decides it", async () => {
    const baseUrl = await server(200, json({ data: [{ id: LOCAL.model }] }));
    const probed: string[] = [];
    const probe: RouteProbePort = async (endpoint) => {
      probed.push(endpoint.baseUrl);
      return httpRouteProbe()(endpoint);
    };
    const observed = await observeRouteReachability([LOCAL, LOCAL], agentDir({ providers: { [LOCAL.provider]: { baseUrl } } }), probe);
    expect(probed).toEqual([baseUrl]);
    expect(observed).toMatchObject({ ok: true, decisions: [{ kind: "reachable", served: { kind: "listed" } }] });
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
