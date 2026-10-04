import { describe, expect, it } from "vitest";
import { scopeCovers } from "../../src/core/artifact-baseline";
import { constrainReviewResolutionToScope, makeParsedFindings } from "../../src/core/review-output";

describe("scopeCovers", () => {
  it("covers exact paths and paths below a directory artifact, never prefix siblings", () => {
    const scope = ["calibration/run", "src/a.ts"];
    expect(scopeCovers(scope, "src/a.ts")).toBe(true);
    expect(scopeCovers(scope, "calibration/run/core.ts")).toBe(true);
    expect(scopeCovers(scope, "calibration/runner.ts")).toBe(false);
    expect(scopeCovers(scope, "src/a.tsx")).toBe(false);
  });
});

describe("constrainReviewResolutionToScope", () => {
  const resolution = (file: string) => ({
    kind: "findings" as const,
    agent: "code-reviewer",
    findings: makeParsedFindings({
      drafts: [{ severity: "critical" as const, file, line: 3, claim: "defect" }],
      criticalCount: 1,
      advisoryCount: 0,
    }),
  });

  it("accepts a finding located below a declared directory artifact", () => {
    const located = resolution("calibration/run/core.ts");
    expect(constrainReviewResolutionToScope(located, ["calibration/run"])).toBe(located);
  });

  it("still rejects a finding outside every scoped artifact", () => {
    expect(constrainReviewResolutionToScope(resolution("calibration/runner.ts"), ["calibration/run"]))
      .toMatchObject({ kind: "evidence-failed" });
  });
});
