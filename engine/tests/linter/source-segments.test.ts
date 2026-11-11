/**
 * The source segmenter at its own seam. What each reader makes of the segments
 * is pinned where it is read: `codeOfLine` in the purity rule's tests,
 * `tokenStream` in the clone detector's.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sourceSegments } from "../../src/linter/source-segments";

const kindsOf = (content: string): readonly (readonly [string, string])[] =>
  sourceSegments(content).map(({ kind, start, end }) => [kind, content.slice(start, end)] as const);

/** Text built from the characters the scanner branches on, so every path is reached. */
const sourceText = fc.array(
  fc.constantFrom("a", "1", " ", "\n", "/", "*", "\"", "'", "`", "$", "{", "}", "\\", "[", "]", "(", ")", "//", "/*", "*/", "${", "return "),
  { maxLength: 60 },
).map((parts) => parts.join(""));

describe("sourceSegments", () => {
  it("names code, each string quote and both comment forms", () => {
    expect(kindsOf(`a = "s" + 't'; // tail\n/* block */ b`)).toEqual([
      ["code", "a = "],
      ["string", `"s"`],
      ["code", " + "],
      ["string", "'t'"],
      ["code", "; "],
      ["comment", "// tail"],
      ["code", "\n"],
      ["comment", "/* block */"],
      ["code", " b"],
    ]);
  });

  it("keeps a template and a regex literal as code, whatever they hold", () => {
    expect(kindsOf("u = `http://${host}`;")).toEqual([["code", "u = `http://${host}`;"]]);
    expect(kindsOf("r = /\\/\\//g; x")).toEqual([["code", "r = /\\/\\//g; x"]]);
  });

  it("reads an unclosed quote as code: when in doubt the text is checked", () => {
    expect(kindsOf(`x = "open + y`)).toEqual([["code", `x = "open + y`]]);
  });

  it("covers every character exactly once, in order, with no empty span", () => {
    fc.assert(fc.property(sourceText, (content) => {
      const segments = sourceSegments(content);
      expect(segments.map(({ start, end }) => content.slice(start, end)).join("")).toBe(content);
      expect(segments.every(({ start, end }, index) => end > start && start === (segments[index - 1]?.end ?? 0))).toBe(true);
    }));
  });
});
