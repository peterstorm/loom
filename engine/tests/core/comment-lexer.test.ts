/**
 * The comment lexer behind a comment-only Change Class (ADR-0094): it removes
 * comments and nothing a reader could execute, refuses what it cannot read,
 * and agrees with the TypeScript parser on every token it keeps.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import ts from "typescript";
import { commentStrippedSource } from "../../src/core/comment-lexer";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe("commentStrippedSource removes comments and nothing a reader could execute", () => {
  it("keeps comment markers inside strings, templates and regular expressions", () => {
    const source = "const a = '// no'; const b = \"/* no */\"; const c = `// ${d} /* no */`; const e = /\\/\\//g;\n";
    expect(commentStrippedSource(source)).toBe(source.trimEnd());
  });

  it("keeps a line break where a block comment held one, so automatic semicolon insertion reads the same", () => {
    expect(commentStrippedSource("return /*\n*/ x")).toBe("return\nx");
    expect(commentStrippedSource("return /* */ x")).toBe("return x");
  });

  it("refuses a division followed by a comment on its line, and unterminated literals", () => {
    expect(commentStrippedSource("a = b / c; // half")).toBeNull();
    expect(commentStrippedSource("a = 'open")).toBeNull();
    expect(commentStrippedSource("a = /* open")).toBeNull();
    expect(commentStrippedSource("a = `open")).toBeNull();
  });

  it("refuses a source holding a lone carriage return, U+2028 or U+2029, which end a JavaScript line comment", () => {
    // In JavaScript `// c\rx = 1` is a comment and then code; a lexer ending
    // the comment only at \n would swallow `x = 1` as comment text.
    expect(commentStrippedSource("// c\rx = 1;\n")).toBeNull();
    expect(commentStrippedSource(`// c${LINE_SEPARATOR}x = 1;\n`)).toBeNull();
    expect(commentStrippedSource(`// c${PARAGRAPH_SEPARATOR}x = 1;\n`)).toBeNull();
    expect(commentStrippedSource(`const s = "${LINE_SEPARATOR}";\n`)).toBeNull();
  });

  it("keeps the blanks after a division as written, since that `/` may open a regular expression", () => {
    // After `)` a `/` is a division in `(a) / b` but a regular expression in
    // `if (x) /a  b/.test(s)`: collapsing its blanks would make two different
    // patterns strip alike. The CI counterexample `)/  a` is the same shape.
    const wide = commentStrippedSource("if (x) /a  b/.test(s);\n");
    const narrow = commentStrippedSource("if (x) /a b/.test(s);\n");
    expect(wide).not.toBeNull();
    expect(wide).not.toBe(narrow);
    expect(commentStrippedSource(")/  a")).toBe(")/  a");
    expect(commentStrippedSource("x = (a)  /  b;\n  y = 1;\n")).toBe("x = (a) /  b;\ny = 1;");
  });

  it("reads a `/` after `++` or `--` as a division, and refuses a pattern whose slash may open a comment", () => {
    // The soak counterexample: after `a++` the `/` divides, so `/ /*` holds a
    // block comment that a regular-expression reading would swallow.
    expect(commentStrippedSource("a++/ /*\n*//* block */a")).toBeNull();
    expect(commentStrippedSource("a++ / b;\n")).toBe("a++ / b;");
    expect(commentStrippedSource("x = / /* y */;\n")).toBeNull();
    expect(commentStrippedSource("x = /[/*]/;\n")).toBeNull();
    expect(commentStrippedSource("x = a + +/re/;\n")).toBe("x = a + +/re/;");
  });

  it("refuses a template literal on a line where a `/` was read as a division", () => {
    // `if (x) /`/` is a pattern holding a backtick: read as a division, the
    // backtick would open a template whose end the lexer would misplace.
    expect(commentStrippedSource("if (x) /`/.test(s);\ny = `a\n/* b */ c`;\n// `\n")).toBeNull();
  });

  it("reads a CRLF source as it reads the LF one", () => {
    expect(commentStrippedSource("// c\r\nx = 1;\r\n")).toBe(commentStrippedSource("// c\nx = 1;\n"));
    expect(commentStrippedSource("// c\r\nx = 1;\r\n")).toBe("x = 1;");
  });
});

const fragment = fc.constantFrom(
  "a", "b1", "return", " ", "  ", "\t", "\n", "\n\n", "(", ")", "{", "}", "[", "]", ";", ",", "=", "+", "++", "-", "--",
  "*", "/ ", "'s'", "\"d\"", "`t`", "`a${b}c`", "/re/g", "/[/]/", "// line\n", "/* block */", "/*\n*/", "x.y",
  "'//'", "\"/*\"", "`/* t */`", "\\", "'", "\"", "`", "${", "/*", "*/", "//", "\r\n", "\r",
);
const sourceArbitrary = fc.array(fragment, { maxLength: 40 }).map((parts) => parts.join(""));

describe("commentStrippedSource is idempotent", () => {
  it("on sources built from code fragments", () => {
    fc.assert(fc.property(sourceArbitrary, (source) => {
      const once = commentStrippedSource(source);
      if (once === null) return;
      expect(commentStrippedSource(once)).toBe(once);
    }), { numRuns: 2000 });
  });

  it("on arbitrary text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (source) => {
      const once = commentStrippedSource(source);
      if (once === null) return;
      expect(commentStrippedSource(once)).toBe(once);
    }), { numRuns: 2000 });
  });
});

/**
 * The reference scanner: the non-trivia tokens the TypeScript parser reads
 * from `source`, as kind and text. JSDoc nodes are comments, not tokens.
 */
function tokensOf(source: string): readonly (readonly [ts.SyntaxKind, string])[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tokens: (readonly [ts.SyntaxKind, string])[] = [];
  const isJsDoc = (node: ts.Node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
  const walk = (node: ts.Node): void => {
    const children = node.getChildren(file).filter((child) => !isJsDoc(child));
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push([node.kind, node.getText(file)] as const);
      return;
    }
    children.forEach(walk);
  };
  walk(file);
  return tokens;
}

describe("commentStrippedSource is sound against the TypeScript parser", () => {
  // Stripping keeps exactly the token stream: so two sources with equal
  // stripped forms have equal token streams, and a comment-only verdict never
  // hides a change the parser would read.
  it("a source and its stripped form have the same non-trivia tokens", () => {
    fc.assert(fc.property(sourceArbitrary, (source) => {
      const stripped = commentStrippedSource(source);
      if (stripped === null) return;
      expect(tokensOf(stripped)).toEqual(tokensOf(source));
    }), { numRuns: 1500 });
  });

  it("two sources with equal stripped forms have the same non-trivia tokens", () => {
    const trivia = fc.constantFrom(" ", "\n", "/* c */", "// c\n", "/*\n*/", "\t");
    const token = fc.constantFrom("a", "return", "(", ")", "{", "}", ";", "=", "+", "'s'", "`t`", "/re/g", "x.y", "1");
    fc.assert(fc.property(fc.array(token, { minLength: 1, maxLength: 12 }), fc.array(trivia, { maxLength: 12 }),
      fc.array(trivia, { maxLength: 12 }), (tokens, left, right) => {
        const render = (separators: readonly string[]) => tokens.map((text, index) => `${text}${separators[index] ?? " "}`).join("");
        const [one, two] = [render(left), render(right)];
        const [strippedOne, strippedTwo] = [commentStrippedSource(one), commentStrippedSource(two)];
        if (strippedOne === null || strippedOne !== strippedTwo) return;
        expect(tokensOf(one)).toEqual(tokensOf(two));
      }), { numRuns: 1500 });
  });
});
