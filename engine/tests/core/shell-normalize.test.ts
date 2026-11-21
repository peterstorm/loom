import { describe, it, expect } from "vitest";
import { normalizeShellSpan, normalizeShellVariants } from "../../src/core/shell-normalize";
import { extractShellWriteTargets } from "../../src/core/shell-write-targets";
import { guardStateFileDecision } from "../../src/core/guard-state-file";
import { guardedLocations } from "../../src/config";

/**
 * The shared normalizer is the single owner of bash word-normalization. These
 * tests pin its rules directly AND prove the two consumers agree — the guard's
 * matching view (collapseQuotes, via guardStateFileDecision) and the evidence
 * scanner's redirect-target reader (extractShellWriteTargets) — so the "twin
 * scanners diverged" bug class of rounds 15-18 cannot recur for normalization.
 */
/**
 * Every text the matching view yields for `t`, sorted: one per combination of
 * the optional word forms' outputs (a colonless default `${x-w}` is `w` on
 * unset and EMPTY on set-but-empty; an alternate form `${x:+w}` is EMPTY on
 * unset and `w` on set). A text with no such form has exactly one view.
 */
const views = (t: string): readonly string[] => {
  const variants = normalizeShellVariants(t, 0, 256);
  expect(variants).not.toBeNull();
  return [...variants!].sort();
};

