import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidualPlaceholders } from "../src/core/validate-template-substitution";

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
 * The residual-placeholder check imports the real detector
 * (findResidualPlaceholders) from validate-template-substitution so the two can
 * never drift: strip `${shell}` expansions, then match `{identifier}` minus the
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

/** Substitute every declared variable with a dummy value. */
function substitute(template: string, vars: string[]): string {
  let out = template;
  for (const v of vars) {
    out = out.split(`{${v}}`).join(`DUMMY_${v}`);
  }
  return out;
}

describe("panel-mode template placeholder audit", () => {
  for (const [file, vars] of Object.entries(TEMPLATES)) {
    it(`${file} — no residual placeholders after substituting declared vars`, () => {
      const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      const substituted = substitute(raw, vars);
      const residual = findResidualPlaceholders(substituted);
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

/**
 * Round-trip: judge verdicts are inlined VERBATIM into the finalize prompt via
 * {judge_verdicts}, then that prompt passes through validate-template-substitution
 * at spawn. The judge template forbids `{`/`}` in free-text values precisely
 * because a brace-word would read as an unsubstituted placeholder and block the
 * finalize spawn AFTER N designers + K judges already ran. These tests pin both
 * halves of that contract: well-formed judge JSON survives the gate, and a
 * rule-violating brace-word is exactly what the gate catches.
 */
describe("panel-mode judge-verdict round-trip through the substitution gate", () => {
  const FINALIZE = "phase-arch-finalize.md";
  const FINALIZE_VARS = TEMPLATES[FINALIZE]!;

  /** Substitute the finalize template with `{judge_verdicts}` set to `verdicts`
   *  and every other declared var to a dummy, mirroring the orchestrator. */
  function finalizeWithVerdicts(verdicts: string): string {
    const raw = readFileSync(join(TEMPLATES_DIR, FINALIZE), "utf-8");
    let out = raw;
    for (const v of FINALIZE_VARS) {
      const value = v === "judge_verdicts" ? verdicts : `DUMMY_${v}`;
      out = out.split(`{${v}}`).join(value);
    }
    return out;
  }

  it("well-formed judge JSON (structural braces, brace-free prose) leaves no residual", () => {
    const verdicts = JSON.stringify(
      {
        criterion: "simplicity",
        rankings: [
          {
            candidate: "candidate-testability.md",
            score: 8,
            fatal_flaw: "leaks persistence concerns into the functional core",
            strongest_idea: "a single pure reducer for all state transitions",
          },
          {
            candidate: "candidate-simplicity.md",
            score: 6,
            fatal_flaw: null,
            strongest_idea: "collapse the two adapters into one port",
          },
        ],
      },
      null,
      2,
    );
    // JSON structural `{` is always followed by whitespace/`"`, never a bare
    // identifier, so the detector does not mistake it for a placeholder.
    expect(findResidualPlaceholders(finalizeWithVerdicts(verdicts))).toEqual([]);
  });

  it("a judge violating the no-brace rule (brace-word in prose) is caught by the gate", () => {
    const verdicts = JSON.stringify(
      {
        criterion: "simplicity",
        rankings: [
          {
            candidate: "candidate-simplicity.md",
            score: 7,
            fatal_flaw: null,
            // Rule violation: a brace-wrapped word in free-text prose.
            strongest_idea: "prefer the {simplicity} adapter over the layered one",
          },
        ],
      },
      null,
      2,
    );
    // Documents the failure mode: the finalize spawn would be BLOCKED at runtime.
    expect(findResidualPlaceholders(finalizeWithVerdicts(verdicts))).toContain("{simplicity}");
  });
});
