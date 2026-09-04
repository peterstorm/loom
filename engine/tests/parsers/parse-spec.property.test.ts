import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec, specContentHash } from "../../src/parsers/parse-spec";

const canonicalText = (value: string): string => value.trim().replace(/\s+/gu, " ");

describe("parseSpec properties", () => {
  it("is total and deterministic for arbitrary markdown", () => {
    fc.assert(fc.property(fc.string(), (markdown) => {
      expect(() => parseSpec(markdown)).not.toThrow();
      expect(parseSpec(markdown)).toEqual(parseSpec(markdown));
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
