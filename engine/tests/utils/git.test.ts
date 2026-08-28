import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { countNewTests, countAssertions, diffFiles, diffUntracked, mergeBase } from "../../src/utils/git";

describe("git command diagnostics", () => {
  it("reports array-argument git failures instead of returning empty silently", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(mergeBase("definitely-missing-loom-test-ref")).toBeNull();
      const output = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(output).toContain("git warning: git");
      expect(output).toContain("merge-base");
      expect(output).toContain("definitely-missing-loom-test-ref");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("diffUntracked", () => {
  it("accepts exit 1 only when Git emitted an actual patch", () => {
    const directory = mkdtempSync(join(tmpdir(), "loom-untracked-diff-"));
    const file = join(directory, "new.test.ts");
    try {
      writeFileSync(file, "export const answer = 42;\n");
      const result = diffUntracked(file);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.diff).toContain("diff --git");
        expect(result.diff).toContain("+export const answer = 42;");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns typed failure when the untracked path cannot be read", () => {
    const missing = join(tmpdir(), `loom-missing-untracked-${process.pid}-${Date.now()}.ts`);
    const result = diffUntracked(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("git diff --no-index");
      expect(result.error).toContain(missing);
    }
  });
});

describe("complete-postimage diff evidence", () => {
  it("keeps a multiline opener outside ordinary hunk range visible to assertion scanning", () => {
    const repository = mkdtempSync(join(tmpdir(), "loom-full-postimage-diff-"));
    const file = join(repository, "ExampleTest.java");
    const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const base = [
      "class ExampleTest {",
      '  String docs = \"\"\"',
      "    context one",
      "    context two",
      "    context three",
      "    context four",
      "    context five",
      '    \"\"\";',
      "}",
      "",
    ].join("\n");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repository });
      writeFileSync(file, base);
      execFileSync("git", ["add", "ExampleTest.java"], { cwd: repository });
      execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", "base"], { cwd: repository });
      writeFileSync(file, base.replace(
        '    \"\"\";',
        '    assertThat(fake).isTrue();\n    \"\"\";\n\n  @Test void empty() {}',
      ));
      process.env.CLAUDE_PROJECT_DIR = repository;

      const observed = diffFiles(["ExampleTest.java"]);
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(observed.diff).toContain('  String docs = \"\"\"');
      expect(countNewTests(observed.diff).java).toBe(1);
      expect(countAssertions(observed.diff)).toBe(0);
    } finally {
      if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

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

  it("counts TypeScript test cases but not describe-only suites", () => {
    const diff = [
      '+  it("should validate input", () => {',
      '+  test("handles edge case", () => {',
      '+  describe("validation", () => {',
      '-  it("old test", () => {',
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.ts).toBe(2);
    expect(result.total).toBe(2);
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

  it("does not launder empty tests through matcher text in titles or comments", () => {
    const diff = [
      '+  it("uses toBe and expect(", () => {});',
      "+  // expect(value).toEqual(true)",
      "+  /* assertThat(value).isTrue();",
      "+     pytest.raises(ExpectedError) */",
      "+  const note = `toThrow and .should.`;",
    ].join("\n");

    expect(countNewTests(diff).ts).toBe(1);
    expect(countAssertions(diff)).toBe(0);
  });

  it.each([
    ["Python triple-quoted string", "'''", "+    assert result == 42"],
    ["Java text block", '\"\"\"', "+    assertThat(result).isEqualTo(42);"],
  ])("does not count assertion text inside a %s", (_name, delimiter, assertion) => {
    const diff = [
      "diff --git a/tests/example.py b/tests/example.py",
      "--- a/tests/example.py",
      "+++ b/tests/example.py",
      "@@ -1,8 +1,9 @@",
      ` ${delimiter}`,
      " context one",
      " context two",
      " context three",
      " context four",
      assertion,
      ` ${delimiter}`,
      "+def test_empty(): pass",
    ].join("\n");

    expect(countNewTests(diff).python).toBe(1);
    expect(countAssertions(diff)).toBe(0);
  });

  it("counts top-level TypeScript test declarations in a bound test source", () => {
    const diff = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1 @@",
      "+test('works', () => {});",
    ].join("\n");

    expect(countNewTests(diff).ts).toBe(1);
  });

  it("rejects quoted or malformed Git paths instead of granting headerless compatibility", () => {
    const diff = [
      'diff --git "a/src/prod\\"uction.ts" "b/src/prod\\"uction.ts"',
      '--- "a/src/prod\\"uction.ts"',
      '+++ "b/src/prod\\"uction.ts"',
      "@@ -0,0 +1,2 @@",
      "+test(fake);",
      "+expect(fake);",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("rejects executable-looking additions in a bound non-test TypeScript source", () => {
    const diff = [
      "diff --git a/src/production.ts b/src/production.ts",
      "--- a/src/production.ts",
      "+++ b/src/production.ts",
      "@@ -0,0 +1,2 @@",
      "+test(fake);",
      "+expect(fake);",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("rejects assertion-shaped prose in Markdown", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      "+This test(fake) example calls expect(fake) in prose.",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("rejects multiline TSX prose while retaining operators and brace expressions", () => {
    const text = [
      "diff --git a/components/Panel.test.tsx b/components/Panel.test.tsx",
      "--- a/components/Panel.test.tsx",
      "+++ b/components/Panel.test.tsx",
      "@@ -1 +1,5 @@",
      "+const prose = <div>",
      "+  it(fake) expect(fake)",
      "+</div>;",
    ].join("\n");
    const expression = [
      "diff --git a/components/Panel.test.tsx b/components/Panel.test.tsx",
      "--- a/components/Panel.test.tsx",
      "+++ b/components/Panel.test.tsx",
      "@@ -1 +1,3 @@",
      "+test('comparison', () => expect(value > 0).toBe(true));",
      "+const result = <Panel value={expect(actual).toBe(expected)} />;",
    ].join("\n");

    expect(countNewTests(text).total).toBe(0);
    expect(countAssertions(text)).toBe(0);
    expect(countNewTests(expression).ts).toBe(1);
    expect(countAssertions(expression)).toBe(2);
  });

  it("rejects nested JSX text while retaining its surrounding expression", () => {
    const diff = [
      "diff --git a/components/Panel.test.tsx b/components/Panel.test.tsx",
      "--- a/components/Panel.test.tsx",
      "+++ b/components/Panel.test.tsx",
      "@@ -1 +1,3 @@",
      "+const result = <div>{condition ? <span>",
      "+  expect(fabricated).toBe(true)",
      "+</span> : expect(actual).toBe(expected)}</div>;",
    ].join("\n");

    expect(countAssertions(diff)).toBe(1);
  });

  it("rejects Rust raw-string and nested-comment contents as evidence", () => {
    const rawString = [
      "diff --git a/tests/evidence.rs b/tests/evidence.rs",
      "--- a/tests/evidence.rs",
      "+++ b/tests/evidence.rs",
      "@@ -1 +1,5 @@",
      "+let docs = r###\"",
      "+#[test]",
      "+assert!(fabricated);",
      "+\"###;",
    ].join("\n");
    const nestedComment = [
      "diff --git a/tests/evidence.rs b/tests/evidence.rs",
      "--- a/tests/evidence.rs",
      "+++ b/tests/evidence.rs",
      "@@ -1 +1,6 @@",
      "+/* outer",
      "+   /* nested */",
      "+   #[test]",
      "+   assert_eq!(fabricated, true);",
      "+*/",
    ].join("\n");

    expect(countNewTests(rawString).total).toBe(0);
    expect(countAssertions(rawString)).toBe(0);
    expect(countNewTests(nestedComment).total).toBe(0);
    expect(countAssertions(nestedComment)).toBe(0);
  });

  it("resets multiline literal state at each file boundary", () => {
    const diff = [
      "diff --git a/first.py b/first.py",
      "--- a/first.py",
      "+++ b/first.py",
      "@@ -1 +1 @@",
      "+'''",
      "diff --git a/second.test.ts b/second.test.ts",
      "--- a/second.test.ts",
      "+++ b/second.test.ts",
      "@@ -1 +1 @@",
      "+expect(result).toBe(true);",
    ].join("\n");

    expect(countAssertions(diff)).toBe(1);
  });

  it("does not let removed lexical state hide an added assertion", () => {
    const diff = [
      "-  /* deleted unterminated comment",
      "+  expect(result).toBe(true);",
    ].join("\n");

    expect(countAssertions(diff)).toBe(1);
  });

  it("still counts executable assertions containing string arguments", () => {
    const diff = [
      '+  expect(message).toBe("toEqual in a value");',
      "+  assert reason == 'expect(fake)'",
    ].join("\n");

    expect(countAssertions(diff)).toBe(2);
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
      ".claude/specs/spec.md",       // `specs/` is deliberately distinct from the `spec/` test directory.
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
