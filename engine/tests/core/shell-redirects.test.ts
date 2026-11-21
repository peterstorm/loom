/**
 * core/shell-redirects: the ONE scan of a segment's output redirects. The
 * guard's two questions (`hasOutputRedirect`, `outputRedirectTargets`) and the
 * evidence reader's minted targets (`extractShellWriteTargets`) all read
 * `redirectsOf`, so the properties below pin the relations between them —
 * the drift class that let `>| out` name a target to the guard and mint
 * nothing as evidence.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  classifyFdDupWord,
  hasOutputRedirect,
  outputRedirectTargets,
  redirectsOf,
} from "../../src/core/shell-redirects";
import { quoteShellArgument, scanUnquoted, CONTINUE } from "../../src/core/shell-quoting";
import { extractShellWriteTargets, isDeviceStreamPath } from "../../src/core/shell-write-targets";
import { splitCommandSegments, stripComment } from "../../src/core/shell-command";
import { shellText } from "../fixtures/shell-text-arbitrary";

const kinds = (segment: string): readonly string[] => redirectsOf(segment).map(({ kind }) => kind);

describe("redirectsOf — every output redirect, typed", () => {
  it.each([
    ["clobber-ignoring >|", "echo x >| out", ["file-write"]],
    ["append", "echo x >> out", ["file-write"]],
    ["both streams", "cmd &> all.log", ["file-write"]],
    ["both streams, appending", "cmd &>> all.log", ["file-write"]],
    ["an fd", "cmd 3>out", ["file-write"]],
    ["fd dups", "cmd 2>&1 >&2 >&-", ["fd-dup", "fd-dup", "fd-dup"]],
    ["a >& to a file", "cmd >&2/../r.json", ["file-dup"]],
    ["the exact stderr discard", "ls .loom 2>/dev/null", ["stderr-discard"]],
    ["a read-write open", "cmd <> f", ["read-write"]],
    ["a process substitution", "tee >(cat)", ["process-substitution"]],
    ["an operator with no word", "cmd >", ["missing-target"]],
    ["a quoted operator", "echo '>' \">\" \\>", []],
    ["a discard masked under a >& word", ">&2>/dev/null", ["file-dup", "stderr-discard"]],
  ])("%s", (_name, segment, expected) => {
    expect(kinds(segment)).toEqual(expected);
  });

  it("names each written word as written, quotes kept", () => {
    expect(outputRedirectTargets(`cat a >| out > "b c" 2>&1 2>/dev/null`)).toEqual(["out", `"b c"`]);
    expect(outputRedirectTargets("cat a <> f")).toBeNull();
    expect(outputRedirectTargets("cat a >&file")).toBeNull();
  });

  it("starts every redirect at an unquoted `>` (a discard at its `2`), in text order", () => {
    fc.assert(fc.property(shellText, (segment) => {
      const unquoted = new Set<number>();
      scanUnquoted<never>(segment, 0, (_char, index) => {
        unquoted.add(index);
        return CONTINUE;
      });
      const redirects = redirectsOf(segment);
      redirects.forEach((redirect, k) => {
        expect(unquoted.has(redirect.at)).toBe(true);
        expect(segment[redirect.at]).toBe(redirect.kind === "stderr-discard" ? "2" : ">");
        expect(redirect.operandAt).toBeGreaterThan(redirect.at);
        if (k > 0) expect(redirect.at).toBeGreaterThan(redirects[k - 1]!.at);
      });
    }), { numRuns: 3000 });
  });

  it("finds no redirect in one quoted word", () => {
    fc.assert(fc.property(shellText, (text) => {
      expect(redirectsOf(quoteShellArgument(text))).toEqual([]);
    }), { numRuns: 2000 });
  });
});

describe("the guard's two questions are one scan", () => {
  it("a segment writes through a redirect exactly when it names a target or has one it cannot name", () => {
    fc.assert(fc.property(shellText, (segment) => {
      const targets = outputRedirectTargets(segment);
      expect(hasOutputRedirect(segment)).toBe(targets === null || targets.length > 0);
    }), { numRuns: 5000 });
  });
});

describe("the evidence reader mints what the guard names", () => {
  /** A target word whose evidence value is itself: no quote, escape or expansion. */
  const PLAIN = /^[A-Za-z0-9_./-]+$/;

  it("mints every plain target the guard names, in every operator spelling", () => {
    for (const operator of [">", ">>", ">|", "&>", "&>>", "2>", "1>|"]) {
      expect(extractShellWriteTargets(`echo x ${operator} out.txt`)).toEqual(["out.txt"]);
    }
  });

  it("over generated lines, every plain non-device target a guard names is minted", () => {
    fc.assert(fc.property(shellText, (line) => {
      if (splitCommandSegments(line).length !== 1) return; // the guard reads one segment
      const segment = stripComment(line); // …with its comment stripped, as the evidence reader does
      const minted = extractShellWriteTargets(segment);
      for (const word of outputRedirectTargets(segment) ?? []) {
        if (PLAIN.test(word) && !isDeviceStreamPath(word)) expect(minted).toContain(word);
      }
    }), { numRuns: 5000 });
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
