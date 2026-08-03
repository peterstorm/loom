import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_SUB_AGENTS, isReviewAgent } from "../src/config";
import { carriedOverCount, resolveReviewFindings } from "../src/core/review-output";

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
