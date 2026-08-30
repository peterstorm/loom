import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { countNewTests, countAssertions, diffFiles, diffFilesSince, diffFilesStaged, diffUntracked, mergeBase, type GitDiffResult } from "../../src/utils/git";

/**
 * Wrap added lines in the exact patch shape Git emits: one `diff --git` entry,
 * its `---`/`+++` prelude, and one hunk.
 *
 * Evidence is path-bound, so a bare `+line` is not a shape Git produces and is
 * deliberately not counted. Fixtures use this instead of loose `+line` arrays so
 * every fixture states which path its lines are attributed to.
 */
const patch = (path: string, ...lines: string[]): string => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -0,0 +1 @@",
  ...lines,
].join("\n");

const withProjectDir = <T>(root: string, run: () => T): T => {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  }
};

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
      const observed = withProjectDir(repository, () => diffFiles(["ExampleTest.java"]));
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(observed.diff).toContain('  String docs = \"\"\"');
      expect(countNewTests(observed.diff).java).toBe(1);
      expect(countAssertions(observed.diff)).toBe(0);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

describe("diff command authority over workspace-authored Git behaviour", () => {
  /** A repository whose tracked file is modified and whose config defines a diff driver. */
  const hostileRepository = (): Readonly<{ root: string; marker: string }> => {
    const root = mkdtempSync(join(tmpdir(), "loom-diff-driver-"));
    const marker = join(root, "EXECUTED");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, "data.dat"), "before\n");
    execFileSync("git", ["add", "data.dat"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", "base"], { cwd: root });
    writeFileSync(join(root, "data.dat"), "after\n");
    writeFileSync(join(root, ".gitattributes"), "*.dat diff=evil\n");
    execFileSync("git", ["config", "diff.evil.textconv", `sh -c 'touch ${marker}; cat'`], { cwd: root });
    return { root, marker };
  };

  it("never executes a workspace-defined Git textconv driver", () => {
    const { root, marker } = hostileRepository();
    try {
      const observed = withProjectDir(root, () => diffFiles(["data.dat"]));
      expect(observed.ok).toBe(true);
      // The patch is still real evidence; only the driver is gone.
      if (observed.ok) expect(observed.diff).toContain("+after");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a baseline argument in option position instead of writing to it", () => {
    const { root, marker } = hostileRepository();
    try {
      const observed = withProjectDir(root, () =>
        diffFilesSince(`--output=${marker}`, ["data.dat"]));
      expect(observed.ok).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an option-shaped untracked path as a path, not an option", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-diff-option-"));
    try {
      const observed = withProjectDir(root, () => diffUntracked("--output=INJECTED.txt"));
      expect(observed.ok).toBe(false);
      expect(existsSync(join(root, "INJECTED.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("complete-postimage context on every diff entry point", () => {
  /**
   * A repository whose tracked Java file opens a text block far above the range
   * a default three-line hunk would show. Only `--unified=<max>` carries that
   * opener to the lexical scanner, so each entry point is pinned separately: an
   * entry point that loses the flag silently reopens assertion laundering on
   * committed-diff evidence, which is the dominant path because implementers
   * commit before SubagentStop.
   */
  const postimageRepository = (): string => {
    const repository = mkdtempSync(join(tmpdir(), "loom-postimage-entry-"));
    const base = [
      "class ExampleTest {",
      '  String docs = """',
      "    context one",
      "    context two",
      "    context three",
      "    context four",
      "    context five",
      '    """;',
      "}",
      "",
    ].join("\n");
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    writeFileSync(join(repository, "ExampleTest.java"), base);
    execFileSync("git", ["add", "ExampleTest.java"], { cwd: repository });
    execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", "base"], { cwd: repository });
    writeFileSync(join(repository, "ExampleTest.java"), base.replace(
      '    """;',
      '    assertThat(fake).isTrue();\n    """;\n\n  @Test void empty() {}',
    ));
    return repository;
  };

  /** The postimage opener must reach the scanner, and prose must stay inert. */
  const expectFullPostimage = (observed: GitDiffResult): void => {
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.diff).toContain('  String docs = """');
    expect(countNewTests(observed.diff).java).toBe(1);
    expect(countAssertions(observed.diff)).toBe(0);
  };

  const commit = (repository: string, message: string): void => {
    execFileSync("git", ["add", "ExampleTest.java"], { cwd: repository });
    execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", message], { cwd: repository });
  };

  it("pins complete postimages on the staged index path", () => {
    const repository = postimageRepository();
    try {
      execFileSync("git", ["add", "ExampleTest.java"], { cwd: repository });
      expectFullPostimage(withProjectDir(repository, () => diffFilesStaged(["ExampleTest.java"])));
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("pins complete postimages on the committed-baseline path", () => {
    const repository = postimageRepository();
    try {
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf-8" }).trim();
      commit(repository, "change");
      expectFullPostimage(withProjectDir(repository, () => diffFilesSince(baseline, ["ExampleTest.java"])));
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("keeps a whole untracked file's lexical state inert", () => {
    const repository = postimageRepository();
    const untracked = join(repository, "UntrackedProbe.java");
    try {
      writeFileSync(untracked, [
        "class UntrackedProbe {",
        '  String docs = """',
        "    context one",
        "    context two",
        "    context three",
        "    context four",
        "    assertThat(fake).isTrue();",
        '    """;',
        "}",
      ].join("\n"));
      const observed = withProjectDir(repository, () => diffUntracked("UntrackedProbe.java"));
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(countAssertions(observed.diff)).toBe(0);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

describe("countNewTests (pure)", () => {
  it("counts Java @Test annotations", () => {
    const diff = patch(
      "ExampleTest.java",
      "+    @Test",
      "+    void shouldValidateOrder() {",
      "+    @Property",
      "+    void orderTotalInvariant() {",
      "-    @Test",
      "     void existingTest() {",
    );
    const result = countNewTests(diff);
    expect(result.java).toBe(2);
    expect(result.total).toBe(2);
  });

  it("counts TypeScript test cases but not describe-only suites", () => {
    const diff = patch(
      "example.test.ts",
      '+  it("should validate input", () => {',
      '+  test("handles edge case", () => {',
      '+  describe("validation", () => {',
      '-  it("old test", () => {',
    );
    const result = countNewTests(diff);
    expect(result.ts).toBe(2);
    expect(result.total).toBe(2);
  });

  it.each([
    "it.each(cases)('works', value => {})",
    "test.concurrent('works', async () => {})",
    "it.concurrent.each(cases)('works', value => {})",
  ])("counts parameterized/concurrent TypeScript declaration: %s", (declaration) => {
    expect(countNewTests(patch("example.test.ts", `+${declaration}`)).ts).toBe(1);
  });

  it("counts Python test functions and methods, not their collection class", () => {
    const diff = patch(
      "tests/test_validation.py",
      "+def test_validates_input():",
      "+class TestValidation:",
      "+    def test_edge_case(self):",
      "-def test_old():",
    );
    const result = countNewTests(diff);
    expect(result.python).toBe(2);
    expect(result.total).toBe(2);
  });

  it("does not count TypeScript helpers named test as runner invocations", () => {
    const diff = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1,2 @@",
      "+export function test(value: string) { return value; }",
      "+class Helper { test(value: string) { return value; } }",
      "+expect(test('helper')).toBe('helper');",
    ].join("\n");

    expect(countNewTests(diff).ts).toBe(0);
    expect(countAssertions(diff)).toBe(1);
  });

  it("does not count a Python test collection class without test methods", () => {
    const diff = [
      "diff --git a/tests/test_support.py b/tests/test_support.py",
      "--- a/tests/test_support.py",
      "+++ b/tests/test_support.py",
      "@@ -0,0 +1,3 @@",
      "+class TestSupport:",
      "+    def helper(self):",
      "+        assert self is not None",
    ].join("\n");

    expect(countNewTests(diff).python).toBe(0);
    expect(countAssertions(diff)).toBe(1);
  });

  it("counts executable Rust tests", () => {
    const diff = [
      "diff --git a/tests/evidence.rs b/tests/evidence.rs",
      "--- a/tests/evidence.rs",
      "+++ b/tests/evidence.rs",
      "@@ -0,0 +1,4 @@",
      "+#[test]",
      "+fn proves_behavior() {",
      "+  assert_eq!(actual, expected);",
      "+}",
    ].join("\n");

    expect(countNewTests(diff).rust).toBe(1);
    expect(countAssertions(diff)).toBe(1);
  });

  it("counts Rust tests colocated in ordinary source files", () => {
    const diff = [
      "diff --git a/src/lib.rs b/src/lib.rs",
      "--- a/src/lib.rs",
      "+++ b/src/lib.rs",
      "@@ -0,0 +1,3 @@",
      "+#[test]",
      "+fn proves_behavior() { assert_eq!(actual, expected); }",
    ].join("\n");

    expect(countNewTests(diff).rust).toBe(1);
    expect(countAssertions(diff)).toBe(1);
  });

  it("returns zeros for no tests", () => {
    const result = countNewTests(patch("example.test.ts", "+const x = 42;", "+function doStuff() {}"));
    expect(result.total).toBe(0);
  });

  it("handles mixed languages", () => {
    const diff = [
      patch("ExampleTest.java", "+    @Test"),
      patch("example.test.ts", '+  it("foo", () => {'),
      patch("tests/test_evidence.py", "+def test_bar():"),
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.java).toBe(1);
    expect(result.ts).toBe(1);
    expect(result.python).toBe(1);
    expect(result.total).toBe(3);
  });

  it("parses Git-quoted paths without letting hunk text forge a test-file header", () => {
    const repository = mkdtempSync(join(tmpdir(), "loom-quoted-diff-path-"));
    const production = "quoted\tproduction.ts";
    const testFile = "quoted\tcase.test.ts";
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repository });
      writeFileSync(join(repository, production), "before\n");
      writeFileSync(join(repository, testFile), "before\n");
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", "base"], { cwd: repository });
      writeFileSync(join(repository, production), "before\n++ b/fake.test.ts\nit('forged', () => expect(1).toBe(1));\n");
      writeFileSync(join(repository, testFile), "before\nit('real', () => expect(1).toBe(1));\n");

      const observed = withProjectDir(repository, () => diffFiles([production, testFile]));

      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(observed.diff).toContain('+++ "b/quoted\\tproduction.ts"');
      expect(countNewTests(observed.diff).ts).toBe(1);
      expect(countAssertions(observed.diff)).toBe(1);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("refuses a +++ b/ header forged inside hunk content", () => {
    // A source line whose text is `++ b/fake.test.ts` is rendered by Git as
    // `+++ b/fake.test.ts`. Reading it as a path boundary let two lines in any
    // non-test file claim a test-source language and fabricate new-test proof.
    const diff = [
      "diff --git a/src/helper.py b/src/helper.py",
      "--- a/src/helper.py",
      "+++ b/src/helper.py",
      "@@ -1 +1,3 @@",
      " x",
      "++ b/fake.test.ts",
      '+it("pwned", () => expect(1).toBe(1));',
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("refuses a forged prelude for an entry that never began", () => {
    const diff = [
      "diff --git a/src/helper.py b/src/helper.py",
      "--- a/src/helper.py",
      "+++ b/src/helper.py",
      "@@ -1 +1,2 @@",
      " x",
      "+x",
      "+++ b/fake.test.ts",
      "+it('pwned', () => {});",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
  });

  it("refuses additions with no Git path boundary at all", () => {
    const diff = '+it("unattributed", () => expect(1).toBe(1));';

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });
});

describe("countAssertions (pure)", () => {
  it("counts Java assertions", () => {
    expect(countAssertions(patch(
      "ExampleTest.java",
      "+    assertThat(result).isEqualTo(expected);",
      "+    assertThrows(Exception.class, () -> run());",
      "+    verify(mock).someMethod();",
    ))).toBe(3);
  });

  it("counts TypeScript assertions", () => {
    expect(countAssertions(patch(
      "example.test.ts",
      "+    expect(result).toBe(42);",
      "+    expect(fn).toThrow();",
      "+    expect(arr).toEqual([1, 2]);",
    ))).toBe(3);
  });

  it("counts Python assertions", () => {
    expect(countAssertions(patch(
      "tests/test_evidence.py",
      "+    assert result == 42",
      "+    assertIn('key', data)",
    ))).toBe(2);
  });

  it("ignores removed lines", () => {
    const diff = patch(
      "example.test.ts",
      "-    expect(old).toBe(true);",
      "+    const x = 1;",
    );
    expect(countAssertions(diff)).toBe(0);
  });

  it("does not launder empty tests through matcher text in titles or comments", () => {
    const diff = patch(
      "example.test.ts",
      '+  it("uses toBe and expect(", () => {});',
      "+  // expect(value).toEqual(true)",
      "+  /* assertThat(value).isTrue();",
      "+     pytest.raises(ExpectedError) */",
      "+  const note = `toThrow and .should.`;",
    );

    expect(countNewTests(diff).ts).toBe(1);
    expect(countAssertions(diff)).toBe(0);
  });

  it.each([
    ["Python triple-quoted string", "tests/test_evidence.py", "'''"],
    ["Java text block", "ExampleTest.java", '"""'],
  ])("does not count assertion text inside a %s", (_name, path, delimiter) => {
    const assertion = path.endsWith(".py")
      ? "+    assert result == 42"
      : "+    assertThat(result).isEqualTo(42);";
    const diff = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,8 +1,9 @@",
      ` ${delimiter}`,
      " context one",
      " context two",
      " context three",
      " context four",
      assertion,
      ` ${delimiter}`,
      path.endsWith(".py") ? "+def test_empty(): pass" : "+@Test void empty() {}",
    ].join("\n");

    expect(countNewTests(diff).python + countNewTests(diff).java).toBe(1);
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

  it("rejects JavaScript regex-literal contents as evidence", () => {
    const diff = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1,2 @@",
      "+const pattern = / test(fake) expect(fake) \\/ [a-z/]+/gi;",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("rejects regex contents used as control-flow statement bodies", () => {
    const diff = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1,3 @@",
      "+if (enabled) /.should./.test(value);",
      "+while (ready()) /expect(fake)/.test(value);",
      "+for (; next(); ) /test(fake)/.test(value);",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("rejects regex contents after a statement-closing brace", () => {
    const diff = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1 @@",
      "+if (enabled) {} /test(fake) expect(fake)/.test(value);",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it.each([
    ["TypeScript", "example.test.ts", `const docs = "prose${String.fromCharCode(92)}`, 'test(fake) expect(fake)";'],
    ["Python", "tests/test_evidence.py", `docs = "prose${String.fromCharCode(92)}`, 'def test_fake(): assert fabricated"'],
  ])("does not expose evidence inside a %s line-continuation string", (_language, path, opener, content) => {
    const diff = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -0,0 +1,2 @@",
      `+${opener}`,
      `+${content}`,
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("rejects JSX prose returned directly from a function", () => {
    const diff = [
      "diff --git a/example.test.tsx b/example.test.tsx",
      "--- a/example.test.tsx",
      "+++ b/example.test.tsx",
      "@@ -0,0 +1,3 @@",
      "+function View() { return <div>",
      "+  test(fake) expect(fake)",
      "+</div>; }",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("retains tests after TSX generic-arrow helpers with nested and quoted constraints", () => {
    const diff = [
      "diff --git a/example.test.tsx b/example.test.tsx",
      "--- a/example.test.tsx",
      "+++ b/example.test.tsx",
      "@@ -0,0 +1,4 @@",
      "+const identity = <T,>(value: T) => value;",
      "+const nested = <T extends Record<string, Array<number>>>(value: T) => value;",
      "+const quoted = <T extends Record<'closing>token', number>>(value: T) => value;",
      "+const defaulted = <T = string,>(value: T) => value;",
      "+test('works', () => expect(defaulted(nested(quoted(identity({ value: [1] }))))).toBeDefined());",
    ].join("\n");

    expect(countNewTests(diff).ts).toBe(1);
    expect(countAssertions(diff)).toBe(1);
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

  it("treats #[ as a comment in bound Python sources", () => {
    const diff = [
      "diff --git a/tests/test_evidence.py b/tests/test_evidence.py",
      "--- a/tests/test_evidence.py",
      "+++ b/tests/test_evidence.py",
      "@@ -0,0 +1 @@",
      "+#[docs] def test_fabricated(): assert fabricated",
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it.each([
    ["Python", "tests/test_evidence.py", "'''", "\\'''", "def test_fabricated():", "assert fabricated"],
    ["Java", "ExampleTest.java", '\"\"\"', '\\\"\"\"', "@Test void fabricated() {}", "assertThat(fabricated).isTrue();"],
  ])("keeps evidence inert after an escaped %s triple-quote sequence", (_language, path, delimiter, escaped, test, assertion) => {
    const diff = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -0,0 +1,5 @@",
      `+${delimiter}`,
      `+${escaped}`,
      `+${test}`,
      `+${assertion}`,
      `+${delimiter}`,
    ].join("\n");

    expect(countNewTests(diff).total).toBe(0);
    expect(countAssertions(diff)).toBe(0);
  });

  it("retains executable evidence after non-nesting TypeScript block-comment text", () => {
    const diff = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1,2 @@",
      "+/* outer /* text */",
      "+test('works', () => expect(value).toBe(true));",
    ].join("\n");

    expect(countNewTests(diff).ts).toBe(1);
    expect(countAssertions(diff)).toBe(1);
  });

  it("closes JSX attribute quotes even when preceded by a backslash", () => {
    const diff = [
      "diff --git a/example.test.tsx b/example.test.tsx",
      "--- a/example.test.tsx",
      "+++ b/example.test.tsx",
      "@@ -0,0 +1,2 @@",
      "+const view = <div title=\"ends\\\\\">text</div>;",
      "+test('works', () => expect(value).toBe(true));",
    ].join("\n");

    expect(countNewTests(diff).ts).toBe(1);
    expect(countAssertions(diff)).toBe(1);
  });

  it("rejects multiline Rust ordinary and byte-string contents as evidence", () => {
    for (const prefix of ["", "b"]) {
      const diff = [
        "diff --git a/tests/evidence.rs b/tests/evidence.rs",
        "--- a/tests/evidence.rs",
        "+++ b/tests/evidence.rs",
        "@@ -0,0 +1,4 @@",
        `+let docs = ${prefix}\"`,
        "+#[test]",
        "+assert_eq!(fabricated, true);",
        "+\";",
      ].join("\n");

      expect(countNewTests(diff).total).toBe(0);
      expect(countAssertions(diff)).toBe(0);
    }
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
    const diff = patch(
      "example.test.ts",
      "-  /* deleted unterminated comment",
      "+  expect(result).toBe(true);",
    );

    expect(countAssertions(diff)).toBe(1);
  });

  it("still counts executable assertions containing string arguments", () => {
    const diff = [
      patch("example.test.ts", '+  expect(message).toBe("toEqual in a value");'),
      patch("tests/test_evidence.py", "+  assert reason == 'expect(fake)'"),
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
