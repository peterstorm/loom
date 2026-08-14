import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALL_START_SLACK_MS,
  bunJunitOutputFileFromCommand,
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

describe("bunJunitOutputFileFromCommand", () => {
  it.each([
    ["equals options", "bun test --reporter=junit --reporter-outfile=report.xml", "report.xml"],
    ["space options", "bun test --reporter junit --reporter-outfile report.xml", "report.xml"],
    ["double-quoted equals path", 'bun test --reporter=junit --reporter-outfile="reports/my report.xml"', "reports/my report.xml"],
    ["single-quoted equals path", "bun test --reporter=junit --reporter-outfile='reports/my report.xml'", "reports/my report.xml"],
    ["separate double-quoted path", 'bun test --reporter "junit" --reporter-outfile "reports/my report.xml"', "reports/my report.xml"],
    ["focused test before options", "bun test engine/tests/example.test.ts --reporter=junit --reporter-outfile=report.xml", "report.xml"],
  ])("extracts Bun JUnit outfile for %s", (_label, command, expected) => {
    expect(bunJunitOutputFileFromCommand(command)).toBe(expected);
  });

  it.each([
    ["non-Bun runner", "npm test --reporter=junit --reporter-outfile=report.xml"],
    ["bun run rather than bun test", "bun run test --reporter=junit --reporter-outfile=report.xml"],
    ["missing reporter", "bun test --reporter-outfile=report.xml"],
    ["non-JUnit reporter", "bun test --reporter=json --reporter-outfile=report.xml"],
    ["missing outfile", "bun test --reporter=junit"],
    ["empty outfile", "bun test --reporter=junit --reporter-outfile="],
    ["duplicate outfiles", "bun test --reporter=junit --reporter-outfile=a.xml --reporter-outfile=b.xml"],
    ["option-looking test pattern", "bun test --test-name-pattern='--reporter=junit' --reporter-outfile=report.xml"],
    ["options after argument terminator", "bun test -- --reporter=junit --reporter-outfile=report.xml"],
    ["dynamic path", "bun test --reporter=junit --reporter-outfile=$REPORT"],
  ])("fails closed for %s", (_label, command) => {
    expect(bunJunitOutputFileFromCommand(command)).toBeNull();
  });
});

