import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidualPlaceholders } from "../src/core/validate-template-substitution";
import { parseRefutationVerdict, serializeRefutationVerdict, REVIEW_LENSES, REFUTATION_VERDICTS, type WaveFindingId } from "../src/core/review-panel";
import { REVIEW_PANEL_AGENTS } from "../src/config";
import { detectPhase, isReviewPanelAgent } from "../src/core/validate-phase-order";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES_DIR = join(REPO_ROOT, "commands", "templates");
const TEMPLATE = "review-verify.md";
const VARS = ["lens_name", "lens_prompt", "finding_manifest_path", "brief_file_path"];

const runbook = readFileSync(join(REPO_ROOT, "commands", "wave-gate.md"), "utf-8");
const lensReference = readFileSync(join(REPO_ROOT, "references", "review-lenses.md"), "utf-8");
const template = readFileSync(join(TEMPLATES_DIR, TEMPLATE), "utf-8");

/** Substitute every declared variable with a dummy value, as the gate does. */
function substitute(raw: string, values: Record<string, string> = {}): string {
  let out = raw;
  for (const v of VARS) out = out.split(`{${v}}`).join(values[v] ?? `DUMMY_${v}`);
  return out;
}

/** The `## <lens>` section of review-lenses.md, as the gate slices it. */
function lensFragment(lens: string): string {
  const start = lensReference.indexOf(`\n## ${lens}\n`);
  expect(start, `lens reference has no section for ${lens}`).toBeGreaterThan(-1);
  const rest = lensReference.slice(start + 1);
  const end = rest.indexOf("\n---\n");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("review-panel template placeholder audit", () => {
  it("no residual placeholders after substituting declared vars", () => {
    const residual = findResidualPlaceholders(substitute(template));
    expect(residual, `residual placeholders: ${residual.join(" ")}`).toEqual([]);
  });

  it("every declared variable appears in the template and the wave-gate runbook", () => {
    for (const v of VARS) {
      expect(template.includes(`{${v}}`), `declared but unused in template: {${v}}`).toBe(true);
      expect(runbook.includes(`{${v}}`), `runbook never substitutes: {${v}}`).toBe(true);
    }
  });

  it("every lens fragment substitutes without leaving a placeholder", () => {
    // The fragments are authored prose; a stray `{word}` in one would block the
    // verifier spawn at runtime, and only for the lens that happened to be
    // selected — the worst kind of intermittent failure.
    for (const lens of REVIEW_LENSES) {
      const substituted = substitute(template, { lens_name: lens, lens_prompt: lensFragment(lens) });
      expect(findResidualPlaceholders(substituted), `lens ${lens}`).toEqual([]);
    }
  });

  it("the lens reference documents exactly the lenses the code selects from", () => {
    const documented = [...lensReference.matchAll(/^## ([a-z-]+)$/gm)]
      .map((m) => m[1]!)
      .filter((heading) => (REVIEW_LENSES as readonly string[]).includes(heading));
    expect(documented).toEqual([...REVIEW_LENSES]);
  });

  it("the template names the verifier's output contract", () => {
    // Derived from REFUTATION_VERDICTS, not a hand-copied list: a fourth
    // verdict kind added to the union must reach the prompt that asks for it,
    // and a hardcoded array here would go on passing while it did not.
    for (const word of [...REFUTATION_VERDICTS, "finding_id", "criterion"]) {
      expect(template).toContain(word);
    }
  });
});

describe("verifier output round-trips through the substitution gate", () => {
  it("brace-bearing reasoning is sanitized before it reaches any prompt", () => {
    const raw = JSON.stringify({
      criterion: "intent",
      verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "the {never-throw} rule is deliberate" }],
    });
    const parsed = parseRefutationVerdict(raw, "intent", ["T1:code-reviewer-1"] as unknown as readonly WaveFindingId[]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const canonical = serializeRefutationVerdict(parsed.value);
    expect(canonical).not.toContain("{never-throw}");
    expect(findResidualPlaceholders(substitute(template, { lens_prompt: canonical }))).toEqual([]);
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
