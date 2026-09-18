import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec, specContentHash, specParseErrorMessage } from "../../src/core/parse-spec";

const canonicalText = (value: string): string => value.trim().replace(/\s+/gu, " ");

const proseArbitrary = fc.tuple(
  fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
  fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.!?_-".split("")),
    maxLength: 40,
  }),
).map(([head, tail]) => `${head}${tail}`);

/** Canonical specifications by construction, with non-empty variable rosters. */
const validSpecArbitrary = fc.record({
  frs: fc.array(proseArbitrary, { minLength: 1, maxLength: 4 }),
  scenarios: fc.array(proseArbitrary, { minLength: 1, maxLength: 4 }),
  oos: fc.array(proseArbitrary, { minLength: 1, maxLength: 3 }),
  glossary: fc.array(proseArbitrary, { minLength: 1, maxLength: 4 }),
  separator: fc.constantFrom(" ", "  ", "\t"),
}).map(({ frs, scenarios, oos, glossary, separator }) => [
  "# Feature: Generated",
  "",
  "## User Scenarios",
  "",
  "### US1: [P1] Generated scenario",
  "",
  "**Acceptance Scenarios:**",
  ...scenarios.map((content, index) => `- AS-${String(index + 1).padStart(3, "0")}:${separator}${content}`),
  "",
  "## Functional Requirements",
  "",
  ...frs.map((content, index) => `- FR-${String(index + 1).padStart(3, "0")}:${separator}${content}`),
  "",
  "## Out of Scope",
  "",
  ...oos.map((content, index) => `- OOS-${String(index + 1).padStart(3, "0")}:${separator}${content}`),
  "",
  "## Appendix: Glossary",
  "",
  "| Term | Definition |",
  "|------|------------|",
  ...glossary.map((definition, index) => `| Concept ${index + 1} | ${definition} |`),
].join("\n"));

const parseValidSpec = (markdown: string) => {
  const parsed = parseSpec(markdown);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("validSpecArbitrary produced an invalid specification");
  return parsed.value;
};

const distinctContinuationPair = fc.tuple(proseArbitrary, proseArbitrary)
  .filter(([left, right]) => canonicalText(left) !== canonicalText(right));

/** Assert the shared Requirement continuation invariant while each named case
 * supplies only its meaningful Markdown form. */
function assertRequirementContinuation(
  continuationMarkdown: (continuation: string) => string,
  expectedContent: (continuation: string) => string = canonicalText,
): void {
  fc.assert(fc.property(
    validSpecArbitrary,
    distinctContinuationPair,
    (markdown, [left, right]) => {
      const continueFirstRequirement = (continuation: string): string => markdown.replace(
        /(- FR-001:[^\n]*)/u,
        `$1${continuationMarkdown(continuation)}`,
      );
      const first = parseValidSpec(continueFirstRequirement(left)).frs[0];
      const second = parseValidSpec(continueFirstRequirement(right)).frs[0];
      expect(first.content).toContain(expectedContent(left));
      expect(second.content).toContain(expectedContent(right));
      expect(first.contentHash).toBe(specContentHash(first.content));
      expect(second.contentHash).toBe(specContentHash(second.content));
      expect(first.contentHash).not.toBe(second.contentHash);
    },
  ));
}

