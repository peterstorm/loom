import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERE, PILOT_2_PREREGISTRATION, REPO_ROOT } from "./pilot-test-fixtures";

/**
 * Shell-level behaviour of `scripts/run-model-calibration.ts --pilot/--decide`,
 * the CLI itself spawned: the explicit opt-in, and — against an unreachable
 * route — a blocked preflight recorded honestly (nothing dispatched, nothing
 * fabricated, decision incomplete, the workload corpus never loaded), the
 * never-overwrite refusal and the offline re-decision with its
 * preregistration-drift refusal; and — against a loopback server answering
 * 401 like the live vLLM — the engine's route probe recorded as an explicit
 * served-model-unverified fact, decided under pilot-2's per-route policy.
 *
 * Everything behind the script's ports is pinned at its own interface: the
 * retention rules and `recordWindow`'s wiring at the `WindowStore` and
 * `ArmDispatch` ports in pilot-retention.test.ts, the matched dispatch and
 * blinding against a fake route in pilot-window.test.ts, the rubric in
 * pilot-rubric.test.ts, and the live Pi adapter with its transcript
 * classification in pilot-dispatch.test.ts. What stays untested is only the
 * script's construction of the live adapters themselves (`piArmDispatch`,
 * `performance.now`, git's changed-path lookup), which needs a model route.
 */

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unreachablePreregistration(): Readonly<{ dir: string; prereg: string; window: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-gcd-pilot-"));
  temps.push(dir);
  const raw = JSON.parse(readFileSync(join(HERE, "preregistration.json"), "utf-8")) as { route: { baseUrl: string } };
  // Port 9 (discard) on loopback: refused immediately, never a model server.
  raw.route.baseUrl = "http://127.0.0.1:9/v1";
  const preregPath = join(dir, "preregistration.json");
  writeFileSync(preregPath, JSON.stringify(raw, null, 2));
  return { dir, prereg: preregPath, window: join(dir, "window") };
}

const run = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => spawnSync("bun", ["scripts/run-model-calibration.ts", ...args], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  env: { ...process.env, ...env },
  timeout: 60_000,
});

