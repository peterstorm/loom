import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_CONTRACT_OPERATIONS } from "../src/handlers/helpers/panel-contract";
import {
  CODEBASE_MATURITIES,
  PRIMARY_AXES,
  TESTABILITY_BARS,
} from "../src/core/panel-contract";
import { parseExportBindings } from "../src/core/skeleton/bindings";
import { renderSkeletonOutcome } from "../src/core/skeleton/outcomes";
import type { SkeletonOutcome } from "../src/core/skeleton/types";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf-8");

/**
 * The runbooks are executable prose: `commands/loom.md` and
 * `commands/wave-gate.md` tell a model which helper to invoke, with which
 * flags, in which order. The engine's side of every one of those calls is
 * proven — by unit tests, by CLI-driven tests, and by the smoke suite.
 * What the prose SAYS about them was proven by nothing but hardcoded greps.
 *
 * That one-directional check is how `--threshold` came to be a supported flag
 * that no runbook mentioned: the tests asserted the prose contained the strings
 * someone remembered to list, so a capability the prose never gained was
 * invisible. Every assertion here is derived from code in BOTH directions —
 * the operation lists come from the handlers, the flags are read off the real
 * `argumentValue` call sites, and the interview vocabulary comes from the
 * parser's own field table.
 *
 * What this cannot prove: that the prose SEMANTICS are right. Only a model
 * executing the runbook can show that the steps mean what they say. These pin
 * the mechanical contract — names, flags, vocabulary, order — which is the part
 * that drifts silently when code moves and prose does not.
 */

/** The flags a handler actually reads, taken from its `argumentValue` calls
 *  rather than a hand-kept list — a duplicate list is one more thing to drift. */
function flagsRead(handlerPath: string): readonly string[] {
  const source = read("engine", "src", "handlers", "helpers", `${handlerPath}.ts`);
  const flags = [...source.matchAll(/argumentValue\(args,\s*"(--[a-z-]+)"\)/g)].map((m) => m[1]!);
  return [...new Set(flags)].sort();
}

/** Line-ordered operation names as the runbook actually presents them.
 *
 *  `[a-z][a-z0-9-]*`, not `[a-z]+`: a hyphenated operation like `re-tally` used
 *  to capture as `re`, and the "invokes unknown operations: re" that produced
 *  points at a name nobody wrote. The pattern must be able to express every name
 *  the operation lists can hold — which the assertion below proves it does. */
function operationOrder(prose: string, helper: string): readonly string[] {
  const pattern = new RegExp(`helper ${helper} ([a-z][a-z0-9-]*)`, "g");
  const seen: string[] = [];
  for (const match of prose.matchAll(pattern)) {
    if (!seen.includes(match[1]!)) seen.push(match[1]!);
  }
  return seen;
}

/** Does the prose mention this flag AS a flag, rather than as a prefix of a
 *  longer one? `prose.includes("--lens")` is satisfied by any `--lenses`, so the
 *  flag check could pass for a flag the runbook never documents. */
