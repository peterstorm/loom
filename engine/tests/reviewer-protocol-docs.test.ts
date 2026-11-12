import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const prose = (path: string): string => readFileSync(`${root}${path}`, "utf8").replace(/\s+/g, " ");

/**
 * A parent prompt keeps what the parent acts on. The parent never writes a
 * reviewer payload, so the protocol itself — fields, versions, retention,
 * byte limits — has one owner, docs/operations.md, and the three parent
 * runbooks carry the same three sentences about it.
 */
const REVIEWER_RECAP =
  "Reviewers return one JSON payload; the engine admits or retries it. A malformed payload is failed evidence, never a Finding. Surviving criticals block.";
const PARENT_RUNBOOKS = ["commands/review-pr.md", "skills/review-and-fix/SKILL.md", "commands/wave-gate.md"] as const;

describe("current reviewer runbooks preserve protocol and decision boundaries", () => {
  it.each(PARENT_RUNBOOKS)("%s states what a parent needs to know about reviewer output, and no more", (path) => {
    const text = prose(path);
    expect(text).toContain(REVIEWER_RECAP);
    // The payload grammar and its version history are not parent instructions.
    for (const field of ["violatedContract", "truthConfidence", "severityRationale", "Machine Summary", "reviewer-protocol-v1"]) {
      expect(text, field).not.toContain(field);
    }
  });

  it.each(["commands/review-pr.md", "skills/review-and-fix/SKILL.md"])("%s uses canonical inspection rather than authored tallies", (path) => {
    const text = prose(path);
    expect(text).toContain("helper orchestration inspect");
    expect(text).not.toContain("artifacts/result.json");
    expect(text).toMatch(/never (compute tallies|from arithmetic) of your own/);
    expect(text).toContain("A successor review is never automatic");
    expect(text).toContain("docs/operations.md#explicit-successor-review");
  });

  it.each(PARENT_RUNBOOKS)("%s carries no rollout bootstrap that gates a shipped program", (path) => {
    // The P5 publisher (`standalone-disposition`) shipped with PR #51. Text
    // telling the parent to wait for a "matching runtime" told it not to use
    // the shipped path.
    const text = prose(path);
    for (const stale of ["P5", "matching runtime", "matching-runtime", "Skill 5.0.0", "bootstrap restriction", "remain pending"]) {
      expect(text, stale).not.toContain(stale);
    }
  });

  it("keeps the remediation obligations a parent acts on", () => {
    const text = prose("skills/review-and-fix/SKILL.md");
    expect(text).toContain('version: "6.0.0"');
    expect(text).toContain("helper orchestration start standalone-disposition");
    expect(text).toContain("unfinished schema-v1 remediation run");
    expect(text).toContain("more than zero executed tests, zero failures");
    expect(text).toContain("Never force-push");
  });

  it("states one true thing about who creates a Run Directory", () => {
    // `createRunDirectory` resolves the runs root (never creating it) and
    // creates the run's own directory. Each runbook that starts a run says so
    // and creates the root before its first start.
    for (const path of PARENT_RUNBOOKS) {
      const text = prose(path);
      expect(text, path).toMatch(/runs root must exist[;,]? ?\(?the engine never creates it/);
      expect(text, path).toMatch(/`start` creates (the|that) Run Directory/);
      expect(text.indexOf("mkdir -p"), path).toBeGreaterThan(-1);
      expect(text.indexOf("mkdir -p"), path).toBeLessThan(text.indexOf("helper orchestration start"));
    }
  });

  it("keeps the explicit Wave override separate from reviewer failure", () => {
    const text = prose("commands/wave-gate.md");
    expect(text).toContain("helper store-review-findings");
    expect(text).toContain("never invoke it automatically");
    expect(text).not.toContain("report not required");
    // This repository's own enrolled check is operator history, not a
    // Wave Gate instruction for every project that installs the plugin.
    expect(text).not.toContain("npm run verify");
    expect(prose("docs/operations.md")).toContain(".loom/completion-reports/verify.junit.xml");
  });

  it("distinguishes historical semantic replay from native fixture evidence", () => {
    const text = prose("docs/operations.md");
    expect(text).toContain("90 exact logical files, 20,250,407 bytes");
    expect(text).toContain("3,395,759 bytes");
    expect(text).toContain("unchanged original inventory");
    expect(text).toContain("not relocated native filesystem admission");
    expect(text).toContain("not positive native evidence");
    for (const prefix of ["initial publication", "outstanding attempt-1 reissue", "newly issued attempt 2", "already-published attempt-2 recovery"]) {
      expect(text).toContain(prefix);
    }
  });

  it.each(["scripts/smoke-review-panel.sh", "scripts/smoke-standalone-review.sh"])("%s labels retained historical/manual coverage", (path) => {
    expect(prose(path).toLowerCase()).toContain("historical/manual");
    expect(prose(path)).toContain("smoke-orchestration-facades.ts");
  });

  it("records the selected audited dependency and rejects retrospective provenance", () => {
    const text = prose("docs/adr/ADR-0009-versioned-reviewer-protocol.md");
    expect(text).toContain("json-bigint@1.0.0");
    expect(text).toContain("ambient `Math.random()`");
    expect(text).toContain('`jsonc-parser: "3.3.1"`');
    expect(text).toContain("no blanket package/core allowlist");
    expect(text).toContain("not invented original provenance");
    expect(text).toContain("P4 merged as `96153edc3dd755b4ac648ed48920b6670753c5a6` on 2026-09-10");
    expect(text).toContain("publication/loaded-runtime reload were verified");
    expect(text).toContain("P5's separate successor implementation is tracked in [ADR-0010]");
    expect(text).toContain("its final validation, registered review and publication remain pending");
    expect(text).not.toContain("Source review, merge, publication and loaded-runtime cutover remain pending");
  });
});