describe("the matching view (normalizeShellVariants) — bash word-normalization rules", () => {

  it("strips quotes and concatenates adjacent parts", () => {
    expect(views(".cl'aude'/state")).toEqual([".claude/state"]);
    expect(views('a"b"c')).toEqual(["abc"]);
  });

  it("drops a backslash escape, keeps the char", () => {
    expect(views(".cl\\aude")).toEqual([".claude"]);
    expect(views('"a\\bc"')).toEqual(["abc"]);
  });

  it("drops a backslash-newline line continuation (both chars)", () => {
    expect(views("grap\\\nh")).toEqual(["graph"]);
    expect(views('"grap\\\nh"')).toEqual(["graph"]);
  });

  it("decodes ANSI-C hex/octal/unicode and drops a decoded NUL", () => {
    expect(views("a$'\\x2e'b")).toEqual(["a.b"]);
    expect(views("a$'\\101'b")).toEqual(["aAb"]); // octal 101 = 'A'
    expect(views("a$'\\u0042'c")).toEqual(["aBc"]);
    // A standalone `$'\x00'` body decodes to empty (nothing after the NUL in
    // the body), so the halves rejoin: `x` + `` + `y` = `xy` (matches bash).
    expect(views("x$'\\x00'y")).toEqual(["xy"]);
    expect(views("x$'\\U00000000'y")).toEqual(["xy"]);
    // NUL truncates the REST of its OWN body: `$'a\x00b'` → `a` (bash drops
    // `\x00b`), then `q` after the close-quote continues → `aq`. All THREE
    // escape families must truncate identically — a drop-and-continue mutant
    // in any one branch would conceal a guarded literal behind trailing junk.
    expect(views("p$'a\\x00b'q")).toEqual(["paq"]);
    expect(views("p$'a\\000b'q")).toEqual(["paq"]);
    expect(views("p$'a\\u0000b'q")).toEqual(["paq"]);
    expect(views("p$'a\\U00000000b'q")).toEqual(["paq"]);
  });

  it("treats locale `$\"…\"` as `\"…\"`", () => {
    expect(views("$\".claude/state\"")).toEqual([".claude/state"]);
  });

  it("deletes `$name`/`${…}` parameter expansion to its unset→empty value, unquoted and double-quoted", () => {
    expect(views(".claude/stat${x}e")).toEqual([".claude/state"]); // braced
    expect(views(".claude/stat$xe")).toEqual([".claude/stat"]); // `$xe` is one name → deleted whole
    expect(views('".claude/stat${x}e"')).toEqual([".claude/state"]); // expands inside "…"
    expect(views("${x:+y}z")).toEqual(["yz","z"]); // alternate form yields empty on unset
    expect(views("${x:?msg}z")).toEqual(["z"]); // error form yields empty on unset
    expect(views("${#x}z")).toEqual(["z"]); // length
    expect(views("${x%.json}z")).toEqual(["z"]); // transform
    expect(views("a${outer${inner}}b")).toEqual(["ab"]); // nested braces balanced
    expect(views("$1$@$?done")).toEqual(["done"]); // special/positional params
    // Single quotes SUPPRESS expansion — `$x` stays literal.
    expect(views("'$x'a")).toEqual(["$xa"]);
    // `$(`/`$'`/`$"` are NOT parameter expansions and are left to their own rules.
    expect(views("$(cmd)")).toEqual(["$(cmd)"]); // command sub stays literal here
    expect(views("price$")).toEqual(["price$"]); // lone trailing `$` is literal
  });

  it("reveals the default word of `${x:-w}`/`${x-w}`/`${x:=w}`/`${x=w}` — bash emits the WORD on unset, not empty", () => {
    // Round-19 deleted EVERY `${…}` to empty; for the default/assign-default
    // forms that CONCEALS a guarded literal carried in the word (fail-open —
    // a live guard ALLOW while bash deleted real state). The word is revealed.
    expect(views("${x:-y}z")).toEqual(["yz"]);
    expect(views("${x-y}z")).toEqual(["yz","z"]);
    expect(views("${x:=y}z")).toEqual(["yz"]);
    expect(views("${x=y}z")).toEqual(["yz","z"]);
    expect(views('"${x:-y}z"')).toEqual(["yz"]); // reveals inside "…" too
    // The word is itself recursively normalized: quotes strip, nested
    // empty-form expansions delete, nested default words reveal.
    expect(views("${x:-'a b'}")).toEqual(["a b"]);
    expect(views("${x:-gr${y}aph}")).toEqual(["graph"]);
    expect(views("${x:-gr${y:-a}ph}")).toEqual(["graph"]);
    // A whole guarded path as the default word survives intact.
    expect(views("${x:-.claude/state/active_task_graph.json}")).toEqual([".claude/state/active_task_graph.json"]);
    // `#`-prefix (length) and PURE indirection (`${!x}`) carry no word — but
    // indirection COMBINED with an operator does (see the round-25 block below).
    expect(views("${!x}z")).toEqual(["z"]);
    expect(views("${#x}z")).toEqual(["z"]);
  });

  it("indirect expansion with a word operator (`${!x:-w}`/`${!x:+w}`/`${!x-w}`) reveals its word — pure indirect/prefix/array forms stay empty (round-25)", () => {
    // `${!x:-w}` indirects `x` to a varname, then applies `:-w` to THAT var: on
    // unset/null it substitutes `w`, exactly like the non-indirect `${y:-w}`. The
    // pre-round-25 `!`-prefix short-circuit deleted the whole span, CONCEALING a
    // guarded literal in `w` (fail-OPEN). Verified against real bash:
    // `x=NOPEVAR; printf %s "${!x:-.claude/state}"` → `.claude/state`.
    expect(views("${!x:-.claude/state/active_task_graph.json}")).toEqual([".claude/state/active_task_graph.json"]);
    expect(views(".claude/stat${!x:-X}e")).toEqual([".claude/statXe"]);
    expect(views(".claude/stat${!x-X}e")).toEqual([".claude/statXe",".claude/state"]); // colonless default
    // The alternate twin (`${!x:+w}`/`${!x+w}`) reveals `w` on SET — the
    // guard's set-state view of the indirect form.
    expect(views("${!x:+.claude/state/active_task_graph.json}")).toEqual(["",".claude/state/active_task_graph.json"]);
    expect(views(".claude/stat${!x+X}e")).toEqual([".claude/statXe",".claude/state"]);
    // A colonless indirect default's set-but-empty output (EMPTY) is a view,
    // as for its non-indirect twin.
    expect(views(".claude/stat${!x-X}e")).toEqual([".claude/statXe",".claude/state"]);
    // Pure indirect, prefix-match and array-key forms carry NO word — still empty.
    expect(views("${!x}z")).toEqual(["z"]);
    expect(views("${!pre@}z")).toEqual(["z"]); // prefix-match: names starting `pre`
    expect(views("${!pre*}z")).toEqual(["z"]);
    expect(views("${!arr[@]}z")).toEqual(["z"]); // array keys
  });

  it("a colonless default `${x-w}`/`${x=w}` has an EMPTY view; colon forms only reveal their word (round-21)", () => {
    // Colonless forms have a set-but-empty output the default view can't see:
    // the word vanishes and the surrounding literals rejoin.
    expect(views(".claude/stat${x-X}e")).toEqual([".claude/statXe",".claude/state"]);
    expect(views(".claude/stat${x=X}e")).toEqual([".claude/statXe",".claude/state"]);
    // Colon forms substitute on unset AND null — `w` is their ONLY output, so
    // every view reveals the word (never expands to empty).
    expect(views(".claude/stat${x:-X}e")).toEqual([".claude/statXe"]);
    expect(views(".claude/stat${x:=X}e")).toEqual([".claude/statXe"]);
    // The unset view (the evidence reader's) still reveals the colonless word.
    expect(normalizeShellSpan(".claude/stat${x-X}e", 0).value).toBe(".claude/statXe");
    expect(views(".claude/stat${x-X}e")).toEqual([".claude/statXe",".claude/state"]);
  });

  it("a NESTED colonless default revealed inside a colon-form word has its own EMPTY view (round-22)", () => {
    // `${x:-${y-X}}` with x unset reveals the word `${y-X}`; that inner colonless
    // form is set-but-empty → EMPTY, so bash yields `.claude/state`. The reveal of
    // the outer word must enumerate the nested form or its set-empty output is
    // concealed (the round-22 fail-open). Verified against real bash:
    // `unset x; y=; printf %s ".claude/stat${x:-${y-X}}e"` → `.claude/state`.
    expect(views(".claude/stat${x:-${y-X}}e")).toEqual([".claude/statXe",".claude/state"]);
    expect(views(".claude/stat${x:=${y=X}}e")).toEqual([".claude/statXe",".claude/state"]);
    // Arbitrary nesting depth: colonless buried two colon-reveals deep.
    expect(views(".claude/stat${x:-${y:-${z-X}}}e")).toEqual([".claude/statXe",".claude/state"]);
    // A nested COLON form inside the revealed word stays revealed (only-output).
    expect(views(".claude/stat${x:-${y:-X}}e")).toEqual([".claude/statXe"]);
    // The unset view reveals the nested colonless word.
    expect(normalizeShellSpan(".claude/stat${x:-${y-X}}e", 0).value).toBe(".claude/statXe");
    expect(views(".claude/stat${x:-${y-X}}e")).toEqual([".claude/statXe",".claude/state"]);
  });

  it("an alternate form `${x:+w}`/`${x+w}` has a view revealing its WORD; default/error forms are unchanged (round-24)", () => {
    // Alternate forms substitute `w` when the var is SET (`:+` set-non-null, `+`
    // set) — the second bash output the primary (unset→empty) view can't see. An
    // always-set var (PWD/HOME/$$) carries a guarded literal in `w`, so the guard
    // must reveal it or fail OPEN (the round-24 bypass). Verified against real
    // bash: `printf %s "${PWD:+.claude/state}"` → `.claude/state`.
    expect(views("${x:+y}z")).toEqual(["yz","z"]);
    expect(views("${x+y}z")).toEqual(["yz","z"]);
    expect(views('"${x:+y}z"')).toEqual(["yz","z"]); // reveals inside "…" too
    expect(views("${PWD:+.claude/state/active_task_graph.json}")).toEqual(["",".claude/state/active_task_graph.json"]);
    expect(views(".claude/stat${x:+X}e")).toEqual([".claude/statXe",".claude/state"]);
    // The alternate word is recursively normalized like a default word.
    expect(views("${x:+gr${y:-a}ph}")).toEqual(["","graph"]);
    // Default/error forms are not optional: a colon default reveals its word in
    // every view (its only output), `:?` stays empty.
    expect(views("${x:-y}z")).toEqual(["yz"]);
    expect(views("${x:?msg}z")).toEqual(["z"]);
    // The unset view (the evidence reader's) deletes an alternate form to empty.
    expect(normalizeShellSpan("${x:+y}z", 0).value).toBe("z");
    expect(views("${x:+y}z")).toEqual(["yz","z"]);
    expect(views(".claude/stat${x:+X}e")).toEqual([".claude/statXe",".claude/state"]);
  });

  it("NESTED alternate/default forms are enumerated at any depth (round-24)", () => {
    // A colon-default reveal wrapping an alternate form must enumerate it or the
    // inner set-state word is concealed. `x` unset → reveal `${PWD:+X}`; `PWD` set
    // → `X`, so bash yields `.claude/state`.
    expect(views(".claude/stat${x:-${PWD:+X}}e")).toEqual([".claude/statXe",".claude/state"]);
    // Alternate nested inside alternate, two deep.
    expect(views(".claude/stat${a:+${b:+X}}e")).toEqual([".claude/statXe",".claude/state"]);
    // A colonless default emptied AND an alternate revealed in the same span —
    // the cross-product the guard tests.
    expect(views(".claude/sta${x-Q}te${y:+/active_task_graph.json}")).toEqual([".claude/staQte",".claude/staQte/active_task_graph.json",".claude/state",".claude/state/active_task_graph.json"]);
  });

  it("enumerates mixed per-expansion states instead of applying one global choice", () => {
    const text = ".cl${a-a}${b-X}u${c-d}e/sta${d-t}${e-X}e/active_task_gr${f-a}${g-X}ph.json";
    const variants = normalizeShellVariants(text, 0, 256);

    expect(variants).not.toBeNull();
    expect(variants).toContain(".claude/state/active_task_graph.json");
    expect(variants).toContain(".claXude/statXe/active_task_graXph.json");
  });

  it("returns null rather than truncating an unbounded parameter-state cross-product", () => {
    const text = Array.from({ length: 9 }, (_, index) => `\${x${index}-x}`).join("");
    expect(normalizeShellVariants(text, 0, 256)).toBeNull();
  });

  it("normalizeShellSpan (the redirect word) stops at unquoted whitespace/redirect metacharacters", () => {
    expect(normalizeShellSpan("file.txt rest", 0).value).toBe("file.txt");
    expect(normalizeShellSpan("file.txt>x", 0).value).toBe("file.txt");
    // quoted whitespace is NOT a boundary
    expect(normalizeShellSpan('"a b" c', 0).value).toBe("a b");
  });

  it("normalizeShellSpan stops a redirect word at `|` and `;`", () => {
    expect(normalizeShellSpan("out.json|cat", 0).value).toBe("out.json");
    expect(normalizeShellSpan("out.json;ls", 0).value).toBe("out.json");
  });

  it("a backtick quotes in a redirect word and stays literal in the matching view", () => {
    expect(views("a`b`c")).toEqual(["a`b`c"]);
    expect(normalizeShellSpan("a`b`c", 0).value).toBe("abc");
  });
});