function mentionsFlag(prose: string, flag: string): boolean {
  return new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`).test(prose);
}

const PANELS = [
  {
    label: "architecture panel",
    helper: "panel-contract",
    // The panel procedure is an on-demand runbook; `commands/loom.md` only
    // tells the orchestrator when to read it.
    runbook: "references/loom/panel-runbook.md",
    prose: read("references", "loom", "panel-runbook.md"),
    operations: PANEL_CONTRACT_OPERATIONS,
  },
] as const;

describe.each(PANELS)("$label runbook ↔ $helper handler", ({ helper, runbook, prose, operations }) => {
  it("documents every operation the handler implements", () => {
    // The direction that catches a capability the prose never gained. An
    // operation an orchestrator is never told to run is an operation that never
    // runs — the engine enforcing it correctly is no consolation.
    const undocumented = operations.filter((op) => !prose.includes(`helper ${helper} ${op}`));
    expect(undocumented, `${runbook} never invokes: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("invokes no operation the handler does not implement", () => {
    // The inverse: prose naming an operation that was renamed or removed sends
    // the orchestrator into a usage error it cannot diagnose from the runbook.
    const invented = operationOrder(prose, helper)
      .filter((op) => !(operations as readonly string[]).includes(op));
    expect(invented, `${runbook} invokes unknown operations: ${invented.join(", ")}`).toEqual([]);
  });

  it("presents the operations in the order a run must perform them", () => {
    // Order is a real contract, not presentation: `manifest` cannot validate a
    // brief that does not exist, and `tally` cannot read verdicts that were
    // never written. The handler's array is the dependency chain; the runbook
    // must walk it forwards.
    expect(operationOrder(prose, helper)).toEqual([...operations]);
  });

  it("documents every flag the handler reads", () => {
    // The `--threshold` gap, generalized. A flag the handler accepts but the
    // runbook never mentions is a knob only someone reading the source knows
    // exists — and in --threshold's case, one that could weaken the panel.
    const undocumented = flagsRead(helper).filter((flag) => !mentionsFlag(prose, flag));
    expect(undocumented, `${runbook} never mentions: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("reads back the flags it derived — the extraction is not vacuously empty", () => {
    // Without this, a regex that silently matched nothing would make the flag
    // assertion above pass for every possible runbook.
    expect(flagsRead(helper).length).toBeGreaterThan(0);
    expect(flagsRead(helper)).toContain("--runs-root");
  });

  it("the operation pattern can express every name the handler declares", () => {
    // The regex is the instrument, and an instrument that cannot represent the
    // thing it measures reports a clean result on a broken input. A hyphenated
    // or digit-bearing operation added to the handler must be MATCHABLE here,
    // whether or not the runbook currently has one.
    for (const operation of operations) {
      expect(
        operationOrder(`helper ${helper} ${operation} --runs-root x`, helper),
        `operationOrder cannot capture '${operation}'`,
      ).toEqual([operation]);
    }
  });

  it("the flag check is not satisfied by a longer flag that merely starts the same", () => {
    // `--lens` vs `--lenses`: substring matching made one document the other.
    expect(mentionsFlag("pass --lenses 3", "--lens")).toBe(false);
    expect(mentionsFlag("pass --lens intent", "--lens")).toBe(true);
  });
});

/**
 * The interview digest is the one contract that is prose on BOTH sides: the
 * interviewer agent is told which labels to emit, and `parseInterviewDigest`
 * requires exactly those labels at column 0. Nothing connected the two, so
 * renaming a field in the code would leave the prose describing a digest the
 * parser rejects — and the failure would land on the first `panel-contract
 * interview` call of every run, with a diagnostic pointing at the agent rather
 * than at the rename that caused it.
 *
 * The agent definition is the ONE owner of the digest format. The spawn
 * template carries only per-run values and defers to it, so there is no second
 * copy to drift.
 */
describe("interview digest vocabulary ↔ parseInterviewDigest", () => {
  const SOURCES = [
    ["agents/arch-interviewer-agent.md", read("agents", "arch-interviewer-agent.md")],
  ] as const;
  const TEMPLATE = read("commands", "templates", "phase-arch-interview.md");

  /** The labels the parser requires, read off its own field table. */
  const LABELS = [
    ...read("engine", "src", "core", "panel-contract.ts")
      .matchAll(/\["[a-zA-Z]+", "(\*\*[^"]+:\*\*)"\]/g),
  ].map((m) => m[1]!);

  it("extracts the parser's field table — the source of truth is non-empty", () => {
    expect(LABELS.length).toBe(14);
    expect(LABELS).toContain("**Primary axis:**");
  });

  it.each(SOURCES)("%s emits every label the parser requires", (_name, prose) => {
    const missing = LABELS.filter((label) => !prose.includes(label));
    expect(missing, `missing digest labels: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(SOURCES)("%s offers every value the enums accept", (_name, prose) => {
    // A value the parser accepts but the interviewer never offers is a branch of
    // the domain model no run can ever reach.
    const values = [...PRIMARY_AXES, ...TESTABILITY_BARS, ...CODEBASE_MATURITIES];
    const missing = values.filter((value) => !prose.toLowerCase().includes(value));
    expect(missing, `interview prose never offers: ${missing.join(", ")}`).toEqual([]);
  });

  it("the spawn template defers to the agent definition instead of restating the labels", () => {
    // A second copy is edited independently of the first; a label fixed in one
    // and missed in the other is drift no per-file check can see.
    const restated = LABELS.filter((label) => TEMPLATE.includes(label));
    expect(restated, `phase-arch-interview.md restates: ${restated.join(", ")}`).toEqual([]);
    expect(TEMPLATE).toContain("your agent definition");
    expect(TEMPLATE).toContain("references/architecture-interview.md");
  });
});

describe("engine-owned orchestration runbook contract", () => {
  // The files that describe a workflow, each of which must drive it through
  // the façade.
  const runbooks = [
    ["commands/wave-gate.md", read("commands", "wave-gate.md")],
    ["skills/review-and-fix/SKILL.md", read("skills", "review-and-fix", "SKILL.md")],
  ] as const;
  // The command file is held to the recipe ban as much as the skill it defers
  // to. When it restated the workflow in its own bullets, they kept describing
  // the manual helper chain long after the registered façade replaced it —
  // including a `standalone-review finalize` step that is a guaranteed
  // contract error on exactly the runs it claimed to cover. It is now a
  // pointer, and the last test of this block keeps it one.
  const prompts = [...runbooks, ["commands/review-and-fix.md", read("commands", "review-and-fix.md")]] as const;

  it.each(runbooks)("%s starts and resumes only through the façade", (_name, prose) => {
    expect(prose).toContain("helper orchestration start");
    expect(prose).toContain("helper orchestration resume");
  });

  it.each(prompts)("%s contains no parent-executable deterministic recipes", (_name, prose) => {
    for (const forbidden of [
      "helper model-profiles agent",
      "helper review-panel brief",
      "helper review-panel manifest",
      "helper review-panel tally",
      "helper standalone-review aggregate",
      "helper standalone-review finalize",
      "GIT_INDEX_FILE",
      "git add -A",
    ]) expect(prose, `parent recipe survived: ${forbidden}`).not.toContain(forbidden);
  });

  it("makes critical remediation mandatory and advisory selection autonomous by default", () => {
    const skill = read("skills", "review-and-fix", "SKILL.md");
    const command = read("commands", "review-and-fix.md");

    expect(skill).toContain("Every surviving critical Finding is mandatory");
    expect(skill).toContain("do not ask the operator to choose advisory IDs");
    // The skill lets a critical be `unresolved` or `out-of-scope`, each of
    // which blocks installation. A command telling the parent to "always
    // fix every" critical contradicted it, so the command states no policy.
    for (const disposition of ["`repaired`", "`unresolved`", "`out-of-scope`"]) expect(skill).toContain(disposition);
    expect(command).not.toContain("always plan/fix every");
    expect(command).not.toContain("ask the user which advisories");
  });

  it("the /review-and-fix command is a pointer to the skill, not a second workflow", () => {
    const command = read("commands", "review-and-fix.md");
    const body = command.slice(command.indexOf("\n---\n", 4) + 5);
    expect(body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/review-and-fix/SKILL.md");
    expect(body).toContain('"$ARGUMENTS"');
    expect(body).not.toContain("helper ");
    expect(body).not.toMatch(/^\s*[-*] /m);
  });

  /**
   * A blocked remediation start used to be described with ONE recovery —
   * "fix the cause it names and resume the SAME run" — listing three causes it
   * applied to. For one of them it is unreachable advice: `supportPaths` come
   * from the start input, `registerProgram` admits only a byte-identical
   * re-registration, so a dirty path belonging to the remediation can never be
   * authorized by the run that refused it, no matter how many times it resumes.
   * The operator had to derive that immutability from the handle's source.
   */
  it("splits blocked-start recovery by cause rather than promising the same run always resumes", () => {
    const skill = read("skills", "review-and-fix", "SKILL.md").replace(/\s+/g, " ");

    expect(skill).toContain("start a **fresh** remediation run whose start input adds the path to `supportPaths`");
    expect(skill).toContain("a run cannot authorize a path its own start input never named");
    expect(skill).toContain("The blocked run stays in place as evidence.");
  });
});

describe("the smoke scripts this file's own header cites are actually run", () => {
  const pkg = JSON.parse(read("engine", "package.json")) as {
    scripts: Record<string, string>;
  };

  it("`npm test` invokes the smoke suite, not just vitest", () => {
    // The header above claims the helper chain is proven by the smoke suite.
    // It was not: `test` ran vitest alone, `test:smoke` was invoked by nothing,
    // and the repo has no CI — so the end-to-end harness gated nothing while
    // the prose said otherwise. All five checks finish quickly, so there is no
    // reason for them to sit outside the default
    // command. Asserted here, beside the claim, so the claim cannot go stale
    // again without a red test.
    expect(pkg.scripts.test).toContain("test:smoke");
  });

  it("`test:smoke` names every orchestration smoke script, and all exist", () => {
    const smoke = pkg.scripts["test:smoke"]!;
    for (const script of [
      "smoke-panel-mode.sh",
      "smoke-review-panel.sh",
      "smoke-standalone-review.sh",
      "smoke-orchestration-facades.ts",
      "smoke-pi-resources.sh",
    ]) {
      expect(smoke, `test:smoke does not run ${script}`).toContain(script);
      expect(
        existsSync(join(REPO_ROOT, "scripts", script)),
        `${script} is named by test:smoke but not on disk`,
      ).toBe(true);
    }
  });
});

/**
 * G2 skeletons: the prose that teaches the plan grammar and the contract
 * Task's duties is executable for a model, exactly like the runbooks above.
 * Every pin here is derived from code where code exists: the binding examples
 * are run through the real `parseExportBindings`, and the outcome wording is
 * read off `renderSkeletonOutcome`, so a grammar or wording change that the
 * prose never followed turns red here.
 */
describe("G2 skeleton prose ↔ the skeleton engine", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const decompose = read("commands", "templates", "phase-decompose.md");
  const architecture = read("commands", "templates", "phase-architecture.md");
  const planTemplate = read("references", "plan-template.md");
  const executableModels = read("references", "executable-models.md");
  // The glossary is the core plus the per-context files CONTEXT-MAP.md lists;
  // Skeleton is a core term, Export Binding and Frozen ADT live with the
  // Acceptance Contract context.
  const context = [
    read("CONTEXT.md"),
    read("docs", "contexts", "acceptance-contracts", "CONTEXT.md"),
  ].join("\n");
  const operations = read("docs", "operations.md");
  const loomRunbook = read("commands", "loom.md");

  /** Rule 12 of the decompose template, from its heading to the next rule. */
  const rule12 = (() => {
    const start = decompose.indexOf("12. **Contract tasks");
    const end = decompose.indexOf("\n---", start);
    return start === -1 ? "" : decompose.slice(start, end === -1 ? undefined : end);
  })();

  /** Every `**Export bindings:**` block the prose shows, as the engine reads it. */
  const bindingExamples = (prose: string) => {
    const blocks = [...prose.matchAll(/^\*\*Export bindings:\*\*\n(?:- .*\n?)+/gm)].map((m) => m[0]);
    return blocks.map((block) => parseExportBindings(block));
  };

  it("AS-045: decompose rule 12 says the engine writes the contract stubs and the contract Task no longer does", () => {
    expect(rule12, "rule 12 not found").not.toBe("");
    const text = flat(rule12);
    expect(text).toContain("The engine writes the contract stubs");
    expect(text).toContain("the contract task never writes a stub");
    // The pre-G2 duty is gone: the contract Task's file_list no longer
    // carries the stub files the acceptance tests import.
    expect(text).not.toContain("plus the stub files the acceptance tests import");
    expect(text).toContain("A bound path never goes in the contract task's `file_list`");
  });

  it("AS-045: rule 12 tells decompose to copy **Export bindings:** verbatim and to put each bound path on a dependent non-contract task", () => {
    const text = flat(rule12);
    expect(text).toContain("**Export bindings:**");
    expect(text).toContain("verbatim");
    expect(text).toContain("depends, directly or transitively, on the contract task");
  });

  // The grammar has ONE owner, `references/executable-models.md`. The decompose
  // template keeps the placement duties decompose acts on; the architecture
  // template only sends the agent to the owning section.
  it.each([
    ["commands/templates/phase-decompose.md", decompose],
    ["references/executable-models.md", executableModels],
  ])("FR-042: %s teaches export bindings, one contract per file, and the frozen-ADT rule", (_name, prose) => {
    const text = flat(prose);
    expect(text).toContain("**Export bindings:**");
    // Case-insensitive: the rule may open a sentence or a bold run-in heading.
    expect(text.toLowerCase()).toContain("one contract per file");
    expect(text.toLowerCase()).toContain("frozen adt");
  });

  it("FR-042: the architecture template sends the agent to the reference's export-binding and frozen-ADT sections", () => {
    const text = flat(architecture);
    expect(text).toContain("{loom_dir}/references/executable-models.md");
    expect(text).toContain("**Export bindings:**");
    expect(text).toContain("§5 Export bindings");
    expect(text).toContain("Frozen ADTs");
    expect(executableModels).toMatch(/^## 5\. Export bindings$/m);
    expect(executableModels).toMatch(/^### Frozen ADTs$/m);
  });

  it("FR-042: the reference's binding grammar example parses cleanly through parseExportBindings", () => {
    const parsed = bindingExamples(executableModels);
    expect(parsed.length, "no **Export bindings:** example in references/executable-models.md").toBeGreaterThan(0);
    for (const { bindings, problems } of parsed) {
      expect(problems).toEqual([]);
      expect(bindings.length).toBeGreaterThan(0);
    }
  });

  it("FR-042: the reference names the frozen-ADT rule's two refusals and its remedy", () => {
    const text = flat(executableModels);
    expect(text).toContain("shadows frozen ADT");
    expect(text).toContain("re-lists frozen variants");
    expect(text).toContain("Extract<");
  });

  it("the plan template shows **Export bindings:** under File Structure, and its example parses", () => {
    const section = planTemplate.indexOf("## File Structure");
    expect(section).toBeGreaterThan(-1);
    const parsed = bindingExamples(planTemplate.slice(section));
    expect(parsed.length).toBeGreaterThan(0);
    for (const { bindings, problems } of parsed) {
      expect(problems).toEqual([]);
      expect(bindings.length).toBeGreaterThan(0);
    }
  });

  it("the executable-models reference documents bindings, the Java holder shape and frozen ADTs", () => {
    const text = flat(executableModels);
    expect(text).toContain("**Export bindings:**");
    expect(text).toContain("exactly one top-level `public` interface or `final class`");
    expect(text).toContain("frozen ADT");
    expect(text).toContain("unimplemented: <name>");
  });

  it.each(["Skeleton", "Export Binding", "Frozen ADT"])("FR-044: CONTEXT.md defines the term %s", (term) => {
    expect(context).toMatch(new RegExp(`^\\*\\*${term}\\*\\*:\\n\\S`, "m"));
  });

  it("operations documents every skeleton outcome in the engine's exact wording", () => {
    const outcomes: readonly SkeletonOutcome[] = [
      { kind: "skeleton-written", origin: "spawn" },
      { kind: "no-bound-exports" },
      { kind: "contract-has-no-types-file" },
      { kind: "unsupported-language", reason: "other-extension" },
      { kind: "exists-not-skeletonized" },
      { kind: "absent-no-skeleton-owed" },
    ];
    const missing = outcomes.map(renderSkeletonOutcome).filter((wording) => !operations.includes(wording));
    expect(missing, `docs/operations.md never shows: ${missing.join(", ")}`).toEqual([]);
    expect(operations).toContain("stale against revised contract");
    expect(operations).toContain("declared-artifact-contract-violated");
  });

  it("the loom runbook's execute loop names the skeleton outcomes and the skeleton-bindings-unresolved blocker", () => {
    expect(loomRunbook).toContain("skeleton-bindings-unresolved");
    expect(loomRunbook).toContain(renderSkeletonOutcome({ kind: "exists-not-skeletonized" }));
  });
});
