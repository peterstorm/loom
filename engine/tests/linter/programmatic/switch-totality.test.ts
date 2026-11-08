/**
 * switch-totality pins BOTH directions, like the style rules beside it: the
 * shapes that drift silently when a union grows, and the shapes that are
 * already total (a rule that fires on correct code gets disabled, which is
 * worse than not having the rule).
 *
 * Every case here is a shape found in this repo, not a hypothetical: the
 * `default: throw` arm is the idiom that motivated the rule, and `typeof raw`
 * is the wire parser's real scrutinee.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_SWITCH_TOTALITY_MODULES,
  RULE_NAME,
  baselineKey,
  detectedSwitchKeys,
  handler as switchTotality,
  unusedBaselineEntries,
} from "../../../src/linter/programmatic/switch-totality";

const FILE = "engine/src/core/example.ts";
const NO_BASELINE: readonly string[] = [];

/** An unproven three-arm switch over a union tag. */
const UNPROVEN = [
  `function name(x: Event): string {`,
  `  switch (x.kind) {`,
  `    case "a":`,
  `      return "a";`,
  `    case "b":`,
  `      return "b";`,
  `    case "c":`,
  `      return "c";`,
  `  }`,
  `  return "?";`,
  `}`,
].join("\n");

/** Run the rule with the repo baseline out of the way — these tests are about
 *  the rule's judgement, not about which files happen to be grandfathered. */
const lint = (source: string, filePath: string = FILE, baseline: readonly string[] = NO_BASELINE) =>
  switchTotality(source, filePath, DEFAULT_SWITCH_TOTALITY_MODULES, baseline);

