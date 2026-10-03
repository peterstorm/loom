/**
 * Fix 14 payoff: the record-evidence handler CORE runs against the in-memory
 * SessionRegistry fake — no tmpdirs, no fs. This proves the port is actually
 * threaded through the production handler (runRecordEvidence takes the registry
 * as its dependency) and that its bind → record → read sequencing is testable
 * as plain data, exactly what the port was minted for.
 */

import { describe, it, expect } from "vitest";
import { runRecordEvidence } from "../../../src/handlers/post-tool-use/record-evidence";
import { parseAgentId, parseAgentType, parseSessionId } from "../../../src/machine/evidence";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";

function post(session: string, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({ session_id: session, tool_name: tool, tool_input: input, cwd: "/repo" });
}

describe("record-evidence core against the SessionRegistry fake (no fs)", () => {
  it("records a bound agent's FileWrite into the injected registry", async () => {
    const reg = inMemorySessionRegistry();
    const sessionId = parseSessionId("inj-session")!;
    const agentType = parseAgentType("code-implementer-agent")!;
    const agentId = parseAgentId("a-1")!;

    // A sole active binding: roster + binding are exactly this one agent.
    await reg.markActive(sessionId, agentId);
    await reg.bind(sessionId, agentType, agentId);

    const result = await runRecordEvidence(post("inj-session", "Write", { file_path: "src/x.ts" }), reg);
    expect(result.kind).toBe("passthrough");

    const records = reg.readEvidence(sessionId);
    expect(records).toHaveLength(1);
    // Paths are resolved at MINT time against the call's cwd (a later
    // reader's cwd may differ), and tool writes carry via: "tool".
    expect(records[0].event).toEqual({ kind: "FileWrite", path: "/repo/src/x.ts", via: "tool" });
    expect(records[0].epoch).toBe(reg.soleActiveBinding(sessionId)!.epoch);
  });

  it("parallel bound agents: each agent_id-stamped call is recorded under its own epoch only", async () => {
    const reg = inMemorySessionRegistry();
    const sessionId = parseSessionId("inj-parallel")!;
    const agentType = parseAgentType("code-implementer-agent")!;
    const ids = ["a-1", "a-2", "a-3", "a-4"].map((id) => parseAgentId(id)!);
    for (const id of ids) {
      await reg.markActive(sessionId, id);
      await reg.bind(sessionId, agentType, id);
    }
    expect(reg.soleActiveBinding(sessionId)).toBeNull(); // the old rule stood down here

    for (const id of ids) {
      const payload = JSON.parse(post("inj-parallel", "Write", { file_path: `src/${id}.ts` }));
      await runRecordEvidence(JSON.stringify({ ...payload, agent_id: id }), reg);
    }
    const records = reg.readEvidence(sessionId);
    expect(records.map((r) => [r.epoch, r.event])).toEqual(
      ids.map((id) => [`${id}:code-implementer-agent`, { kind: "FileWrite", path: `/repo/src/${id}.ts`, via: "tool" }]),
    );
  });

  it("an agent_id-stamped call never falls back to the sole binding of another agent", async () => {
    const reg = inMemorySessionRegistry();
    const sessionId = parseSessionId("inj-foreign")!;
    const bound = parseAgentId("a-1")!;
    await reg.markActive(sessionId, bound);
    await reg.bind(sessionId, parseAgentType("code-implementer-agent")!, bound);

    for (const agentId of ["a-9", "pi-grant-forged", "bad id"]) {
      const payload = JSON.parse(post("inj-foreign", "Write", { file_path: "src/x.ts" }));
      await runRecordEvidence(JSON.stringify({ ...payload, agent_id: agentId }), reg);
    }
    expect(reg.readEvidence(sessionId)).toEqual([]);

    // The unreported (main-agent / older-harness) fallback is unchanged.
    await runRecordEvidence(post("inj-foreign", "Write", { file_path: "src/x.ts" }), reg);
    expect(reg.readEvidence(sessionId).map((r) => r.epoch)).toEqual(["a-1:code-implementer-agent"]);
  });

  it("stands down (records nothing) when no binding is active — contended/ungated", async () => {
    const reg = inMemorySessionRegistry();
    const result = await runRecordEvidence(post("inj-ungated", "Write", { file_path: "src/x.ts" }), reg);
    expect(result.kind).toBe("passthrough");
    expect(reg.readEvidence(parseSessionId("inj-ungated")!)).toEqual([]);
  });
});
