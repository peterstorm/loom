/**
 * The brief's owner duties (plan AD-10, FR-027, AS-028): a duty paragraph per
 * owned Invariant the Task touches (`obligationsTouchedBy`, any role), naming
 * the coverage duty (the matrix test must import the owner and every sibling)
 * and the mutation duty (the owner's changed lines are mutation-verified) or
 * the declared exemption. Rendered only when the graph carries the
 * `owner_obligations` stamp, so pre-feature graphs get no false duty.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
  [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));

const ADMISSION: OwnerObligation = {
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: "Every entry point admits through decide().",
  owner: "src/rules/owner.ts",
  siblings: [
    { path: "src/rules/sibling-a.ts", note: "admits members" },
    { path: "src/rules/sibling-b.ts", note: null },
  ],
  matrixTest: "tests/rules.matrix.test.ts",
  mutation: { kind: "verify" },
};

const FEES: OwnerObligation = {
  invariant: "INV-4",
  title: "Fees are computed only by the fee table",
  statement: null,
  owner: "src/fees/table.ts",
  siblings: [],
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: { kind: "exempt", reason: "generated lookup table" },
};

const STAMP: readonly OwnerObligation[] = [ADMISSION, FEES];

/** The plan the stamp is derived from. */
const PLAN_MODELS = parsePlanModels([
  "# Plan: duties", "",
  "## Invariants", "",
  "### INV-1: Admission is decided only by the owner", "",
  "**Tier:** advisory",
  "**Owner module:** `src/rules/owner.ts`",
  "**Sibling entry points:**",
  "- `src/rules/sibling-a.ts` — admits members",
  "- `src/rules/sibling-b.ts`",
  "**Matrix test:** `tests/rules.matrix.test.ts`",
  "**Statement:** Every entry point admits through decide().", "",
  "### INV-4: Fees are computed only by the fee table", "",
  "**Tier:** advisory",
  "**Owner module:** src/fees/table.ts",
  "**Sibling entry points:** none",
  "**Matrix test:** tests/fees.matrix.test.ts",
  "**Mutation exemption:** generated lookup table", "",
].join("\n"));
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
    invariants: INVARIANTS,
    contracts: [],
    repositoryRoot: "/repo",
    operatorNotes: [],
    ...(stamp === undefined ? {} : { ownerObligations: stamp }),
  };
  const rendered = renderImplementationBrief(input);
  if (!rendered.ok) throw new Error(rendered.error.message);
  const prompt = rendered.value.prompt;
  const start = prompt.indexOf("## Invariant Ownership");
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end < 0 ? undefined : end);
}

const paragraphs = (text: string): readonly string[] => text.split(/\n\s*\n/);
const someParagraph = (text: string, ...needles: readonly string[]): boolean =>
  paragraphs(text).some((paragraph) => needles.every((needle) => paragraph.includes(needle)));

describe("owner duties in the brief (AD-10)", () => {
  it("the fixture stamp is the one population derives from the fixture plan", () => {
    expect(obligationsFromPlan(PLAN_MODELS)).toEqual(STAMP);
  });

  it("AS-028: the owner Task's brief names the import duty over owner and every sibling, and the mutation duty", () => {
    const section = ownership([ADMISSION.owner], STAMP);
    expect(someParagraph(section, "must import", ADMISSION.matrixTest, ADMISSION.owner, "src/rules/sibling-a.ts", "src/rules/sibling-b.ts"))
      .toBe(true);
    expect(someParagraph(section, "mutation-verified", "changed", ADMISSION.owner, ADMISSION.matrixTest)).toBe(true);
    expect(section).not.toContain(FEES.invariant);
  });

  it("AS-028: the matrix-test author's brief for an exempt Invariant names the exemption and its reason", () => {
    const section = ownership([FEES.matrixTest], STAMP);
    expect(someParagraph(section, "must import", FEES.matrixTest, FEES.owner)).toBe(true);
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

  it("FR-027: a touched stamped obligation with no plan Invariant block still states its heading and duties", () => {
    const drifted: OwnerObligation = {
      invariant: "INV-9",
      title: "Ledgers are balanced only by the balancer",
      statement: "Every entry is balanced by balance().",
      owner: "src/ledger/balance.ts",
      siblings: [{ path: "src/api/post.ts", note: null }],
      matrixTest: "tests/balance.matrix.test.ts",
      mutation: { kind: "verify" },
    };
    const section = ownership([drifted.owner], [...STAMP, drifted]);
    expect(INVARIANTS.map(({ id }) => id)).not.toContain("INV-9");
    expect(paragraphs(section)).toContain(`**INV-9: ${drifted.title}**`);
    expect(someParagraph(section, "**Owner duties (INV-9):**", "must import", drifted.owner, "src/api/post.ts", drifted.matrixTest)).toBe(true);
    expect(someParagraph(section, "mutation-verified", drifted.owner, drifted.matrixTest)).toBe(true);
    expect(section).not.toContain(ADMISSION.invariant);
  });

  it("FR-027: the duty follows the stamp, not the plan: a stamp without that Invariant owes no duty", () => {
    expect(ownership([ADMISSION.owner], [FEES])).not.toContain("Owner duties");
  });
});
