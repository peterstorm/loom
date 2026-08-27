/**
 * Handler-level e2e: SubagentStart binding → PostToolUse evidence →
 * PreToolUse gating, through the real hook handlers with stdin JSON.
 *
 * Isolation via unique session ids + targeted cleanup (SUBAGENT_DIR is
 * process-global).
 */

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import markActive from "../../src/handlers/subagent-start/mark-subagent-active";
import recordEvidence from "../../src/handlers/post-tool-use/record-evidence";
import enforce from "../../src/handlers/pre-tool-use/enforce-phase-tools";
import cleanup from "../../src/handlers/subagent-stop/cleanup-subagent-flag";
import {
  countActiveAgents,
  readActiveAgentRoles,
  ledgerPath,
  machineBindingPath,
  readEvidence,
  soleActiveBinding,
} from "../../src/machine/ledger";
import { eventsForEpoch, parseEpoch, parseSessionId } from "../../src/machine/evidence";
import { SUBAGENT_DIR } from "../../src/config";

const run = `handlers-e2e-${process.pid}-${Date.now()}`;
const fixtureRoot = mkdtempSync(join(tmpdir(), "loom-machine-handler-e2e-"));
const statePath = join(fixtureRoot, "active_task_graph.json");
const machinesPath = fixtureRoot;
const previousStatePath = process.env.LOOM_STATE_PATH;
const previousMachinesPath = process.env.LOOM_MACHINES_DIR;
// Ledger API takes the branded SessionId; parse once at construction.
const sid = (name: string) => parseSessionId(`${run}-${name}`)!;
const sessions = ["e2e-1", "e2e-2", "e2e-3", "e2e-4", "e2e-5", "e2e-6", "e2e-6b", "e2e-7"].map(sid);

beforeAll(() => {
  writeFileSync(statePath, JSON.stringify({ current_phase: "init", phase_artifacts: {} }));
  process.env.LOOM_STATE_PATH = statePath;
  process.env.LOOM_MACHINES_DIR = machinesPath;
  const machine = {
    agent: "guarded-test-agent",
    enforcedTools: ["Edit", "Write", "MultiEdit"],
    phases: [
      { id: "read-context", allowedTools: [], advance: { event: "FileRead", min: 1 } },
      { id: "implement", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "FileWrite", min: 1 } },
      { id: "verify", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "TestRunPassed", min: 1 } },
      { id: "done", terminal: true, allowedTools: ["Edit", "Write", "MultiEdit"], requires: [{ event: "TestRunPassed", min: 1 }] },
    ],
  };
  writeFileSync(join(machinesPath, "guarded-test-agent.machine.json"), JSON.stringify(machine), { flag: "wx" });
});

