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
 * and it is deliberately strict about what counts as proof:
 *
 *   match(x).with(…).exhaustive()        — proof
 *   switch with `default:` binding never  — proof (`const _: never = x`)
 *   switch with assertNever(x)            — proof
 *
 * A `default: throw new Error("unreachable")` is NOT proof: it compiles after a
 * new variant is added, which is exactly the drift being prevented.
 *
 * `switch (typeof raw)` is exempt — its domain is closed by the language, not
 * by a union type we own, so no variant can be added to it.
 *
 * Grandfathered sites live in `switch-totality-baseline.ts`, keyed by
 * `path::scrutinee` with multiplicity. A baselined switch costs nothing until
 * it is edited, a new switch must prove totality, and a baseline entry that no
 * longer matches is reported so the list shrinks instead of rotting.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";
import { isTestFile } from "./config";
import { SWITCH_TOTALITY_BASELINE } from "./switch-totality-baseline";
import { baselineCounter, baselineKey, unusedBaselineEntries, type Baseline } from "./baseline";

export { baselineKey, unusedBaselineEntries };

export const RULE_NAME = "switch-totality";

/** Branches below this read as a local guard, not a union pattern-match. */
export const DEFAULT_MIN_SWITCH_ARMS = 2;

/** Modules whose switches must prove totality. The pure core and the machine
 *  core hold the closed unions; the shell's CLI switches are ordinary control
 *  flow over flags and would be noise. */
export const DEFAULT_SWITCH_TOTALITY_MODULES: readonly string[] = [
  "engine/src/core/",
  "engine/src/machine/",
];

