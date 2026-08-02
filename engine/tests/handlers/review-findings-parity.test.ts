import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "../../src/types";
import { claimsOfSeverity, findingsLockstepError } from "../../src/core/findings";
import { mergeFindings } from "../../src/core/findings";
import {
  applyReviewResolution,
  makeParsedFindings,
  resolveReviewFindings,
  reviewResolutionLog,
} from "../../src/core/review-output";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PI_EXTENSION = readFileSync(join(REPO_ROOT, "pi", "extension.ts"), "utf-8");

const baseTask: Task = {
  id: "T1",
  description: "Test task",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  depends_on: [],
};

const TRANSCRIPT = [
  "Task: T1",
  "",
  "### Machine Summary",
  "CRITICAL_COUNT: 1",
  "CRITICAL: unchecked cast in the reducer",
  "ADVISORY: prefer a named constant",
].join("\n");

/**
 * Phase A changed six functions Pi imported directly and re-ran itself. Left
 * that way, Pi would keep writing the old `string[]`-only shape while Claude
 * Code wrote identified findings — findings would have identity on one harness
 * and not the other, and the review panel would work on one harness only.
 *
 * The fix was to collapse the two sequences into one. These tests pin that:
 * Pi must reach the shared decision + transform, and must NOT re-implement the
 * parse → reconcile → merge sequence out of the lower-level parts.
 *
 * What the structural assertions can and cannot prove: Pi's review logic lives
 * inside `export default function (pi: ExtensionAPI)` and needs the Pi runtime
 * to execute, so these grep the source rather than run it. That catches the
 * realistic regression — a harness quietly reaching for the lower-level parts
 * again — but it would not catch a harness that inlined its own copy under
 * different names. The output-contract test below is the other half: it pins
 * the exact task shape both shells must write.
 */
describe("harness parity: one path from transcript to task", () => {
  const CLAUDE_CODE_HOOK = readFileSync(
    join(REPO_ROOT, "engine", "src", "handlers", "subagent-stop", "store-reviewer-findings.ts"),
    "utf-8",
  );
  const HARNESSES: readonly (readonly [string, string])[] = [
    ["pi/extension.ts", PI_EXTENSION],
    ["engine/src/handlers/subagent-stop/store-reviewer-findings.ts", CLAUDE_CODE_HOOK],
  ];

  it.each(HARNESSES)("%s imports the shared path from core/review-output", (_name, source) => {
    // The import PATH, not just the function names: both shells must reach the
    // one pure module. A harness that grew its own copy would still mention the
    // names, and it is the shared module that makes drift impossible.
    expect(source).toContain('core/review-output"');
    for (const fn of ["resolveReviewFindings", "applyReviewResolution", "reviewResolutionLog"]) {
      expect(source, `${_name} must call ${fn}`).toContain(fn);
    }
  });

  it.each(HARNESSES)("%s does not re-run the sequence out of the lower-level parts", (_name, source) => {
    for (const fn of ["parseMachineSummary", "parseLegacyFindings", "reconcileFindings", "mergeFindings", "buildEvidenceFailureMessage"]) {
      expect(source, `${_name} must not call ${fn} directly — use the shared path`)
        .not.toContain(fn);
    }
  });

  it.each(HARNESSES)("%s does not hand-write the evidence_capture_failed transition", (_name, source) => {
    expect(source).not.toContain('"evidence_capture_failed" as const');
  });

  it.each(HARNESSES)("%s logs rather than silently discarding an unattributable review", (_name, source) => {
    // Every early return has to say so. A reviewer whose output is dropped in
    // silence is indistinguishable from one that found nothing, which is the
    // confusion evidence_capture_failed exists to prevent — and the Claude Code
    // hook used to return `passthrough` here with no output at all.
    const discardPoint = source.indexOf("extractTaskId");
    expect(discardPoint, `${_name} must extract a task id`).toBeGreaterThan(-1);
    expect(source.slice(discardPoint)).toContain("findings NOT stored");
  });

  it("pins the exact task shape BOTH harnesses must produce", () => {
    // This used to assert `f(x) === f(x)` — the same call twice, which proves
    // determinism of a pure function and nothing about Pi. What is worth
    // pinning is the OUTPUT CONTRACT: the shape each harness's `mgr.update`
    // writes. If this changes, both shells change together or the drift the
    // collapse removed is back.
    const task = applyReviewResolution(baseTask, resolveReviewFindings(TRANSCRIPT, "code-reviewer"));

    expect(task.review_status).toBe("blocked");
    expect(task.critical_findings).toEqual(["unchecked cast in the reducer"]);
    expect(task.advisory_findings).toEqual(["prefer a named constant"]);
    expect(task.findings).toEqual([
      {
        id: "code-reviewer-1",
        agent: "code-reviewer",
        severity: "critical",
        file: null,
        line: null,
        claim: "unchecked cast in the reducer",
      },
      {
        id: "code-reviewer-2",
        agent: "code-reviewer",
        severity: "advisory",
        file: null,
        line: null,
        claim: "prefer a named constant",
      },
    ]);
    // And the shape is one the load boundary accepts, so whichever harness
    // wrote it, the other can read it back.
    expect(findingsLockstepError(task.findings, task.critical_findings, task.advisory_findings, "t"))
      .toBeNull();
  });

  it("the evidence-failure transition is identical for both harnesses too", () => {
    // The other branch of the closed union. A harness that handled only the
    // findings case would silently pass a wave whose reviewer emitted nothing.
    const task = applyReviewResolution(
      baseTask,
      resolveReviewFindings("### Machine Summary\nCRITICAL: no count marker", "code-reviewer"),
    );
    expect(task.review_status).toBe("evidence_capture_failed");
    expect(task.review_error).toContain("CRITICAL_COUNT marker not found");
  });
});

