/**
 * The three style rules added to make the architecture rules enforceable
 * rather than aspirational. Each test pins BOTH directions: the shape the rule
 * exists to catch, and the shapes it must leave alone — a rule that fires on
 * correct code gets disabled, which is worse than not having it.
 */
import { describe, expect, it } from "vitest";
import { handler as exhaustive } from "../../../src/linter/programmatic/exhaustive-discriminant-branching";
import { handler as nestedTernary } from "../../../src/linter/programmatic/no-nested-ternary";
import { handler as preferArrayMethods } from "../../../src/linter/programmatic/prefer-array-methods";

const FILE = "engine/src/core/example.ts";

describe("exhaustive-discriminant-branching", () => {
  it("flags a chain of three branches on one discriminant", () => {
    const source = [
      `function describe(event: Event): string {`,
      `  if (event.kind === "a") return "a";`,
      `  if (event.kind === "b") return "b";`,
      `  if (event.kind === "c") return "c";`,
      `  return "?";`,
      `}`,
    ].join("\n");
    const violations = exhaustive(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.fixHint).toContain("event.kind");
  });

  it("leaves one- and two-branch guard clauses alone", () => {
    const source = [
      `function describe(event: Event): string {`,
      `  if (event.kind === "a") return "a";`,
      `  if (event.kind === "b") return "b";`,
      `  return fallback(event);`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE)).toEqual([]);
  });

  it("accepts a `never` binding as proof of totality", () => {
    const source = [
      `function describe(event: Event): string {`,
      `  if (event.kind === "a") return "a";`,
      `  if (event.kind === "b") return "b";`,
      `  if (event.kind === "c") return "c";`,
      `  const exhaustiveCheck: never = event;`,
      `  return exhaustiveCheck;`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE)).toEqual([]);
  });

  it("accepts .exhaustive() as proof of totality", () => {
    const source = [
      `const out = match(event)`,
      `  .with({ kind: "a" }, () => 1)`,
      `  .exhaustive();`,
      `if (other.kind === "a") return 1;`,
      `if (other.kind === "b") return 2;`,
      `if (other.kind === "c") return 3;`,
    ].join("\n");
    expect(exhaustive(source, FILE)).toEqual([]);
  });

  it("does not merge distant guards on the same tag into a phantom chain", () => {
    const source = [
      `if (task.status === "completed") throw new Error("done");`,
      ...Array.from({ length: 40 }, (_, i) => `const filler${i} = ${i};`),
      `if (task.status === "failed") throw new Error("failed");`,
      ...Array.from({ length: 40 }, (_, i) => `const more${i} = ${i};`),
      `if (task.status === "pending") throw new Error("pending");`,
    ].join("\n");
    expect(exhaustive(source, FILE)).toEqual([]);
  });

  it("ignores test files", () => {
    const source = [
      `if (event.kind === "a") return "a";`,
      `if (event.kind === "b") return "b";`,
      `if (event.kind === "c") return "c";`,
    ].join("\n");
    expect(exhaustive(source, "engine/tests/example.test.ts")).toEqual([]);
  });
});

describe("no-nested-ternary", () => {
  it("flags an else-branch that opens another ternary", () => {
    const source = [
      `const label = first`,
      `  ? "one"`,
      `  : second`,
      `    ? "two"`,
      `    : "three";`,
    ].join("\n");
    expect(nestedTernary(source, FILE)).toHaveLength(1);
  });

  it("leaves a single-level ternary alone", () => {
    const source = [`const label = first`, `  ? "one"`, `  : "two";`].join("\n");
    expect(nestedTernary(source, FILE)).toEqual([]);
  });

  it("exempts type-level conditionals, which have no if or match", () => {
    const source = [
      `type EventFor<S> = S extends { kind: "a" }`,
      `  ? AEvent`,
      `  : S extends { kind: "b" }`,
      `    ? BEvent`,
      `    : never;`,
    ].join("\n");
    expect(nestedTernary(source, FILE)).toEqual([]);
  });
});

