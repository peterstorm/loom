/**
 * Top-level failure polarity of the CLI (cli.ts main().catch): exit 1 is
 * NON-blocking for PreToolUse hooks, so a crash outside the handler — here
 * a stdin read error, the same class as a dynamic-import failure — must
 * exit 2 (blocking) for the fail-closed gate route, and exit 1 everywhere
 * else. The crash is induced by handing the CLI a DIRECTORY as stdin:
 * reading it fails with EISDIR, rejecting the stdin promise before any
 * handler runs.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAIL_CLOSED_ROUTES, KNOWN_HANDLERS, failureExitCode } from "../../src/handler-routes";

const CLI_PATH = join(__dirname, "../../src/cli.ts");
const crashDir = mkdtempSync(join(tmpdir(), "loom-cli-crash-"));

afterAll(() => {
  rmSync(crashDir, { recursive: true, force: true });
});

/** Run the CLI with a directory as stdin — guarantees a crash outside the handler. */
function runWithCrashingStdin(args: string[]): { status: number | null; stderr: string } {
  const fd = openSync(crashDir, "r");
  try {
    const result = spawnSync("bun", [CLI_PATH, ...args], {
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { status: result.status, stderr: result.stderr ?? "" };
  } finally {
    closeSync(fd);
  }
}

describe("cli top-level failure polarity", () => {
  it("a crash on the fail-closed gate route exits 2 (blocking) — the gate never fails open", () => {
    const { status, stderr } = runWithCrashingStdin(["pre-tool-use", "enforce-phase-tools"]);
    expect(stderr).toContain("Hook error");
    expect(status).toBe(2);
  });

  it("the same crash on any other route keeps exit 1 (non-blocking)", () => {
    const { status, stderr } = runWithCrashingStdin(["subagent-stop", "cleanup-subagent-flag"]);
    expect(stderr).toContain("Hook error");
    expect(status).toBe(1);
  });
});

describe("failure polarity is route metadata (handler-routes.ts)", () => {
  it("failureExitCode derives the polarity from FAIL_CLOSED_ROUTES", () => {
    expect(failureExitCode("pre-tool-use", "enforce-phase-tools")).toBe(2);
    expect(failureExitCode("pre-tool-use", "guard-state-file")).toBe(2);
    expect(failureExitCode("pre-tool-use", "block-direct-edits")).toBe(2);
    expect(failureExitCode("pre-tool-use", "validate-task-execution")).toBe(2);
    expect(failureExitCode("pre-tool-use", "validate-phase-order")).toBe(2);
    expect(failureExitCode("pre-tool-use", "validate-template-substitution")).toBe(2);
    expect(failureExitCode("pre-tool-use", "validate-agent-model")).toBe(2);
    expect(failureExitCode("pre-tool-use", "validate-agent-skill")).toBe(2);
    expect(failureExitCode("subagent-stop", "cleanup-subagent-flag")).toBe(1);
    expect(failureExitCode("helper", "complete-wave-gate")).toBe(1);
    expect(failureExitCode(undefined, undefined)).toBe(1);
  });

  it("every fail-closed route is a real route in the routing table", () => {
    for (const route of FAIL_CLOSED_ROUTES) {
      const [hookType, handlerName] = route.split("/");
      expect(KNOWN_HANDLERS[hookType]?.has(handlerName), route).toBe(true);
    }
  });
});
