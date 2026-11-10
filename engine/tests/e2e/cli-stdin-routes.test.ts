/**
 * Which CLI routes wait for stdin. Hook routes and the orchestration
 * operations that take input (start/submit/decide) read stdin to EOF; every
 * flags-only orchestration operation must not, or an inherited stdin that is
 * never closed hangs the command (observed: `orchestration abandon` blocked
 * for ten minutes under a parent shell whose stdin stayed open).
 *
 * The row-by-row agreement between the route predicates and each helper's
 * operation table lives in ONE suite at the handler-routes seam
 * (`architecture/handler-routes-operations.test.ts`). This file keeps what
 * only a real process can prove: a flags-only operation exits under an open
 * stdin.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_HANDLERS, routeConsumesStdin } from "../../src/handler-routes";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { aSeed } from "../security/fixtures";

const CLI_PATH = join(__dirname, "../../src/cli.ts");
const root = canonicalTempDir("loom-cli-stdin-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The real CLI, with `PI_CODING_AGENT` stripped so the runtime handshake gate
 *  does not answer for the route under test. */
const spawnCli = (args: readonly string[], stdin: "open" | string): ChildProcess => {
  const { PI_CODING_AGENT: _pi, ...inherited } = process.env;
  const child = spawn("bun", [CLI_PATH, ...args], {
    cwd: root,
    env: { ...inherited, LOOM_STATE_PATH: join(root, "absent", "active_task_graph.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (stdin !== "open") child.stdin?.end(stdin);
  // `open` deliberately never writes to or closes stdin: that is the parent
  // shell shape (a terminal, a pipe held by a supervisor) that hangs any route
  // which reads to EOF.
  return child;
};

const waitForExit = async (child: ChildProcess, timeoutMs: number): Promise<"exited" | "hung"> => {
  const outcome = await new Promise<"exited" | "hung">((resolve) => {
    const timer = setTimeout(() => resolve("hung"), timeoutMs);
    child.on("exit", () => { clearTimeout(timer); resolve("exited"); });
  });
  if (outcome === "hung") child.kill("SIGKILL");
  return outcome;
};

/** Everything the child prints on the named streams, in arrival order; read
 *  the getter once the child has exited. */
const collectOutput = (child: ChildProcess, streams: readonly ("stdout" | "stderr")[]): (() => string) => {
  let printed = "";
  for (const stream of streams) child[stream]?.on("data", (chunk: Buffer) => { printed += chunk.toString("utf8"); });
  return () => printed;
};

describe("routeConsumesStdin", () => {
  it("reads stdin only for the orchestration operations that take input", () => {
    for (const operation of ["start", "submit", "decide"]) {
      expect(routeConsumesStdin("helper", "orchestration", [operation]), operation).toBe(true);
    }
    for (const operation of ["status", "inspect", "brief", "abandon", "restart", "recover-orphan", "resume",
      "correlate", "complete", "remediate", "attest"]) {
      expect(routeConsumesStdin("helper", "orchestration", [operation]), operation).toBe(false);
    }
    expect(routeConsumesStdin("helper", "orchestration", [])).toBe(false);
  });

  it("keeps every other known route on stdin", () => {
    for (const [hookType, handlers] of Object.entries(KNOWN_HANDLERS)) {
      for (const handler of handlers) {
        // Both helpers are operation-dependent: stdin and skew follow a traits
        // table, pinned row by row at the handler-routes seam.
        if (hookType === "helper" && (handler === "orchestration" || handler === "security-audit")) continue;
        expect(routeConsumesStdin(hookType, handler, []), `${hookType}/${handler}`).toBe(true);
      }
    }
  });
});

describe("a flags-only operation with an inherited open stdin", () => {
  it("completes an orchestration status without waiting for an end of input that never arrives", async () => {
    const child = spawnCli(["helper", "orchestration", "status", "--json"], "open");
    expect(await waitForExit(child, 20_000)).toBe("exited");
  }, 30_000);

  it("completes a security-audit status against a real run directory", async () => {
    // The traits table says `status` reads no stdin; this proves it against the
    // real CLI rather than against the table that predicts it. Seeding uses
    // `start`, which DOES read stdin, so the run directory is produced by the
    // program itself rather than hand-written.
    const out = join(root, "security-run");
    const seeding = spawnCli(
      ["helper", "security-audit", "start", "--out", out, "--repo", root, "--source", "0".repeat(40)],
      JSON.stringify({ units: [aSeed()] }),
    );
    expect(await waitForExit(seeding, 20_000)).toBe("exited");
    expect(seeding.exitCode, "start must succeed before status proves anything").toBe(0);

    const child = spawnCli(["helper", "security-audit", "status", "--out", out], "open");
    const printed = collectOutput(child, ["stdout"]);
    expect(await waitForExit(child, 20_000)).toBe("exited");
    expect(child.exitCode).toBe(0);
    expect(printed()).toContain("coverage:");

    // `nonce` is flags-only too: with nothing in flight it refuses — and it
    // must REACH that refusal rather than wait on the open stdin.
    const nonce = spawnCli(
      ["helper", "security-audit", "nonce", "--out", out, "--artifact", "agents/security-hunter-agent/artifacts/repro.txt"],
      "open",
    );
    const refusal = collectOutput(nonce, ["stderr", "stdout"]);
    expect(await waitForExit(nonce, 20_000)).toBe("exited");
    expect(nonce.exitCode).not.toBe(0);
    expect(refusal()).toContain("no in_progress unit is owned by security-hunter-agent");
  }, 60_000);
});
