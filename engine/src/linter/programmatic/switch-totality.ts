/**
 * Programmatic rule: switch-totality
 *
 * `switch (x.kind) { case "a": … case "b": … }` over a discriminated union is a
 * pattern match the compiler only half-checks. A switch with every arm listed
 * and a declared return type *does* fail to compile when a variant is added —
 * but only where every arm returns; a switch that assigns, pushes, or falls
 * through, or whose scrutinee is `unknown`/`string` (the wire-parsing case),
 * compiles happily and silently stops covering the new variant.
 *
 * The companion rule `exhaustive-discriminant-branching` catches the same
 * omission written as an if/else chain. This rule is its switch-statement half,
 * and it is deliberately strict about what counts as proof — and WHERE:
 *
 *   default arm binding never            — proof (`const _: never = x`)
 *   default arm calling assertNever(x)   — proof
 *   default arm delegating to a match    — proof (`default: return match(x)…exhaustive()`)
 *
 * Only the DEFAULT arm can prove the switch total: it is the arm a new variant
 * would land in. A `.exhaustive()` inside a `case` arm proves that nested
 * match, never the switch around it — accepting it anywhere in the span was the
 * fail-open hole this rule's first version shipped with.
 *
 * A `default: throw new Error("unreachable")` is NOT proof: it compiles after a
 * new variant is added, which is exactly the drift being prevented.
 *
 * An OPEN domain — a `string` command name, a status code — has no `never` to
 * bind. Its shape is `match(raw).with("a", …).with("b", …).otherwise(…)`: the
 * fallback is then a visible decision in ts-pattern rather than a `default:`
 * that reads the same whether or not a union grew under it. That is
 * `rules/typescript-patterns.md`'s "use ts-pattern instead of switch", made a
 * check instead of a sentence.
 *
 * `switch (typeof raw)` is exempt — its domain is closed by the language, not
 * by a union type we own, so no variant can be added to it.
 *
 * SCOPE: every non-test TypeScript file, by default, in every project — this is
 * a rule about TypeScript, not about one repository's layout. A project may
 * narrow it with `switchTotalityModules`; it may not empty it (disable the rule
 * by name instead, which is visible as a disabled rule rather than as a scope
 * that matches nothing). Pre-existing sites are grandfathered per project in
 * `switchTotalityBaseline`, keyed by `path::scrutinee` with multiplicity: a
 * baselined switch costs nothing until it is edited, a new switch must prove
 * totality, and an entry that no longer matches is reported so the list
 * shrinks instead of rotting.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";
import { isTestFile } from "./config";
import { baselineCounter, baselineKey, projectRelative, type Baseline } from "./baseline";

export const RULE_NAME = "switch-totality";

/** Branches below this read as a local guard, not a union pattern-match. */
export const DEFAULT_MIN_SWITCH_ARMS = 2;

/** Which files the rule governs. `everywhere` is the default; `modules` is a
 *  project's own narrowing, and is never empty. */
export type SwitchScope =
  | Readonly<{ kind: "everywhere" }>
  | Readonly<{ kind: "modules"; prefixes: readonly [string, ...string[]] }>;

export const EVERYWHERE: SwitchScope = Object.freeze({ kind: "everywhere" });

export type SwitchTotalityOptions = Readonly<{
  scope: SwitchScope;
  baseline: Baseline;
  minArms: number;
  /** The root of the project whose config supplied `scope` and `baseline` —
   *  the frame both are written in. Null when no project config is in play. */
  projectRoot: string | null;
}>;

export const DEFAULT_SWITCH_TOTALITY_OPTIONS: SwitchTotalityOptions = Object.freeze({
  scope: EVERYWHERE,
  baseline: Object.freeze([]),
  minArms: DEFAULT_MIN_SWITCH_ARMS,
  projectRoot: null,
});

