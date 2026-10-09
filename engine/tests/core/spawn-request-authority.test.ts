import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStoredAgentRequestAuthority } from "../../src/core/orchestration-contract";
import { parseSpawnRequestAuthority } from "../../src/core/spawn-request-authority";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

/**
 * The one re-parse an emitted spawn request crosses at the emission gate and
 * at session publication: exactly the stored-request parser's verdict, with
 * a refusal that names the harness, the request's index and every violation.
 */

const stored = agentRequestAuthority("run.spawn-request-authority");

describe("parseSpawnRequestAuthority", () => {
  it("admits exactly what the stored-request parser admits", () => {
    expect(parseSpawnRequestAuthority("Pi", 0, stored)).toEqual(parseStoredAgentRequestAuthority(stored));
  });

  it("names the harness, the index and every violation of a request it refuses (property)", () => {
    const broken = { ...stored, modelProfile: "no-such-profile", contextDigest: "not-a-digest" };
    const parsed = parseStoredAgentRequestAuthority(broken);
    if (parsed.ok) throw new Error("the fixture must not parse");
    const violations = parsed.error.violations.map(({ message }) => message).join("; ");
    fc.assert(fc.property(fc.constantFrom("Pi", "Claude Code"), fc.nat({ max: 64 }), (label, index) => {
      expect(parseSpawnRequestAuthority(label, index, broken))
        .toEqual({ ok: false, message: `${label} orchestration spawn request ${index}: ${violations}` });
    }));
    expect(parsed.error.violations.length).toBeGreaterThanOrEqual(2);
  });
});
