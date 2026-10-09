/**
 * The façade smoke's stand-in for the local Pi route (ADR-0023). A Pi
 * parent's spawn batches pass the route gate, which probes
 * `GET {baseUrl}/models`; the smoke points Pi's models.json at this stub so no
 * vLLM host has to be reachable. It runs in a separate process because every
 * CLI call the smoke makes is a blocking spawnSync, which an in-process server
 * could never answer.
 *
 * The stub announces the port it bound as its first stdout line. That line is
 * parsed, not trusted: anything but a TCP port stops the stub and fails its
 * start naming the line, instead of a NaN port surfacing later as an opaque
 * route-probe failure.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ROUTE_STUB_SOURCE = `
const served = JSON.stringify({ object: "list", data: [{ id: process.env.STUB_MODEL, object: "model" }] });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => new URL(request.url).pathname === "/v1/models"
    ? new Response(served, { headers: { "content-type": "application/json" } })
    : new Response("not found", { status: 404 }),
});
process.stdout.write(server.port + "\\n");
`;

declare const ROUTE_STUB_PORT: unique symbol;

/** A TCP port the stub announced: an integer in 1..65535. */
type RouteStubPort = number & { readonly [ROUTE_STUB_PORT]: true };

type RouteStubPortParse =
  | Readonly<{ ok: true; value: RouteStubPort }>
  | Readonly<{ ok: false; error: string }>;

/** Parse the stub's announcement line: exactly a decimal TCP port, no sign, padding or whitespace. Pure and total. */
export function parseRouteStubPort(line: string): RouteStubPortParse {
  const port = /^[1-9][0-9]{0,4}$/.test(line) ? Number(line) : Number.NaN;
  return port >= 1 && port <= 65_535
    ? { ok: true, value: port as RouteStubPort }
    : { ok: false, error: `route stub announced ${JSON.stringify(line)} instead of its TCP port (an integer in 1..65535)` };
}

/** A listening stub: the port it serves `/v1/models` on, and how to stop it. */
type RouteStub = Readonly<{ port: RouteStubPort; stop: () => void }>;

/**
 * Start the stub serving exactly `model` at `GET /v1/models`. Resolves once
 * it announces a valid port; rejects — with the stub stopped — when it exits,
 * closes its output, or announces anything else first.
 */
export function startRouteStub(model: string): Promise<RouteStub> {
  const child = spawn("bun", ["-e", ROUTE_STUB_SOURCE], {
    env: { ...process.env, STUB_MODEL: model },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = (): void => { child.kill(); };
  return new Promise<RouteStub>((resolve, reject) => {
    const refuse = (message: string): void => { stop(); reject(new Error(message)); };
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`route stub exited before listening (code ${code})`)));
    const lines = createInterface({ input: child.stdout });
    lines.once("close", () => refuse("route stub closed its output before announcing a port"));
    lines.once("line", (line) => {
      const port = parseRouteStubPort(line);
      if (!port.ok) return refuse(port.error);
      // The port is all a caller needs: release the stub's handles so they
      // cannot hold the event loop open; `stop` still ends it.
      resolve(Object.freeze({ port: port.value, stop }));
      lines.removeAllListeners("close");
      child.stdout.destroy();
      child.unref();
    });
  });
}
