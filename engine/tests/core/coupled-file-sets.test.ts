/**
 * Coupled file sets (ADR-0082): a package manifest and its lockfile belong to
 * one Task.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { coupledSetGaps, coupledSetKey, describeCoupledSetGap, PACKAGE_LOCKFILES } from "../../src/core/coupled-file-sets";

describe("coupledSetKey", () => {
  it.each([
    ["package.json", "package:"],
    ["bun.lock", "package:"],
    ["packages/contract/package.json", "package:packages/contract/"],
    ["packages/contract/pnpm-lock.yaml", "package:packages/contract/"],
  ])("couples %s under %s", (path, key) => {
    expect(coupledSetKey(path)).toBe(key);
  });

  it.each(["src/package.ts", "package.json.bak", "lib/__tests__/sources.test.ts", "bun.lock.txt"])("leaves %s uncoupled", (path) => {
    expect(coupledSetKey(path)).toBeNull();
  });

  it("couples every known lockfile with the manifest beside it, and not with one in another directory", () => {
    for (const lockfile of PACKAGE_LOCKFILES) expect(coupledSetKey(`a/${lockfile}`)).toBe(coupledSetKey("a/package.json"));
    expect(coupledSetKey("a/bun.lock")).not.toBe(coupledSetKey("b/package.json"));
  });
});

describe("coupledSetGaps", () => {
  const T12 = { id: "T12", file_list: ["package.json", "scripts/bench.ts"] };
  const T28 = { id: "T28", file_list: ["bun.lock", "packages/contract/src/index.ts"] };

  it("reports each Task that lists part of a set another Task lists the rest of", () => {
    expect(coupledSetGaps([T12, T28], T12)).toEqual([{ taskId: "T12", listed: ["package.json"], missing: ["bun.lock"] }]);
    expect(coupledSetGaps([T12, T28], T28)).toEqual([{ taskId: "T28", listed: ["bun.lock"], missing: ["package.json"] }]);
  });

  it("reports nothing for a Task that lists the whole set, or no member of it", () => {
    const whole = { id: "T12", file_list: ["package.json", "bun.lock"] };
    expect(coupledSetGaps([whole, { id: "T6", file_list: ["bun.lock", "package.json"] }], whole)).toEqual([]);
    expect(coupledSetGaps([T12, T28], { id: "T1", file_list: ["src/a.ts"] })).toEqual([]);
  });

  it("names the Task, what it lists and what it must take", () => {
    const [gap] = coupledSetGaps([T12, T28], T12);
    expect(describeCoupledSetGap(gap!)).toContain("T12 lists package.json but not bun.lock");
  });

  it("never reports a gap for a Task that lists every member any Task lists (property)", () => {
    const member: fc.Arbitrary<string> = fc.constantFrom("package.json", "bun.lock", "yarn.lock", "web/package.json", "web/bun.lock", "src/a.ts");
    const fileList = fc.uniqueArray(member, { maxLength: 6 });
    fc.assert(fc.property(fc.array(fileList, { minLength: 1, maxLength: 4 }), (lists) => {
      const tasks = lists.map((file_list, index) => ({ id: `T${index + 1}`, file_list }));
      const everything = [...new Set(lists.flat())];
      const owner = { id: "T0", file_list: everything };
      expect(coupledSetGaps([...tasks, owner], owner)).toEqual([]);
      for (const task of tasks) {
        for (const gap of coupledSetGaps([...tasks, owner], task)) {
          expect(gap.missing.every((path) => !task.file_list.includes(path))).toBe(true);
          expect(gap.listed.every((path) => coupledSetKey(path) === coupledSetKey(gap.missing[0]))).toBe(true);
        }
      }
    }));
  });
});