describe("prefer-array-methods", () => {
  it("flags an accumulator whose loop only pushes into it", () => {
    const source = [
      `const names: string[] = [];`,
      `for (const user of users) {`,
      `  names.push(user.name);`,
      `}`,
    ].join("\n");
    const violations = preferArrayMethods(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.fixHint).toContain("names");
  });

  it("flags a guarded push, which is a filter", () => {
    const source = [
      `const active = [];`,
      `for (const user of users) {`,
      `  if (user.active) active.push(user);`,
      `}`,
    ].join("\n");
    expect(preferArrayMethods(source, FILE)).toHaveLength(1);
  });

  it("leaves loops with early exit alone — the rewrite is not mechanical", () => {
    const source = [
      `const names: string[] = [];`,
      `for (const user of users) {`,
      `  if (user.blocked) break;`,
      `  names.push(user.name);`,
      `}`,
    ].join("\n");
    expect(preferArrayMethods(source, FILE)).toEqual([]);
  });

  it("leaves sequential await alone — map would make it concurrent", () => {
    const source = [
      `const names: string[] = [];`,
      `for (const user of users) {`,
      `  names.push(await resolve(user));`,
      `}`,
    ].join("\n");
    expect(preferArrayMethods(source, FILE)).toEqual([]);
  });

  it("leaves multi-statement bodies alone — that is a fold, not a map", () => {
    const source = [
      `const names: string[] = [];`,
      `for (const user of users) {`,
      `  const name = normalize(user.name);`,
      `  names.push(name);`,
      `}`,
    ].join("\n");
    expect(preferArrayMethods(source, FILE)).toEqual([]);
  });
});

