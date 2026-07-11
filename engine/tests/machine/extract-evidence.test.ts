import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  attributeExit,
  classifyTestCommand,
  classifyTestCommandDetailed,
  extractBashOutcome,
  extractEvidence,
  extractShellWriteTargets,
  isToolFailure,
} from "../../src/machine/extract-evidence";
import { judgeTestRun } from "../../src/machine/test-report";
import { reportSummary } from "./report-summary";
import { TEST_COMMAND_PATTERNS } from "../../src/core/tool-vocabulary";

/** The TestRun event extractEvidence minted for a Bash call, or null. */
function mintTestRun(command: string, exit: number, stdout = "") {
  const events = extractEvidence("Bash", { command }, { exit_code: exit, stdout }, () => null);
  const run = events.find((e) => e.kind === "TestRun");
  return run && run.kind === "TestRun" ? run : null;
}

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

describe("classifyTestCommand — backslash escapes mirror sh semantics", () => {
  it('an escaped quote (\\") does not open quote state — the separator after it still splits', () => {
    // A quote-state bug here would swallow the `;` and hide the runner.
    expect(classifyTestCommand('echo \\" ; npm test')).toBe("npm test");
    // …while a REAL quote does open state: the `;` and runner stay inside it.
    expect(classifyTestCommand('echo " ; npm test"')).toBeNull();
  });

  it("an escaped \\# is argument text, not a comment — an unquoted # still truncates", () => {
    expect(classifyTestCommand("npm test \\#not-a-comment")).toBe("npm test \\#not-a-comment");
    expect(classifyTestCommand("npm test # a real comment")).toBe("npm test");
  });

  it("escaped separators do not split: the runner never becomes a segment head", () => {
    expect(classifyTestCommand("echo one\\; npm test")).toBeNull();
    // …while the unescaped separator splits and classifies:
    expect(classifyTestCommand("echo one; npm test")).toBe("npm test");
    // An escaped space inside the head breaks the runner match too:
    expect(classifyTestCommand("npm\\ test")).toBeNull();
  });
});

describe("exit-status ownership — the line's exit is attributed only when provable (fail closed)", () => {
  it("kills the guarded-dead-runner forgery: `false && npx vitest …; true` exit 0 is NOT a passing run", () => {
    // The whole line exits 0 (from `true`) while vitest never executed —
    // the old code credited exit 0 to the vitest segment.
    const run = mintTestRun("false && npx vitest run --outputFile=/tmp/r.json; true", 0);
    expect(run).not.toBeNull();
    expect(run!.exit).toBeNull();
    expect(judgeTestRun(run!.exit, run!.report)).toEqual({ verdict: "untrusted" });
  });

  it("kills the `npm test || true` red-run launderer: exit 0 belongs to the fallback, not the test", () => {
    const run = mintTestRun("npm test || true", 0);
    expect(run!.exit).toBeNull();
    expect(judgeTestRun(run!.exit, run!.report)).toEqual({ verdict: "untrusted" });
  });

  it("exit 0 after `||` is never attributed even when the test IS the last segment", () => {
    // `false || npm test` exit 0 could also be `true || npm test` where the
    // test never ran — ownership is unprovable from the command text.
    const run = mintTestRun("some-flaky-setup || npm test", 0);
    expect(run!.exit).toBeNull();
  });

  it("a nonzero exit after `&&` is not a trusted failure — the guard may have failed, not the test", () => {
    const run = mintTestRun("cd missing-dir && npm test", 1);
    expect(run!.exit).toBeNull();
    expect(judgeTestRun(run!.exit, run!.report)).toEqual({ verdict: "untrusted" });
  });

  it("a nonzero exit after `;` IS the test's — trusted failure stands", () => {
    const run = mintTestRun("echo start; npm test", 1);
    expect(run!.exit).toBe(1);
    expect(judgeTestRun(run!.exit, run!.report)).toEqual({ verdict: "trusted-fail" });
  });

  it("PIN (usability regression guard): `cd engine && bun test` exit 0 keeps its exit — still trustable", () => {
    const run = mintTestRun("cd engine && bun test", 0);
    expect(run!.exit).toBe(0);
    // …and with a report it still judges trusted-pass end to end:
    const report = reportSummary(5, 0);
    const events = extractEvidence(
      "Bash",
      { command: "cd engine && npx vitest run --reporter=json" },
      { exit_code: 0, stdout: "" },
      () => report,
    );
    const testRun = events.find((e) => e.kind === "TestRun");
    expect(testRun && testRun.kind === "TestRun" && judgeTestRun(testRun.exit, testRun.report)).toEqual({
      verdict: "trusted-pass",
    });
  });

  it("multi-line sequencing (newline = `;`): last-segment exits are owned in both polarities", () => {
    expect(mintTestRun("cd engine\nbun test", 0)!.exit).toBe(0);
    expect(mintTestRun("cd engine\nbun test", 1)!.exit).toBe(1);
  });

  it("a sole test command is attributed as-is, both polarities", () => {
    expect(mintTestRun("npm test", 0)!.exit).toBe(0);
    expect(mintTestRun("npm test", 1)!.exit).toBe(1);
  });

  it("a trailing comment or `;` does not demote the test to 'not last'", () => {
    expect(mintTestRun("cd pkg && npm test # verify", 0)!.exit).toBe(0);
    expect(mintTestRun("cd pkg && npm test;", 0)!.exit).toBe(0);
  });

  it("a test masked by a trailing pipe (`mvn test | tee`) never owns exit 0 — tee exits 0 regardless", () => {
    const run = mintTestRun("mvn test | tee out.log", 0);
    expect(run!.exit).toBeNull();
  });

  it("a test at the END of a pipe owns exit 0 (pipeline exit is the last command's)", () => {
    const run = mintTestRun("cat cases.txt | npm test", 0);
    expect(run!.exit).toBe(0);
  });

  it("attributeExit is fail-closed on unknown exits regardless of position", () => {
    const classified = classifyTestCommandDetailed("cd engine && bun test")!;
    expect(attributeExit(null, classified)).toBeNull();
  });
});

