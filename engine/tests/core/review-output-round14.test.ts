/**
 * Round-14 remediation: the three ways a reviewer's transcript could lose a
 * finding on its way into the task graph, and the advisory backstop that never
 * existed.
 *
 * The module's stated rule is that no finding is ever lost — degraded, maybe,
 * duplicated at worst, but never deleted. Each block below is a path where that
 * did not hold.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  carriedOverCount,
  parseLegacyFindings,
  parseMachineSummary,
  reconcileFindings,
  resolveReviewFindings,
  reviewResolutionLog,
} from "../../src/core/review-output";
import { isNoFindingSentinel } from "../../src/utils/no-finding-sentinel";

const block = (entries: readonly Record<string, unknown>[]): string =>
  ["```findings", JSON.stringify(entries), "```"].join("\n");

// ---------------------------------------------------------------------------
// A1 — a LOSING block must not be deleted
// ---------------------------------------------------------------------------

describe("a block that loses arbitration still contributes its claims", () => {
  it("keeps the block's real claim when there are no marker lines at all", () => {
    // The bug in full: a reviewer emits CRITICAL_COUNT plus a well-formed block
    // but no CRITICAL: lines (plausible — the block already says everything).
    // The scraped set is empty, so the block "under-reports" against the count,
    // loses, and every located claim it named was thrown away. reconcileFindings
    // then replaced a real blocker with a synthetic "1 findings not captured"
    // that no verifier can adjudicate.
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "",
      block([{ severity: "critical", file: "src/a.ts", line: 3, claim: "real blocker A" }]),
    ].join("\n");

    const parsed = parseMachineSummary(transcript);
    expect(parsed).not.toBeNull();
    expect(parsed!.blockStatus.kind).toBe("superseded");
    expect(parsed!.critical).toContain("real blocker A");
    expect(carriedOverCount(parsed!.blockStatus)).toBe(1);
  });

  it("the surviving claim keeps its file and line", () => {
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      block([{ severity: "critical", file: "src/a.ts", line: 3, claim: "real blocker A" }]),
    ].join("\n");
    const parsed = parseMachineSummary(transcript)!;
    const carried = parsed.drafts.find((d) => d.claim === "real blocker A")!;
    expect(carried.file).toBe("src/a.ts");
    expect(carried.line).toBe(3);
  });

  it("does not duplicate a claim the markers already named", () => {
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 3",
      "CRITICAL: shared claim",
      block([{ severity: "critical", file: null, line: null, claim: "shared claim" }]),
    ].join("\n");
    const parsed = parseMachineSummary(transcript)!;
    expect(parsed.blockStatus.kind).toBe("superseded");
    expect(parsed.critical.filter((c) => c === "shared claim")).toHaveLength(1);
    expect(carriedOverCount(parsed.blockStatus)).toBe(0);
  });

  it("reconciliation counts what actually survived, not what the markers held", () => {
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 0",
      block([{ severity: "critical", file: "src/a.ts", line: 3, claim: "real blocker A" }]),
    ].join("\n");
    const resolved = resolveReviewFindings(transcript, "code-reviewer");
    expect(resolved.kind).toBe("findings");
    if (resolved.kind !== "findings") return;
    // One real claim recovered, one genuinely missing → a shortfall of exactly 1.
    expect(resolved.findings.critical).toContain("real blocker A");
    expect(resolved.findings.critical.join(" ")).toContain("1 of 2 critical findings not captured");
  });

  it("property: no claim of either severity is lost, whoever wins", () => {
    // Exclude sentinels by asking the production classifier, not a hand-rolled
    // subset of it: an inlined `none|n/a|nothing` regex still admits `na`,
    // `nil`, `null` and the punctuated forms, which the parser drops on
    // purpose — so the generator produced claims the property then demanded be
    // preserved, and the suite failed on roughly one seed in 1700.
    const claim = fc.string({ minLength: 3, maxLength: 12 })
      .filter((s) => s.trim() !== "" && !isNoFindingSentinel(s) && !/[\r\n{}"\\]/.test(s));
    fc.assert(
      fc.property(
        fc.uniqueArray(claim, { maxLength: 3 }),
        fc.uniqueArray(claim, { maxLength: 3 }),
        fc.integer({ min: 0, max: 4 }),
        (markerClaims, blockClaims, declared) => {
          const transcript = [
            "### Machine Summary",
            `CRITICAL_COUNT: ${declared}`,
            ...markerClaims.map((c) => `CRITICAL: ${c}`),
            block(blockClaims.map((c) => ({ severity: "critical", file: null, line: null, claim: c }))),
          ].join("\n");
          const parsed = parseMachineSummary(transcript);
          if (parsed === null) return false;
          // Compared on the NORMALIZED form, because that is what a claim is
          // once `makeDraftFinding` has built it: internal whitespace runs are
          // collapsed on both the marker path and the block path, identically.
          const normalize = (c: string) => c.replace(/\s+/g, " ").trim();
          const recorded = new Set(parsed.critical.map(normalize));
          // Every claim EITHER side made is somewhere in the result.
          return [...markerClaims, ...blockClaims].every((c) => recorded.has(normalize(c)));
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// A3 — the legacy path arbitrates too
// ---------------------------------------------------------------------------

describe("a block under an unrecognized heading is not reported as absent", () => {
  const BOLD_HEADING = [
    "**Machine Summary**",
    "CRITICAL_COUNT: 1",
    "CRITICAL: null deref in parser",
    block([{ severity: "critical", file: "src/p.ts", line: 9, claim: "null deref in parser" }]),
  ].join("\n");

  it("parseMachineSummary does not match the bold heading (the precondition)", () => {
    expect(parseMachineSummary(BOLD_HEADING)).toBeNull();
  });

  it("the legacy path keeps the block's file and line", () => {
    // It used to return the scraped claims directly: file/line dropped, and
    // blockStatus reported "absent" — the one value documented to mean "the
    // reviewer emitted no block" — so no degradation note printed either.
    const parsed = parseLegacyFindings(BOLD_HEADING);
    expect(parsed.blockStatus.kind).toBe("used");
    const finding = parsed.drafts.find((d) => d.claim === "null deref in parser")!;
    expect(finding.file).toBe("src/p.ts");
    expect(finding.line).toBe(9);
  });

  it("a malformed block on the legacy path is reported as rejected, not absent", () => {
    const malformed = ["**Machine Summary**", "CRITICAL_COUNT: 1", "CRITICAL: x", "```findings", "{not json", "```"].join("\n");
    expect(parseLegacyFindings(malformed).blockStatus.kind).toBe("rejected");
  });

  it("genuinely blockless output is still 'absent'", () => {
    expect(parseLegacyFindings("CRITICAL_COUNT: 0").blockStatus.kind).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// A4 — ADVISORY_COUNT is parsed and reconciled
// ---------------------------------------------------------------------------

describe("ADVISORY_COUNT is an authority, not decoration", () => {
  it("is parsed off the transcript", () => {
    const parsed = parseMachineSummary("### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 4")!;
    expect(parsed.advisoryCount).toBe(4);
  });

  it("a shortfall becomes a self-describing advisory entry", () => {
    // The wave gate's advisory-disposition step (the `await-user` action in
    // `commands/wave-gate.md`) must triage every advisory to fixed/deferred/dismissed.
    // It cannot triage what a failed scrape silently dropped, and there was no
    // advisory analogue of the critical backstop.
    const parsed = parseMachineSummary(
      "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 3\nADVISORY: only one survived",
    )!;
    const reconciled = reconcileFindings(parsed);
    expect(reconciled.advisory).toHaveLength(2);
    expect(reconciled.advisory.join(" ")).toContain("2 of 3 advisory findings not captured");
  });

  it("the synthetic entry keeps its own severity — a lost advisory is not a blocker", () => {
    const parsed = parseMachineSummary("### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 2")!;
    const reconciled = reconcileFindings(parsed);
    expect(reconciled.critical).toEqual([]);
    expect(reconciled.advisory).toHaveLength(1);
    expect(reviewResolutionLog("T1", { kind: "findings", agent: "code-reviewer", findings: reconciled }))
      .toContain("passed (0 critical)");
  });

  it("reconciles both severities in one pass", () => {
    const parsed = parseMachineSummary("### Machine Summary\nCRITICAL_COUNT: 2\nADVISORY_COUNT: 2")!;
    const reconciled = reconcileFindings(parsed);
    expect(reconciled.critical).toHaveLength(1);
    expect(reconciled.advisory).toHaveLength(1);
  });

  it("fails evidence capture when the mandatory ADVISORY_COUNT marker is missing", () => {
    const resolved = resolveReviewFindings("### Machine Summary\nCRITICAL_COUNT: 0", "code-reviewer");
    expect(resolved).toMatchObject({
      kind: "evidence-failed",
      message: expect.stringContaining("ADVISORY_COUNT marker not found"),
    });
  });

  it("property: a shortfall is always reported, and a met count is never padded", () => {
    // The backstop names the shortfall in ONE self-describing entry — it does
    // not fabricate N placeholder findings, on either severity. So the invariant
    // is about the presence of the report, not about the length matching.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 6 }), (declared, emitted) => {
        const parsed = parseMachineSummary(
          [
            "### Machine Summary",
            "CRITICAL_COUNT: 0",
            `ADVISORY_COUNT: ${declared}`,
            ...Array.from({ length: emitted }, (_, i) => `ADVISORY: nit ${i}`),
          ].join("\n"),
        )!;
        const reconciled = reconcileFindings(parsed);
        const reported = reconciled.advisory.filter((c) => c.includes("Review output parsing failed"));
        const short = declared > emitted;
        if (short) return reported.length === 1 && reconciled.advisory.length === emitted + 1;
        return reported.length === 0 && reconciled.advisory.length === emitted;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// A2 — the duplication arbitration accepts is at least VISIBLE
// ---------------------------------------------------------------------------

describe("the operator is told how many claims were carried over", () => {
  it("reports the duplicate count when a block rewords every marker claim", () => {
    // Arbitration is cardinal on purpose: demanding verbatim text would reject
    // every reworded block and permanently cost the file/line. The accepted cost
    // is that a reworded claim arrives twice and burns a verifier vote. That is
    // the right trade and it must not be invisible.
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "CRITICAL: unchecked cast in the reducer",
      "CRITICAL: swallowed error in the catch",
      block([
        { severity: "critical", file: "src/a.ts", line: 1, claim: "the reducer casts without checking" },
        { severity: "critical", file: "src/b.ts", line: 2, claim: "the catch block swallows" },
      ]),
    ].join("\n");

    const parsed = parseMachineSummary(transcript)!;
    expect(parsed.blockStatus.kind).toBe("partial");
    expect(parsed.critical).toHaveLength(4);
    expect(carriedOverCount(parsed.blockStatus)).toBe(2);

    const log = reviewResolutionLog("T1", { kind: "findings", agent: "code-reviewer", findings: parsed });
    expect(log).toContain("2 claim(s) carried over");
    expect(log).toContain("adjudicated twice");
  });

  it("says nothing when the block named everything", () => {
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "CRITICAL: same claim",
      block([{ severity: "critical", file: "src/a.ts", line: 1, claim: "same claim" }]),
    ].join("\n");
    const parsed = parseMachineSummary(transcript)!;
    expect(parsed.blockStatus.kind).toBe("used");
    expect(reviewResolutionLog("T1", { kind: "findings", agent: "code-reviewer", findings: parsed }))
      .toBe("Task T1 review: blocked (1 critical)");
  });
});
