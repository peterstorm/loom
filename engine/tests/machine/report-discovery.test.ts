import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALL_START_SLACK_MS,
  findReport,
  outputFileFromCommand,
} from "../../src/machine/report-discovery";

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
  /** Call-start stamp predating the artifacts each test writes — the honest
   *  shape: the runner wrote its report AFTER the call began. */
  let callStart: number;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "loom-report-"));
    callStart = Date.now() - 1000;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads an explicit --outputFile vitest report", () => {
    writeFileSync(join(cwd, "out.json"), JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), callStart);
    expect(report).toEqual({ total: 3, failed: 0, source: "vitest-json" });
  });

  it("parses JSON from stdout when a JSON reporter was requested", () => {
    const stdout = JSON.stringify({ numTotalTests: 8, numFailedTests: 1 });
    const report = findReport("npx vitest run --reporter=json", cwd, stdout, Date.now(), callStart);
    expect(report).toEqual({ total: 8, failed: 1, source: "vitest-json" });
  });

  it("finds fresh surefire XML reports", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    const report = findReport("mvn test", cwd, "", Date.now(), callStart);
    expect(report).toEqual({ total: 4, failed: 0, source: "junit-xml" });
  });

  it("finds reports one module level down (multi-module builds)", () => {
    const dir = join(cwd, "core/target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="2" failures="1" errors="0"/>');
    const report = findReport("mvn test", cwd, "", Date.now(), callStart);
    expect(report).toEqual({ total: 2, failed: 1, source: "junit-xml" });
  });

  it("runner-family scoping: fresh surefire XML cannot vouch for a non-JVM command", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    // A sibling JVM run's artifact must not vouch for `npm test`.
    expect(findReport("npm test", cwd, "", Date.now(), callStart)).toBeNull();
  });

  it("ignores a stale explicit --outputFile report — freshness bounds cross-run attribution", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(file, old, old);
    // Even a call-start stamp from an hour ago cannot resurrect it: the
    // recency window is the belt-and-braces upper bound.
    expect(
      findReport(
        "npx vitest run --reporter=json --outputFile=out.json",
        cwd,
        "",
        Date.now(),
        Date.now() - 2 * 60 * 60 * 1000,
      ),
    ).toBeNull();
  });

  it("ignores stale reports — an old artifact cannot vouch for this run", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "TEST-a.xml");
    writeFileSync(file, '<testsuite tests="4" failures="0" errors="0"/>');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(file, old, old);
    expect(findReport("mvn test", cwd, "", Date.now(), Date.now() - 2 * 60 * 60 * 1000)).toBeNull();
  });

  it("returns null when no artifact exists (echo-spoof shape)", () => {
    expect(findReport('echo "npm test: 5 passing"', cwd, 'npm test: 5 passing', Date.now(), callStart)).toBeNull();
  });

  it("an unreadable explicit --outputFile falls through instead of crashing (TestRun keeps report: null)", () => {
    // A DIRECTORY at the declared path: exists + fresh, but readFileSync throws
    mkdirSync(join(cwd, "out.json"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let report: unknown = "unset";
      expect(() => {
        report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), callStart);
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
      expect(findReport("mvn test", cwd, "", Date.now(), callStart)).toBeNull();
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
      expect(findReport("mvn test", notADir, "", Date.now(), callStart)).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("cannot list module dirs");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("findReport — call-start ordering (a window bounds, the stamp orders)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "loom-report-order-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("an --outputFile artifact from BEFORE the call start is rejected even inside the recency window", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    // Artifact is 5 minutes old (well inside the 15-minute window)…
    const mtime = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(file, mtime, mtime);
    // …but the CALL started just now: a run that produced nothing must not
    // re-vouch the sibling artifact.
    expect(
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), Date.now() - 1000),
    ).toBeNull();
  });

  it("a JUnit artifact from BEFORE the call start is rejected — `mvn test -DskipTests` cannot re-vouch stale surefire XML", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "TEST-a.xml");
    writeFileSync(file, '<testsuite tests="4" failures="0" errors="0"/>');
    const mtime = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(file, mtime, mtime);
    expect(findReport("mvn test -DskipTests", cwd, "", Date.now(), Date.now() - 1000)).toBeNull();
  });

  it("an artifact at/after the call start (within slack) is accepted", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    // Call "started" slightly AFTER the write — coarse-mtime slack absorbs it.
    const callStart = Date.now() + CALL_START_SLACK_MS - 500;
    expect(
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), callStart),
    ).toEqual({ total: 3, failed: 0, source: "vitest-json" });
  });

  it("an artifact older than the slack allowance before the call start is rejected", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const mtime = (Date.now() - CALL_START_SLACK_MS - 5000) / 1000;
    utimesSync(file, mtime, mtime);
    expect(
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), Date.now()),
    ).toBeNull();
  });

  it("null call start → the --outputFile source fails closed with a loud stderr line", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), null),
      ).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("no call-start stamp");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("null call start → JUnit dirs fail closed with a loud stderr line", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport("mvn test", cwd, "", Date.now(), null)).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("no call-start stamp");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("null call start → stdout reporter JSON STILL vouches (inherently call-scoped)", () => {
    const stdout = JSON.stringify({ numTotalTests: 8, numFailedTests: 1 });
    expect(findReport("npx vitest run --reporter=json", cwd, stdout, Date.now(), null)).toEqual({
      total: 8,
      failed: 1,
      source: "vitest-json",
    });
  });

  it("null call start: a vetoed --outputFile still reports the VETO, not the missing stamp", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now(), null, () => true),
      ).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("rejecting --outputFile");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
