/**
 * Failure polarity of the bash shims themselves, spawned for real:
 *
 * enforce-phase-tools.sh (fail-CLOSED gate):
 *   - existing-but-unreadable SUBAGENT_DIR → exit 2 (bindings may exist unseen)
 *   - binding present + CLAUDE_PLUGIN_ROOT unset → exit 2 (runtime gone ≠ gate off)
 *   - no bindings → exit 0 fast path, no bun spawn
 *
 * record-evidence.sh (fail-OPEN recorder — must never block):
 *   - existing-but-unreadable SUBAGENT_DIR → exit 0 WITH a stderr note
 *     (dropping evidence silently would be indistinguishable from "nothing ran")
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(__dirname, "../../../hooks/scripts");
const ENFORCE = join(SCRIPTS, "enforce-phase-tools.sh");
const RECORD = join(SCRIPTS, "record-evidence.sh");

// chmod 000 does not bar root — these tests are meaningless under uid 0.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-shim-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ShimResult {
  status: number | null;
  stderr: string;
}

function runShim(script: string, env: Record<string, string | undefined>): ShimResult {
  // Build the env explicitly so CLAUDE_PLUGIN_ROOT can be genuinely ABSENT,
  // not empty — the shim tests `-z`, but absence is the real-world drift.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CLAUDE_PLUGIN_ROOT" && k !== "LOOM_SUBAGENT_DIR") base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) base[k] = v;
  }
  const result = spawnSync("bash", [script], {
    env: base,
    input: JSON.stringify({ session_id: "shim-test", tool_name: "Write", tool_input: {} }),
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("enforce-phase-tools.sh — fail-closed branches", () => {
  it.skipIf(isRoot)("existing-but-unreadable SUBAGENT_DIR → exit 2", () => {
    const dir = tempDir();
    chmodSync(dir, 0o000);
    const { status, stderr } = runShim(ENFORCE, { LOOM_SUBAGENT_DIR: dir });
    expect(stderr).toContain("cannot read");
    expect(status).toBe(2);
  });

  it("binding present + CLAUDE_PLUGIN_ROOT unset → exit 2", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(ENFORCE, { LOOM_SUBAGENT_DIR: dir });
    expect(stderr).toContain("CLAUDE_PLUGIN_ROOT unset");
    expect(status).toBe(2);
  });

  it("no bindings → exit 0 fast path (no runtime needed at all)", () => {
    const dir = tempDir(); // empty: no *.machine anywhere
    const { status } = runShim(ENFORCE, { LOOM_SUBAGENT_DIR: dir });
    expect(status).toBe(0);
  });

  it("nonexistent SUBAGENT_DIR → exit 0 fast path (nothing was ever gated)", () => {
    const { status } = runShim(ENFORCE, { LOOM_SUBAGENT_DIR: join(tempDir(), "never-created") });
    expect(status).toBe(0);
  });
});

describe("record-evidence.sh — fail-open, never silent", () => {
  it.skipIf(isRoot)("existing-but-unreadable SUBAGENT_DIR → exit 0 WITH a stderr note", () => {
    const dir = tempDir();
    chmodSync(dir, 0o000);
    const { status, stderr } = runShim(RECORD, { LOOM_SUBAGENT_DIR: dir });
    expect(stderr).toContain("cannot read");
    expect(stderr).toContain("evidence not recorded");
    expect(status).toBe(0);
  });

  it("no bindings → exit 0 fast path, no note needed", () => {
    const dir = tempDir();
    const { status, stderr } = runShim(RECORD, { LOOM_SUBAGENT_DIR: dir });
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});
