import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec, specContentHash, specParseErrorMessage } from "../../src/core/parse-spec";

const canonicalText = (value: string): string => value.trim().replace(/\s+/gu, " ");

describe("parseSpec properties", () => {
  it("is total and deterministic for arbitrary markdown", () => {
    fc.assert(fc.property(fc.string(), (markdown) => {
      expect(() => parseSpec(markdown)).not.toThrow();
      expect(parseSpec(markdown)).toEqual(parseSpec(markdown));
    }));
  });

  it("ok:true results always carry unique IDs and 64-hex content hashes", () => {
    fc.assert(fc.property(fc.string(), (markdown) => {
      const parsed = parseSpec(markdown);
      if (!parsed.ok) return;
      for (const collection of [parsed.value.frs, parsed.value.scenarios, parsed.value.oos]) {
        const ids = collection.map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of collection) expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      }
      const terms = parsed.value.glossary.map(({ term }) => term.toLocaleLowerCase("en-US"));
      expect(new Set(terms).size).toBe(terms.length);
      for (const entry of parsed.value.glossary) expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    }));
  });

  it("mints every entry with a hash derived from its own content", () => {
    // The runtime witness of the construction invariant the phantom
    // `HashedByConstruction` brand enforces at the type level: a minted entry's
    // hash and content can never disagree, for any input.
    fc.assert(fc.property(fc.string(), (markdown) => {
      const parsed = parseSpec(markdown);
      if (!parsed.ok) return;
      for (const entry of [...parsed.value.frs, ...parsed.value.scenarios, ...parsed.value.oos]) {
        expect(entry.contentHash).toBe(specContentHash(entry.content));
      }
      for (const entry of parsed.value.glossary) {
        expect(entry.contentHash).toBe(specContentHash(`${entry.term}: ${entry.definition}`));
      }
    }));
  });

  it("projects each collection under its own identifier family", () => {
    // The runtime witness of the family branding: `frs`, `scenarios`, and `oos`
    // are mutually non-assignable types, and their contents match.
    fc.assert(fc.property(fc.string(), (markdown) => {
      const parsed = parseSpec(markdown);
      if (!parsed.ok) return;
      for (const { id } of parsed.value.frs) expect(id).toMatch(/^FR-\d{3}$/u);
      for (const { id } of parsed.value.scenarios) expect(id).toMatch(/^AS-\d{3}$/u);
      for (const { id } of parsed.value.oos) expect(id).toMatch(/^OOS-\d{3}$/u);
    }));
  });

  it("renders every emitted error as non-empty operator text", () => {
    // `specParseErrorMessage` is total over the union by construction; this
    // proves the parser never emits an error that renders to nothing, for any
    // input at all.
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
