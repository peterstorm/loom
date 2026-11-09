/**
 * shellWords (core/shell-command-head): bash's pre-expansion word split, built
 * on the one quote scan. Quoted regions and `${…}` spans stay inside one word.
 * commandWords: the head-resolution split on the same scan, pinned against the
 * tokenizer it replaced.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { commandWords, shellWords } from "../../src/core/shell-command-head";

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

/**
 * The hand-rolled tokenizer commandWords replaced, kept verbatim as the
 * differential oracle: commandWords moved onto the shared quote scan, and its
 * behaviour (backticks as quotes, escape pairs kept inside a word, unquoted
 * `( ) { }` standalone) must not move with it.
 */
function referenceCommandWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (quote !== "'" && c === "\\") { current += c + (text[i + 1] ?? ""); i++; continue; }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === "\\") { current += c + (text[i + 1] ?? ""); i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; current += c; continue; }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      if (current !== "") { words.push(current); current = ""; }
      words.push(c);
      continue;
    }
    if (/\s/.test(c)) {
      if (current !== "") { words.push(current); current = ""; }
      continue;
    }
    current += c;
  }
  if (current !== "") words.push(current);
  return words;
}

describe("commandWords", () => {
  it.each([
    ["compound syntax splits even when fused", "(bash -c x){ sh;}", ["(", "bash", "-c", "x", ")", "{", "sh;", "}"]],
    ["quoted brackets stay in the word", `echo "(a)" '{b}'`, ["echo", `"(a)"`, `'{b}'`]],
    ["a backtick region is one word", "echo `a (b)` c", ["echo", "`a (b)`", "c"]],
    ["an escaped bracket stays in the word", "echo \\(a\\)", ["echo", "\\(a\\)"]],
    ["a trailing backslash is kept", "echo a\\", ["echo", "a\\"]],
    ["an unterminated quote runs to the end", `echo "a (b c`, ["echo", `"a (b c`]],
    ["a parameter span is NOT special", "echo ${A}", ["echo", "$", "{", "A", "}"]],
  ])("%s", (_name, text, words) => {
    expect(commandWords(text)).toEqual(words);
  });

  it("agrees with the hand-rolled reference tokenizer on arbitrary shell-ish text", () => {
    const alphabet = ["a", "b", " ", "\t", "\n", "(", ")", "{", "}", "\\", '"', "'", "`", "$", ";", "<", ">", "&", "|"];
    const shellish = fc.array(fc.constantFrom(...alphabet), { maxLength: 40 }).map((chars) => chars.join(""));
    fc.assert(fc.property(shellish, (text) => {
      expect(commandWords(text)).toEqual(referenceCommandWords(text));
    }), { numRuns: 5000 });
  });

  it("agrees with the reference on arbitrary unicode text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (text) => {
      expect(commandWords(text)).toEqual(referenceCommandWords(text));
    }), { numRuns: 2000 });
  });
});
