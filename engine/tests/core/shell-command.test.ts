import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { shellText } from "../fixtures/shell-text-arbitrary";
import {
  splitCommandSegments,
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
  hasUnbalancedQuotes,
  OPERATOR_WALK_START,
  readShellOperator,
} from "../../src/core/shell-command";

/**
 * Direct pins for the extracted command parser (core/shell-command).
 *
 * This module is now imported directly by pi/transcript-adapter.ts and was
 * pinned only indirectly through machine/extract-evidence before — a
 * regression in the splitter would have surfaced as a misclassified test
 * verdict, not a parser failure. These tests pin the parser's own contract:
 * quote-aware segment splitting, the operator each segment was preceded by,
 * comment/env stripping, and the fail-closed
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

/** The operator at `index` as a walk that has read nothing before it sees it. */
const operatorAt = (text: string, index: number) => readShellOperator(text, index, OPERATOR_WALK_START).operator;

/** The operator at `index` as a walk that has just read the `>` before it unquoted. */
const operatorAfterUnquotedGt = (text: string, index: number) => {
  expect(text[index - 1]).toBe(">");
  return readShellOperator(text, index, readShellOperator(text, index - 1, OPERATOR_WALK_START).walk).operator;
};

/**
 * readShellOperator is the ONE operator table and the one walk that reads it:
 * the segment splitter and the heredoc opener-line group walk both consume it,
 * so this pins what each operator does in both (the group walk cuts on every
 * separator but `|`).
 */
describe("readShellOperator", () => {
  it.each([
    ["&&", "a && b", 2, { separator: "&&", width: 2 }],
    ["||", "a || b", 2, { separator: "||", width: 2 }],
    ["background &", "a & b", 2, { separator: "&", width: 1 }],
    ["&> redirect binds", "a &>f", 2, { separator: null, width: 2 }],
    ["&>> redirect binds over its &>", "a &>>f", 2, { separator: null, width: 2 }],
    ["pipe", "a | b", 2, { separator: "|", width: 1 }],
    ["|& pipes stderr too", "a |& b", 2, { separator: "|", width: 2 }],
    [";", "a; b", 1, { separator: ";", width: 1 }],
    ["each ; of ;; is its own separator", "a;; b", 2, { separator: ";", width: 1 }],
    ["newline", "a\nb", 1, { separator: ";", width: 1 }],
  ] as const)("%s", (_name, text, index, operator) => {
    expect(operatorAt(text, index)).toEqual(operator);
  });

  it.each([
    [">& fd dup binds its &", "a 2>&1", 4, { separator: null, width: 1 }],
    [">| clobber binds its |", "a >|f", 3, { separator: null, width: 1 }],
    ["&& still separates", "a >&& b", 3, { separator: "&&", width: 2 }],
    ["|| still separates", "a >|| b", 3, { separator: "||", width: 2 }],
    ["a | after >> is a pipe (a syntax error bash runs nothing for)", "a >>| b", 4, { separator: "|", width: 1 }],
    ["a | after &> is a pipe", "a &>| b", 4, { separator: "|", width: 1 }],
  ] as const)("after an unquoted >: %s", (_name, text, index, operator) => {
    expect(operatorAfterUnquotedGt(text, index)).toEqual(operator);
  });

  it("binds only right after a > the walk itself read: a skipped or earlier > arms nothing", () => {
    // The walk read `>` at 2, then the space at 3: the `&` at 4 is background.
    const pastSpace = readShellOperator("a > & b", 3, readShellOperator("a > & b", 2, OPERATOR_WALK_START).walk).walk;
    expect(readShellOperator("a > & b", 4, pastSpace).operator).toEqual({ separator: "&", width: 1 });
    // A walk that never read the `>` before the `&` (a skipped span) does not bind it.
    expect(readShellOperator("a 2>&1", 4, readShellOperator("a 2>&1", 2, OPERATOR_WALK_START).walk).operator)
      .toEqual({ separator: "&", width: 1 });
  });

  it("arms the walk past an operator that ends in >: the & after &> binds", () => {
    const pastRedirect = readShellOperator("a &>&2", 2, OPERATOR_WALK_START);
    expect(pastRedirect.operator).toEqual({ separator: null, width: 2 });
    expect(readShellOperator("a &>&2", 4, pastRedirect.walk).operator).toEqual({ separator: null, width: 1 });
  });

  it.each([
    ["an ordinary character", "abc", 1],
    ["a redirect", "a > f", 2],
    ["past the end", "a", 5],
  ])("is null at %s", (_name, text, index) => {
    expect(operatorAt(text, index)).toBeNull();
  });

  it("keeps a binding operator's characters in the segment it belongs to", () => {
    expect(splitCommandSegments("cat a &>log; b 2>&1")).toEqual(["cat a &>log", " b 2>&1"]);
    expect(splitCommandSegments("echo x >| out | wc")).toEqual(["echo x >| out ", " wc"]);
  });

  it("binds only after a > the lexer reads unquoted: an escaped or quoted > is a word, and its & separates", () => {
    expect(splitCommandSegments("echo \\>& rm f")).toEqual(["echo \\>", " rm f"]);
    expect(splitCommandSegments("echo '>'& rm f")).toEqual(["echo '>'", " rm f"]);
    expect(splitCommandSegments("echo \\>| rm f")).toEqual(["echo \\>", " rm f"]);
  });
});

describe("the splitter and env-prefix strip read the one quote lexer", () => {
  it("segments and the separators between them rebuild the command exactly", () => {
    fc.assert(fc.property(shellText, (command) => {
      const segments = splitCommandSegmentsWithOps(command);
      let at = 0;
      segments.forEach(({ text, opBefore }, k) => {
        if (k > 0) {
          // A separator never follows an unquoted `>` it would bind to.
          const operator = operatorAt(command, at);
          expect(operator?.separator).toBe(opBefore);
          at += operator!.width;
        } else {
          expect(opBefore).toBeNull();
        }
        expect(command.startsWith(text, at)).toBe(true);
        at += text.length;
      });
      expect(at).toBe(command.length);
    }), { numRuns: 3000 });
  });

  it("a segment holds no separator of its own: re-splitting it yields itself", () => {
    fc.assert(fc.property(shellText, (command) => {
      for (const { text } of splitCommandSegmentsWithOps(command)) {
        expect(splitCommandSegments(text)).toEqual([text]);
      }
    }), { numRuns: 3000 });
  });

  it("stripEnvPrefix returns an idempotent suffix that starts with no assignment", () => {
    fc.assert(fc.property(fc.tuple(fc.constantFrom("", "A=", "A=1 ", "B='x y' ", "C=a\\ b "), shellText), ([prefix, rest]) => {
      const segment = prefix + rest;
      const stripped = stripEnvPrefix(segment);
      expect(segment.endsWith(stripped)).toBe(true);
      expect(stripped).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
      expect(stripEnvPrefix(stripped)).toBe(stripped);
    }), { numRuns: 3000 });
  });
});
