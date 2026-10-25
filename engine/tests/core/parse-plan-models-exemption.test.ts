/**
 * The plan's mutation-exemption grammar (AD-3): `**Mutation exemption:**
 * <reason>` on an owned Invariant reads into `owned.mutation`; a blank one, a
 * placeholder one (`none`, `n/a`, `TBD`, ...) and one on an unowned
 * Invariant are malformed ownership, which the one plan validator (populate,
 * repair and validate) refuses naming the Invariant. A plan without the field
 * parses exactly as before, apart from the new `mutation: { kind: "verify" }`
 * member (FR-021): pinned against frozen copies of two pre-feature plans
 * (`tests/fixtures/plans/`), so editing a live plan never fails this suite.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePlanModels, renderStray, type PlanModels } from "../../src/core/parse-plan-models";
import { canonicalDigest } from "../../src/core/digest";
import {
  checkPlanModelBindings,
  validateModelBindings,
  type ModelBindingDeps,
} from "../../src/handlers/helpers/validate-model-bindings";
import type { InvariantOwnership } from "../../src/types";

const PLAN_FILE = ".claude/plans/exemption.md";
/** The live plans directory, swept only for "no exemption problem", never pinned. */
const PLANS = resolve(__dirname, "../../../.claude/plans");
/** Byte-for-byte frozen copies of two plans written before the exemption grammar. */
const FROZEN_PLANS = resolve(__dirname, "../fixtures/plans");

/**
 * Placeholder reasons the grammar refuses, written as a plan author might:
 * any case, padded, with trailing punctuation. An oracle independent of the
 * parser's own list.
 */
const PLACEHOLDERS = ["none", "n/a", "na", "tbd", "todo", "-", "—", "null", "nil", "no", "nothing"] as const;
const isPlaceholder = (reason: string): boolean =>
  (PLACEHOLDERS as readonly string[]).includes(reason.trim().replace(/[.!?,;:]+$/, "").trim().toLowerCase());

const OWNED_FIELDS = [
  "**Tier:** advisory",
  "**Owner module:** `src/rules/owner.ts`",
  "**Sibling entry points:**",
  "- `src/rules/sibling.ts` — admits members",
  "**Matrix test:** `tests/rules.matrix.test.ts`",
  "**Statement:** Every entry point admits through decide().",
];

const UNOWNED_FIELDS = [
  "**Tier:** advisory",
  "**Owner module:** none",
  "**Unowned reason:** A prohibition with no implementation to home.",
  "**Statement:** No module reads the clock directly.",
];

const plan = (heading: string, fields: readonly string[]): string =>
  ["# Plan: exemption", "", "## Invariants", "", `### ${heading}`, "", ...fields, ""].join("\n");

const ownershipOf = (text: string): InvariantOwnership => parsePlanModels(text).invariants[0]!.ownership;

/** Every declared path exists and every rule file is unreadable, so only the grammar decides. */
const DEPS: ModelBindingDeps = {
  readFile: () => ({ ok: false, error: "ENOENT" }),
  pathPresence: () => ({ kind: "present" }),
};

const errorsOf = (text: string): readonly string[] => {
  const result = validateModelBindings(parsePlanModels(text), [], DEPS);
  return result.ok ? [] : result.errors;
};

/** The plan validator every populate, repair and validate run goes through. */
const checked = (text: string) =>
  checkPlanModelBindings(PLAN_FILE, [], {
    ...DEPS,
    readFile: (path) => path === PLAN_FILE ? { ok: true, content: text } : { ok: false, error: "ENOENT" },
  });

/**
 * The models as the pre-feature parser built them: every owned ownership
 * loses its `mutation` member, which must be `verify` for a plan without the
 * field. Key order is kept, so the canonical digest is comparable.
 */
function preFeatureModels(models: PlanModels): unknown {
  return {
    ...models,
    invariants: models.invariants.map((invariant) => {
      if (invariant.ownership.kind !== "owned") return invariant;
      const { mutation, ...ownership } = invariant.ownership;
      expect(mutation, `${invariant.id} mutation policy`).toEqual({ kind: "verify" });
      return { ...invariant, ownership };
    }),
  };
}

