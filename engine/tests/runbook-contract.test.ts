import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_PANEL_OPERATIONS } from "../src/handlers/helpers/review-panel";
import { PANEL_CONTRACT_OPERATIONS } from "../src/handlers/helpers/panel-contract";
import {
  CODEBASE_MATURITIES,
  PRIMARY_AXES,
  TESTABILITY_BARS,
} from "../src/core/panel-contract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf-8");

/**
 * The runbooks are executable prose: `commands/loom.md` and
 * `commands/wave-gate.md` tell a model which helper to invoke, with which
 * flags, in which order. The engine's side of every one of those calls is
 * proven — by unit tests, by CLI-driven tests, and by the two smoke scripts.
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
    label: "review panel",
    helper: "review-panel",
    runbook: "commands/wave-gate.md",
    prose: read("commands", "wave-gate.md"),
    operations: REVIEW_PANEL_OPERATIONS,
  },
  {
    label: "architecture panel",
    helper: "panel-contract",
    runbook: "commands/loom.md",
    prose: read("commands", "loom.md"),
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
    expect(flagsRead(helper).length).toBeGreaterThanOrEqual(4);
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
 * renaming a field in the code would leave both prose files describing a digest
 * the parser rejects — and the failure would land on the first `panel-contract
 * interview` call of every run, with a diagnostic pointing at the agent rather
 * than at the rename that caused it.
 */
describe("interview digest vocabulary ↔ parseInterviewDigest", () => {
  const SOURCES = [
    ["agents/arch-interviewer-agent.md", read("agents", "arch-interviewer-agent.md")],
    ["commands/templates/phase-arch-interview.md", read("commands", "templates", "phase-arch-interview.md")],
  ] as const;

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

  it("the two prose sources agree with each other", () => {
    // They are written and edited independently; a label fixed in one and
    // missed in the other is drift the per-file checks above cannot see.
    const [, agent] = SOURCES[0];
    const [, template] = SOURCES[1];
    for (const label of LABELS) {
      expect(agent.includes(label)).toBe(template.includes(label));
    }
  });
});
