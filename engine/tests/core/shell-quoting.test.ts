import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CONTINUE,
  halt,
  lexShellQuotes,
  openQuoteAfter,
  quoteShellArgument,
  scanUnquoted,
  skip,
  type ShellQuoteToken,
} from "../../src/core/shell-quoting";
import { shellText } from "../fixtures/shell-text-arbitrary";

/** Every token the lexer hands its visitor for `text`, in order. */
const tokensOf = (text: string): readonly ShellQuoteToken[] => {
  const tokens: ShellQuoteToken[] = [];
  lexShellQuotes<never>(text, 0, (token) => {
    tokens.push(token);
    return CONTINUE;
  });
  return tokens;
};

/** The source text one token was read from. */
const sourceOf = (token: ShellQuoteToken): string =>
  token.kind === "text" ? token.char : token.kind === "escape" ? `\\${token.escaped}` : token.quote;

/** sh's own reading of one single-quoted word: `'` toggles, everything else is literal. */
const unquoteSingle = (word: string): string => {
  let out = "";
  let quoted = false;
  for (let i = 0; i < word.length; i++) {
    const char = word[i]!;
    if (char === "'") quoted = !quoted;
    else if (!quoted && char === "\\") out += word[++i] ?? "";
    else out += char;
  }
  return out;
};

describe("quoteShellArgument", () => {
  it.each([
    ["plain", "'plain'"],
    ["", "''"],
    ["cost $(x) `y` \\z", "'cost $(x) `y` \\z'"],
    ["it's", "'it'\\''s'"],
    ["/runs/with space", "'/runs/with space'"],
  ])("quotes %j as one literal word", (value, quoted) => {
    expect(quoteShellArgument(value)).toBe(quoted);
  });

  it("always yields one balanced word that reads back as the exact value", () => {
    fc.assert(fc.property(fc.string(), (value) => {
      const quoted = quoteShellArgument(value);
      expect(openQuoteAfter(quoted, 0)).toBeNull();
      expect(unquoteSingle(quoted)).toBe(value);
    }));
  });
});

describe("lexShellQuotes — the one quote lexer", () => {
  it("reads every character exactly once: the tokens' sources rebuild the text", () => {
    fc.assert(fc.property(shellText, (text) => {
      const tokens = tokensOf(text);
      expect(tokens.map(sourceOf).join("")).toBe(text);
      tokens.forEach((token, k) => {
        if (k > 0) expect(token.index).toBe(tokens[k - 1]!.index + sourceOf(tokens[k - 1]!).length);
      });
    }), { numRuns: 2000 });
  });

  it("nests no region: every close ends the region the last open began, and a backslash never escapes inside single quotes", () => {
    fc.assert(fc.property(shellText, (text) => {
      let open: string | null = null;
      for (const token of tokensOf(text)) {
        if (token.kind === "open") {
          expect(open).toBeNull();
          open = token.quote;
        } else if (token.kind === "close") {
          expect(token.quote).toBe(open);
          open = null;
        } else {
          expect(token.quote).toBe(open);
          if (token.kind === "escape") expect(token.quote).not.toBe("'");
        }
      }
      expect(openQuoteAfter(text, 0)).toBe(open);
    }), { numRuns: 2000 });
  });

  it("scanUnquoted visits exactly the unquoted text characters", () => {
    fc.assert(fc.property(shellText, (text) => {
      const visited: number[] = [];
      scanUnquoted<never>(text, 0, (char, index) => {
        expect(text[index]).toBe(char);
        visited.push(index);
        return CONTINUE;
      });
      const unquoted = tokensOf(text).filter((token) => token.kind === "text" && token.quote === null);
      expect(visited).toEqual(unquoted.map((token) => token.index));
    }), { numRuns: 2000 });
  });

  it("stops at the first halt and resumes a skip in the current quote state", () => {
    expect(lexShellQuotes(`a"b`, 0, (token) => (token.kind === "text" && token.char === "b" ? halt(token.index) : CONTINUE)))
      .toEqual({ halted: 2, openQuote: '"' });
    // A skip over a quote character never lexes it: the walk stays unquoted and sees `y`.
    expect(scanUnquoted("x'y'", 0, (char, index) => (char === "x" ? skip(index + 2) : halt(char)))).toBe("y");
  });
});
