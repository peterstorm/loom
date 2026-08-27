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
 *
 * mark-subagent-active.sh (fail-CLOSED authority binder):
 *   - runtime unavailable → exit 2 because only the engine may prove graph absence
 *   - ENOENT graph → engine passthrough; EACCES/ELOOP/ENOTDIR → engine block
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(__dirname, "../../../hooks/scripts");
const ENFORCE = join(SCRIPTS, "enforce-phase-tools.sh");
const RECORD = join(SCRIPTS, "record-evidence.sh");
const GUARD = join(SCRIPTS, "guard-state-file.sh");
const DISPATCH = join(SCRIPTS, "dispatch.sh");
const MARK = join(SCRIPTS, "mark-subagent-active.sh");
const CLEANUP = join(SCRIPTS, "cleanup-stale-subagents.sh");
const PLUGIN_ROOT = join(SCRIPTS, "..", "..");

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
  // CLAUDE_PROJECT_DIR is stripped too: graph presence must be under the
  // test's control, never inherited from the invoking session.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      k !== "CLAUDE_PLUGIN_ROOT" &&
      k !== "LOOM_SUBAGENT_DIR" &&
      k !== "LOOM_STATE_PATH" &&
      k !== "CLAUDE_PROJECT_DIR"
    )
      base[k] = v;
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

/** Resolve a binary the shim needs (ls, cat) via the CURRENT PATH. */
function resolveBin(name: string): string {
  const result = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" });
  const path = (result.stdout ?? "").trim();
  if (!path) throw new Error(`test setup: cannot resolve ${name}`);
  return path;
}

/**
 * A PATH containing ONLY the external binaries the shims use before their
 * bun check (ls, cat, bash) — `command -v bun` then genuinely fails,
 * simulating PATH drift that removed the runtime.
 */
function bunlessPath(): string {
  const bin = tempDir();
  for (const name of ["ls", "cat", "bash", "date"]) {
    symlinkSync(resolveBin(name), join(bin, name));
  }
  return bin;
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

  it("binding present + bun not found on PATH → exit 2 (runtime gone ≠ gate off)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(ENFORCE, {
      LOOM_SUBAGENT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin-root", // set, so only the bun check can fail
      PATH: bunlessPath(),
    });
    expect(stderr).toContain("bun not found");
    expect(status).toBe(2);
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

  it("binding present + CLAUDE_PLUGIN_ROOT unset → exit 0 WITH a 'runtime unavailable' note", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(RECORD, { LOOM_SUBAGENT_DIR: dir });
    expect(stderr).toContain("runtime unavailable");
    expect(stderr).toContain("evidence not recorded");
    expect(status).toBe(0); // fail-open recorder — but never silent
  });

  it("binding present + bun not found on PATH → exit 0 WITH a 'runtime unavailable' note", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(RECORD, {
      LOOM_SUBAGENT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin-root",
      PATH: bunlessPath(),
    });
    expect(stderr).toContain("runtime unavailable");
    expect(status).toBe(0);
  });
});

/** A CLAUDE_PROJECT_DIR with no task graph in it. */
function graphlessProjectDir(): string {
  return tempDir();
}

describe("guard-state-file.sh — runs on binding-without-graph, fails CLOSED on runtime drift", () => {
  it("no graph + no bindings → exit 0 fast path (no runtime needed at all)", () => {
    const { status, stderr } = runShim(GUARD, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: tempDir(), // empty: no *.machine anywhere
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("no graph + binding present + CLAUDE_PLUGIN_ROOT unset → exit 2 (the shim SPAWNS for bindings, and fails closed)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(GUARD, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: dir,
    });
    expect(stderr).toContain("CLAUDE_PLUGIN_ROOT unset");
    expect(status).toBe(2);
  });

  it("no graph + binding present + bun not found on PATH → exit 2 (runtime gone ≠ guard off)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(GUARD, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin-root",
      PATH: bunlessPath(),
    });
    expect(stderr).toContain("bun not found");
    expect(status).toBe(2);
  });
});

