/**
 * Passthrough-when-ungated coverage for the PreToolUse gate.
 *
 * The malformed-stdin and missing-identity policies fail closed only while a
 * gate is actually armed; with NO binding anywhere they must pass through, or
 * a harness format change would brick every ungated session (the comment at
 * enforce-phase-tools.ts:48 names exactly this). `anyBindingExists()` reads
 * the process-global SUBAGENT_DIR, so this must run hermetically: a subprocess
 * with LOOM_SUBAGENT_DIR pointed at a fresh EMPTY dir, invoked through the CLI
 * exactly as the shim does — not in-process, where a concurrent test file's
 * binding on the shared /tmp dir would flip the result.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh, empty SUBAGENT_DIR — exists, but holds no *.machine binding. */
function emptySubagentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-gate-ungated-"));
  dirs.push(d);
  return d;
}

function runGate(stdin: string): { status: number | null; stderr: string } {
  const dir = emptySubagentDir();
  const result = spawnSync("bun", [CLI_PATH, "pre-tool-use", "enforce-phase-tools"], {
    input: stdin,
    env: { ...process.env, LOOM_SUBAGENT_DIR: dir },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("PreToolUse gate passes through when no session is gated", () => {
  it("malformed stdin + no binding → passthrough (exit 0, never blocks)", () => {
    const { status, stderr } = runGate("this is not json");
    expect(status).toBe(0);
    expect(stderr).not.toContain("failing closed");
  });

  it("well-formed JSON missing session_id/tool_name + no binding → passthrough (exit 0)", () => {
    const { status, stderr } = runGate(JSON.stringify({ tool_input: {} }));
    expect(status).toBe(0);
    expect(stderr).not.toContain("failing closed");
  });
});
