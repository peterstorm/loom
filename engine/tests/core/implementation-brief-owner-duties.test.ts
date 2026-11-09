/**
 * The brief's owner duties (plan AD-10, FR-027, AS-028): a duty paragraph per
 * owned Invariant the Task touches (`taskOwnerDuty`, any role), naming
 * the coverage duty (the matrix test must import the owner and every sibling
 * due by the Task's Wave, `duePaths`) and the mutation duty (the owner's
 * changed lines are mutation-verified) or the declared exemption. A contract
 * Task's stub owes neither (ADR-0063). Rendered only when the graph carries the
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
  invariantOwnershipSourceOf,
  renderImplementationBrief,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { obligationsFromPlan, taskOwnerDuty } from "../../src/core/owner-verification/obligations";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import type { PlanInvariant, Task } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { unobservedSkeletons } from "../fixtures/frozen-signatures";
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

/** The rest of the graph the brief reads: the other Tasks and the contracts. */
type Graph = Readonly<{ roster: readonly Task[]; contracts: readonly AcceptanceContract[] }>;

function ownership(fileList: readonly string[], stamp: readonly OwnerObligation[] | undefined, graph: Graph = { roster: [], contracts: [] }): string {
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
    roster: graph.roster,
    contracts: graph.contracts,
    repositoryRoot: "/repo",
    operatorNotes: [],
    ownership: briefOwnership(stamp, INVARIANTS, value.file_list ?? []),
    frozenSignatures: unobservedSkeletons(graphFixture(graph.roster)),
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

  it("a sibling only a later Wave adds is not this Wave's duty: the brief names the due siblings and defers the rest", () => {
    const later = taskFixture({ id: "T2", description: "Add a sibling", agent: "code-implementer-agent", wave: 2, depends_on: ["T1"], file_list: ["src/rules/sibling-b.ts"] });
    const section = ownership([ADMISSION.owner, ADMISSION.matrixTest], STAMP, { roster: [later], contracts: [] });
    expect(someParagraph(section, "must import", "every sibling entry point due by Wave 1: `src/rules/sibling-a.ts`",
      "Later Waves add `src/rules/sibling-b.ts`")).toBe(true);
    expect(someParagraph(section, "mutation-verified", ADMISSION.owner)).toBe(true);
  });

  it("a Wave the gate does not owe is told so: a sibling built before the owner is due owes nothing yet", () => {
    const owner = taskFixture({ id: "T2", description: "Build the owner", agent: "code-implementer-agent", wave: 2, depends_on: [], file_list: [ADMISSION.owner] });
    const section = ownership(["src/rules/sibling-a.ts"], STAMP, { roster: [owner], contracts: [] });
    expect(someParagraph(section, "**Owner duties (INV-1):** Wave 1 owes no owner verification for INV-1", "bind from the first Wave", "must import"))
      .toBe(true);
    // The Wave that builds the owner owes the duties outright.
    expect(ownership([ADMISSION.owner], STAMP)).not.toContain("owes no owner verification");
  });

  it("a contract Task's stub owes no owner verification: its brief says when verification starts", () => {
    const contract: AcceptanceContract = {
      schemaVersion: 1, id: "CT-1", title: "Admission surface", statement: "s", contractTask: "T1",
      types: { kind: "file", path: "src/rules/types.ts" },
      acceptance: [{ path: "tests/admission.acceptance.test.ts", anchors: ["AS-001"] }],
      supportedDomain: null, freeze: { state: "awaiting-red" }, revisions: [],
    };
    const section = ownership([ADMISSION.owner], STAMP, { roster: [], contracts: [contract] });
    expect(someParagraph(section, "**Owner duties (INV-1):** none in this Wave", "contract Task", "compiling stub")).toBe(true);
    expect(section).not.toContain("must import");
    expect(section).not.toContain("mutation-verified");
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

describe("invariantOwnershipSourceOf — the one stamped-or-plan choice (#134)", () => {
  const files = [ADMISSION.owner];

  it("a stamped duty is the source itself, and the plan is never read", () => {
    const duty = taskOwnerDuty({ owner_obligations: STAMP }, files);
    const read = () => { throw new Error("a stamped graph must not read the plan"); };
    expect(invariantOwnershipSourceOf(duty, read)).toEqual({ ok: true, value: duty });
  });

  it("an unstamped duty reads the plan once, and renders its Invariants", () => {
    let reads = 0;
    const source = invariantOwnershipSourceOf(taskOwnerDuty({}, files), () => {
      reads += 1;
      return { ok: true as const, value: INVARIANTS };
    });
    expect(source).toEqual({ ok: true, value: { kind: "plan", invariants: INVARIANTS } });
    expect(reads).toBe(1);
  });

  it("an unstamped duty whose plan cannot be read carries the read's refusal unchanged", () => {
    const refusal = { ok: false as const, error: "cannot read the plan plan.md" };
    expect(invariantOwnershipSourceOf(taskOwnerDuty({}, files), () => refusal)).toBe(refusal);
  });
});
