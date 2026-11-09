/**
 * `--write-baseline` as data (`baseline-config.ts`): the recorded lists and the
 * config object they produce, tested without a filesystem. The script's own
 * I/O (walk, harness directories, exit codes) is covered by
 * `tests/linter/lint-project-cli.test.ts`.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { configWithBaselines, recordedBaselines, type RecordedBaseline } from "../../../src/linter/programmatic/baseline-config";
import type { BaselineOwner } from "../../../src/linter/programmatic/baseline";
import { baselineOwners } from "../../../src/linter/programmatic/index";

/** An owner whose detector flags every line that starts with `marker`. */
const markerOwner = (configKey: BaselineOwner["configKey"], marker: string, extensions: readonly string[] = [".ts"]): BaselineOwner => ({
  rule: `${configKey}-rule`,
  configKey,
  extensions,
  baseline: [],
  site: "marked line",
  detect: (content, path) => content.split("\n").filter((line) => line.startsWith(marker)).map((line) => `${path}::${line}`),
});

const SWITCH = markerOwner("switchTotalityBaseline", "S");
const CHAIN = markerOwner("discriminantBranchingBaseline", "C");

describe("recordedBaselines", () => {
  it("runs each owner's detector over the sources its extensions cover, sorted per owner", () => {
    const recorded = recordedBaselines([SWITCH, CHAIN], [
      { path: "src/b.ts", content: "S2\nC1" },
      { path: "src/a.ts", content: "S1" },
      { path: "src/ignored.java", content: "S9\nC9" },
    ]);
    expect(recorded).toEqual([
      { configKey: "switchTotalityBaseline", keys: ["src/a.ts::S1", "src/b.ts::S2"] },
      { configKey: "discriminantBranchingBaseline", keys: ["src/b.ts::C1"] },
    ]);
  });

  it("ignores the owner's current baseline: a since-proven site drops out on a re-record", () => {
    const owner = { ...SWITCH, baseline: ["src/a.ts::S-gone"] };
    expect(recordedBaselines([owner], [{ path: "src/a.ts", content: "S1" }])).toEqual([
      { configKey: "switchTotalityBaseline", keys: ["src/a.ts::S1"] },
    ]);
  });

  it("records an empty list for an owner with no live site", () => {
    expect(recordedBaselines([SWITCH], [{ path: "src/a.ts", content: "clean" }]))
      .toEqual([{ configKey: "switchTotalityBaseline", keys: [] }]);
  });

  it("drives the real registered owners over a real unproven switch", () => {
    const owners = baselineOwners({}, null);
    const source = [
      "type Shape = { kind: 'a' } | { kind: 'b' };",
      "export function f(s: Shape): number {",
      "  switch (s.kind) {",
      "    case 'a': return 1;",
      "    case 'b': return 2;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const recorded = recordedBaselines(owners, [{ path: "src/shape.ts", content: source }]);
    expect(recorded.map(({ configKey }) => configKey)).toEqual(owners.map(({ configKey }) => configKey));
    expect(recorded.find(({ configKey }) => configKey === "switchTotalityBaseline")?.keys).toEqual(["src/shape.ts::s.kind"]);
  });
});

describe("configWithBaselines", () => {
  it("keeps every other field, replaces a recorded key where it stood, appends a new one", () => {
    const next = configWithBaselines(
      { switchTotalityBaseline: ["old::x"], pureModules: ["src/domain/"], maxFunctionLines: 40 },
      [
        { configKey: "switchTotalityBaseline", keys: ["new::y"] },
        { configKey: "discriminantBranchingBaseline", keys: ["new::z"] },
      ],
    );
    expect(next).toEqual({
      switchTotalityBaseline: ["new::y"], pureModules: ["src/domain/"], maxFunctionLines: 40, discriminantBranchingBaseline: ["new::z"],
    });
    expect(Object.keys(next)).toEqual(["switchTotalityBaseline", "pureModules", "maxFunctionLines", "discriminantBranchingBaseline"]);
  });

  it("removes a key whose recorded list is empty, and never writes an empty one", () => {
    expect(configWithBaselines(
      { switchTotalityBaseline: ["old::x"], boundaries: [] },
      [{ configKey: "switchTotalityBaseline", keys: [] }, { configKey: "discriminantBranchingBaseline", keys: [] }],
    )).toEqual({ boundaries: [] });
  });

  it("leaves the existing config untouched (a pure function of its inputs)", () => {
    const existing = Object.freeze({ switchTotalityBaseline: Object.freeze(["old::x"]) });
    configWithBaselines(existing, [{ configKey: "switchTotalityBaseline", keys: [] }]);
    expect(existing).toEqual({ switchTotalityBaseline: ["old::x"] });
  });

  const configKey = fc.constantFrom<RecordedBaseline["configKey"]>("switchTotalityBaseline", "discriminantBranchingBaseline");
  const recordedArb = fc.uniqueArray(
    fc.record({ configKey, keys: fc.array(fc.string({ minLength: 1 }), { maxLength: 4 }) }),
    { selector: ({ configKey: key }) => key, maxLength: 2 },
  );
  const otherFields = fc.dictionary(
    fc.string({ minLength: 1 }).filter((key) => !["switchTotalityBaseline", "discriminantBranchingBaseline", "__proto__"].includes(key)),
    fc.jsonValue(),
  );

  it("is idempotent: writing the same lists twice changes nothing (write-then-rerun)", () => {
    fc.assert(fc.property(otherFields, recordedArb, (existing, recorded) => {
      const once = configWithBaselines(existing, recorded);
      expect(configWithBaselines(once, recorded)).toEqual(once);
    }));
  });

  it("every recorded key ends up holding exactly its list, or absent when empty; other fields survive", () => {
    fc.assert(fc.property(otherFields, recordedArb, (existing, recorded) => {
      const next = configWithBaselines(existing, recorded);
      for (const { configKey: key, keys } of recorded) {
        if (keys.length === 0) expect(Object.hasOwn(next, key)).toBe(false);
        else expect(next[key]).toEqual(keys);
      }
      for (const [key, value] of Object.entries(existing)) expect(next[key]).toEqual(value);
    }));
  });
});
