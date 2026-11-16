import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { observeAcceptanceFacts } from "../../src/core/acceptance-contract/gate";
import { parseArtifactDigest } from "../../src/core/orchestration-contract/identity";
import { parseJunitTestcasesUnder, testcasesUnderRunRoot } from "../../src/core/report-run-root";
import { parseJunitTestcases, type ReportTestcase } from "../../src/core/structured-test-report";
import { contract, surface, task } from "../fixtures/contract-status-fixtures";
import { graphAcceptanceExpectation } from "../../src/core/acceptance-contract";

const ROOT = "/Users/someone/app";

/** A Mocha `xunit` report: one suite, each testcase's file an absolute path. */
const mochaReport = (cases: readonly Readonly<{ file: string; name: string; failure?: string }>[]): Uint8Array =>
  new TextEncoder().encode(
    `<testsuite name="Mocha Tests" tests="${cases.length}" failures="0" errors="${cases.filter((c) => c.failure !== undefined).length}">` +
    cases.map(({ file, name, failure }) => `<testcase classname="suite" name="${name}" file="${file}">` +
      (failure === undefined ? "" : `<failure>${failure}</failure>`) + "</testcase>").join("") +
    "</testsuite>",
  );

const filesOf = (bytes: Uint8Array, root: string): readonly string[] => {
  const parsed = parseJunitTestcasesUnder(bytes, root);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.map(({ file }) => file);
};

describe("parseJunitTestcasesUnder", () => {
  it("makes an absolute file inside the run root relative to it", () => {
    expect(filesOf(mochaReport([{ file: `${ROOT}/tests/a.test.ts`, name: "a" }]), ROOT)).toEqual(["tests/a.test.ts"]);
    expect(filesOf(mochaReport([{ file: `${ROOT}/tests/a.test.ts`, name: "a" }]), `${ROOT}/`)).toEqual(["tests/a.test.ts"]);
  });

  it("leaves a file outside the run root, or a lookalike sibling root, exactly as reported", () => {
    expect(filesOf(mochaReport([{ file: `/elsewhere/tests/a.test.ts`, name: "a" }]), ROOT)).toEqual(["/elsewhere/tests/a.test.ts"]);
    expect(filesOf(mochaReport([{ file: `${ROOT}-copy/tests/a.test.ts`, name: "a" }]), ROOT)).toEqual([`${ROOT}-copy/tests/a.test.ts`]);
    expect(filesOf(mochaReport([{ file: ROOT, name: "a" }]), ROOT)).toEqual([ROOT]);
  });

  it("passes a refused report through unchanged", () => {
    const refused = parseJunitTestcases(new TextEncoder().encode("not xml"));
    expect(refused.ok).toBe(false);
    expect(testcasesUnderRunRoot(refused, ROOT)).toBe(refused);
  });

  it("property: relative files never change, and every other field of a testcase is kept", () => {
    const testcase: fc.Arbitrary<ReportTestcase> = fc.record({
      file: fc.oneof(
        fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,3}\.test\.ts$/),
        fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,3}\.test\.ts$/).map((path) => `${ROOT}/${path}`),
      ),
      classname: fc.string({ maxLength: 8 }),
      name: fc.string({ maxLength: 8 }),
      outcome: fc.constantFrom("passed", "failed", "skipped"),
      failureType: fc.option(fc.constantFrom("Error", "AssertionError"), { nil: null }),
    });
    fc.assert(fc.property(fc.array(testcase, { maxLength: 6 }), (cases) => {
      const projected = testcasesUnderRunRoot({ ok: true, value: cases }, ROOT);
      if (!projected.ok) throw new Error("a parsed projection stays parsed");
      projected.value.forEach((after, index) => {
        const before = cases[index]!;
        expect({ ...after, file: null }).toEqual({ ...before, file: null });
        expect(after.file).toBe(before.file.startsWith(`${ROOT}/`) ? before.file.slice(ROOT.length + 1) : before.file);
      });
    }));
  });
});

describe("a contract Wave's acceptance facts over a Mocha report", () => {
  it("attributes each absolute acceptance testcase inside the repository, and only those", () => {
    const SURFACE = surface("payload");
    const awaiting = contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
    const expectation = graphAcceptanceExpectation({ acceptance_contracts: [awaiting], tasks: [task("T1", 1, [SURFACE.types, SURFACE.acceptance])] }, 1);
    const digest = parseArtifactDigest("a".repeat(64));
    if (!digest.ok) throw new Error("fixture digest");
    const report = mochaReport([
      { file: `${ROOT}/${SURFACE.acceptance}`, name: "AS-001: one valid call wins", failure: "unimplemented: rule" },
      { file: `/elsewhere/${SURFACE.acceptance}`, name: "AS-001: a stranger", failure: "unimplemented: rule" },
    ]);
    const facts = observeAcceptanceFacts(expectation, "project:unit", digest.value, parseJunitTestcasesUnder(report, ROOT));
    expect(facts.kind).toBe("projected");
    if (facts.kind !== "projected") return;
    expect(facts.testcases.map(({ file, name }) => [file, name])).toEqual([[SURFACE.acceptance, "AS-001: one valid call wins"]]);
  });
});
