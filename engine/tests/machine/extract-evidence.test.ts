import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyTestCommand,
  extractBashOutcome,
  extractEvidence,
  isToolFailure,
} from "../../src/machine/extract-evidence";
import { TEST_COMMAND_PATTERNS } from "../../src/core/tool-vocabulary";

describe("classifyTestCommand — parse, don't substring-match", () => {
  it("matches runners at segment head", () => {
    expect(classifyTestCommand("npm test")).toBe("npm test");
    expect(classifyTestCommand("cd pkg && npm test")).toBe("npm test");
    expect(classifyTestCommand("npm install; npm test -- --run")).toBe("npm test -- --run");
    expect(classifyTestCommand("mvn test | tee out.log")).toBe("mvn test");
    expect(classifyTestCommand("./gradlew test")).toBe("./gradlew test");
    expect(classifyTestCommand("pytest -x tests/")).toBe("pytest -x tests/");
  });

  it("strips env-var prefixes", () => {
    expect(classifyTestCommand("CI=1 npm test")).toBe("npm test");
    expect(classifyTestCommand("FOO=bar BAZ=1 bun test")).toBe("bun test");
  });

  it("kills the comment spoof: a runner mentioned in a comment is not a run", () => {
    expect(classifyTestCommand(`echo '{"numTotalTests":5,"numFailedTests":0}' # npm test --json`)).toBeNull();
    expect(classifyTestCommand('echo "npm test: 5 passing"')).toBeNull();
    expect(classifyTestCommand("true # mvn test")).toBeNull();
  });

  it("kills the prose spoof: a runner substring inside another command is not a run", () => {
    expect(classifyTestCommand('git grep "npm test" README.md')).toBeNull();
    expect(classifyTestCommand('git commit -m "fix npm test"')).toBeNull();
    expect(classifyTestCommand("cat docs/how-to-run-cargo-test.md")).toBeNull();
  });

  it("requires a token boundary after the runner pattern", () => {
    expect(classifyTestCommand("npm testify")).toBeNull();
    expect(classifyTestCommand("go tester ./...")).toBeNull();
    expect(classifyTestCommand("pytest-benchmark compare")).toBeNull();
    expect(classifyTestCommand("make testdata")).toBeNull();
    // …while real boundaries still classify:
    expect(classifyTestCommand("npm test")).toBe("npm test");
    expect(classifyTestCommand("go test ./...")).toBe("go test ./...");
  });

  it("mvn segments require an actual test goal — `mvn -pl core install` is not a test run", () => {
    expect(classifyTestCommand("mvn -pl core install")).toBeNull();
    expect(classifyTestCommand("mvn -pl core -am compile")).toBeNull();
    // …but goal-carrying maven invocations classify:
    expect(classifyTestCommand("mvn -pl core test")).toBe("mvn -pl core test");
    expect(classifyTestCommand("mvn -pl core -am verify")).toBe("mvn -pl core -am verify");
    expect(classifyTestCommand("mvn test")).toBe("mvn test");
    expect(classifyTestCommand("mvn verify -DskipITs")).toBe("mvn verify -DskipITs");
  });

  it("kills the quoted-separator forgery: a runner inside a quoted string is not a run", () => {
    // The review's verified end-to-end forgery — naive splitting minted a
    // trusted-pass out of this:
    expect(
      classifyTestCommand(
        `true "; npx vitest --reporter=json "; echo '{"numTotalTests":5,"numFailedTests":0}'`,
      ),
    ).toBeNull();
    // Balanced-quote variant of the same shape:
    expect(
      classifyTestCommand(`true "; npm test " ""; echo '{"numTotalTests":5,"numFailedTests":0}'`),
    ).toBeNull();
    // Single quotes and backticks too:
    expect(classifyTestCommand("true '; bun test '; echo done")).toBeNull();
    expect(classifyTestCommand("echo `; cargo test `; echo done")).toBeNull();
  });

  it("comment strip is quote-aware: a quoted '#' is argument text, not a comment", () => {
    // Old behavior stripped from the quoted '#', leaving an unbalanced quote
    // that the fail-closed check then refused — legitimate evidence dropped.
    expect(classifyTestCommand('npm test -- --grep "issue #123"')).toBe(
      'npm test -- --grep "issue #123"',
    );
    expect(classifyTestCommand("pytest -k 'not #slow'")).toBe("pytest -k 'not #slow'");
    // …while an actual trailing comment (unquoted #) still strips:
    expect(classifyTestCommand("echo hi # npm test")).toBeNull();
    expect(classifyTestCommand("npm test # just checking")).toBe("npm test");
  });

  it("env-prefix strip is quote-aware: quoted whitespace in the value stays in the value", () => {
    // Old behavior consumed only up to the first raw space (`FOO="a`),
    // leaving `b" npm test` whose head is not a runner — evidence dropped.
    expect(classifyTestCommand('FOO="a b" npm test')).toBe("npm test");
    expect(classifyTestCommand("NODE_OPTIONS='--max-old-space-size=4096 --trace-warnings' bun test")).toBe(
      "bun test",
    );
    expect(classifyTestCommand('A=1 B="x y" CI=true pytest -x')).toBe("pytest -x");
    // An env-prefix-only segment classifies nothing:
    expect(classifyTestCommand('FOO="a b"')).toBeNull();
  });

  it("refuses to classify segments with unbalanced quotes (fail closed)", () => {
    expect(classifyTestCommand('npm test "unclosed')).toBeNull();
    expect(classifyTestCommand("bun test 'unclosed")).toBeNull();
    expect(classifyTestCommand("cargo test `unclosed")).toBeNull();
    // …while balanced quoting inside a genuine test command still classifies:
    expect(classifyTestCommand('npm test -- --grep "auth flow"')).toBe('npm test -- --grep "auth flow"');
  });

  it("property: runner patterns embedded inside quoted strings never classify", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TEST_COMMAND_PATTERNS),
        fc.constantFrom("&&", "||", ";", "|", "\n"),
        fc.constantFrom('"', "'", "`"),
        fc.constantFrom("true", "echo done", "git status", "printf x"),
        fc.constantFrom("", " --reporter=json", " -x", " --run"),
        (pattern, sep, quote, harmlessHead, flags) => {
          // The quoted string CONTAINS separators + the runner text, so a
          // quote-blind splitter would cut a segment that head-matches.
          const cmd = `${harmlessHead} ${quote}${sep} ${pattern}${flags} ${sep}${quote} ${sep} echo ok`;
          expect(classifyTestCommand(cmd)).toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: commands whose segments never head-match a runner classify null", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ./"'-]{0,80}$/).filter((s) => {
          const heads = ["npm", "npx", "yarn", "pnpm", "bun", "mvn", "gradle", "./gradlew", "./mvnw", "pytest", "python", "cargo", "go ", "dotnet", "mix", "make"];
          return s
            .split(/&&|\|\||;|\||\r?\n/)
            .map((seg) => seg.replace(/(^|\s)#.*$/, "").trim())
            .every((seg) => !heads.some((h) => seg.startsWith(h)));
        }),
        (command) => {
          expect(classifyTestCommand(command)).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("extractBashOutcome — defensive harness-shape parsing", () => {
  it("reads known exit-code field names", () => {
    expect(extractBashOutcome({ exit_code: 1, stdout: "x" })).toEqual({ exit: 1, stdout: "x" });
    expect(extractBashOutcome({ exitCode: 0, stdout: "y" })).toEqual({ exit: 0, stdout: "y" });
    expect(extractBashOutcome({ returnCode: 2 })).toEqual({ exit: 2, stdout: "" });
    expect(extractBashOutcome({ code: 0, output: "z" })).toEqual({ exit: 0, stdout: "z" });
  });

  it("never invents an exit code", () => {
    expect(extractBashOutcome({ exit_code: 1.5 }).exit).toBeNull();
    expect(extractBashOutcome({ exit_code: "0" }).exit).toBeNull();
    expect(extractBashOutcome({ weird: true })).toEqual({ exit: null, stdout: "" });
    expect(extractBashOutcome("raw text")).toEqual({ exit: null, stdout: "raw text" });
    expect(extractBashOutcome(null)).toEqual({ exit: null, stdout: "" });
    expect(extractBashOutcome(undefined)).toEqual({ exit: null, stdout: "" });
  });

  it("interrupted runs have no exit (→ never trusted downstream)", () => {
    expect(extractBashOutcome({ interrupted: true, exit_code: 0, stdout: "5 passing" })).toEqual({
      exit: null,
      stdout: "",
    });
  });
});

describe("extractEvidence — facts only", () => {
  it("emits TestRun facts for classified commands, nothing for prose", () => {
    const report = { total: 3, failed: 0, source: "vitest-json" as const };
    const events = extractEvidence("Bash", { command: "npm test" }, { exit_code: 0, stdout: "" }, () => report);
    expect(events).toEqual([{ kind: "TestRun", command: "npm test", exit: 0, report }]);

    expect(
      extractEvidence("Bash", { command: 'echo "npm test: 5 passing"' }, { exit_code: 0, stdout: "5 passing" }, () => null),
    ).toEqual([]);
  });

  it("passes the classified SEGMENT to report discovery, not the whole command", () => {
    let seen = "";
    extractEvidence(
      "Bash",
      { command: "cd pkg && npx vitest run --reporter=json" },
      { exit_code: 0, stdout: "" },
      (segment) => {
        seen = segment;
        return null;
      },
    );
    expect(seen).toBe("npx vitest run --reporter=json");
  });

  it("maps Read and file-modifying tools; handles path variants", () => {
    expect(extractEvidence("Read", { file_path: "/a" }, {}, () => null)).toEqual([
      { kind: "FileRead", path: "/a" },
    ]);
    expect(extractEvidence("Edit", { path: "/b" }, {}, () => null)).toEqual([
      { kind: "FileWrite", path: "/b" },
    ]);
    expect(extractEvidence("Write", { file_path: "  " }, {}, () => null)).toEqual([]);
    expect(extractEvidence("Grep", { pattern: "x" }, {}, () => null)).toEqual([]);
  });
});

describe("extractEvidence — facts mean the tool SUCCEEDED", () => {
  it("mints no FileRead/FileWrite for error-shaped tool responses", () => {
    for (const errorShape of [
      { is_error: true },
      { isError: true },
      { success: false },
      { error: "old_string not found in file" },
      { error: { code: "ENOENT" } },
    ]) {
      expect(extractEvidence("Read", { file_path: "/a" }, errorShape, () => null)).toEqual([]);
      expect(extractEvidence("Edit", { file_path: "/a" }, errorShape, () => null)).toEqual([]);
      expect(extractEvidence("Write", { file_path: "/a" }, errorShape, () => null)).toEqual([]);
      expect(extractEvidence("MultiEdit", { file_path: "/a" }, errorShape, () => null)).toEqual([]);
    }
  });

  it("still mints for success-shaped and unknown responses (recorder must not starve)", () => {
    for (const okShape of [undefined, null, {}, { type: "text", file: { filePath: "/a" } }, { success: true }, { error: "" }]) {
      expect(extractEvidence("Read", { file_path: "/a" }, okShape, () => null)).toEqual([
        { kind: "FileRead", path: "/a" },
      ]);
    }
  });

  it("Bash keeps minting TestRun on error responses — a failing run IS the ground truth", () => {
    const events = extractEvidence(
      "Bash",
      { command: "npm test" },
      { is_error: true, exit_code: 1, stdout: "3 failing" },
      () => null,
    );
    expect(events).toEqual([{ kind: "TestRun", command: "npm test", exit: 1, report: null }]);
    // …and an error response with no usable exit yields exit: null (never trusted):
    const noExit = extractEvidence("Bash", { command: "npm test" }, { error: "spawn failed" }, () => null);
    expect(noExit).toEqual([{ kind: "TestRun", command: "npm test", exit: null, report: null }]);
  });

  it("isToolFailure recognizes error shapes and nothing else", () => {
    expect(isToolFailure({ is_error: true })).toBe(true);
    expect(isToolFailure({ success: false })).toBe(true);
    expect(isToolFailure({ error: "boom" })).toBe(true);
    expect(isToolFailure({ error: { message: "boom" } })).toBe(true);
    expect(isToolFailure({ is_error: false })).toBe(false);
    expect(isToolFailure({ success: true })).toBe(false);
    expect(isToolFailure({ error: "" })).toBe(false);
    expect(isToolFailure("plain text output")).toBe(false);
    expect(isToolFailure(null)).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
  });
});
