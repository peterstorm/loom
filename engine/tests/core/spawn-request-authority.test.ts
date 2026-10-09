import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStoredAgentRequestAuthority } from "../../src/core/orchestration-contract";
import { parseSpawnBatch } from "../../src/core/spawn-request-authority";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

/**
 * The one parse an emitted spawn batch crosses, shared by the emission gate
 * and session publication: exactly the stored-request parser's verdict on
 * each request, in order, stopping at the first refusal — which names the
 * harness, the request's index and every violation, and keeps the requests
 * before it.
 */

const RUN_ID = "run.spawn-request-authority";
const stored = agentRequestAuthority(RUN_ID);
const second = agentRequestAuthority(RUN_ID, { requestId: "request:reviewer:2" });
const broken = { ...stored, modelProfile: "no-such-profile", contextDigest: "not-a-digest" };

const admitted = (raw: unknown) => {
  const parsed = parseStoredAgentRequestAuthority(raw);
  if (!parsed.ok) throw new Error("the fixture must parse");
  return parsed.value;
};
const violations = (() => {
  const parsed = parseStoredAgentRequestAuthority(broken);
  if (parsed.ok) throw new Error("the fixture must not parse");
  return parsed.error.violations.map(({ message }) => message);
})();

describe("parseSpawnBatch", () => {
  it("admits every request exactly as the stored-request parser admits it, in order", () => {
    expect(parseSpawnBatch("Pi", [stored, second])).toEqual({ ok: true, requests: [admitted(stored), admitted(second)] });
  });

  it("admits an empty batch as empty, leaving the emptiness refusal to its consumer", () => {
    expect(parseSpawnBatch("Pi", [])).toEqual({ ok: true, requests: [] });
  });

  it("refuses at the first unparseable request, naming the harness, its index and every violation, keeping the requests before it (property)", () => {
    expect(violations.length).toBeGreaterThanOrEqual(2);
    fc.assert(fc.property(
      fc.constantFrom("Pi", "Claude Code"),
      fc.array(fc.constantFrom(stored, second), { maxLength: 4 }),
      fc.array(fc.constantFrom<unknown>(stored, broken), { maxLength: 3 }),
      (label, before, after) => {
        expect(parseSpawnBatch(label, [...before, broken, ...after])).toEqual({
          ok: false,
          admitted: before.map(admitted),
          message: `${label} orchestration spawn request ${before.length}: ${violations.join("; ")}`,
        });
      },
    ));
  });
});
