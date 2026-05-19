import { describe, it, expect } from "vitest";
import { countNewTests, countAssertions } from "../../src/utils/git";

describe("countNewTests (pure)", () => {
  it("counts Java @Test annotations", () => {
    const diff = [
      "+    @Test",
      "+    void shouldValidateOrder() {",
      "+    @Property",
      "+    void orderTotalInvariant() {",
      "-    @Test",
      "     void existingTest() {",
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.java).toBe(2);
    expect(result.total).toBe(2);
  });

  it("counts TypeScript it/test/describe blocks", () => {
    const diff = [
      '+  it("should validate input", () => {',
      '+  test("handles edge case", () => {',
      '+  describe("validation", () => {',
      '-  it("old test", () => {',
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.ts).toBe(3);
    expect(result.total).toBe(3);
  });

  it("counts Python test functions and classes", () => {
    const diff = [
      "+def test_validates_input():",
      "+class TestValidation:",
      "+    def test_edge_case(self):",
      "-def test_old():",
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.python).toBe(3);
    expect(result.total).toBe(3);
  });

  it("returns zeros for no tests", () => {
    const diff = ["+const x = 42;", "+function doStuff() {}"].join("\n");
    const result = countNewTests(diff);
    expect(result.total).toBe(0);
  });

  it("handles mixed languages", () => {
    const diff = [
      "+    @Test",
      '+  it("foo", () => {',
      "+def test_bar():",
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.java).toBe(1);
    expect(result.ts).toBe(1);
    expect(result.python).toBe(1);
    expect(result.total).toBe(3);
  });
});

describe("countAssertions (pure)", () => {
  it("counts Java assertions", () => {
    const diff = [
      "+    assertThat(result).isEqualTo(expected);",
      "+    assertThrows(Exception.class, () -> run());",
      "+    verify(mock).someMethod();",
    ].join("\n");
    expect(countAssertions(diff)).toBe(3);
  });

  it("counts TypeScript assertions", () => {
    const diff = [
      "+    expect(result).toBe(42);",
      "+    expect(fn).toThrow();",
      "+    expect(arr).toEqual([1, 2]);",
    ].join("\n");
    expect(countAssertions(diff)).toBe(3);
  });

  it("counts Python assertions", () => {
    const diff = [
      "+    assert result == 42",
      "+    assertIn('key', data)",
    ].join("\n");
    expect(countAssertions(diff)).toBe(2);
  });

  it("ignores removed lines", () => {
    const diff = [
      "-    expect(old).toBe(true);",
      "+    const x = 1;",
    ].join("\n");
    expect(countAssertions(diff)).toBe(0);
  });
});

import { filterTestFiles } from "../../src/utils/git";

describe("filterTestFiles (pure)", () => {
  it("matches files in top-level tests/ directory", () => {
    const files = ["tests/utils/git.test.ts", "tests/integration.spec.ts"];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches files in nested tests/ directories", () => {
    const files = [
      "engine/tests/utils/git.test.ts",
      "apps/web/tests/login.spec.ts",
      "packages/core/tests/unit/foo.test.ts",
    ];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches files in test/ (singular) directories", () => {
    const files = ["src/test/java/com/example/FooTest.java", "lib/test/helper.test.ts"];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches files in __tests__/ directories", () => {
    const files = [
      "src/components/__tests__/Button.test.tsx",
      "packages/ui/__tests__/hook.spec.ts",
    ];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches files in spec/ directories", () => {
    const files = ["spec/models/user.spec.ts", "lib/spec/integration.test.js"];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches .test.ts and .test.tsx suffixes anywhere", () => {
    const files = ["src/utils/parser.test.ts", "components/Button.test.tsx"];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches .spec.ts and .spec.jsx suffixes anywhere", () => {
    const files = ["src/api.spec.ts", "components/Dialog.spec.jsx"];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("matches .test.js and .spec.js suffixes", () => {
    const files = ["lib/calc.test.js", "utils/format.spec.js"];
    expect(filterTestFiles(files)).toEqual(files);
  });

  it("excludes non-test files", () => {
    const files = [
      "src/config.ts",
      "README.md",
      ".claude/specs/spec.md",
      "src/utils/parser.ts",
      "package.json",
      "engine/src/handlers/test-handler.ts", // has 'test' in name but not a test dir/suffix
    ];
    expect(filterTestFiles(files)).toEqual([]);
  });

  it("excludes files that have 'spec' or 'test' only in non-directory path segments", () => {
    const files = [
      ".claude/specs/spec.md",       // 'specs' not 'spec' dir exactly (but wait, specs/ isn't matched)
      "docs/testing-guide.md",       // 'testing' not 'test/'
      "src/testutils/helper.ts",     // 'testutils' not 'test/'
    ];
    expect(filterTestFiles(files)).toEqual([]);
  });

  it("handles empty input", () => {
    expect(filterTestFiles([])).toEqual([]);
  });

  it("handles mixed test and non-test files", () => {
    const files = [
      "src/config.ts",
      "engine/tests/utils/git.test.ts",
      "README.md",
      "src/api.spec.ts",
      "package.json",
    ];
    expect(filterTestFiles(files)).toEqual([
      "engine/tests/utils/git.test.ts",
      "src/api.spec.ts",
    ]);
  });
});
