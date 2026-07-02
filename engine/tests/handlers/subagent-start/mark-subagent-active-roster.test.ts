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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SUBAGENT_DIR } from "../../../src/config";
import markActive from "../../../src/handlers/subagent-start/mark-subagent-active";

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
    for (const suffix of ["active", "machine", "task_graph", "evidence.jsonl", "cleanup"]) {
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

  it("control: a healthy roster arms the binding AND writes .task_graph", async () => {
    const s = session("ok");
    process.env.LOOM_STATE_PATH = statePath;
    const result = await markActive(start(s), []);
    expect(result.kind).toBe("passthrough");
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
  });
});
