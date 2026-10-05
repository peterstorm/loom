/**
 * Which CLI routes wait for stdin. Hook routes and the orchestration
 * operations that take input (start/submit/decide) read stdin to EOF; every
 * flags-only orchestration operation must not, or an inherited stdin that is
 * never closed hangs the command (observed: `orchestration abandon` blocked
 * for ten minutes under a parent shell whose stdin stayed open).
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_HANDLERS, routeConsumesStdin } from "../../src/handler-routes";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const CLI_PATH = join(__dirname, "../../src/cli.ts");
const root = canonicalTempDir("loom-cli-stdin-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
        if (hookType === "helper" && handler === "orchestration") continue;
        expect(routeConsumesStdin(hookType, handler, []), `${hookType}/${handler}`).toBe(true);
      }
    }
  });
});

describe("a flags-only orchestration operation with an inherited open stdin", () => {
  it("completes without waiting for an end of input that never arrives", async () => {
    const { PI_CODING_AGENT: _pi, ...inherited } = process.env;
    const env = { ...inherited, LOOM_STATE_PATH: join(root, "absent", "active_task_graph.json") };
    const child = spawn("bun", [CLI_PATH, "helper", "orchestration", "status", "--json"], {
      cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
    });
    // stdin is deliberately never written to or closed.
    const outcome = await new Promise<"exited" | "hung">((resolve) => {
      const timer = setTimeout(() => resolve("hung"), 20_000);
      child.on("exit", () => { clearTimeout(timer); resolve("exited"); });
    });
    if (outcome === "hung") child.kill("SIGKILL");
    expect(outcome).toBe("exited");
  }, 30_000);
});
