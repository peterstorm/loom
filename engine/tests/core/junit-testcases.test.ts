import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJunitTestcases } from "../../src/core/structured-test-report";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const probe = readFileSync(join(__dirname, "..", "fixtures", "junit", "vitest-acceptance-probe.xml"));

describe("parseJunitTestcases — the per-testcase projection of a JUnit report", () => {
  it("projects every testcase of a real Vitest report with its file, outcome and failure type", () => {
    const parsed = parseJunitTestcases(new Uint8Array(probe));
    expect(parsed).toEqual({
      ok: true,
      value: [
        { file: "tests/green.test.ts", classname: "tests/green.test.ts", name: "plain", outcome: "passed", failureType: null },
        { file: "tests/green.test.ts", classname: "tests/green.test.ts", name: "skipped one", outcome: "skipped", failureType: null },
        // A file that never loads: Vitest names the synthetic testcase after the file.
        {
          file: "tests/acceptance/broken.acceptance.test.ts",
          classname: "tests/acceptance/broken.acceptance.test.ts",
          name: "tests/acceptance/broken.acceptance.test.ts",
          outcome: "failed",
          failureType: "Error",
        },
        {
          file: "tests/acceptance/red.acceptance.test.ts",
          classname: "tests/acceptance/red.acceptance.test.ts",
          name: "contract > AS-001: subtracts",
          outcome: "failed",
          failureType: "AssertionError",
        },
        {
          file: "tests/acceptance/red.acceptance.test.ts",
          classname: "tests/acceptance/red.acceptance.test.ts",
          name: "contract > AS-002: throws stub",
          outcome: "failed",
          failureType: "Error",
        },
      ],
    });
  });

  it("projects Surefire's per-class suites, where <error> fails a testcase like <failure>", () => {
    const surefire = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.OrderAcceptanceTest" tests="3" failures="1" errors="1" skipped="0">
  <testcase name="AS-001 submits" classname="com.acme.OrderAcceptanceTest" time="0.01">
    <failure type="org.opentest4j.AssertionFailedError" message="expected 2"/>
  </testcase>
  <testcase name="AS-002 refuses" classname="com.acme.OrderAcceptanceTest">
    <error type="java.lang.UnsupportedOperationException"/>
  </testcase>
  <testcase name="AS-003 replays" classname="com.acme.OrderAcceptanceTest$Nested"/>
</testsuite>`;
    expect(parseJunitTestcases(bytes(surefire))).toEqual({
      ok: true,
      value: [
        { file: "com.acme.OrderAcceptanceTest", classname: "com.acme.OrderAcceptanceTest", name: "AS-001 submits", outcome: "failed", failureType: "org.opentest4j.AssertionFailedError" },
        { file: "com.acme.OrderAcceptanceTest", classname: "com.acme.OrderAcceptanceTest", name: "AS-002 refuses", outcome: "failed", failureType: "java.lang.UnsupportedOperationException" },
        { file: "com.acme.OrderAcceptanceTest$Nested", classname: "com.acme.OrderAcceptanceTest$Nested", name: "AS-003 replays", outcome: "passed", failureType: null },
      ],
    });
  });

  it("identifies a real Bun testcase by its file attribute: classname is the describe chain, or empty at top level", () => {
    const bun = readFileSync(join(__dirname, "..", "fixtures", "bun-1.4.2-mixed.junit.xml"));
    expect(parseJunitTestcases(new Uint8Array(bun))).toEqual({
      ok: true,
      value: [
        { file: "src/b.test.ts", classname: "ok", name: "passes", outcome: "passed", failureType: null },
        { file: "src/c.test.ts", classname: "inner > outer", name: "nested passes", outcome: "passed", failureType: null },
        { file: "src/c.test.ts", classname: "outer", name: "fails", outcome: "failed", failureType: "AssertionError" },
        { file: "src/c.test.ts", classname: "", name: "top level", outcome: "passed", failureType: null },
      ],
    });
  });

  it("reads a failing TODO case as skipped, as the count parser does", () => {
    const node = `<testsuites><testsuite name="s" tests="1" failures="0" skipped="1">
<testcase name="todo" classname="t.test.ts"><skipped type="todo"/><failure type="Error"/></testcase>
</testsuite></testsuites>`;
    expect(parseJunitTestcases(bytes(node))).toMatchObject({ ok: true, value: [{ name: "todo", outcome: "skipped" }] });
  });

  it.each([
    ["Vitest JSON", JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }), "unrecognized-format"],
    ["malformed XML", "<testsuites><testsuite>", "malformed-counts"],
    ["counts that disagree with the testcases", `<testsuite name="s" tests="5" failures="0"><testcase name="a" classname="c"/></testsuite>`, "malformed-counts"],
  ])("refuses %s with a named reason", (_name, text, reason) => {
    expect(parseJunitTestcases(bytes(text))).toMatchObject({ ok: false, error: { kind: "invalid-structured-test-report", reason } });
  });

  it("refuses a testcase that names no file (neither a file attribute nor a classname) instead of inventing one", () => {
    for (const testcase of ['<testcase name="a"/>', '<testcase name="a" classname=""/>', '<testcase name="a" classname="" file=" "/>', '<testcase classname="c" file="f"/>']) {
      const report = `<testsuite name="s" tests="1" failures="0">${testcase}</testsuite>`;
      expect(parseJunitTestcases(bytes(report)), testcase).toMatchObject({ ok: false, error: { reason: "malformed-testcase" } });
    }
  });
});
