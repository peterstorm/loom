import { describe, it, expect } from "vitest";
import { normalizeShellSpan } from "../../src/core/shell-normalize";
import { extractShellWriteTargets } from "../../src/machine/extract-evidence";
import { guardStateFileDecision } from "../../src/core/guard-state-file";

/**
 * The shared normalizer is the single owner of bash word-normalization. These
 * tests pin its rules directly AND prove the two consumers agree — the guard's
 * matching view (collapseQuotes, via guardStateFileDecision) and the evidence
 * scanner's redirect-target reader (extractShellWriteTargets) — so the "twin
 * scanners diverged" bug class of rounds 15-18 cannot recur for normalization.
 */
describe("normalizeShellSpan — bash word-normalization rules", () => {
  const whole = (t: string) => normalizeShellSpan(t, 0, { mode: "matching-view" }).value;

  it("strips quotes and concatenates adjacent parts", () => {
    expect(whole(".cl'aude'/state")).toBe(".claude/state");
    expect(whole('a"b"c')).toBe("abc");
  });

  it("drops a backslash escape, keeps the char", () => {
    expect(whole(".cl\\aude")).toBe(".claude");
    expect(whole('"a\\bc"')).toBe("abc");
  });

  it("drops a backslash-newline line continuation (both chars)", () => {
    expect(whole("grap\\\nh")).toBe("graph");
    expect(whole('"grap\\\nh"')).toBe("graph");
  });

  it("decodes ANSI-C hex/octal/unicode and drops a decoded NUL", () => {
    expect(whole("a$'\\x2e'b")).toBe("a.b");
    expect(whole("a$'\\101'b")).toBe("aAb"); // octal 101 = 'A'
    expect(whole("a$'\\u0042'c")).toBe("aBc");
    // A standalone `$'\x00'` body decodes to empty (nothing after the NUL in
    // the body), so the halves rejoin: `x` + `` + `y` = `xy` (matches bash).
    expect(whole("x$'\\x00'y")).toBe("xy");
    expect(whole("x$'\\U00000000'y")).toBe("xy");
    // NUL truncates the REST of its OWN body: `$'a\x00b'` → `a` (bash drops
    // `\x00b`), then `q` after the close-quote continues → `aq`.
    expect(whole("p$'a\\x00b'q")).toBe("paq");
  });

  it("treats locale `$\"…\"` as `\"…\"`", () => {
    expect(whole("$\".claude/state\"")).toBe(".claude/state");
  });

  it("deletes `$name`/`${…}` parameter expansion to its unset→empty value, unquoted and double-quoted", () => {
    expect(whole(".claude/stat${x}e")).toBe(".claude/state"); // braced
    expect(whole(".claude/stat$xe")).toBe(".claude/stat"); // `$xe` is one name → deleted whole
    expect(whole('".claude/stat${x}e"')).toBe(".claude/state"); // expands inside "…"
    expect(whole("${x:-y}z")).toBe("z"); // modifier form removed whole
    expect(whole("a${outer${inner}}b")).toBe("ab"); // nested braces balanced
    expect(whole("$1$@$?done")).toBe("done"); // special/positional params
    // Single quotes SUPPRESS expansion — `$x` stays literal.
    expect(whole("'$x'a")).toBe("$xa");
    // `$(`/`$'`/`$"` are NOT parameter expansions and are left to their own rules.
    expect(whole("$(cmd)")).toBe("$(cmd)"); // command sub stays literal here
    expect(whole("price$")).toBe("price$"); // lone trailing `$` is literal
  });

  it("redirect-word mode stops at unquoted whitespace/redirect metacharacters", () => {
    expect(normalizeShellSpan("file.txt rest", 0, { mode: "redirect-word" }).value).toBe("file.txt");
    expect(normalizeShellSpan("file.txt>x", 0, { mode: "redirect-word" }).value).toBe("file.txt");
    // quoted whitespace is NOT a boundary
    expect(normalizeShellSpan('"a b" c', 0, { mode: "redirect-word" }).value).toBe("a b");
  });

  it("redirect-word mode stops a redirect word at `|` and `;`", () => {
    expect(normalizeShellSpan("out.json|cat", 0, { mode: "redirect-word" }).value).toBe("out.json");
    expect(normalizeShellSpan("out.json;ls", 0, { mode: "redirect-word" }).value).toBe("out.json");
  });

  it("mode selects whether a backtick quotes (redirect-word) or stays literal (matching-view)", () => {
    expect(normalizeShellSpan("a`b`c", 0, { mode: "matching-view" }).value).toBe("a`b`c");
    expect(normalizeShellSpan("a`b`c", 0, { mode: "redirect-word" }).value).toBe("abc");
  });
});

describe("guard ⇄ evidence normalization parity (same input, same decoded literal)", () => {
  // Each raw word, once bash-normalized, is `decoded`. The evidence scanner must
  // MINT exactly `decoded` as the redirect target, and the shared normalizer's
  // whole-segment view must produce the same — one contract, two consumers.
  const battery: ReadonlyArray<readonly [string, string]> = [
    ["a$'\\x2e'b", "a.b"],
    ["x$'\\x00'y", "xy"], // standalone `$'\x00'` body → empty, halves rejoin
    ["p$'a\\x00b'q", "paq"], // NUL truncates the rest of its OWN body (`a\x00b` → `a`)
    ["a$'\\101'b", "aAb"],
    ["a$'\\u002f'b", "a/b"],
    ["gr\\\naph", "graph"],
    [".cl'aude'/state", ".claude/state"],
    ["$\"/tmp/x\"", "/tmp/x"],
    [".claude/stat${x}e", ".claude/state"], // param expansion deleted in both
    ["grap${x}h.json", "graph.json"],
  ];

  for (const [raw, decoded] of battery) {
    it(`"${raw.replace(/\n/g, "\\n")}" → "${decoded}" in both`, () => {
      expect(normalizeShellSpan(raw, 0, { mode: "matching-view" }).value).toBe(decoded);
      expect(extractShellWriteTargets(`cat > ${raw}`)).toEqual([decoded]);
    });
  }

  it("a guarded path spelled in ANSI-C: guard BLOCKS and evidence MINTS the same path", () => {
    const hexPath =
      "$'\\x2e\\x63\\x6c\\x61\\x75\\x64\\x65\\x2f\\x73\\x74\\x61\\x74\\x65\\x2f" +
      "\\x61\\x63\\x74\\x69\\x76\\x65\\x5f\\x74\\x61\\x73\\x6b\\x5f\\x67\\x72\\x61\\x70\\x68\\x2e\\x6a\\x73\\x6f\\x6e'";
    expect(guardStateFileDecision(`echo X > ${hexPath}`).kind).toBe("block");
    expect(extractShellWriteTargets(`echo X > ${hexPath}`)).toEqual([
      ".claude/state/active_task_graph.json",
    ]);
  });
});
