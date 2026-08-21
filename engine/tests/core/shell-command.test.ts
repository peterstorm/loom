import { describe, it, expect } from "vitest";
import {
  splitCommandSegments,
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
  classifyFdDupWord,
  hasUnbalancedQuotes,
} from "../../src/core/shell-command";

/**
 * Direct pins for the extracted command parser (core/shell-command).
 *
 * This module is now imported directly by pi/transcript-adapter.ts and was
 * pinned only indirectly through machine/extract-evidence before — a
 * regression in the splitter would have surfaced as a misclassified test
 * verdict, not a parser failure. These tests pin the parser's own contract:
 * quote-aware segment splitting, the operator each segment was preceded by,
 * comment/env stripping, fd-dup classification, and the fail-closed
 * unbalanced-quote refusal.
 */

describe("splitCommandSegmentsWithOps", () => {
  it("returns a single empty segment for empty input", () => {
    expect(splitCommandSegmentsWithOps("")).toEqual([{ text: "", opBefore: null }]);
  });

  it("splits on &&, ||, ;, |, and & with the preceding operator recorded", () => {
    expect(splitCommandSegmentsWithOps("a && b || c ; d | e & f")).toEqual([
      { text: "a ", opBefore: null },
      { text: " b ", opBefore: "&&" },
      { text: " c ", opBefore: "||" },
      { text: " d ", opBefore: ";" },
      { text: " e ", opBefore: "|" },
      { text: " f", opBefore: "&" },
    ]);
  });

  it("treats |& as a single pipe operator, not a pipe plus background", () => {
    expect(splitCommandSegmentsWithOps("a |& b")).toEqual([
      { text: "a ", opBefore: null },
      { text: " b", opBefore: "|" },
    ]);
  });

  it("does not split on &> (fd-merge redirect) — the & stays in the segment", () => {
    expect(splitCommandSegmentsWithOps("cmd &> f")).toEqual([
      { text: "cmd &> f", opBefore: null },
    ]);
  });

  it("still splits on a standalone & after a redirection (the & is a separator there)", () => {
    expect(splitCommandSegmentsWithOps("a > b & c")).toEqual([
      { text: "a > b ", opBefore: null },
      { text: " c", opBefore: "&" },
    ]);
  });

  it("keeps separators inside double quotes, single quotes, and backticks", () => {
    expect(splitCommandSegmentsWithOps('echo "a;b" && c')).toEqual([
      { text: 'echo "a;b" ', opBefore: null },
      { text: " c", opBefore: "&&" },
    ]);
    expect(splitCommandSegmentsWithOps("echo 'a|b' | cat")).toEqual([
      { text: "echo 'a|b' ", opBefore: null },
      { text: " cat", opBefore: "|" },
    ]);
    expect(splitCommandSegmentsWithOps("echo `a&b` && c")).toEqual([
      { text: "echo `a&b` ", opBefore: null },
      { text: " c", opBefore: "&&" },
    ]);
  });

  it("honors backslash escapes outside quotes (escaped separators stay literal)", () => {
    expect(splitCommandSegmentsWithOps("a \\; b")).toEqual([
      { text: "a \\; b", opBefore: null },
    ]);
    expect(splitCommandSegmentsWithOps("a \\& b")).toEqual([
      { text: "a \\& b", opBefore: null },
    ]);
  });

  it("does not let an escaped quote open a quote region (the ; between escaped quotes still splits)", () => {
    const input = 'echo \\"a;b\\"'; // runtime: echo \"a;b\" — both quotes escaped
    expect(splitCommandSegmentsWithOps(input)).toEqual([
      { text: 'echo \\"a', opBefore: null },
      { text: 'b\\"', opBefore: ";" },
    ]);
  });

  it("treats a newline as a ; separator", () => {
    expect(splitCommandSegmentsWithOps("a\nb")).toEqual([
      { text: "a", opBefore: null },
      { text: "b", opBefore: ";" },
    ]);
  });
});

describe("splitCommandSegments", () => {
  it("returns segment texts only, in order", () => {
    expect(splitCommandSegments("npm test; echo done")).toEqual(["npm test", " echo done"]);
  });

  it("agrees with the ops variant on text", () => {
    const command = "a && b | c & d";
    expect(splitCommandSegments(command)).toEqual(
      splitCommandSegmentsWithOps(command).map(({ text }) => text),
    );
  });
});

