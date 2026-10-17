/**
 * INV-5 matrix: a report's file identity (a path relative to some runner cwd,
 * an absolute path, or a JVM class) maps to a declared repository path only
 * through `attributeReportedFile`.
 *
 * Every row runs through the owner and through each sibling entry point:
 * - the Wave Gate's acceptance attribution in `acceptance-contract/gate.ts`
 *   (`observeAcceptanceFacts`, and the `testcaseAcceptanceFile` alias it keeps
 *   for its barrel callers);
 * - the I6 judge (`judgeRedThenGreen`), whose red step sees a failing file
 *   only when the owner attributes it to a Task test file;
 * - the I7 failure renderer (`renderAffectedBlock`), which shows the owner's
 *   declared path, or the reported identity when the owner finds none.
 */

import { describe, expect, it } from "vitest";
import { attributeReportedFile } from "../../src/core/report-file-attribution";
import { observeAcceptanceFacts, testcaseAcceptanceFile } from "../../src/core/acceptance-contract/gate";
import type { AcceptanceExpectation } from "../../src/core/acceptance-contract";
import { renderAffectedBlock } from "../../src/core/affected-stop-check";
import { parseArtifactDigest, type ArtifactDigest } from "../../src/core/orchestration-contract";
import { judgeRedThenGreen } from "../../src/core/red-then-green";
import { parseReportSummary } from "../../src/core/structured-test-report";
import type { Evidence } from "../../src/machine/types";

const ROOT = "/home/dev/repo";

const DECLARED: readonly string[] = [
  "engine/tests/acceptance/ledger.acceptance.test.ts",
  "engine/tests/core/ledger.test.ts",
  "pi/tests/core/ledger.test.ts",
  "svc/src/test/java/com/acme/LedgerTest.java",
  "svc/src/test/kotlin/com/acme/BillingTest.kt",
];

type Row = Readonly<{ label: string; reported: string; expected: string | null; needsRoot?: true }>;

const ROWS: readonly Row[] = [
  { label: "an exact repository path", reported: "engine/tests/core/ledger.test.ts", expected: "engine/tests/core/ledger.test.ts" },
  { label: "a ./-prefixed repository path", reported: "./engine/tests/core/ledger.test.ts", expected: "engine/tests/core/ledger.test.ts" },
  { label: "a runner-cwd-relative path with one match", reported: "tests/acceptance/ledger.acceptance.test.ts", expected: "engine/tests/acceptance/ledger.acceptance.test.ts" },
  { label: "a runner-cwd-relative path with two matches (ambiguous)", reported: "tests/core/ledger.test.ts", expected: null },
  { label: "a bare basename that is only a text suffix", reported: "ger.test.ts", expected: null },
  { label: "an undeclared file", reported: "engine/tests/core/other.test.ts", expected: null },
  { label: "a JVM class", reported: "com.acme.LedgerTest", expected: "svc/src/test/java/com/acme/LedgerTest.java" },
  { label: "a JVM nested class", reported: "com.acme.BillingTest$Nested", expected: "svc/src/test/kotlin/com/acme/BillingTest.kt" },
  { label: "an undeclared JVM class", reported: "com.acme.OtherTest", expected: null },
  { label: "an absolute path inside the repository", reported: `${ROOT}/pi/tests/core/ledger.test.ts`, expected: "pi/tests/core/ledger.test.ts", needsRoot: true },
  { label: "an absolute path outside the repository", reported: "/elsewhere/engine/tests/core/ledger.test.ts", expected: null },
  { label: "an absolute path in a sibling directory sharing the root's prefix", reported: `${ROOT}-copy/engine/tests/core/ledger.test.ts`, expected: null },
  { label: "the repository root itself", reported: ROOT, expected: null },
];

