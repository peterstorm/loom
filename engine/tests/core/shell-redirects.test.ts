/**
 * core/shell-redirects: the ONE scan of a segment's output redirects. The
 * guard's two questions (`hasOutputRedirect`, `outputRedirectTargets`) and the
 * evidence reader's minted targets (`redirectTargetsOf`, read by
 * `extractShellWriteTargets`) all read `redirectsOf`, each by the redirect's
 * kind, so the properties below pin the relations between them —
 * the drift class that let `>| out` name a target to the guard and mint
 * nothing as evidence.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  hasOutputRedirect,
  outputRedirectTargets,
  redirectTargetsOf,
  redirectsOf,
  type OutputRedirect,
} from "../../src/core/shell-redirects";
import { normalizeShellSpan } from "../../src/core/shell-normalize";
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

  /** Text cut off mid-redirect: what the lexer, the guard and the evidence reader each read off it. */
  it.each<[name: string, segment: string, kinds: readonly string[], guard: readonly string[] | null, minted: readonly string[]]>([
    ["a target ending in a lone backslash", "echo x > out\\", ["file-write"], ["out\\"], ["out"]],
    ["a lone backslash as the whole target", "echo x >\\", ["file-write"], ["\\"], []],
    ["only whitespace after the operator", "echo x >\t", ["missing-target"], null, []],
    ["an unterminated single quote", "echo x > 'unterminated", ["file-write"], ["'unterminated"], ["unterminated"]],
    ["an unterminated double quote", `echo x > "a b`, ["file-write"], [`"a b`], ["a b"]],
  ])("reads truncated input: %s", (_name, segment, expectedKinds, guard, minted) => {
    expect(kinds(segment)).toEqual(expectedKinds);
    expect(outputRedirectTargets(segment)).toEqual(guard);
    expect(hasOutputRedirect(segment)).toBe(true);
    expect(redirectTargetsOf(segment)).toEqual(minted);
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

describe("a >& word: fd duplication or a file", () => {
  /** The one redirect of `segment`, without the fields a `>&` does not carry. */
  const only = (segment: string): Pick<OutputRedirect, "kind" | "at" | "end"> => {
    const [redirect, ...rest] = redirectsOf(segment);
    expect(rest).toEqual([]);
    return { kind: redirect!.kind, at: redirect!.at, end: redirect!.end };
  };

  it("classifies a digit word as fd duplication (2>&1), ending past the word", () => {
    expect(only("2>&1 rest")).toEqual({ kind: "fd-dup", at: 1, end: 4 });
  });

  it("classifies the close form >&- as fd duplication", () => {
    expect(only(">&-")).toEqual({ kind: "fd-dup", at: 0, end: 3 });
  });

  it("classifies multi-digit fds as duplication (>&10)", () => {
    expect(only(">&10 x")).toEqual({ kind: "fd-dup", at: 0, end: 4 });
  });

  it("classifies a digit-starting path as a FILE redirect, not a dup (>&2/../r.json)", () => {
    expect(only(">&2/../r.json")).toEqual({ kind: "file-dup", at: 0, end: 13 });
  });
});

describe("every kind answers what file it writes, once", () => {
  /** One spelling per kind, with what the guard and the evidence reader each read off it. */
  const KINDS: Readonly<Record<OutputRedirect["kind"], readonly [segment: string, guard: readonly string[] | null, minted: readonly string[]]>> = {
    "file-write": ["echo x > out", ["out"], ["out"]],
    "file-dup": ["echo x >&out", null, ["out"]],
    "read-write": ["cat <> rw", null, ["rw"]],
    "process-substitution": ["tee >(cat)", null, []],
    "missing-target": ["echo x >", null, []],
    "fd-dup": ["echo x 2>&1", [], []],
    "stderr-discard": ["ls 2>/dev/null", [], ["/dev/null"]],
  };

  it.each(Object.entries(KINDS))("%s", (kind, [segment, guard, minted]) => {
    expect(kinds(segment)).toEqual([kind]);
    expect(outputRedirectTargets(segment)).toEqual(guard);
    expect(hasOutputRedirect(segment)).toBe(guard === null || guard.length > 0);
    expect(redirectTargetsOf(segment)).toEqual(minted);
  });
});

describe("redirectTargetsOf — the evidence reader's targets", () => {
  it("values each target through the normalizer: quotes, escapes and ANSI-C removed", () => {
    expect(redirectTargetsOf(`cat > "a b" >> c\\ d >| $'e\\x66'`)).toEqual(["a b", "c d", "ef"]);
  });

  it("reads past a word the normalizer ends where the lexer would leave a quote open", () => {
    // The lexer reads `$'a\'b'` as `$'a\'` then `b` and a quote left open to
    // the end, so it sees one redirect; bash and the normalizer read the
    // ANSI-C word `a'b`, and then the second redirect.
    expect(outputRedirectTargets("cat > $'a\\'b' > out")).toEqual(["$'a\\'b' > out"]);
    expect(redirectTargetsOf("cat > $'a\\'b' > out")).toEqual(["a'b", "out"]);
  });

  it("keeps the lexer's reading where the normalizer reads a word further", () => {
    // `${x:-a >f}` is one word to the normalizer; the lexer cuts it at the
    // blank and reads a second redirect inside it. Both readings' targets are
    // minted (`out` by each reading; the caller dedupes).
    expect(new Set(redirectTargetsOf("cat > ${x:-a >f} > out"))).toEqual(new Set(["a >f", "out", "f}"]));
  });

  it("mints the word bash writes where the stderr-discard mask hid it from the scan, and the word the guard judged", () => {
    // `>|2` writes the file `2`; the scan masks `2>/dev/null` as a discard and
    // hands the guard `a` as the `>|` target. Both are minted.
    expect(outputRedirectTargets("echo x >|2>/dev/null a")).toEqual(["a"]);
    expect(new Set(redirectTargetsOf("echo x >|2>/dev/null a"))).toEqual(new Set(["2", "a", "/dev/null"]));
  });

  it("mints nothing for an operator bash rejects as a syntax error (>>&, <>&, &>>&, >|&)", () => {
    for (const segment of ["echo hi >>&x", "cat <>&x", "echo hi &>>&x", "echo hi >|&x"]) {
      expect(redirectTargetsOf(segment), segment).toEqual([]);
    }
  });

  it("over generated lines, mints the normalizer's value of every word a redirect carries", () => {
    fc.assert(fc.property(shellText, (segment) => {
      const minted = redirectTargetsOf(segment);
      for (const redirect of redirectsOf(segment)) {
        if (redirect.kind !== "file-write") continue;
        const { value } = normalizeShellSpan(segment, redirect.end - redirect.word.length);
        if (value !== "") expect(minted).toContain(value);
      }
    }), { numRuns: 3000 });
  });
});
