/**
 * shellWords (core/shell-command-head): bash's pre-expansion word split, built
 * on the one quote scan. Quoted regions and `${…}` spans stay inside one word.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { shellWords } from "../../src/core/shell-command-head";

describe("shellWords", () => {
  it.each([
    ["plain words", "rm -rf /a/b", ["rm", "-rf", "/a/b"]],
    ["runs of whitespace", "  a \t b\n c  ", ["a", "b", "c"]],
    ["a word that starts quoted", `"a b" c`, [`"a b"`, "c"]],
    ["a word that ends quoted", `x'a b'`, [`x'a b'`]],
    ["a single-quoted word with a double quote", `'a "b' c`, [`'a "b'`, "c"]],
    ["an escaped space", "a\\ b c", ["a\\ b", "c"]],
    ["a parameter span", "rm ${RUN}/ledger.json", ["rm", "${RUN}/ledger.json"]],
    ["a parameter span with a space in its word", "rm ${X:-a b}/f", ["rm", "${X:-a b}/f"]],
    ["nested parameter spans", "echo ${A:-${B:-x y}} z", ["echo", "${A:-${B:-x y}}", "z"]],
    ["braces that are not a parameter", "echo {a,b} }", ["echo", "{a,b}", "}"]],
    ["redirects stay attached", "cat a>b 2>&1", ["cat", "a>b", "2>&1"]],
    ["empty", "", []],
  ])("%s", (_name, text, words) => {
    expect(shellWords(text)).toEqual(words);
  });

  it("splits quote-free text exactly like a whitespace split", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z/ .\-]{0,40}$/), (text) => {
      expect(shellWords(text)).toEqual(text.split(/\s+/).filter((word) => word !== ""));
    }));
  });

  it("never loses or invents a non-whitespace character", () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (text) => {
      const kept = shellWords(text).join("").replace(/\s/g, "");
      expect(kept).toBe(text.replace(/\s/g, ""));
    }));
  });
});
