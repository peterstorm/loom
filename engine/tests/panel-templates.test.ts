import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidualPlaceholders } from "../src/core/validate-template-substitution";
import { candidateFilename, parseJudgeVerdict, serializeJudgeVerdict } from "../src/core/panel-contract";

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
  "phase-arch-interview.md": ["feature_description", "spec_file_path", "interview_file_path", "loom_dir"],
  "phase-arch-design.md": [
    "feature_description",
    "lens_name",
    "lens_prompt",
    "spec_file_path",
    "interview_file_path",
    "candidate_output_path",
  ],
  "phase-arch-judge.md": ["criterion", "candidate_manifest_path", "interview_json_path"],
  "phase-arch-finalize.md": [
    "feature_description",
    "spec_file_path",
    "interview_file_path",
    "candidate_manifest_path",
    "judge_verdicts",
    "panel_ranking",
    "date_slug",
    "loom_dir",
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
  const loomRunbook = readFileSync(join(TEMPLATES_DIR, "..", "loom.md"), "utf-8");

  for (const [file, vars] of Object.entries(TEMPLATES)) {
    it(`${file} — no residual placeholders after substituting declared vars`, () => {
      const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      const substituted = substitute(raw, vars);
      const residual = findResidualPlaceholders(substituted);
      expect(residual, `residual placeholders: ${residual.join(" ")}`).toEqual([]);
    });

    it(`${file} — every declared variable appears in template and runbook substitution contract`, () => {
      const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      for (const v of vars) {
        expect(raw.includes(`{${v}}`), `declared but unused in template: {${v}}`).toBe(true);
        expect(loomRunbook.includes(`{${v}}`), `runbook never substitutes: {${v}}`).toBe(true);
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
 * Round-trip: untrusted judge output is parsed, schema-checked, and sanitized
 * before its canonical JSON is substituted into the finalize prompt.
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

  it("brace-bearing judge prose is sanitized before final-template substitution", () => {
    const raw = JSON.stringify({
      criterion: "simplicity",
      rankings: [
        {
          candidate: "candidate-simplicity.md",
          score: 7,
          fatal_flaw: null,
          strongest_idea: "prefer the {simplicity} adapter over the layered one",
        },
      ],
    });
    const parsed = parseJudgeVerdict(raw, "simplicity", [candidateFilename("simplicity")]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const canonical = serializeJudgeVerdict(parsed.value);
    expect(canonical).not.toContain("{simplicity}");
    expect(findResidualPlaceholders(finalizeWithVerdicts(canonical))).toEqual([]);
  });
});
