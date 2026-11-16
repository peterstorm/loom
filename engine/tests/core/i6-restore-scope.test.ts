/**
 * The I6 repair restores only implementation files no other Task lists: a
 * shared file holds another Task's work, so restoring it to the start commit
 * would discard that work.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { restoreScope } from "../../src/core/i6-restore-scope";
import { baselineRestoreCommand, redThenGreenRemedy } from "../../src/core/implementation-brief";
import type { Task } from "../../src/types";

const ROOT = "/repo";
const START = "a".repeat(40);
const task = (id: string, file_list: readonly string[]): Task => ({ id, file_list, start_sha: START }) as unknown as Task;

describe("restoreScope", () => {
  it("keeps a file only this Task lists restorable and names the co-owners of a shared one", () => {
    const roster = [task("T12", ["a.ts", "b.ts", "c.ts"]), task("T1", ["b.ts"]), task("T6", ["b.ts", "c.ts"]), task("T1", ["c.ts"])];
    expect(restoreScope("T12", ["a.ts", "b.ts", "c.ts"], roster)).toEqual({
      restorable: ["a.ts"],
      shared: [{ path: "b.ts", coOwners: ["T1", "T6"] }, { path: "c.ts", coOwners: ["T6", "T1"] }],
    });
  });

  it("partitions every implementation file exactly once, and never marks a co-owned file restorable", () => {
    const path = fc.constantFrom<string>("a.ts", "b.ts", "c.ts", "d.ts");
    const files = fc.uniqueArray(path, { maxLength: 4 });
    const others = fc.array(fc.tuple(fc.constantFrom("T1", "T2", "T3"), fc.uniqueArray(path, { maxLength: 4 })), { maxLength: 4 });
    fc.assert(fc.property(files, others, (mine, rest) => {
      const roster = [task("T9", mine), ...rest.map(([id, list]) => task(id, list))];
      const scope = restoreScope("T9", mine, roster);
      expect([...scope.restorable, ...scope.shared.map(({ path: p }) => p)].sort()).toEqual([...mine].sort());
      for (const p of scope.restorable) expect(rest.some(([, list]) => list.includes(p))).toBe(false);
      for (const { path: p, coOwners } of scope.shared) {
        expect(coOwners.length).toBeGreaterThan(0);
        expect(coOwners).not.toContain("T9");
        for (const id of coOwners) expect(rest.some(([other, list]) => other === id && list.includes(p))).toBe(true);
      }
    }));
  });
});

describe("the I6 repair of a retry", () => {
  const classification = (implementationFiles: readonly string[]) =>
    ({ testFiles: ["a.test.ts"], implementationFiles, createdImplementationFiles: [] });
  const remedy = (roster: readonly Task[], files: readonly string[]): string =>
    redThenGreenRemedy(roster[0] as Task, classification(files), ["proof:red-then-green-unproven:implementation-write-missing"], ROOT, roster).join("\n");

  it("restores only the unshared files and tells the agent to leave a shared one alone", () => {
    const roster = [task("T12", ["a.test.ts", "a.ts", "package.json"]), task("T1", ["package.json"])];
    const text = remedy(roster, ["a.ts", "package.json"]);
    expect(text).toContain(baselineRestoreCommand(START, ["a.ts"], ROOT));
    expect(text).not.toContain(baselineRestoreCommand(START, ["a.ts", "package.json"], ROOT));
    expect(text).toContain("`package.json` (also T1)");
    expect(text).toContain("never restore, delete or rewrite one wholesale");
    expect(text).toContain("Before your first write to a shared file, add a test that fails against its current bytes");
  });

  it("carries no restore command when every implementation file is shared", () => {
    const roster = [task("T12", ["a.test.ts", "a.ts"]), task("T1", ["a.ts"]), task("T7", ["a.ts"])];
    const text = remedy(roster, ["a.ts"]);
    expect(text).not.toContain("git restore");
    expect(text).toContain("1. Every implementation file you declare is also another Task's, so there is nothing to restore; skip to step 2.");
    expect(text).toContain("`a.ts` (also T1, T7)");
  });

  it("does not count the Wave's Distill Task as a co-owner: its pass runs after the retry settles", () => {
    const distill = { ...task("T13", ["a.ts"]), agent: "distill-agent" } as Task;
    const text = remedy([task("T12", ["a.test.ts", "a.ts"]), distill], ["a.ts"]);
    expect(text).toContain(baselineRestoreCommand(START, ["a.ts"], ROOT));
    expect(text).not.toContain("Shared implementation files");
  });

  it("keeps the single-owner repair as it was", () => {
    const roster = [task("T12", ["a.test.ts", "a.ts"])];
    const text = remedy(roster, ["a.ts"]);
    expect(text).toContain(baselineRestoreCommand(START, ["a.ts"], ROOT));
    expect(text).toContain("Touch only these files: they are yours, and no sibling's work lives in them.");
    expect(text).not.toContain("also T");
  });
});
