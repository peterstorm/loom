import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidualPlaceholders } from "../src/core/validate-template-substitution";
import { parseRefutationVerdict, serializeRefutationVerdict, REVIEW_LENSES, REFUTATION_VERDICTS, type WaveFindingId } from "../src/core/review-panel";
import { REVIEW_PANEL_AGENTS } from "../src/core/agent-catalog-projections";
import { REVIEW_LENSES_REGION, extractRegion } from "../src/core/wire-contract";
import { detectPhase, isReviewPanelAgent } from "../src/core/validate-phase-order";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LENS_REFERENCE_PATH = "references/review-lenses.md";

const lensReference = readFileSync(join(REPO_ROOT, LENS_REFERENCE_PATH), "utf-8");
const verifier = readFileSync(join(REPO_ROOT, "agents", "review-verifier-agent.md"), "utf-8");
const stampedLenses = extractRegion(verifier, REVIEW_LENSES_REGION);

/**
 * The two places a lens is defined: the reference that owns the text, and the
 * copy stamped into the verifier, where the sections sit one level deeper.
 */
const LENS_DOCUMENTS = [
  ["the lens reference", lensReference, "##"],
  ["the verifier agent's stamped lenses", stampedLenses.ok ? stampedLenses.value : "", "###"],
] as const;

/** One lens's section of a document: from its heading to the next rule. */
function lensSection(document: string, heading: string): string {
  const start = document.split("\n").indexOf(heading);
  expect(start, `no section headed ${heading}`).toBeGreaterThan(-1);
  const rest = document.split("\n").slice(start).join("\n");
  const end = rest.indexOf("\n---\n");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The engine issues a verifier its lens by NAME (the packet's output contract
 * says "through lens '<name>'"). The definitions are stamped into the verifier
 * agent from the lens reference, so the only link between a selected lens and
 * its definition is the section heading. These pin that link in the reference
 * and in the agent the verifier actually runs from.
 */
describe("the verifier can find the definition of every lens the engine can select", () => {
  it("the verifier agent carries a stamped lens region", () => {
    expect(stampedLenses.ok, stampedLenses.ok ? "" : stampedLenses.error).toBe(true);
  });

  describe.each(LENS_DOCUMENTS)("%s", (_name, document, level) => {
    it("documents exactly the lenses the code selects from", () => {
      const documented = document.split("\n")
        .filter((line) => line.startsWith(`${level} `))
        .map((line) => line.slice(level.length + 1))
        .filter((heading) => (REVIEW_LENSES as readonly string[]).includes(heading));
      expect(documented).toEqual([...REVIEW_LENSES]);
    });

    it.each([...REVIEW_LENSES])("the %s section states what it refutes and what it refuses to refute on", (lens) => {
      const section = lensSection(document, `${level} ${lens}`);
      expect(section).toMatch(/refut/i);
      expect(section.length).toBeGreaterThan(200);
    });
  });

  it("the verifier agent points at its own lens sections, not at a file it may not be able to resolve", () => {
    const prose = verifier.replace(/\s+/g, " ");
    expect(prose).toContain("Its definition is the matching section under Lenses below");
    expect(prose).toContain("Apply only that one.");
    expect(verifier).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(verifier).not.toContain("plain meaning");
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