describe("mutation exemption — parse states", () => {
  it("FR-018: an owned Invariant without the field is mutation-verified", () => {
    expect(ownershipOf(plan("INV-1: Owned", OWNED_FIELDS))).toEqual({
      kind: "owned",
      owner: "src/rules/owner.ts",
      siblings: [{ path: "src/rules/sibling.ts", note: "admits members" }],
      matrixTest: "tests/rules.matrix.test.ts",
      mutation: { kind: "verify" },
    });
  });

  it("FR-018: a reasoned exemption on an owned Invariant is exempt, its reason trimmed and unquoted", () => {
    for (const [line, reason] of [
      ["**Mutation exemption:** equivalent mutants only", "equivalent mutants only"],
      ["**Mutation exemption:**   `generated lookup table`  ", "generated lookup table"],
      ["**mutation exemption:** case-insensitive label", "case-insensitive label"],
    ] as const) {
      const text = plan("INV-1: Owned", [...OWNED_FIELDS, line]);
      expect(ownershipOf(text)).toMatchObject({ kind: "owned", mutation: { kind: "exempt", reason } });
      expect(parsePlanModels(text).strays).toEqual([]);
      expect(errorsOf(text)).toEqual([]);
    }
  });

  it("AS-019: an exemption with no reason is malformed ownership, whatever the blank", () => {
    for (const blank of ["**Mutation exemption:**", "**Mutation exemption:** \t ", "**Mutation exemption:** ``", "**Mutation exemption:** ` `"]) {
      expect(ownershipOf(plan("INV-1: Owned", [...OWNED_FIELDS, blank])), blank)
        .toEqual({ kind: "malformed", problems: [{ kind: "exemption-without-reason" }] });
    }
  });

  it("AS-019: a blank exemption never captures the next line as its reason", () => {
    const text = plan("INV-1: Owned", [...OWNED_FIELDS.slice(0, -1), "**Mutation exemption:**", OWNED_FIELDS.at(-1)!]);
    expect(ownershipOf(text)).toEqual({ kind: "malformed", problems: [{ kind: "exemption-without-reason" }] });
  });

  it("AS-019: a blank exemption is named beside every other problem of the owned declaration", () => {
    const text = plan("INV-1: Owned", ["**Owner module:** src/a.ts", "**Mutation exemption:**"]);
    expect(ownershipOf(text)).toEqual({
      kind: "malformed",
      problems: [{ kind: "missing-siblings" }, { kind: "missing-matrix-test" }, { kind: "exemption-without-reason" }],
    });
  });

  it("an exemption whose reason is a placeholder is malformed ownership naming the placeholder, never exempt", () => {
    for (const reason of [...PLACEHOLDERS, "None", "N/A", "TBD.", "  todo!  ", "nothing;", "NA:", "No."]) {
      const text = plan("INV-1: Owned", [...OWNED_FIELDS, `**Mutation exemption:** ${reason}`]);
      expect(ownershipOf(text), reason).toEqual({
        kind: "malformed",
        problems: [{ kind: "exemption-placeholder-reason", reason: reason.trim() }],
      });
    }
    expect(ownershipOf(plan("INV-1: Owned", [...OWNED_FIELDS, "**Mutation exemption:** `n/a`"])))
      .toEqual({ kind: "malformed", problems: [{ kind: "exemption-placeholder-reason", reason: "n/a" }] });
  });

  it("property — a placeholder in any case, padded, with trailing punctuation, is refused and never exempt", () => {
    const variant = fc.record({
      word: fc.constantFrom(...PLACEHOLDERS),
      upper: fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
      pad: fc.constantFrom("", " ", "  ", "\t"),
      tail: fc.stringMatching(/^[.!?,;:]{0,3}$/),
    }).map(({ word, upper, pad, tail }) =>
      `${pad}${[...word].map((char, index) => upper[index] ? char.toUpperCase() : char).join("")}${tail}${pad}`);
    fc.assert(fc.property(variant, (reason) => {
      const ownership = ownershipOf(plan("INV-1: Owned", [...OWNED_FIELDS, `**Mutation exemption:** ${reason}`]));
      expect(ownership).toEqual({ kind: "malformed", problems: [{ kind: "exemption-placeholder-reason", reason: reason.trim() }] });
    }));
  });

  it("a reason that merely starts or ends with a placeholder word is a real reason", () => {
    for (const reason of ["nothing to mutate", "none of the mutants are observable", "no runtime branches", "N/A — generated code", "todo-list renderer"]) {
      expect(ownershipOf(plan("INV-1: Owned", [...OWNED_FIELDS, `**Mutation exemption:** ${reason}`])), reason)
        .toMatchObject({ kind: "owned", mutation: { kind: "exempt", reason } });
    }
  });

  it("a placeholder exemption is named beside every other problem of the owned declaration", () => {
    const text = plan("INV-1: Owned", ["**Owner module:** src/a.ts", "**Mutation exemption:** none"]);
    expect(ownershipOf(text)).toEqual({
      kind: "malformed",
      problems: [{ kind: "missing-siblings" }, { kind: "missing-matrix-test" }, { kind: "exemption-placeholder-reason", reason: "none" }],
    });
  });

  it("AS-020: an exemption on an unowned Invariant is malformed, reasoned or blank", () => {
    for (const line of ["**Mutation exemption:** nothing to mutate", "**Mutation exemption:**"]) {
      expect(ownershipOf(plan("INV-2: Unowned", [...UNOWNED_FIELDS, line])), line)
        .toEqual({ kind: "malformed", problems: [{ kind: "exemption-on-unowned" }] });
    }
  });

  it("AS-020: an exemption on an unowned Invariant is named beside its other problems", () => {
    const text = plan("INV-2: Unowned", ["**Owner module:** none", "**Matrix test:** t.ts", "**Mutation exemption:** x"]);
    expect(ownershipOf(text)).toEqual({
      kind: "malformed",
      problems: [
        { kind: "unowned-without-reason" },
        { kind: "owner-fields-on-unowned", labels: ["Matrix test"] },
        { kind: "exemption-on-unowned" },
      ],
    });
  });

  it("FR-018: the exemption label outside `## Invariants` is a misplaced-label stray", () => {
    const text = `${plan("INV-1: Owned", OWNED_FIELDS)}\n## Notes\n\n**Mutation exemption:** stray reason\n`;
    const strays = parsePlanModels(text).strays;
    expect(strays).toEqual([{ kind: "misplaced-label", label: "Mutation exemption", home: "Invariants" }]);
    expect(renderStray(strays[0]!)).toContain("'**Mutation exemption:**' line found outside a '## Invariants' section");
  });
});

