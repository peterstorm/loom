import { describe, it, expect } from "vitest";
import { parseMachineSummary, parseLegacyFindings, isReviewAgent, mergeFindings } from "../../src/handlers/subagent-stop/store-reviewer-findings";
import { REVIEW_SUB_AGENTS } from "../../src/config";
import type { Task } from "../../src/types";

describe("parseMachineSummary (pure)", () => {
  it("parses structured Machine Summary block", () => {
    const output = [
      "Some preamble",
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 1",
      "CRITICAL: SQL injection in query builder",
      "CRITICAL: Missing auth check on endpoint",
      "ADVISORY: Consider extracting validation",
      "",
      "### Other section",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(2);
    expect(result!.critical).toEqual([
      "SQL injection in query builder",
      "Missing auth check on endpoint",
    ]);
    expect(result!.advisory).toEqual(["Consider extracting validation"]);
  });

  it("returns null when no Machine Summary block", () => {
    expect(parseMachineSummary("just plain text")).toBeNull();
  });

  it("handles zero findings", () => {
    const output = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0\n\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
    expect(result!.critical).toEqual([]);
  });

  it("finds last Machine Summary, not skill template", () => {
    const output = [
      "### Machine Summary",
      "CRITICAL_COUNT: {number of critical issues}",
      "ADVISORY_COUNT: {number of important + suggestion issues}",
      "CRITICAL: {each critical finding on its own line}",
      "ADVISORY: {each non-critical finding on its own line}",
      "",
      "Some other review text...",
      "",
      "### Machine Summary",
      "CRITICAL_COUNT: 3",
      "ADVISORY_COUNT: 5",
      "CRITICAL: SQL injection in db.ts",
      "CRITICAL: Connection leak",
      "CRITICAL: Type mismatch",
      "ADVISORY: Missing test coverage",
      "ADVISORY: Consider extracting validation",
      "ADVISORY: Code duplication in service layer",
      "ADVISORY: Incomplete error handling",
      "ADVISORY: Performance concern in loop",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(3);
    expect(result!.critical).toHaveLength(3);
    expect(result!.critical).toEqual([
      "SQL injection in db.ts",
      "Connection leak",
      "Type mismatch",
    ]);
    expect(result!.advisory).toHaveLength(5);
    expect(result!.advisory).toContain("Missing test coverage");
    expect(result!.advisory).toContain("Performance concern in loop");
  });

  it("filters empty strings after CRITICAL: and ADVISORY: markers", () => {
    const output = [
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL: ",
      "ADVISORY: ",
      "CRITICAL:   ",
      "ADVISORY:   ",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
    expect(result!.critical).toEqual([]);
    expect(result!.advisory).toEqual([]);
  });

  it("CRITICAL_COUNT line is NOT captured as a finding (negative lookahead)", () => {
    const output = [
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 1",
      "CRITICAL: SQL injection in query builder",
      "CRITICAL: Missing auth check on endpoint",
      "ADVISORY: Consider extracting validation",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    // CRITICAL_COUNT should NOT appear in findings
    expect(result!.critical).toEqual([
      "SQL injection in query builder",
      "Missing auth check on endpoint",
    ]);
    expect(result!.critical).not.toContainEqual(expect.stringContaining("_COUNT"));
  });

  it("ADVISORY_COUNT line is NOT captured as a finding (negative lookahead)", () => {
    const output = [
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 3",
      "ADVISORY: Finding one",
      "ADVISORY: Finding two",
      "ADVISORY: Finding three",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.advisory).toHaveLength(3);
    expect(result!.advisory).not.toContainEqual(expect.stringContaining("_COUNT"));
  });

  it("CRITICAL_COUNT: 0 followed by real CRITICAL finding captures only the finding", () => {
    const output = [
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL: real finding that should be captured",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
    expect(result!.critical).toEqual(["real finding that should be captured"]);
  });
});

describe("parseLegacyFindings (pure)", () => {
  it("parses Critical/Advisory sections", () => {
    const output = [
      "### Critical Findings",
      "- **XSS vulnerability in template**",
      "- Missing input sanitization",
      "### Advisory Findings",
      "- Consider using parameterized queries",
      "### Other",
    ].join("\n");

    const result = parseLegacyFindings(output);
    expect(result.critical.length).toBe(2);
    expect(result.advisory.length).toBe(1);
  });

  it("skips None entries", () => {
    const output = [
      "### Critical Findings",
      "- None",
      "### Advisory Findings",
      "- None",
      "### Other",
    ].join("\n");

    const result = parseLegacyFindings(output);
    expect(result.critical).toEqual([]);
    expect(result.advisory).toEqual([]);
  });

  it("extracts CRITICAL_COUNT from body", () => {
    const output = "blah\nCRITICAL_COUNT: 5\nblah";
    const result = parseLegacyFindings(output);
    expect(result.criticalCount).toBe(5);
  });

  it("returns null criticalCount when marker missing", () => {
    const result = parseLegacyFindings("no markers here");
    expect(result.criticalCount).toBeNull();
  });
});

describe("isReviewAgent (pure)", () => {
  it("accepts all REVIEW_SUB_AGENTS", () => {
    for (const agent of REVIEW_SUB_AGENTS) {
      expect(isReviewAgent(agent)).toBe(true);
    }
  });

  it("rejects non-review agents", () => {
    expect(isReviewAgent("spec-check-invoker")).toBe(false);
    expect(isReviewAgent("code-implementer-agent")).toBe(false);
    expect(isReviewAgent("random-agent")).toBe(false);
    expect(isReviewAgent("")).toBe(false);
  });
});

describe("mergeFindings (pure)", () => {
  const baseTask: Task = {
    id: "T1",
    description: "Test task",
    agent: "test",
    wave: 1,
    status: "implemented",
    depends_on: [],
  };

  it("sets review_status to passed when no criticals", () => {
    const result = mergeFindings(baseTask, {
      critical: [],
      advisory: ["Consider refactor"],
      criticalCount: 0,
    });

    expect(result.review_status).toBe("passed");
    expect(result.critical_findings).toEqual([]);
    expect(result.advisory_findings).toEqual(["Consider refactor"]);
  });

  it("sets review_status to blocked when criticals present", () => {
    const result = mergeFindings(baseTask, {
      critical: ["SQL injection"],
      advisory: [],
      criticalCount: 1,
    });

    expect(result.review_status).toBe("blocked");
    expect(result.critical_findings).toEqual(["SQL injection"]);
  });

  it("accumulates findings from multiple agents", () => {
    const afterFirst = mergeFindings(baseTask, {
      critical: ["Issue from code-reviewer"],
      advisory: ["Advice from code-reviewer"],
      criticalCount: 1,
    });

    const afterSecond = mergeFindings(afterFirst, {
      critical: [],
      advisory: ["Advice from silent-failure-hunter"],
      criticalCount: 0,
    });

    expect(afterSecond.critical_findings).toEqual(["Issue from code-reviewer"]);
    expect(afterSecond.advisory_findings).toEqual([
      "Advice from code-reviewer",
      "Advice from silent-failure-hunter",
    ]);
  });

  it("never demotes blocked to passed", () => {
    const blockedTask: Task = {
      ...baseTask,
      review_status: "blocked",
      critical_findings: ["Existing critical"],
      advisory_findings: [],
    };

    const result = mergeFindings(blockedTask, {
      critical: [],
      advisory: ["All good from me"],
      criticalCount: 0,
    });

    expect(result.review_status).toBe("blocked");
    expect(result.critical_findings).toEqual(["Existing critical"]);
    expect(result.advisory_findings).toEqual(["All good from me"]);
  });

  it("escalates pending to blocked when criticals found", () => {
    const pendingTask: Task = { ...baseTask, review_status: "pending" };

    const result = mergeFindings(pendingTask, {
      critical: ["New critical"],
      advisory: [],
      criticalCount: 1,
    });

    expect(result.review_status).toBe("blocked");
  });

  it("handles task with no prior findings (undefined arrays)", () => {
    // baseTask has no critical_findings or advisory_findings
    const result = mergeFindings(baseTask, {
      critical: ["First finding"],
      advisory: ["First advice"],
      criticalCount: 1,
    });

    expect(result.critical_findings).toEqual(["First finding"]);
    expect(result.advisory_findings).toEqual(["First advice"]);
  });

  it("accumulates across three agents", () => {
    let task = baseTask;
    task = mergeFindings(task, { critical: ["C1"], advisory: ["A1"], criticalCount: 1 });
    task = mergeFindings(task, { critical: [], advisory: ["A2"], criticalCount: 0 });
    task = mergeFindings(task, { critical: ["C2"], advisory: ["A3"], criticalCount: 1 });

    expect(task.critical_findings).toEqual(["C1", "C2"]);
    expect(task.advisory_findings).toEqual(["A1", "A2", "A3"]);
    expect(task.review_status).toBe("blocked");
  });
});
