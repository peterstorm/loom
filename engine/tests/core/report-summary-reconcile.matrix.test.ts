/**
 * INV-8 matrix: one report-summary constructor reconciles per-file results.
 *
 * The same consistent and inconsistent per-file fixtures are fed through every
 * entry point that yields a TestReportSummary: the Vitest JSON parser, the
 * JUnit parser, `mergeSummaries`, the ledger read-back (`parseReportField`,
 * reached through `parseEvidenceLine`) and capture (`findReport`, over an
 * explicit Vitest JSON `--outputFile`, Loom's completion-report JUnit directory
 * and multi-file Surefire reports). Each consistent fixture must survive with
 * exactly its per-file results; each inconsistent one must become `null`.
 *
 * A fixture is a claim: summary counts plus per-file results. "Inconsistent"
 * means the claimed counts disagree with the per-file results; every entry
 * point renders the claim in its own input form, so the counts an entry point
 * sees are the claim's, never a re-derivation from the files.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestFileResult, TestReportFiles } from "../../src/core/red-then-green-types";
import {
  mergeSummaries,
  parseJunitXml,
  parseReportSummary,
  parseVitestJson,
  type TestReportSummary,
} from "../../src/core/structured-test-report";
import { parseEvidenceLine } from "../../src/machine/evidence";
import { findReport } from "../../src/machine/report-discovery";

type Source = TestReportSummary["source"];

type Fixture = Readonly<{
  name: string;
  consistent: boolean;
  source: Source;
  total: number;
  failed: number;
  results: readonly TestFileResult[];
}>;

const result = (file: string, executed: number, failed: number, collectionError = false): TestFileResult =>
  ({ file, executed, failed, skipped: 0, collectionError });

const JUNIT_RESULTS = [
  result("tests/broken.test.ts", 1, 1, true),
  result("tests/green.test.ts", 2, 0),
  result("tests/red.test.ts", 2, 1),
] as const;

const VITEST_RESULTS = [
  result("/repo/tests/broken.test.ts", 0, 0, true),
  result("/repo/tests/green.test.ts", 2, 0),
  result("/repo/tests/red.test.ts", 2, 1),
] as const;

const FIXTURES: readonly Fixture[] = [
  { name: "junit consistent", consistent: true, source: "junit-xml", total: 5, failed: 2, results: JUNIT_RESULTS },
  { name: "junit failed sum disagrees", consistent: false, source: "junit-xml", total: 5, failed: 1, results: JUNIT_RESULTS },
  { name: "junit executed sum disagrees", consistent: false, source: "junit-xml", total: 6, failed: 2, results: JUNIT_RESULTS },
  { name: "vitest consistent", consistent: true, source: "vitest-json", total: 4, failed: 1, results: VITEST_RESULTS },
  { name: "vitest failed sum disagrees", consistent: false, source: "vitest-json", total: 4, failed: 2, results: VITEST_RESULTS },
  { name: "vitest executed sum disagrees", consistent: false, source: "vitest-json", total: 5, failed: 1, results: VITEST_RESULTS },
];

const recorded = (results: readonly TestFileResult[]): TestReportFiles => ({ kind: "recorded", results });

// --- Rendering a claim in each entry point's input form ---

function vitestJson(fixture: Fixture): string {
  return JSON.stringify({
    numTotalTests: fixture.total,
    numPassedTests: fixture.total - fixture.failed,
    numFailedTests: fixture.failed,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: fixture.results.map(({ file, executed, failed, collectionError }) => ({
      name: file,
      status: collectionError || failed > 0 ? "failed" : "passed",
      message: collectionError ? "Cannot find module" : "",
      assertionResults: Array.from({ length: executed }, (_, index) => ({
        title: `case ${index}`,
        status: index < failed ? "failed" : "passed",
        failureMessages: [],
      })),
    })),
  });
}

function junitSuite({ file, executed, failed, collectionError }: TestFileResult): string {
  const cases = collectionError
    ? [`<testcase classname="${file}" name="${file}"><failure type="Error"/></testcase>`]
    : Array.from({ length: executed }, (_, index) => index < failed
      ? `<testcase classname="${file}" name="case ${index}"><failure type="AssertionError"/></testcase>`
      : `<testcase classname="${file}" name="case ${index}"/>`);
  return `<testsuite name="${file}" tests="${executed}" failures="${failed}" errors="0" skipped="0">${cases.join("")}</testsuite>`;
}

/** The suites carry the per-file truth; the root carries the claim. */
const junitXml = (fixture: Fixture): string =>
  `<testsuites tests="${fixture.total}" failures="${fixture.failed}" errors="0">${fixture.results.map(junitSuite).join("")}</testsuites>`;

const ledgerLine = (fixture: Fixture): string => JSON.stringify({
  epoch: "agent-1:code-implementer-agent",
  event: {
    kind: "TestRun",
    command: "npx vitest run",
    exit: fixture.failed > 0 ? 1 : 0,
    report: { total: fixture.total, failed: fixture.failed, source: fixture.source, files: recorded(fixture.results) },
  },
});

