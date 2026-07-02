import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyTestCommand,
  extractBashOutcome,
  extractEvidence,
} from "../../src/machine/extract-evidence";

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
    const events = extractEvidence("Bash", { command: "npm test" }, { exit: 0, stdout: "" }, () => report);
    expect(events).toEqual([{ kind: "TestRun", command: "npm test", exit: 0, report }]);

    expect(
      extractEvidence("Bash", { command: 'echo "npm test: 5 passing"' }, { exit: 0, stdout: "5 passing" }, () => null),
    ).toEqual([]);
  });

  it("passes the classified SEGMENT to report discovery, not the whole command", () => {
    let seen = "";
    extractEvidence(
      "Bash",
      { command: "cd pkg && npx vitest run --reporter=json" },
      { exit: 0, stdout: "" },
      (segment) => {
        seen = segment;
        return null;
      },
    );
    expect(seen).toBe("npx vitest run --reporter=json");
  });

  it("maps Read and file-modifying tools; handles path variants", () => {
    expect(extractEvidence("Read", { file_path: "/a" }, { exit: null, stdout: "" }, () => null)).toEqual([
      { kind: "FileRead", path: "/a" },
    ]);
    expect(extractEvidence("Edit", { path: "/b" }, { exit: null, stdout: "" }, () => null)).toEqual([
      { kind: "FileWrite", path: "/b" },
    ]);
    expect(extractEvidence("Write", { file_path: "  " }, { exit: null, stdout: "" }, () => null)).toEqual([]);
    expect(extractEvidence("Grep", { pattern: "x" }, { exit: null, stdout: "" }, () => null)).toEqual([]);
  });
});
