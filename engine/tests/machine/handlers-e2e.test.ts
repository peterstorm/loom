/**
 * Handler-level e2e: SubagentStart binding → PostToolUse evidence →
 * PreToolUse gating, through the real hook handlers with stdin JSON.
 *
 * Isolation via unique session ids + targeted cleanup (SUBAGENT_DIR is
 * process-global).
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import markActive from "../../src/handlers/subagent-start/mark-subagent-active";
import recordEvidence from "../../src/handlers/post-tool-use/record-evidence";
import enforce from "../../src/handlers/pre-tool-use/enforce-phase-tools";
import cleanup from "../../src/handlers/subagent-stop/cleanup-subagent-flag";
import {
  countActiveAgents,
  ledgerPath,
  machineBindingPath,
  readEvidence,
  soleActiveBinding,
} from "../../src/machine/ledger";
import { eventsForEpoch, parseEpoch } from "../../src/machine/evidence";
import { SUBAGENT_DIR } from "../../src/config";

const run = `handlers-e2e-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["e2e-1", "e2e-2", "e2e-3", "e2e-4", "e2e-5", "e2e-6", "e2e-7"].map(sid);

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
    expect(records[0].epoch).toBe("a-1:code-implementer-agent");
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
    await markActive(start(s, "a-2", "ts-test-agent"), []);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
    await recordEvidence(post(s, "Read", { file_path: "/other.ts" }), []);
    expect(readEvidence(s)).toEqual([]); // nothing recorded while contended

    await cleanup(start(s, "a-2", "ts-test-agent"), []);
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

  it("an agent_id with reserved characters is refused LOUDLY at the bind boundary (never desyncs the epoch)", async () => {
    const s = sid("e2e-6");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // ':' in the id would make the recorded epoch ambiguous with epochOf
      await markActive(start(s, "evil:id"), []);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("reserved or path-unsafe characters");
      expect(text).toContain("UNGATED");
    } finally {
      stderrSpy.mockRestore();
    }
    // No binding was written — the session is simply ungated (fail-unarmed,
    // which the gate's binding-exists checks already cover). But the agent
    // IS on the roster (as a sanitized placeholder) so contention counting
    // still sees it.
    expect(existsSync(machineBindingPath(s))).toBe(false);
    expect(countActiveAgents(s)).toBe(1);
    expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
    await cleanup(stop(s, "evil:id"), []);
    expect(countActiveAgents(s)).toBe(0); // stop removes the same placeholder
  });

  it("an unparseable agent_id still counts on the roster — attribution stands down instead of cross-crediting", async () => {
    const s = sid("e2e-7");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // A validly-bound agent…
      await markActive(start(s), []);
      expect(soleActiveBinding(s)?.agentId).toBe("a-1");

      // …then a rogue agent whose id the bind boundary rejects joins the
      // session. It cannot be bound — but it MUST still count as active,
      // otherwise its tool calls (including trusted TestRun evidence)
      // would be attributed to a-1's epoch.
      await markActive(start(s, "evil:id"), []);
      expect(countActiveAgents(s)).toBe(2);
      expect(soleActiveBinding(s)).toBeNull(); // contended → stand down

      // Gate and recorder both stand down while contended.
      expect((await enforce(pre(s, "Write"), [])).kind).toBe("passthrough");
      await recordEvidence(
        post(s, "Bash", { command: "npm test" }, { exit_code: 0, stdout: "5 passing" }),
        [],
      );
      expect(readEvidence(s)).toEqual([]); // the rogue run credited NOTHING

      // The rogue agent stops → symmetric placeholder removal re-arms a-1.
      await cleanup(stop(s, "evil:id"), []);
      expect(soleActiveBinding(s)?.agentId).toBe("a-1");
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
