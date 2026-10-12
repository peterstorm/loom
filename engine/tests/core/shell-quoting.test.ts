import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { openQuoteAfter, quoteShellArgument } from "../../src/core/shell-quoting";

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
