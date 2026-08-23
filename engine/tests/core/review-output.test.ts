import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyReviewResolution, resolveReviewFindings, reviewResolutionLog } from "../../src/core/review-output";
import { claimsOfSeverity, removeOnce } from "../../src/core/findings";
import { parseMachineSummary, parseLegacyFindings, makeParsedFindings, buildEvidenceFailureMessage, reconcileFindings } from "../../src/core/review-output";
import { mergeFindings } from "../../src/core/findings";
import { isReviewAgent } from "../../src/config";
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

describe("the declared count survives a skill-template echo", () => {
  // `parseMachineSummary` slices from the LAST heading precisely because agents
  // echo the template before their real output. The legacy fallback reads the
  // count from the WHOLE transcript, where that echo is likeliest — so a
  // first-match read lets a templated `CRITICAL_COUNT: 0` outrank the real
  // count, and `reconcileFindings`'s shortfall backstop is gated on `count > 0`
  // and never fires to notice it.
  it("takes the LAST count marker, not an earlier echoed one", () => {
    const output = [
      "I will end with this block:",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "",
      "### Critical Findings",
      "- **Fail-open guard in the evidence reader**",
      "### Advisory Findings",
      "- Consider naming the helper",
      "### Other",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 1",
    ].join("\n");

    const result = parseLegacyFindings(output);

    expect(result.criticalCount).toBe(1);
    expect(result.advisoryCount).toBe(1);
    expect(result.critical).toHaveLength(1);
  });

  it("still reports an absent marker as absent rather than zero", () => {
    const result = parseLegacyFindings([
      "### Critical Findings",
      "- **Something real**",
      "### Other",
    ].join("\n"));

    expect(result.criticalCount).toBeNull();
  });

  it("keeps the last marker inside a Machine Summary too", () => {
    const output = [
      "Template I was given:",
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "",
      "Now my real answer:",
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 0",
      "CRITICAL: first real defect",
      "CRITICAL: second real defect",
    ].join("\n");

    const result = parseMachineSummary(output);

    expect(result?.criticalCount).toBe(2);
    expect(result?.critical).toHaveLength(2);
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
    expect(msg).toBe(
      "CRITICAL_COUNT marker not found; ADVISORY_COUNT marker not found in agent output",
    );
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
    expect(result.critical[0]).toContain("3 critical findings not captured");
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
  const summary = (
    count: number,
    criticals: readonly string[],
    block: string | null,
    advisories: readonly string[] = [],
  ) =>
    [
      "### Machine Summary",
      `CRITICAL_COUNT: ${count}`,
      `ADVISORY_COUNT: ${advisories.length}`,
      ...criticals.map((claim) => `CRITICAL: ${claim}`),
      ...advisories.map((claim) => `ADVISORY: ${claim}`),
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
    expect(result?.blockStatus.kind).toBe("used");
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
    expect(result?.blockStatus.kind).toBe("superseded");
    expect(result?.critical).toEqual(["leak in the cache", "unchecked cast", "race on the queue"]);
  });

  it("still prefers a block that supplies criticals the marker lines omitted", () => {
    // The inverse: a reviewer that emitted only the block. Falling back here
    // would throw away its findings and report a parse failure instead.
    const result = parseMachineSummary(
      summary(2, [], JSON.stringify([entry("leak in the cache"), entry("unchecked cast")])),
    );
    expect(result?.blockStatus.kind).toBe("used");
    expect(result?.critical).toEqual(["leak in the cache", "unchecked cast"]);
  });

  it("reports a malformed block rather than degrading in silence", () => {
    const result = parseMachineSummary(summary(1, ["unchecked cast"], "[{not json"));
    expect(result?.blockStatus).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("invalid JSON"),
    });
    expect(result?.critical).toEqual(["unchecked cast"]);
  });

  it("says nothing when no block was offered", () => {
    expect(parseMachineSummary(summary(1, ["unchecked cast"], null))?.blockStatus.kind).toBe("absent");
  });

  it("tells the operator when locations were lost", () => {
    const degraded = resolveReviewFindings(summary(1, ["unchecked cast"], "[{not json"), "code-reviewer");
    expect(reviewResolutionLog("T1", degraded)).toContain("findings block was malformed (invalid JSON:");
    const clean = resolveReviewFindings(summary(1, ["unchecked cast"], null), "code-reviewer");
    expect(reviewResolutionLog("T1", clean)).toBe("Task T1 review: blocked (1 critical)");
  });

  // -- the advisory half of the same rule ------------------------------------

  it("keeps every advisory when a criticals-only block would have eaten them", () => {
    // The bug this pins: the block/marker arbitration counted CRITICALS only. A
    // block that accounted for every critical but listed no advisories won
    // outright and deleted all three ADVISORY: lines, with blockStatus still
    // reporting "used" so no degradation note was printed. The wave gate's
    // advisory-disposition step (the `await-user` action in `commands/wave-gate.md`)
    // must triage every advisory to fixed/deferred/dismissed; it cannot triage
    // what it never sees. And a criticals-only block is exactly what a reviewer
    // following the prompt literally emits — the prompt scopes its mandatory
    // block accounting to criticals.
    const result = parseMachineSummary(
      summary(1, ["unchecked cast"], JSON.stringify([entry("unchecked cast")]), [
        "advisory one",
        "advisory two",
        "advisory three",
      ]),
    );
    expect(result?.blockStatus.kind).toBe("superseded");
    expect(result?.advisory).toEqual(["advisory one", "advisory two", "advisory three"]);
    expect(result?.critical).toEqual(["unchecked cast"]);
  });

  it("uses a block that accounts for BOTH severities", () => {
    const result = parseMachineSummary(
      summary(1, ["unchecked cast"], JSON.stringify([
        entry("unchecked cast"),
        entry("advisory one", "advisory"),
      ]), ["advisory one"]),
    );
    expect(result?.blockStatus.kind).toBe("used");
    expect(result?.advisory).toEqual(["advisory one"]);
    expect(result?.drafts.every((d) => d.file === "src/x.ts")).toBe(true);
  });

  it("tells the operator when an under-reporting block was superseded", () => {
    // The "superseded" arm of blockStatusNote — its "rejected" sibling was
    // asserted above and this one was not, so the two strings could be swapped
    // with nothing failing.
    const degraded = resolveReviewFindings(
      summary(1, ["unchecked cast"], JSON.stringify([entry("unchecked cast")]), ["a nit"]),
      "code-reviewer",
    );
    expect(reviewResolutionLog("T1", degraded)).toContain("findings block under-reported findings");
  });

  // -- counting is necessary, and NOT sufficient -----------------------------

  it("carries over a marker claim the winning block never named", () => {
    // The bug this pins: arbitration compared only CARDINALITIES. A block with
    // as many entries as the markers claimed won outright even when its entries
    // named entirely different claims — and because it won, blockStatus said
    // "used", so blockStatusNote printed nothing, reconcileFindings saw a
    // matching count and stayed quiet, and findingsLockstepError passed because
    // the views were derived from the substituted set. Every backstop declined
    // to fire and the reviewer's actual critical was simply gone.
    const result = parseMachineSummary(
      summary(1, ["race on the queue"], JSON.stringify([
        entry("totally unrelated claim"),
        entry("another nit", "advisory"),
      ]), ["naming nit"]),
    );
    expect(result?.blockStatus.kind).toBe("partial");
    // The block's claims survive WITH their locations; the markers' claims
    // survive without. Neither side is discarded.
    expect(result?.critical).toEqual(["totally unrelated claim", "race on the queue"]);
    expect(result?.advisory).toEqual(["another nit", "naming nit"]);
    expect(result?.drafts.find((d) => d.claim === "totally unrelated claim")?.file).toBe("src/x.ts");
    expect(result?.drafts.find((d) => d.claim === "race on the queue")?.file).toBeNull();
  });

  it("treats a block that names one claim twice as naming it once", () => {
    // The multiset half. Two marker criticals, a two-entry block repeating one
    // of them: the count cleared the bar while only one distinct claim was
    // actually accounted for.
    const result = parseMachineSummary(
      summary(2, ["leak in the cache", "race on the queue"], JSON.stringify([
        entry("leak in the cache"),
        entry("leak in the cache"),
      ])),
    );
    expect(result?.blockStatus.kind).toBe("partial");
    expect(result?.critical).toEqual([
      "leak in the cache",
      "leak in the cache",
      "race on the queue",
    ]);
  });

  it("keeps a claim two reviewers worded identically", () => {
    // The reason the difference is a MULTISET and not a set. Two reviewers
    // worded a claim the same way; the block names it once and adds an unrelated
    // one, so the COUNT clears the bar and only a by-value multiset difference
    // can see that one of the two repeats was dropped. A set difference would
    // find nothing missing and lose it.
    const result = parseMachineSummary(
      summary(2, ["same wording", "same wording"], JSON.stringify([
        entry("same wording"),
        entry("something else"),
      ])),
    );
    expect(result?.blockStatus.kind).toBe("partial");
    expect(result?.critical).toEqual(["same wording", "something else", "same wording"]);
  });

  it("still supersedes a block that is simply too short", () => {
    // The count rule runs first and is unchanged: a block with fewer entries
    // than the markers claim is a truncated emission, so the markers win
    // wholesale rather than the block winning with a carry-over.
    const result = parseMachineSummary(
      summary(2, ["same wording", "same wording"], JSON.stringify([entry("same wording")])),
    );
    expect(result?.blockStatus.kind).toBe("superseded");
    expect(result?.critical).toEqual(["same wording", "same wording"]);
  });

  it("tells the operator when the block did not name every marker claim", () => {
    const degraded = resolveReviewFindings(
      summary(1, ["race on the queue"], JSON.stringify([entry("something else")])),
      "code-reviewer",
    );
    expect(reviewResolutionLog("T1", degraded)).toContain("did not name every marker claim");
  });

  it("never loses a claim of EITHER severity, for any block/marker combination", () => {
    // The property behind every example above. Its predecessor built the block
    // entries as a PREFIX SUBSET of the generated marker claims and asserted
    // only on lengths — two choices that together made it structurally incapable
    // of telling count-coverage from claim-coverage, which is how a block naming
    // disjoint claims passed it. Block claims now come from a DISJOINT alphabet,
    // and the assertion is multiset containment by value.
    // Collapse-stable by construction: `makeDraftFinding` normalizes internal
    // whitespace runs, so a generated `"a  b"` comes back as `"a b"` and the
    // by-value assertions below would be measuring normalization rather than
    // arbitration. Normalization has its own tests; this property is about
    // which side wins and what survives.
    const claim = (prefix: string) => fc.string({ minLength: 3, maxLength: 12 })
      .filter((s) => s.trim().length >= 3 && !/[\r\n]/.test(s))
      .map((s) => `${prefix} ${s.trim().replace(/\s+/g, " ")}`);
    const markerClaim = claim("m");
    const blockClaim = claim("b");
    fc.assert(
      fc.property(
        fc.uniqueArray(markerClaim, { maxLength: 4 }),
        fc.uniqueArray(markerClaim, { maxLength: 4 }),
        fc.array(blockClaim, { maxLength: 4 }),
        fc.array(blockClaim, { maxLength: 4 }),
        (criticals, advisories, blockCrit, blockAdv) => {
          const blockEntries = [
            ...blockCrit.map((c) => entry(c)),
            ...blockAdv.map((c) => entry(c, "advisory")),
          ];
          const result = parseMachineSummary(
            summary(criticals.length, criticals, JSON.stringify(blockEntries), advisories),
          );
          expect(result).not.toBeNull();
          // Every marker claim survives BY VALUE, at its own severity, however
          // the arbitration went. `removeOnce` returning empty is the multiset
          // containment statement.
          expect(removeOnce(criticals, result!.critical)).toEqual([]);
          expect(removeOnce(advisories, result!.advisory)).toEqual([]);
          // And nothing is invented: every surviving claim came from one side.
          const offered = [...criticals, ...advisories, ...blockCrit, ...blockAdv];
          for (const claim of [...result!.critical, ...result!.advisory]) {
            expect(offered).toContain(claim);
          }
        },
      ),
      { numRuns: 300 },
    );
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
    expect(result.critical).toEqual(["Review output parsing failed - 3 critical findings not captured"]);
  });

  it("is a no-op when the capture matches or exceeds the count", () => {
    for (const [critical, count] of [[["a", "b"], 2], [["a", "b", "c"], 2]] as const) {
      const input = makeParsedFindings({ critical: [...critical], criticalCount: count });
      expect(reconcileFindings(input)).toBe(input);
    }
  });

  it("a partially-parsed reviewer still blocks the wave", () => {
    const resolution = resolveReviewFindings(
      [
        "### Machine Summary",
        "CRITICAL_COUNT: 3",
        "ADVISORY_COUNT: 0",
        "CRITICAL: leak in the cache",
      ].join("\n"),
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
