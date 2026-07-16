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

  it("stands down (records nothing) when no binding is active — contended/ungated", async () => {
    const reg = inMemorySessionRegistry();
    const result = await runRecordEvidence(post("inj-ungated", "Write", { file_path: "src/x.ts" }), reg);
    expect(result.kind).toBe("passthrough");
    expect(reg.readEvidence(parseSessionId("inj-ungated")!)).toEqual([]);
  });
});