describe("extractShellWriteTargets — Bash-authored writes are visible to the veto", () => {
  it("collects >, >>, &> and fd-redirect targets, unquoted", () => {
    expect(extractShellWriteTargets("cat > /tmp/r.json")).toEqual(["/tmp/r.json"]);
    expect(extractShellWriteTargets("echo x >> log.txt")).toEqual(["log.txt"]);
    expect(extractShellWriteTargets("cmd &> all.log")).toEqual(["all.log"]);
    expect(extractShellWriteTargets("cmd 2> err.log")).toEqual(["err.log"]);
    expect(extractShellWriteTargets('cat > "/tmp/my report.json"')).toEqual(["/tmp/my report.json"]);
  });

  it("kills the heredoc staging move: `cat > /tmp/r.json <<EOF …` mints the target", () => {
    const cmd = 'cat > /tmp/r.json <<EOF\n{"numTotalTests":5,"numFailedTests":0}\nEOF';
    expect(extractShellWriteTargets(cmd)).toContain("/tmp/r.json");
  });

  it("collects tee targets (flags skipped), across pipe segments", () => {
    expect(extractShellWriteTargets("npm test | tee out.log")).toEqual(["out.log"]);
    expect(extractShellWriteTargets("npm test | tee -a a.log b.log")).toEqual(["a.log", "b.log"]);
  });

  it("fd dups and input redirects are not write targets; quoted '>' is argument text", () => {
    expect(extractShellWriteTargets("npm test 2>&1")).toEqual([]);
    expect(extractShellWriteTargets("sort < in.txt")).toEqual([]);
    expect(extractShellWriteTargets('grep ">" file.txt')).toEqual([]);
    expect(extractShellWriteTargets("echo hi # > not-a-write.txt")).toEqual([]);
  });

  it("`>&<digit><path>` is a filename redirect, not an fd dup — the target IS minted (round-16 bypass)", () => {
    // Bash duplicates an fd only when the ENTIRE `>&` word is digits (or
    // exactly `-`); `2/../report.json` is a filename, and missing it left a
    // fabricated report invisible to the agent-authored-artifact veto.
    expect(extractShellWriteTargets("echo X >&2/../report.json")).toEqual(["2/../report.json"]);
    expect(extractShellWriteTargets("echo X >&2foo")).toEqual(["2foo"]);
    // Whole-word dups and the fd close form still mint nothing.
    expect(extractShellWriteTargets("cmd >&2")).toEqual([]);
    expect(extractShellWriteTargets("cmd 2>&1")).toEqual([]);
    expect(extractShellWriteTargets("cmd >&-")).toEqual([]);
  });

  it("decodes an ANSI-C `$'…'` redirect target — twin parity with the guard (round-18)", () => {
    // Round-17 taught the guard to SEE `> $'\x2e…'`; the evidence scanner must
    // MINT the same decoded path, or a FileWrite into an escape-encoded target
    // reads as garbage and escapes the agent-authored-artifact veto.
    // `$'\x2e\x63\x6c\x61\x75\x64\x65'` → `.claude`:
    expect(
      extractShellWriteTargets("echo X > $'\\x2e\\x63\\x6c\\x61\\x75\\x64\\x65'"),
    ).toEqual([".claude"]);
    // NUL is dropped, matching bash and the guard: `a\x00b` → `ab`.
    expect(extractShellWriteTargets("echo X > a$'\\x00'b")).toEqual(["ab"]);
  });

  it("drops a `\\`-newline continuation in a redirect target — twin parity (round-18)", () => {
    // Bash rejoins the token; keeping the newline would split the minted path.
    expect(extractShellWriteTargets("echo X > /tmp/re\\\nport.json")).toEqual(["/tmp/report.json"]);
  });

  it("extractEvidence mints Bash FileWrites BEFORE the TestRun — a test's own redirect never reads as write-after-pass", () => {
    const events = extractEvidence(
      "Bash",
      { command: "npm test 2>&1 | tee /tmp/test.log" },
      { exit_code: 0, stdout: "" },
      () => null,
    );
    expect(events.map((e) => e.kind)).toEqual(["FileWrite", "TestRun"]);
    expect(events[0]).toEqual({ kind: "FileWrite", path: "/tmp/test.log", via: "shell" });
  });

  it("a redirect-only Bash call mints FileWrite even on an error-shaped response (the shell truncates the target before the command runs)", () => {
    const events = extractEvidence(
      "Bash",
      { command: "cat > /tmp/r.json" },
      { is_error: true, exit_code: 1 },
      () => null,
    );
    expect(events).toEqual([{ kind: "FileWrite", path: "/tmp/r.json", via: "shell" }]);
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
    const report = reportSummary(3, 0);
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
      { kind: "FileWrite", path: "/b", via: "tool" },
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

describe("unquoted & — background compositions (round-10 Fix 3)", () => {
  it("a backgrounded test never owns the line's exit: `npx vitest &` → exit null", () => {
    // The shell reports 0 immediately without waiting for the test.
    expect(mintTestRun("npx vitest run &", 0)!.exit).toBeNull();
    expect(mintTestRun("npm test &", 0)!.exit).toBeNull();
    expect(mintTestRun("npm test & echo done", 0)!.exit).toBeNull();
  });

  it("`X & npm test`: the foreground test owns the exit (both polarities — `&` sequences unconditionally)", () => {
    expect(mintTestRun("false & npm test", 0)!.exit).toBe(0);
    expect(mintTestRun("false & npm test", 1)!.exit).toBe(1);
  });

  it("`&` splits segments: a runner after `&` classifies; a quoted `&` does not split", () => {
    expect(classifyTestCommand("sleep 1 & npm test")).toBe("npm test");
    expect(classifyTestCommand('echo "a & npm test"')).toBeNull();
  });

  it("`&>` redirects and `2>&1` fd dups are NOT background separators", () => {
    // `npm test &> log`: the `&` belongs to the redirect — sole segment, owns exit.
    expect(mintTestRun("npm test &> /tmp/all.log", 0)!.exit).toBe(0);
    expect(mintTestRun("npm test 2>&1", 1)!.exit).toBe(1);
    // …and the &> target is still a shell write.
    expect(extractShellWriteTargets("npm test &> /tmp/all.log")).toEqual(["/tmp/all.log"]);
  });

  it("classifyTestCommandDetailed exposes opAfter '&' even with only blank text after it", () => {
    const c = classifyTestCommandDetailed("npx vitest run &")!;
    expect(c.opAfter).toBe("&");
    expect(attributeExit(0, c)).toBeNull();
  });

  it("`|&` is ONE pipe op (bash `2>&1 |`), never a pipe + spurious background segment (round-15)", () => {
    // A runner downstream of |& classifies with opBefore "|" — previously the
    // mis-parsed `&` emitted an empty backgrounded segment and the runner's
    // opBefore read "&".
    expect(classifyTestCommand("make build |& npm test")).toBe("npm test");
    const c = classifyTestCommandDetailed("make build |& npm test")!;
    expect(c.opBefore).toBe("|");
    expect(c.isLast).toBe(true);
    // Last segment through a pipe owns exit 0, exactly like a plain `|`.
    expect(attributeExit(0, c)).toBe(0);
    // A test BEFORE |& is not the last command and never owns the exit —
    // and its opAfter is the pipe, not a phantom background `&`.
    const before = classifyTestCommandDetailed("npm test |& tee log.txt")!;
    expect(before.opAfter).toBe("|");
    expect(mintTestRun("npm test |& tee log.txt", 0)!.exit).toBeNull();
  });
});

describe("extractShellWriteTargets — backslash-escape property (round-10 gap 19)", () => {
  // Simple filename material with no shell metacharacters.
  const plainName = fc
    .stringMatching(/^[A-Za-z0-9._/-]{1,20}$/)
    .filter((s) => !s.includes("..") && !s.startsWith("-"));

  it("an escaped `\\>` never mints a write target; a real `>` always does", () => {
    fc.assert(
      fc.property(plainName, (name) => {
        // `echo a \> f` passes a literal ">" argument — nothing is written.
        expect(extractShellWriteTargets(`echo a \\> ${name}`)).toEqual([]);
        // The unescaped twin writes the file.
        expect(extractShellWriteTargets(`echo a > ${name}`)).toEqual([name]);
      }),
    );
  });

  it("backslash-escaped characters INSIDE a target are preserved unescaped", () => {
    fc.assert(
      fc.property(plainName, plainName, (a, b) => {
        // `> a\ b` writes the single file "a b" (escaped space).
        expect(extractShellWriteTargets(`cmd > ${a}\\ ${b}`)).toEqual([`${a} ${b}`]);
      }),
    );
  });

  it("a trailing backslash never crashes a scanner and mints nothing beyond the text", () => {
    fc.assert(
      fc.property(plainName, (name) => {
        expect(() => extractShellWriteTargets(`echo ${name} \\`)).not.toThrow();
        expect(() => extractShellWriteTargets(`cmd > ${name}\\`)).not.toThrow();
      }),
    );
  });
});
