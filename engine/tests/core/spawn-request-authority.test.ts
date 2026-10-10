import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStoredAgentRequestAuthority } from "../../src/core/orchestration-contract";
import { parseSpawnBatch } from "../../src/core/spawn-request-authority";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

/**
 * The one parse an emitted spawn batch crosses, shared by the emission gate
 * and session publication: exactly the stored-request parser's verdict on
 * each request, for the emitting run, in order, stopping at the first request
 * that is not admitted — one that does not parse, or one of another run —
 * and naming the harness, its index and, for a parse refusal, every
 * violation.
 */

const RUN_ID = "run.spawn-request-authority";
const stored = agentRequestAuthority(RUN_ID);
const second = agentRequestAuthority(RUN_ID, { requestId: "request:reviewer:2" });
const foreign = agentRequestAuthority("run.elsewhere");
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

const labels = fc.constantFrom("Pi", "Claude Code");
/** Requests this run's parse admits. */
const owned = fc.array(fc.constantFrom(stored, second), { maxLength: 4 });
/** Anything, admitted or not, after the first refused request. */
const anything = fc.array(fc.constantFrom<unknown>(stored, broken, foreign), { maxLength: 3 });

describe("parseSpawnBatch", () => {
  it("admits every request exactly as the stored-request parser admits it, in order", () => {
    expect(parseSpawnBatch("Pi", RUN_ID, [stored, second])).toEqual({ ok: true, requests: [admitted(stored), admitted(second)] });
  });

  it("admits an empty batch as empty, leaving the emptiness refusal to its consumer", () => {
    expect(parseSpawnBatch("Pi", RUN_ID, [])).toEqual({ ok: true, requests: [] });
  });

  it("refuses at the first unparseable request, naming the harness, its index and every violation (property)", () => {
    expect(violations.length).toBeGreaterThanOrEqual(2);
    fc.assert(fc.property(labels, owned, anything, (label, before, after) => {
      expect(parseSpawnBatch(label, RUN_ID, [...before, broken, ...after])).toEqual({
        ok: false,
        message: `${label} orchestration spawn request ${before.length}: ${violations.join("; ")}`,
      });
    }));
  });

  it("refuses at the first request of another run, naming the harness and its index, before any later request that did not parse (property)", () => {
    fc.assert(fc.property(labels, owned, anything, (label, before, after) => {
      expect(parseSpawnBatch(label, RUN_ID, [...before, foreign, ...after])).toEqual({
        ok: false,
        message: `${label} orchestration spawn request ${before.length} belongs to another run`,
      });
    }));
  });

  it("admits a batch for the run its requests belong to, and refuses it for any other", () => {
    expect(parseSpawnBatch("Pi", "run.elsewhere", [foreign])).toEqual({ ok: true, requests: [admitted(foreign)] });
    expect(parseSpawnBatch("Pi", "run.elsewhere", [stored]))
      .toEqual({ ok: false, message: "Pi orchestration spawn request 0 belongs to another run" });
  });
});
