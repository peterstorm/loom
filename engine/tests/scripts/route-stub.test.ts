/**
 * The façade smoke's route stub (`scripts/route-stub.ts`): its port
 * announcement is parsed, so a malformed line fails the stub's start naming
 * that line rather than surfacing later as an opaque route-probe failure; it
 * serves exactly the path the engine's own route probe requests; and once it
 * is listening, an exit nobody asked for is reported naming the stub.
 *
 * The failure arms run real children through the harness seam: tiny scripted
 * `bun -e` sources stand in for the server, and a recording sink stands in
 * for stderr. A stopped child proves its stop by writing a marker on SIGTERM.
 */
import { existsSync, rmSync } from "node:fs";
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

/** A child that idles until stopped, and on SIGTERM writes `marker` before exiting. */
const idleUntilStopped = (marker: string): string =>
  `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "stopped"); process.exit(0); });\n` +
  "setInterval(() => {}, 1000);\n";

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

  it("fails the start on any event before the stub listened", () => {
    expect(routeStubVerdict({ kind: "starting" }, { kind: "exit", code: 7, signal: null }))
      .toEqual({ kind: "reject", error: new Error("route stub exited before listening (code 7)") });
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
    const stub = scripted(`process.stdout.write("listening\\n");\n${idleUntilStopped(marker)}`);
    await expect(startRouteStub("stub-model", stub.harness)).rejects.toThrow(refusal("listening"));
    await eventually(marker);
    expect(stub.reports).toEqual([]);
  });

  it("refuses a stub that closes its output before announcing a port, and stops it", async () => {
    const marker = markerPath();
    const stub = scripted(`require("node:fs").closeSync(1);\n${idleUntilStopped(marker)}`);
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
    const stub = scripted(`process.stdout.write("4243\\n");\n${idleUntilStopped(marker)}`);
    const started = await startRouteStub("stub-model", stub.harness);
    started.stop();
    await eventually(marker);
    // Let the exit event reach the parent before reading the sink.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.reports).toEqual([]);
  });
});
