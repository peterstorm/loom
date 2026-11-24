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

  it("reports each site's span as a non-empty slice of the text it read", () => {
    for (const source of [GATE, GUARDS, MODERN]) {
      for (const site of parsed(source).sites) {
        expect(site.start, `${site.operator} of ${source.slice(0, 20)}`).toBeLessThan(site.end);
        expect(source.slice(site.start, site.end)).not.toBe("");
        expect(site.replacement).not.toBe("");
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
