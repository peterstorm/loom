import { describe, it, expect } from "vitest";
import { applyReviewResolution, resolveReviewFindings, reviewResolutionLog } from "../../src/core/review-output";
import { claimsOfSeverity } from "../../src/core/findings";
import { parseMachineSummary, parseLegacyFindings, makeParsedFindings, buildEvidenceFailureMessage, reconcileFindings } from "../../src/core/review-output";
import { mergeFindings } from "../../src/core/findings";
import { isReviewAgent } from "../../src/core/review-output";
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

  it("CRITICAL_COUNT: 0 with a 'CRITICAL: none' sentinel yields no findings", () => {
    const output = [
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL: none",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
    expect(result!.critical).toEqual([]);
  });

  it("matches ## heading level", () => {
    const output = "## Machine Summary\nCRITICAL_COUNT: 1\nCRITICAL: issue\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(1);
    expect(result!.critical).toEqual(["issue"]);
  });

  it("matches #### heading level", () => {
    const output = "#### Machine Summary\nCRITICAL_COUNT: 0\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
  });

  it("matches bold heading: ### **Machine Summary**", () => {
    const output = "### **Machine Summary**\nCRITICAL_COUNT: 0\nADVISORY: minor thing\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
    expect(result!.advisory).toEqual(["minor thing"]);
  });

  it("matches MACHINE_SUMMARY (no markdown heading)", () => {
    const output = "MACHINE_SUMMARY\nCRITICAL_COUNT: 2\nCRITICAL: a\nCRITICAL: b\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(2);
    expect(result!.critical).toEqual(["a", "b"]);
  });

  it("matches MACHINE SUMMARY (space variant)", () => {
    const output = "MACHINE SUMMARY\nCRITICAL_COUNT: 0\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(0);
  });

  it("handles bold CRITICAL_COUNT: **CRITICAL_COUNT** 3", () => {
    const output = "### Machine Summary\n**CRITICAL_COUNT** 3\nCRITICAL: x\n";
    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(3);
  });

  it("strips code fences from Machine Summary block", () => {
    const output = [
      "### Machine Summary",
      "```",
      "CRITICAL_COUNT: 1",
      "CRITICAL: found inside fence",
      "```",
    ].join("\n");

    const result = parseMachineSummary(output);
    expect(result).not.toBeNull();
    expect(result!.criticalCount).toBe(1);
    expect(result!.critical).toEqual(["found inside fence"]);
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

  it("matches ## Critical (two hashes, no 'Findings' suffix)", () => {
    const output = [
      "## Critical",
      "- XSS in template",
      "## Advisory",
      "- Consider refactor",
      "## Other",
    ].join("\n");

    const result = parseLegacyFindings(output);
    expect(result.critical).toEqual(["XSS in template"]);
    expect(result.advisory).toEqual(["Consider refactor"]);
  });

  it("falls back to line-scan when no section headings found", () => {
    const output = [
      "Here is my review output.",
      "CRITICAL_COUNT: 2",
      "CRITICAL: SQL injection in query builder",
      "CRITICAL: Missing auth check",
      "ADVISORY: Consider extracting validation",
    ].join("\n");

    const result = parseLegacyFindings(output);
    expect(result.criticalCount).toBe(2);
    expect(result.critical).toEqual([
      "SQL injection in query builder",
      "Missing auth check",
    ]);
    expect(result.advisory).toEqual(["Consider extracting validation"]);
  });

  it("handles bold CRITICAL_COUNT in legacy mode", () => {
    const output = "some text\n**CRITICAL_COUNT** 5\nmore text";
    const result = parseLegacyFindings(output);
    expect(result.criticalCount).toBe(5);
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
    const result = mergeFindings(baseTask, makeParsedFindings({
      critical: [],
      advisory: ["Consider refactor"],
      criticalCount: 0,
    }), "code-reviewer");

    expect(result.review_status).toBe("passed");
    expect(result.critical_findings).toEqual([]);
    expect(result.advisory_findings).toEqual(["Consider refactor"]);
  });

  it("sets review_status to blocked when criticals present", () => {
    const result = mergeFindings(baseTask, makeParsedFindings({
      critical: ["SQL injection"],
      advisory: [],
      criticalCount: 1,
    }), "code-reviewer");

    expect(result.review_status).toBe("blocked");
    expect(result.critical_findings).toEqual(["SQL injection"]);
  });

  it("accumulates findings from multiple agents", () => {
    const afterFirst = mergeFindings(baseTask, makeParsedFindings({
      critical: ["Issue from code-reviewer"],
      advisory: ["Advice from code-reviewer"],
      criticalCount: 1,
    }), "code-reviewer");

    const afterSecond = mergeFindings(afterFirst, makeParsedFindings({
      critical: [],
      advisory: ["Advice from silent-failure-hunter"],
      criticalCount: 0,
    }), "silent-failure-hunter");

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

    const result = mergeFindings(blockedTask, makeParsedFindings({
      critical: [],
      advisory: ["All good from me"],
      criticalCount: 0,
    }), "code-reviewer");

    expect(result.review_status).toBe("blocked");
    expect(result.critical_findings).toEqual(["Existing critical"]);
    expect(result.advisory_findings).toEqual(["All good from me"]);
  });

  it("escalates pending to blocked when criticals found", () => {
    const pendingTask: Task = { ...baseTask, review_status: "pending" };

    const result = mergeFindings(pendingTask, makeParsedFindings({
      critical: ["New critical"],
      advisory: [],
      criticalCount: 1,
    }), "code-reviewer");

    expect(result.review_status).toBe("blocked");
  });

  it("handles task with no prior findings (undefined arrays)", () => {
    // baseTask has no critical_findings or advisory_findings
    const result = mergeFindings(baseTask, makeParsedFindings({
      critical: ["First finding"],
      advisory: ["First advice"],
      criticalCount: 1,
    }), "code-reviewer");

    expect(result.critical_findings).toEqual(["First finding"]);
    expect(result.advisory_findings).toEqual(["First advice"]);
  });

  it("accumulates across three agents", () => {
    let task = baseTask;
    task = mergeFindings(task, makeParsedFindings({ critical: ["C1"], advisory: ["A1"], criticalCount: 1 }), "code-reviewer");
    task = mergeFindings(task, makeParsedFindings({ critical: [], advisory: ["A2"], criticalCount: 0 }), "silent-failure-hunter");
    task = mergeFindings(task, makeParsedFindings({ critical: ["C2"], advisory: ["A3"], criticalCount: 1 }), "pr-test-analyzer");

    expect(task.critical_findings).toEqual(["C1", "C2"]);
    expect(task.advisory_findings).toEqual(["A1", "A2", "A3"]);
    expect(task.review_status).toBe("blocked");
  });
});

describe("buildEvidenceFailureMessage (pure)", () => {
  it("returns generic message when no partial findings", () => {
    const msg = buildEvidenceFailureMessage(makeParsedFindings({ critical: [], advisory: [], criticalCount: null }));
    expect(msg).toBe("CRITICAL_COUNT marker not found in agent output");
  });

  it("surfaces partial counts when section parsing extracted findings", () => {
    const msg = buildEvidenceFailureMessage(makeParsedFindings({
      critical: ["XSS in template", "SQL injection"],
      advisory: ["Refactor advised"],
      criticalCount: null,
    }));
    expect(msg).toContain("partial findings extracted");
    expect(msg).toContain("2 critical");
    expect(msg).toContain("1 advisory");
  });
});

describe("reconcileFindings (pure)", () => {
  it("synthesizes placeholder when count > 0 but no critical findings parsed", () => {
    const result = reconcileFindings(makeParsedFindings({ critical: [], advisory: [], criticalCount: 3 }));
    expect(result.critical).toHaveLength(1);
    expect(result.critical[0]).toContain("3 findings not captured");
  });

  it("returns input unchanged when count and findings agree", () => {
    const input = makeParsedFindings({ critical: ["x"], advisory: [], criticalCount: 1 });
    expect(reconcileFindings(input)).toBe(input);
  });

  it("returns input unchanged when count is 0", () => {
    const input = makeParsedFindings({ critical: [], advisory: ["a"], criticalCount: 0 });
    expect(reconcileFindings(input)).toBe(input);
  });

  it("returns input unchanged when count is null", () => {
    const input = makeParsedFindings({ critical: [], advisory: [], criticalCount: null });
    expect(reconcileFindings(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Which source wins when the reviewer's three descriptions disagree
// ---------------------------------------------------------------------------

const partialTask: Task = {
  id: "T1",
  description: "d",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  depends_on: [],
};

describe("the structured block never costs a claim the markers made", () => {
  const summary = (count: number, criticals: readonly string[], block: string | null) =>
    [
      "### Machine Summary",
      `CRITICAL_COUNT: ${count}`,
      ...criticals.map((claim) => `CRITICAL: ${claim}`),
      ...(block === null ? [] : ["```findings", block, "```"]),
    ].join("\n");

  const entry = (claim: string, severity = "critical") =>
    ({ severity, file: "src/x.ts", line: 4, claim });

  it("uses the block when it accounts for every critical — locations are the win", () => {
    const result = parseMachineSummary(
      summary(2, ["leak in the cache", "unchecked cast"], JSON.stringify([
        entry("leak in the cache"),
        entry("unchecked cast"),
      ])),
    );
    expect(result?.blockStatus).toBe("used");
    expect(result?.critical).toEqual(["leak in the cache", "unchecked cast"]);
    expect(result?.drafts.every((d) => d.file === "src/x.ts")).toBe(true);
  });

  it("keeps every claim when the block under-reports the criticals", () => {
    // The bug this pins: the block used to replace the scraped CRITICAL: lines
    // outright while criticalCount still came from the markers. A two-entry
    // block against three marker lines silently dropped one critical, and the
    // survivors made the gate look like it had seen everything.
    const result = parseMachineSummary(
      summary(3, ["leak in the cache", "unchecked cast", "race on the queue"], JSON.stringify([
        entry("leak in the cache"),
        entry("unchecked cast"),
      ])),
    );
    expect(result?.blockStatus).toBe("superseded");
    expect(result?.critical).toEqual(["leak in the cache", "unchecked cast", "race on the queue"]);
  });

  it("still prefers a block that supplies criticals the marker lines omitted", () => {
    // The inverse: a reviewer that emitted only the block. Falling back here
    // would throw away its findings and report a parse failure instead.
    const result = parseMachineSummary(
      summary(2, [], JSON.stringify([entry("leak in the cache"), entry("unchecked cast")])),
    );
    expect(result?.blockStatus).toBe("used");
    expect(result?.critical).toEqual(["leak in the cache", "unchecked cast"]);
  });

  it("reports a malformed block rather than degrading in silence", () => {
    const result = parseMachineSummary(summary(1, ["unchecked cast"], "[{not json"));
    expect(result?.blockStatus).toBe("rejected");
    expect(result?.critical).toEqual(["unchecked cast"]);
  });

  it("says nothing when no block was offered", () => {
    expect(parseMachineSummary(summary(1, ["unchecked cast"], null))?.blockStatus).toBe("absent");
  });

  it("tells the operator when locations were lost", () => {
    const degraded = resolveReviewFindings(summary(1, ["unchecked cast"], "[{not json"), "code-reviewer");
    expect(reviewResolutionLog("T1", degraded)).toContain("findings block was malformed");
    const clean = resolveReviewFindings(summary(1, ["unchecked cast"], null), "code-reviewer");
    expect(reviewResolutionLog("T1", clean)).toBe("Task T1 review: blocked (1 critical)");
  });
});

describe("reconcileFindings backstops a SHORTFALL, not only a total loss", () => {
  it("marks the gap when fewer criticals were captured than counted", () => {
    const result = reconcileFindings(makeParsedFindings({ critical: ["one"], criticalCount: 3 }));
    expect(result.critical).toHaveLength(2);
    expect(result.critical[0]).toBe("Review output parsing failed - 2 of 3 critical findings not captured");
    expect(result.critical[1], "the captured claim is kept, not replaced").toBe("one");
  });

  it("keeps the total-loss wording when nothing was captured", () => {
    const result = reconcileFindings(makeParsedFindings({ critical: [], criticalCount: 3 }));
    expect(result.critical).toEqual(["Review output parsing failed - 3 findings not captured"]);
  });

  it("is a no-op when the capture matches or exceeds the count", () => {
    for (const [critical, count] of [[["a", "b"], 2], [["a", "b", "c"], 2]] as const) {
      const input = makeParsedFindings({ critical: [...critical], criticalCount: count });
      expect(reconcileFindings(input)).toBe(input);
    }
  });

  it("a partially-parsed reviewer still blocks the wave", () => {
    const resolution = resolveReviewFindings(
      ["### Machine Summary", "CRITICAL_COUNT: 3", "CRITICAL: leak in the cache"].join("\n"),
      "code-reviewer",
    );
    expect(resolution.kind).toBe("findings");
    if (resolution.kind !== "findings") return;
    const task = applyReviewResolution(partialTask, resolution);
    expect(task.review_status).toBe("blocked");
    expect(task.critical_findings).toHaveLength(2);
    expect(task.critical_findings).toEqual(claimsOfSeverity(task.findings ?? [], "critical"));
  });
});