afterAll(() => {
  for (const s of sessions) {
    for (const path of [
      ledgerPath(s),
      machineBindingPath(s),
      `${SUBAGENT_DIR}/${s}.active`,
      `${SUBAGENT_DIR}/${s}.task_graph`,
    ]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  if (previousMachinesPath === undefined) delete process.env.LOOM_MACHINES_DIR;
  else process.env.LOOM_MACHINES_DIR = previousMachinesPath;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const start = (session: string, agentId = "a-1", agentType = "guarded-test-agent") =>
  JSON.stringify({ session_id: session, agent_id: agentId, agent_type: agentType });
const stop = start;
const pre = (session: string, tool: string) =>
  JSON.stringify({ session_id: session, tool_name: tool, tool_input: {} });
const post = (session: string, tool: string, input: Record<string, unknown>, response?: unknown) =>
  JSON.stringify({ session_id: session, tool_name: tool, tool_input: input, tool_response: response, cwd: "/tmp" });

describe("guarded machine — full hook lifecycle", () => {
  it("blocks Write before Read, allows it after, then unbinds cleanly", async () => {
    const s = sid("e2e-1");
    await markActive(start(s), []);

    const blocked = await enforce(pre(s, "Write"), []);
    expect(blocked.kind).toBe("block");
    if (blocked.kind === "block") {
      expect(blocked.message).toContain("read-context");
    }

    expect((await enforce(pre(s, "Read"), [])).kind).toBe("allow");
    expect((await enforce(pre(s, "Bash"), [])).kind).toBe("allow");

    await recordEvidence(post(s, "Read", { file_path: "/plan.md" }), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("allow");

    await cleanup(stop(s), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("records epoch-stamped TestRun facts from Bash tool calls", async () => {
    const s = sid("e2e-2");
    await markActive(start(s), []);
    await recordEvidence(
      post(s, "Bash", { command: "npm test" }, { exit_code: 1, stdout: "BUILD SUCCESS 5 passing" }),
      [],
    );
    const records = readEvidence(s);
    expect(records).toHaveLength(1);
    expect(records[0].epoch).toBe("a-1:guarded-test-agent");
    expect(records[0].event).toEqual({ kind: "TestRun", command: "npm test", exit: 1, report: null });
    // Foreign epochs see nothing (parseEpoch: the branded deserialization boundary):
    expect(eventsForEpoch(records, parseEpoch("a-9:code-implementer-agent")!)).toEqual([]);
    await cleanup(stop(s), []);
  });

  it("does not record evidence when no machine is bound (unrelated sessions untouched)", async () => {
    const s = sid("e2e-3");
    await recordEvidence(post(s, "Read", { file_path: "/x.ts" }), []);
    expect(readEvidence(s)).toEqual([]);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("stands down when ANY second subagent joins the session, re-arms when it leaves", async () => {
    const s = sid("e2e-4");
    await markActive(start(s), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("block");

    // A second active subagent (machine-less) makes attribution impossible:
    // both the gate and the recorder stand down.
    await markActive(start(s, "a-2", "brainstorm-agent"), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
    await recordEvidence(post(s, "Read", { file_path: "/other.ts" }), []);
    expect(readEvidence(s)).toEqual([]); // nothing recorded while contended

    await cleanup(start(s, "a-2", "brainstorm-agent"), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("block"); // re-armed

    await cleanup(stop(s), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("agents without a machine definition are never gated (opt-in)", async () => {
    const s = sid("e2e-5");
    await markActive(start(s, "a-9", "brainstorm-agent"), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
    await cleanup(start(s, "a-9", "brainstorm-agent"), []);
  });

  it("blocks a machine-bearing agent whose agent_id has reserved characters without publishing capabilities", async () => {
    const s = sid("e2e-6");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s, "evil:id"), []);
      expect(result).toMatchObject({
        kind: "block",
        message: expect.stringContaining("no valid agent_id"),
      });
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join(""))
        .toContain("is reserved or path-unsafe");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(machineBindingPath(s))).toBe(false);
    expect(countActiveAgents(s)).toBe(0);
    expect(existsSync(`${SUBAGENT_DIR}/${s}.task_graph`)).toBe(false);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("blocks a machine-bearing self-reported agent_id in the write-grant namespace", async () => {
    const s = sid("e2e-6b");
    const forged = "pi-grant-0123456789abcdef";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s, forged), []);
      expect(result.kind).toBe("block");
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join(""))
        .toContain("write-grant namespace");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(countActiveAgents(s)).toBe(0);
    expect(readActiveAgentRoles(s)).toEqual([]);
    expect(existsSync(machineBindingPath(s))).toBe(false);
    expect(existsSync(`${SUBAGENT_DIR}/${s}.task_graph`)).toBe(false);
  });

  it("a rejected unparseable sibling cannot disable an existing machine binding", async () => {
    const s = sid("e2e-7");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await markActive(start(s), []);
      expect(soleActiveBinding(s)?.agentId).toBe("a-1");

      const rejected = await markActive(start(s, "evil:id"), []);
      expect(rejected.kind).toBe("block");
      expect(countActiveAgents(s)).toBe(1);
      expect(soleActiveBinding(s)?.agentId).toBe("a-1");
      expect((await enforce(pre(s, "Write"), [])).kind).toBe("block");

      await cleanup(stop(s), []);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("the gate fails closed on malformed stdin while any binding exists", async () => {
    const s = sid("e2e-1"); // reuse cleaned session name space
    await markActive(start(s), []);
    const result = await enforce("{not json", []);
    expect(result.kind).toBe("block");
    await cleanup(stop(s), []);
  });
});
