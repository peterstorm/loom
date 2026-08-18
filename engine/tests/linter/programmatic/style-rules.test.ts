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
});
