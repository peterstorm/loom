import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidualPlaceholders } from "../src/core/validate-template-substitution";
import { parseRefutationVerdict, serializeRefutationVerdict, REVIEW_LENSES, REFUTATION_VERDICTS, type WaveFindingId } from "../src/core/review-panel";
import { REVIEW_PANEL_AGENTS } from "../src/core/agent-catalog-projections";
import { detectPhase, isReviewPanelAgent } from "../src/core/validate-phase-order";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LENS_REFERENCE_PATH = "references/review-lenses.md";

const lensReference = readFileSync(join(REPO_ROOT, LENS_REFERENCE_PATH), "utf-8");
const verifier = readFileSync(join(REPO_ROOT, "agents", "review-verifier-agent.md"), "utf-8");

/** The `## <lens>` section of review-lenses.md, the slice the verifier is told to read. */
function lensSection(lens: string): string {
  const start = lensReference.indexOf(`\n## ${lens}\n`);
  expect(start, `lens reference has no section for ${lens}`).toBeGreaterThan(-1);
  const rest = lensReference.slice(start + 1);
  const end = rest.indexOf("\n---\n");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The engine issues a verifier its lens by NAME (the packet's output contract
 * says "through lens '<name>'"); the definition lives in the lens reference,
 * which the verifier agent is told to read. Nothing substitutes the lens text
 * into a prompt, so the only link between a selected lens and its definition
 * is the section heading. These pin that link in both directions.
 */
describe("the verifier can find the definition of every lens the engine can select", () => {
  it("the lens reference documents exactly the lenses the code selects from", () => {
    const documented = [...lensReference.matchAll(/^## ([a-z-]+)$/gm)]
      .map((m) => m[1]!)
      .filter((heading) => (REVIEW_LENSES as readonly string[]).includes(heading));
    expect(documented).toEqual([...REVIEW_LENSES]);
  });

  it.each([...REVIEW_LENSES])("the %s section states what it refutes and what it refuses to refute on", (lens) => {
    const section = lensSection(lens);
    expect(section).toMatch(/refut/i);
    expect(section.length).toBeGreaterThan(200);
  });

  it("the verifier agent names the lens reference and the section heading form", () => {
    expect(verifier).toContain(`\${CLAUDE_PLUGIN_ROOT}/${LENS_REFERENCE_PATH}`);
    expect(verifier).toContain("`## <your lens>`");
  });

  it("the verifier agent names its output contract", () => {
    // Derived from REFUTATION_VERDICTS, not a hand-copied list: a fourth
    // verdict kind added to the union must reach the prompt that asks for it,
    // and a hardcoded array here would go on passing while it did not.
    for (const word of [...REFUTATION_VERDICTS, "finding_id", "criterion"]) {
      expect(verifier).toContain(word);
    }
  });
});

describe("verifier output is sanitized before it is stored", () => {
  it("brace-bearing reasoning carries no placeholder into any later prompt", () => {
    const raw = JSON.stringify({
      criterion: "intent",
      verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "the {never-throw} rule is deliberate" }],
    });
    const parsed = parseRefutationVerdict(raw, "intent", ["T1:code-reviewer-1"] as unknown as readonly WaveFindingId[]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const canonical = serializeRefutationVerdict(parsed.value);
    expect(canonical).not.toContain("{never-throw}");
    expect(findResidualPlaceholders(canonical)).toEqual([]);
  });
});

describe("the verifier agent is wired for the execute phase, invisible to dispatch", () => {
  it("is recognized bare and -agent-suffixed", () => {
    for (const agent of REVIEW_PANEL_AGENTS) {
      expect(isReviewPanelAgent(agent)).toBe(true);
      expect(isReviewPanelAgent(agent.replace(/-agent$/, ""))).toBe(true);
      expect(detectPhase(agent, "")).toBe("execute");
    }
  });

  it("has an agent definition on disk whose name matches the registry", () => {
    for (const agent of REVIEW_PANEL_AGENTS) {
      const definition = readFileSync(join(REPO_ROOT, "agents", `${agent}.md`), "utf-8");
      expect(definition).toContain(`name: ${agent}`);
    }
  });
});
