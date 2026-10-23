/**
 * CT-1 acceptance: the plan's mutation-exemption grammar.
 *
 * An owned Invariant may declare `**Mutation exemption:** <reason>`. The
 * production plan grammar (`parsePlanModels`) reads it into the owned
 * ownership's `mutation` policy, and the one plan validator every populate,
 * repair and validate run goes through (`checkPlanModelBindings`, over
 * `validateModelBindings`) refuses an exemption without a reason and an
 * exemption on an unowned Invariant as malformed ownership, naming the
 * Invariant.
 */

import { describe, expect, it } from "vitest";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import type { MutationPolicy } from "../../src/core/owner-verification/types";
import {
  checkPlanModelBindings,
  validateModelBindings,
  type ModelBindingDeps,
} from "../../src/handlers/helpers/validate-model-bindings";

const PLAN_FILE = ".claude/plans/exemption.md";

const OWNED_FIELDS = [
  "**Tier:** advisory",
  "**Owner module:** `src/rules/owner.ts`",
  "**Sibling entry points:**",
  "- `src/rules/sibling-a.ts` — admits members",
  "- `src/rules/sibling-b.ts` — admits guests",
  "**Matrix test:** `tests/rules.matrix.test.ts`",
  "**Statement:** Every entry point admits through decide().",
];

const UNOWNED_FIELDS = [
  "**Tier:** advisory",
  "**Owner module:** none",
  "**Unowned reason:** A prohibition with no implementation to home.",
  "**Statement:** No module reads the clock directly.",
];

/** A plan whose `## Invariants` holds one block per entry, each `### INV-n: title` with its fields. */
const plan = (...blocks: readonly (readonly [string, readonly string[]])[]): string => [
  "# Plan: exemption fixture",
  "",
  "## Invariants",
  "",
  ...blocks.flatMap(([heading, fields]) => [`### ${heading}`, "", ...fields, ""]),
].join("\n");

/** Every declared path exists, so only the exemption grammar can fail validation. */
const DEPS: ModelBindingDeps = {
  readFile: () => ({ ok: false, error: "ENOENT" }),
  pathPresence: () => ({ kind: "present" }),
};

/** The populate / repair / validate entry point over plan text. */
const DEPS_WITH_PLAN = (text: string): ModelBindingDeps => ({
  readFile: (path) => path === PLAN_FILE ? { ok: true, content: text } : { ok: false, error: "ENOENT" },
  pathPresence: () => ({ kind: "present" }),
});

const errorsOf = (text: string): readonly string[] => {
  const result = validateModelBindings(parsePlanModels(text), [], DEPS);
  return result.ok ? [] : result.errors;
};

const mutationOf = (text: string): MutationPolicy | "not-owned" => {
  const ownership = parsePlanModels(text).invariants[0]!.ownership;
  return ownership.kind === "owned" && "mutation" in ownership ? (ownership as { mutation: MutationPolicy }).mutation : "not-owned";
};

describe("mutation exemption grammar (CT-1)", () => {
  it("FR-018: an owned Invariant with a non-empty exemption reason parses as exempt, carrying the reason", () => {
    const text = plan(["INV-1: Admission is decided only by the owner", [
      ...OWNED_FIELDS,
      "**Mutation exemption:** The owner is a generated lookup table; every mutant is equivalent.",
    ]]);
    expect(mutationOf(text)).toEqual({ kind: "exempt", reason: "The owner is a generated lookup table; every mutant is equivalent." });
    expect(parsePlanModels(text).strays).toEqual([]);
    expect(errorsOf(text)).toEqual([]);
  });

  it("FR-018: an owned Invariant without the field is mutation-verified", () => {
    expect(mutationOf(plan(["INV-1: Admission is decided only by the owner", OWNED_FIELDS]))).toEqual({ kind: "verify" });
  });

  it("FR-018: the exemption label outside `## Invariants` is a misplaced-label stray", () => {
    const text = `${plan(["INV-1: Admission is decided only by the owner", OWNED_FIELDS])}\n## Notes\n\n**Mutation exemption:** stray reason\n`;
    expect(parsePlanModels(text).strays).toContainEqual({ kind: "misplaced-label", label: "Mutation exemption", home: "Invariants" });
  });

  it("AS-019: FR-019: an exemption with no reason fails validation naming the Invariant", () => {
    for (const blank of ["**Mutation exemption:**", "**Mutation exemption:**    ", "**Mutation exemption:** ``"]) {
      const text = plan(["INV-1: Admission is decided only by the owner", [...OWNED_FIELDS, blank]]);
      const ownership = parsePlanModels(text).invariants[0]!.ownership;
      expect(ownership).toEqual({ kind: "malformed", problems: [{ kind: "exemption-without-reason" }] });
      const errors = errorsOf(text);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("INV-1");
      expect(errors[0]).toContain("Mutation exemption");
    }
  });

  it("AS-020: FR-019: an exemption on an unowned Invariant fails validation — it is meaningful only on an owned one", () => {
    const text = plan(["INV-2: No clock reads", [...UNOWNED_FIELDS, "**Mutation exemption:** nothing to mutate"]]);
    const ownership = parsePlanModels(text).invariants[0]!.ownership;
    expect(ownership).toEqual({ kind: "malformed", problems: [{ kind: "exemption-on-unowned" }] });
    const errors = errorsOf(text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("INV-2");
    expect(errors[0]).toContain("Mutation exemption");
  });

  it("FR-019: AS-019: AS-020: the populate, repair and validate entry point refuses both malformed exemptions and admits a reasoned one", () => {
    const blank = plan(["INV-1: Admission is decided only by the owner", [...OWNED_FIELDS, "**Mutation exemption:**"]]);
    const unowned = plan(["INV-2: No clock reads", [...UNOWNED_FIELDS, "**Mutation exemption:** nothing to mutate"]]);
    const reasoned = plan(["INV-1: Admission is decided only by the owner", [...OWNED_FIELDS, "**Mutation exemption:** equivalent mutants only"]]);

    const refusedBlank = checkPlanModelBindings(PLAN_FILE, [], DEPS_WITH_PLAN(blank));
    expect(refusedBlank.kind).toBe("invalid-bindings");
    expect(refusedBlank.ok ? [] : refusedBlank.errors).toEqual([expect.stringMatching(/INV-1.*Mutation exemption/)]);

    const refusedUnowned = checkPlanModelBindings(PLAN_FILE, [], DEPS_WITH_PLAN(unowned));
    expect(refusedUnowned.kind).toBe("invalid-bindings");
    expect(refusedUnowned.ok ? [] : refusedUnowned.errors).toEqual([expect.stringMatching(/INV-2.*Mutation exemption/)]);

    const admitted = checkPlanModelBindings(PLAN_FILE, [], DEPS_WITH_PLAN(reasoned));
    expect(admitted.kind).toBe("validated");
    if (admitted.kind === "validated") {
      const ownership = admitted.models.invariants[0]!.ownership;
      expect(ownership).toMatchObject({ kind: "owned", mutation: { kind: "exempt", reason: "equivalent mutants only" } });
    }
  });
});
