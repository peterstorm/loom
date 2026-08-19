import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  analyzeCommandHead,
  blankSubstitutions,
  flattenSubstitutions,
  scanSubstitutions,
  splitHeredocs,
} from "../../src/core/guard-state-file";

/**
 * Walker-divergence property net for guard-state-file's shell scanners.
 *
 * The module's history is a series of "two quote-aware walkers disagreed"
 * bugs (rounds 15–18 twin-scanner divergence; round-20 double-quoted
 * apostrophe disabling the substitution defense; the heredoc inline-program
 * classification gap). Each property below pins an invariant that a walker
 * refactor must preserve, asserted against an INDEPENDENT reference walker
 * written here rather than against the implementation itself:
 *
 *  - scanSubstitutions' span decisions must agree with a naive-but-earnest
 *    reference on what is inside single quotes / double quotes / live
 *    substitution spans;
 *  - flattenSubstitutions and blankSubstitutions must agree with each other
 *    AND with the reference on the LIVE substitution count (they share the
 *    scanner today; the net pins the contract they must keep sharing);
 *  - analyzeCommandHead must produce a head that is a single unquoted word
 *    (a quote-state leak surfaces as whitespace or a quote char in the head);
 *  - splitHeredocs must strip exactly the body of a quoted heredoc and leave
 *    the opener line's non-heredoc text intact.
 */

/** Command heads constructed here must come out as single unquoted words. */
const WORD = fc.array(fc.constantFrom("a", "b", "c", ".", "/", "-"), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));
const HEAD = fc.constantFrom("cat", "bash", "sh", "echo", "read", "eval", "xargs", "python3", "sudo", "env");

/** Word with a single-quote span inside double quotes or vice versa — the
 *  round-20 class: a `'` inside `"…"` must NOT open single-quote mode. */
const QUOTED = fc.oneof(
  fc.tuple(WORD, WORD).map(([a, b]) => `"${a}'${b}"`),
  fc.tuple(WORD, WORD).map(([a, b]) => `'${a}"${b}'`),
);

/** A substitution-like span: bare, inside double quotes (LIVE — bash still
 *  performs it), or inside single quotes (INERT — bash does not). */
const SPAN = fc.tuple(WORD, WORD).map(([a, b]) => `$(${a} ${b})`);
const BACKTICK = fc.tuple(WORD, WORD).map(([a, b]) => `\`${a} ${b}\``);

/** Reference walker: tracks single/double quote state and counts LIVE
 *  substitution openers (`$(` and backticks outside single quotes; `$(` and
 *  backticks inside double quotes stay live — matching bash and the scanner
 *  contract). Each opener SKIPS its whole span (to the matching close paren,
 *  paren-depth counted, or the closing backtick) exactly like
 *  scanSubstitutions — inner openers inside a body are NOT top-level spans.
 *  Deliberately independent of scanSubstitutions. */
function referenceLiveSubstitutionCount(text: string): number {
  let count = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === null && c === "'") { quote = "'"; continue; }
    if (quote === "'" && c === "'") { quote = null; continue; }
    if (quote === null && c === '"') { quote = '"'; continue; }
    if (quote === '"' && c === '"') { quote = null; continue; }
    if (quote === "'") continue; // everything in single quotes is inert
    if (c === "$" && text[i + 1] === "(") {
      count++;
      let depth = 1;
      for (let j = i + 2; j < text.length && depth > 0; j++) {
        if (text[j] === "(") depth++;
        if (text[j] === ")") depth--;
        i = j;
      }
      continue;
    }
    if (c === "`") {
      count++;
      const close = text.indexOf("`", i + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
  }
  return count;
}

