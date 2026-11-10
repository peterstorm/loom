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
  DEFAULT_SWITCH_TOTALITY_OPTIONS,
  EVERYWHERE,
  RULE_NAME,
  detectedSwitchKeys,
  handler as switchTotality,
  type SwitchScope,
} from "../../../src/linter/programmatic/switch-totality";
import { baselineKey, unusedBaselineEntries, type Baseline } from "../../../src/linter/programmatic/baseline";

const FILE = "engine/src/core/example.ts";
const NO_BASELINE: Baseline = [];

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

/** A two-arm switch over `x.kind` whose default arm is the given text (one line, or several). */
const withDefaultLine = (defaultLine: string): string => [
  `function name(x: Event): string {`,
  `  switch (x.kind) {`,
  `    case "a":`,
  `      return "a";`,
  `    case "b":`,
  `      return "b";`,
  `    ${defaultLine}`,
  `  }`,
  `}`,
].join("\n");

/** A two-arm switch made total by a default arm that binds it to `never`. */
const NEVER_DEFAULT = withDefaultLine("default: {\n      const unreachable: never = x;\n      return unreachable;\n    }");

/** A two-arm switch made total by a default arm delegating to an exhaustive match. */
const MATCH_DEFAULT = withDefaultLine(`default:\n      return match(x).with({ kind: "c" }, () => "c").exhaustive();`);

/** Run the rule with the repo baseline out of the way — these tests are about
 *  the rule's judgement, not about which files happen to be grandfathered. */
const lint = (
  source: string,
  filePath: string = FILE,
  baseline: Baseline = NO_BASELINE,
  scope: SwitchScope = EVERYWHERE,
  projectRoot: string | null = null,
) => switchTotality(source, filePath, { ...DEFAULT_SWITCH_TOTALITY_OPTIONS, baseline, scope, projectRoot });