describe("exhaustive-discriminant-branching — chain vs standalone guards", () => {
  it("does not treat sibling functions guarding the same field as one chain", () => {
    // Three adapter methods that each check connection state before acting.
    // Same discriminant, close together, but three separate functions — this
    // shape was the rule's first false positive.
    const source = [
      `const port = {`,
      `  setUser: async (u) => {`,
      `    if (client.status === "wait") await client.connect();`,
      `    return ok(undefined);`,
      `  },`,
      `  delUser: async (u) => {`,
      `    if (client.status === "wait") await client.connect();`,
      `    return ok(undefined);`,
      `  },`,
      `  xAdd: async (k) => {`,
      `    if (client.status === "wait") await client.connect();`,
      `    return ok(undefined);`,
      `  },`,
      `};`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toEqual([]);
  });

  // The case above uses a CALL body. The guard shape people actually write
  // exits on the same line, and for that shape the false positive survived the
  // first fix: `return`/`throw`/`continue`/`break` anywhere on the line counted
  // as chain evidence, with nothing asking whether the guards were even in the
  // same scope. One case per exit keyword — each is a separate alternative in
  // the regex, and a fix that only covers `return` is not a fix.
  it("does not treat sibling functions whose guards RETURN as one chain", () => {
    const source = [
      `const port = {`,
      `  setUser: async (u) => {`,
      `    if (client.status === "wait") return null;`,
      `    return ok(undefined);`,
      `  },`,
      `  delUser: async (u) => {`,
      `    if (client.status === "wait") return null;`,
      `    return ok(undefined);`,
      `  },`,
      `  xAdd: async (k) => {`,
      `    if (client.status === "wait") return null;`,
      `    return ok(undefined);`,
      `  },`,
      `};`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toEqual([]);
  });

  it("does not treat sibling functions whose guards THROW as one chain", () => {
    const source = [
      `function a(x) {`,
      `  if (x.kind === "bad") throw new Error("a");`,
      `}`,
      `function b(x) {`,
      `  if (x.kind === "bad") throw new Error("b");`,
      `}`,
      `function c(x) {`,
      `  if (x.kind === "bad") throw new Error("c");`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toEqual([]);
  });

  it("does not treat sibling loops whose guards CONTINUE as one chain", () => {
    const source = [
      `for (const a of xs) {`,
      `  if (a.status === "skip") continue;`,
      `}`,
      `for (const b of ys) {`,
      `  if (b.status === "skip") continue;`,
      `}`,
      `for (const c of zs) {`,
      `  if (c.status === "skip") continue;`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toEqual([]);
  });

  // Chain evidence is read from the branch BODY. Reading the whole line also
  // read the CONDITION, so a discriminant literal that merely CONTAINS an exit
  // keyword was chain evidence on a guard that exits nowhere.
  it("does not read an exit keyword inside a discriminant literal as chain evidence", () => {
    const source = [
      `function f(mode) {`,
      `  if (mode.kind === "break-glass") apply();`,
      `  if (mode.kind === "continue-later") defer();`,
      `  if (mode.kind === "normal") run();`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toEqual([]);
  });

  it("still flags an else-if chain", () => {
    const source = [
      `if (result.kind === "updated") {`,
      `  onComplete();`,
      `} else if (result.kind === "no-change") {`,
      `  onNoChange();`,
      `} else if (result.kind === "error") {`,
      `  onError();`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toHaveLength(1);
  });

  // The scope rule must not buy its way out of the false positives by going
  // blind: a chain nested inside a function is still a chain, and `} else if`
  // sits at the SAME indentation as the branch it continues rather than
  // undercutting it.
  it("still flags an else-if chain nested inside a function", () => {
    const source = [
      `function f(r) {`,
      `  if (r.kind === "a") {`,
      `    a();`,
      `  } else if (r.kind === "b") {`,
      `    b();`,
      `  } else if (r.kind === "c") {`,
      `    c();`,
      `  }`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toHaveLength(1);
  });

  // A fall-through row of same-line returns IS a switch when the branches share
  // one scope — the shape the rule was written for. Distinguishing it from the
  // sibling-guard cases above is the whole point of the scope rule.
  it("still flags a fall-through chain of same-line returns in one function", () => {
    const source = [
      `function classify(x) {`,
      `  if (x.kind === "a") return 1;`,
      `  if (x.kind === "b") return 2;`,
      `  if (x.kind === "c") return 3;`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, "engine/src/core/example.ts")).toHaveLength(1);
  });
});

/**
 * `branchBody`'s condition scan, and the limits of `discriminantOf` around it
 * (round-41 A3).
 *
 * `branchBody`'s doc comment claims it "scans with paren depth and skips quoted
 * text, so neither a `)` inside a string literal nor a nested call ends the
 * condition early" — a claim no test exercised. Where the condition ends decides
 * whether a branch has a same-line exit, which is the evidence that separates a
 * real switch from a row of sibling guards.
 *
 * The quoted-text cases are written so the verdict FLIPS if quote skipping
 * regresses: the literal holds a `)` with an exit keyword AFTER it, so a scan
 * that stopped at the literal's paren would read "return" out of the string and
 * invent chain evidence that is not there.
 */
describe("exhaustive-discriminant-branching — condition scanning", () => {
  const FILE_UNDER_TEST = "engine/src/core/example.ts";

  it("does not read an exit keyword out of a double-quoted literal holding a paren", () => {
    // Correct scan: the condition closes at the REAL paren, so each body is
    // ` apply();` — no exit, no chain evidence, no violation. A scan that
    // stopped at the literal's `)` would see `return") apply();` and flag.
    const source = [
      `function f(mode) {`,
      `  if (mode.kind === "a)return") apply();`,
      `  if (mode.kind === "b)return") defer();`,
      `  if (mode.kind === "c)return") run();`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE_UNDER_TEST)).toEqual([]);
  });

  it("does the same for a single-quoted literal", () => {
    const source = [
      `function f(mode) {`,
      `  if (mode.kind === 'a)return') apply();`,
      `  if (mode.kind === 'b)return') defer();`,
      `  if (mode.kind === 'c)return') run();`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE_UNDER_TEST)).toEqual([]);
  });

  it("a same-line body after a nested call in the condition is still found", () => {
    // `allow(x)`'s closing paren is not the condition's: depth tracking has to
    // carry past it for ` return 1;` to read as the branch body.
    const source = [
      `function classify(x) {`,
      `  if (x.kind === "a" && allow(x)) return 1;`,
      `  if (x.kind === "b" && allow(x)) return 2;`,
      `  if (x.kind === "c" && allow(x)) return 3;`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE_UNDER_TEST)).toHaveLength(1);
  });

  it("a multi-line condition has no same-line body, so the run is not a chain", () => {
    // The condition never closes on its own line — `branchBody` returns "" and
    // the branch cannot contribute a same-line exit.
    const source = [
      `function classify(x) {`,
      `  if (`,
      `    x.kind === "a"`,
      `  ) return 1;`,
      `  if (`,
      `    x.kind === "b"`,
      `  ) return 2;`,
      `  if (`,
      `    x.kind === "c"`,
      `  ) return 3;`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE_UNDER_TEST)).toHaveLength(0);
  });

  /**
   * Documented LIMITS of `discriminantOf`, which gates every case above: it
   * recognises only `<expr>.<tag> === "quoted-literal"`. Both shapes here are
   * deliberately invisible to the rule, and pinning them keeps a future
   * "improvement" to that pattern from silently changing what the rule reports.
   */
  it("does not recognise a template-literal discriminant", () => {
    const source = [
      `function classify(x) {`,
      "  if (x.kind === `a`) return 1;",
      "  if (x.kind === `b`) return 2;",
      "  if (x.kind === `c`) return 3;",
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE_UNDER_TEST)).toEqual([]);
  });

  it("does not recognise a discriminant read through a call", () => {
    const source = [
      `function classify(x) {`,
      `  if (normalize(x.kind).trim() === "a") return 1;`,
      `  if (normalize(x.kind).trim() === "b") return 2;`,
      `  if (normalize(x.kind).trim() === "c") return 3;`,
      `}`,
    ].join("\n");
    expect(exhaustive(source, FILE_UNDER_TEST)).toEqual([]);
  });
});
