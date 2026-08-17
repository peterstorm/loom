import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOfKind } from "../src/core/model-profiles";
import { extractWireContractRegion, stampWireContract } from "../src/core/wire-contract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fragment = readFileSync(join(REPO_ROOT, "agents", "_shared", "wire-contract.md"), "utf-8");
const reviewers = agentsOfKind("reviewer");

/**
 * The Wire Contract has ONE source: agents/_shared/wire-contract.md. Each
 * finding-producing reviewer carries a stamped copy between markers — never a
 * hand-edited one. This test is the drift gate: it uses the SAME extraction
 * the stamp script writes with, so "the regions match" here means re-running
 * scripts/stamp-wire-contract.ts is a no-op. review-agent-contract.test.ts
 * separately proves the stamped text still parses through the real engine.
 */
describe("every reviewer carries the exact stamped Wire Contract", () => {
  it("covers the full reviewer roster (a vacuous pass would prove nothing)", () => {
    expect(reviewers.length).toBeGreaterThanOrEqual(7);
  });

  it.each([...reviewers])("agents/%s.md region is byte-identical to the fragment", (agent) => {
    const markdown = readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");
    const region = extractWireContractRegion(markdown);
    expect(region.ok, region.ok ? "" : region.error).toBe(true);
    if (!region.ok) return;
    expect(region.value).toBe(fragment.replace(/\n$/, ""));
  });

  it.each([...reviewers])("stamping agents/%s.md is idempotent", (agent) => {
    const markdown = readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");
    const stamped = stampWireContract(markdown, fragment);
    expect(stamped.ok).toBe(true);
    if (stamped.ok) expect(stamped.value).toBe(markdown);
  });

  it("the fragment itself carries every wire token the engine's parsers demand", () => {
    for (const token of [
      "CRITICAL_COUNT:", "ADVISORY_COUNT:", "CRITICAL: {", "ADVISORY: {",
      "```findings", "REVIEW_GENERATION:", "REVIEW_PACKET_ID:", "review_lifecycle",
      "resolved_by_remediation", "still_present", '"finding_id"', '"verdict"', '"prior_findings"',
    ]) {
      expect(fragment, token).toContain(token);
    }
  });
});
