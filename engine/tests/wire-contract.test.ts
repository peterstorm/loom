import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOfKind } from "../src/core/model-profiles";
import {
  READ_COVERAGE_BULLET_ANCHOR,
  extractReadCoverageBullet,
  extractWireContractRegion,
  stampReadCoverageBullet,
  stampWireContract,
} from "../src/core/wire-contract";
import { renderReviewerWireContract, renderReviewerWireInstructions } from "../src/core/reviewer-protocol";
import {
  REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER, REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE,
  REVIEWER_OUTPUT_CONTRACT, REVIEWER_PAYLOAD_SCHEMA_V2, REVIEWER_IMPACT_RUBRIC_V1,
  reviewerEmissionToolContract,
} from "../src/core/reviewer-contract";
import { EMISSION_TOOL_SPECS, issueEmissionBinding } from "../src/core/emission-tool";
import { parseRequestId } from "../src/core/orchestration-contract/identity";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fragment = readFileSync(join(REPO_ROOT, "agents", "_shared", "wire-contract.md"), "utf-8");
const readCoverageFragment = readFileSync(join(REPO_ROOT, "agents", "_shared", "read-coverage.md"), "utf-8");
const reviewers = agentsOfKind("reviewer");

const REQUEST = parseRequestId("request:wire-contract");
if (!REQUEST.ok) throw new Error(`fixture request id refused: ${REQUEST.error.message}`);
/** Every supported registry cell, minted by the actual issuance machinery. */
const REGISTRY_CELLS = (Object.keys(EMISSION_TOOL_SPECS) as Array<keyof typeof EMISSION_TOOL_SPECS>).flatMap((kind) =>
  Object.keys(EMISSION_TOOL_SPECS[kind].schemaVersions).map((version) => {
    const minted = issueEmissionBinding({ requestId: REQUEST.value, kind, version });
    if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
    return minted.value;
  }));

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

  it("the shared fragment is generated from the actual executable contract", () => {
    expect(fragment).toBe(renderReviewerWireContract());
    for (const token of ['"schemaVersion"', '"basis"', '"reason"', '"finding_id"', '"verdict"', '"prior_findings"']) {
      expect(fragment, token).toContain(token);
    }
    expect(fragment).not.toContain("CRITICAL_COUNT:");
    expect(fragment).not.toContain("```findings");
  });
});

/**
 * The read-coverage bullet has ONE source too: agents/_shared/read-coverage.md,
 * stamped by the same script over each reviewer's single anchored bullet. The
 * drift gate uses the stamper's own extraction, exactly like the region above.
 */
describe("every reviewer carries the exact stamped read-coverage bullet", () => {
  it("the fragment is one anchored line naming the engine-verified obligation", () => {
    expect(readCoverageFragment.endsWith("\n")).toBe(true);
    expect(readCoverageFragment.slice(0, -1)).not.toContain("\n");
    expect(readCoverageFragment.startsWith(`${READ_COVERAGE_BULLET_ANCHOR}every-frozen-diff-unit\``)).toBe(true);
    expect(readCoverageFragment).toContain("ADR-0022");
  });

  it.each([...reviewers])("agents/%s.md bullet is byte-identical to the fragment, and stamping it is idempotent", (agent) => {
    const markdown = readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");
    expect(extractReadCoverageBullet(markdown)).toEqual({ ok: true, value: readCoverageFragment.replace(/\n$/, "") });
    expect(stampReadCoverageBullet(markdown, readCoverageFragment)).toEqual({ ok: true, value: markdown });
  });

  it("restamps a drifted bullet in place and leaves every other line untouched", () => {
    const drifted = `# agent\n\n- first\n${READ_COVERAGE_BULLET_ANCHOR}every-frozen-diff-unit\`, stale wording.\n- last\n`;
    expect(stampReadCoverageBullet(drifted, readCoverageFragment)).toEqual({
      ok: true,
      value: `# agent\n\n- first\n${readCoverageFragment}- last\n`,
    });
  });

  it.each<readonly [string, string, string, string]>([
    ["no bullet", "# agent\n- first\n", readCoverageFragment, "missing read-coverage bullet"],
    ["two bullets", `${READ_COVERAGE_BULLET_ANCHOR}a\n${READ_COVERAGE_BULLET_ANCHOR}b\n`, readCoverageFragment,
      "2 read-coverage bullets; expected exactly one"],
    ["an unanchored fragment", `${READ_COVERAGE_BULLET_ANCHOR}a\n`, "- something else\n", "read-coverage fragment must be one line starting with its anchor"],
    ["a multi-line fragment", `${READ_COVERAGE_BULLET_ANCHOR}a\n`, `${READ_COVERAGE_BULLET_ANCHOR}a\nb\n`,
      "read-coverage fragment must be one line starting with its anchor"],
  ])("refuses %s", (_name, markdown, bullet, error) => {
    expect(stampReadCoverageBullet(markdown, bullet)).toEqual({ ok: false, error });
  });
});

