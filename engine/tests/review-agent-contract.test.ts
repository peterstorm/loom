import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_SUB_AGENTS, WAVE_REVIEW_AGENTS, isReviewAgent } from "../src/config";
import { carriedOverCount, resolveReviewFindings, resolveTaskReviewFindings } from "../src/core/review-output";
import type { ReviewRun } from "../src/types";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agentFile = (name: string): string =>
  readFileSync(join(REPO_ROOT, "agents", `${name}.md`), "utf-8");

/**
 * Membership in `REVIEW_SUB_AGENTS` is not a label — it is a routing decision
 * with a failure mode. `store-reviewer-findings` sends every member's transcript
 * through `resolveReviewFindings`, which marks the task `evidence_capture_failed`
 * when it finds no `CRITICAL_COUNT`. So an agent can be added to the set without
 * its file being given the contract, and the result is a wave blocked by an agent
 * that did nothing wrong.
 *
 * That is not hypothetical: `code-simplifier` sat in `REVIEW_SUB_AGENTS` and was
 * spawned as reviewer #7 by `commands/review-pr.md` with no Machine Summary
 * section at all, while a comment in `core/review-output.ts` asserted that
 * "every reviewer agent file now requires the block". These tests replace that
 * assertion with a proof.
 */
describe("every REVIEW_SUB_AGENT declares the Machine Summary contract", () => {
  const agents = [...REVIEW_SUB_AGENTS].sort();

  it("has at least one member (a vacuous pass would prove nothing)", () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it.each(agents)("agents/%s.md declares the mandatory block", (agent) => {
    const md = agentFile(agent);
    expect(md, "must have a Machine Summary section").toMatch(/^##+\s+Machine Summary/m);
    expect(md, "must name CRITICAL_COUNT — its absence is what fails the gate").toContain(
      "CRITICAL_COUNT:",
    );
    expect(md, "must name ADVISORY_COUNT — wave-gate Step 4b triages advisories").toContain(
      "ADVISORY_COUNT:",
    );
    expect(md, "must name the CRITICAL: marker line").toContain("CRITICAL: {");
    expect(md, "must name the ADVISORY: marker line").toContain("ADVISORY: {");
    expect(md, "must document the optional structured findings block").toContain("```findings");
  });

  it.each(agents)("%s routes through the review parser at runtime", (agent) => {
    expect(isReviewAgent(agent)).toBe(true);
  });

  it.each(WAVE_REVIEW_AGENTS)("%s declares remediation lifecycle evidence", (agent) => {
    const md = agentFile(agent);
    expect(md).toContain("REVIEW_GENERATION:");
    expect(md).toContain("REVIEW_PACKET_ID:");
    expect(md).toContain("review_lifecycle");
    expect(md).toContain("resolved_by_remediation");
    expect(md).toContain("still_present");
  });

  /**
   * The lifecycle parser (`parsePriorAssessments`) accepts ONLY `finding_id`
   * and `verdict` — never the plausible synonyms `id`/`status` a model infers
   * from prose alone. A production wave failed 17/20 reviewer slots because the
   * agent files described the block without ever showing those key names, so
   * every model emitted `{id, status}` and every output was rejected until the
   * two-attempt allowance was exhausted. Prose is not a schema; these tests
   * require the exact wire keys to appear literally in every reviewer file.
   */
  it.each(WAVE_REVIEW_AGENTS)("%s shows the EXACT lifecycle key names, not synonyms", (agent) => {
    const md = agentFile(agent);
    expect(md, "must show the literal finding_id key").toContain('"finding_id"');
    expect(md, "must show the literal verdict key").toContain('"verdict"');
    expect(md, "must show the prior_findings envelope key").toContain('"prior_findings"');
    expect(md, "must warn against the id synonym").toMatch(/`finding_id`\s*\(NOT\s*`id`\)/);
    expect(md, "must warn against the status synonym").toMatch(/`verdict`\s*\(NOT\s*`status`\)/);
  });

  /**
   * The strongest guarantee: extract the review_lifecycle JSON the agent file
   * actually documents, feed it through the REAL bound-review parser, and prove
   * it resolves to findings — not `evidence-failed`. A documented-but-
   * unparseable example is precisely the failure that blocked the wave, and no
   * amount of prose review catches it. This executes the documentation.
   */
  it.each(WAVE_REVIEW_AGENTS)("the lifecycle example %s documents actually parses", (agent) => {
    const md = agentFile(agent);
    const fence = /```review_lifecycle\s*\r?\n([\s\S]*?)\r?\n```/.exec(md);
    expect(fence, "agent file must contain a concrete review_lifecycle example").not.toBeNull();
    const lifecycleJson = fence![1]!;
    const parsed = JSON.parse(lifecycleJson) as { prior_findings: { finding_id: string }[] };
    const priorIds = parsed.prior_findings.map((entry) => entry.finding_id);
    expect(priorIds.length, "example must assess at least one prior finding").toBeGreaterThan(0);

    const run: ReviewRun = {
      generation: 3,
      packet_id: "a".repeat(64),
      head_sha: "b".repeat(40),
      expected_agents: [agent],
      prior_finding_ids: priorIds,
      evidence: [],
    };
    const transcript = [
      "Some prose the reviewer wrote first.",
      "",
      "### Machine Summary",
      `REVIEW_GENERATION: ${run.generation}`,
      `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL:",
      "ADVISORY:",
      "",
      "```findings",
      "[]",
      "```",
      "",
      "```review_lifecycle",
      lifecycleJson,
      "```",
    ].join("\n");

    const resolved = resolveTaskReviewFindings(transcript, agent, run, run.generation);
    expect(
      resolved.kind,
      resolved.kind === "evidence-failed" ? `parser rejected the documented example: ${resolved.message}` : "",
    ).toBe("findings");
    if (resolved.kind !== "findings" || resolved.bound === undefined) return;
    expect(resolved.bound.priorAssessments.map((a) => a.finding_id)).toEqual(priorIds);
    for (const assessment of resolved.bound.priorAssessments) {
      expect(["resolved_by_remediation", "still_present"]).toContain(assessment.verdict);
      expect(assessment.reason.length).toBeGreaterThan(0);
    }
  });

  /**
   * The contract each file documents, executed. A transcript shaped exactly as
   * the agent file instructs must resolve to findings — not to
   * `evidence-failed`, which is what a documented-but-unparseable shape would
   * produce and what no amount of prose review would catch.
   */
  it.each(agents)("the shape %s's file documents actually parses", (agent) => {
    const transcript = [
      "Some prose the reviewer wrote first.",
      "",
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 1",
      "CRITICAL: a real blocker",
      "ADVISORY: a nit",
      "",
      "```findings",
      JSON.stringify([
        { severity: "critical", file: "src/x.ts", line: 42, claim: "a real blocker" },
        { severity: "advisory", file: null, line: null, claim: "a nit" },
      ]),
      "```",
    ].join("\n");

    const resolved = resolveReviewFindings(transcript, agent);
    expect(resolved.kind).toBe("findings");
    if (resolved.kind !== "findings") return;
    expect(resolved.findings.critical).toEqual(["a real blocker"]);
    expect(resolved.findings.advisory).toEqual(["a nit"]);
    expect(resolved.findings.blockStatus.kind).toBe("used");
    // The block won cleanly, so nothing was carried over and nothing duplicated.
    expect(carriedOverCount(resolved.findings.blockStatus)).toBe(0);
  });
});
