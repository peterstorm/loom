/**
 * Programmatic rule: no-nested-ternary
 *
 * One level of ternary is readable. A ternary whose else-branch is another
 * ternary is a decision tree wearing an expression's clothes: the reader has to
 * hold every prior condition to know what the arm they are looking at means,
 * and the diff of adding a case touches lines that have nothing to do with it.
 *
 * `rules/architecture.md` and the distill catalog both put the ceiling at one
 * level: beyond that, use `if` with early returns, or `match` when the branches
 * are a discriminated union.
 *
 * Detection is the multi-line shape a nested chain always takes once formatted:
 *
 *     cond1
 *       ? a
 *       : cond2          <- else-branch line
 *         ? b            <- immediately opens another ternary
 *         : c
 *
 * TYPE-LEVEL CONDITIONALS ARE NOT FLAGGED. `S extends X ? A : S extends Y ? B :
 * C` is the only way to write a mapped state→event relation in TypeScript's
 * type system — there is no `if` and no `match` at the type level, so the
 * chain is essential, not incidental. `core/wave-gate-machine.ts` uses one to
 * map each Wave Gate state to the events declared from it, and flagging that
 * would be telling the author to write something that does not exist.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";

const EXCLUDE_PATTERNS: readonly string[] = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"];

/**
 * An else-branch line: `: <something>`.
 *
 * Deliberately NOT an exclusion filter — it excludes neither `::` nor a type
 * annotation, and the comment that claimed it did described a pattern this one
 * is not. Type-level conditionals are filtered separately, by `TYPE_LEVEL`
 * below.
 */
const ELSE_BRANCH = /^\s*:\s*\S/;
/** A line that opens a ternary's then-branch. */
const THEN_BRANCH = /^\s*\?\s*\S/;
/** The tell of a type-level conditional rather than a value ternary. */
const TYPE_LEVEL = /\bextends\b/;

export function handler(content: string, filePath: string): readonly Violation[] {
  if (EXCLUDE_PATTERNS.some((pattern) => filePath.endsWith(pattern))) return [];
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1]!;
    const line = lines[index]!;
    if (!ELSE_BRANCH.test(previous) || !THEN_BRANCH.test(line)) continue;
    if (TYPE_LEVEL.test(previous) || TYPE_LEVEL.test(line)) continue;
    violations.push(makeViolation(
      "no-nested-ternary",
      filePath,
      index,
      previous.trim(),
      "this else-branch opens another ternary — use if with early returns, or match(...).exhaustive() for a discriminated union",
    ));
  }
  return Object.freeze(violations);
}
