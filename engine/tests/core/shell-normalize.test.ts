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
    // `\x00b`), then `q` after the close-quote continues → `aq`. All THREE
    // escape families must truncate identically — a drop-and-continue mutant
    // in any one branch would conceal a guarded literal behind trailing junk.
    expect(whole("p$'a\\x00b'q")).toBe("paq");
    expect(whole("p$'a\\000b'q")).toBe("paq");
    expect(whole("p$'a\\u0000b'q")).toBe("paq");
    expect(whole("p$'a\\U00000000b'q")).toBe("paq");
  });

  it("treats locale `$\"…\"` as `\"…\"`", () => {
    expect(whole("$\".claude/state\"")).toBe(".claude/state");
  });

  it("deletes `$name`/`${…}` parameter expansion to its unset→empty value, unquoted and double-quoted", () => {
    expect(whole(".claude/stat${x}e")).toBe(".claude/state"); // braced
    expect(whole(".claude/stat$xe")).toBe(".claude/stat"); // `$xe` is one name → deleted whole
    expect(whole('".claude/stat${x}e"')).toBe(".claude/state"); // expands inside "…"
    expect(whole("${x:+y}z")).toBe("z"); // alternate form yields empty on unset
    expect(whole("${x:?msg}z")).toBe("z"); // error form yields empty on unset
    expect(whole("${#x}z")).toBe("z"); // length
    expect(whole("${x%.json}z")).toBe("z"); // transform
    expect(whole("a${outer${inner}}b")).toBe("ab"); // nested braces balanced
    expect(whole("$1$@$?done")).toBe("done"); // special/positional params
    // Single quotes SUPPRESS expansion — `$x` stays literal.
    expect(whole("'$x'a")).toBe("$xa");
    // `$(`/`$'`/`$"` are NOT parameter expansions and are left to their own rules.
    expect(whole("$(cmd)")).toBe("$(cmd)"); // command sub stays literal here
    expect(whole("price$")).toBe("price$"); // lone trailing `$` is literal
  });

  it("reveals the default word of `${x:-w}`/`${x-w}`/`${x:=w}`/`${x=w}` — bash emits the WORD on unset, not empty", () => {
    // Round-19 deleted EVERY `${…}` to empty; for the default/assign-default
    // forms that CONCEALS a guarded literal carried in the word (fail-open —
    // a live guard ALLOW while bash deleted real state). The word is revealed.
    expect(whole("${x:-y}z")).toBe("yz");
    expect(whole("${x-y}z")).toBe("yz");
    expect(whole("${x:=y}z")).toBe("yz");
    expect(whole("${x=y}z")).toBe("yz");
    expect(whole('"${x:-y}z"')).toBe("yz"); // reveals inside "…" too
    // The word is itself recursively normalized: quotes strip, nested
    // empty-form expansions delete, nested default words reveal.
    expect(whole("${x:-'a b'}")).toBe("a b");
    expect(whole("${x:-gr${y}aph}")).toBe("graph");
    expect(whole("${x:-gr${y:-a}ph}")).toBe("graph");
    // A whole guarded path as the default word survives intact.
    expect(whole("${x:-.claude/state/active_task_graph.json}")).toBe(
      ".claude/state/active_task_graph.json",
    );
    // `#`/`!`-prefixed bodies are length/indirection, never a default word.
    expect(whole("${!x}z")).toBe("z");
  });

  it("colonlessDefaultsEmpty collapses `${x-w}`/`${x=w}` to EMPTY but leaves colon forms revealing their word (round-21)", () => {
    const empty = (t: string) =>
      normalizeShellSpan(t, 0, { mode: "matching-view", colonlessDefaultsEmpty: true }).value;
    // Colonless forms have a set-but-empty output the default view can't see:
    // the word vanishes and the surrounding literals rejoin.
    expect(empty(".claude/stat${x-X}e")).toBe(".claude/state");
    expect(empty(".claude/stat${x=X}e")).toBe(".claude/state");
    // Colon forms substitute on unset AND null — `w` is their ONLY output, so
    // this base still reveals the word (never expands to empty).
    expect(empty(".claude/stat${x:-X}e")).toBe(".claude/statXe");
    expect(empty(".claude/stat${x:=X}e")).toBe(".claude/statXe");
    // The flag is additive: without it, colonless forms reveal their word like
    // the default matching view (keeping guard and evidence twin point-wise equal).
    expect(whole(".claude/stat${x-X}e")).toBe(".claude/statXe");
  });

  it("colonlessDefaultsEmpty threads into NESTED colonless defaults revealed inside a colon-form word (round-22)", () => {
    const empty = (t: string) =>
      normalizeShellSpan(t, 0, { mode: "matching-view", colonlessDefaultsEmpty: true }).value;
    // `${x:-${y-X}}` with x unset reveals the word `${y-X}`; that inner colonless
    // form is set-but-empty → EMPTY, so bash yields `.claude/state`. The reveal of
    // the outer word must carry the colonless-empty flag or the nested set-empty
    // output is concealed (the round-22 fail-open). Verified against real bash:
    // `unset x; y=; printf %s ".claude/stat${x:-${y-X}}e"` → `.claude/state`.
    expect(empty(".claude/stat${x:-${y-X}}e")).toBe(".claude/state");
    expect(empty(".claude/stat${x:=${y=X}}e")).toBe(".claude/state");
    // Arbitrary nesting depth: colonless buried two colon-reveals deep.
    expect(empty(".claude/stat${x:-${y:-${z-X}}}e")).toBe(".claude/state");
    // A nested COLON form inside the revealed word stays revealed (only-output).
    expect(empty(".claude/stat${x:-${y:-X}}e")).toBe(".claude/statXe");
    // Without the flag, nested colonless reveals its word like the default view,
    // keeping guard and evidence twin point-wise identical for the primary base.
    expect(whole(".claude/stat${x:-${y-X}}e")).toBe(".claude/statXe");
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
    // Default/assign-default forms reveal their word in BOTH consumers — all
    // four operators, as redirect targets too (`cat > grap${x:-h}.json` mints
    // `graph.json`, the file bash creates when x is unset).
    ["grap${x:-h}.json", "graph.json"],
    ["grap${x-h}.json", "graph.json"],
    ["grap${x:=h}.json", "graph.json"],
    ["grap${x=h}.json", "graph.json"],
    // Mid-body NUL truncation, one row per ANSI-C escape family.
    ["p$'a\\000b'q", "paq"],
    ["p$'a\\u0000b'q", "paq"],
    ["p$'a\\U00000000b'q", "paq"],
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
