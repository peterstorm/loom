import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReport, outputFileFromCommand } from "../../src/machine/report-discovery";

describe("outputFileFromCommand", () => {
  it("extracts --outputFile=path", () => {
    expect(outputFileFromCommand("npx vitest run --reporter=json --outputFile=out.json")).toBe("out.json");
  });

  it("extracts --outputFile path and quoted forms", () => {
    expect(outputFileFromCommand("npx vitest --outputFile out.json")).toBe("out.json");
    expect(outputFileFromCommand('npx vitest --outputFile="my out.json"')).toBe("my out.json");
    expect(outputFileFromCommand("npx vitest --outputFile='o.json'")).toBe("o.json");
  });

  it("returns null when absent", () => {
    expect(outputFileFromCommand("npm test")).toBeNull();
  });
});

describe("findReport", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "loom-report-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads an explicit --outputFile vitest report", () => {
    writeFileSync(join(cwd, "out.json"), JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now());
    expect(report).toEqual({ total: 3, failed: 0, source: "vitest-json" });
  });

  it("parses JSON from stdout when a JSON reporter was requested", () => {
    const stdout = JSON.stringify({ numTotalTests: 8, numFailedTests: 1 });
    const report = findReport("npx vitest run --reporter=json", cwd, stdout, Date.now());
    expect(report).toEqual({ total: 8, failed: 1, source: "vitest-json" });
  });

  it("finds fresh surefire XML reports", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    const report = findReport("mvn test", cwd, "", Date.now());
    expect(report).toEqual({ total: 4, failed: 0, source: "junit-xml" });
  });

  it("finds reports one module level down (multi-module builds)", () => {
    const dir = join(cwd, "core/target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="2" failures="1" errors="0"/>');
    const report = findReport("mvn test", cwd, "", Date.now());
    expect(report).toEqual({ total: 2, failed: 1, source: "junit-xml" });
  });

  it("runner-family scoping: fresh surefire XML cannot vouch for a non-JVM command", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    // A sibling JVM run's artifact must not vouch for `npm test`.
    expect(findReport("npm test", cwd, "", Date.now())).toBeNull();
  });

  it("ignores a stale explicit --outputFile report — freshness bounds cross-run attribution", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(file, old, old);
    expect(
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now()),
    ).toBeNull();
  });

  it("ignores stale reports — an old artifact cannot vouch for this run", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "TEST-a.xml");
    writeFileSync(file, '<testsuite tests="4" failures="0" errors="0"/>');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(file, old, old);
    expect(findReport("mvn test", cwd, "", Date.now())).toBeNull();
  });

  it("returns null when no artifact exists (echo-spoof shape)", () => {
    expect(findReport('echo "npm test: 5 passing"', cwd, 'npm test: 5 passing', Date.now())).toBeNull();
  });

  it("an unreadable explicit --outputFile falls through instead of crashing (TestRun keeps report: null)", () => {
    // A DIRECTORY at the declared path: exists + fresh, but readFileSync throws
    mkdirSync(join(cwd, "out.json"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let report: unknown = "unset";
      expect(() => {
        report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now());
      }).not.toThrow();
      expect(report).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("cannot read --outputFile");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("an unreadable JUnit dir stays fail-closed but says so on stderr", () => {
    // A FILE where a report DIR is expected: existsSync passes, readdirSync throws
    mkdirSync(join(cwd, "target"), { recursive: true });
    writeFileSync(join(cwd, "target/surefire-reports"), "not a directory");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport("mvn test", cwd, "", Date.now())).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("cannot read JUnit dir");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("an unlistable cwd (module-dir walk) stays fail-closed but says so on stderr", () => {
    const notADir = join(cwd, "plain-file");
    writeFileSync(notADir, "x");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport("mvn test", notADir, "", Date.now())).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("cannot list module dirs");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
