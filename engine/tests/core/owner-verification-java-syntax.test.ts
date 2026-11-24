/**
 * The one Java syntax seam (issue #254): what `parseJava` reads from Java text
 * and what it refuses. Every expectation is on the projection the plan and the
 * coverage rule consume — package, imports, used names, and the span plus
 * replacement of each mutation site — never on the parser's own CST.
 *
 * The property at the end is the seam's contract with the plan: every site it
 * reports, applied to the source it came from, is still Java. A site whose text
 * does not compile would be an invalid mutant, and a run of only invalid
 * mutants is the `no-valid-mutants` infrastructure failure — a false block on
 * exactly the kind of change issue #254 reported.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseJava, type JavaMutationSite } from "../../src/core/owner-verification/java-syntax";
import { mutationPlan, MUTANT_CAP_PER_INVARIANT, applyMutant } from "../../src/core/owner-verification/mutation-plan";

const GATE = [
  "package p.q;",
  "",
  "import java.util.List;",
  "import java.util.Optional;",
  "import static java.util.Objects.requireNonNull;",
  "",
  "/** A gate on one decision. */",
  "final class Gate {",
  "  private final int threshold;",
  "",
  "  Gate(String reason, int threshold) {",
  "    requireNonNull(reason);",
  "    this.threshold = threshold;",
  "  }",
  "",
  "  List<String> decide(Optional<String> reason) {",
  "    if (reason.isEmpty() || threshold < 20) {",
  '      throw new IllegalStateException("no reason");',
  "    }",
  '    return List.of("allow");',
  "  }",
  "",
  "  boolean blocks(int score) {",
  "    return score >= threshold;",
  "  }",
  "",
  "  void noop() {",
  "    return;",
  "  }",
  "}",
  "",
].join("\n");

