/**
 * ADR-0070: the State File wire proves `plan_design_review` before the
 * decompose gate reads it. Each of the three recorded shapes survives a
 * serialize/parse round trip unchanged; an absent field stays absent, so a
 * graph initialized before the review loads and owes none; a malformed record
 * refuses the whole graph instead of reading as "not required".
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planDesignGate, planDesignReviewOf, type RecordedPlanDesignReview } from "../src/core/plan-design-review";
import { resolveInitialState } from "../src/phase-init";
import { parseTaskGraph } from "../src/state-file-wire";
import type { TaskGraph } from "../src/types";
import { value } from "./fixtures/parse-result";

const graph = (extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  current_phase: "plan-alignment",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: ".claude/plans/feature.md",
  tasks: [],
  wave_gates: {},
  ...extra,
} satisfies Partial<TaskGraph> & Record<string, unknown>);

const viaDisk = (state: unknown): unknown => JSON.parse(JSON.stringify(state));

const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
const recordArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.constant({ status: "required" }),
  fc.constant({ status: "not-required", reason: "skipped" }),
  fc.record({ status: fc.constant("accepted"), planSha256: hex, runId: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), resultDigest: hex }),
);

describe("plan_design_review on the State File wire", () => {
  it("round-trips every recorded shape: parse, serialize, parse again", () => {
    fc.assert(fc.property(recordArb, (record) => {
      const first = value(parseTaskGraph(viaDisk(graph({ plan_design_review: record }))));
      expect(first.plan_design_review).toEqual(record);
      const second = value(parseTaskGraph(viaDisk(first)));
      expect(second.plan_design_review).toEqual(record);
    }));
  });

  it("keeps an absent field absent, which the gate reads as not required", () => {
    const parsed = value(parseTaskGraph(viaDisk(graph())));
    expect("plan_design_review" in parsed).toBe(false);
    expect(planDesignGate(planDesignReviewOf(parsed.plan_design_review), "0".repeat(64))).toEqual({ kind: "open" });
  });

  it.each([
    ["null", null],
    ["a bare status string", "required"],
    ["an unknown status", { status: "approved" }],
    ["a required record with a stray field", { status: "required", planSha256: "a".repeat(64) }],
    ["an acceptance missing its Run", { status: "accepted", planSha256: "a".repeat(64), resultDigest: "b".repeat(64) }],
    ["an acceptance with a malformed digest", { status: "accepted", planSha256: "nope", runId: "run-1", resultDigest: "b".repeat(64) }],
  ])("refuses the graph when the record is %s", (_label, record) => {
    const parsed = parseTaskGraph(viaDisk(graph({ plan_design_review: record })));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("plan_design_review");
  });

  it("loads the state init-state writes, with the duty it recorded", () => {
    const duties: readonly [boolean, RecordedPlanDesignReview][] = [
      [false, { status: "required" }],
      [true, { status: "not-required", reason: "skipped" }],
    ];
    for (const [skipPlanDesignReview, expected] of duties) {
      const initial = resolveInitialState({ skipPlanDesignReview }, ".claude/specs/feature");
      expect(value(parseTaskGraph(viaDisk(initial))).plan_design_review).toEqual(expected);
    }
  });
});
