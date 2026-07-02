/**
 * The standalone CLI route of cleanup-subagent-flag receives raw stdin —
 * a malformed payload must produce a context-carrying error (naming what
 * was NOT released and why that's survivable), never a bare JSON.parse
 * throw surfacing as an uncontextualized "Hook error".
 */

import { describe, it, expect } from "vitest";
import cleanup from "../../../src/handlers/subagent-stop/cleanup-subagent-flag";

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
});
