import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  mergeSummaries, parseJunitXml, parseReportCounts, parseReportSummary, parseStructuredTestReportBytes, parseVitestJson,
} from "../../src/core/structured-test-report";

const parse = (xml: string) => parseStructuredTestReportBytes(new TextEncoder().encode(xml));
const nodeCounts = (tests = 1, pass = 1, fail = 0, cancelled = 0, skipped = 0, todo = 0) =>
  `<!-- tests ${tests} --><!-- pass ${pass} --><!-- fail ${fail} --><!-- cancelled ${cancelled} --><!-- skipped ${skipped} --><!-- todo ${todo} -->`;
const suite = '<testsuite tests="1" failures="0"><testcase name="real"/></testsuite>';

describe("structural JUnit authorization", () => {
  it.each([
    ["comment-only", `<!-- ${suite} -->`],
    ["CDATA-only", `<![CDATA[${suite}]]>`],
    ["comment pretending to be a suite", `<testsuites><!-- ${suite} --></testsuites>`],
    ["CDATA pretending to be a suite", `<testsuites><![CDATA[${suite}]]></testsuites>`],
    ["mixed fake suite and actual empty suite", `<testsuites><!-- ${suite} --><testsuite tests="0"/></testsuites>`],
    ["mixed fake suite and real skipped case", `<testsuites><!-- ${suite} --><testsuite tests="1" skipped="1"><testcase><skipped/></testcase></testsuite></testsuites>`],
    ["missing closing tag", '<testsuite tests="1">'],
    ["count in a different attribute", '<testsuite data-tests="1"/>'],
    ["unbound namespace", '<testsuite tests="1"><x:diagnostic/></testsuite>'],
    ["invalid character entity", '<testsuite tests="1" name="&#0;"/>'],
    ["invalid comment", `<testsuites><!-- illegal -- comment -->${suite}</testsuites>`],
    ["mismatched tags", '<testsuite tests="1"></testsuites>'],
    ["duplicate attributes", '<testsuite tests="1" tests="2"/>'],
    ["unquoted attribute", '<testsuite tests="1" failures=0/>'],
    ["multiple roots", `${suite}${suite}`],
    ["trailing junk", `${suite}junk`],
    ["invalid character", `<testsuite tests="1">\u0000</testsuite>`],
    ["unknown entity", '<testsuite tests="1" name="&unknown;"/>'],
    ["bare doctype", `<!DOCTYPE testsuite>${suite}`],
    ["external DTD", `<!DOCTYPE testsuite SYSTEM "https://example.invalid/report.dtd">${suite}`],
    ["internal DTD", `<!DOCTYPE testsuite [<!ENTITY local "safe">]>${suite}`],
    ["external entity", '<!DOCTYPE testsuite [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuite tests="1" name="&xxe;"/>'],
    ["wrong root", `<wrapper>${suite}</wrapper>`],
    ["hidden suite", `<testsuites><system-out>${suite}</system-out></testsuites>`],
    ["comment summary without cases", `<testsuites>${nodeCounts()}</testsuites>`],
    ["comment pretending to be testcase", `<testsuites><!-- <testcase/> -->${nodeCounts()}</testsuites>`],
    ["CDATA pretending to be testcase", `<testsuites><![CDATA[<testcase/>]]>${nodeCounts()}</testsuites>`],
    ["summary outside report", `<testsuites><testcase/></testsuites>${nodeCounts()}`],
    ["summary inside diagnostic", `<testsuites><testcase/><system-out>${nodeCounts()}</system-out></testsuites>`],
    ["summary disagrees with real skipped case", `<testsuites><testcase><skipped/></testcase>${nodeCounts()}</testsuites>`],
    ["hidden testcase", `<testsuites><system-out><testcase/></system-out>${nodeCounts()}</testsuites>`],
  ])("%s cannot authorize positive execution", (_name, xml) => {
    const result = parse(xml);
    expect(result.ok && result.value.total > 0).toBe(false);
  });

  it.each([
    '<testsuite tests="0">',
    '<testsuite tests="0"></testsuites>',
    '<testsuite tests="0" tests="0"/>',
    '<testsuite tests="0" name="&unknown;"/>',
    '<!DOCTYPE testsuite><testsuite tests="0"/>',
    '<!DOCTYPE testsuite SYSTEM "https://example.invalid/report.dtd"><testsuite tests="0"/>',
    '<!DOCTYPE testsuite [<!ENTITY safe "text">]><testsuite tests="0"/>',
    `${suite}junk`,
  ])("strict XML rejection also applies to zero-count reports: %s", (xml) => {
    expect(parse(xml).ok).toBe(false);
    expect(parseJunitXml(xml)).toBeNull();
  });

  it.each([
    `<!-- ${suite} -->`, '<testsuite tests="1">', `<!DOCTYPE testsuite>${suite}`,
  ])("legacy JUnit API also rejects non-report XML: %s", (xml) => {
    expect(parseJunitXml(xml)).toBeNull();
  });

  it("preserves declared-count legacy APIs without using them for executed P3 totals", () => {
    const xml = '<testsuite tests="3" skipped="2"/>';
    expect(parseJunitXml(xml)).toEqual({ total: 3, failed: 0, source: "junit-xml" });
    expect(parse(xml)).toEqual({ ok: true, value: { total: 1, failed: 0, source: "junit-xml" } });
    const json = JSON.stringify({ numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 2, numTodoTests: 0 });
    expect(parseVitestJson(json)).toEqual({ total: 3, failed: 0, source: "vitest-json" });
    expect(parse(json)).toEqual({ ok: true, value: { total: 1, failed: 0, source: "vitest-json" } });
  });

  it("ignores fake diagnostic elements but preserves actual failures", () => {
    const xml = `<testsuite tests="1" failures="1"><testcase><failure><![CDATA[<skipped/>]]><!-- <testcase/> --></failure></testcase></testsuite>`;
    expect(parse(xml)).toEqual({ ok: true, value: { total: 1, failed: 1, source: "junit-xml" } });
  });

  it("accepts safe XML entities, single quotes, and diagnostic CDATA", () => {
    const xml = `<testsuite tests='&#49;' failures='0' name='&amp;&lt;&gt;&quot;&apos;&#x1F600;'><testcase name='safe'><system-out><![CDATA[<testsuite tests="99"/>]]></system-out></testcase></testsuite>`;
    expect(parse(xml)).toEqual({ ok: true, value: { total: 1, failed: 0, source: "junit-xml" } });
  });

  it("counts Node leaf cases across nested suites without double counting their attributes", () => {
    const xml = `<testsuites><testsuite tests="2" failures="1" skipped="1"><testsuite tests="2" failures="1" skipped="1"><testcase><failure/></testcase><testcase><skipped/></testcase></testsuite><testcase/></testsuite>${nodeCounts(3, 1, 1, 0, 1)}</testsuites>`;
    expect(parse(xml)).toEqual({ ok: true, value: { total: 2, failed: 1, source: "junit-xml" } });
  });

  it("includes Node cancellations as failed executions", () => {
    const xml = `<testsuites><testcase><failure type="cancelledByParent"/></testcase>${nodeCounts(1, 0, 0, 1)}</testsuites>`;
    expect(parse(xml)).toEqual({ ok: true, value: { total: 1, failed: 1, source: "junit-xml" } });
  });

  it("does not double count nested traditional JUnit suite totals", () => {
    expect(parse(`<testsuites tests="1"><testsuite tests="1">${suite}</testsuite></testsuites>`))
      .toEqual({ ok: true, value: { total: 1, failed: 0, source: "junit-xml" } });
  });

  it.each([
    '<testsuite tests="1" failures="0"><testcase><failure/></testcase></testsuite>',
    '<testsuite tests="2"><testcase/></testsuite>',
    '<testsuite tests="1" skipped="invalid"/>',
    '<testsuites tests="2"><testsuite tests="1"/></testsuites>',
    `<testsuites><testcase/>${nodeCounts()}<!-- pass 1 --></testsuites>`,
  ])("rejects inconsistent or malformed count claims: %s", (xml) => {
    expect(parse(xml).ok).toBe(false);
  });
});

