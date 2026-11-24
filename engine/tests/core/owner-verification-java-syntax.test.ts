/**
 * The one Java syntax seam (issue #254): what `parseJava` reads from Java text
 * and what it refuses. Every expectation is on the projection the plan and the
 * coverage rule consume — package, imports, used names, and the span plus
 * replacement of each mutation site — never on the parser's own CST.
 *
 * The seam's contract with the plan has two halves. Every site it reports,
 * applied to the source it came from, still parses as Java (the properties at
 * the end): that is all a re-parse can prove. And every site javac is known to
 * reject is withheld (the exclusion tests), because a mutant that does not
 * compile is an invalid run, and a run of only invalid mutants is the
 * `no-valid-mutants` infrastructure failure — a false block on exactly the
 * kind of change issue #254 reported.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { parse as parseWithGrammar } from "java-parser";
import { describe, expect, it } from "vitest";
import { isGrammarRefusal, parseJava, type JavaMutationSite } from "../../src/core/owner-verification/java-syntax";
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

  it("reads a declared package and a default package", () => {
    expect(parsed("final class A {}\n").packageName).toBeNull();
    expect(parsed(GATE).packageName).toBe("p.q");
  });

  it("reads a contextual keyword in a package or import name as the name segment javac reads, never dropping it", () => {
    const file = parsed([
      "package a.record;",
      "",
      "import a.module.open.B;",
      "import static a.to.C.with;",
      "import a.sealed.*;",
      "",
      "final class T { void f() { new a.record.D(); var permits = 1; } }",
      "",
    ].join("\n"));
    expect(file.packageName).toBe("a.record");
    expect(file.imports).toEqual([
      { kind: "class", name: "a.module.open.B" },
      { kind: "static-member", owner: "a.to.C" },
      { kind: "class-wildcard", packageName: "a.sealed" },
    ]);
    expect([...file.qualifiedNames]).toContain("a.record.D");
    expect([...file.identifiers]).toContain("permits");
  });

  it("reports each operator's span and the replacement its Java type allows", () => {
    // `this.threshold = threshold;` is the final field's one assignment: removing it does not compile.
    expect(sites(GATE)).toEqual([
      ["statement-removal", "requireNonNull(reason);", ";"],
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

  it("offers no return site for a lambda's value return, even inside a method whose own return offers one", () => {
    const source = [
      "final class Lambdas {",
      "  boolean same(java.util.function.Function<Integer, Integer> g) {",
      "    java.util.function.Function<Integer, Integer> h = x -> { return x + 1; };",
      "    return g == h;",
      "  }",
      "}",
      "",
    ].join("\n");
    // `!(x + 1)` inside the lambda would not compile; the method's own return is a boolean.
    expect(sites(source).filter(([operator]) => operator === "return-value-replacement"))
      .toEqual([["return-value-replacement", "g == h", "!(g == h)"]]);
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
    const loopSites = parsed(loops).sites;
    const negations = loopSites.filter((site) => site.operator === "condition-negation").length;
    const flips = loopSites.filter((site) => site.operator === "boolean-literal-flip").length;
    // Only the `do … while (true)`, whose negation and flip still compile.
    expect([negations, flips]).toEqual([1, 1]);
    expect(loopSites.filter((site) => site.operator === "statement-removal")).toHaveLength(3);
  });

  it("offers condition-negation for every if, while, do, for and ?: condition, with the exact text it negates", () => {
    const source = [
      "final class Conditions {",
      "  int f(int i, boolean b) {",
      "    while (b) { i++; }",
      "    do { i--; } while (i < 3);",
      "    for (; i < 9; i++) { b = !b; }",
      "    if (i > 4) { i = 0; }",
      "    return b ? 1 : 2;",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(sites(source).filter(([operator]) => operator === "condition-negation")).toEqual([
      ["condition-negation", "b", "!(b)"],
      ["condition-negation", "i < 3", "!(i < 3)"],
      ["condition-negation", "i < 9", "!(i < 9)"],
      ["condition-negation", "i > 4", "!(i > 4)"],
      ["condition-negation", "b", "!(b)"],
    ]);
  });

  it("offers guard-removal for a braceless continue, break or return guard, and none for a block that does more than exit", () => {
    const source = [
      "final class Exits {",
      "  void f(int x) {",
      "    for (int i = 0; i < x; i++) {",
      "      if (i == 1) continue;",
      "      if (i == 2) break;",
      "      if (i == 3) return;",
      "      if (i == 4) { log(); return; }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(sites(source).filter(([operator]) => operator === "guard-removal").map(([, original]) => original))
      .toEqual(["if (i == 1) continue;", "if (i == 2) break;", "if (i == 3) return;"]);
  });

  it("offers no guard-removal of a break guard in an endless loop, whose removal makes the code after the loop unreachable", () => {
    const source = [
      "final class Spin {",
      "  int f(java.util.Iterator<Integer> it) {",
      "    int n = 0;",
      "    while (true) {",
      "      if (!it.hasNext()) break;",
      "      if (n > 9) return n;",
      "      n += it.next();",
      "    }",
      "    for (;;) {",
      "      if (n < 0) break;",
      "      n--;",
      "    }",
      "    return n;",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(sites(source).filter(([operator]) => operator === "guard-removal").map(([, original]) => original))
      .toEqual(["if (n > 9) return n;"]);
  });

  it("offers no statement-removal of a final field's or a blank local's assignment, which javac rejects as not initialized", () => {
    const source = [
      "final class Fields {",
      "  private final int a;",
      "  private int b;",
      "  static int c;",
      "  static { c = 1; }",
      "  { b = 2; }",
      "  Fields(int a) { this.a = a; log(); }",
      "  int f(int x) {",
      "    int y;",
      "    int z = 0;",
      "    y = x;",
      "    z = x;",
      "    this.b = x;",
      "    x += 1;",
      "    return y + z;",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(sites(source).filter(([operator]) => operator === "statement-removal").map(([, original]) => original))
      .toEqual(["log();", "z = x;", "this.b = x;", "x += 1;"]);
  });

  it("offers no negation, guard-removal or logical-swap over a condition that declares a type or record pattern", () => {
    const source = [
      "final class Patterns {",
      "  int f(Object o, Object shape) {",
      "    if (o instanceof String s && s.isEmpty()) { return 1; }",
      "    if (!(o instanceof Integer n)) return 0;",
      "    if (shape instanceof Circle(double r)) { return (int) r; }",
      "    return n;",
      "  }",
      "}",
      "",
      "record Circle(double r) {}",
      "",
    ].join("\n");
    const operators = operatorsOf(source);
    expect(operators).not.toContain("condition-negation");
    expect(operators).not.toContain("guard-removal");
    expect(operators).not.toContain("logical-swap");
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

  it("ADR-0102: loads the grammar only when a Java text is parsed, never when the engine's modules load", () => {
    const engine = fileURLToPath(new URL("../..", import.meta.url));
    const script = [
      'import { createRequire } from "node:module";',
      `const engine = ${JSON.stringify(engine)};`,
      'const loaded = () => Object.keys(createRequire(engine + "/package.json").cache).some((path) => path.includes("/java-parser/"));',
      'await import(engine + "/src/core/owner-verification/mutation-plan.ts");',
      'const seam = await import(engine + "/src/core/owner-verification/java-syntax.ts");',
      "const before = loaded();",
      'seam.parseJava("final class A {}\\n");',
      "process.stdout.write(JSON.stringify({ before, after: loaded() }));",
    ].join("\n");
    const run = spawnSync("bun", ["-e", script], { cwd: engine, encoding: "utf-8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ before: false, after: true });
  });

  it("reads a thrown message as the grammar's refusal only when the grammar composed it", () => {
    const thrownBy = (text: string): string => {
      try {
        parseWithGrammar(text);
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
      throw new Error(`the grammar accepted ${text}`);
    };
    expect(isGrammarRefusal(thrownBy("final class A { void f() { if ( } }\n"))).toBe(true);
    expect(isGrammarRefusal(thrownBy("final class A { int \\u0061 = 1; }\n"))).toBe(true);
    // A broken install or a parser bug is not a verdict on the owner's text.
    expect(isGrammarRefusal("Cannot find module 'java-parser'")).toBe(false);
    expect(isGrammarRefusal("Cannot read properties of undefined (reading 'children')")).toBe(false);
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

  it("every fixture site's mutant still parses as Java", () => {
    for (const source of [GATE, GUARDS, MODERN]) {
      for (const site of parsed(source).sites) {
        const reparsed = parseJava(applyMutant(source, site));
        expect(reparsed.ok, `${site.operator}: ${source.slice(site.start, site.end)} → ${site.replacement}`).toBe(true);
      }
    }
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

  it("property: over generated owners, every site's mutant still parses as Java and no site writes the bytes it replaces", () => {
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

  it("keeps exact UTF-16 spans, lines and columns past non-ASCII and astral text in a CRLF file", () => {
    const text = ["final class U {", "  boolean f(int a, int b) {", '    String s = "é😀";', "    return a < b;", "  }", "}", ""].join("\r\n");
    const plan = mutationPlan({ ownerPath: "billing/src/main/java/p/U.java", ownerText: text, changedLines: new Set([4]), cap: MUTANT_CAP_PER_INVARIANT });
    if (!plan.ok) throw new Error(`fixture refused: ${plan.error.kind}`);
    expect(plan.value.mutants.map((mutant) => [mutant.operator, text.slice(mutant.start, mutant.end), mutant.line, mutant.column])).toEqual([
      ["return-value-replacement", "a < b", 4, 12],
      ["comparison-flip", "<", 4, 14],
    ]);
  });
});
