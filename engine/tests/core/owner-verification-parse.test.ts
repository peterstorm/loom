/**
 * The owner-verification wire parsers (AD-1), beside the types they rebuild:
 * the observation results and receipts carry, and the owed ids the
 * authorized owner check binds. Every refusal names its path.
 */

import { describe, expect, it } from "vitest";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { parseOwedInvariantIds, parseOwnerVerificationObservation } from "../../src/core/owner-verification/parse";
import type { OwnerVerificationObservation } from "../../src/core/owner-verification/types";
import { digest } from "../fixtures/acceptance-fixtures";
import { invariantId } from "../fixtures/owner-obligation";
import { labelledValue } from "../fixtures/parse-result";

const viaDisk = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const run = labelledValue("run", verifiedMutationOf({
  killed: 2, timedOut: 1, invalid: 1,
  survivors: [{ mutantId: "m1", operator: "logical-swap", line: 3, column: 9, original: "&&", replacement: "||" }],
  unmutated: 2, ownerChangedInWave: true,
}));

const OBSERVATION: OwnerVerificationObservation = {
  kind: "verified",
  obligationsDigest: digest("e"),
  boundMs: 90_000,
  verdicts: [
    { invariant: invariantId("INV-1"), title: "t1", owner: "src/a.ts", matrixTest: "tests/a.test.ts", coverage: { kind: "covered" }, mutation: run },
    {
      invariant: invariantId("INV-2"), title: "t2", owner: "src/b.ts", matrixTest: "tests/b.test.ts",
      coverage: { kind: "missing", paths: ["src/b-sibling.ts"] },
      mutation: { kind: "infrastructure", failure: { kind: "no-valid-mutants", detail: "every mutant was invalid" } },
    },
    {
      invariant: invariantId("INV-3"), title: "t3", owner: "src/c.ts", matrixTest: "tests/c.test.ts",
      coverage: { kind: "infrastructure", failure: { kind: "coverage-bound-exceeded", detail: "too many files" } },
      mutation: { kind: "red-baseline", failures: ["matrix > case"] },
    },
  ],
};

const refusal = (raw: unknown): readonly string[] => {
  const parsed = parseOwnerVerificationObservation(raw, "o");
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error.errors;
};

describe("parseOwnerVerificationObservation", () => {
  it("round-trips every verdict shape, and an unavailable check", () => {
    expect(parseOwnerVerificationObservation(viaDisk(OBSERVATION), "o")).toEqual({ ok: true, value: OBSERVATION });
    const unavailable = { kind: "unavailable", failure: { kind: "plan-drift", detail: "stamp drifted" } };
    expect(parseOwnerVerificationObservation(unavailable, "o")).toEqual({ ok: true, value: unavailable });
  });

  it.each([
    ["a non-object", 7, "o must be an object"],
    ["an unknown kind", { kind: "skipped" }, "o.kind must be verified or unavailable"],
    ["an unknown infrastructure kind", { kind: "unavailable", failure: { kind: "flaky", detail: "x" } }, "o.failure.kind must be an owner-verification infrastructure kind"],
    ["a blank detail", { kind: "unavailable", failure: { kind: "plan-drift", detail: " " } }, "o.failure.detail must be a non-blank string"],
    ["a repeated Invariant", { ...OBSERVATION, verdicts: [OBSERVATION.verdicts[0], OBSERVATION.verdicts[0]] }, "o.verdicts names an Invariant more than once"],
    ["a non-Invariant id", { ...OBSERVATION, verdicts: [{ ...OBSERVATION.verdicts[0], invariant: "LC-1" }] }, "o.verdicts[0].invariant must be an Invariant id (INV-N)"],
    ["a recount that disagrees", { ...OBSERVATION, verdicts: [{ ...OBSERVATION.verdicts[0], mutation: { ...run, generated: 99 } }] }, "o.verdicts[0].mutation.generated must equal the mutants its tallies count"],
    ["an unknown operator", {
      ...OBSERVATION,
      verdicts: [{ ...OBSERVATION.verdicts[0], mutation: { ...run, survivors: [{ mutantId: "m", operator: "swap", line: 1, column: 1, original: "", replacement: "" }] } }],
    }, "o.verdicts[0].mutation.survivors[0].operator must be one of the fixed mutation operators"],
    ["an extra field", { ...OBSERVATION, extra: 1 }, "o.extra is not allowed"],
  ] as const)("refuses %s, naming the path", (_case, raw, message) => {
    expect(refusal(viaDisk(raw))).toContain(message);
  });
});

describe("parseOwedInvariantIds", () => {
  it("keeps plan order and mints each id", () => {
    expect(parseOwedInvariantIds(["INV-2", "INV-1"], "owed")).toEqual({ ok: true, value: ["INV-2", "INV-1"] });
    expect(parseOwedInvariantIds([], "owed")).toEqual({ ok: true, value: [] });
  });

  it.each([
    ["a non-array", "INV-1", "owed must be an array"],
    ["a non-Invariant id", ["INV-1", "x"], "owed[1] must be an Invariant id (INV-N)"],
    ["a repeated id", ["INV-1", "INV-1"], "owed names an Invariant more than once"],
  ] as const)("refuses %s", (_case, raw, message) => {
    const parsed = parseOwedInvariantIds(raw, "owed");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.errors).toContain(message);
  });
});