describe("parseSpec properties", () => {
  it("is total and deterministic for arbitrary markdown", () => {
    fc.assert(fc.property(fc.string(), (markdown) => {
      expect(() => parseSpec(markdown)).not.toThrow();
      expect(parseSpec(markdown)).toEqual(parseSpec(markdown));
    }));
  });

  it("ok:true results always carry unique IDs and 64-hex content hashes", () => {
    fc.assert(fc.property(validSpecArbitrary, (markdown) => {
      const value = parseValidSpec(markdown);
      for (const collection of [value.frs, value.scenarios, value.oos]) {
        const ids = collection.map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of collection) expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      }
      const terms = value.glossary.map(({ term }) => term.toLocaleLowerCase("en-US"));
      expect(new Set(terms).size).toBe(terms.length);
      for (const entry of value.glossary) expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    }));
  });

  it("mints every entry with a hash derived from its own content", () => {
    // Runtime construction proof: the phantom brand records parser provenance
    // but is not itself forgery-proof under structural spreading.
    fc.assert(fc.property(validSpecArbitrary, (markdown) => {
      const value = parseValidSpec(markdown);
      for (const entry of [...value.frs, ...value.scenarios, ...value.oos]) {
        expect(entry.contentHash).toBe(specContentHash(entry.content));
      }
      for (const entry of value.glossary) {
        // The glossary hash input is the lossless (term, definition) pair —
        // the mint's derivation, not the ambiguous term-colon join.
        expect(entry.contentHash).toBe(specContentHash(JSON.stringify([entry.term, entry.definition])));
      }
    }));
  });

  it("makes every wrapped continuation part of the entry content and hash", () => {
    assertRequirementContinuation((continuation) => `\n  ${continuation}`);
  });

  it("hashes blank-separated indented Requirement paragraphs as item content", () => {
    assertRequirementContinuation((continuation) => `\n\n    ${continuation}`);
  });

  it("hashes blank-separated nested Requirement clauses as item content", () => {
    assertRequirementContinuation(
      (continuation) => `\n\n    - ${continuation}`,
      (continuation) => `- ${canonicalText(continuation)}`,
    );
  });

  it.each([
    { family: "FR", collection: "frs" },
    { family: "AS", collection: "scenarios" },
    { family: "OOS", collection: "oos" },
  ] as const)("preserves the complete generated $family body without changing its canonical roster", ({ family, collection }) => {
    fc.assert(fc.property(
      validSpecArbitrary,
      proseArbitrary,
      fc.record({
        indent: fc.constantFrom("  ", "    ", "\t", " \t"),
        gap: fc.constantFrom("\n", "\n\n"),
        prefix: fc.constantFrom("", "- ", "+ ", "1. ", "### "),
        fence: fc.constantFrom("```", "~~~"),
      }),
      (markdown, prose, { indent, gap, prefix, fence }) => {
        const baseline = parseValidSpec(markdown);
        const body = [
          `${prefix}detail ${prose}`,
          fence,
          "literal example",
          fence,
          "---",
          "**Acceptance Scenarios:**",
          `${family}-009 without a colon is prose`,
          "tail clause",
        ];
        const appendBody = (lines: readonly string[]): string => markdown.replace(
          new RegExp(`(- ${family}-001:[^\\n]*)`, "u"),
          (_match, firstLine: string) => `${firstLine}${gap}${lines.map((line) => `${indent}${line}`).join(gap)}`,
        );
        const value = parseValidSpec(appendBody(body));
        const expected = canonicalText(`${baseline[collection][0].content} ${body.join(" ")}`);
        expect(value[collection][0]).toEqual({
          id: `${family}-001`, content: expected, contentHash: specContentHash(expected),
        });
        for (const key of ["frs", "scenarios", "oos"] as const) {
          expect(value[key].map(({ id }) => id)).toEqual(baseline[key].map(({ id }) => id));
        }
        expect(value[collection].slice(1)).toEqual(baseline[collection].slice(1));
        const changed = parseValidSpec(appendBody([...body, "mandatory new clause"]));
        expect(changed[collection][0].contentHash).not.toBe(value[collection][0].contentHash);
      },
    ), { numRuns: 200, seed: 43001 });
  });

  it.each(["FR", "AS", "OOS"] as const)("rejects nested colon-full IDs in generated %s documents", (family) => {
    fc.assert(fc.property(
      validSpecArbitrary,
      fc.record({
        indent: fc.constantFrom("  ", "    ", "\t", " \t"),
        gap: fc.constantFrom("\n", "\n\n"),
        prefix: fc.constantFrom("", "- ", "1. ", "> > ", "### "),
        nestedFamily: fc.constantFrom("FR", "AS", "OOS"),
        id: fc.integer({ min: 5, max: 999 }),
      }),
      (markdown, { indent, gap, prefix, nestedFamily, id }) => {
        // Success is mandatory before the single invalid grammar mutation;
        // arbitrary garbage or unrelated parser failures cannot satisfy this law.
        parseValidSpec(markdown);
        const nested = `${indent}${prefix}${nestedFamily}-${String(id).padStart(3, "0")}: nested entry`;
        const mutated = markdown.replace(new RegExp(`(- ${family}-001:[^\\n]*)`, "u"), `$1${gap}${nested}`);
        const parsed = parseSpec(mutated);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) throw new Error("nested structural ID unexpectedly indexed");
        const line = mutated.split("\n").indexOf(nested) + 1;
        expect(parsed.errors).toContainEqual(expect.objectContaining({ line }));
      },
    ), { numRuns: 200, seed: 43002 });
  });

  it("projects each collection under its own identifier family", () => {
    // The runtime witness of the family branding: `frs`, `scenarios`, and `oos`
    // are mutually non-assignable types, and their contents match.
    fc.assert(fc.property(validSpecArbitrary, (markdown) => {
      const value = parseValidSpec(markdown);
      for (const { id } of value.frs) expect(id).toMatch(/^FR-\d{3}$/u);
      for (const { id } of value.scenarios) expect(id).toMatch(/^AS-\d{3}$/u);
      for (const { id } of value.oos) expect(id).toMatch(/^OOS-\d{3}$/u);
    }));
  });

  it("renders every emitted error as non-empty operator text", () => {
    // `specParseErrorMessage` is total over the union by construction; this
    // samples arbitrary parser inputs and proves every observed failure renders
    // to text, while the typed renderer supplies compile-time exhaustiveness.
    fc.assert(fc.property(fc.string(), (markdown) => {
      const parsed = parseSpec(markdown);
      if (parsed.ok) return;
      for (const error of parsed.errors) {
        expect(specParseErrorMessage(error).trim().length).toBeGreaterThan(0);
      }
    }));
  });

  it("hashes canonical content independently of surrounding and repeated whitespace", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter((value) => canonicalText(value) !== ""),
      fc.array(fc.constantFrom(" ", "\t", "\n"), { minLength: 1, maxLength: 5 }),
      (content, whitespace) => {
        const canonical = canonicalText(content);
        const separator = whitespace.join("");
        const expanded = ` ${canonical.split(" ").join(separator)} `;
        expect(specContentHash(expanded)).toBe(specContentHash(canonical));
      },
    ));
  });
});
