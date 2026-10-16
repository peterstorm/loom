/**
 * INV-5 matrix: a report's file identity (a path relative to some runner cwd,
 * an absolute path, or a JVM class) maps to a declared repository path only
 * through `attributeReportedFile`.
 *
 * Every row runs through the owner and through each sibling entry point that
 * exists in this slice: the Wave Gate's acceptance attribution in
 * `acceptance-contract/gate.ts` (`observeAcceptanceFacts`, and the
 * `testcaseAcceptanceFile` alias it keeps for its barrel callers). The I6
 * judge (`red-then-green.ts`) and the I7 failure renderer
 * (`affected-stop-check.ts`) gain their columns when they land (T7, T8).
 */

import { describe, expect, it } from "vitest";
import { attributeReportedFile } from "../../src/core/report-file-attribution";
import { observeAcceptanceFacts, testcaseAcceptanceFile } from "../../src/core/acceptance-contract/gate";
import type { AcceptanceExpectation } from "../../src/core/acceptance-contract";
import { parseArtifactDigest, type ArtifactDigest } from "../../src/core/orchestration-contract";

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
  { label: "an absolute path inside the repository, root with a trailing slash", reported: `${ROOT}/engine/tests/core/ledger.test.ts`, expected: "engine/tests/core/ledger.test.ts", needsRoot: true },
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
});
