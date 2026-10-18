/**
 * Unit and property tests for `changedFilesAtStop`, the one derivation of a
 * Task's changed files at stop (INV-7, FR-019, FR-034): the epoch's FileWrite
 * paths, deduplicated in first-write order, kept only inside the repository
 * and only when the injected existence predicate says they exist, parsed into
 * `ChangedFiles`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ChangedFilePath } from "../../src/core/affected-stop-check-types";
import { changedFilesAtStop } from "../../src/core/changed-files";
import { extractShellWriteTargets } from "../../src/core/shell-write-targets";
import type { Evidence } from "../../src/machine/types";

const ROOT = "/work/repo";

const write = (path: string, via: "tool" | "shell" = "tool"): Evidence => ({ kind: "FileWrite", path, via });
const everything = (): boolean => true;
const only = (...present: string[]) => (path: ChangedFilePath): boolean => present.includes(path);

describe("changedFilesAtStop", () => {
  it("is none for an epoch without FileWrite facts", () => {
    const events: Evidence[] = [
      { kind: "FileRead", path: `${ROOT}/src/a.ts` },
      { kind: "TestRun", command: "npx vitest run", exit: 0, report: null },
    ];

    expect(changedFilesAtStop(events, ROOT, everything)).toEqual({ kind: "none" });
    expect(changedFilesAtStop([], ROOT, everything)).toEqual({ kind: "none" });
  });

  it("keeps repository-relative paths, deduplicated in first-write order across tool and shell writes", () => {
    const events = [
      write(`${ROOT}/src/b.ts`),
      write(`${ROOT}/src/a.ts`, "shell"),
      write("src/b.ts", "shell"),
      write(`${ROOT}/./src/a.ts`),
      write(`${ROOT}/src/c.ts`),
    ];

    expect(changedFilesAtStop(events, ROOT, everything)).toEqual({ kind: "some", files: ["src/b.ts", "src/a.ts", "src/c.ts"] });
  });

  it("resolves a relative path against the repository root", () => {
    expect(changedFilesAtStop([write("./engine/src/x.ts", "shell")], ROOT, everything))
      .toEqual({ kind: "some", files: ["engine/src/x.ts"] });
  });

  it("drops writes outside the repository: another absolute tree, a sibling with a shared prefix, a relative escape, and the root itself", () => {
    const events = [
      write("/tmp/loom-T8-vitest.json", "shell"),
      write("/work/repo-other/src/a.ts"),
      write("../elsewhere/a.ts", "shell"),
      write(ROOT),
      write(`${ROOT}/src/kept.ts`),
    ];

    expect(changedFilesAtStop(events, ROOT, everything)).toEqual({ kind: "some", files: ["src/kept.ts"] });
    expect(changedFilesAtStop(events.slice(0, 4), ROOT, everything)).toEqual({ kind: "none" });
  });

  it("drops writes that are not valid paths at all", () => {
    expect(changedFilesAtStop([write(""), write(" src/a.ts"), write("src/a\nb.ts")], ROOT, everything)).toEqual({ kind: "none" });
  });

  it("drops a path absent at stop time, asking the predicate with the repository-relative path", () => {
    const asked: string[] = [];
    const exists = (path: ChangedFilePath): boolean => {
      asked.push(path);
      return path !== "src/deleted.ts";
    };

    const changed = changedFilesAtStop([write(`${ROOT}/src/deleted.ts`), write(`${ROOT}/src/kept.ts`)], ROOT, exists);

    expect(changed).toEqual({ kind: "some", files: ["src/kept.ts"] });
    expect(asked).toEqual(["src/deleted.ts", "src/kept.ts"]);
  });

  it("is none when every changed file was deleted", () => {
    expect(changedFilesAtStop([write(`${ROOT}/src/gone.ts`)], ROOT, () => false)).toEqual({ kind: "none" });
  });

  it("FR-034: a renamed file appears under its new path, from the mv destination FileWrite", () => {
    const [destination, ...rest] = extractShellWriteTargets("mv src/old.ts src/new.ts");
    expect(rest).toEqual([]);
    const events = [write(`${ROOT}/src/old.ts`), write(destination!, "shell")];

    expect(changedFilesAtStop(events, ROOT, only("src/new.ts"))).toEqual({ kind: "some", files: ["src/new.ts"] });
  });

  it("is deterministic and never returns a path twice, out of first-write order, outside the repository or absent", () => {
    const segment = fc.constantFrom("src", "engine", "a.ts", "b.ts", "c.test.ts", "..", ".");
    const relativePath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));
    const rawPath = fc.oneof(
      relativePath,
      relativePath.map((path) => `${ROOT}/${path}`),
      relativePath.map((path) => `/elsewhere/${path}`),
    );
    const event = fc.oneof(
      rawPath.map((path) => write(path)),
      rawPath.map((path) => write(path, "shell")),
      rawPath.map((path): Evidence => ({ kind: "FileRead", path })),
    );

    fc.assert(fc.property(fc.array(event, { maxLength: 12 }), fc.func(fc.boolean()), (events, present) => {
      const exists = (path: ChangedFilePath): boolean => present(path);
      const changed = changedFilesAtStop(events, ROOT, exists);
      expect(changedFilesAtStop(events, ROOT, exists)).toEqual(changed);
      const files: readonly string[] = changed.kind === "none" ? [] : changed.files;
      expect(new Set(files).size).toBe(files.length);
      for (const file of files) {
        expect(file.startsWith("/") || file.split("/").some((part) => part === ".." || part === "." || part === "")).toBe(false);
        expect(exists(file as ChangedFilePath)).toBe(true);
      }
      // First-write order: each file's first FileWrite precedes the next file's.
      const derived = (e: Evidence): string | null => {
        const one = changedFilesAtStop([e], ROOT, () => true);
        return one.kind === "some" ? one.files[0] : null;
      };
      const firstWrite = (file: string): number => events.findIndex((e) => derived(e) === file);
      const order = files.map(firstWrite);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }));
  });
});
