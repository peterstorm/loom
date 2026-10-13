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
export function scanSubstitutions(text: string, onBody: (body: string) => string): SubstitutionScan {
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
      rebuilt += onBody(body);
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close === -1) return { bodies, rebuilt, unclosed: true };
      const body = text.slice(i + 1, close);
      bodies.push(body);
      rebuilt += onBody(body);
      i = close;
      continue;
    }
    rebuilt += c;
  }
  return { bodies, rebuilt, unclosed: false };
}

/** Index of the `)` closing a substitution opened before `start`. Paren depth
 *  is counted quote-aware, and a BACKTICK body counts as quoted, so
 *  `` $(`a)b`) `` closes at the final `)`. -1 when unclosed. */
export function findClosingParen(command: string, start: number): number {
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