describe("summary minting invariants", () => {
  it("freezes every public summary producer at runtime", () => {
    const summary = parseReportSummary(1, 0, "junit-xml", undefined)!;
    for (const value of [summary, parseReportCounts(1, 0, "junit-xml")!, parseJunitXml(suite)!, parseVitestJson('{"numTotalTests":1,"numFailedTests":0}')!, mergeSummaries([summary])!]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, "total", 99)).toBe(false);
      expect(Reflect.set(value, "failed", 99)).toBe(false);
      expect(Reflect.set(value, "source", "forged")).toBe(false);
      expect(value.total).toBe(1);
      expect(value.failed).toBe(0);
    }
  });

  it("rejects unsafe integers and overflow during merging", () => {
    expect(parseReportSummary(Number.MAX_SAFE_INTEGER + 1, 0, "junit-xml", undefined)).toBeNull();
    expect(mergeSummaries([parseReportSummary(Number.MAX_SAFE_INTEGER, 0, "junit-xml", undefined)!, parseReportSummary(1, 0, "junit-xml", undefined)!])).toBeNull();
  });

  it("generated comment/CDATA markup cannot add executions", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000000 }), (count) => {
      const fake = `<testsuite tests="${count}" failures="0"/>`;
      for (const inert of [`<!-- ${fake} -->`, `<![CDATA[${fake}]]>`]) {
        const result = parse(`<testsuites>${inert}<testsuite tests="0"/></testsuites>`);
        expect(result.ok && result.value.total > 0).toBe(false);
      }
    }), { numRuns: 100 });
  });

  it("arbitrary input never throws or returns unsafe mutable summaries", () => {
    fc.assert(fc.property(fc.string({ maxLength: 500 }), (content) => {
      const result = parse(content);
      if (result.ok) {
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(Number.isSafeInteger(result.value.total)).toBe(true);
        expect(result.value.failed).toBeGreaterThanOrEqual(0);
        expect(result.value.failed).toBeLessThanOrEqual(result.value.total);
      }
    }), { numRuns: 300 });
  });

  it("generated actual cases conserve executed, skipped, and failed counts", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("passed", "failed", "skipped"), { minLength: 1, maxLength: 40 }), (outcomes) => {
      const failed = outcomes.filter((o) => o === "failed").length;
      const skipped = outcomes.filter((o) => o === "skipped").length;
      const cases = outcomes.map((o) => `<testcase>${o === "failed" ? "<failure/>" : o === "skipped" ? "<skipped/>" : ""}</testcase>`).join("");
      const result = parse(`<testsuite tests="${outcomes.length}" failures="${failed}" skipped="${skipped}">${cases}</testsuite>`);
      expect(result).toEqual({ ok: true, value: { total: outcomes.length - skipped, failed, source: "junit-xml" } });
      if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
    }), { numRuns: 100 });
  });
});
