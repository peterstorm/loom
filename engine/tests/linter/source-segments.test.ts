/**
 * The source segmenter at its own seam. What each reader makes of the segments
 * is pinned where it is read: `codeOfLine` in the purity rule's tests,
 * `tokenStream` in the clone detector's.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { lexicalSpans, sourceSegments } from "../../src/linter/source-segments";

type Spans = readonly Readonly<{ kind: string; start: number; end: number }>[];

const textOf = (content: string, spans: Spans): readonly (readonly [string, string])[] =>
  spans.map(({ kind, start, end }) => [kind, content.slice(start, end)] as const);

const kindsOf = (content: string): readonly (readonly [string, string])[] => textOf(content, sourceSegments(content));
const spansOf = (content: string): readonly (readonly [string, string])[] => textOf(content, lexicalSpans(content));

/** Every character is in exactly one span, in order, and no span is empty. */
const tiles = (content: string, spans: Spans): boolean =>
  spans.map(({ start, end }) => content.slice(start, end)).join("") === content
  && spans.every(({ start, end }, index) => end > start && start === (spans[index - 1]?.end ?? 0));

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
      expect(tiles(content, sourceSegments(content))).toBe(true);
    }));
  });
});

describe("lexicalSpans", () => {
  it("tells template text and a regex literal apart from the code around them", () => {
    expect(spansOf("u = `http://${host}/x`; r = /[)(]\\//g;")).toEqual([
      ["code", "u = "],
      ["template", "`http://$"],
      ["code", "{host}"],
      ["template", "/x`"],
      ["code", "; r = "],
      ["regex", "/[)(]\\//"],
      ["code", "g;"],
    ]);
  });

  it("keeps an interpolation's own strings, comments and nested templates apart", () => {
    expect(spansOf("`a${f(\"s\", `b${c}`) /* n */}z`")).toEqual([
      ["template", "`a$"],
      ["code", "{f("],
      ["string", "\"s\""],
      ["code", ", "],
      ["template", "`b$"],
      ["code", "{c}"],
      ["template", "`"],
      ["code", ") "],
      ["comment", "/* n */"],
      ["code", "}"],
      ["template", "z`"],
    ]);
  });

  it("leaves the brackets of its code spans balanced around every interpolation", () => {
    const code = lexicalSpans("x = `(${a[0]}{`; y = `}${b}`;")
      .filter(({ kind }) => kind === "code")
      .map(({ start, end }) => "x = `(${a[0]}{`; y = `}${b}`;".slice(start, end))
      .join("");
    expect(code).toBe("x = {a[0]}; y = {b};");
  });

  it("covers every character exactly once, in order, with no empty span", () => {
    fc.assert(fc.property(sourceText, (content) => {
      expect(tiles(content, lexicalSpans(content))).toBe(true);
    }));
  });

  it("is the segments once template text and regex literals are read as code", () => {
    fc.assert(fc.property(sourceText, (content) => {
      const coarse = lexicalSpans(content)
        .map(({ kind, start, end }) => ({ kind: kind === "string" || kind === "comment" ? kind : "code", start, end }))
        .reduce<{ kind: string; start: number; end: number }[]>((merged, span) => {
          const last = merged.at(-1);
          return last !== undefined && last.kind === "code" && span.kind === "code"
            ? [...merged.slice(0, -1), { ...last, end: span.end }]
            : [...merged, span];
        }, []);
      expect(sourceSegments(content)).toEqual(coarse);
    }));
  });
});
