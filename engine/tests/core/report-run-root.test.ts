import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { graphAcceptanceExpectation, observeAcceptanceFacts } from "../../src/core/acceptance-contract";
import { parseArtifactDigest } from "../../src/core/orchestration-contract/identity";
import { parseJunitTestcasesUnder, parseRunRoot } from "../../src/core/report-run-root";
import { contract, surface, task } from "../fixtures/contract-status-fixtures";
import { mochaXunit, RUN_ROOT, type MochaCase } from "../fixtures/mocha-report";

const filesOf = (cases: readonly MochaCase[]): readonly string[] => {
  const parsed = parseJunitTestcasesUnder(mochaXunit(cases), RUN_ROOT);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.map(({ file }) => file);
};

describe("parseRunRoot", () => {
  it.each(["/", "/repo", "/Users/someone/app", "/private/tmp/loom-run.x1"])("mints %s", (raw) => {
    expect(parseRunRoot(raw)).toEqual({ ok: true, value: raw });
  });

  it.each(["", "repo", "./repo", "/repo/", "/repo//app", "/repo/./app", "/repo/../app", "C:\\repo", "/repo\\app"])(
    "refuses %j: a run root is an absolute, normalized POSIX path",
    (raw) => {
      expect(parseRunRoot(raw).ok).toBe(false);
    },
  );
});

describe("parseJunitTestcasesUnder", () => {
  it("makes an absolute file inside the run root relative to it", () => {
    expect(filesOf([{ file: `${RUN_ROOT}/tests/a.test.ts`, name: "a" }])).toEqual(["tests/a.test.ts"]);
  });

  it("leaves a file outside the run root, under a lookalike sibling root, or the root itself exactly as reported", () => {
    expect(filesOf([{ file: "/elsewhere/tests/a.test.ts", name: "a" }])).toEqual(["/elsewhere/tests/a.test.ts"]);
    expect(filesOf([{ file: `${RUN_ROOT}-copy/tests/a.test.ts`, name: "a" }])).toEqual([`${RUN_ROOT}-copy/tests/a.test.ts`]);
    expect(filesOf([{ file: RUN_ROOT, name: "a" }])).toEqual([RUN_ROOT]);
  });

  it("passes a refused report through unchanged", () => {
    const refused = parseJunitTestcasesUnder(new TextEncoder().encode("not xml"), RUN_ROOT);
    expect(refused.ok).toBe(false);
  });

  it("property: a relative file never changes, an absolute one inside the root loses exactly the root, and every other field is kept", () => {
    const relativePath = fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,3}\.test\.ts$/);
    const mochaCase: fc.Arbitrary<MochaCase & Readonly<{ relative: string }>> = fc.record({
      relative: relativePath,
      absolute: fc.boolean(),
      name: fc.stringMatching(/^[a-z]{1,10}$/),
      failure: fc.option(fc.constant("AssertionError: no"), { nil: undefined }),
    }).map(({ relative, absolute, name, failure }) =>
      ({ relative, name, file: absolute ? `${RUN_ROOT}/${relative}` : relative, ...(failure === undefined ? {} : { failure }) }));
    fc.assert(fc.property(fc.array(mochaCase, { minLength: 1, maxLength: 6 }), (cases) => {
      const parsed = parseJunitTestcasesUnder(mochaXunit(cases), RUN_ROOT);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.value.map(({ file }) => file)).toEqual(cases.map(({ relative }) => relative));
      expect(parsed.value.map(({ name, outcome }) => [name, outcome]))
        .toEqual(cases.map(({ name, failure }) => [name, failure === undefined ? "passed" : "failed"]));
    }));
  });
});

describe("a contract Wave's acceptance facts over a Mocha report", () => {
  it("attributes each absolute acceptance testcase inside the run root, and only those", () => {
    const SURFACE = surface("payload");
    const awaiting = contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
    const expectation = graphAcceptanceExpectation({ acceptance_contracts: [awaiting], tasks: [task("T1", 1, [SURFACE.types, SURFACE.acceptance])] }, 1);
    const digest = parseArtifactDigest("a".repeat(64));
    if (!digest.ok) throw new Error("fixture digest");
    const report = mochaXunit([
      { file: `${RUN_ROOT}/${SURFACE.acceptance}`, name: "AS-001: one valid call wins", failure: "unimplemented: rule" },
      { file: `/elsewhere/${SURFACE.acceptance}`, name: "AS-001: a stranger", failure: "unimplemented: rule" },
    ]);
    const facts = observeAcceptanceFacts(expectation, "project:unit", digest.value, parseJunitTestcasesUnder(report, RUN_ROOT));
    expect(facts.kind).toBe("projected");
    if (facts.kind !== "projected") return;
    expect(facts.testcases.map(({ file, name }) => [file, name])).toEqual([[SURFACE.acceptance, "AS-001: one valid call wins"]]);
    expect(facts.otherFailures).toBe(1);
  });
});