describe("stripComment", () => {
  it("strips an unquoted trailing comment (with the separator whitespace)", () => {
    expect(stripComment("echo hi # there")).toBe("echo hi ");
  });

  it("strips a whole-line comment to the empty string", () => {
    expect(stripComment("# c")).toBe("");
  });

  it("leaves # inside quotes untouched (double and single)", () => {
    expect(stripComment('echo "a # b"')).toBe('echo "a # b"');
    expect(stripComment("echo 'a # b'")).toBe("echo 'a # b'");
  });

  it("leaves # untouched when not at a token start (no preceding whitespace)", () => {
    expect(stripComment("x#y")).toBe("x#y");
  });

  it("leaves an escaped # untouched", () => {
    expect(stripComment("echo a\\#b")).toBe("echo a\\#b");
  });
});

describe("stripEnvPrefix", () => {
  it("strips a leading VAR=value assignment", () => {
    expect(stripEnvPrefix("FOO=1 bar x")).toBe("bar x");
  });

  it("strips multiple consecutive assignments", () => {
    expect(stripEnvPrefix("FOO=1 BAR=2 cmd")).toBe("cmd");
  });

  it("is quote-aware inside the assignment value", () => {
    expect(stripEnvPrefix("FOO='a b' bar")).toBe("bar");
    expect(stripEnvPrefix('FOO="a b" bar')).toBe("bar");
  });

  it("is escape-aware inside the assignment value", () => {
    expect(stripEnvPrefix("FOO=a\\ b bar")).toBe("bar");
  });

  it("returns the empty string when the segment is only an assignment", () => {
    expect(stripEnvPrefix("FOO=1")).toBe("");
  });

  it("leaves a command without an assignment prefix untouched", () => {
    expect(stripEnvPrefix("cmd arg")).toBe("cmd arg");
  });
});

describe("classifyFdDupWord", () => {
  it("classifies a digit word as fd duplication (2>&1)", () => {
    // start points just past the &; the word is "1", end one past it.
    expect(classifyFdDupWord("2>&1 rest", 3)).toEqual({ isFdDup: true, end: 4 });
  });

  it("classifies the close form >&- as fd duplication", () => {
    expect(classifyFdDupWord(">&-", 2)).toEqual({ isFdDup: true, end: 3 });
  });

  it("classifies multi-digit fds as duplication (>&10)", () => {
    expect(classifyFdDupWord(">&10 x", 2)).toEqual({ isFdDup: true, end: 4 });
  });

  it("classifies a digit-starting path as a FILE redirect, not a dup (>&2/../r.json)", () => {
    expect(classifyFdDupWord(">&2/../r.json", 2)).toEqual({ isFdDup: false, end: 13 });
  });
});

describe("hasUnbalancedQuotes", () => {
  it("flags an unterminated double quote", () => {
    expect(hasUnbalancedQuotes('echo "abc')).toBe(true);
  });

  it("flags an unterminated backtick", () => {
    expect(hasUnbalancedQuotes("echo `abc")).toBe(true);
  });

  it("accepts a quote nested inside another region (bash reads it as closed)", () => {
    // The old per-character parity flagged this: one raw single quote. The
    // splitter's quote state does not — inside double quotes `'` is literal,
    // so the command is balanced and must classify.
    expect(hasUnbalancedQuotes('echo "a\'b"')).toBe(false);
    expect(hasUnbalancedQuotes("echo 'a \" b'")).toBe(false);
  });

  it("flags an open region hidden behind an even raw count (parity missed this)", () => {
    // `\"` is an escaped quote (closed), but the trailing `"` opens a region
    // that never closes — two raw quotes, one effective open.
    expect(hasUnbalancedQuotes('echo \\" a"')).toBe(true);
    // …while a lone escaped quote is balanced:
    expect(hasUnbalancedQuotes('echo \\"')).toBe(false);
  });

  it("accepts balanced quotes, including the sh 'it''s' idiom", () => {
    expect(hasUnbalancedQuotes("echo 'it''s'")).toBe(false);
    expect(hasUnbalancedQuotes("echo \"a\" 'b' `c`")).toBe(false);
  });

  it("accepts a quote-free command", () => {
    expect(hasUnbalancedQuotes("npm test --json")).toBe(false);
  });
});
