/**
 * Roster failure handling in mark-subagent-active: a markAgentActive
 * lock/fs failure means the agent is OFF the roster — soleActiveBinding
 * would then cross-credit its tool calls into any armed binding. The
 * handler must (a) say so on stderr, (b) SKIP the machine bind (an unsound
 * roster must not coexist with an armed binding), and (c) STILL write the
 * .task_graph path — SubagentStop needs it regardless.
 *
 * SUBAGENT_DIR freezes at first config import, so this suite uses the
 * shared dir with unique session ids (the pattern every other suite uses).
 * The task-graph path and machines dir are read at CALL time by the
 * handler, so per-test env re-pointing works without a module reload.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SUBAGENT_DIR } from "../../../src/config";
import { shouldBlockDirectEdit } from "../../../src/core/block-direct-edits";
import { activeRosterProbe } from "../../../src/handlers/pre-tool-use/block-direct-edits";
import markActive from "../../../src/handlers/subagent-start/mark-subagent-active";
import { parseSessionId } from "../../../src/machine";

const uniq = `roster-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const stateDir = mkdtempSync(join(tmpdir(), "loom-roster-state-"));
const statePath = join(stateDir, "active_task_graph.json");
writeFileSync(statePath, "{}");

const sessions: string[] = [];
const session = (label: string) => {
  const s = `${uniq}-${label}`;
  sessions.push(s);
  return s;
};

afterAll(() => {
  delete process.env.LOOM_STATE_PATH;
  for (const s of sessions) {
    for (const suffix of ["active", "active.tmp", "machine", "task_graph", "evidence.jsonl", "cleanup"]) {
      rmSync(join(SUBAGENT_DIR, `${s}.${suffix}`), { recursive: true, force: true });
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
});

const start = (s: string, agentId = "a-1", agentType = "loom:code-implementer-agent") =>
  JSON.stringify({ session_id: s, agent_id: agentId, agent_type: agentType });

describe("mark-subagent-active — roster failure is contained, never silent", () => {
  it("roster write failure: loud stderr, machine NOT bound, .task_graph still written", async () => {
    const s = session("fail");
    process.env.LOOM_STATE_PATH = statePath;
    // A DIRECTORY at the .active path makes markAgentActive's append throw.
    mkdirSync(join(SUBAGENT_DIR, `${s}.active`), { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s), []);
      expect(result.kind).toBe("passthrough");

      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("roster update failed");
      expect(text).toContain("refusing to arm machine binding");
    } finally {
      stderrSpy.mockRestore();
    }

    // (b) unsound roster ⇒ no armed binding…
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(false);
    // (c) …but the .task_graph path write still happened.
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
    expect(readFileSync(join(SUBAGENT_DIR, `${s}.task_graph`), "utf-8")).toBe(resolve(statePath));
  });

  it("machine binding failure blocks the Agent after writing .task_graph", async () => {
    const s = session("bind-fail");
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(join(SUBAGENT_DIR, `${s}.machine`), { recursive: true });

    const result = await markActive(start(s), []);

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("bindMachineAgent failed");
      expect(result.message).toContain("refusing to run code-implementer-agent (a-1) ungated");
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
    expect(readFileSync(join(SUBAGENT_DIR, `${s}.task_graph`), "utf-8")).toBe(resolve(statePath));

    const parsedSession = parseSessionId(s);
    expect(parsedSession).not.toBeNull();
    if (parsedSession === null) return;
    expect(activeRosterProbe(parsedSession)).toBeNull();
    expect(shouldBlockDirectEdit("Edit", s, () => true, activeRosterProbe).kind).toBe("block");
  });

  it("reports an unproven rollback when strict roster removal itself fails", async () => {
    const s = session("rollback-fail");
    process.env.LOOM_STATE_PATH = statePath;
    const activePath = join(SUBAGENT_DIR, `${s}.active`);
    writeFileSync(activePath, "reviewer-1\tcode-reviewer\n");
    // A second surviving row makes rollback use the atomic rewrite path. Its
    // deterministic temporary slot is a directory, so strict removal cannot
    // prove the denied implementation Agent's role-bearing row was removed.
    mkdirSync(`${activePath}.tmp`);
    mkdirSync(join(SUBAGENT_DIR, `${s}.machine`));

    const result = await markActive(start(s), []);

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("bindMachineAgent failed");
      expect(result.message).toContain("active-roster rollback could not be proven");
      expect(result.message).toContain("EISDIR");
    }
    expect(readFileSync(activePath, "utf8")).toContain("a-1\tcode-implementer-agent");

    const parsedSession = parseSessionId(s);
    expect(parsedSession).not.toBeNull();
    if (parsedSession === null) return;
    expect(activeRosterProbe(parsedSession)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentType: "code-implementer-agent" }),
    ]));
    // This is why the failed rollback is security-sensitive: the ghost row is
    // still interpreted as an active implementation-role write authority.
    expect(shouldBlockDirectEdit("Edit", s, () => true, activeRosterProbe).kind).toBe("allow");
  });

  it("an inaccessible Task Graph still writes the fail-closed cross-repo pointer", async () => {
    const s = session("graph-eloop");
    const loop = join(stateDir, "graph-loop");
    symlinkSync(loop, loop);
    process.env.LOOM_STATE_PATH = loop;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s), []);
      expect(result.kind).toBe("passthrough");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(readFileSync(join(SUBAGENT_DIR, `${s}.task_graph`), "utf-8")).toBe(resolve(loop));
  });

  it("reports an unreadable stored task_graph pointer before attempting repair", async () => {
    const s = session("pointer-eloop");
    const pointer = join(SUBAGENT_DIR, `${s}.task_graph`);
    process.env.LOOM_STATE_PATH = statePath;
    symlinkSync(pointer, pointer);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s), []);
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
      expect(text).toContain(`cannot read task_graph pointer ${pointer}`);
      expect(text).toContain("attempting rewrite");
      expect(text).toMatch(/ELOOP|too many levels of symbolic links/i);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("control: a healthy roster arms the binding AND writes .task_graph", async () => {
    const s = session("ok");
    process.env.LOOM_STATE_PATH = statePath;
    const result = await markActive(start(s), []);
    expect(result.kind).toBe("passthrough");
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
  });

  it("an unparseable (traversal) session_id refuses ALL session-file writes, loudly", async () => {
    process.env.LOOM_STATE_PATH = statePath;
    const evil = "../mark-active-escape";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(evil), []);
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("invalid session_id");
      expect(text).toContain("task_graph pointer not written");
    } finally {
      stderrSpy.mockRestore();
    }
    // The traversal path was never created — neither inside nor above the dir.
    expect(existsSync(join(SUBAGENT_DIR, `${evil}.task_graph`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${evil}.active`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${evil}.machine`))).toBe(false);
  });

  it("an unparseable agent_type (path traversal) never reaches loadMachine — no bind, loud stderr", async () => {
    const s = session("evil-type");
    process.env.LOOM_STATE_PATH = statePath;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s, "a-1", "../../outside/evil-agent"), []);
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("path-unsafe characters");
      expect(text).toContain("UNGATED");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(false);
    // Roster + task_graph writes still happen — only the machine bind refuses.
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
  });
});
