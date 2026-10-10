/**
 * The façade smoke's route stub (`scripts/route-stub.ts`): its port
 * announcement is parsed, so a malformed line fails the stub's start naming
 * that line rather than surfacing later as an opaque route-probe failure; it
 * serves exactly the path the engine's own route probe requests; and once it
 * is listening, an exit nobody asked for is reported naming the stub.
 *
 * The failure arms run real children through the harness seam: tiny scripted
 * `bun -e` sources stand in for the server, and a recording sink stands in
 * for stderr. A stopped child proves its stop by writing its pid to a marker
 * on SIGTERM, so a test can also wait until that process is gone.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { modelsUrl } from "../../src/core/route-reachability";
import {
  parseRouteStubPort,
  routeStubVerdict,
  startRouteStub,
  type RouteStubHarness,
  type RouteStubPhase,
} from "../../../scripts/route-stub";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const refusal = (line: string): string =>
  `route stub announced ${JSON.stringify(line)} instead of its TCP port (an integer in 1..65535)`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A child that on SIGTERM writes its pid to `marker` before exiting, then runs `body`
 * and idles until stopped. The handler is installed before `body` runs: the
 * parent stops the child as soon as `body`'s output reaches it, so a handler
 * installed after that output races the stop, and a lost race kills the
 * child by default action with its marker unwritten.
 */
const untilStopped = (marker: string, body: string): string =>
  `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.exit(0); });\n` +
  `${body}\nsetInterval(() => {}, 1000);\n`;

/**
 * Close the child's stdout while it stays alive. `fs.closeSync(1)` cannot:
 * on bun 1.3.13 it is a silent no-op that leaves fd 1 naming the
 * pipe. libc's own close(2) closes it on every bun, and a failed close throws,
 * so the start fails as an exit instead of hanging.
 */
const CLOSE_STDOUT =
  'const libc = require("bun:ffi").dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { close: { args: ["i32"], returns: "i32" } });\n' +
  'if (libc.symbols.close(1) !== 0) throw new Error("close(1) failed");';

/** A harness running `source`, recording every after-start report. */
function scripted(source: string): Readonly<{ harness: RouteStubHarness; reports: readonly string[]; reported: Promise<string> }> {
  const reports: string[] = [];
  let first: (line: string) => void = () => undefined;
  const reported = new Promise<string>((resolve) => { first = resolve; });
  return {
    reports,
    reported,
    harness: { source, report: (line) => { reports.push(line); first(line); } },
  };
}

