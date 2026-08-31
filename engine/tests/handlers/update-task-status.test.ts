import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import updateTaskStatus, { isMachineBound } from "../../src/handlers/subagent-stop/update-task-status";
import { resolveTestEvidence } from "../../src/core/implementation-evidence";
import { analyzeNewTests } from "../../src/handlers/helpers/task-local-completion";
import { extractTestEvidence, type TestEvidence } from "../../src/core/test-evidence";
import { legacyTestsPassedNote } from "../../src/types";
import type { TaskGraph } from "../../src/types";
import { captureDeclaredArtifactBaseline } from "../../src/utils/artifact-baseline";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { StateManager } from "../../src/state-manager";

describe("update-task-status — malformed stdin guard (directly-registered route)", () => {
  it("returns a contextual error naming that status/evidence was NOT updated, not a bare throw", async () => {
    const result = await updateTaskStatus("this is not json", []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("invalid SubagentStop input");
      expect(result.message).toContain("NOT updated");
    }
  });

  it.each(["null", "42", "[]", JSON.stringify({ session_id: "session-1", agent_type: 7 })])(
    "rejects valid JSON outside the SubagentStop domain: %s",
    async (stdin) => {
      const result = await updateTaskStatus(stdin, []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/invalid SubagentStop input.*NOT updated/),
      });
    },
  );

  it.each([
    ["absent", `missing-implementation-session-${process.pid}-${Date.now()}`],
    ["malformed", "../../invalid implementation session"],
  ])("fails closed for a recognized implementation stop with %s TaskGraph authority", async (_label, sessionId) => {
    const result = await updateTaskStatus(JSON.stringify({
      session_id: sessionId,
      agent_type: "code-implementer-agent",
    }), []);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/TaskGraph authority unavailable.*task status and test evidence NOT updated|session TaskGraph authority unavailable/),
    });
  });

  it("rejects an unnameable direct implementation result", async () => {
    const result = await updateTaskStatus(JSON.stringify({ session_id: "session-1" }), []);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/Agent identity is unavailable.*NOT updated/),
    });
  });
});
import { parseMachineJson } from "../../src/machine";
import type { Evidence, LoadedMachine } from "../../src/machine";
import { reportSummary } from "../machine/report-summary";

describe("legacyTestsPassedNote (pure)", () => {
  it("flags a pre-refactor task carrying tests_passed without test_result", () => {
    const note = legacyTestsPassedNote({ id: "T1", tests_passed: true });
    expect(note).toContain("legacy tests_passed found on task T1");
    expect(note).toContain("re-run task or regenerate graph");
    expect(note).toContain("replaced by test_result");
  });

  it("flags the legacy field regardless of its value (presence, not truthiness)", () => {
    expect(legacyTestsPassedNote({ id: "T1", tests_passed: false })).not.toBeNull();
    expect(legacyTestsPassedNote({ id: "T1", tests_passed: null })).not.toBeNull();
  });

  it("stays silent when test_result is present alongside the stray field, or the field is absent", () => {
    expect(
      legacyTestsPassedNote({ id: "T1", tests_passed: true, test_result: { verdict: "trusted-pass" } }),
    ).toBeNull();
    expect(legacyTestsPassedNote({ id: "T1", test_result: { verdict: "trusted-pass" } })).toBeNull();
    expect(legacyTestsPassedNote({ id: "T1" })).toBeNull();
  });

  it("handles non-object and id-less input without throwing", () => {
    expect(legacyTestsPassedNote(null)).toBeNull();
    expect(legacyTestsPassedNote("task")).toBeNull();
    expect(legacyTestsPassedNote({ tests_passed: true })).toContain("<unknown>");
  });
});