describe("guard-state-file walker divergence net", () => {
  it("flattenSubstitutions and blankSubstitutions agree with the reference on LIVE substitution spans", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(WORD, QUOTED, SPAN, BACKTICK, fc.constant(" ")), { minLength: 0, maxLength: 12 }),
        (fragments) => {
          const text = fragments.join("");
          const expected = referenceLiveSubstitutionCount(text);
          const flat = flattenSubstitutions(text);
          const blanked = blankSubstitutions(text);
          // flattenSubstitutions returns null ONLY on unbalanced openers —
          // the generator emits balanced spans, so it must parse.
          if (flat === null) return;
          expect(flat.bodies.length).toBe(expected);
          // The flattened text must contain no live opener the scanner saw.
          expect(scanSubstitutions(blanked, () => "").bodies.length).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a ' inside double quotes never opens single-quote mode (round-20 regression class)", () => {
    fc.assert(
      fc.property(QUOTED, fc.array(fc.oneof(SPAN, BACKTICK), { minLength: 1, maxLength: 4 }), (quoted, spans) => {
        // spans AFTER the quoted fragment: if the apostrophe leaked quote
        // state, the scanner would treat the following spans as inert and
        // the reference count would disagree.
        const text = `${quoted} ${spans.join(" ")}`;
        const flat = flattenSubstitutions(text);
        if (flat === null) return;
        expect(flat.bodies.length).toBe(spans.length);
        expect(scanSubstitutions(text, () => "").bodies.length).toBe(spans.length);
      }),
      { numRuns: 300 },
    );
  });

  it("analyzeCommandHead yields a single unquoted word with no redirect operators", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(HEAD, QUOTED, SPAN, fc.constant(" "), fc.constant("<<"), fc.constant("'EOF'"), fc.constant("2>/dev/null")), { minLength: 1, maxLength: 8 }),
        (fragments) => {
          const text = fragments.join(" ");
          const analyzed = analyzeCommandHead(text);
          if (analyzed === null) return;
          const { head } = analyzed;
          // The head is one WORD: no whitespace, no redirect operators (a
          // quote-state leak surfaces as whitespace in the head). A quote
          // CHARACTER inside the head is legitimate — it is the literal name
          // of a quoted word (`'a"a'` names the file `a"a`).
          expect(head).not.toMatch(/\s/);
          expect(head).not.toMatch(/[<>]/);
          expect(head.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("quoted heredoc bodies round-trip exactly and leave the opener line intact", () => {
    fc.assert(
      fc.property(
        fc.array(WORD, { minLength: 0, maxLength: 10 }),
        fc.constantFrom("EOF", "BODY", "PY"),
        (proseWords, delim) => {
          // "ZZ" cannot appear in the fixed scaffold (cat / echo done / the
          // delimiter vocabulary), so it is a reliable body marker.
          const prose = `ZZ${proseWords.join(" ") || "data"}ZZ`;
          const cmd = `cat << '${delim}'\n${prose}\n${delim}\necho done`;
          const split = splitHeredocs(cmd);
          expect(split.unparseable).toBe(false);
          // The quoted body is opaque data: it is stripped, not returned as a
          // script body; the opener line's non-heredoc text survives; the body
          // and the `<<` construct are gone.
          expect(split.bodies).toEqual([]);
          expect(split.stripped).not.toContain("ZZ");
          expect(split.stripped).not.toContain("<<");
          expect(split.stripped).toContain("cat");
          expect(split.stripped).toContain("echo done");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("inline-program heredocs are classified as script bodies (bash -c 'sh' class)", () => {
    // Pins the Phase-0 fix at the splitHeredocs level: the body of an
    // interpreter-fed heredoc MUST be returned as a script body so decide()
    // judges it as command text.
    const split = splitHeredocs(`bash -c 'sh' << 'BODY'\necho x > .claude/state/x\nBODY`);
    expect(split.bodies).toEqual(["echo x > .claude/state/x\n"]);
    const data = splitHeredocs(`bash -c 'echo hi' << 'EOF'\nprose\nEOF`);
    expect(data.bodies).toEqual([]); // quoted DATA body: opaque
  });
});

/**
 * The backtick that `findClosingParen` did not count as a quote.
 *
 * `hasOutputRedirect` (same module) and `stripComment` (machine/extract-evidence)
 * both treated a backtick as a quote opener; `findClosingParen` tracked only `"`
 * and `'`. So the `)` inside a backtick body nested in `$(…)` was read as the
 * OUTER substitution's close and the guard analysed a truncated body — the twin-
 * scanner divergence class this file's property net exists to catch, in the one
 * dimension no property covered. All three now share `core/shell-quoting`'s
 * `scanUnquoted`, so this pins the alphabet they share.
 */
describe("guard-state-file — backtick inside $( … )", () => {
  it("does not close a $(…) span at a ) inside a nested backtick body", () => {
    // The `)` in `a)b` belongs to the backtick body, so the substitution runs
    // to the FINAL `)` and its body is the whole `echo `a)b``.
    const scan = scanSubstitutions("$(echo `a)b`)", (body) => body);
    expect(scan.unclosed).toBe(false);
    expect(scan.bodies).toEqual(["echo `a)b`"]);
  });

  it("flattens such a command instead of failing closed on a phantom unclosed span", () => {
    expect(flattenSubstitutions("echo $(echo `a)b`)")).not.toBeNull();
  });

  it("still reports a genuinely unclosed substitution", () => {
    expect(flattenSubstitutions("echo $(echo `a)b`")).toBeNull();
  });

  it("keeps a guarded token inside a backtick-bearing body visible to the guard", () => {
    // The truncation was not fail-closed: a body cut short at the wrong `)`
    // hid whatever followed it, including the guarded path.
    const scan = scanSubstitutions("$(echo `x)y` .claude/state/active_task_graph.json)", (body) => body);
    expect(scan.unclosed).toBe(false);
    expect(scan.bodies[0]).toContain(".claude/state/active_task_graph.json");
  });
});
