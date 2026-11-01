/**
 * The brief's owner duties (plan AD-10, FR-027, AS-028): a duty paragraph per
 * owned Invariant the Task touches (`taskOwnerDuty`, any role), naming
 * the coverage duty (the matrix test must import the owner and every sibling)
 * and the mutation duty (the owner's changed lines are mutation-verified) or
 * the declared exemption. Rendered only when the graph carries the
 * `owner_obligations` stamp, so pre-feature graphs get no false duty. On a
 * stamped graph the stamp is the only source of the whole ownership section
 * (#134); a pre-feature graph renders the plan's own blocks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  NO_INVARIANT_OWNERSHIP,
  RULE_DOCUMENTS,
  renderImplementationBrief,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { obligationsFromPlan } from "../../src/core/owner-verification/obligations";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import type { PlanInvariant, Task } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { taskFixture } from "../fixtures/task-lifecycle";
import { briefOwnership, ownerObligation } from "../fixtures/owner-obligation";
import {
  ADMISSION,
  ADMISSION_FEE_TABLE_PLAN_TEXT,
  ADMISSION_FEE_TABLE_STAMP,
  CLOCK,
  FEE_TABLE,
  FEES,
  FEES_CLOCK_PLAN_TEXT,
  paragraphs,
  someParagraph,
} from "../fixtures/owner-families";

const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
  [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));

const STAMP = ADMISSION_FEE_TABLE_STAMP;

/** The plan the stamp is derived from. */
const PLAN_MODELS = parsePlanModels(ADMISSION_FEE_TABLE_PLAN_TEXT);
const INVARIANTS: readonly PlanInvariant[] = PLAN_MODELS.invariants;

const task = (fileList: readonly string[]): Task => taskFixture({
  id: "T1", description: "Change a family", agent: "code-implementer-agent", wave: 1, depends_on: [],
  file_list: [...fileList],
});

function ownership(fileList: readonly string[], stamp: readonly OwnerObligation[] | undefined): string {
  const value = task(fileList);
  const derivation = deriveTaskImplementationDispatch(value);
  if (derivation.kind !== "dispatch") throw new Error(`fixture must be owed a dispatch, got ${derivation.kind}`);
  const input: ImplementationBriefInput = {
    template: TEMPLATE,
    task: value,
    dispatch: derivation.dispatch,
    verificationManifest: undefined,
    planFile: ".claude/plans/plan.md",
    spec: { kind: "unavailable", reason: { kind: "no-spec-file" } },
    rules: RULES,
    roster: [],
    contracts: [],
    repositoryRoot: "/repo",
    operatorNotes: [],
    ownership: briefOwnership(stamp, INVARIANTS, value.file_list ?? []),
  };
  const rendered = renderImplementationBrief(input);
  if (!rendered.ok) throw new Error(rendered.error.message);
  const prompt = rendered.value.prompt;
  const start = prompt.indexOf("## Invariant Ownership");
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end < 0 ? undefined : end);
}