describe("extractTestEvidence (pure)", () => {
  it("detects Maven BUILD SUCCESS", () => {
    const output = "BUILD SUCCESS\nTests run: 42, Failures: 0, Errors: 0";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("maven");
    expect(result.evidence).toContain("Tests run: 42");
  });

  it("strips markdown bold from Maven output", () => {
    const output = "**BUILD SUCCESS**\n**Tests run: 5, Failures: 0, Errors: 0**";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("maven");
  });

  it("rejects Maven with failures", () => {
    const output = "BUILD SUCCESS\nTests run: 10, Failures: 2, Errors: 0";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("detects Node/Mocha passing", () => {
    const output = "  15 passing (2s)";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("node");
  });

  it("requires Node/Mocha passing prose to occupy a complete summary line", () => {
    expect(extractTestEvidence("Release note: 15 passing checks after cleanup")).toEqual({
      passed: false,
      evidence: "",
    });
  });

  it("rejects Node with failing tests", () => {
    const output = "  10 passing\n  3 failing";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("detects Vitest passing", () => {
    const output = "Tests  36 passed (36)\n Test Files  3 passed (3)";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("vitest");
  });

  it("rejects Vitest with failed", () => {
    const output = "Tests  30 passed\n Tests  2 failed";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("treats a pipe-delimited mixed Vitest summary as one failed verdict", () => {
    expect(extractTestEvidence("Tests  1 failed | 29 passed (30)")).toEqual({
      passed: false,
      evidence: "vitest: Tests  1 failed | 29 passed (30)",
    });
  });

  it("lets a later mixed Vitest failure supersede an earlier passing run", () => {
    expect(extractTestEvidence("Tests  30 passed (30)\n\nTests  2 failed | 28 passed (30)")).toEqual({
      passed: false,
      evidence: "vitest: Tests  2 failed | 28 passed (30)",
    });
  });

  it("makes empty passing evidence unrepresentable", () => {
    if (false) {
      // @ts-expect-error A passing verdict must carry parser-minted non-empty evidence.
      const impossible: TestEvidence = { passed: true, evidence: "" };
      void impossible;
    }
    expect(extractTestEvidence("Tests  1 passed (1)").evidence).not.toBe("");
  });

  it("detects pytest passing", () => {
    const output = "===== 8 passed in 0.5s =====";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("pytest");
  });

  it("rejects pytest with failures", () => {
    // The REAL pytest summary shape: one line, failures FIRST. A non-zero
    // failure tally on the same line as the pass tally is one verdict unit
    // and must veto it. The former fixture (`6 passed, 2 failed`) never
    // matched the pass regex at all (no `in X.XXs` suffix), so that case was
    // green for the wrong reason.
    const output = "===== 2 failed, 6 passed in 0.42s =====";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("keeps the cross-line exemption: a superseded failing run does not veto a later passing run", () => {
    const output = "===== 3 failed, 12 passed in 0.9s =====\n\n===== 15 passed in 0.5s =====";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("15 passed");
  });

  it("detects bun test passing", () => {
    const output = " 409 pass\n 0 fail\n 16856 expect() calls\nRan 409 tests across 13 files. [2.28s]";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("bun");
  });

  it("rejects bun test with failures", () => {
    const output = " 408 pass\n 1 fail\n 16856 expect() calls";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("detects bun test pass-only (no fail line)", () => {
    const output = " 26 pass\n 63 expect() calls";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("bun");
  });

  it("returns false for no test output", () => {
    const result = extractTestEvidence("just some code output");
    expect(result.passed).toBe(false);
    expect(result.evidence).toBe("");
  });

  // --- Round-12: anchored matchers reject prose the OLD regex accepted ---

  it("pytest prose without the 'in X.XXs' timing suffix is NOT read as passing (round-12 anchor)", () => {
    // The old unanchored /(\d+) passed/ matched this; the timing anchor now
    // requires the runner-summary shape, so prose can't mint a passing result.
    const result = extractTestEvidence("3 passed review");
    expect(result.passed).toBe(false);
    expect(result.evidence).toBe("");
  });

  it("bun-style mid-sentence prose 'all 5 pass rates' is NOT read as passing (round-12 anchor)", () => {
    // The old /(\d+) pass\b/ matched mid-line; the line-start anchor now
    // requires the counter to open the line, so prose can't mint a pass.
    const result = extractTestEvidence("all 5 pass rates");
    expect(result.passed).toBe(false);
    expect(result.evidence).toBe("");
  });

  // --- Tests for multiple test runs (T11 fix) ---

  it.each([
    ["pass before failure", "  2 passing (5ms)\nTests  1 failed"],
    ["failure before pass", "Tests  1 failed\n  2 passing (5ms)"],
  ])("aggregates recognized runners so a cross-runner failure dominates: %s", (_label, output) => {
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("node: 2 passing (5ms)");
    expect(result.evidence).toContain("vitest: Tests  1 failed");
  });

  it("aggregates passing evidence from every recognized runner", () => {
    const result = extractTestEvidence("  2 passing (5ms)\nTests  3 passed (3)");
    expect(result).toEqual({
      passed: true,
      evidence: "node: 2 passing (5ms); vitest: Tests  3 passed (3)",
    });
  });

  it("uses last match for bun: first fails, last passes", () => {
    const output = "3 pass\n2 fail\nRan 5 tests\n\n289 pass\n0 fail\nRan 289 tests";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("bun");
    expect(result.evidence).toContain("289 pass");
  });

  it("uses last match for bun: first passes, last fails", () => {
    const output = "10 pass\n0 fail\nRan 10 tests\n\n8 pass\n2 fail\nRan 10 tests";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("uses last match for mocha: first fails, last passes", () => {
    const output = "  5 passing\n  2 failing\n\n  42 passing";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("node");
    expect(result.evidence).toContain("42 passing");
  });

  it("uses last match for vitest: first fails, last passes", () => {
    const output = "Tests  5 passed\n Tests  2 failed\n\nTests  25 passed";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("vitest");
    expect(result.evidence).toContain("25 passed");
  });

  it("uses last match for pytest: first fails, last passes", () => {
    const output = "===== 3 passed, 1 failed =====\n\n===== 15 passed in 0.5s =====";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("pytest");
    expect(result.evidence).toContain("15 passed");
  });

  it("uses last match for cargo: first fails, last passes", () => {
    const output = "test result: FAILED. 5 passed; 1 failed\n\ntest result: ok. 20 passed; 0 failed";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("cargo");
    expect(result.evidence).toContain("20 passed");
  });

  it("uses last match for maven: first fails, last passes", () => {
    const output = "BUILD SUCCESS\nTests run: 10, Failures: 2, Errors: 0\n\nBUILD SUCCESS\nTests run: 15, Failures: 0, Errors: 0";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("maven");
    expect(result.evidence).toContain("Tests run: 15");
  });

  it("uses last match for maven: first passes, last fails", () => {
    // A re-run that broke (or a later failing module in the same output) must
    // not launder into a pass off the superseded run's BUILD SUCCESS — the
    // runner loop's last-verdict-wins rule, mirrored for maven.
    const output = "Tests run: 15, Failures: 0, Errors: 0\nBUILD SUCCESS\n\nTests run: 10, Failures: 2, Errors: 0\nBUILD FAILURE";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("a later non-zero maven Errors tally vetoes an earlier pass", () => {
    const output = "Tests run: 15, Failures: 0, Errors: 0\nBUILD SUCCESS\n\nTests run: 10, Failures: 0, Errors: 3\nBUILD FAILURE";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
  });

  it("keeps the cross-line exemption for maven: a superseded failing run does not veto a later passing run", () => {
    const output = "Tests run: 5, Failures: 1, Errors: 0\nBUILD FAILURE\n\nTests run: 5, Failures: 0, Errors: 0\nBUILD SUCCESS";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("maven");
  });

  it("handles 3+ test runs, uses last", () => {
    const output = "5 pass\n2 fail\n\n10 pass\n1 fail\n\n50 pass\n0 fail";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("50 pass");
  });
});

describe("resolveTestEvidence — stale trusted failure vs later untrusted run (pure)", () => {
  const trustedFail: Evidence = { kind: "TestRun", command: "npm test", exit: 1, report: null };
  const untrustedExitZero: Evidence = { kind: "TestRun", command: "npm test", exit: 0, report: null };

  it("[fail, untrusted exit-0] routes to the labeled low-trust fallback — the stale failure does not outrank it", () => {
    const resolved = resolveTestEvidence([trustedFail, untrustedExitZero], "12 passing", true);
    // never promoted to a trusted pass — the verdict stays untrusted, labeled
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "low-trust (exit 0, no report artifact; transcript-regex)",
      provenance: "unverified",
    });
    expect(resolved.evidence).toContain("low-trust");
  });

  it("[fail, untrusted exit-0] with no transcript signal stays failed and untrusted (never promoted)", () => {
    const resolved = resolveTestEvidence([trustedFail, untrustedExitZero], "no test output here", true);
    expect(resolved.result.verdict).toBe("untrusted");
    expect(resolved.result.verdict === "untrusted" && resolved.result.passed).toBe(false);
  });

  it("a trusted failure with no later exit-0 run keeps its trusted verdict", () => {
    const resolved = resolveTestEvidence([untrustedExitZero, trustedFail], "12 passing", true);
    expect(resolved.result).toEqual({ verdict: "trusted-fail" });
    expect(resolved.evidence).toContain("ledger: exit 1");
  });
});

describe("resolveTestEvidence — a trusted pass goes stale when files change after it (pure)", () => {
  const trustedPass: Evidence = {
    kind: "TestRun",
    command: "npm test",
    exit: 0,
    report: reportSummary(5, 0),
  };
  const fileWrite: Evidence = { kind: "FileWrite", path: "/src/thing.ts", via: "tool" };
  const fileRead: Evidence = { kind: "FileRead", path: "/src/thing.ts" };

  it("[pass, FileWrite] demotes to the labeled low-trust path — the pass vouched for old code", () => {
    const resolved = resolveTestEvidence([trustedPass, fileWrite], "12 passing", true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "low-trust (files modified after last trusted pass; transcript-regex)",
      provenance: "unverified",
    });
    expect(resolved.evidence).toContain("files modified after last trusted pass");
  });

  it("[pass, FileWrite] with no transcript signal is an untrusted non-pass, same label", () => {
    const resolved = resolveTestEvidence([trustedPass, fileWrite], "no test output", true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "low-trust (files modified after last trusted pass; transcript-regex)",
      provenance: "unverified",
    });
  });

  it("FileWrite BEFORE the deciding pass does not demote (write → test → pass is the happy path)", () => {
    const resolved = resolveTestEvidence([fileWrite, trustedPass], "", true);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
  });

  it("FileRead after the pass does not demote — only modifications invalidate it", () => {
    const resolved = resolveTestEvidence([trustedPass, fileRead], "", true);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
  });

  it("write-after-pass followed by a NEW trusted pass is trusted again", () => {
    const resolved = resolveTestEvidence([trustedPass, fileWrite, trustedPass], "", true);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
  });
});

describe("isMachineBound — an invalid machine still counts as bound (pure)", () => {
  it("kind 'machine' and kind 'invalid' are bound; only 'none' is unbound", () => {
    const parsed = parseMachineJson(JSON.stringify({
      agent: "good-agent",
      enforcedTools: ["Edit"],
      phases: [
        { id: "a", allowedTools: [], advance: { event: "FileRead" } },
        { id: "z", terminal: true, allowedTools: ["Edit"], requires: [] },
      ],
    }));
    if (!parsed.ok) throw new Error(parsed.error);
    const machine: LoadedMachine = { kind: "machine", machine: parsed.value };
    const invalid: LoadedMachine = { kind: "invalid", error: "corrupt json" };
    const none: LoadedMachine = { kind: "none" };

    expect(isMachineBound(machine)).toBe(true);
    expect(isMachineBound(invalid)).toBe(true); // bound-but-broken → "degraded", never "fallback"
    expect(isMachineBound(none)).toBe(false);
  });

  it("an invalid machine with an empty ledger resolves to the degraded label, not fallback", () => {
    const invalid: LoadedMachine = { kind: "invalid", error: "corrupt json" };
    const resolved = resolveTestEvidence([], "12 passing", isMachineBound(invalid));
    expect(resolved.result.verdict).toBe("untrusted");
    expect(resolved.result.verdict === "untrusted" && resolved.result.label).toContain("degraded");
  });
});

describe("resolveTestEvidence — snapshot-read-failed labeling (pure)", () => {
  it("snapshotFailed routes to the transcript fallback with the snapshot-read-failed label, never 'degraded'", () => {
    const resolved = resolveTestEvidence([], "12 passing", true, true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      provenance: "unverified",
    });
    expect(resolved.evidence).toContain("snapshot-read-failed");
  });

  it("snapshotFailed + no transcript pass markers → untrusted failure with the same label", () => {
    const resolved = resolveTestEvidence([], "no test output at all", true, true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      provenance: "unverified",
    });
  });

  it("snapshotFailed never mints a trusted verdict even if events are (wrongly) supplied", () => {
    const trustedPass = {
      kind: "TestRun" as const,
      command: "npm test",
      exit: 0,
      report: reportSummary(5, 0),
    };
    const resolved = resolveTestEvidence([trustedPass], "12 passing", true, true);
    expect(resolved.result.verdict).toBe("untrusted");
    expect(resolved.result.verdict === "untrusted" && resolved.result.label).toContain(
      "snapshot-read-failed",
    );
  });
});

/**
 * New-test evidence is path-bound: every counted line must belong to a path Git
 * named in that entry's header. These fixtures therefore carry the real patch
 * shape rather than loose `+lines`.
 */
const patch = (path: string, ...lines: string[]): string => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -0,0 +1 @@",
  ...lines,
].join("\n");

describe("analyzeNewTests (pure)", () => {
  it("detects Java @Test methods with assertions", () => {
    const diff = patch(
      "ExampleTest.java",
      "+    @Test",
      "+    void shouldWork() {",
      "+    assertThat(result).isEqualTo(42);",
    );
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(true);
    expect(result.evidence).toContain("1 new test");
    expect(result.evidence).toContain("assertion");
  });

  it("rejects test stubs with no assertions", () => {
    const diff = patch(
      "ExampleTest.java",
      "+    @Test",
      "+    void stubTest() {",
      "+    }",
    );
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(false);
    expect(result.evidence).toContain("0 assertions");
  });

  it("records migration provenance when legacy new_tests_required=false waives new tests", () => {
    const diff = patch("ExampleTest.java", "+    @Test", "+    assertThat(x).isTrue();");
    const result = analyzeNewTests(diff, false);
    expect(result.written).toBe(false);
    expect(result.evidence).toContain(
      "verification_policy.new_tests waived: legacy-new-tests-required-false",
    );
  });

  it("detects TypeScript tests with expect()", () => {
    const diff = patch(
      "example.test.ts",
      '+  it("works", () => {',
      "+    expect(result).toBe(42);",
    );
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(true);
    expect(result.evidence).toContain("ts");
  });

  it("refuses an executable-looking diff in an ordinary source path", () => {
    const diff = patch(
      "src/production.ts",
      '+  it("works", () => {',
      "+    expect(result).toBe(42);",
    );
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(false);
    expect(result.evidence).toBe("");
  });

  it("refuses a +++ b/ header forged inside patch content as a language switch", () => {
    // Two lines added to any non-test file used to satisfy the whole new-test
    // obligation: the forged header made Git's own rendering of the following
    // line look like a test-source boundary.
    const diff = [
      "diff --git a/src/helper.py b/src/helper.py",
      "--- a/src/helper.py",
      "+++ b/src/helper.py",
      "@@ -1 +1,3 @@",
      " x",
      "++ b/fake.test.ts",
      '+it("pwned", () => expect(1).toBe(1));',
    ].join("\n");

    expect(analyzeNewTests(diff, undefined).written).toBe(false);
  });

  it("refuses unattributed additions with no Git path boundary", () => {
    const diff = '+  it("works", () => {\n+    expect(result).toBe(42);';
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(false);
    expect(result.evidence).toBe("");
  });

  it("returns empty for no tests in diff", () => {
    const diff = patch("example.test.ts", "+const x = 42;", "+function foo() {}");
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(false);
    expect(result.evidence).toBe("");
  });
});

/**
 * Harness compatibility: SubagentStop without `agent_transcript_path`.
 *
 * This handler owns task-status settlement for the SubagentStop implementation
 * completion path, and it resolves the task id from the transcript (falling
 * back to a single-entry `executing_tasks`). A harness that sends no transcript
 * path therefore recorded NOTHING — tasks
 * stayed `pending`, `test_result` stayed null, and not one line reached stderr
 * saying so, while the transcript sat on disk the whole time.
 */
describe("update-task-status — transcript path resolution", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const undo of cleanup.splice(0)) undo();
  });

  /**
   * A session with a task graph, a bound state pointer, and — when asked — a
   * transcript planted exactly where the harness writes one.
   */
  async function makeSession(opts: {
    plantTranscript: boolean;
    modifiedPath?: string;
    transcriptTaskId?: string;
    failedReview?: boolean;
    executingTasks?: readonly string[];
    proof?: TaskGraph["tasks"][number]["proof"];
  }): Promise<{
    session: string;
    agentId: string;
    read: () => TaskGraph;
  }> {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const { projectSlug } = await import("../../src/utils/agent-transcript-path");
    const stamp = `${process.pid}${Date.now()}${Math.random().toString(36).slice(2)}`;
    const session = `uts-${stamp}`;
    const agentId = `a${stamp}`;

    const tmpRoot = join(tmpdir(), `uts-${stamp}`);
    mkdirSync(tmpRoot, { recursive: true });
    // macOS tmpdir() sits behind /var → /private/var; the anchored primitives
    // resolve the base once, so the fixture root must be canonical too.
    const tmpDir = realpathSync.native(tmpRoot);
    const configDir = join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    const statePath = join(tmpDir, "graph.json");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    // A case that plants a write into THIS repository must declare this
    // repository as the project: the handler canonicalizes modified paths
    // against the live `CLAUDE_PROJECT_DIR`, so a temp project dir plus a
    // real-repo path is a combination production cannot produce, and it only
    // used to pass because the git helpers answered from a root frozen at
    // import time. Transcript isolation still comes from CLAUDE_CONFIG_DIR
    // and the unique session id, not from the project dir.
    const projectDir = opts.modifiedPath ? repoRoot : join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const artifactBaseline = opts.modifiedPath
      ? captureDeclaredArtifactBaseline(repoRoot, ["engine/src/types.ts"])
      : undefined;
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      executing_tasks: opts.executingTasks ?? [],
      tasks: [
        {
          id: "T1", description: "a task", agent: "code-implementer-agent", status: "pending", wave: 1, depends_on: [],
          ...(opts.proof === undefined ? {} : { proof: opts.proof }),
          ...(opts.failedReview ? {
            review_status: "evidence_capture_failed",
            review_error: "review transcript missing evidence",
            review_evidence_failures: ["code-reviewer"],
          } : {}),
          ...(opts.modifiedPath ? {
            file_list: ["engine/src/types.ts"],
            artifact_baseline: artifactBaseline,
          } : {}),
        },
        ...((opts.executingTasks ?? []).includes("T2") ? [{
          id: "T2", description: "concurrent task", agent: "code-implementer-agent",
          status: "pending", wave: 1, depends_on: [],
        }] : []),
      ],
      wave_gates: {},
    }));

    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);

    if (opts.plantTranscript) {
      const dir = join(configDir, "projects", projectSlug(projectDir), session, "subagents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `agent-${agentId}.jsonl`),
        JSON.stringify({
          type: "assistant",
          message: { content: [
            { type: "text", text: `**Task ID:** ${opts.transcriptTaskId ?? "T1"}\n\nImplemented the thing.` },
            ...(opts.modifiedPath
              ? [{ type: "tool_use", name: "Write", input: { file_path: opts.modifiedPath } }]
              : []),
          ] },
        }) + "\n",
      );
    }

    const prevConfig = process.env.CLAUDE_CONFIG_DIR;
    const prevProject = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    cleanup.push(() => {
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfig;
      if (prevProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProject;
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(pointer, { force: true });
    });

    return { session, agentId, read: (): TaskGraph => JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph };
  }

  it("resolves the task from the DERIVED transcript when the payload names none", async () => {
    const s = await makeSession({ plantTranscript: true, executingTasks: ["T1"] });

    const result = await updateTaskStatus(JSON.stringify({
      session_id: s.session,
      agent_id: s.agentId,
      agent_type: "code-implementer-agent",
      // No agent_transcript_path — exactly what the harness sends.
    }), []);

    expect(result.kind).toBe("passthrough");
    const task = s.read().tasks.find((t) => t.id === "T1");
    expect(task?.status, "untrusted transcript evidence must not claim implementation").toBe("pending");
    expect(task?.proof?.state).toBe("failed");
  });

  it("fails loudly when the transcript names a task outside the graph", async () => {
    const s = await makeSession({ plantTranscript: true, transcriptTaskId: "T999" });

    const result = await updateTaskStatus(JSON.stringify({
      session_id: s.session,
      agent_id: s.agentId,
      agent_type: "code-implementer-agent",
    }), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("unknown task T999");
      expect(result.message).toContain("known tasks: T1");
      expect(result.message).toContain("evidence was NOT stored");
    }
    expect(s.read().tasks[0]?.status).toBe("pending");
  });

  it("canonicalizes transcript paths but does not treat an attempted no-op Write as artifact proof", async () => {
    const s = await makeSession({
      plantTranscript: true,
      modifiedPath: join(dirname(fileURLToPath(import.meta.url)), "../../src/types.ts"),
      failedReview: true,
      executingTasks: ["T1"],
    });

    const result = await updateTaskStatus(JSON.stringify({
      session_id: s.session,
      agent_id: s.agentId,
      agent_type: "code-implementer-agent",
    }), []);

    expect(result.kind).toBe("passthrough");
    const task = s.read().tasks.find((candidate) => candidate.id === "T1");
    expect(task?.files_modified).toEqual(["engine/src/types.ts"]);
    expect(task?.review_status).toBe("pending");
    expect(task?.review_error).toBeUndefined();
    expect(task?.review_evidence_failures).toBeUndefined();
    expect(task?.proof?.obligations).toContainEqual({
      kind: "declared-artifact-changed",
      artifact: "engine/src/types.ts",
    });
    expect(task?.proof?.results).toContainEqual(expect.objectContaining({
      state: "failed",
      failure: { kind: "declared-artifact-not-changed", artifact: "engine/src/types.ts" },
    }));
  });

  it("quarantines the sole proof-bearing executing Task when its resolved transcript becomes unreadable", async () => {
    const proof = derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: [] });
    const s = await makeSession({ plantTranscript: false, executingTasks: ["T1"], proof });
    expect(s.read().tasks[0]?.proof).toEqual(proof);
    const unreadableTranscript = canonicalTempDir("loom-unreadable-transcript-");
    try {
      const result = await updateTaskStatus(JSON.stringify({
        session_id: s.session,
        agent_id: s.agentId,
        agent_type: "code-implementer-agent",
        agent_transcript_path: unreadableTranscript,
      }), []);

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("cannot read transcript"),
      });
      if (result.kind === "error") expect(result.message).toContain("quarantined T1");
      expect(s.read().executing_tasks).toEqual([]);
      expect(s.read().tasks[0]).toMatchObject({ status: "pending", revalidation_required: true });
    } finally {
      rmSync(unreadableTranscript, { recursive: true, force: true });
    }
  });

  it("uses locked execution authority when an unreadable transcript races with a sibling reservation", async () => {
    const initial = await makeSession({ plantTranscript: false, executingTasks: ["T1"] });
    const unreadableTranscript = canonicalTempDir("loom-racing-transcript-");
    let persisted = initial.read();
    const lockedState: TaskGraph = { ...persisted, executing_tasks: ["T1", "T2"] };
    const manager = {
      load: vi.fn(() => persisted),
      update: vi.fn(async (fn: (state: TaskGraph) => TaskGraph) => {
        persisted = fn(lockedState);
      }),
      updateAndReturn: vi.fn(async <T>(
        fn: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
      ): Promise<T> => {
        const transition = fn(lockedState);
        persisted = transition.state;
        return transition.value;
      }),
    } as unknown as StateManager;
    const managerSpy = vi.spyOn(StateManager, "fromSession").mockReturnValue(manager);
    try {
      const result = await updateTaskStatus(JSON.stringify({
        session_id: initial.session,
        agent_id: initial.agentId,
        agent_type: "code-implementer-agent",
        agent_transcript_path: unreadableTranscript,
      }), []);

      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("ambiguous") });
      expect(manager.updateAndReturn).toHaveBeenCalledOnce();
      expect(persisted.executing_tasks).toEqual(["T1", "T2"]);
      expect(persisted.tasks[0]?.revalidation_required).toBeUndefined();
    } finally {
      managerSpy.mockRestore();
      rmSync(unreadableTranscript, { recursive: true, force: true });
    }
  });

  it("preserves ambiguous execution authority when an unreadable transcript binds no Task", async () => {
    const s = await makeSession({ plantTranscript: false, executingTasks: ["T1", "T2"] });
    const unreadableTranscript = canonicalTempDir("loom-ambiguous-transcript-");
    try {
      const result = await updateTaskStatus(JSON.stringify({
        session_id: s.session,
        agent_id: s.agentId,
        agent_type: "code-implementer-agent",
        agent_transcript_path: unreadableTranscript,
      }), []);

      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("ambiguous") });
      expect(s.read().executing_tasks).toEqual(["T1", "T2"]);
      expect(s.read().tasks[0]?.revalidation_required).toBeUndefined();
    } finally {
      rmSync(unreadableTranscript, { recursive: true, force: true });
    }
  });

  it("errors out loud when nothing was recorded and there is no execution authority", async () => {
    const s = await makeSession({ plantTranscript: false });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let text = "";
    try {
      const result = await updateTaskStatus(JSON.stringify({
        session_id: s.session,
        agent_id: s.agentId,
        agent_type: "code-implementer-agent",
      }), []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("attribution unavailable"),
      });
      text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      stderrSpy.mockRestore();
    }

    expect(text, "a no-op this consequential must never be silent").toContain("code-implementer-agent");
    expect(text).toContain("task status was NOT recorded");
    expect(text).toContain("no transcript found");
    expect(text).toContain("executing_tasks is empty");
    expect(s.read().tasks.find((t) => t.id === "T1")?.status).toBe("pending");
  });
});
