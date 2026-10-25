import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FAMILIES,
  familySiteDelta,
  parseFamilySiteBaseline,
  renderFamilySites,
  scanFamilySites,
  serializeFamilySites,
  type FamilySiteReport,
  type SourceFile,
} from "../../src/core/family-sites";
import {
  DEFAULT_PURE_MODULES,
  handler as noIoInPureModules,
} from "../../src/linter/programmatic/no-io-in-pure-modules";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = (path: string, ...lines: string[]): SourceFile => ({ path, text: lines.join("\n") });

const familyOf = (report: FamilySiteReport, id: string) => {
  const found = report.families.find(({ family }) => family === id);
  if (found === undefined) throw new Error(`family ${id} missing from report`);
  return found;
};

/** One raw site per calibrated pattern, each in a non-owner engine source file. */
const RAW_SITES: readonly SourceFile[] = [
  file("engine/src/handlers/a.ts",
    "import { existsSync } from 'node:fs';",
    "if (!existsSync(path)) return null;",
    "const x = 1;",
    "if ((error as NodeJS.ErrnoException).code === \"ENOENT\") return null;"),
  file("engine/src/core/b.ts",
    "const words = command.split(/\\s+/);",
    "if (c === '\"' || c === \"'\") { quote = c; continue; }",
    "let inSingleQuote = false;"),
  file("engine/src/core/c.ts",
    "const patch = {",
    "  critical_findings: [...claims],",
    "  advisory_findings: Object.freeze([]),",
    "};",
    "remaining.splice(index, 1);"),
];