function readBack(fixture: Fixture): TestReportSummary | null {
  const parsed = parseEvidenceLine(ledgerLine(fixture));
  if (!parsed.ok) throw new Error(`the TestRun fact itself must stay readable: ${parsed.error}`);
  return parsed.value.event.kind === "TestRun" ? parsed.value.event.report : null;
}

/** Split the claim into a first-file part and a remainder that carries the
 *  rest of the claimed counts, mint each part, then merge. Splitting keeps the
 *  claim's totals, so an inconsistency survives into exactly one part. */
function merged(fixture: Fixture): TestReportSummary | null {
  const [first, ...rest] = fixture.results;
  if (first === undefined) return null;
  const head = parseReportSummary(first.executed, first.failed, fixture.source, recorded([first]));
  const tail = parseReportSummary(fixture.total - first.executed, fixture.failed - first.failed, fixture.source, recorded(rest));
  return head === null || tail === null ? null : mergeSummaries([head, tail]);
}

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-inv8-matrix-"));
  cleanup.push(dir);
  return dir;
}

function write(dir: string, relativePath: string, content: string): string {
  const path = join(dir, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const times = () => ({ nowMs: Date.now(), callStartMs: Date.now() - 1_000 });

function captured(fixture: Fixture): TestReportSummary | null {
  const dir = projectDir();
  if (fixture.source === "vitest-json") {
    const report = write(dir, "reports/vitest.json", vitestJson(fixture));
    return findReport(`npx vitest run --reporter=json --outputFile=${report}`, dir, "", times());
  }
  write(dir, ".loom/completion-reports/verify.junit.xml", junitXml(fixture));
  return findReport("npm run test:unit", dir, "", times());
}

/** Surefire writes one report per class; findReport merges them. The claim
 *  rides on the first report's attributes, so an inconsistent claim makes that
 *  report untrusted, and one untrusted report makes the whole run's capture
 *  untrusted: the merge never vouches with the remaining reports alone. */
function capturedSurefire(fixture: Fixture): TestReportSummary | null {
  const dir = projectDir();
  const [first, ...rest] = fixture.results;
  if (first === undefined) return null;
  const firstClaim: Fixture = {
    ...fixture,
    total: fixture.total - rest.reduce((sum, entry) => sum + entry.executed, 0),
    failed: fixture.failed - rest.reduce((sum, entry) => sum + entry.failed, 0),
    results: [first],
  };
  write(dir, "target/surefire-reports/TEST-0.xml", junitXml(firstClaim));
  rest.forEach((entry, index) => write(dir, `target/surefire-reports/TEST-${index + 1}.xml`, junitSuite(entry)));
  return findReport("mvn test", dir, "", times());
}

/** Bun writes one JUnit report, named by `--reporter-outfile`. */
function capturedBun(fixture: Fixture): TestReportSummary | null {
  const dir = projectDir();
  const report = write(dir, "reports/bun.xml", junitXml(fixture));
  return findReport(`bun test --reporter=junit --reporter-outfile=${report}`, dir, "", times());
}

type EntryPoint = Readonly<{
  name: string;
  sources: readonly Source[];
  run: (fixture: Fixture) => TestReportSummary | null;
}>;

const ENTRY_POINTS: readonly EntryPoint[] = [
  { name: "parseVitestJson", sources: ["vitest-json"], run: (fixture) => parseVitestJson(vitestJson(fixture)) },
  { name: "parseJunitXml", sources: ["junit-xml"], run: (fixture) => parseJunitXml(junitXml(fixture)) },
  { name: "mergeSummaries", sources: ["junit-xml", "vitest-json"], run: merged },
  { name: "parseReportField (ledger read-back)", sources: ["junit-xml", "vitest-json"], run: readBack },
  { name: "findReport (capture)", sources: ["junit-xml", "vitest-json"], run: captured },
  { name: "findReport (Surefire merge)", sources: ["junit-xml"], run: capturedSurefire },
  { name: "findReport (Bun --reporter-outfile)", sources: ["junit-xml"], run: capturedBun },
];

const ROWS = ENTRY_POINTS.flatMap((entry) =>
  FIXTURES.filter((fixture) => entry.sources.includes(fixture.source)).map((fixture) => ({ entry, fixture })));

const byFile = (left: TestFileResult, right: TestFileResult): number =>
  left.file < right.file ? -1 : left.file > right.file ? 1 : 0;

describe("INV-8 matrix: every entry point reconciles per-file results through parseReportSummary", () => {
  it.each(ROWS.map(({ entry, fixture }) => [entry.name, fixture.name, entry, fixture] as const))(
    "AS-002: %s × %s",
    (_entryName, _fixtureName, entry, fixture) => {
      const summary = entry.run(fixture);
      if (!fixture.consistent) {
        expect(summary).toBeNull();
        return;
      }
      expect(summary).toMatchObject({ total: fixture.total, failed: fixture.failed, source: fixture.source });
      expect(summary?.files?.kind).toBe("recorded");
      if (summary?.files?.kind !== "recorded") return;
      expect([...summary.files.results].sort(byFile)).toEqual([...fixture.results].sort(byFile));
    },
  );

  it("AS-001: the matrix covers every entry point with at least one consistent and one inconsistent fixture", () => {
    for (const entry of ENTRY_POINTS) {
      const rows = ROWS.filter((row) => row.entry === entry);
      expect(rows.some((row) => row.fixture.consistent), entry.name).toBe(true);
      expect(rows.some((row) => !row.fixture.consistent), entry.name).toBe(true);
    }
  });
});

describe("INV-8 at capture: a run's reports vouch together or not at all", () => {
  it("AS-002: one malformed report among a run's Loom completion reports makes the whole capture untrusted", () => {
    const dir = projectDir();
    const consistent = FIXTURES.find((fixture) => fixture.consistent && fixture.source === "junit-xml")!;
    write(dir, ".loom/completion-reports/a.junit.xml", junitXml(consistent));
    write(dir, ".loom/completion-reports/b.junit.xml", '<testsuite tests="1" failures="2"/>');

    expect(findReport("npm run test:unit", dir, "", times())).toBeNull();
  });

  it("AS-002: one unreconciled Surefire report in one module makes the whole multi-module capture untrusted", () => {
    const dir = projectDir();
    const [green, red] = [result("com.example.A", 2, 0), result("com.example.B", 1, 1)];
    write(dir, "core/target/surefire-reports/TEST-A.xml", junitSuite(green));
    // The claim says two failures; the testcases carry one.
    write(dir, "api/target/surefire-reports/TEST-B.xml",
      `<testsuite tests="1" failures="2">${junitSuite(red).replace(/^<testsuite[^>]*>|<\/testsuite>$/g, "")}</testsuite>`);

    expect(findReport("mvn test", dir, "", times())).toBeNull();
  });

  it("AS-002: Maven failsafe's failsafe-summary.xml beside a valid TEST-*.xml is not a report, so the capture stays trusted", () => {
    const dir = projectDir();
    write(dir, "target/failsafe-reports/TEST-com.example.ItA.xml", junitSuite(result("com.example.ItA", 2, 1)));
    write(dir, "target/failsafe-reports/failsafe-summary.xml", `<?xml version="1.0" encoding="UTF-8"?>
<failsafe-summary xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/maven-surefire-plugin/xsd/failsafe-summary.xsd" result="255" timeout="false">
    <completed>2</completed>
    <errors>0</errors>
    <failures>1</failures>
    <skipped>0</skipped>
    <failureMessage xsi:nil="true" />
</failsafe-summary>`);

    const summary = findReport("mvn verify", dir, "", times());

    expect(summary).toMatchObject({ total: 2, failed: 1, source: "junit-xml" });
    expect(summary?.files).toEqual(recorded([result("com.example.ItA", 2, 1)]));
  });

  it("AS-002: a malformed JUnit report beside failsafe-summary.xml still makes the whole capture untrusted", () => {
    const dir = projectDir();
    write(dir, "target/failsafe-reports/TEST-com.example.ItA.xml", junitSuite(result("com.example.ItA", 2, 0)));
    write(dir, "target/failsafe-reports/TEST-com.example.ItB.xml", '<testsuite tests="1" failures="2"/>');
    write(dir, "target/failsafe-reports/failsafe-summary.xml", '<failsafe-summary result="255" timeout="false"><completed>3</completed></failsafe-summary>');

    expect(findReport("mvn verify", dir, "", times())).toBeNull();
  });

  it("AS-002: a dir holding only non-report XML yields no report, not a vouching one", () => {
    const dir = projectDir();
    write(dir, "target/failsafe-reports/failsafe-summary.xml", '<failsafe-summary timeout="false"><completed>0</completed></failsafe-summary>');

    expect(findReport("mvn verify", dir, "", times())).toBeNull();
  });

  it("AS-001: every trusted report of a run merges into one summary carrying all its files", () => {
    const dir = projectDir();
    write(dir, "core/target/surefire-reports/TEST-A.xml", junitSuite(result("com.example.A", 2, 0)));
    write(dir, "api/target/surefire-reports/TEST-B.xml", junitSuite(result("com.example.B", 1, 1)));

    const summary = findReport("mvn test", dir, "", times());

    expect(summary).toMatchObject({ total: 3, failed: 1, source: "junit-xml" });
    expect(summary?.files?.kind === "recorded" ? [...summary.files.results].sort(byFile) : summary?.files)
      .toEqual([result("com.example.A", 2, 0), result("com.example.B", 1, 1)]);
  });
});
