/**
 * The façade smoke's stand-in for the local Pi route (ADR-0023). A Pi
 * parent's spawn batches pass the route gate, which probes
 * `GET {baseUrl}/models`; the smoke points Pi's models.json at this stub's
 * `baseUrl` so no vLLM host has to be reachable. The one path the stub serves
 * is derived from the engine's own probe URL rule (`modelsUrl`), so the stub
 * and the probe cannot drift apart. It runs in a separate process because
 * every CLI call the smoke makes is a blocking spawnSync, which an in-process
 * server could never answer.
 *
 * The stub announces the port it bound as its first stdout line. That line is
 * parsed, not trusted: anything but a TCP port stops the stub and fails its
 * start naming the line, instead of a NaN port surfacing later as an opaque
 * route-probe failure. Once it is listening, an exit or error the caller did
 * not ask for is reported on stderr naming the stub, never swallowed.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { modelsUrl } from "../engine/src/core/route-reachability";

const ROUTE_STUB_HOST = "127.0.0.1";
/** The base path the stub's `baseUrl` names: the OpenAI-style prefix a vLLM route serves under. */
const ROUTE_STUB_BASE_PATH = "/v1";

/** The one path the stub serves: what the engine's route probe requests under the stub's base path. */
const SERVED_PATH = new URL(modelsUrl({ provider: "route-stub", baseUrl: `http://${ROUTE_STUB_HOST}${ROUTE_STUB_BASE_PATH}` })).pathname;

const ROUTE_STUB_SOURCE = `
const served = JSON.stringify({ object: "list", data: [{ id: process.env.STUB_MODEL, object: "model" }] });
const server = Bun.serve({
  hostname: process.env.STUB_HOST,
  port: 0,
  fetch: (request) => new URL(request.url).pathname === process.env.STUB_PATH
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
  // The pattern admits only canonical decimal integers of at least 1, so the
  // one bound left to check is the top of the TCP range.
  const valid = /^[1-9][0-9]{0,4}$/.test(line) && Number(line) <= 65_535;
  return valid
    ? { ok: true, value: Number(line) as RouteStubPort }
    : { ok: false, error: `route stub announced ${JSON.stringify(line)} instead of its TCP port (an integer in 1..65535)` };
}

/** Where a stub's life is: starting until it announces a port, listening on
 *  that port, or stopping once its caller (or a refused start) ended it. */
export type RouteStubPhase =
  | Readonly<{ kind: "starting" }>
  | Readonly<{ kind: "listening"; port: RouteStubPort }>
  | Readonly<{ kind: "stopping" }>;

/** What the stub's process reported. */
export type RouteStubEvent =
  | Readonly<{ kind: "exit"; code: number | null; signal: NodeJS.Signals | null }>
  | Readonly<{ kind: "error"; error: Error }>;

/** What the shell does with an event: fail the start, report it, or nothing (an asked-for stop). */
export type RouteStubVerdict =
  | Readonly<{ kind: "reject"; error: Error }>
  | Readonly<{ kind: "report"; line: string }>
  | Readonly<{ kind: "expected" }>;

const ending = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal === null ? `code ${code}` : `signal ${signal}`;

/** Decide one process event in one phase. Pure: an event while starting fails
 *  the start; an exit while stopping is the stop itself; everything else — an
 *  exit while listening, any error after the start — is reported. */
export function routeStubVerdict(phase: RouteStubPhase, event: RouteStubEvent): RouteStubVerdict {
  if (phase.kind === "starting") {
    return event.kind === "error"
      ? { kind: "reject", error: event.error }
      : { kind: "reject", error: new Error(`route stub exited before listening (${ending(event.code, event.signal)})`) };
  }
  if (event.kind === "exit") {
    return phase.kind === "stopping"
      ? { kind: "expected" }
      : { kind: "report", line: `route stub on port ${phase.port} exited unexpectedly (${ending(event.code, event.signal)}); route probes against it will now fail` };
  }
  const where = phase.kind === "listening" ? `on port ${phase.port}` : "while stopping";
  return { kind: "report", line: `route stub ${where} failed: ${event.error.message}` };
}

/** A listening stub: its port, the `baseUrl` a Pi models.json names for it, and how to stop it. */
type RouteStub = Readonly<{ port: RouteStubPort; baseUrl: string; stop: () => void }>;

/** The stub's process source and where its after-start reports go. Production
 *  runs the real server and reports on stderr; tests substitute scripted
 *  children and a recording sink. */
export type RouteStubHarness = Readonly<{ source: string; report: (line: string) => void }>;

const PRODUCTION_HARNESS: RouteStubHarness = Object.freeze({
  source: ROUTE_STUB_SOURCE,
  report: (line: string) => { process.stderr.write(`${line}\n`); },
});

/**
 * Start the stub serving exactly `model` at the engine's probe path. Resolves
 * once it announces a valid port; rejects — with the stub stopped — when it
 * exits, closes its output, or announces anything else first.
 */
export function startRouteStub(model: string, harness: RouteStubHarness = PRODUCTION_HARNESS): Promise<RouteStub> {
  const child = spawn("bun", ["-e", harness.source], {
    env: { ...process.env, STUB_MODEL: model, STUB_HOST: ROUTE_STUB_HOST, STUB_PATH: SERVED_PATH },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let phase: RouteStubPhase = { kind: "starting" };
  const stop = (): void => {
    phase = { kind: "stopping" };
    child.kill();
  };
  return new Promise<RouteStub>((resolve, reject) => {
    const decide = (event: RouteStubEvent): void => {
      const verdict = routeStubVerdict(phase, event);
      if (verdict.kind === "reject") reject(verdict.error);
      else if (verdict.kind === "report") harness.report(verdict.line);
    };
    const refuse = (message: string): void => { stop(); reject(new Error(message)); };
    child.on("error", (error) => decide({ kind: "error", error }));
    child.once("exit", (code, signal) => decide({ kind: "exit", code, signal }));
    const lines = createInterface({ input: child.stdout });
    lines.once("close", () => refuse("route stub closed its output before announcing a port"));
    lines.once("line", (line) => {
      const port = parseRouteStubPort(line);
      if (!port.ok) return refuse(port.error);
      phase = { kind: "listening", port: port.value };
      resolve(Object.freeze({ port: port.value, baseUrl: `http://${ROUTE_STUB_HOST}:${port.value}${ROUTE_STUB_BASE_PATH}`, stop }));
      // The port is all a caller needs: release the stub's handles so they
      // cannot hold the event loop open; `stop` still ends it.
      lines.removeAllListeners("close");
      child.stdout.destroy();
      child.unref();
    });
  });
}