describe("owner duties in the brief (AD-10)", () => {
  it("the fixture stamp is the one population derives from the fixture plan", () => {
    expect(obligationsFromPlan(PLAN_MODELS)).toEqual({ ok: true, value: STAMP });
  });

  it("the FEES / CLOCK fixture plan derives exactly the FEES / CLOCK obligations", () => {
    expect(obligationsFromPlan(parsePlanModels(FEES_CLOCK_PLAN_TEXT))).toEqual({ ok: true, value: [FEES, CLOCK] });
  });

  it("AS-028: the owner Task's brief names the import duty over owner and every sibling, and the mutation duty", () => {
    const section = ownership([ADMISSION.owner], STAMP);
    expect(someParagraph(section, "must import", ADMISSION.matrixTest, ADMISSION.owner, "src/rules/sibling-a.ts", "src/rules/sibling-b.ts"))
      .toBe(true);
    expect(someParagraph(section, "mutation-verified", "changed", ADMISSION.owner, ADMISSION.matrixTest)).toBe(true);
    expect(section).not.toContain(FEE_TABLE.invariant);
  });

  it("AS-028: the matrix-test author's brief for an exempt Invariant names the exemption and its reason", () => {
    const section = ownership([FEE_TABLE.matrixTest], STAMP);
    expect(someParagraph(section, "must import", FEE_TABLE.matrixTest, FEE_TABLE.owner)).toBe(true);
    expect(someParagraph(section, "exempt", "generated lookup table")).toBe(true);
    expect(section).not.toContain("mutation-verified");
  });

  it("AS-028: a sibling Task is owed the duties of the family it touches", () => {
    const section = ownership(["src/rules/sibling-b.ts"], STAMP);
    expect(someParagraph(section, "**Owner duties (INV-1):**", "must import")).toBe(true);
  });

  it("FR-027: a graph without owner_obligations renders no duty paragraph (no false duty)", () => {
    const withStamp = ownership([ADMISSION.owner], STAMP);
    const without = ownership([ADMISSION.owner], undefined);
    expect(without).not.toContain("must import");
    expect(without).not.toContain("mutation-verified");
    // The stamp only adds the two duty paragraphs; every other paragraph is unchanged.
    const before = paragraphs(without);
    const added = paragraphs(withStamp).filter((paragraph) => !before.includes(paragraph));
    expect(paragraphs(withStamp).filter((paragraph) => before.includes(paragraph))).toEqual(before);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatch(/^\*\*Owner duties \(INV-1\):\*\*/);
  });

  it("FR-027: a Task touching no owned family renders no duty", () => {
    expect(ownership(["src/other.ts"], STAMP)).not.toContain("Owner duties");
  });

  it("#134: a touched stamped obligation the plan does not declare renders whole, from the stamp", () => {
    const drifted: OwnerObligation = ownerObligation({
      invariant: "INV-9",
      title: "Ledgers are balanced only by the balancer",
      statement: "Every entry is balanced by balance().",
      owner: "src/ledger/balance.ts",
      siblings: [{ path: "src/api/post.ts", note: "posts entries" }],
      matrixTest: "tests/balance.matrix.test.ts",
      mutation: { kind: "verify" },
    });
    const section = ownership([drifted.owner], [...STAMP, drifted]);
    expect(INVARIANTS.map(({ id }) => id)).not.toContain("INV-9");
    expect(paragraphs(section)).toContain(`**INV-9: ${drifted.title}**\n${drifted.statement}`);
    expect(someParagraph(section, "**Your role:**", `- Owner: you change the owner module \`${drifted.owner}\``)).toBe(true);
    expect(someParagraph(section, `**Owner module:** \`${drifted.owner}\``, "- `src/api/post.ts` — posts entries", `**Matrix test:** \`${drifted.matrixTest}\``))
      .toBe(true);
    expect(someParagraph(section, "**Owner duties (INV-9):**", "must import", drifted.owner, "src/api/post.ts", drifted.matrixTest)).toBe(true);
    expect(someParagraph(section, "mutation-verified", drifted.owner, drifted.matrixTest)).toBe(true);
    expect(section).not.toContain(ADMISSION.invariant);
  });

  it("#134: on a stamped graph the stamp is the only source: a plan Invariant the stamp lacks renders nothing", () => {
    expect(ownership([ADMISSION.owner], [FEE_TABLE])).toContain(NO_INVARIANT_OWNERSHIP);
  });

  it("#134: on a stamped graph the stamp's prose wins over the plan's when they differ", () => {
    const restated = ownerObligation({ ...ADMISSION, statement: "Admission goes through decide() and nothing else." });
    const section = ownership([ADMISSION.owner], [restated, FEE_TABLE]);
    expect(section).toContain(restated.statement!);
    expect(section).not.toContain(ADMISSION.statement!);
  });

  it("#134: a stamp that agrees with the plan renders the plan's blocks byte for byte, each followed by its two duty paragraphs", () => {
    const universe = [
      ADMISSION.owner, ...ADMISSION.siblings.map(({ path }) => path), ADMISSION.matrixTest,
      FEE_TABLE.owner, FEE_TABLE.matrixTest, "src/other.ts",
    ];
    fc.assert(fc.property(fc.subarray(universe), (files) => {
      const stamped = paragraphs(ownership(files, STAMP));
      const fromPlan = paragraphs(ownership(files, undefined));
      const dutyAt = stamped.flatMap((paragraph, index) => paragraph.startsWith("**Owner duties (") ? [index, index + 1] : []);
      expect(stamped.filter((_, index) => !dutyAt.includes(index))).toEqual(fromPlan);
    }));
  });
});