describe("guard ⇄ evidence normalization parity (same input, same decoded literal)", () => {
  // Each raw word, once bash-normalized, is `decoded`. The evidence scanner must
  // MINT exactly `decoded` as the redirect target, and the shared normalizer's
  // whole-segment view must produce the same — one contract, two consumers.
  // A colonless default also has its set-but-empty output among the guard's
  // views (the third column); every other row has exactly one view.
  type Row = readonly [raw: string, decoded: string] | readonly [raw: string, decoded: string, guardViews: readonly string[]];
  const battery: readonly Row[] = [
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
    ["grap${x-h}.json", "graph.json", ["grap.json", "graph.json"]],
    ["grap${x:=h}.json", "graph.json"],
    ["grap${x=h}.json", "graph.json", ["grap.json", "graph.json"]],
    // Mid-body NUL truncation, one row per ANSI-C escape family.
    ["p$'a\\000b'q", "paq"],
    ["p$'a\\u0000b'q", "paq"],
    ["p$'a\\U00000000b'q", "paq"],
  ];

  for (const [raw, decoded, guardViews = [decoded]] of battery) {
    it(`"${raw.replace(/\n/g, "\\n")}" → "${decoded}" in both`, () => {
      expect(views(raw)).toEqual(guardViews);
      expect(normalizeShellSpan(raw, 0).value).toBe(decoded);
      expect(extractShellWriteTargets(`cat > ${raw}`)).toEqual([decoded]);
    });
  }

  it("a guarded path spelled in ANSI-C: guard BLOCKS and evidence MINTS the same path", () => {
    const hexPath =
      "$'\\x2e\\x63\\x6c\\x61\\x75\\x64\\x65\\x2f\\x73\\x74\\x61\\x74\\x65\\x2f" +
      "\\x61\\x63\\x74\\x69\\x76\\x65\\x5f\\x74\\x61\\x73\\x6b\\x5f\\x67\\x72\\x61\\x70\\x68\\x2e\\x6a\\x73\\x6f\\x6e'";
    expect(guardStateFileDecision(`echo X > ${hexPath}`, guardedLocations()).kind).toBe("block");
    expect(extractShellWriteTargets(`echo X > ${hexPath}`)).toEqual([
      ".claude/state/active_task_graph.json",
    ]);
  });
});
