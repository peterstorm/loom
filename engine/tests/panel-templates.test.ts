import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentSkillPrompt } from "../src/core/agent-skills";
import { findResidualPlaceholders } from "../src/core/validate-template-substitution";
import { architectureCriterion, candidateFilename, parseJudgeVerdict, serializeJudgeVerdict } from "../src/core/panel-contract";
import { describeMarkdownError, markdown, orFail, rowWhere, tableWithColumns, type Table, type TableRow } from "./support/markdown";

/**
 * Template placeholder audit for every phase template (`phase-*.md`).
 *
 * The substitution authoring rule: after every DECLARED variable is
 * substituted, NO literal `{...}` placeholder may survive in the spawned prompt
 * — otherwise validate-template-substitution blocks the spawn at runtime. Any
 * naming scheme referenced in prose must use angle brackets
 * (`candidate-<lens>.md`), never braces (`candidate-{lens}.md`).
 *
 * "Declared" is what the orchestrator is told to substitute: the Variables cell
 * of the template's row in the Phases table of `commands/loom.md`, or in the
 * template table of `references/loom/panel-runbook.md`. The two sets must be
 * EQUAL. A variable the template uses and the table omits is a spawn the hook
 * refuses; a variable the table lists and the template lacks is an instruction
 * the orchestrator cannot follow.
 *
 * The residual-placeholder check imports the real detector
 * (findResidualPlaceholders) from validate-template-substitution so the two can
 * never drift: strip `${shell}` expansions, then match `{identifier}` minus the
 * {type}/{id}/{name} false-positive set.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES_DIR = join(REPO_ROOT, "commands", "templates");
const readTemplate = (file: string) => readFileSync(join(TEMPLATES_DIR, file), "utf-8");

/** The documents that tell the orchestrator which variables to substitute. */
const SUBSTITUTION_CONTRACTS = [
  ["commands/loom.md", readFileSync(join(REPO_ROOT, "commands", "loom.md"), "utf-8")],
  ["references/loom/panel-runbook.md", readFileSync(join(REPO_ROOT, "references", "loom", "panel-runbook.md"), "utf-8")],
] as const;

/** The agent each phase template is spawned for. */
const TEMPLATE_AGENT: Readonly<Record<string, string>> = {
  "phase-brainstorm.md": "brainstorm-agent",
  "phase-specify.md": "specify-agent",
  "phase-clarify.md": "clarify-agent",
  "phase-architecture.md": "architecture-agent",
  "phase-plan-alignment.md": "plan-alignment-agent",
  "phase-decompose.md": "decompose-agent",
  "phase-arch-interview.md": "arch-interviewer-agent",
  "phase-arch-design.md": "arch-designer-agent",
  "phase-arch-judge.md": "arch-judge-agent",
  "phase-arch-finalize.md": "architecture-agent",
};

const PHASE_TEMPLATES = readdirSync(TEMPLATES_DIR).filter((file) => /^phase-.*\.md$/.test(file)).sort();

/** A document's substitution table: its one table with a Template and a Variables column. */
const substitutionTable = ([name, text]: (typeof SUBSTITUTION_CONTRACTS)[number]): Table<"Template" | "Variables"> =>
  orFail(tableWithColumns(markdown(name, text), ["Template", "Variables"]), describeMarkdownError);

/**
 * The row of one document's substitution table whose Template cell names the
 * file, or none. A template named only in another table or in prose is not
 * declared there: only the table with a Variables column declares.
 */
function declarationIn(contract: (typeof SUBSTITUTION_CONTRACTS)[number], file: string): readonly TableRow<"Template" | "Variables">[] {
  const row = rowWhere(substitutionTable(contract), "Template", `\`${file}\``);
  if (row.ok) return [row.value];
  if (row.error.kind === "row-not-found") return [];
  throw new Error(describeMarkdownError(row.error));
}

/** The variables the orchestrator is told to substitute for a template: the `{name}` tokens of its Variables cell. */
function declaredVariables(file: string): readonly string[] {
  const declarations = SUBSTITUTION_CONTRACTS.flatMap((contract) => declarationIn(contract, file));
  expect(declarations.length, `${file} must be declared in exactly one substitution table`).toBe(1);
  const [declaration] = declarations;
  if (declaration === undefined) return [];
  return [...declaration.cells.Variables.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(([, name]) => name);
}

/** Substitute every declared variable with a dummy value. */
function substitute(template: string, vars: readonly string[]): string {
  let out = template;
  for (const v of vars) {
    out = out.split(`{${v}}`).join(`DUMMY_${v}`);
  }
  return out;
}

describe("phase template placeholder audit", () => {
  it("covers every phase template on disk", () => {
    expect(PHASE_TEMPLATES).toEqual(Object.keys(TEMPLATE_AGENT).sort());
  });

  for (const contract of SUBSTITUTION_CONTRACTS) {
    it(`${contract[0]} has one substitution table, with a Template and a Variables column`, () => {
      expect(substitutionTable(contract).rows.length).toBeGreaterThan(0);
    });
  }

  for (const file of PHASE_TEMPLATES) {
    it(`${file} — the template's placeholders equal the variables its substitution table declares`, () => {
      const used = [...new Set(findResidualPlaceholders(readTemplate(file)).map((token) => token.slice(1, -1)))].sort();
      expect(used).toEqual([...new Set(declaredVariables(file))].sort());
    });

    it(`${file} — no residual placeholders after substituting declared vars`, () => {
      const residual = findResidualPlaceholders(substitute(readTemplate(file), declaredVariables(file)));
      expect(residual, `residual placeholders: ${residual.join(" ")}`).toEqual([]);
    });

    it(`${file} — names every skill its agent requires (validate-agent-skill gate)`, () => {
      const agent = readFileSync(join(REPO_ROOT, "agents", `${TEMPLATE_AGENT[file]}.md`), "utf-8");
      expect(checkAgentSkillPrompt(agent, readTemplate(file))).toEqual({ ok: true });
    });
  }
});

/**
 * Round-trip: untrusted judge output is parsed, schema-checked, and sanitized
 * before its canonical JSON is substituted into the finalize prompt.
 */
describe("panel-mode judge-verdict round-trip through the substitution gate", () => {
  const FINALIZE = "phase-arch-finalize.md";

  /** Substitute the finalize template with `{judge_verdicts}` set to `verdicts`
   *  and every other declared var to a dummy, mirroring the orchestrator. */
  function finalizeWithVerdicts(verdicts: string): string {
    let out = readTemplate(FINALIZE);
    for (const v of declaredVariables(FINALIZE)) {
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
          candidate: "candidate-simplicity-first.md",
          score: 7,
          fatal_flaw: null,
          strongest_idea: "prefer the {simplicity} adapter over the layered one",
        },
      ],
    });
    const expectedCriterion = architectureCriterion("simplicity");
    if (expectedCriterion === null) throw new Error("fixture criterion is outside the validated interview vocabulary");
    const parsed = parseJudgeVerdict(raw, expectedCriterion, [candidateFilename("simplicity-first")]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const canonical = serializeJudgeVerdict(parsed.value);
    expect(canonical).not.toContain("{simplicity}");
    expect(findResidualPlaceholders(finalizeWithVerdicts(canonical))).toEqual([]);
  });
});