describe("resolveReviewFindings (pure)", () => {
  it("resolves a missing CRITICAL_COUNT to evidence-failed", () => {
    const resolution = resolveReviewFindings("### Machine Summary\nCRITICAL: something", "code-reviewer");
    expect(resolution.kind).toBe("evidence-failed");
    const task = applyReviewResolution(baseTask, resolution);
    expect(task.review_status).toBe("evidence_capture_failed");
    expect(task.review_error).toContain("partial findings extracted");
    // Nothing is recorded when the evidence marker is absent — a partially
    // parsed review must not look like a completed one.
    expect(task.findings).toBeUndefined();
  });

  it("prefers the structured findings block and keeps file/line", () => {
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "CRITICAL: unchecked cast in the reducer",
      "```findings",
      JSON.stringify([
        { severity: "critical", file: "src/reducer.ts", line: 88, claim: "unchecked cast in the reducer" },
        { severity: "advisory", file: "src/reducer.ts", line: 12, claim: "prefer a named constant" },
      ]),
      "```",
    ].join("\n");
    const task = applyReviewResolution(baseTask, resolveReviewFindings(transcript, "code-reviewer"));
    expect(task.findings).toEqual([
      { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: "src/reducer.ts", line: 88, claim: "unchecked cast in the reducer" },
      { id: "code-reviewer-2", agent: "code-reviewer", severity: "advisory", file: "src/reducer.ts", line: 12, claim: "prefer a named constant" },
    ]);
    expect(task.critical_findings).toEqual(["unchecked cast in the reducer"]);
    expect(task.review_status).toBe("blocked");
  });

  it("falls back to the line scraper with null file/line when there is no block", () => {
    const task = applyReviewResolution(baseTask, resolveReviewFindings(TRANSCRIPT, "code-reviewer"));
    expect(task.findings).toEqual([
      { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "unchecked cast in the reducer" },
      { id: "code-reviewer-2", agent: "code-reviewer", severity: "advisory", file: null, line: null, claim: "prefer a named constant" },
    ]);
  });

  it("still takes CRITICAL_COUNT from the markers when a block is present", () => {
    // The count is the reviewer's own tally and is what distinguishes "zero
    // findings" from "the parse failed" — the block must not override it.
    const transcript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "```findings",
      "[]",
      "```",
    ].join("\n");
    const task = applyReviewResolution(baseTask, resolveReviewFindings(transcript, "code-reviewer"));
    expect(task.review_status).toBe("blocked");
    expect(task.critical_findings).toEqual(["Review output parsing failed - 2 findings not captured"]);
    expect(task.findings?.[0]!.claim).toContain("2 findings not captured");
  });

  it("logs the same operator line for both harnesses", () => {
    expect(reviewResolutionLog("T1", resolveReviewFindings(TRANSCRIPT, "code-reviewer")))
      .toBe("Task T1 review: blocked (1 critical)");
    expect(reviewResolutionLog("T1", resolveReviewFindings("no markers here", "code-reviewer")))
      .toContain("evidence_capture_failed");
  });
});

/**
 * The migration guarantee behind Phase A3: `findings` became the authoritative
 * field and the two `string[]` arrays became derived views, with no consumer
 * change. That only holds if the views never diverge from the record.
 */
describe("derived views match the authoritative findings array", () => {
  const REVIEWERS = ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer", "comment-analyzer"];

  it("holds after every reviewer in a wave has merged", () => {
    let task = baseTask;
    for (const [index, agent] of REVIEWERS.entries()) {
      task = mergeFindings(task, makeParsedFindings({
        critical: index % 2 === 0 ? [`critical from ${agent}`] : [],
        advisory: [`advice from ${agent}`],
        criticalCount: index % 2 === 0 ? 1 : 0,
      }), agent);
    }
    expect(task.critical_findings).toEqual(claimsOfSeverity(task.findings ?? [], "critical"));
    expect(task.advisory_findings).toEqual(claimsOfSeverity(task.findings ?? [], "advisory"));
    expect(task.review_status).toBe("blocked");
  });

  it("holds across a re-review of the same task by the same agent, with unique ids", () => {
    let task = mergeFindings(baseTask, makeParsedFindings({
      critical: ["first pass"], advisory: ["a1"], criticalCount: 1,
    }), "code-reviewer");
    task = mergeFindings(task, makeParsedFindings({
      critical: ["second pass"], advisory: ["a2"], criticalCount: 1,
    }), "code-reviewer");

    expect(task.findings?.map((f) => f.id))
      .toEqual(["code-reviewer-1", "code-reviewer-2", "code-reviewer-3", "code-reviewer-4"]);
    expect(new Set(task.findings?.map((f) => f.id)).size).toBe(4);
    expect(task.critical_findings).toEqual(claimsOfSeverity(task.findings ?? [], "critical"));
    expect(task.advisory_findings).toEqual(claimsOfSeverity(task.findings ?? [], "advisory"));
  });

  it("drops sentinels from both the record and its views identically", () => {
    const task = mergeFindings(baseTask, makeParsedFindings({
      critical: ["none"], advisory: ["(n/a)", "real advice"], criticalCount: 0,
    }), "code-reviewer");
    expect(task.findings?.map((f) => f.claim)).toEqual(["real advice"]);
    expect(task.critical_findings).toEqual([]);
    expect(task.advisory_findings).toEqual(["real advice"]);
  });
});
