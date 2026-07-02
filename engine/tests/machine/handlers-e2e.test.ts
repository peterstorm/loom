/**
 * Handler-level e2e: SubagentStart binding → PostToolUse evidence →
 * PreToolUse gating, through the real hook handlers with stdin JSON.
 *
 * bun test runs all files in one process, so SUBAGENT_DIR resolves once
 * globally — isolate via unique session ids + targeted cleanup.
 */

import { describe, it, expect, afterAll } from "vitest";
import { unlinkSync } from "node:fs";
import markActive from "../../src/handlers/subagent-start/mark-subagent-active";
import recordEvidence from "../../src/handlers/post-tool-use/record-evidence";
import enforce from "../../src/handlers/pre-tool-use/enforce-phase-tools";
import cleanup from "../../src/handlers/subagent-stop/cleanup-subagent-flag";
import { ledgerPath, machineBindingPath, readEvidence } from "../../src/machine/ledger";
import { SUBAGENT_DIR } from "../../src/config";

const run = `handlers-e2e-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["e2e-1", "e2e-2", "e2e-3", "e2e-4", "e2e-5"].map(sid);

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
});

const start = (session: string, agentId = "a-1", agentType = "loom:code-implementer-agent") =>
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

    // R1: Write blocked in read-context
    const blocked = await enforce(pre(s, "Write"), []);
    expect(blocked.kind).toBe("block");
    if (blocked.kind === "block") {
      expect(blocked.message).toContain("read-context");
    }

    // Unenforced tools pass while writes are gated
    expect((await enforce(pre(s, "Read"), [])).kind).toBe("allow");
    expect((await enforce(pre(s, "Bash"), [])).kind).toBe("allow");

    // A real Read is recorded as evidence → phase advances
    await recordEvidence(post(s, "Read", { file_path: "/plan.md" }), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("allow");

    // Unbind → gate stands down entirely
    await cleanup(stop(s), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("records TestRun ground truth from Bash tool calls", async () => {
    const s = sid("e2e-2");
    await markActive(start(s), []);
    await recordEvidence(
      post(s, "Bash", { command: "npm test" }, { exit_code: 1, stdout: "BUILD SUCCESS 5 passing" }),
      [],
    );
    const events = readEvidence(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "TestRun", exit: 1, passed: false, trusted: true });
    await cleanup(stop(s), []);
  });

  it("does not record evidence when no machine is bound (unrelated sessions untouched)", async () => {
    const s = sid("e2e-3");
    await recordEvidence(post(s, "Read", { file_path: "/x.ts" }), []);
    expect(readEvidence(s)).toEqual([]);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("keeps gating when a second, machine-less agent joins the session", async () => {
    const s = sid("e2e-4");
    await markActive(start(s), []);
    await markActive(start(s, "a-2", "ts-test-agent"), []);

    // ts-test-agent ships no machine → still exactly one distinct bound type → gated
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("block");

    await cleanup(stop(s), []);
    await cleanup(start(s, "a-2", "ts-test-agent"), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
  });

  it("agents without a machine definition are never gated (opt-in)", async () => {
    const s = sid("e2e-5");
    await markActive(start(s, "a-9", "brainstorm-agent"), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
    await cleanup(start(s, "a-9", "brainstorm-agent"), []);
  });
});