const digest = (): ArtifactDigest => {
  const parsed = parseArtifactDigest("b".repeat(64));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

/** The Wave Gate's attribution of one reported classname, read from the facts it observes. */
function gateAttribution(reported: string): string | null {
  const [first, ...rest] = DECLARED.map((path) => ({ path, anchors: ["AS-001"] as const }));
  const expectation: AcceptanceExpectation = {
    wave: 2,
    contracts: [{ contract: "CT-1", files: [first!, ...rest], dueWave: { "AS-001": 2 }, phase: "red" }],
    unobservable: [],
  };
  const facts = observeAcceptanceFacts(expectation, "project:verify", digest(), {
    ok: true,
    value: [{ classname: reported, name: "AS-001: decides", outcome: "passed", failureType: null }],
  });
  if (facts.kind !== "projected") throw new Error(`unprojectable: ${facts.reason}`);
  return facts.testcases[0]?.file ?? null;
}

const IMPLEMENTATION = "engine/src/core/ledger.ts";

/** A trusted failing run whose report names one file, by its reported identity. */
function failingRun(reported: string): Evidence {
  const report = parseReportSummary(1, 1, "junit-xml", {
    files: { kind: "recorded", results: [{ file: reported, executed: 1, failed: 1, skipped: 0, collectionError: false }] },
  });
  if (report === null) throw new Error("fixture report must reconcile");
  return { kind: "TestRun", command: "npm test", exit: 1, report };
}

/** The I6 judge's red step over one failing report: it is shown only when the
 *  reported file attributes to a Task test file, so with no green after the
 *  write the gap is `green-missing`; otherwise it is `red-missing`. */
function judgeRedStep(reported: string): string {
  const observation = judgeRedThenGreen(
    [failingRun(reported), { kind: "FileWrite", path: IMPLEMENTATION, via: "tool" }],
    { testFiles: DECLARED, implementationFiles: [IMPLEMENTATION] },
    ROOT,
    false,
  );
  return observation.kind === "unproven" ? observation.gap.kind : observation.kind;
}

/** The file the I7 block message shows for one failing reported testcase. */
function renderedFile(reported: string, repositoryRoot: string | null): string {
  const block = renderAffectedBlock(
    [{ file: reported, name: "AS-001: decides", outcome: "failed" }],
    { declared: DECLARED, repositoryRoot },
    "",
    1,
  );
  const line = block.split("\n").find((text) => text.startsWith("- 'AS-001: decides' ("));
  if (line === undefined) throw new Error("the block names the failing testcase");
  return line.slice("- 'AS-001: decides' (".length, line.lastIndexOf(") — failed"));
}

describe("INV-5: one reported-file to declared-file attribution", () => {
  it.each(ROWS)("owner: $label", ({ reported, expected }) => {
    expect(attributeReportedFile(DECLARED, reported, ROOT)).toBe(expected);
    expect(attributeReportedFile(DECLARED, reported, `${ROOT}/`)).toBe(expected);
  });

  it.each(ROWS)("owner without a known repository root: $label", ({ reported, expected, needsRoot }) => {
    // An absolute identity can only be made repository-relative against a root.
    expect(attributeReportedFile(DECLARED, reported, null)).toBe(needsRoot === true ? null : expected);
  });

  it.each(ROWS)("gate.ts attributes acceptance testcases through the owner: $label", ({ reported, needsRoot }) => {
    const owner = attributeReportedFile(DECLARED, reported, null);
    expect(testcaseAcceptanceFile(DECLARED, reported)).toBe(owner);
    expect(gateAttribution(reported)).toBe(owner);
    if (needsRoot === true) expect(owner).toBeNull();
  });

  it.each(ROWS)("red-then-green.ts sees a red only in a file the owner attributes: $label", ({ reported, expected }) => {
    expect(attributeReportedFile(DECLARED, reported, ROOT)).toBe(expected);
    expect(judgeRedStep(reported)).toBe(expected === null ? "red-missing" : "green-missing");
  });

  it.each(ROWS)("affected-stop-check.ts shows the owner's declared path, else the reported file: $label", ({ reported }) => {
    expect(renderedFile(reported, ROOT)).toBe(attributeReportedFile(DECLARED, reported, ROOT) ?? reported);
    expect(renderedFile(reported, null)).toBe(attributeReportedFile(DECLARED, reported, null) ?? reported);
  });
});
