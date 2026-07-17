import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Template placeholder audit for the four panel-mode templates.
 *
 * Encodes the substitution authoring rule from the panel-mode plan's hook-gate
 * audit: after every DECLARED variable is substituted, NO literal `{...}`
 * placeholder may survive in the spawned prompt — otherwise
 * validate-template-substitution blocks the Task spawn at runtime. Any naming
 * scheme referenced in prose must use angle brackets (`candidate-<lens>.md`),
 * never braces (`candidate-{lens}.md`).
 *
 * The residual-placeholder check mirrors validate-template-substitution exactly:
 * strip `${shell}` expansions, then match `{identifier}` minus the
 * {type}/{id}/{name} false-positive set.
 */

const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "commands",
  "templates",
);

// Declared variables per template — the exact set the orchestrator substitutes.
const TEMPLATES: Record<string, string[]> = {
  "phase-arch-interview.md": ["feature_description", "spec_file_path", "interview_file_path"],
  "phase-arch-design.md": [
    "feature_description",
    "lens_name",
    "lens_prompt",
    "spec_file_path",
    "interview_file_path",
    "candidate_output_path",
  ],
  "phase-arch-judge.md": ["criterion", "candidates_dir", "interview_excerpt"],
  "phase-arch-finalize.md": [
    "feature_description",
    "spec_file_path",
    "interview_file_path",
    "candidates_dir",
    "judge_verdicts",
    "date_slug",
  ],
};

const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}"]);

/** Substitute every declared variable with a dummy value. */
function substitute(template: string, vars: string[]): string {
  let out = template;
  for (const v of vars) {
    out = out.split(`{${v}}`).join(`DUMMY_${v}`);
  }
  return out;
}

/** The exact residual-placeholder detection from validate-template-substitution. */
function residualPlaceholders(prompt: string): string[] {
  const cleaned = prompt.replace(/\$\{[^}]*\}/g, "");
  const matches = cleaned.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? [];
  return matches.filter((v) => !FALSE_POSITIVES.has(v));
}

describe("panel-mode template placeholder audit", () => {
  for (const [file, vars] of Object.entries(TEMPLATES)) {
    it(`${file} — no residual placeholders after substituting declared vars`, () => {
      const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      const substituted = substitute(raw, vars);
      const residual = residualPlaceholders(substituted);
      expect(residual, `residual placeholders: ${residual.join(" ")}`).toEqual([]);
    });

    it(`${file} — every declared variable actually appears in the template`, () => {
      const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      for (const v of vars) {
        expect(raw.includes(`{${v}}`), `declared but unused: {${v}}`).toBe(true);
      }
    });
  }

  it("finalize template references the architecture-tech-lead skill (validate-agent-skill gate)", () => {
    const raw = readFileSync(join(TEMPLATES_DIR, "phase-arch-finalize.md"), "utf-8");
    expect(raw).toContain("architecture-tech-lead");
  });

  it("design template references the architecture-tech-lead skill (designers do design work)", () => {
    const raw = readFileSync(join(TEMPLATES_DIR, "phase-arch-design.md"), "utf-8");
    expect(raw).toContain("architecture-tech-lead");
  });
});
