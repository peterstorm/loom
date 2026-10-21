/**
 * The ONE quote-aware traversal of top-level command/process substitutions,
 * with the span closers it is built from. Pure: shared by the state-file
 * guard's matching views and recursive judging (`blankSubstitutions`,
 * `flattenSubstitutions`) and by test-evidence classification, so the guard
 * and the evidence ledger cannot disagree about where a substitution begins
 * and ends.
 */

import { CONTINUE, halt, scanUnquoted } from "./shell-quoting";

export interface SubstitutionScan {
  /** Substitution bodies, outermost-first (one nesting level). */
  readonly bodies: readonly string[];
  /** Text with each substitution replaced by `onBody(body)`. When `unclosed`,
   *  this holds everything BEFORE the offending opener — the opener onward is
   *  dropped (blank-to-end), which is maximal reveal for the matching view. */
  readonly rebuilt: string;
  /** An opener (`$(`, `<(`/`>(`, backtick) had no matching closer. */
  readonly unclosed: boolean;
}

/**
 * Quote state is tracked as `'"' | "'" | null`, NOT a lone single-quote flag:
 * a `'` inside double quotes (`"it's"`) is a literal apostrophe that must NOT
 * open a single-quoted region (the round-20 regression that disabled the whole
 * substitution defense after any double-quoted apostrophe). Command
 * substitution `$(…)` and backticks stay LIVE inside double quotes (bash still
 * performs them); process substitution `<(…)`/`>(…)` is a substitution only when
 * UNQUOTED (bash does not perform it inside double quotes), so it is treated
 * literally there. `onBody` maps each body to its replacement; the caller
 * decides the unclosed policy from `scan.unclosed`.
 *
 * The walker-divergence property net (tests/core/guard-state-file-walkers.test.ts)
 * pins its span decisions against an independent reference walker: a
 * regression in THIS quote state machine silently disables the guard's
 * substitution defense.
 */
/** What a caller may know about one substitution beyond its body text. */
export type SubstitutionContext = Readonly<{
  /** The exact output when the body is a `cat` quoted heredoc (`staticHeredocCat`), else null. */
  staticLiteral: string | null;
  /** The substitution is an entire double-quoted word — whitespace or the line
   *  edge before the opening `"`, and the closing `"` directly after `)` then
   *  whitespace, a separator or the line edge — so its output is one word with
   *  no adjacent text to join, and is neither word-split nor globbed. */
  wholeQuotedWord: boolean;
}>;

const WORD_EDGE_BEFORE = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const WORD_EDGE_AFTER = (c: string | undefined): boolean => c === undefined || /[\s;&|)]/.test(c);

export function scanSubstitutions(
  text: string,
  onBody: (body: string, context: SubstitutionContext) => string,
): SubstitutionScan {
  const bodies: string[] = [];
  let rebuilt = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      rebuilt += c;
      if (c === "'") quote = null; // inside '…': everything literal until the close
      continue;
    }
    if (c === "\\") { rebuilt += c + (text[i + 1] ?? ""); i++; continue; }
    // A `'` opens a single-quoted region ONLY when unquoted; inside `"…"` it is a
    // literal apostrophe (`"it's"`) and MUST NOT flip to single-quote mode — doing
    // so disabled every substitution after it (the round-20 regression). It falls
    // through to be appended literally while `$(…)`/backticks below stay live.
    if (c === "'" && quote === null) { quote = "'"; rebuilt += c; continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; rebuilt += c; continue; }
    const isCmdSub = c === "$" && text[i + 1] === "(";
    const isProcSub = quote === null && (c === "<" || c === ">") && text[i + 1] === "(";
    if (isCmdSub || isProcSub) {
      const close = findClosingParen(text, i + 2);
      if (close === -1) return { bodies, rebuilt, unclosed: true };
      const body = text.slice(i + 2, close);
      bodies.push(body);
      const wholeQuotedWord = isCmdSub && quote === '"' && text[i - 1] === '"' && WORD_EDGE_BEFORE(text[i - 2]) &&
        text[close + 1] === '"' && WORD_EDGE_AFTER(text[close + 2]);
      rebuilt += onBody(body, { staticLiteral: staticHeredocCat(text, i + 2)?.literal ?? null, wholeQuotedWord });
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close === -1) return { bodies, rebuilt, unclosed: true };
      const body = text.slice(i + 1, close);
      bodies.push(body);
      rebuilt += onBody(body, { staticLiteral: null, wholeQuotedWord: false });
      i = close;
      continue;
    }
    rebuilt += c;
  }
  return { bodies, rebuilt, unclosed: false };
}

/**
 * A substitution body that is exactly `cat` reading one QUOTED here-document
 * (`cat <<'D'` / `cat <<"D"` / `cat <<-'D'`, then the body, then the line `D`,
 * then only whitespace): bash performs no expansion in such a body, so the
 * substitution's output is exactly the literal body text. Recognized at the
 * position just past `$(`/`<(`/`>(`; returns the literal and the index of the
 * closing `)`, or null for any other shape (an unquoted delimiter, another
 * command, arguments or a pipe on the opener line, a missing terminator).
 * The body is data, so quote characters and parentheses inside it never
 * affect the span — which the generic quote-aware closer would get wrong.
 */
export function staticHeredocCat(command: string, start: number): Readonly<{ literal: string; close: number }> | null {
  const opener = /^[ \t]*cat[ \t]+<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\\\n$`]+)")[ \t]*\n/.exec(command.slice(start));
  if (opener === null) return null;
  const minus = opener[1] === "-";
  const delimiter = opener[2] ?? opener[3]!;
  const lines: string[] = [];
  let cursor = start + opener[0].length;
  while (cursor <= command.length) {
    const newline = command.indexOf("\n", cursor);
    const end = newline === -1 ? command.length : newline;
    const raw = command.slice(cursor, end);
    const line = minus ? raw.replace(/^\t+/, "") : raw;
    if (line === delimiter) {
      const after = /^[ \t\n]*\)/.exec(command.slice(end));
      return after === null ? null : { literal: lines.join("\n"), close: end + after[0].length - 1 };
    }
    if (newline === -1) return null; // no terminator line: not this shape
    lines.push(line);
    cursor = newline + 1;
  }
  return null;
}

/** Index of the `)` closing a substitution opened before `start`. Paren depth
 *  is counted quote-aware, and a BACKTICK body counts as quoted, so
 *  `` $(`a)b`) `` closes at the final `)`. A `cat` quoted-heredoc body
 *  (`staticHeredocCat`) is data and closes at its exact span. -1 when unclosed. */
export function findClosingParen(command: string, start: number): number {
  const heredoc = staticHeredocCat(command, start);
  if (heredoc !== null) return heredoc.close;
  let depth = 1;
  return scanUnquoted<number>(command, start, (c, i) => {
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return halt(i);
    }
    return CONTINUE;
  }) ?? -1;
}

/** Index of the backtick closing a body opened before `start` (backslash-
 *  escape aware). -1 when unclosed. */
export function findClosingBacktick(command: string, start: number): number {
  for (let i = start; i < command.length; i++) {
    if (command[i] === "\\") {
      i++;
      continue;
    }
    if (command[i] === "`") return i;
  }
  return -1;
}