describe("mutation exemption — validation refuses malformed exemptions naming the Invariant", () => {
  it("AS-019: validation fails on an exemption without a reason, naming the Invariant and the field", () => {
    const errors = errorsOf(plan("INV-7: Owned", [...OWNED_FIELDS, "**Mutation exemption:**"]));
    expect(errors).toEqual([
      expect.stringMatching(/^INV-7 \("Owned"\): '\*\*Mutation exemption:\*\*' has no reason/),
    ]);
  });

  it("validation fails on a placeholder exemption, naming the Invariant, the field and the placeholder", () => {
    const errors = errorsOf(plan("INV-9: Owned", [...OWNED_FIELDS, "**Mutation exemption:** none"]));
    expect(errors).toEqual([
      expect.stringMatching(/^INV-9 \("Owned"\): '\*\*Mutation exemption:\*\* none' is a placeholder, not a reason/),
    ]);
    const refused = checked(plan("INV-9: Owned", [...OWNED_FIELDS, "**Mutation exemption:** TBD"]));
    expect(refused).toMatchObject({ ok: false, kind: "invalid-bindings", errors: [expect.stringContaining("INV-9")] });
  });

  it("AS-020: validation fails on an exemption on an unowned Invariant, naming the Invariant and the field", () => {
    const errors = errorsOf(plan("INV-8: Unowned", [...UNOWNED_FIELDS, "**Mutation exemption:** x"]));
    expect(errors).toEqual([
      expect.stringMatching(/^INV-8 \("Unowned"\): '\*\*Mutation exemption:\*\*' on an unowned invariant/),
    ]);
  });

  it("AS-019: AS-020: populate, repair and validate refuse both through the one plan check, and admit a reasoned exemption", () => {
    const blank = checked(plan("INV-1: Owned", [...OWNED_FIELDS, "**Mutation exemption:** "]));
    expect(blank).toMatchObject({ ok: false, kind: "invalid-bindings", errors: [expect.stringContaining("INV-1")] });
    const unowned = checked(plan("INV-2: Unowned", [...UNOWNED_FIELDS, "**Mutation exemption:** x"]));
    expect(unowned).toMatchObject({ ok: false, kind: "invalid-bindings", errors: [expect.stringContaining("INV-2")] });
    const reasoned = checked(plan("INV-1: Owned", [...OWNED_FIELDS, "**Mutation exemption:** reason"]));
    expect(reasoned.kind).toBe("validated");
  });
});

