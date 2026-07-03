import { describe, it, expect } from "vitest";
import updateTaskStatus, { extractTestEvidence, analyzeNewTests, isMachineBound, resolveTestEvidence } from "../../src/handlers/subagent-stop/update-task-status";
import { legacyTestsPassedNote } from "../../src/types";

describe("update-task-status — malformed stdin guard (directly-registered route)", () => {
  it("returns a contextual error naming that status/evidence was NOT updated, not a bare throw", async () => {
    const result = await updateTaskStatus("this is not json", []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("malformed SubagentStop input");
      expect(result.message).toContain("NOT updated");
    }
  });
});
import { parseMachineJson } from "../../src/machine";
import type { Evidence, LoadedMachine } from "../../src/machine";

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

  it("detects pytest passing", () => {
    const output = "===== 8 passed in 0.5s =====";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("pytest");
  });

  it("rejects pytest with failures", () => {
    const output = "===== 6 passed, 2 failed =====";
    const result = extractTestEvidence(output);
    expect(result.passed).toBe(false);
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

  // --- Tests for multiple test runs (T11 fix) ---

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
    report: { total: 5, failed: 0, source: "vitest-json" },
  };
  const fileWrite: Evidence = { kind: "FileWrite", path: "/src/thing.ts" };
  const fileRead: Evidence = { kind: "FileRead", path: "/src/thing.ts" };

  it("[pass, FileWrite] demotes to the labeled low-trust path — the pass vouched for old code", () => {
    const resolved = resolveTestEvidence([trustedPass, fileWrite], "12 passing", true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "low-trust (files modified after last trusted pass; transcript-regex)",
    });
    expect(resolved.evidence).toContain("files modified after last trusted pass");
  });

  it("[pass, FileWrite] with no transcript signal is an untrusted non-pass, same label", () => {
    const resolved = resolveTestEvidence([trustedPass, fileWrite], "no test output", true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "low-trust (files modified after last trusted pass; transcript-regex)",
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
    });
    expect(resolved.evidence).toContain("snapshot-read-failed");
  });

  it("snapshotFailed + no transcript pass markers → untrusted failure with the same label", () => {
    const resolved = resolveTestEvidence([], "no test output at all", true, true);
    expect(resolved.result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
    });
  });

  it("snapshotFailed never mints a trusted verdict even if events are (wrongly) supplied", () => {
    const trustedPass = {
      kind: "TestRun" as const,
      command: "npm test",
      exit: 0,
      report: { total: 5, failed: 0, source: "vitest-json" as const },
    };
    const resolved = resolveTestEvidence([trustedPass], "12 passing", true, true);
    expect(resolved.result.verdict).toBe("untrusted");
    expect(resolved.result.verdict === "untrusted" && resolved.result.label).toContain(
      "snapshot-read-failed",
    );
  });
});

describe("analyzeNewTests (pure)", () => {
  it("detects Java @Test methods with assertions", () => {
    const diff = [
      "+    @Test",
      "+    void shouldWork() {",
      "+    assertThat(result).isEqualTo(42);",
    ].join("\n");
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(true);
    expect(result.evidence).toContain("1 new test");
    expect(result.evidence).toContain("assertion");
  });

  it("rejects test stubs with no assertions", () => {
    const diff = [
      "+    @Test",
      "+    void stubTest() {",
      "+    }",
    ].join("\n");
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(false);
    expect(result.evidence).toContain("0 assertions");
  });

  it("skips when new_tests_required=false", () => {
    const diff = "+    @Test\n+    assertThat(x).isTrue();";
    const result = analyzeNewTests(diff, false);
    expect(result.written).toBe(false);
    expect(result.evidence).toContain("skipped");
  });

  it("detects TypeScript tests with expect()", () => {
    const diff = [
      '+  it("works", () => {',
      "+    expect(result).toBe(42);",
    ].join("\n");
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(true);
    expect(result.evidence).toContain("ts");
  });

  it("returns empty for no tests in diff", () => {
    const diff = "+const x = 42;\n+function foo() {}";
    const result = analyzeNewTests(diff, undefined);
    expect(result.written).toBe(false);
    expect(result.evidence).toBe("");
  });
});