describe("switch-totality", () => {
  it("flags a switch with literal arms and no totality proof", () => {
    const violations = lint(UNPROVEN);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe(RULE_NAME);
    expect(violations[0]!.line).toBe(2);
    expect(violations[0]!.fixHint).toContain("x.kind");
    expect(violations[0]!.fixHint).toContain("exhaustive()");
  });

  it("accepts a default arm that binds the scrutinee to `never`", () => {
    const source = [
      `function name(x: Event): string {`,
      `  switch (x.kind) {`,
      `    case "a":`,
      `      return "a";`,
      `    case "b":`,
      `      return "b";`,
      `    default: {`,
      `      const unreachable: never = x;`,
      `      return unreachable;`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("accepts assertNever in the default arm", () => {
    const source = [
      `function name(x: Event): string {`,
      `  switch (x.kind) {`,
      `    case "a":`,
      `      return "a";`,
      `    case "b":`,
      `      return "b";`,
      `    default:`,
      `      return assertNever(x);`,
      `  }`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("accepts a switch that delegates to match(...).exhaustive()", () => {
    const source = [
      `function name(x: Event): string {`,
      `  switch (x.kind) {`,
      `    case "a":`,
      `      return match(x).with({ kind: "a" }, () => "a").exhaustive();`,
      `    case "b":`,
      `      return "b";`,
      `  }`,
      `  return "?";`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("does NOT accept `default: throw` — it compiles after a new variant is added", () => {
    const source = [
      `function name(x: Event): string {`,
      `  switch (x.kind) {`,
      `    case "a":`,
      `      return "a";`,
      `    case "b":`,
      `      return "b";`,
      `    default:`,
      `      throw new Error("unreachable");`,
      `  }`,
      `}`,
    ].join("\n");
    expect(lint(source)).toHaveLength(1);
  });

  it("does not let a `: never` outside the default arm prove the switch", () => {
    const source = [
      `function name(x: Event): string {`,
      `  switch (x.kind) {`,
      `    case "a": {`,
      `      const local: never = boom();`,
      `      return local;`,
      `    }`,
      `    case "b":`,
      `      return "b";`,
      `  }`,
      `  return "?";`,
      `}`,
    ].join("\n");
    expect(lint(source)).toHaveLength(1);
  });

  it("leaves a one-arm switch alone — that is a guard, not a pattern match", () => {
    const source = [
      `function clean(x: Job): void {`,
      `  switch (x.status) {`,
      `    case "done":`,
      `      drop(x);`,
      `  }`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("exempts `switch (typeof raw)` — the language closes that domain", () => {
    const source = [
      `function parse(raw: unknown): string | null {`,
      `  switch (typeof raw) {`,
      `    case "string":`,
      `      return raw;`,
      `    case "number":`,
      `      return String(raw);`,
      `  }`,
      `  return null;`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("ignores switches outside the pure-core and machine scopes", () => {
    expect(lint(UNPROVEN, "engine/src/handlers/cli.ts")).toEqual([]);
  });

  it("ignores test files even inside the scope", () => {
    expect(lint(UNPROVEN, "engine/src/core/example.test.ts")).toEqual([]);
  });

  it.each([
    ["engine/src/core/example.ts"],
    // machine/ is not an import boundary, so anchoring on the boundary table
    // left its absolute paths unmatched and the baseline entry silently dead.
    ["engine/src/machine/example.ts"],
  ])("normalizes an absolute path to %s so a baselined site stays baselined", (relative) => {
    const absolute = `/home/someone/dev/loom/`;
    expect(lint(UNPROVEN, absolute, [baselineKey(relative, "x.kind")])).toEqual([]);
  });

  it("spends one baseline entry per site, so a second switch on the same scrutinee still fails", () => {
    const violations = lint(`${UNPROVEN}\n${UNPROVEN}`, FILE, [baselineKey(FILE, "x.kind")]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(13);
  });

  it("sees a switch written on a single line, arms and all", () => {
    expect(lint(`switch (x.kind) { case "a": go(); case "b": stop(); }`)).toHaveLength(1);
  });

  it("reports nothing for text with no switch at all", () => {
    expect(lint("export const x = 1;\n")).toEqual([]);
  });
});

describe("switch-totality baseline staleness", () => {
  it("reports entries no detected switch consumed", () => {
    const detected = [baselineKey(FILE, "x.kind")];
    const baseline = [baselineKey(FILE, "x.kind"), baselineKey(FILE, "y.status")];
    expect(unusedBaselineEntries(detected, baseline)).toEqual([baselineKey(FILE, "y.status")]);
  });

  it("keeps the multiplicity of a duplicated entry", () => {
    const detected = [baselineKey(FILE, "x.kind")];
    const baseline = [baselineKey(FILE, "x.kind"), baselineKey(FILE, "x.kind")];
    expect(unusedBaselineEntries(detected, baseline)).toEqual([baselineKey(FILE, "x.kind")]);
  });

  it("distils every switch in a file into keys, skipping the language-closed ones", () => {
    const source = [
      `switch (x.kind) { case "a": break; case "b": break; }`,
      `switch (typeof raw) { case "string": break; case "number": break; }`,
    ].join("\n");
    expect(detectedSwitchKeys(source, FILE)).toEqual([baselineKey(FILE, "x.kind")]);
  });
});

describe("switch-totality properties", () => {
  it("flags exactly the switches with 2+ literal arms, no proof, a union scrutinee and no baseline entry", () => {
    fc.assert(fc.property(
      fc.constantFrom("x.kind", "x.status", "typeof raw"),
      fc.integer({ min: 0, max: 5 }),
      (scrutinee: string, arms: number) => {
        const cases = Array.from({ length: arms }, (_, index) => `    case "v${index}":\n      return ${index};`);
        const source = [`function f(x: T): number {`, `  switch (${scrutinee}) {`, ...cases, `  }`, `  return -1;`, `}`]
          .join("\n");
        const expected = scrutinee === "typeof raw" || arms < 2 ? 0 : 1;
        expect(lint(source)).toHaveLength(expected);
      },
    ));
  });

  it("never throws on arbitrary source text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 240 }), (source: string) => {
      expect(() => lint(source)).not.toThrow();
    }));
  });

  it("hides at most one violation per baseline entry, and never rots silently", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom(baselineKey(FILE, "x.kind"), baselineKey(FILE, "y.status")), { maxLength: 5 }),
      (baseline: readonly string[]) => {
        const consumed = baseline.includes(baselineKey(FILE, "x.kind")) ? 1 : 0;
        expect(lint(UNPROVEN, FILE, baseline)).toHaveLength(1 - consumed);
        expect(unusedBaselineEntries([baselineKey(FILE, "x.kind")], baseline)).toHaveLength(
          baseline.length - consumed,
        );
      },
    ));
  });
});
