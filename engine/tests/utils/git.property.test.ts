import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { countNewTests, countAssertions } from "../../src/utils/git";

describe("countNewTests — property tests", () => {
  it("adding more +@Test lines never decreases count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        (base, extra) => {
          const baseDiff = Array.from({ length: base }, () => "+    @Test").join("\n");
          const moreDiff = Array.from({ length: base + extra }, () => "+    @Test").join("\n");
          expect(countNewTests(moreDiff).total).toBeGreaterThanOrEqual(countNewTests(baseDiff).total);
        },
      ),
    );
  });

  it("removed lines are never counted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const diff = Array.from({ length: n }, () => "-    @Test").join("\n");
        expect(countNewTests(diff).total).toBe(0);
      }),
    );
  });

  it("context lines (no +/-) are never counted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const diff = Array.from({ length: n }, () => "     @Test").join("\n");
        expect(countNewTests(diff).total).toBe(0);
      }),
    );
  });

  it("mixed +/- lines: only + lines count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (addCount, removeCount) => {
          const added = Array.from({ length: addCount }, () => "+    @Test").join("\n");
          const removed = Array.from({ length: removeCount }, () => "-    @Test").join("\n");
          const diff = `${added}\n${removed}`;
          expect(countNewTests(diff).java).toBe(addCount);
        },
      ),
    );
  });

  it("TypeScript test patterns counted correctly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = Array.from({ length: n }, () => '+  it("works", () => {').join("\n");
        expect(countNewTests(diff).ts).toBe(n);
      }),
    );
  });

  it("Python test patterns counted correctly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = Array.from({ length: n }, () => "+def test_something():").join("\n");
        expect(countNewTests(diff).python).toBe(n);
      }),
    );
  });
});