describe("findReport — Bun JUnit artifacts", () => {
  let cwd: string;
  let callStart: number;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "loom-bun-report-"));
    callStart = Date.now() - 1000;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("parses an explicit fresh Bun JUnit artifact via parseJunitXml", () => {
    writeFileSync(join(cwd, "report.xml"), '<testsuites><testsuite tests="7" failures="1" errors="1"/></testsuites>');

    expect(findReport(
      "bun test --reporter=junit --reporter-outfile=report.xml",
      cwd,
      "",
      { nowMs: Date.now(), callStartMs: callStart },
    )).toEqual({ total: 7, failed: 2, source: "junit-xml" });
  });

  it("resolves a quoted relative outfile against the command cwd", () => {
    const dir = join(cwd, "test reports");
    mkdirSync(dir);
    writeFileSync(join(dir, "bun.xml"), '<testsuite tests="3" failures="0" errors="0"/>');

    expect(findReport(
      'bun test --reporter junit --reporter-outfile "test reports/bun.xml"',
      cwd,
      "",
      { nowMs: Date.now(), callStartMs: callStart },
    )).toEqual({ total: 3, failed: 0, source: "junit-xml" });
  });

  it("supports an absolute Bun reporter path", () => {
    const path = join(cwd, "absolute.xml");
    writeFileSync(path, '<testsuite tests="2" failures="0" errors="0"/>');

    expect(findReport(
      `bun test --reporter=junit --reporter-outfile='${path}'`,
      join(cwd, "unused-command-cwd"),
      "",
      { nowMs: Date.now(), callStartMs: callStart },
    )).toEqual({ total: 2, failed: 0, source: "junit-xml" });
  });

  it("requires both the Bun runner and explicit JUnit reporter before reading the artifact", () => {
    writeFileSync(join(cwd, "report.xml"), '<testsuite tests="5" failures="0" errors="0"/>');
    const times = { nowMs: Date.now(), callStartMs: callStart };

    expect(findReport("bun test --reporter-outfile=report.xml", cwd, "", times)).toBeNull();
    expect(findReport("bun test --reporter=json --reporter-outfile=report.xml", cwd, "", times)).toBeNull();
    expect(findReport("npm test --reporter=junit --reporter-outfile=report.xml", cwd, "", times)).toBeNull();
  });

  it("applies the agent-authored-artifact veto to the resolved absolute path", () => {
    const path = join(cwd, "report.xml");
    writeFileSync(path, '<testsuite tests="5" failures="0" errors="0"/>');
    const seen: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport(
        "bun test --reporter=junit --reporter-outfile=report.xml",
        cwd,
        "",
        { nowMs: Date.now(), callStartMs: callStart },
        (candidate) => {
          seen.push(candidate);
          return true;
        },
      )).toBeNull();
      expect(seen).toEqual([path]);
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(""))
        .toContain("rejecting --reporter-outfile");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("fails closed with a diagnostic when the call-start stamp is missing", () => {
    writeFileSync(join(cwd, "report.xml"), '<testsuite tests="5" failures="0" errors="0"/>');
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport(
        "bun test --reporter=junit --reporter-outfile=report.xml",
        cwd,
        "",
        { nowMs: Date.now(), callStartMs: null },
      )).toBeNull();
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(""))
        .toContain("no call-start stamp");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("rejects and diagnoses an artifact that predates this call", () => {
    const path = join(cwd, "report.xml");
    writeFileSync(path, '<testsuite tests="5" failures="0" errors="0"/>');
    const stale = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(path, stale, stale);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport(
        "bun test --reporter=junit --reporter-outfile=report.xml",
        cwd,
        "",
        { nowMs: Date.now(), callStartMs: Date.now() - 1000 },
      )).toBeNull();
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(""))
        .toContain("stale report");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("fails closed and diagnoses an unreadable Bun artifact", () => {
    mkdirSync(join(cwd, "report.xml"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport(
        "bun test --reporter=junit --reporter-outfile=report.xml",
        cwd,
        "",
        { nowMs: Date.now(), callStartMs: callStart },
      )).toBeNull();
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(""))
        .toContain("cannot read Bun JUnit report");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("fails closed and diagnoses malformed JUnit XML", () => {
    writeFileSync(join(cwd, "report.xml"), '<testsuite tests="4" failures="5" errors="0"/>');
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(findReport(
        "bun test --reporter=junit --reporter-outfile=report.xml",
        cwd,
        "",
        { nowMs: Date.now(), callStartMs: callStart },
      )).toBeNull();
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(""))
        .toContain("malformed Bun JUnit report");
    } finally {
      stderrSpy.mockRestore();
    }
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
    const report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: callStart });
    expect(report).toEqual({ total: 3, failed: 0, source: "vitest-json" });
  });

  it("parses JSON from stdout when a JSON reporter was requested", () => {
    const stdout = JSON.stringify({ numTotalTests: 8, numFailedTests: 1 });
    const report = findReport("npx vitest run --reporter=json", cwd, stdout, { nowMs: Date.now(), callStartMs: callStart });
    expect(report).toEqual({ total: 8, failed: 1, source: "vitest-json" });
  });

  it("finds fresh surefire XML reports", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    const report = findReport("mvn test", cwd, "", { nowMs: Date.now(), callStartMs: callStart });
    expect(report).toEqual({ total: 4, failed: 0, source: "junit-xml" });
  });

  it("finds reports one module level down (multi-module builds)", () => {
    const dir = join(cwd, "core/target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="2" failures="1" errors="0"/>');
    const report = findReport("mvn test", cwd, "", { nowMs: Date.now(), callStartMs: callStart });
    expect(report).toEqual({ total: 2, failed: 1, source: "junit-xml" });
  });

  it("runner-family scoping: fresh surefire XML cannot vouch for a non-JVM command", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    // A sibling JVM run's artifact must not vouch for `npm test`.
    expect(findReport("npm test", cwd, "", { nowMs: Date.now(), callStartMs: callStart })).toBeNull();
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
        { nowMs: Date.now(), callStartMs: Date.now() - 2 * 60 * 60 * 1000 },
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
    expect(findReport("mvn test", cwd, "", { nowMs: Date.now(), callStartMs: Date.now() - 2 * 60 * 60 * 1000 })).toBeNull();
  });

  it("returns null when no artifact exists (echo-spoof shape)", () => {
    expect(findReport('echo "npm test: 5 passing"', cwd, 'npm test: 5 passing', { nowMs: Date.now(), callStartMs: callStart })).toBeNull();
  });

  it("an unreadable explicit --outputFile falls through instead of crashing (TestRun keeps report: null)", () => {
    // A DIRECTORY at the declared path: exists + fresh, but readFileSync throws
    mkdirSync(join(cwd, "out.json"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let report: unknown = "unset";
      expect(() => {
        report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: callStart });
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
      expect(findReport("mvn test", cwd, "", { nowMs: Date.now(), callStartMs: callStart })).toBeNull();
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
      expect(findReport("mvn test", notADir, "", { nowMs: Date.now(), callStartMs: callStart })).toBeNull();
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
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: Date.now() - 1000 }),
    ).toBeNull();
  });

  it("a JUnit artifact from BEFORE the call start is rejected — `mvn test -DskipTests` cannot re-vouch stale surefire XML", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "TEST-a.xml");
    writeFileSync(file, '<testsuite tests="4" failures="0" errors="0"/>');
    const mtime = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(file, mtime, mtime);
    expect(findReport("mvn test -DskipTests", cwd, "", { nowMs: Date.now(), callStartMs: Date.now() - 1000 })).toBeNull();
  });

  it("a mixed-mtime JUnit dir counts ONLY files fresh for this call — a stale failing XML beside a fresh passing one does not pollute the merge", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    // Stale FAILING report from a previous run (5 minutes before the call)…
    const stale = join(dir, "TEST-old.xml");
    writeFileSync(stale, '<testsuite tests="6" failures="3" errors="0"/>');
    const staleMtime = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(stale, staleMtime, staleMtime);
    // …beside a fresh PASSING report written during this call.
    writeFileSync(join(dir, "TEST-new.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    const report = findReport("mvn test", cwd, "", {
      nowMs: Date.now(),
      callStartMs: Date.now() - 1000,
    });
    expect(report).toEqual({ total: 4, failed: 0, source: "junit-xml" });
  });

  it("an artifact at/after the call start (within slack) is accepted", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    // Call "started" slightly AFTER the write — coarse-mtime slack absorbs it.
    const callStart = Date.now() + CALL_START_SLACK_MS - 500;
    expect(
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: callStart }),
    ).toEqual({ total: 3, failed: 0, source: "vitest-json" });
  });

  it("an artifact older than the slack allowance before the call start is rejected", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const mtime = (Date.now() - CALL_START_SLACK_MS - 5000) / 1000;
    utimesSync(file, mtime, mtime);
    expect(
      findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: Date.now() }),
    ).toBeNull();
  });

  it("null call start → the --outputFile source fails closed with a loud stderr line", () => {
    const file = join(cwd, "out.json");
    writeFileSync(file, JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: null }),
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
      expect(findReport("mvn test", cwd, "", { nowMs: Date.now(), callStartMs: null })).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("no call-start stamp");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("null call start → stdout reporter JSON STILL vouches (inherently call-scoped)", () => {
    const stdout = JSON.stringify({ numTotalTests: 8, numFailedTests: 1 });
    expect(findReport("npx vitest run --reporter=json", cwd, stdout, { nowMs: Date.now(), callStartMs: null })).toEqual({
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
        findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", { nowMs: Date.now(), callStartMs: null }, () => true),
      ).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("rejecting --outputFile");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