describe("family-site metric (pure core)", () => {
  it("defines exactly the three known families, each with owners and patterns, in one table", () => {
    expect(FAMILIES.map(({ id }) => id)).toEqual([
      "fail-closed-path-probes",
      "shell-tokenizing",
      "claim-conservation",
    ]);
    const byId = new Map(FAMILIES.map((family) => [family.id, family]));
    expect(byId.get("fail-closed-path-probes")!.owners).toEqual(["engine/src/utils/path-presence.ts"]);
    expect(byId.get("shell-tokenizing")!.owners).toEqual([
      "engine/src/core/shell-quoting.ts",
      "engine/src/core/shell-command.ts",
      "engine/src/core/shell-normalize.ts",
      "engine/src/core/shell-substitution.ts",
      "engine/src/core/shell-write-targets.ts",
      "engine/src/core/shell-ansi-c.ts",
    ]);
    expect(byId.get("claim-conservation")!.owners).toEqual(["engine/src/core/findings.ts"]);
    for (const family of FAMILIES) {
      expect(family.patterns.length).toBeGreaterThan(0);
      // A global regex carries lastIndex state: the scan would be order-dependent.
      for (const pattern of family.patterns) expect(pattern.flags).not.toContain("g");
    }
  });

  it("AS-031: reports each family's count and path:line list of raw sites outside its owners", () => {
    const report = scanFamilySites(RAW_SITES);

    expect(report.families.map(({ family }) => family)).toEqual(FAMILIES.map(({ id }) => id));
    expect(familyOf(report, "fail-closed-path-probes")).toMatchObject({
      sites: ["engine/src/handlers/a.ts:2", "engine/src/handlers/a.ts:4"],
      owners: ["engine/src/utils/path-presence.ts"],
    });
    expect(familyOf(report, "shell-tokenizing")).toMatchObject({
      sites: ["engine/src/core/b.ts:1", "engine/src/core/b.ts:2", "engine/src/core/b.ts:3"],
    });
    expect(familyOf(report, "claim-conservation")).toMatchObject({
      sites: ["engine/src/core/c.ts:2", "engine/src/core/c.ts:3", "engine/src/core/c.ts:5"],
    });
    // The patterns reported are the table's patterns: one definition, echoed.
    for (const family of FAMILIES) {
      expect(familyOf(report, family.id).patterns).toEqual(family.patterns.map(({ source }) => source));
    }
  });

  it("AS-031: excludes each family's owner modules, but only from that family", () => {
    const owner = file("engine/src/utils/path-presence.ts",
      "if (existsSync(path)) return true;",
      "remaining.splice(index, 1);");
    const shellOwner = file("engine/src/core/shell-normalize.ts", "const t = s.split(/\\s+/);");
    const findingsOwner = file("engine/src/core/findings.ts", "remaining.splice(index, 1);");
    const report = scanFamilySites([owner, shellOwner, findingsOwner]);

    expect(familyOf(report, "fail-closed-path-probes").sites).toEqual([]);
    expect(familyOf(report, "shell-tokenizing").sites).toEqual([]);
    // path-presence.ts owns path probes, not claim conservation.
    expect(familyOf(report, "claim-conservation").sites).toEqual(["engine/src/utils/path-presence.ts:2"]);
  });

  it("AS-031: scans only engine/src TypeScript sources, never test files, and skips comment lines", () => {
    const report = scanFamilySites([
      file("engine/src/handlers/a.test.ts", "existsSync(x);"),
      file("engine/src/handlers/a.spec.ts", "existsSync(x);"),
      file("engine/tests/handlers/a.ts", "existsSync(x);"),
      file("scripts/a.ts", "existsSync(x);"),
      file("engine/src/handlers/a.js", "existsSync(x);"),
      file("engine/src/handlers/b.ts",
        "// existsSync(x) used to be here",
        " * existsSync(x) in a doc comment",
        "/* existsSync(x) */",
        "existsSync(x);"),
      file("engine\\src\\handlers\\c.ts", "existsSync(x);"),
    ]);

    expect(familyOf(report, "fail-closed-path-probes").sites).toEqual([
      "engine/src/handlers/b.ts:4",
      "engine/src/handlers/c.ts:1",
    ]);
  });

  it("AS-031: does not count non-probe ENOENT mentions, type annotations or one-sided quote checks", () => {
    const report = scanFamilySites([file("engine/src/core/d.ts",
      "const CODES = new Set([\"ELOOP\", \"ENOENT\"]);",
      "readonly critical_findings?: readonly string[];",
      "critical_findings: readonly string[];",
      "critical_findings?: never;",
      "const view = (critical ? task.critical_findings : task.advisory_findings) ?? [];",
      "if (char === '\"') quoted = true;",
      "const parts = text.split(\" \");",
      "const surviving_critical_findings = [];")]);

    for (const family of report.families) expect(family.sites).toEqual([]);
  });

  it("AS-031: sorts sites by path, then by line number, not by text", () => {
    const report = scanFamilySites([
      file("engine/src/z.ts", ...Array.from({ length: 10 }, () => "existsSync(x);")),
      file("engine/src/a.ts", "existsSync(x);"),
    ]);

    expect(familyOf(report, "fail-closed-path-probes").sites).toEqual([
      "engine/src/a.ts:1",
      ...Array.from({ length: 10 }, (_, index) => `engine/src/z.ts:${index + 1}`),
    ]);
  });

  it("AS-032: the same repository bytes give byte-identical output, whatever order files are read in", () => {
    const lines = fc.constantFrom(
      "existsSync(x);", "const a = 1;", "x.split(/\\s+/)", "  critical_findings: [],",
      "if (e.code !== 'ENOENT') throw e;", "// existsSync(x)", "pool.splice(at, 1);",
    );
    const sources = fc.uniqueArray(
      fc.record({
        path: fc.constantFrom(
          "engine/src/a.ts", "engine/src/b/c.ts", "engine/src/core/findings.ts",
          "engine/src/utils/path-presence.ts", "engine/src/x.test.ts", "other/y.ts",
        ),
        text: fc.array(lines, { maxLength: 12 }).map((rows) => rows.join("\n")),
      }),
      { selector: ({ path }) => path },
    );
    fc.assert(fc.property(sources, fc.nat(), (files, seed) => {
      const shuffled = [...files].sort((a, b) => ((a.path.length * 31 + seed) % 7) - ((b.path.length * 31 + seed) % 7));
      const first = serializeFamilySites(scanFamilySites(files), null);
      const second = serializeFamilySites(scanFamilySites(shuffled), null);
      expect(second).toBe(first);
      expect(renderFamilySites(scanFamilySites(shuffled), null)).toBe(renderFamilySites(scanFamilySites(files), null));
      for (const family of JSON.parse(first).families) expect(family.count).toBe(family.sites.length);
    }));
  });

  it("derives each family's count from its sites: the report stores no count, the JSON writes it in baseline key order", () => {
    const report = scanFamilySites(RAW_SITES);
    for (const family of report.families) expect(Object.keys(family)).toEqual(["family", "owners", "patterns", "sites"]);

    const written = JSON.parse(serializeFamilySites(report, null));
    expect(Object.keys(written)).toEqual(["schema", "families"]);
    for (const [index, family] of written.families.entries()) {
      expect(Object.keys(family)).toEqual(["family", "owners", "patterns", "count", "sites"]);
      expect(family.count).toBe(report.families[index]!.sites.length);
    }
  });

  it("AS-032: JSON output parses back to the same report (round trip through the baseline parser)", () => {
    const report = scanFamilySites(RAW_SITES);
    const parsed = parseFamilySiteBaseline(JSON.parse(serializeFamilySites(report, null)));

    expect(parsed).toEqual({ ok: true, value: { families: report.families } });
  });

  it("AS-033: reports the per-family delta against a recorded baseline", () => {
    const baselineReport = scanFamilySites(RAW_SITES);
    const current = scanFamilySites([
      ...RAW_SITES.slice(0, 2),
      file("engine/src/core/c.ts", "remaining.splice(index, 1);"),
      file("engine/src/core/e.ts", "existsSync(a);", "existsSync(b);"),
    ]);
    const baseline = parseFamilySiteBaseline(JSON.parse(serializeFamilySites(baselineReport, null)));
    if (!baseline.ok) throw new Error(baseline.error);

    expect(familySiteDelta(current, baseline.value)).toEqual([
      { kind: "compared", family: "fail-closed-path-probes", baseline: 2, current: 4, delta: 2, patternsChanged: false },
      { kind: "compared", family: "shell-tokenizing", baseline: 3, current: 3, delta: 0, patternsChanged: false },
      { kind: "compared", family: "claim-conservation", baseline: 3, current: 1, delta: -2, patternsChanged: false },
    ]);
  });

  it("AS-033: names families missing from the baseline, families the baseline retired, and changed patterns", () => {
    const current = scanFamilySites(RAW_SITES);
    const baseline = parseFamilySiteBaseline({
      schema: 1,
      families: [
        { family: "shell-tokenizing", owners: ["x.ts"], patterns: ["old"], count: 1, sites: ["engine/src/q.ts:1"] },
        { family: "retired-family", owners: ["y.ts"], patterns: ["p"], count: 2, sites: ["engine/src/q.ts:1", "engine/src/q.ts:2"] },
      ],
    });
    if (!baseline.ok) throw new Error(baseline.error);

    const delta = familySiteDelta(current, baseline.value);
    expect(delta).toEqual([
      { kind: "unrecorded", family: "fail-closed-path-probes", current: 2 },
      { kind: "compared", family: "shell-tokenizing", baseline: 1, current: 3, delta: 2, patternsChanged: true },
      { kind: "unrecorded", family: "claim-conservation", current: 3 },
      { kind: "retired", family: "retired-family", baseline: 2 },
    ]);
    const human = renderFamilySites(current, delta);
    expect(human).toContain("shell-tokenizing: 3 (baseline 1, +2; patterns changed since the baseline)");
    expect(human).toContain("fail-closed-path-probes: 2 (not in the baseline)");
    expect(human).toContain("retired-family: retired (baseline 2)");
    const json = JSON.parse(serializeFamilySites(current, delta));
    expect(json.delta).toEqual(delta);
  });

  it("AS-033: refuses a malformed baseline with the reason, instead of comparing against it", () => {
    const refused = (value: unknown): string => {
      const result = parseFamilySiteBaseline(value);
      if (result.ok) throw new Error("expected a refusal");
      return result.error;
    };
    expect(refused(null)).toMatch(/object/);
    expect(refused({ schema: 2, families: [] })).toMatch(/schema/);
    expect(refused({ schema: 1, families: {} })).toMatch(/families/);
    expect(refused({ schema: 1, families: [{ family: "", owners: [], patterns: [], count: 0, sites: [] }] })).toMatch(/family/);
    expect(refused({ schema: 1, families: [{ family: "f", owners: [], patterns: [], count: 1, sites: [] }] })).toMatch(/count/);
    expect(refused({ schema: 1, families: [{ family: "f", owners: [], patterns: [], count: -1, sites: [] }] })).toMatch(/count/);
    expect(refused({ schema: 1, families: [{ family: "f", owners: [], patterns: [], count: 1, sites: [3] }] })).toMatch(/sites/);
    expect(refused({ schema: 1, families: [{ family: "f", owners: [1], patterns: [], count: 0, sites: [] }] })).toMatch(/owners/);
    expect(refused({ schema: 1, families: [{ family: "f", owners: [], patterns: [1], count: 0, sites: [] }] })).toMatch(/patterns/);
    const duplicate = { family: "f", owners: [], patterns: [], count: 0, sites: [] };
    expect(refused({ schema: 1, families: [duplicate, duplicate] })).toMatch(/more than once/);
  });

  it("renders a human report: one header per family with owners, then its sites", () => {
    const human = renderFamilySites(scanFamilySites(RAW_SITES), null);

    expect(human.endsWith("\n")).toBe(true);
    expect(human).toContain("fail-closed-path-probes: 2 raw sites outside engine/src/utils/path-presence.ts");
    expect(human).toContain("  engine/src/handlers/a.ts:2");
    expect(human).toContain("claim-conservation: 3 raw sites outside engine/src/core/findings.ts");
  });

  it("is listed as a pure module, and its own source passes the purity rule", () => {
    expect(DEFAULT_PURE_MODULES).toContain("engine/src/core/family-sites.ts");
    const source = readFileSync(resolve(__dirname, "../../src/core/family-sites.ts"), "utf-8");
    expect(noIoInPureModules(source, "engine/src/core/family-sites.ts")).toEqual([]);
  });
});