const SWITCH_HEAD = /^\s*switch\s*\(\s*(.+?)\s*\)\s*\{/;
/**
 * Split a switch body into its arms. Text BEFORE the first arm (`{`) and after
 * the last belongs to the surrounding arm, so the split never loses it — the
 * default arm's body is whatever follows `default:`.
 */
const ARM_SPLIT = /(?=\bcase\s+["'`])|(?=\bdefault\s*:)/;
const IS_CASE_ARM = /^\bcase\s+["'`]/;
const IS_DEFAULT_ARM = /^\bdefault\s*:/;
/** A proof a switch arm carries: a never binding or an assertNever call. */
const NEVER_PROOF = /:\s*never\b|\bassertNever\s*\(/;
/** A nested ts-pattern match proves that match, not the surrounding switch. */
const EXHAUSTIVE_PROOF = /\.exhaustive\s*\(\s*\)/;

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

/** Strip quoted text and a trailing line comment before counting braces. */
function structural(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && line[index + 1] === "/") break;
    out += char;
  }
  return out;
}

/** How the rule learns which sites are grandfathered: exact `path::scrutinee`
 *  keys, each suppressing one violation. */
export type SwitchTotalityBaseline = Baseline;

/**
 * One switch's span: the case count, whether a default arm exists, whether the
 * default arm's body proves never, and whether a nested match is exhaustive.
 */
type SwitchSpan = Readonly<{
  arms: number;
  hasDefault: boolean;
  neverProof: boolean;
  exhaustiveProof: boolean;
}>;

/**
 * Read the switch opened on `startLine` to its closing brace. Line-based with
 * brace depth — the same granularity as the rest of this linter — and braces
 * inside strings or line comments do not count.
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
  let exhaustiveProof = false;

  for (let index = startLine; index < lines.length; index++) {
    const line = lines[index]!;
    const raw = withoutComment(line);
    const structure = structural(line);
    // The opening line's body starts AFTER its `switch (…) {`; later lines are
    // body already.
    const body = index === startLine ? raw.slice(raw.indexOf("{") + 1) : raw;
    for (const part of body.split(ARM_SPLIT)) {
      if (part === "") continue;
      if (IS_DEFAULT_ARM.test(part)) {
        hasDefault = true;
        inDefault = true;
        defaultText += part;
      } else if (IS_CASE_ARM.test(part)) {
        arms++;
        inDefault = false;
      } else if (inDefault) {
        defaultText += part;
      }
    }
    if (EXHAUSTIVE_PROOF.test(body)) exhaustiveProof = true;
    for (const char of structure) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
    }
    if (depth === 0) break;
  }
  // Only the DEFAULT arm may prove never; a `: never` in a case arm is a value
  // annotation that says nothing about the union's coverage.
  return { arms, hasDefault, neverProof: hasDefault && NEVER_PROOF.test(defaultText), exhaustiveProof };
}

const inScope = (filePath: string, modules: readonly string[]): boolean =>
  modules.some((module) => filePath.includes(module));

/**
 * Normalize a path to the same repo-relative form the baseline keys use.
 *
 * Anchors on each module scope's first two segments (`engine/src/…`) rather
 * than reusing `toRepositoryRelative`, which anchors on the IMPORT BOUNDARY
 * table — and `engine/src/machine/` is not an import boundary, so an absolute
 * path there stayed absolute and its baseline entry silently stopped matching.
 * A grandfathered list that quietly stops applying is worse than no list: the
 * site looks baselined in review and fails in CI.
 */
const repoRelative = (filePath: string, modules: readonly string[]): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) return normalized;
  for (const module of modules) {
    const anchor = `${module.split("/").slice(0, 2).join("/")}/`;
    const at = normalized.lastIndexOf(`/${anchor}`);
    if (at !== -1) return normalized.slice(at + 1);
  }
  return normalized;
};

export function handler(
  content: string,
  filePath: string,
  modules: readonly string[] = DEFAULT_SWITCH_TOTALITY_MODULES,
  baseline: SwitchTotalityBaseline = SWITCH_TOTALITY_BASELINE,
  minArms: number = DEFAULT_MIN_SWITCH_ARMS,
): readonly Violation[] {
  // lintFile hands rules an ABSOLUTE path; baseline keys and module prefixes are
  // repo-relative. Normalize once so a baselined site stays baselined wherever
  // the checkout lives.
  const relative = repoRelative(filePath, modules);
  if (isTestFile(relative)) return [];
  if (!inScope(relative, modules)) return [];

  const lines = content.split("\n");
  const baselineEntries = baselineCounter(baseline);

  const violations: Violation[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const head = SWITCH_HEAD.exec(line);
    if (head === null) continue;
    const scrutinee = head[1]!;
    if (LANGUAGE_CLOSED.test(scrutinee)) continue;
    const span = switchSpan(lines, index);
    if (span.arms < minArms) continue;
    // A nested match's `.exhaustive()` proves the match, not the switch: only an
    // arm-level never proof or a total match over the SAME scrutinee would, and
    // line-based analysis cannot see the receiver. Accept it file-locally as the
    // companion if-chain rule does, and say so.
    if (span.neverProof || span.exhaustiveProof) continue;

    const key = baselineKey(relative, scrutinee);
    if (baselineEntries.consume(key)) continue;
    violations.push(
      makeViolation(
        RULE_NAME,
        filePath,
        index + 1,
        line.trim(),
        `switch on \`${scrutinee}\` has ${span.arms} literal arms and no totality proof — use match(${scrutinee}).with(…).exhaustive(), or a default arm that binds it to \`never\`, so a new variant is a compile error`,
      ),
    );
  }
  return Object.freeze(violations);
}

/** Every switch key in a file that the rule would consider — the input of the
 *  staleness pass. */
export function detectedSwitchKeys(content: string, filePath: string): readonly string[] {
  const lines = content.split("\n");
  const keys: string[] = [];
  for (const line of lines) {
    const head = SWITCH_HEAD.exec(line);
    if (head === null || LANGUAGE_CLOSED.test(head[1]!)) continue;
    keys.push(baselineKey(filePath.replace(/\\/g, "/"), head[1]!));
  }
  return keys;
}