describe("run-model-calibration --pilot", () => {
  it("refuses to run without the explicit opt-in", () => {
    const fixture = unreachablePreregistration();
    const result = run(["--pilot", fixture.prereg, "--window-dir", fixture.window], { LOOM_RUN_MODEL_CALIBRATION: "" });
    expect(result.status).toBe(2);
    expect(existsSync(fixture.window)).toBe(false);
  });

  it("retains a blocked preflight honestly: no dispatch, no fabricated samples, decision incomplete", () => {
    const fixture = unreachablePreregistration();
    const result = run([
      "--pilot", fixture.prereg,
      "--fixtures", join(HERE, "workload-fixtures.json"),
      "--window-dir", fixture.window,
    ], { LOOM_RUN_MODEL_CALIBRATION: "1" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Release decision: incomplete-missing-measurement");

    const window = JSON.parse(readFileSync(join(fixture.window, "window.json"), "utf-8"));
    expect(window.preflight.kind).toBe("blocked");
    expect(window.preflight.blocks.map((block: { kind: string }) => block.kind)).toContain("route-unreachable");
    expect(window.dispatch.kind).toBe("not-attempted");
    expect(window.observations).toBe(0);
    expect(Date.parse(window.endedAt)).not.toBeNaN();
    expect(window.preflightFacts.stagedRuntimeRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(join(fixture.window, "observations.jsonl"))).toBe(false);

    const decision = JSON.parse(readFileSync(join(fixture.window, "release-decision.json"), "utf-8"));
    expect(decision.decision.kind).toBe("incomplete-missing-measurement");
    expect(decision.decision.missing.map((missing: { kind: string }) => missing.kind)).toEqual(
      expect.arrayContaining(["preflight-blocked", "no-qualified-capable-route", "cell-not-measured"]));
    expect(decision.cells.map((cell: { kind: string }) => cell.kind)).toEqual(["not-measured", "not-measured", "not-measured", "not-measured"]);
    expect(decision.preregistration.path).not.toMatch(/^\//);
  });

  it("retains a blocked window even when the workload corpus cannot be read (it is loaded only to dispatch)", () => {
    const fixture = unreachablePreregistration();
    const fixtures = JSON.parse(readFileSync(join(HERE, "workload-fixtures.json"), "utf-8")) as { reviewer: { corpus: string } };
    fixtures.reviewer.corpus = "calibration/grammar-constrained-decoding/no-such-corpus.json";
    const fixturesPath = join(fixture.dir, "workload-fixtures.json");
    writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2));
    const result = run(["--pilot", fixture.prereg, "--fixtures", fixturesPath, "--window-dir", fixture.window], { LOOM_RUN_MODEL_CALIBRATION: "1" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Release decision: incomplete-missing-measurement");
    const window = JSON.parse(readFileSync(join(fixture.window, "window.json"), "utf-8"));
    expect(window.preflight.kind).toBe("blocked");
    expect(window.dispatch.kind).toBe("not-attempted");
    expect(window.observations).toBe(0);
    expect(existsSync(join(fixture.window, "release-decision.json"))).toBe(true);
  });

  it("never overwrites a retained window", () => {
    const fixture = unreachablePreregistration();
    const args = ["--pilot", fixture.prereg, "--fixtures", join(HERE, "workload-fixtures.json"), "--window-dir", fixture.window];
    expect(run(args, { LOOM_RUN_MODEL_CALIBRATION: "1" }).status).toBe(1);
    const second = run(args, { LOOM_RUN_MODEL_CALIBRATION: "1" });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/error: window \S+ already exists; a retained window is never overwritten/i);
    expect(JSON.parse(readFileSync(join(fixture.window, "window.json"), "utf-8")).dispatch.kind).toBe("not-attempted");
  });

  it("re-decides a retained window offline, retaining an --assessment, and refuses a preregistration changed after the window", () => {
    const fixture = unreachablePreregistration();
    run(["--pilot", fixture.prereg, "--fixtures", join(HERE, "workload-fixtures.json"), "--window-dir", fixture.window], { LOOM_RUN_MODEL_CALIBRATION: "1" });
    const external = join(fixture.dir, "human-blind-1.json");
    const assessment = JSON.stringify({ schemaVersion: 1, assessorId: "human-blind-1", method: "independent blinded review", blinded: true, entries: [] }, null, 2);
    writeFileSync(external, assessment);
    const redecided = run(["--decide", fixture.window, "--assessment", external], { LOOM_RUN_MODEL_CALIBRATION: "" });
    expect(redecided.status, redecided.stderr).toBe(1);
    expect(redecided.stderr).toContain("Release decision: incomplete-missing-measurement");
    expect(readFileSync(join(fixture.window, "assessments", "human-blind-1.json"), "utf-8")).toBe(assessment);
    expect(readFileSync(join(fixture.window, "decision-log.jsonl"), "utf-8").trim().split("\n")).toHaveLength(2);

    writeFileSync(fixture.prereg, readFileSync(fixture.prereg, "utf-8").replace("gcd-ad11-pilot-1", "gcd-ad11-pilot-edited"));
    const tampered = run(["--decide", fixture.window]);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain("changed after window");
  });
});

/**
 * A loopback model server that refuses every unauthenticated request with
 * HTTP 401, like the live vLLM. It runs in its OWN process: the CLI is spawned
 * synchronously, which blocks this test's event loop, so a server living in
 * it could never answer. A request carrying an Authorization header would be
 * answered with a model listing instead, so a leaked credential shows up as a
 * served list rather than the served-model-unverified fact an auth refusal
 * records.
 */
const AUTH_REFUSING_SERVER = `
const server = require("node:http").createServer((request, response) => {
  const listing = request.headers.authorization !== undefined;
  response.writeHead(listing ? 200 : 401, { "content-type": "application/json" });
  response.end(JSON.stringify(listing ? { data: [{ id: "credential-leaked" }] } : { error: "unauthorized" }));
});
server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
`;

async function authRefusingServer(): Promise<Readonly<{ baseUrl: string; stop: () => void }>> {
  const child = spawn(process.execPath, ["-e", AUTH_REFUSING_SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolvePort, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`auth-refusing server exited with ${code}`)));
    child.stdout.once("data", (chunk: Buffer) => resolvePort(chunk.toString("utf-8").trim()));
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, stop: () => child.kill() };
}

describe("run-model-calibration --pilot (pilot-2, route answering 401)", () => {
  it("records an auth refusal as served-model-unverified, and decides under the per-route policy", async () => {
    const server = await authRefusingServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), "loom-gcd-pilot2-"));
      temps.push(dir);
      const raw = JSON.parse(readFileSync(join(HERE, PILOT_2_PREREGISTRATION), "utf-8")) as { route: { baseUrl: string } };
      raw.route.baseUrl = server.baseUrl;
      const prereg = join(dir, PILOT_2_PREREGISTRATION);
      writeFileSync(prereg, JSON.stringify(raw, null, 2));
      const windowDir = join(dir, "window");
      const result = run([
        "--pilot", prereg, "--preflight-only",
        "--fixtures", join(HERE, "workload-fixtures.json"),
        "--window-dir", windowDir,
      ], { LOOM_RUN_MODEL_CALIBRATION: "1" });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Release decision: incomplete-missing-measurement");

      const window = JSON.parse(readFileSync(join(windowDir, "window.json"), "utf-8"));
      expect(window.preflightFacts.route).toEqual({
        kind: "served-model-unverified",
        reason: `GET ${server.baseUrl}/models answered HTTP 401: the model list needs credentials Loom never sends`,
      });
      const blocks = window.preflight.kind === "blocked" ? window.preflight.blocks.map((block: { kind: string }) => block.kind) : [];
      expect(blocks).not.toContain("route-unreachable");
      expect(blocks).not.toContain("served-model-absent");
      expect(window.dispatch.kind).toBe("not-attempted");
      expect(window.observations).toBe(0);

      const decision = JSON.parse(readFileSync(join(windowDir, "release-decision.json"), "utf-8"));
      expect(decision.preregistration.id).toBe("gcd-ad11-pilot-2");
      const missing = decision.decision.missing.map((entry: { kind: string }) => entry.kind);
      expect(missing).toContain("cell-not-measured");
      expect(missing).not.toContain("no-qualified-capable-route");
    } finally {
      server.stop();
    }
  });
});