const SWITCH_HEAD = /^\s*switch\s*\(\s*(.+?)\s*\)\s*\{/;
/**
 * One arm label, matched anywhere in a line so a one-line switch is measured
 * like any other: a quoted literal (`case "a":`), a qualified enum member
 * (`case Kind.Draft:`), or `default:`. A qualified member is a union variant
 * exactly like a string literal is — reading only quoted literals let every
 * `enum` switch through unmeasured.
 */
const ARM_TOKEN = /(?:\bcase\s+(?:["'`]|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*:))|(?:\bdefault\s*:)/g;
const IS_DEFAULT_ARM = /^\bdefault\s*:/;
/** The text before a `{` that makes it the body of a NESTED switch. */
const OPENS_NESTED_SWITCH = /\bswitch\s*\([^{]*\)\s*$/;
/** A proof the default arm carries: a never binding, an assertNever call, or a
 *  delegation to an exhaustive ts-pattern match. */
const DEFAULT_ARM_PROOF = /:\s*never\b|\bassertNever\s*\(|\.exhaustive\s*\(\s*\)/;

/** Scrutinees whose domain the language closes, so no union variant can drift. */
const LANGUAGE_CLOSED = /^typeof\b/;

/** Drop a trailing line comment, KEEPING quoted text: arm detection needs the
 *  case literals, which the brace scanner strips. */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "/" && line[index + 1] === "/") return line.slice(0, index);
  }
  return line;
}

/** One switch's span: its arm count and whether its default arm proves never. */
type SwitchSpan = Readonly<{
  arms: number;
  proven: boolean;
}>;

/** One line of a switch body, scanned character by character. */
type LineScan = Readonly<{
  /** The depth BEFORE each character. */
  depthAt: readonly number[];
  /** How many nested switch bodies are open before each character. */
  nestedAt: readonly number[];
  /** The depth after the line's last character. */
  endDepth: number;
  /** Characters belonging to the default arm's own body, when inside it. */
  defaultText: string;
}>;

/** Scan one comment-stripped line from `depth`. Quoted text never changes depth. */
function scanSwitchLine(raw: string, depth: number, inDefault: boolean): LineScan {
  const depthAt: number[] = [];
  const nestedAt: number[] = [];
  const nestedBodies: number[] = [];
  let level = depth;
  let quote: string | null = null;
  let defaultText = "";
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    depthAt[at] = level;
    nestedAt[at] = nestedBodies.length;
    if (quote !== null) {
      if (char === "\\") { depthAt[at + 1] = level; nestedAt[at + 1] = nestedBodies.length; at++; }
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      // A switch opened INSIDE the enclosing body is nested; the enclosing
      // switch's own `{` sits at depth 0 and names nothing.
      if (level >= 1 && OPENS_NESTED_SWITCH.test(raw.slice(0, at))) nestedBodies.push(level + 1);
      level++;
    } else if (char === "}") {
      if (nestedBodies.at(-1) === level) nestedBodies.pop();
      level--;
    }
    // The default arm's own body, at any depth, but never inside a nested
    // switch: that switch's `never` binding proves the nested switch.
    if (inDefault && nestedBodies.length === 0 && level >= 1) defaultText += char;
  }
  return { depthAt, nestedAt, endDepth: level, defaultText };
}

/**
 * Read the switch opened on `startLine` to its closing brace. Line-based with
 * brace depth — the same granularity as the rest of this linter — and braces
 * inside strings or line comments do not count.
 *
 * ONLY the enclosing switch's own arms count. The first version counted every
 * `case`/`default` in the span, so a nested switch's arms inflated the arm
 * count and — worse — a nested `default:` made the OUTER switch read as having
 * a default arm, which is the fail-open direction: an outer switch with no
 * proof was accepted because some inner switch had a default. Arms are therefore
 * matched only at the switch body's own depth (1) and outside any nested switch
 * body. The default arm's BODY is still read at any depth, because the proof
 * this rule accepts is usually written as `default: { const unhandled: never = x; }`.
 *
 * Arms are counted from the switch BODY, not from the start of each line, so a
 * switch written on one line (`switch (x.kind) { case "a": …; case "b": … }`)
 * is measured like any other. Treating only line-initial `case` as an arm made
 * every one-line switch invisible — the detector saw no arms and skipped it.
 */
function switchSpan(lines: readonly string[], startLine: number): SwitchSpan {
  let depth = 0;
  let arms = 0;
  let hasDefault = false;
  let inDefault = false;
  let defaultText = "";

  for (let index = startLine; index < lines.length; index++) {
    const raw = withoutComment(lines[index]!);
    const { depthAt, nestedAt, endDepth, defaultText: lineDefaultText } = scanSwitchLine(raw, depth, inDefault);
    defaultText += lineDefaultText;

    ARM_TOKEN.lastIndex = 0;
    for (let token = ARM_TOKEN.exec(raw); token !== null; token = ARM_TOKEN.exec(raw)) {
      if (depthAt[token.index] !== 1 || nestedAt[token.index] !== 0) continue;
      if (IS_DEFAULT_ARM.test(token[0])) {
        hasDefault = true;
        inDefault = true;
      } else {
        arms++;
        inDefault = false;
      }
    }
    depth = endDepth;
    if (depth === 0) break;
  }
  // Only the DEFAULT arm may prove the switch: a `: never` or an `.exhaustive()`
  // in a case arm is about that arm's own value, not about the union's coverage.
  return { arms, proven: hasDefault && DEFAULT_ARM_PROOF.test(defaultText) };
}

const inScope = (relativePath: string, scope: SwitchScope): boolean => {
  switch (scope.kind) {
    case "everywhere":
      return true;
    case "modules":
      return scope.prefixes.some((prefix) => relativePath.includes(prefix));
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
};

/** A switch this rule flags absent a baseline: in scope, with enough arms to be
 *  a union match, and no totality proof. */
type UnprovenSwitch = Readonly<{
  /** 1-based line of the `switch` head. */
  line: number;
  scrutinee: string;
  arms: number;
  /** `path::scrutinee`, the form a baseline entry is written in. */
  key: string;
}>;

/**
 * The rule's ONE analysis of a file. `handler` spends baseline entries against
 * these sites and reports the rest; `detectedSwitchKeys` hands the same sites to
 * the staleness pass. Two traversals were how the detector came to see EVERY
 * switch — proven, one-armed, out of scope — so a baselined switch later made
 * total still "consumed" its entry and the debt never showed as paid.
 */
function unprovenSwitches(
  content: string,
  filePath: string,
  options: SwitchTotalityOptions,
): readonly UnprovenSwitch[] {
  const relative = projectRelative(filePath, options.projectRoot);
  if (isTestFile(relative) || !inScope(relative, options.scope)) return [];

  const lines = content.split("\n");
  return Object.freeze(lines.flatMap((line, index): readonly UnprovenSwitch[] => {
    const head = SWITCH_HEAD.exec(line);
    if (head === null) return [];
    const scrutinee = head[1]!;
    if (LANGUAGE_CLOSED.test(scrutinee)) return [];
    const span = switchSpan(lines, index);
    if (span.arms < options.minArms || span.proven) return [];
    return [{ line: index + 1, scrutinee, arms: span.arms, key: baselineKey(relative, scrutinee) }];
  }));
}

export function handler(
  content: string,
  filePath: string,
  options: SwitchTotalityOptions = DEFAULT_SWITCH_TOTALITY_OPTIONS,
): readonly Violation[] {
  const lines = content.split("\n");
  const baselineEntries = baselineCounter(options.baseline);
  return Object.freeze(unprovenSwitches(content, filePath, options)
    .filter((site) => !baselineEntries.consume(site.key))
    .map((site) => makeViolation(
      RULE_NAME,
      filePath,
      site.line,
      lines[site.line - 1]!.trim(),
      `switch on \`${site.scrutinee}\` has ${site.arms} arms and no totality proof — use match(${site.scrutinee}).with(…).exhaustive() (or .otherwise(…) when the domain is open, like a plain string), or a default arm that binds it to \`never\`, so a new variant is a compile error`,
    )));
}

/** The baseline keys of every switch the rule would flag absent its baseline —
 *  the input of the staleness pass and of `lint-project --write-baseline`. A
 *  baselined switch converted to a proof drops out of this list, so its entry
 *  is reported unused. */
export function detectedSwitchKeys(
  content: string,
  filePath: string,
  options: SwitchTotalityOptions = DEFAULT_SWITCH_TOTALITY_OPTIONS,
): readonly string[] {
  return unprovenSwitches(content, filePath, options).map((site) => site.key);
}