const GUARDS = [
  "package p.q;",
  "",
  "final class Guards {",
  "  void guard(int score) {",
  "    if (score < 0) {",
  '      throw new IllegalArgumentException("negative");',
  "    }",
  "    if (score < 0) {",
  "      return;",
  "    } else {",
  "      return;",
  "    }",
  "    if (score < 0) {",
  "      score++;",
  "    }",
  "  }",
  "",
  "  void patterns(Object value) {",
  "    if (value instanceof String text) {",
  "      text.length();",
  "    }",
  "    if (value instanceof String) {",
  "      value.hashCode();",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

const MODERN = [
  "package p.q;",
  "",
  "sealed interface Shape permits Circle, Square {}",
  "",
  "record Circle(double radius) implements Shape {}",
  "",
  "record Square(double side) implements Shape {}",
  "",
  "final class Area {",
  "  double area(Shape shape) {",
  "    return switch (shape) {",
  "      case Circle circle -> 3.14 * circle.radius();",
  "      case Square square -> square.side() * square.side();",
  "    };",
  "  }",
  "",
  "  String json() {",
  '    return """',
  '      {"a": 1}',
  '      """;',
  "  }",
  "",
  "  int count() {",
  "    return 2;",
  "  }",
  "",
  "  Runnable lambda() {",
  "    return () -> {",
  "      return;",
  "    };",
  "  }",
  "}",
  "",
].join("\n");

const parsed = (text: string) => {
  const result = parseJava(text);
  if (!result.ok) throw new Error(`fixture refused: ${result.error.diagnostics.join("; ")}`);
  return result.value;
};

/** Each site as [operator, the text it replaces, the text it puts there], in source order. */
const sites = (text: string): readonly (readonly [string, string, string])[] =>
  parsed(text).sites.map((site: JavaMutationSite) => [site.operator, text.slice(site.start, site.end), site.replacement]);

const operatorsOf = (text: string): readonly string[] => parsed(text).sites.map((site) => site.operator);

const BODY_STATEMENTS = [
  "x = x + 1;",
  "if (x < 0) { x = 0; }",
  "if (x > 0 && b) { x = x - 1; } else { x = 1; }",
  "while (b) { x = x - 1; }",
  "do { x = x + 1; } while (b);",
  "for (int i = 0; i < x; i++) { x = x - 1; }",
  "int y = b ? 1 : 2;",
  "boolean ok = x != 3 && b;",
  "if (s instanceof String t) { s = t; }",
  "try { x = x + 1; } catch (RuntimeException e) { x = 0; }",
] as const;

describe("parseJava", () => {
  it("reads the package, every import form and the names used outside them", () => {
    const file = parsed(GATE);
    expect(file.packageName).toBe("p.q");
    expect(file.imports).toEqual([
      { kind: "class", name: "java.util.List" },
      { kind: "class", name: "java.util.Optional" },
      { kind: "static-member", owner: "java.util.Objects" },
    ]);
    expect([...file.identifiers]).toEqual(expect.arrayContaining(["Gate", "List", "Optional", "String", "requireNonNull", "threshold"]));
    expect([...file.identifiers]).not.toContain("java");
    expect([...file.identifiers]).not.toContain("util");
    expect([...file.qualifiedNames]).toContain("List.of");
  });

  it("reads a default package and a module-prefixed layout the same way", () => {
    expect(parsed("final class A {}\n").packageName).toBeNull();
    expect(parsed(GATE).packageName).toBe("p.q");
  });

  it("reports each operator's span and the replacement its Java type allows", () => {
    expect(sites(GATE)).toEqual([
      ["statement-removal", "requireNonNull(reason);", ";"],
      ["statement-removal", "this.threshold = threshold;", ";"],
      ["guard-removal", 'if (reason.isEmpty() || threshold < 20) {\n      throw new IllegalStateException("no reason");\n    }', ";"],
      ["condition-negation", "reason.isEmpty() || threshold < 20", "!(reason.isEmpty() || threshold < 20)"],
      ["logical-swap", "||", "&&"],
      ["comparison-flip", "<", ">="],
      ["return-value-replacement", 'List.of("allow")', "null"],
      ["return-value-replacement", "score >= threshold", "!(score >= threshold)"],
      ["comparison-flip", ">=", "<"],
    ]);
  });

  it("gives a void method no return site, a numeric one 0, a reference one null, and a lambda's return none at all", () => {
    const replacements = sites(MODERN).filter(([operator]) => operator === "return-value-replacement");
    expect(replacements).toEqual([
      ["return-value-replacement", "switch (shape) {\n      case Circle circle -> 3.14 * circle.radius();\n      case Square square -> square.side() * square.side();\n    }", "0"],
      ["return-value-replacement", '"""\n      {"a": 1}\n      """', "null"],
      ["return-value-replacement", "2", "0"],
      ["return-value-replacement", "() -> {\n      return;\n    }", "null"],
    ]);
    expect(operatorsOf(MODERN)).not.toContain("boolean-literal-flip");
  });

  it("offers no return site whose replacement is the value already there, which would mutate the owner into itself", () => {
    const source = [
      "final class Already {",
      "  String find(int x) {",
      "    if (x > 0) return null;",
      "    return null;",
      "  }",
      "  int count() {",
      "    return 0;",
      "  }",
      "  boolean flag() {",
      "    return false;",
      "  }",
      "}",
      "",
    ].join("\n");
    const replacements = sites(source).filter(([operator]) => operator === "return-value-replacement");
    // The boolean return still offers one: `!(false)` is a different value.
    expect(replacements).toEqual([["return-value-replacement", "false", "!(false)"]]);
  });

  it("reads a return inside an interface's default, static or private method as a method body", () => {
    const source = [
      "interface Sized {",
      "  default int size() { return 1; }",
      "  static void go() { sink(); }",
      "  private int hidden() { return 2; }",
      "}",
      "",
    ].join("\n");
    expect(sites(source)).toEqual([
      ["return-value-replacement", "1", "0"],
      ["statement-removal", "sink();", ";"],
      ["return-value-replacement", "2", "0"],
    ]);
  });

  it("offers no boolean site on a `while` or `for` condition that is the constant true, whose flipped body javac rejects", () => {
    const loops = ["final class Loops {", "  void spin() {", "    while (true) { tick(); }", "    for (; true; ) { tock(); }", "    do { done(); } while (true);", "  }", "}", ""].join("\n");
    const sites = parsed(loops).sites;
    const negations = sites.filter((site) => site.operator === "condition-negation").length;
    const flips = sites.filter((site) => site.operator === "boolean-literal-flip").length;
    // Only the `do … while (true)`, whose negation and flip still compile.
    expect([negations, flips]).toEqual([1, 1]);
    expect(sites.filter((site) => site.operator === "statement-removal")).toHaveLength(3);
  });

  it("offers no statement-removal inside a try block whose handlers catch a checked exception", () => {
    const source = [
      "final class Guarded {",
      "  void read() throws Exception {",
      "    try {",
      "      work();",
      "    } catch (java.io.IOException e) {",
      "      log(e);",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const removed = sites(source).filter(([operator]) => operator === "statement-removal").map(([, original]) => original);
    // `work();` can leave the handler unreachable; the catch block's own statement is fine.
    expect(removed).toEqual(["log(e);"]);
  });

  it("reads a dotted chain only where the text writes a dot, never two identifiers side by side", () => {
    const file = parsed('final class Chain {\n  String d() { return new p.q.Thing().render(); }\n}\n');
    expect([...file.qualifiedNames]).toContain("p.q.Thing");
    // `String d` is a type and a method, not the chain `String.d`.
    expect([...file.qualifiedNames].some((name) => name.startsWith("String."))).toBe(false);
  });

  it("refuses a Java 25 module import the Java 21 grammar does not know, rather than inventing sites for it", () => {
    const refused = parseJava("import module java.base;\nfinal class A {}\n");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a module import parsed");
    expect(refused.error.kind).toBe("java-syntax-error");
  });

  it("offers guard-removal only for an if with no else whose body only exits", () => {
    const guards = parsed(GUARDS).sites.filter((site) => site.operator === "guard-removal");
    expect(guards).toHaveLength(1);
    expect(GUARDS.slice(guards[0]?.start, guards[0]?.end)).toBe("if (score < 0) {\n      throw new IllegalArgumentException(\"negative\");\n    }");
  });

  it("offers no condition-negation for a condition that declares a pattern variable, which the negation would put out of scope", () => {
    const negations = sites(GUARDS).filter(([operator]) => operator === "condition-negation").map(([, original]) => original);
    // The three plain guards negate; the pattern one, which declares `text`, does not.
    expect(negations).toEqual(["score < 0", "score < 0", "score < 0", "value instanceof String"]);
  });

  it("refuses text the grammar cannot parse as one diagnostic, never a recovered tree", () => {
    const refused = parseJava("package p.q;\nfinal class A {\n  void f() { if ( }\n}\n");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a broken file parsed");
    expect(refused.error.kind).toBe("java-syntax-error");
    expect(refused.error.diagnostics).toHaveLength(1);
    expect(refused.error.diagnostics[0]).toMatch(/^Java parsing failed at line \d+, column \d+: found /u);
  });

  it("keeps the parser's token dump out of the diagnostic", () => {
    const refused = parseJava("final class A {\n  void f() { int x = ; }\n}\n");
    if (refused.ok) throw new Error("a broken file parsed");
    const [diagnostic] = refused.error.diagnostics;
    expect(diagnostic.length).toBeLessThanOrEqual(300);
    expect(diagnostic).toContain("found ';'");
    expect(diagnostic).not.toContain("->classDeclaration");
  });

  it("names the end of the input where the parser reports no position", () => {
    const refused = parseJava("final class A {\n");
    if (refused.ok) throw new Error("a truncated file parsed");
    expect(refused.error.diagnostics[0]).toContain("at the end of the input");
  });

  it("refuses unicode escapes in an identifier, which javac would decode before lexing", () => {
    const refused = parseJava("final class A { int \\u0061 = 1; }\n");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a file with a unicode escape parsed");
    expect(refused.error.diagnostics[0]).toContain("unexpected character");
  });

  it("reads the Java 21 surface the engine's own Java projects use: sealed types, records, switch expressions and text blocks", () => {
    expect(operatorsOf(MODERN)).toContain("return-value-replacement");
    expect(sites(MODERN).length).toBeGreaterThan(0);
  });

  it("is deterministic: the same bytes project the same names and sites", () => {
    const once = parsed(GATE);
    const twice = parsed(GATE);
    expect([...twice.identifiers]).toEqual([...once.identifiers]);
    expect(twice.sites).toEqual(once.sites);
  });

  it("reports each site's span as a different, non-empty slice of the text it read", () => {
    for (const source of [GATE, GUARDS, MODERN]) {
      const reported = parsed(source).sites;
      expect(reported.length, source.slice(0, 20)).toBeGreaterThan(0);
      for (const site of reported) {
        expect(site.start, `${site.operator} of ${source.slice(0, 20)}`).toBeLessThan(site.end);
        expect(source.slice(site.start, site.end)).not.toBe("");
        expect(site.replacement, `${site.operator} of ${source.slice(0, 20)}`).not.toBe("");
        // A site that writes the bytes it replaced is not a mutant.
        expect(site.replacement, `${site.operator} of ${source.slice(0, 20)}`).not.toBe(source.slice(site.start, site.end));
      }
    }
  });

  it("property: every site's replacement keeps the file Java, so no mutant of a Java owner is born invalid", () => {
    fc.assert(
      fc.property(fc.constantFrom(GATE, GUARDS, MODERN), (source) => {
        for (const site of parsed(source).sites) {
          const mutated = applyMutant(source, site);
          const reparsed = parseJava(mutated);
          expect(reparsed.ok, `${site.operator}: ${source.slice(site.start, site.end)} → ${site.replacement}`).toBe(true);
        }
      }),
      { numRuns: 20 },
    );
  });

  const javaOwnerOf = (statements: readonly string[]): string => [
    "package p.q;",
    "",
    "final class Generated {",
    "  int f(int x, String s, boolean b) {",
    ...statements.map((statement) => `    ${statement}`),
    "    return x;",
    "  }",
    "}",
    "",
  ].join("\n");

  it("property: over generated owners, every site's mutant is still Java and no site writes the bytes it replaces", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...BODY_STATEMENTS), { minLength: 1, maxLength: 12 }).map(javaOwnerOf), (source) => {
        for (const site of parsed(source).sites) {
          expect(source.slice(site.start, site.end), site.operator).not.toBe(site.replacement);
          const reparsed = parseJava(applyMutant(source, site));
          expect(reparsed.ok, `${site.operator}: ${source.slice(site.start, site.end)} → ${site.replacement}`).toBe(true);
        }
      }),
      { seed: 25_401, numRuns: 80 },
    );
  });

  it("plans a Java owner through the same operators as a TypeScript one, on its changed lines only", () => {
    const plan = mutationPlan({
      ownerPath: "billing/src/main/java/p/q/Gate.java",
      ownerText: GATE,
      changedLines: new Set([16, 17, 18, 19]),
      cap: MUTANT_CAP_PER_INVARIANT,
    });
    if (!plan.ok) throw new Error(`fixture refused: ${plan.error.kind}`);
    expect(plan.value.mutants.map(({ operator, line }) => [operator, line])).toEqual([
      ["condition-negation", 17],
      ["logical-swap", 17],
      ["comparison-flip", 17],
    ]);
    for (const mutant of plan.value.mutants) {
      expect(parseJava(applyMutant(GATE, mutant)).ok, mutant.operator).toBe(true);
    }
  });
});
