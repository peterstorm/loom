/**
 * Programmatic rule: prefer-array-methods
 *
 * Flags the ACCUMULATOR LOOP — a mutable array declared immediately before a
 * loop whose body does nothing but push into it:
 *
 *     const names: string[] = [];
 *     for (const user of users) {
 *       names.push(user.name);          // -> users.map(u => u.name)
 *     }
 *
 *     const active = [];
 *     for (const user of users) {
 *       if (user.active) active.push(user);   // -> users.filter(u => u.active)
 *     }
 *
 * This shape is `map`/`filter`/`flatMap` written with a mutable binding and an
 * extra scope. Rewriting removes the mutation and the binding, which is why
 * `rules/architecture.md` puts immutability first — not because the loop is
 * longer.
 *
 * WHAT THIS DOES NOT FLAG, deliberately:
 *
 * The distill catalog's phrasing is the specification here — replace a loop
 * with the named operation "only when it removes state, not when the loop is
 * genuinely clearer". So the rule fires only on the narrow shape above. A loop
 * that does any of the following is left alone, because the array methods
 * either cannot express it or express it worse:
 *
 *   - `break` / `continue` / `return` — early exit; `some`/`find` may fit, but
 *     the transformation is not mechanical and the loop is not merely an
 *     accumulator
 *   - `await` / `yield` — sequential asynchrony is a real choice, and `map` over
 *     an async function changes it to concurrent; a generator body has no
 *     array-method equivalent at all
 *   - more than one statement, or pushes into more than one array — that is a
 *     fold, and spelling it `reduce` is frequently HARDER to read; the catalog
 *     says the named operation must clarify, not merely exist
 *   - `for (let i = 0; …)` over indices used for anything but element access
 *
 * The bar is: a mechanical rewrite exists AND it deletes a mutable binding.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";
import { isTestFile } from "./config";

/** `const xs: T[] = [];` / `const xs = [];` / `let xs: T[] = []` */
const ACCUMULATOR_DECL = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[\s*\]\s*;?\s*$/;
/** `for (const x of xs) {` — the only loop form this rule considers. */
const FOR_OF_OPEN = /^\s*for\s*\(\s*(?:const|let)\s+[^)]+\s+of\s+[^)]+\)\s*\{\s*$/;
/** A single push into the accumulator, optionally guarded by a one-line `if`. */
const pushInto = (name: string): RegExp =>
  new RegExp(`^\\s*(?:if\\s*\\(.+\\)\\s*)?${name}\\.push\\(.+\\)\\s*;?\\s*$`);
/** Constructs that make the rewrite non-mechanical. */
const DISQUALIFYING = /\b(?:break|continue|return|await|yield)\b/;

export function handler(content: string, filePath: string): readonly Violation[] {
  if (isTestFile(filePath)) return [];
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let index = 0; index < lines.length - 2; index++) {
    const declaration = ACCUMULATOR_DECL.exec(lines[index]!);
    if (declaration === null) continue;
    const accumulator = declaration[1]!;
    if (!FOR_OF_OPEN.test(lines[index + 1]!)) continue;

    // Collect the body up to its closing brace at the loop's indentation.
    const indent = /^\s*/.exec(lines[index + 1]!)![0];
    const body: string[] = [];
    let closed = false;
    for (let cursor = index + 2; cursor < lines.length; cursor++) {
      const line = lines[cursor]!;
      if (line === `${indent}}`) { closed = true; break; }
      body.push(line);
      if (body.length > 3) break;
    }
    if (!closed || body.length === 0) continue;
    if (body.some((line) => DISQUALIFYING.test(line))) continue;
    if (body.length !== 1 || !pushInto(accumulator).test(body[0]!)) continue;

    violations.push(makeViolation(
      "prefer-array-methods",
      filePath,
      index + 1,
      lines[index]!.trim(),
      `\`${accumulator}\` is only pushed into — use map/filter/flatMap and delete the mutable binding`,
    ));
  }
  return Object.freeze(violations);
}
