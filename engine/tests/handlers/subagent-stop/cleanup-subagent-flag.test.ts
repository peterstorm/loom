/**
 * The standalone CLI route of cleanup-subagent-flag receives raw stdin —
 * a malformed payload must produce a context-carrying error (naming what
 * was NOT released and why that's survivable), never a bare JSON.parse
 * throw surfacing as an uncontextualized "Hook error".
 */

import { describe, it, expect } from "vitest";
import cleanup, { runCleanupSubagentFlag } from "../../../src/handlers/subagent-stop/cleanup-subagent-flag";
import { fsSessionRegistry } from "../../../src/machine";

describe("cleanup-subagent-flag — malformed stdin", () => {
  it("returns a contextual error instead of throwing", async () => {
    const result = await cleanup("{not json", []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("cleanup-subagent-flag");
      expect(result.message).toContain("malformed");
      expect(result.message).toContain("NOT released");
      expect(result.message).toContain("TTL");
    }
  });

  it("well-formed input without agent_id stays a passthrough (no roster entry to remove)", async () => {
    const result = await cleanup(JSON.stringify({ session_id: "s-none" }), []);
    expect(result.kind).toBe("passthrough");
  });

  it("attempts machine unbind, sidecar deletion, and roster cleanup and returns every failure", async () => {
    const attempted: string[] = [];
    const registry = {
      ...fsSessionRegistry,
      unbind: async () => {
        attempted.push("unbind");
        throw new Error("unbind unavailable");
      },
      removeActive: async () => {
        attempted.push("roster");
        throw new Error("roster unavailable");
      },
    };
    const result = await runCleanupSubagentFlag(
      JSON.stringify({
        session_id: "cleanup-all-failures",
        agent_id: "agent-cleanup",
        agent_type: "code-implementer-agent",
      }),
      registry,
      () => {
        attempted.push("sidecar");
        throw new Error("sidecar unavailable");
      },
      async () => {
        attempted.push("pointer");
        throw new Error("pointer unavailable");
      },
    );

    expect(attempted).toEqual(["unbind", "sidecar", "pointer", "roster"]);
    expect(result).toEqual({
      kind: "error",
      message: expect.stringMatching(/unbind unavailable.*sidecar unavailable.*pointer unavailable.*roster unavailable/),
    });
  });
});
