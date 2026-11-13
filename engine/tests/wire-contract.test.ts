import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOfKind } from "../src/core/agent-catalog-projections";
import { REVIEW_LENSES } from "../src/core/review-panel";
import {
  READ_COVERAGE_BULLET_ANCHOR,
  REVIEW_LENSES_REGION,
  REVIEWER_BOOTSTRAP_REGION,
  REVIEWER_PREFLIGHT_REGION,
  WIRE_CONTRACT_REGION,
  extractReadCoverageBullet,
  extractRegion,
  extractWireContractRegion,
  reviewLensSections,
  stampReadCoverageBullet,
  stampRegion,
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
import { compactSchemaOf, describeCompactSchemaError } from "./support/compact-schema";
import { describeMarkdownError, fencesOf, markdown, orFail } from "./support/markdown";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readFragment = (name: string): string => readFileSync(join(REPO_ROOT, "references", "reviewer-wire", name), "utf-8");
const fragment = readFragment("wire-contract.md");
const readCoverageFragment = readFragment("read-coverage.md");
const reviewers = agentsOfKind("reviewer");
const reviewerFile = (agent: string): string => readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");

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
 * The Wire Contract has ONE source: references/reviewer-wire/wire-contract.md. Each
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
 * The Context Packet bootstrap and the payload preflight are hand-written once,
 * in references/reviewer-wire/, and stamped between their own markers. Each was
 * a block hand-copied into seven files; the copies had drifted apart. The
 * drift gate is the stamper's own extraction, as for the Wire Contract above.
 */
describe.each([
  ["bootstrap.md", REVIEWER_BOOTSTRAP_REGION],
  ["before-you-emit.md", REVIEWER_PREFLIGHT_REGION],
] as const)("every reviewer carries the exact stamped %s", (file, region) => {
  const source = readFragment(file);

  it.each([...reviewers])("agents/%s.md region is byte-identical to the fragment, and stamping it is idempotent", (agent) => {
    const markdown = reviewerFile(agent);
    expect(extractRegion(markdown, region)).toEqual({ ok: true, value: source.replace(/\n$/, "") });
    expect(stampRegion(markdown, region, source)).toEqual({ ok: true, value: markdown });
  });

  it("the fragment opens with its own heading, so the region is a whole section", () => {
    expect(source).toMatch(/^## \S/);
    expect(source.endsWith("\n")).toBe(true);
  });
});

describe("the reviewer regions sit in the order a reviewer reads them", () => {
  it.each([...reviewers])("agents/%s.md opens with the bootstrap, then the read-coverage bullet, the preflight and the Wire Contract", (agent) => {
    const markdown = reviewerFile(agent);
    const positions = [
      markdown.indexOf(REVIEWER_BOOTSTRAP_REGION.start),
      markdown.indexOf(READ_COVERAGE_BULLET_ANCHOR),
      markdown.indexOf(REVIEWER_PREFLIGHT_REGION.start),
      markdown.indexOf(WIRE_CONTRACT_REGION.start),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Nothing but frontmatter precedes the bootstrap: it is the first thing read.
    expect(markdown.slice(0, positions[0]).trimEnd().endsWith("---")).toBe(true);
    // The Wire Contract closes the file: no hand-written text trails the generated region.
    expect(markdown.endsWith(`${WIRE_CONTRACT_REGION.end}\n`)).toBe(true);
  });
});

describe("the fragments are not agents", () => {
  it("agents/ holds no subdirectory", () => {
    // Claude Code registers every Markdown file beneath agents/ as a spawnable
    // agent, so a fragment kept there appeared in the roster with all tools.
    const subdirectories = readdirSync(join(REPO_ROOT, "agents"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(subdirectories).toEqual([]);
  });
});

/**
 * The refutation verifier is issued its lens by name. The definitions have ONE
 * source, references/review-lenses.md, and the verifier carries its lens
 * sections between markers, stamped by the same script through the same seam.
 */
describe("the refutation verifier carries the exact stamped lens sections", () => {
  const reference = readFileSync(join(REPO_ROOT, "references", "review-lenses.md"), "utf-8");
  const sections = reviewLensSections(reference, REVIEW_LENSES);
  const verifiers = agentsOfKind("review-verifier");

  it("covers the verifier (a vacuous pass would prove nothing)", () => {
    expect(verifiers).toEqual(["review-verifier-agent"]);
  });

  it.each([...verifiers])("agents/%s.md region is byte-identical to the reference's lens sections, and stamping it is idempotent", (agent) => {
    expect(sections.ok, sections.ok ? "" : sections.error).toBe(true);
    if (!sections.ok) return;
    const markdown = reviewerFile(agent);
    expect(extractRegion(markdown, REVIEW_LENSES_REGION)).toEqual({ ok: true, value: sections.value.replace(/\n$/, "") });
    expect(stampRegion(markdown, REVIEW_LENSES_REGION, sections.value)).toEqual({ ok: true, value: markdown });
    // The sections nest under the agent's own heading.
    expect(markdown).toContain(`\n## Lenses\n\n${REVIEW_LENSES_REGION.start}\n### ${REVIEW_LENSES[0]}\n`);
  });

  it("takes the lens sections only, demoted one level, and nothing of the header", () => {
    const source = "# Lenses\n\nHeader.\n\n## The standing rule\n\nRule.\n\n---\n\n## a\n\nA body.\n\n---\n\n## b\n\nB body.\n";
    expect(reviewLensSections(source, ["a", "b"]))
      .toEqual({ ok: true, value: "### a\n\nA body.\n\n---\n\n### b\n\nB body.\n" });
  });

  it.each<readonly [string, string, readonly string[], string]>([
    ["a reference with no lens section", "# Lenses\n\n## other\n", ["a", "b"], "lens reference has no `## <lens>` section"],
    ["a selectable lens with no section", "## a\n\nA.\n", ["a", "b"], "lens reference sections [a] are not the selectable lenses [a, b]"],
    ["sections out of selection order", "## b\n\nB.\n\n## a\n\nA.\n", ["a", "b"], "lens reference sections [b, a] are not the selectable lenses [a, b]"],
    ["a section no lens selects", "## a\n\nA.\n\n## b\n\nB.\n\n## c\n\nC.\n", ["a", "b"], "lens reference sections [a, b, c] are not the selectable lenses [a, b]"],
  ])("refuses %s", (_name, source, lenses, error) => {
    expect(reviewLensSections(source, lenses)).toEqual({ ok: false, error });
  });
});

describe.each([REVIEWER_BOOTSTRAP_REGION, REVIEW_LENSES_REGION])("stamping the marked $name region", (region) => {
  const file = (inner: string): string => `---\nname: demo\n---\n\n${region.start}\n${inner}\n${region.end}\n\nBody\n`;

  it("replaces only the region and leaves every other byte untouched", () => {
    expect(stampRegion(file("stale"), region, "fresh\n")).toEqual({ ok: true, value: file("fresh") });
    expect(extractRegion(file("fresh"), region)).toEqual({ ok: true, value: "fresh" });
  });

  it("fills an empty region", () => {
    expect(stampRegion(`${region.start}\n${region.end}\n`, region, "fresh\n"))
      .toEqual({ ok: true, value: `${region.start}\nfresh\n${region.end}\n` });
  });

  it.each<readonly [string, string, string]>([
    ["a missing start marker", `text\n${region.end}\n`, `missing ${region.name} start marker`],
    ["a missing end marker", `${region.start}\ntext\n`, `missing ${region.name} end marker`],
    ["markers out of order", `${region.end}\n${region.start}\n`, `${region.name} markers are out of order`],
  ])("refuses %s, naming the region", (_name, markdown, error) => {
    expect(stampRegion(markdown, region, "fresh\n")).toEqual({ ok: false, error });
    expect(extractRegion(markdown, region)).toEqual({ ok: false, error });
  });

  it("one region's markers never satisfy another's", () => {
    expect(stampRegion(file("text"), REVIEWER_PREFLIGHT_REGION, "fresh\n"))
      .toEqual({ ok: false, error: "missing reviewer-preflight start marker" });
  });
});

/**
 * The read-coverage bullet has ONE source too: references/reviewer-wire/read-coverage.md,
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

  it("states the spawn-wide prohibition and the single-payload fallback once, in the template itself (AS-012)", () => {
    // The template is the wording; a paragraph restating it beside the
    // template would be the second wording AD-7 rules out.
    const [lead, instruction, template] = fragment.split("\n\n");
    expect(lead).toBe(REVIEWER_OUTPUT_CONTRACT);
    expect(instruction).toBe(
      `If your task names an emission tool, this wording applies instead, with that tool's name in place of ${REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER}:`,
    );
    expect(template).toBe(`\`\`\`\n${REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE}\n\`\`\``);
    for (const phrase of [
      "a second time in this spawn",
      "Only if the tool is unavailable or refuses your arguments, fall back to the final message",
      "exactly one JSON object conforming to the issued payload schema, and nothing else",
    ]) {
      expect(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE, phrase).toContain(phrase);
      expect(fragment.split(phrase), phrase).toHaveLength(2);
    }
  });

  it("shows the common case, located findings, and says the example is the standalone arm only", () => {
    const example = /## Example \(standalone-review only\)\n\n```json\n([\s\S]*?)\n```\n\n(.*)\n/.exec(fragment);
    expect(example).not.toBeNull();
    const payload = JSON.parse(example![1]!) as { kind: string; findings: { severity: string; file: unknown; line: unknown }[] };
    expect(payload.kind).toBe("standalone-review");
    expect(payload.findings.map(({ severity }) => severity)).toEqual(["critical", "advisory"]);
    for (const finding of payload.findings) {
      expect(typeof finding.file).toBe("string");
      expect(typeof finding.line).toBe("number");
    }
    expect(example![2]).toContain('"kind": "wave-review"');
    expect(example![2]).toContain("refused");
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

  it("the stamped schema is the issued schema value and the rubric bytes are untouched (stamp/schema consistency)", () => {
    // The template fence is plain text: exactly the schema and example remain ```json blocks.
    const source = markdown("references/reviewer-wire/wire-contract.md", fragment);
    expect(orFail(fencesOf(source, "json"), describeMarkdownError)).toHaveLength(2);
    // Shown compact, so the bytes differ from the packet section; the value may not.
    expect(orFail(compactSchemaOf(source), describeCompactSchemaError).value).toEqual(JSON.parse(REVIEWER_PAYLOAD_SCHEMA_V2));
    expect(fragment).toContain("section in compact form; the packet copy governs.\n\n```json\n");
    expect(fragment.endsWith(REVIEWER_IMPACT_RUBRIC_V1)).toBe(true);
  });

  it.each([...reviewers])("agents/%s.md carries the template and the retained contract in its stamped region", (agent) => {
    const markdown = readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");
    const region = extractWireContractRegion(markdown);
    expect(region.ok, region.ok ? "" : region.error).toBe(true);
    if (!region.ok) return;
    expect(region.value).toContain(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE);
    expect(region.value).toContain(REVIEWER_OUTPUT_CONTRACT);
  });

  it("the archived issued v1 fragment is NOT rewritten (AS-012)", () => {
    // The schema-2 archive is no longer kept in the tree: nothing read it, and
    // docs/standalone-review.md records the commit that reproduces it.
    const shared = readFileSync(join(REPO_ROOT, "references/reviewer-protocol-v1/agents/_shared/wire-contract.md"), "utf-8");
    expect(shared).not.toContain(REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE);
    expect(shared).not.toContain(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER);
    expect(shared).not.toContain("primary final action");
    expect(shared).not.toContain("loom_emit_");
  });
});
