import { describe, it, expect } from "vitest";
import { extractTestEvidence, analyzeNewTests } from "../../src/handlers/subagent-stop/update-task-status";

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
