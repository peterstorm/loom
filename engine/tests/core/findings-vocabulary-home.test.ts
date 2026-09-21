/**
 * The Finding/ReviewRun/Refutation vocabulary's one home (atl-2).
 *
 * The shapes moved from the types.ts catch-all into core/findings.ts — the
 * Finding concept's one owner (shape AND behaviour) — and types.ts re-exports
 * them so the import surface is unchanged. These pins hold the re-export
 * contract: the runtime tuples must be the same objects, and the type
 * re-exports must remain the same declarations the Task schema-root fields
 * use.
 */

import { describe, expect, it } from "vitest";
import {
  FINDING_SEVERITIES,
  PRIOR_FINDING_VERDICTS,
  type Finding,
  type ReviewRun,
} from "../../src/core/findings";
import {
  FINDING_SEVERITIES as FINDING_SEVERITIES_VIA_TYPES,
  PRIOR_FINDING_VERDICTS as PRIOR_FINDING_VERDICTS_VIA_TYPES,
  type Finding as FindingViaTypes,
  type ReviewRun as ReviewRunViaTypes,
} from "../../src/types";

describe("the Finding vocabulary's one home", () => {
  it("is defined once in core/findings and re-exported by types.ts unchanged", () => {
    expect(FINDING_SEVERITIES_VIA_TYPES).toBe(FINDING_SEVERITIES);
    expect(PRIOR_FINDING_VERDICTS_VIA_TYPES).toBe(PRIOR_FINDING_VERDICTS);
  });

  it("keeps the Task schema-root fields and the vocabulary the same declarations", () => {
    // The types.ts re-export is the SAME declaration, not a structural copy:
    // a Finding built against either import path must satisfy the other, and
    // the same holds for the ReviewRun authority the Task carries.
    const finding: FindingViaTypes = {
      severity: "critical",
      file: null,
      line: null,
      claim: "a reviewer claim",
      id: "code-reviewer-1",
      agent: "code-reviewer",
    };
    const sameFinding: Finding = finding;
    expect(sameFinding.id).toBe("code-reviewer-1");

    const run: ReviewRunViaTypes = {
      generation: 3,
      packet_id: "a".repeat(64),
      head_sha: "b".repeat(40),
      expected_agents: ["code-reviewer"],
      prior_finding_ids: ["code-reviewer-1"],
      evidence: [],
    };
    const sameRun: ReviewRun = run;
    expect(sameRun.generation).toBe(3);
  });
});
