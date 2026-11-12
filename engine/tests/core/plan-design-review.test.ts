/**
 * The plan design review's pure core (ADR-0070): the State File record and its
 * parser, the decompose gate's decision, the judgement of a completed review,
 * and the reviewer lens.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseArtifactDigest, parseOrchestrationRunId, type ArtifactDigest } from "../../src/core/orchestration-contract/identity";
import {
  PLAN_DESIGN_REVIEWERS,
  PLAN_DESIGN_REVIEW_KIND,
  PLAN_DESIGN_REVIEW_REQUIRED,
  PLAN_DESIGN_REVIEW_SKIPPED,
  judgePlanDesignEvidence,
  parsePlanDesignReview,
  planDesignGate,
  planDesignLens,
  planDesignReviewOf,
  renderPlanDesignRefusal,
  renderPlanDesignRequirement,
  type AcceptedPlanDesignReview,
  type CurrentPlan,
  type PlanDesignEvidence,
  type PlanDesignRefusal,
  type RecordedPlanDesignReview,
} from "../../src/core/plan-design-review";
import { STANDALONE_REVIEWER_ROLES } from "../../src/core/standalone-review-scope";
import { refusal, value } from "../fixtures/parse-result";

const digestArb: fc.Arbitrary<ArtifactDigest> = fc
  .stringMatching(/^[0-9a-f]{64}$/)
  .map((hex) => value(parseArtifactDigest(hex)));
const runIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/).map((id) => value(parseOrchestrationRunId(id)));
const acceptedArb: fc.Arbitrary<AcceptedPlanDesignReview> = fc.record({
  status: fc.constant("accepted" as const),
  planSha256: digestArb,
  runId: runIdArb,
  resultDigest: digestArb,
});
const recordedArb: fc.Arbitrary<RecordedPlanDesignReview> = fc.oneof(
  fc.constant(PLAN_DESIGN_REVIEW_REQUIRED),
  fc.constant(PLAN_DESIGN_REVIEW_SKIPPED),
  acceptedArb,
);

const viaDisk = (record: unknown): unknown => JSON.parse(JSON.stringify(record));

describe("parsePlanDesignReview", () => {
  it("round-trips every record through its JSON form", () => {
    fc.assert(fc.property(recordedArb, (record) => {
      expect(value(parsePlanDesignReview(viaDisk(record)))).toEqual(record);
    }));
  });

  it("refuses any surplus field on every shape", () => {
    fc.assert(fc.property(recordedArb, fc.stringMatching(/^[a-z_]{1,12}$/), (record, key) => {
      fc.pre(!Object.hasOwn(record, key));
      expect(parsePlanDesignReview({ ...record, [key]: true }).ok).toBe(false);
    }));
  });

  it.each([
    ["a non-object", "accepted"],
    ["an unknown status", { status: "waived" }],
    ["the gate-only unrecorded reason", { status: "not-required", reason: "unrecorded" }],
    ["a skip without its reason", { status: "not-required" }],
    ["an acceptance without a plan digest", { status: "accepted", runId: "run-1", resultDigest: "a".repeat(64) }],
    ["an uppercase plan digest", { status: "accepted", planSha256: "A".repeat(64), runId: "run-1", resultDigest: "a".repeat(64) }],
    ["a short result digest", { status: "accepted", planSha256: "a".repeat(64), runId: "run-1", resultDigest: "abc" }],
    ["a path-shaped Run id", { status: "accepted", planSha256: "a".repeat(64), runId: "../run", resultDigest: "a".repeat(64) }],
  ])("refuses %s", (_label, raw) => {
    expect(refusal(parsePlanDesignReview(raw))).toContain("plan_design_review");
  });
});

describe("planDesignGate", () => {
  it("is open exactly when no review is required or the accepted digest is the current one", () => {
    fc.assert(fc.property(fc.option(recordedArb, { nil: undefined }), digestArb, (recorded, current) => {
      const open = recorded === undefined || recorded.status === "not-required" ||
        (recorded.status === "accepted" && recorded.planSha256 === current);
      expect(planDesignGate(planDesignReviewOf(recorded), current).kind === "open").toBe(open);
    }));
  });

  it("opens for an acceptance at its own digest and closes at any other", () => {
    fc.assert(fc.property(acceptedArb, digestArb, (accepted, other) => {
      expect(planDesignGate(accepted, accepted.planSha256)).toEqual({ kind: "open" });
      fc.pre(other !== accepted.planSha256);
      expect(planDesignGate(accepted, other)).toEqual({
        kind: "plan-changed", acceptedSha256: accepted.planSha256, currentSha256: other,
      });
    }));
  });

  it("reads an absent record as not required, without making it a storable record", () => {
    const unrecorded = planDesignReviewOf(undefined);
    expect(unrecorded).toEqual({ status: "not-required", reason: "unrecorded" });
    expect(parsePlanDesignReview(viaDisk(unrecorded)).ok).toBe(false);
  });

  it("names the plan and the accepting helper in each closed-gate message", () => {
    const required = renderPlanDesignRequirement({ kind: "review-required" }, ".claude/plans/p.md");
    const changed = renderPlanDesignRequirement(
      { kind: "plan-changed", acceptedSha256: value(parseArtifactDigest("a".repeat(64))), currentSha256: "b".repeat(64) },
      ".claude/plans/p.md",
    );
    for (const message of [required, changed]) {
      expect(message).toContain(".claude/plans/p.md");
      expect(message).toContain("helper accept-plan-design-review --runs-root");
      expect(message).toContain(`${PLAN_DESIGN_REVIEW_KIND} standalone review`);
    }
    expect(changed).toContain("a".repeat(64));
    expect(changed).toContain("b".repeat(64));
  });
});

const PLAN: CurrentPlan = { path: ".claude/plans/feature.md", sha256: value(parseArtifactDigest("1".repeat(64))) };

const evidence = (overrides: Partial<PlanDesignEvidence> = {}): PlanDesignEvidence => ({
  runId: value(parseOrchestrationRunId("plan-design-1")),
  resultDigest: value(parseArtifactDigest("2".repeat(64))),
  requestedKinds: [PLAN_DESIGN_REVIEW_KIND],
  scope: [{ path: PLAN.path, sha256: PLAN.sha256 }],
  reviewers: [...PLAN_DESIGN_REVIEWERS],
  readObligated: true,
  survivingCriticals: [],
  advisoryCount: 0,
  dispositionPublished: false,
  ...overrides,
});

describe("judgePlanDesignEvidence", () => {
  it("accepts a clean review of the current plan, bound to the plan bytes and the result", () => {
    expect(value(judgePlanDesignEvidence(evidence(), PLAN))).toEqual({
      status: "accepted",
      planSha256: PLAN.sha256,
      runId: "plan-design-1",
      resultDigest: "2".repeat(64),
    });
  });

  it("accepts advisories once their disposition is published, and refuses them without one", () => {
    expect(judgePlanDesignEvidence(evidence({ advisoryCount: 3, dispositionPublished: true }), PLAN).ok).toBe(true);
    expect(refusal(judgePlanDesignEvidence(evidence({ advisoryCount: 3 }), PLAN)))
      .toEqual({ kind: "advisories-undisposed", advisoryCount: 3 });
  });

  it.each<[string, Partial<PlanDesignEvidence>, PlanDesignRefusal["kind"]]>([
    ["another review kind", { requestedKinds: ["architecture"] }, "wrong-kind"],
    ["a kind set wider than plan-design", { requestedKinds: [PLAN_DESIGN_REVIEW_KIND, "code"] }, "wrong-kind"],
    ["a scope naming another file", { scope: [{ path: "docs/other.md", sha256: PLAN.sha256 }] }, "scope-mismatch"],
    ["a scope wider than the plan", { scope: [{ path: PLAN.path, sha256: PLAN.sha256 }, { path: "src/a.ts", sha256: PLAN.sha256 }] }, "scope-mismatch"],
    ["an empty scope", { scope: [] }, "scope-mismatch"],
    ["a roster missing the type lens", { reviewers: ["code-reviewer", "architecture-tech-lead"] }, "roster-incomplete"],
    ["a registration without the read obligation", { readObligated: false }, "read-not-obligated"],
    ["a plan that was absent when frozen", { scope: [{ path: PLAN.path, sha256: null }] }, "plan-unobserved"],
    ["a plan edited since the review", { scope: [{ path: PLAN.path, sha256: "3".repeat(64) }] }, "plan-changed-since-review"],
    ["a surviving critical", { survivingCriticals: ["code-reviewer-1"] }, "surviving-criticals"],
  ])("refuses %s", (_label, overrides, kind) => {
    expect(refusal(judgePlanDesignEvidence(evidence(overrides), PLAN)).kind).toBe(kind);
  });

  it("never accepts while a critical survives, whatever else holds", () => {
    fc.assert(fc.property(
      fc.array(fc.stringMatching(/^[a-z-]{1,12}-[1-9]$/), { minLength: 1, maxLength: 4 }),
      fc.nat(5),
      fc.boolean(),
      (survivingCriticals, advisoryCount, dispositionPublished) => {
        const judged = judgePlanDesignEvidence(evidence({ survivingCriticals, advisoryCount, dispositionPublished }), PLAN);
        expect(refusal(judged)).toEqual({ kind: "surviving-criticals", findingIds: survivingCriticals });
      },
    ));
  });

  it("opens the gate for exactly the bytes it judged", () => {
    fc.assert(fc.property(digestArb, digestArb, (reviewed, later) => {
      const plan: CurrentPlan = { path: PLAN.path, sha256: reviewed };
      const accepted = value(judgePlanDesignEvidence(evidence({ scope: [{ path: plan.path, sha256: reviewed }] }), plan));
      expect(planDesignGate(accepted, later).kind === "open").toBe(later === reviewed);
    }));
  });

  it("words every refusal with what to do next", () => {
    const refusals: readonly PlanDesignRefusal[] = [
      { kind: "wrong-kind", requestedKinds: ["code"] },
      { kind: "scope-mismatch", scope: ["a.md"], planPath: PLAN.path },
      { kind: "roster-incomplete", missing: ["type-design-analyzer"] },
      { kind: "read-not-obligated" },
      { kind: "plan-unobserved", planPath: PLAN.path },
      { kind: "plan-changed-since-review", reviewedSha256: "3".repeat(64), currentSha256: PLAN.sha256 },
      { kind: "surviving-criticals", findingIds: ["code-reviewer-1"] },
    ];
    for (const each of refusals) expect(renderPlanDesignRefusal(each)).toMatch(/start a (fresh )?plan-design standalone review|review the plan as it exists/);
    expect(renderPlanDesignRefusal({ kind: "advisories-undisposed", advisoryCount: 2 }))
      .toContain("--disposition, --disposition-run and --disposition-digest");
  });
});

describe("planDesignLens", () => {
  it("gives every plan design reviewer its own lens, naming the role", () => {
    const lenses = PLAN_DESIGN_REVIEWERS.map((role) => {
      const lens = planDesignLens([PLAN_DESIGN_REVIEW_KIND], role);
      expect(lens).toContain(`### Your lens: ${role}`);
      expect(lens).toContain("Rate a finding critical when the plan, built as written");
      return lens;
    });
    expect(new Set(lenses).size).toBe(PLAN_DESIGN_REVIEWERS.length);
  });

  it("gives no lens outside a plan design review or outside its roster", () => {
    for (const role of STANDALONE_REVIEWER_ROLES) {
      expect(planDesignLens(["architecture"], role)).toBeNull();
      if (!(PLAN_DESIGN_REVIEWERS as readonly string[]).includes(role)) {
        expect(planDesignLens([PLAN_DESIGN_REVIEW_KIND], role)).toBeNull();
      }
    }
  });
});