describe("plans without the field validate exactly as before (FR-021)", () => {
  /**
   * The canonical digests the pre-feature parser and validator produced for
   * plans written before this feature, recorded before the exemption grammar
   * landed. They pin the frozen fixture copies under `tests/fixtures/plans/`,
   * never the live plans, so only a change to the PlanModels shape or the
   * validator re-records them.
   */
  const PRE_FEATURE = [
    {
      plan: "2026-10-16-g4-slice-2-oracle.md",
      models: "6348692764a6a80f465442bd0ee2db61663d9132e2a0960cf3cc70d1dc33c5ba",
      validation: "42ac7994d6bc7d12ff79cd48543ba4c368788c85a7770d5348e75dbbb3046780",
    },
    {
      plan: "2026-09-16-grammar-constrained-decoding.md",
      models: "21f9301181049b1936f6794c2a7a434666f43dbd619a1840568ceba6962c328b",
      validation: "381404b12b4d62a98729c1d4b68818660c39d8ed25caf8dfe05bb3b2be08c41f",
    },
  ] as const;

  it.each(PRE_FEATURE)("AS-021: frozen $plan parses and validates to its pre-feature result apart from mutation verify", ({ plan: name, models, validation }) => {
    const text = readFileSync(resolve(FROZEN_PLANS, name), "utf-8");
    expect(text).not.toMatch(/Mutation exemption/i);
    const parsed = parsePlanModels(text);
    expect(canonicalDigest(preFeatureModels(parsed))).toBe(models);
    expect(canonicalDigest(validateModelBindings(parsed, [], DEPS))).toBe(validation);
  });

  it("AS-021: the frozen oracle plan's owned Invariants all default to mutation verification", () => {
    const parsed = parsePlanModels(readFileSync(resolve(FROZEN_PLANS, "2026-10-16-g4-slice-2-oracle.md"), "utf-8"));
    const owned = parsed.invariants.filter(({ ownership }) => ownership.kind === "owned");
    expect(owned.length).toBe(7);
    for (const { ownership } of owned) expect(ownership).toMatchObject({ mutation: { kind: "verify" } });
  });

  it("AS-021: every plan on disk without the field has only verify policies and no exemption problem", () => {
    for (const name of readdirSync(PLANS).filter((file) => file.endsWith(".md"))) {
      const text = readFileSync(resolve(PLANS, name), "utf-8");
      if (/\*\*Mutation exemption:\*\*/i.test(text)) continue;
      const parsed = parsePlanModels(text);
      expect(parsed.strays.filter((stray) => stray.kind === "misplaced-label" && stray.label === "Mutation exemption"), name).toEqual([]);
      for (const { id, ownership } of parsed.invariants) {
        if (ownership.kind === "owned") expect(ownership.mutation, `${name} ${id}`).toEqual({ kind: "verify" });
        if (ownership.kind === "malformed") {
          expect(ownership.problems.filter(({ kind }) => kind.startsWith("exemption-")), `${name} ${id}`).toEqual([]);
        }
      }
    }
  });

  it("FR-021: property — adding a reasoned exemption to an owned block changes only its mutation policy", () => {
    const reason = fc.string({ minLength: 1, maxLength: 40 })
      .map((raw) => raw.replace(/[\r\n`*]/g, "x").trim())
      .filter((raw) => raw.length > 0 && !isPlaceholder(raw));
    const path = fc.stringMatching(/^[a-z]{1,8}\/[a-z]{1,8}\.ts$/);
    fc.assert(fc.property(path, fc.array(path, { maxLength: 3 }), path, reason, (owner, siblings, matrixTest, why) => {
      const fields = [
        "**Tier:** advisory",
        `**Owner module:** ${owner}`,
        siblings.length === 0 ? "**Sibling entry points:** none" : "**Sibling entry points:**",
        ...siblings.map((sibling) => `- ${sibling}`),
        `**Matrix test:** ${matrixTest}`,
      ];
      const plain = parsePlanModels(plan("INV-1: P", fields));
      const exempt = parsePlanModels(plan("INV-1: P", [...fields, `**Mutation exemption:** ${why}`]));
      const plainOwnership = plain.invariants[0]!.ownership;
      expect(plainOwnership.kind).toBe("owned");
      if (plainOwnership.kind !== "owned") return;
      expect(plainOwnership.mutation).toEqual({ kind: "verify" });
      expect(exempt).toEqual({
        ...plain,
        invariants: [{ ...plain.invariants[0]!, ownership: { ...plainOwnership, mutation: { kind: "exempt", reason: why } } }],
      });
    }));
  });

  it("FR-021: property — any exemption line on an unowned block makes it malformed, never unowned", () => {
    const line = fc.string({ maxLength: 30 }).map((raw) => `**Mutation exemption:** ${raw.replace(/[\r\n]/g, " ")}`);
    fc.assert(fc.property(line, (exemption) => {
      const ownership = ownershipOf(plan("INV-2: U", [...UNOWNED_FIELDS, exemption]));
      expect(ownership).toEqual({ kind: "malformed", problems: [{ kind: "exemption-on-unowned" }] });
    }));
  });
});