/** Resolve once `path` exists, or fail after `timeoutMs`. */
async function eventually(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Resolve once the stopped child whose pid `marker` names has been reaped, or
 * fail after `timeoutMs`. The parent reaps its child and emits the child's
 * `exit` in the same event-loop step, so once the pid is gone the stub has
 * already decided that exit: whatever the sink holds then is final.
 */
async function reaped(marker: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const alive = (): boolean => {
    const pid = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (!/^[1-9][0-9]*$/.test(pid)) return true;
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  while (alive()) {
    if (Date.now() > deadline) throw new Error(`the child named by ${marker} was never reaped`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function markerPath(): string {
  const dir = canonicalTempDir("loom-route-stub-");
  dirs.push(dir);
  return join(dir, "stopped");
}

describe("parseRouteStubPort", () => {
  it("admits exactly the TCP ports 1..65535, as the stub prints them (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 65_535 }), (port) => {
      expect(parseRouteStubPort(String(port))).toEqual({ ok: true, value: port });
    }));
  });

  it.each(["", "NaN", "0", "65536", "99999", "-1", "+80", "080", "80.0", "8e3", " 80", "80 ", "80\r", "0x50", "listening on 80"])(
    "refuses %j, naming the line it got",
    (line) => {
      expect(parseRouteStubPort(line)).toEqual({ ok: false, error: refusal(line) });
    },
  );

  it("refuses every line that is not a canonical decimal port (property)", () => {
    fc.assert(fc.property(fc.string(), (line) => {
      const canonical = /^[1-9][0-9]*$/.test(line) && Number(line) <= 65_535;
      expect(parseRouteStubPort(line).ok).toBe(canonical);
    }));
  });
});

describe("routeStubVerdict", () => {
  const port = (() => {
    const parsed = parseRouteStubPort("4242");
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  })();
  const listening: RouteStubPhase = { kind: "listening", port };
  const crash = new Error("spawn bun EACCES");

  it("fails the start on any event before the stub listened, naming how an exit ended", () => {
    expect(routeStubVerdict({ kind: "starting" }, { kind: "exit", code: 7, signal: null }))
      .toEqual({ kind: "reject", error: new Error("route stub exited before listening (code 7)") });
    expect(routeStubVerdict({ kind: "starting" }, { kind: "exit", code: null, signal: "SIGKILL" }))
      .toEqual({ kind: "reject", error: new Error("route stub exited before listening (signal SIGKILL)") });
    expect(routeStubVerdict({ kind: "starting" }, { kind: "error", error: crash })).toEqual({ kind: "reject", error: crash });
  });

  it("reports an exit nobody asked for once the stub listened, naming the stub and how it ended", () => {
    expect(routeStubVerdict(listening, { kind: "exit", code: 3, signal: null })).toEqual({
      kind: "report",
      line: "route stub on port 4242 exited unexpectedly (code 3); route probes against it will now fail",
    });
    expect(routeStubVerdict(listening, { kind: "exit", code: null, signal: "SIGKILL" })).toEqual({
      kind: "report",
      line: "route stub on port 4242 exited unexpectedly (signal SIGKILL); route probes against it will now fail",
    });
  });

  it("treats the exit a stop asked for as expected, and reports every error after the start", () => {
    expect(routeStubVerdict({ kind: "stopping" }, { kind: "exit", code: null, signal: "SIGTERM" })).toEqual({ kind: "expected" });
    expect(routeStubVerdict(listening, { kind: "error", error: crash }))
      .toEqual({ kind: "report", line: "route stub on port 4242 failed: spawn bun EACCES" });
    expect(routeStubVerdict({ kind: "stopping" }, { kind: "error", error: crash }))
      .toEqual({ kind: "report", line: "route stub while stopping failed: spawn bun EACCES" });
  });
});

describe("startRouteStub", () => {
  it("serves exactly the named model at the engine's probe URL for its baseUrl, until stopped", async () => {
    const stub = await startRouteStub("stub-model");
    try {
      expect(parseRouteStubPort(String(stub.port)).ok).toBe(true);
      expect(stub.baseUrl).toBe(`http://127.0.0.1:${stub.port}/v1`);
      const listed = await fetch(modelsUrl({ provider: "stub", baseUrl: stub.baseUrl }));
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ object: "list", data: [{ id: "stub-model", object: "model" }] });
      expect((await fetch(`http://127.0.0.1:${stub.port}/elsewhere`)).status).toBe(404);
    } finally {
      stub.stop();
    }
  });

  it("refuses a malformed announcement, naming the line, and stops the stub", async () => {
    const marker = markerPath();
    const stub = scripted(untilStopped(marker, 'process.stdout.write("listening\\n");'));
    await expect(startRouteStub("stub-model", stub.harness)).rejects.toThrow(refusal("listening"));
    await eventually(marker);
    expect(stub.reports).toEqual([]);
  });

  it("refuses a stub that closes its output before announcing a port, and stops it", async () => {
    const marker = markerPath();
    const stub = scripted(untilStopped(marker, CLOSE_STDOUT));
    await expect(startRouteStub("stub-model", stub.harness)).rejects.toThrow("route stub closed its output before announcing a port");
    await eventually(marker);
    expect(stub.reports).toEqual([]);
  });

  it("refuses a stub that exits before announcing a port", async () => {
    // The exit and the end of its output race: whichever the parent sees
    // first fails the start, and neither may resolve it.
    const stub = scripted("process.exit(7);\n");
    await expect(startRouteStub("stub-model", stub.harness))
      .rejects.toThrow(/^route stub (exited before listening \(code 7\)|closed its output before announcing a port)$/);
    expect(stub.reports).toEqual([]);
  });

  it("reports a stub that exits after it announced its port, naming the stub, instead of swallowing it", async () => {
    const stub = scripted('process.stdout.write("4242\\n");\nsetTimeout(() => process.exit(3), 50);\n');
    const started = await startRouteStub("stub-model", stub.harness);
    expect(started.port).toBe(4242);
    expect(await stub.reported).toBe("route stub on port 4242 exited unexpectedly (code 3); route probes against it will now fail");
    started.stop();
  });

  it("does not report the exit its own stop caused", async () => {
    const marker = markerPath();
    const stub = scripted(untilStopped(marker, 'process.stdout.write("4243\\n");'));
    const started = await startRouteStub("stub-model", stub.harness);
    started.stop();
    // Wait for the stop's exit itself to reach the stub, not a fixed sleep:
    // an assertion before that point would pass however the exit was decided.
    await reaped(marker);
    expect(stub.reports).toEqual([]);
  });
});