/**
 * Tool-primary fragment wording (FR-020/AS-012; AD-7): the stamped fragment
 * carries the ONE frozen emission wording as a placeholder template, keeps
 * the retained extraction-only contract verbatim, and leaves the archived
 * issued v1/v2 fragments untouched (AS-012). The template is derived from —
 * never a rewrite of — `reviewerEmissionToolContract`, so substituting the
 * placeholder with an actually minted tool name reproduces the exact
 * per-spawn render production issues.
 */
describe("the fragment's tool-primary emission wording (FR-020/AS-012)", () => {
  it("carries the frozen emission wording as a placeholder template, not a second wording", () => {
    expect(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE).toBe(reviewerEmissionToolContract(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER));
    expect(fragment).toContain(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE);
    for (const phrase of [
      "primary final action", "exactly once", "a second time in this spawn",
      "fall back to the final message", "conforming to the issued payload schema",
    ]) expect(fragment, phrase).toContain(phrase);
  });

  it.each(REGISTRY_CELLS.map((binding) => [`${binding.kind.kind}/${binding.version}`, binding] as const))(
    "placeholder substitution reproduces the exact per-spawn emission render for %s",
    (_cell, binding) => {
      const rendered = renderReviewerWireInstructions({ kind: "emission", toolName: binding.toolName });
      expect(rendered).toBe(reviewerEmissionToolContract(binding.toolName));
      expect(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE.replaceAll(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER, binding.toolName)).toBe(rendered);
    },
  );

  it("the emission route is the only tool-primary arm: extraction-only requests retain the final-message contract verbatim (AS-012)", () => {
    const extracted = renderReviewerWireInstructions({ kind: "extraction-only", reason: "explicit extraction-only surface" });
    expect(extracted).toBe(REVIEWER_OUTPUT_CONTRACT);
    expect(extracted).not.toContain("primary final action");
    expect(extracted).not.toContain(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER);
    // A caller-supplied final-message contract is rendered verbatim, never blended with the template.
    expect(renderReviewerWireInstructions({ kind: "extraction-only", reason: "archived schema-1 claim" }, "Return the issued summary object.")).toBe(
      "Return the issued summary object.",
    );
  });

  it("the fragment's fallback carry-through carries the spawn-wide prohibition and the single-payload fallback (AS-012)", () => {
    for (const phrase of [
      "deterministic fallback",
      "never re-emit within the same spawn",
      "a second call is refused as duplicate-call ambiguity",
      "exactly the one issued payload object, nothing else",
      "with the exact issued tool name substituted for the placeholder",
    ]) expect(fragment, phrase).toContain(phrase);
  });

  it("the retained extraction-only final-message contract stays verbatim and leads the fragment", () => {
    expect(fragment.startsWith(REVIEWER_OUTPUT_CONTRACT)).toBe(true);
    expect(fragment).toContain(REVIEWER_OUTPUT_CONTRACT);
    expect(REVIEWER_OUTPUT_CONTRACT).not.toContain("primary final action");
  });

  it("the template stays route-agnostic: no concrete minted tool name is stamped", () => {
    for (const spec of Object.values(EMISSION_TOOL_SPECS)) expect(fragment, spec.toolName).not.toContain(spec.toolName);
    expect(fragment).toContain(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER);
  });

  it("the schema/rubric bytes are untouched by the tool-primary section (stamp/schema consistency)", () => {
    expect(fragment).toContain(REVIEWER_PAYLOAD_SCHEMA_V2);
    expect(fragment.endsWith(REVIEWER_IMPACT_RUBRIC_V1)).toBe(true);
    // The template fence is plain text: exactly the schema and example remain ```json blocks.
    expect([...fragment.matchAll(/```json\n([\s\S]*?)\n```/g)]).toHaveLength(2);
  });

  it.each([...reviewers])("agents/%s.md carries the template and the retained contract in its stamped region", (agent) => {
    const markdown = readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");
    const region = extractWireContractRegion(markdown);
    expect(region.ok, region.ok ? "" : region.error).toBe(true);
    if (!region.ok) return;
    expect(region.value).toContain(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE);
    expect(region.value).toContain(REVIEWER_OUTPUT_CONTRACT);
  });

  it("archived issued v1 and v2 fragments are NOT rewritten (AS-012)", () => {
    for (const archive of ["references/reviewer-protocol-v1", "references/reviewer-protocol-v2"]) {
      const shared = readFileSync(join(REPO_ROOT, archive, "agents", "_shared", "wire-contract.md"), "utf-8");
      expect(shared, archive).not.toContain(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE);
      expect(shared, archive).not.toContain(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER);
      expect(shared, archive).not.toContain("primary final action");
      expect(shared, archive).not.toContain("loom_emit_");
    }
  });
});