/** A project narrowing the rule to its pure core and machine core. */
const CORE_ONLY: SwitchScope = { kind: "modules", prefixes: ["engine/src/core/", "engine/src/machine/"] };

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
    expect(lint(NEVER_DEFAULT)).toEqual([]);
  });

  it("accepts assertNever in the default arm", () => {
    expect(lint(withDefaultLine("default:\n      return assertNever(x);"))).toEqual([]);
  });

  it("accepts a default arm that delegates the remaining variants to match(...).exhaustive()", () => {
    expect(lint(MATCH_DEFAULT)).toEqual([]);
  });

  it("does NOT accept a match(...).exhaustive() inside a CASE arm — it proves that match, not the switch", () => {
    // The rule's first version accepted `.exhaustive()` anywhere in the span,
    // so a nested match in one arm silenced a switch that a new variant would
    // fall straight through.
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
    expect(lint(source)).toHaveLength(1);
  });

  it("measures qualified enum-member arms like literal arms", () => {
    const source = [
      `function name(status: Status): string {`,
      `  switch (status) {`,
      `    case Status.Draft:`,
      `      return "draft";`,
      `    case Status.Paid:`,
      `      return "paid";`,
      `  }`,
      `  return "?";`,
      `}`,
    ].join("\n");
    const violations = lint(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.fixHint).toContain("2 arms");
  });

  it("does NOT accept `default: throw` — it compiles after a new variant is added", () => {
    expect(lint(withDefaultLine(`default:\n      throw new Error("unreachable");`))).toHaveLength(1);
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

  it("does not fold a NESTED switch's never proof into the enclosing switch", () => {
    // The nested `default` proves the nested switch. Reading it as the outer
    // switch's proof is the fail-open direction: an unproven union match is
    // accepted because some inner switch happens to be total.
    const source = [
      `function name(x: Event, y: Kind): string {`,
      `  switch (x.kind) {`,
      `    case "a":`,
      `      switch (y) {`,
      `        case "p": return "p";`,
      `        case "q": return "q";`,
      `        default: {`,
      `          const unreachable: never = y;`,
      `          return unreachable;`,
      `        }`,
      `      }`,
      `      return "a";`,
      `    case "b":`,
      `      return "b";`,
      `  }`,
      `  return "?";`,
      `}`,
    ].join("\n");
    const violations = lint(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(2);
  });

  it("does not count a NESTED switch's arms toward the enclosing guard", () => {
    // The outer switch has ONE literal arm — a guard, exempt. Counting the
    // nested switch's arms made it look like a three-arm union match. The
    // nested switch itself proves totality, so it is not the site under test.
    const source = [
      `function clean(x: Job, y: Kind): void {`,
      `  switch (x.status) {`,
      `    case "done":`,
      `      switch (y) {`,
      `        case "p": drop(y); break;`,
      `        case "q": keep(y); break;`,
      `        default: {`,
      `          const unreachable: never = y;`,
      `          drop(unreachable);`,
      `        }`,
      `      }`,
      `  }`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
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

  it("applies to every TypeScript file by default — any project, any layout", () => {
    // The rule used to default to loom's own `engine/src/core/` and
    // `engine/src/machine/`, so in every other repository it matched nothing.
    expect(lint(UNPROVEN, "engine/src/handlers/cli.ts")).toHaveLength(1);
    expect(lint(UNPROVEN, "src/domain/order.ts")).toHaveLength(1);
    expect(lint(UNPROVEN, "app/api/orders/route.tsx")).toHaveLength(1);
  });

  it("a project may narrow the scope to its own module prefixes", () => {
    expect(lint(UNPROVEN, "engine/src/handlers/cli.ts", NO_BASELINE, CORE_ONLY)).toEqual([]);
    expect(lint(UNPROVEN, "engine/src/core/example.ts", NO_BASELINE, CORE_ONLY)).toHaveLength(1);
  });

  it("ignores test files", () => {
    expect(lint(UNPROVEN, "engine/src/core/example.test.ts")).toEqual([]);
    expect(lint(UNPROVEN, "src/domain/order.spec.ts")).toEqual([]);
  });

  it.each([
    ["/home/someone/dev/loom", "engine/src/core/example.ts"],
    ["/home/someone/dev/loom", "pi/implementation-brief-expansion.ts"],
    // A target project's tree shares no directory name with loom's — the case
    // the old anchor list could never key, so no baseline could describe it.
    ["/work/shop", "src/domain/order.ts"],
  ])("keys an absolute path under %s relative to that project root, so a baselined %s stays baselined", (root, relative) => {
    // Joining the relative path is the point: an absolute path that does not
    // sit under the root would stay absolute and match no key — the case below
    // shows the key is live by failing without it.
    const absolute = `${root}/${relative}`;
    expect(lint(UNPROVEN, absolute, [baselineKey(relative, "x.kind")], EVERYWHERE, root)).toEqual([]);
    expect(lint(UNPROVEN, absolute, NO_BASELINE, EVERYWHERE, root)).toHaveLength(1);
  });

  it("never excuses a site through a key it could not make relative", () => {
    // No project root (no project config in play), or a file outside the root:
    // the path stays absolute, so the relative key does not match and the site
    // is reported — the fail-closed direction.
    const relative = "src/domain/order.ts";
    expect(lint(UNPROVEN, `/work/shop/${relative}`, [baselineKey(relative, "x.kind")])).toHaveLength(1);
    expect(lint(UNPROVEN, `/elsewhere/${relative}`, [baselineKey(relative, "x.kind")], EVERYWHERE, "/work/shop"))
      .toHaveLength(1);
  });

  it("spends one baseline entry per site, so a second switch on the same scrutinee still fails", () => {
    const violations = lint(`${UNPROVEN}\n${UNPROVEN}`, FILE, [baselineKey(FILE, "x.kind")]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(13);
  });

  it("sees a switch written on a single line, arms and all", () => {
    expect(lint(`switch (x.kind) { case "a": go(); case "b": stop(); }`)).toHaveLength(1);
  });

  it.each([
    ["assertNever", `default: return assertNever(x);`],
    ["a braced never binding", `default: { const unreachable: never = x; return unreachable; }`],
    ["a match delegation", `default: return match(x).with({ kind: "c" }, () => "c").exhaustive();`],
  ])("accepts a proof written on the SAME line as `default:` (%s)", (_shape, defaultLine) => {
    // Membership in the default arm used to be decided from the state at the
    // START of the line, so the commonest one-line proof was never read.
    expect(lint(withDefaultLine(defaultLine))).toEqual([]);
  });

  it("accepts a one-line switch whose default carries the proof", () => {
    expect(lint(`switch (x.kind) { case "a": go(); break; case "b": stop(); break; default: assertNever(x); }`))
      .toEqual([]);
  });

  it.each([
    ["a block comment", `/* x: never */ return "?";`],
    ["a block comment naming assertNever", `/* assertNever(x) */ return "?";`],
    ["a block comment naming exhaustive()", `/* .exhaustive() */ return "?";`],
    ["an error message", `throw new Error("unreachable: never");`],
    ["an error message naming assertNever", `throw new Error('call assertNever(x) here');`],
    ["a template literal", "throw new Error(`x: never ${x}`);"],
    ["a line comment", `return "?"; // x: never`],
  ])("does NOT accept a proof that lives only in %s", (_where, body) => {
    // Comments and strings are not code: they still compile after a new
    // variant is added, which is exactly the drift being prevented. Both
    // placements — on the `default:` line and on the line after it.
    expect(lint(withDefaultLine(`default: ${body}`))).toHaveLength(1);
    expect(lint(withDefaultLine(`default:\n      ${body}`))).toHaveLength(1);
  });

  it("does NOT accept a proof inside a block comment that spans lines", () => {
    expect(lint(withDefaultLine(`default:\n      /*\n       const unreachable: never = x;\n      */\n      return "?";`))).toHaveLength(1);
  });

  it("does not count `case` labels inside comments or strings as arms", () => {
    // One real arm — a guard, exempt. A commented-out or quoted `case` must not
    // inflate it into a union match (nor hide a real one behind it).
    const source = [
      `function clean(x: Job): void {`,
      `  switch (x.status) {`,
      `    case "done": drop(x); /* case "x": */ log("case 'y': skipped");`,
      `    /*`,
      `    case "z":`,
      `    */`,
      `    // case "w":`,
      `  }`,
      `}`,
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("does not count braces inside a block comment toward the switch's depth", () => {
    // A `}` in a comment would close the span early and hide the second arm.
    const source = [
      `function name(x: Event): string {`,
      `  switch (x.kind) {`,
      `    case "a": /* } */`,
      `      return "a";`,
      `    case "b":`,
      `      return "b";`,
      `  }`,
      `  return "?";`,
      `}`,
    ].join("\n");
    const violations = lint(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.fixHint).toContain("2 arms");
  });

  it("does not read a switch head inside a block comment as a switch", () => {
    const source = [`/*`, UNPROVEN, `*/`, `export const x = 1;`].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("reports the head line as written, comments and all", () => {
    const source = UNPROVEN.replace(`switch (x.kind) {`, `switch (x.kind) { // tagged`);
    expect(lint(source)[0]!.text).toBe(`switch (x.kind) { // tagged`);
  });

  it("reports nothing for text with no switch at all", () => {
    expect(lint("export const x = 1;\n")).toEqual([]);
  });
});

describe("switch-totality baseline staleness", () => {
  it("reports entries no detected switch consumed", () => {
    const detected = [baselineKey(FILE, "x.kind")];
    const baseline = [baselineKey(FILE, "x.kind"), baselineKey(FILE, "y.status")];
    expect(unusedBaselineEntries({ detected, baseline })).toEqual([baselineKey(FILE, "y.status")]);
  });

  it("keeps the multiplicity of a duplicated entry", () => {
    const detected = [baselineKey(FILE, "x.kind")];
    const baseline = [baselineKey(FILE, "x.kind"), baselineKey(FILE, "x.kind")];
    expect(unusedBaselineEntries({ detected, baseline })).toEqual([baselineKey(FILE, "x.kind")]);
  });

  it("distils every switch in a file into keys, skipping the language-closed ones", () => {
    const source = [
      `switch (x.kind) { case "a": break; case "b": break; }`,
      `switch (typeof raw) { case "string": break; case "number": break; }`,
    ].join("\n");
    expect(detectedSwitchKeys(source, FILE)).toEqual([baselineKey(FILE, "x.kind")]);
  });

  it("detects exactly the sites the rule would flag: guards, proven switches, out-of-scope and test files are not sites", () => {
    const narrowed = { ...DEFAULT_SWITCH_TOTALITY_OPTIONS, scope: CORE_ONLY };
    const guard = [`switch (x.status) {`, `  case "done": drop(x);`, `}`].join("\n");
    expect(detectedSwitchKeys(guard, FILE)).toEqual([]);
    expect(detectedSwitchKeys(UNPROVEN, "engine/src/handlers/cli.ts", narrowed)).toEqual([]);
    expect(detectedSwitchKeys(UNPROVEN, "engine/src/core/example.test.ts")).toEqual([]);
    // And the detector agrees with the handler site for site.
    expect(detectedSwitchKeys(`${UNPROVEN}\n${UNPROVEN}`, FILE)).toHaveLength(lint(`${UNPROVEN}\n${UNPROVEN}`).length);
  });

  it("keys an absolute path relative to the project root, like the handler", () => {
    const options = { ...DEFAULT_SWITCH_TOTALITY_OPTIONS, projectRoot: "/home/someone/dev/loom" };
    expect(detectedSwitchKeys(UNPROVEN, `/home/someone/dev/loom/${FILE}`, options)).toEqual([baselineKey(FILE, "x.kind")]);
  });

  it.each([
    ["a `never` default", NEVER_DEFAULT],
    ["a default delegating to match(...).exhaustive()", MATCH_DEFAULT],
    ["a whole match(...).exhaustive()", [
      `function name(x: Event): string {`,
      `  return match(x.kind)`,
      `    .with("a", () => "a")`,
      `    .with("b", () => "b")`,
      `    .with("c", () => "c")`,
      `    .exhaustive();`,
      `}`,
    ].join("\n")],
  ])("reports a baselined switch's entry unused once the switch is converted to %s", (_proof, converted) => {
    const baseline = [baselineKey(FILE, "x.kind")];
    // Before the conversion the entry is live: it excuses the one unproven site.
    expect(unusedBaselineEntries({ detected: detectedSwitchKeys(UNPROVEN, FILE), baseline })).toEqual([]);
    // After it, nothing consumes the entry — the paid debt shows up as stale.
    expect(lint(converted, FILE, baseline)).toEqual([]);
    expect(unusedBaselineEntries({ detected: detectedSwitchKeys(converted, FILE), baseline })).toEqual(baseline);
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
      (baseline: Baseline) => {
        const consumed = baseline.includes(baselineKey(FILE, "x.kind")) ? 1 : 0;
        expect(lint(UNPROVEN, FILE, baseline)).toHaveLength(1 - consumed);
        expect(unusedBaselineEntries({ detected: [baselineKey(FILE, "x.kind")], baseline })).toHaveLength(
          baseline.length - consumed,
        );
      },
    ));
  });
});