describe("countAssertions — property tests", () => {
  it("adding more assertions never decreases count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        (base, extra) => {
          const baseDiff = Array.from({ length: base }, () => "+    assertThat(x).isTrue();").join("\n");
          const moreDiff = Array.from({ length: base + extra }, () => "+    assertThat(x).isTrue();").join("\n");
          expect(countAssertions(moreDiff)).toBeGreaterThanOrEqual(countAssertions(baseDiff));
        },
      ),
    );
  });

  it("removed assertions never counted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const diff = Array.from({ length: n }, () => "-    assertThat(x).isTrue();").join("\n");
        expect(countAssertions(diff)).toBe(0);
      }),
    );
  });

  it("assertion-like tokens inside titles and comments never count", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("expect(", "toBe", "toEqual", "assertThat", "pytest.raises", ".should."),
        fc.string({ maxLength: 40 }),
        (token, suffix) => {
          const escaped = `${token}${suffix}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
          const diff = [
            `+  it("${escaped}", () => {});`,
            `+  // ${token}${suffix}`,
            `+  const label = "${escaped}";`,
          ].join("\n");
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("multiline string contents never become assertion evidence", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("'''", '\"\"\"'),
        fc.constantFrom(
          "assert result == 42",
          "assertThat(result).isTrue();",
          "expect(result).toBe(true);",
          "pytest.raises(ExpectedError)",
        ),
        fc.array(fc.string({ maxLength: 30 }), { minLength: 4, maxLength: 12 }),
        (delimiter, assertion, prefix) => {
          const diff = [
            "diff --git a/example.test b/example.test",
            "@@ -1,20 +1,21 @@",
            ` ${delimiter}`,
            ...prefix.map((line) => ` ${line.replaceAll("\n", " ").replaceAll(delimiter, "")}`),
            "+def test_laundered():",
            `+${assertion}`,
            ` ${delimiter}`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("line-continuation strings never expose evidence on the next physical line", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          { path: "example.test.ts", opener: 'const docs = "prose', content: 'test(fake) expect(fake)";' },
          { path: "tests/test_evidence.py", opener: 'docs = "prose', content: 'def test_fake(): assert fabricated"' },
        ),
        (fixture) => {
          const diff = [
            `diff --git a/${fixture.path} b/${fixture.path}`,
            `--- a/${fixture.path}`,
            `+++ b/${fixture.path}`,
            "@@ -0,0 +1,2 @@",
            `+${fixture.opener}${String.fromCharCode(92)}`,
            `+${fixture.content}`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("returned or yielded JSX prose never becomes executable evidence", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("return", "yield"),
        fc.constantFrom("test(fake)", "expect(fake)", "it(fake) .should."),
        (keyword, evidence) => {
          const diff = [
            "diff --git a/example.test.tsx b/example.test.tsx",
            "--- a/example.test.tsx",
            "+++ b/example.test.tsx",
            "@@ -0,0 +1,3 @@",
            `+function* View() { ${keyword} <div>`,
            `+${evidence}`,
            "+</div>; }",
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("nested TSX generic-arrow constraints never suppress following executable evidence", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 24 }), (depth) => {
        const constraint = `${"Box<".repeat(depth)}string${">".repeat(depth)}`;
        const diff = [
          "diff --git a/example.test.tsx b/example.test.tsx",
          "--- a/example.test.tsx",
          "+++ b/example.test.tsx",
          "@@ -0,0 +1,2 @@",
          `+const nested = <T extends ${constraint}>(value: T) => value;`,
          "+test('works', () => expect(nested(value)).toBe(value));",
        ].join("\n");
        expect(countNewTests(diff).ts).toBe(1);
        expect(countAssertions(diff)).toBe(1);
      }),
    );
  });

  it("control-flow regex bodies never expose evidence-shaped contents", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("if", "while", "for"),
        fc.integer({ min: 0, max: 12 }),
        fc.constantFrom("expect(fake)", "test(fake)", ".should."),
        (keyword, nesting, evidence) => {
          const condition = `${"(".repeat(nesting)}enabled${")".repeat(nesting)}`;
          const header = keyword === "for" ? `for (; ${condition}; )` : `${keyword} (${condition})`;
          const diff = [
            "diff --git a/example.test.ts b/example.test.ts",
            "--- a/example.test.ts",
            "+++ b/example.test.ts",
            "@@ -0,0 +1 @@",
            `+${header} /${evidence}/.test(value);`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("bound Python comments never expose evidence after any hash prefix", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("#", "#[", "##[", "# ["),
        fc.constantFrom("def test_fabricated():", "assert fabricated", "class TestFabricated:"),
        (prefix, evidence) => {
          const diff = [
            "diff --git a/tests/test_evidence.py b/tests/test_evidence.py",
            "--- a/tests/test_evidence.py",
            "+++ b/tests/test_evidence.py",
            "@@ -0,0 +1 @@",
            `+${prefix}${evidence}`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("escaped triple quotes never terminate multiline evidence suppression", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          { path: "tests/test_evidence.py", delimiter: "'''", escaped: "\\'''", test: "def test_fabricated():", assertion: "assert fabricated" },
          { path: "ExampleTest.java", delimiter: '\"\"\"', escaped: '\\\"\"\"', test: "@Test void fabricated() {}", assertion: "assertThat(fabricated).isTrue();" },
        ),
        fc.integer({ min: 0, max: 10 }),
        (fixture, pairs) => {
          const diff = [
            `diff --git a/${fixture.path} b/${fixture.path}`,
            `--- a/${fixture.path}`,
            `+++ b/${fixture.path}`,
            "@@ -0,0 +1,5 @@",
            `+${fixture.delimiter}`,
            `+${"\\\\".repeat(pairs)}${fixture.escaped}`,
            `+${fixture.test}`,
            `+${fixture.assertion}`,
            `+${fixture.delimiter}`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("regex bodies after closing braces never expose evidence", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("expect(fake)", "test(fake)", ".should."),
        (evidence) => {
          const diff = [
            "diff --git a/example.test.ts b/example.test.ts",
            "--- a/example.test.ts",
            "+++ b/example.test.ts",
            "@@ -0,0 +1 @@",
            `+if (enabled) {} /${evidence}/.test(value);`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("Rust ordinary and byte strings never expose multiline evidence-shaped contents", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "b"),
        fc.constantFrom("#[test]", "assert!(fabricated);", "assert_eq!(left, right);"),
        (prefix, content) => {
          const diff = [
            "diff --git a/tests/evidence.rs b/tests/evidence.rs",
            "--- a/tests/evidence.rs",
            "+++ b/tests/evidence.rs",
            "@@ -0,0 +1,3 @@",
            `+let docs = ${prefix}\"`,
            `+${content}`,
            "+\";",
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("Rust raw strings never expose evidence-shaped contents", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 24 }),
        fc.constantFrom("#[test]", "assert!(fabricated);", "assert_eq!(left, right);"),
        (hashCount, content) => {
          const hashes = "#".repeat(hashCount);
          const diff = [
            "diff --git a/tests/evidence.rs b/tests/evidence.rs",
            "--- a/tests/evidence.rs",
            "+++ b/tests/evidence.rs",
            "@@ -1 +1,3 @@",
            `+let docs = r${hashes}\"`,
            `+${content}`,
            `+\"${hashes};`,
          ].join("\n");
          expect(countNewTests(diff).total).toBe(0);
          expect(countAssertions(diff)).toBe(0);
        },
      ),
    );
  });

  it("max 1 assertion per line", () => {
    // Even if a line contains multiple assertion keywords, it should count at most 1
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = Array.from(
          { length: n },
          () => "+    assertThat(expect(x).toBe(42)).isTrue();",
        ).join("\n");
        // Each line has both assertThat AND expect, but should count max 1 per line
        expect(countAssertions(diff)).toBe(n);
      }),
    );
  });
});