describe("mark-subagent-active.sh — engine-owned ENOENT-only graph decision", () => {
  it("proven absent graph → engine passthrough, quiet, and no session files", () => {
    const project = graphlessProjectDir();
    const subagents = tempDir();
    const { status, stderr } = runShim(MARK, {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      LOOM_STATE_PATH: join(project, "missing-task-graph.json"),
      LOOM_SUBAGENT_DIR: subagents,
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(readdirSync(subagents)).toEqual([]);
  });

  it("runtime unavailable blocks even when the graph may be absent", () => {
    const { status, stderr } = runShim(MARK, {
      LOOM_STATE_PATH: join(graphlessProjectDir(), "missing-task-graph.json"),
    });
    expect(stderr).toContain("TaskGraph absence");
    expect(stderr).toContain("refusing spawn");
    expect(status).toBe(2);
  });

  it("bun unavailable blocks before graph observation", () => {
    const { status, stderr } = runShim(MARK, {
      LOOM_STATE_PATH: join(graphlessProjectDir(), "missing-task-graph.json"),
      CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin-root",
      PATH: bunlessPath(),
    });
    expect(stderr).toContain("TaskGraph absence");
    expect(stderr).toContain("refusing spawn");
    expect(status).toBe(2);
  });

  it("ELOOP graph observation blocks", () => {
    const loop = join(tempDir(), "task-graph-loop");
    symlinkSync(loop, loop);
    const { status, stderr } = runShim(MARK, {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      LOOM_STATE_PATH: loop,
      LOOM_SUBAGENT_DIR: tempDir(),
    });
    expect(stderr).toMatch(/ELOOP|too many levels of symbolic links/i);
    expect(stderr).toContain("refusing spawn");
    expect(status).toBe(2);
  });

  it("ENOTDIR graph observation blocks", () => {
    const parent = join(tempDir(), "not-a-directory");
    writeFileSync(parent, "file");
    const { status, stderr } = runShim(MARK, {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      LOOM_STATE_PATH: join(parent, "active_task_graph.json"),
      LOOM_SUBAGENT_DIR: tempDir(),
    });
    expect(stderr).toMatch(/ENOTDIR|not a directory/i);
    expect(stderr).toContain("refusing spawn");
    expect(status).toBe(2);
  });

  it.skipIf(isRoot)("EACCES graph observation blocks", () => {
    const parent = tempDir();
    const graph = join(parent, "active_task_graph.json");
    writeFileSync(graph, "{}");
    chmodSync(parent, 0o000);
    const result = runShim(MARK, {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      LOOM_STATE_PATH: graph,
      LOOM_SUBAGENT_DIR: tempDir(),
    });
    chmodSync(parent, 0o700);
    expect(result.stderr).toMatch(/EACCES|permission denied/i);
    expect(result.stderr).toContain("refusing spawn");
    expect(result.status).toBe(2);
  });
});

describe("cleanup-stale-subagents.sh — fails OPEN loudly (SessionStart must never block)", () => {
  it("no graph + empty subagent dir → exit 0 fast path, quiet (nothing to sweep)", () => {
    const { status, stderr } = runShim(CLEANUP, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: tempDir(),
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("dir has entries + CLAUDE_PLUGIN_ROOT unset → exit 0 WITH a 'stale sweep skipped' note", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(CLEANUP, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: dir,
    });
    expect(stderr).toContain("stale sweep skipped");
    expect(status).toBe(0); // fail-open: SessionStart is never blocked — but never silent
  });

  it("dir has entries + bun not found on PATH → exit 0 WITH a 'stale sweep skipped' note", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(CLEANUP, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin-root",
      PATH: bunlessPath(),
    });
    expect(stderr).toContain("stale sweep skipped");
    expect(status).toBe(0);
  });
});

describe("dispatch.sh — runs on binding-without-graph, fails OPEN loudly on runtime drift", () => {
  it("no graph + no bindings → exit 0 skip, quiet", () => {
    const { status, stderr } = runShim(DISPATCH, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: tempDir(),
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("no graph + binding present + CLAUDE_PLUGIN_ROOT unset → exit 0 WITH a 'bindings may leak' note (proves the graph-missing skip no longer swallows cleanup)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(DISPATCH, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: dir,
    });
    expect(stderr).toContain("bindings may leak");
    expect(status).toBe(0);
  });

  it("no graph + binding present + bun not found on PATH → exit 0 WITH a 'bindings may leak' note", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "shim-test.machine"), "a-1\tcode-implementer-agent\t1\n");
    const { status, stderr } = runShim(DISPATCH, {
      CLAUDE_PROJECT_DIR: graphlessProjectDir(),
      LOOM_SUBAGENT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin-root",
      PATH: bunlessPath(),
    });
    expect(stderr).toContain("bindings may leak");
    expect(status).toBe(0);
  });
});
