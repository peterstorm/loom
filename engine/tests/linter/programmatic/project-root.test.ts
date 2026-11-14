/**
 * `findProjectRoot`: which project a directory sits in. The edit hooks ask it
 * from the edited file's directory and `lint-project` from the working
 * directory, so the answer must not depend on where the asking process runs.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import { CLAUDE_PROJECT_RULES_DIR, PI_PROJECT_RULES_DIR, findProjectRoot } from "../../../src/linter/programmatic/config";

/** A presence probe over a fixed set of absolute paths. */
const presentAmong = (paths: readonly string[]) => (path: string): boolean => paths.includes(path);

describe("findProjectRoot: examples", () => {
  it("finds the project from a subdirectory with its own package, such as engine/", () => {
    const present = presentAmong(["/repo/.claude/linter/rules", "/repo/.git", "/repo/engine/package.json"]);
    expect(findProjectRoot("/repo/engine/src/handlers", present)).toBe("/repo");
  });

  it("reads a worktree nested under its main checkout as its own project", () => {
    const present = presentAmong([
      "/repo/.claude/linter/rules",
      "/repo/.git",
      "/repo/.claude/worktrees/fix/.claude/linter/rules",
      "/repo/.claude/worktrees/fix/.git",
    ]);
    expect(findProjectRoot("/repo/.claude/worktrees/fix/engine/src", present)).toBe("/repo/.claude/worktrees/fix");
  });

  it("finds a Pi-only project by its layout", () => {
    expect(findProjectRoot("/shop/src", presentAmong(["/shop/.pi/linter/rules"]))).toBe("/shop");
  });

  it("falls back to the repository root when no directory holds a rules layout", () => {
    expect(findProjectRoot("/repo/src/deep", presentAmong(["/repo/.git"]))).toBe("/repo");
  });

  it("prefers a rules layout above to a nearer repository without one", () => {
    const present = presentAmong(["/work/.claude/linter/rules", "/work/vendored/.git"]);
    expect(findProjectRoot("/work/vendored/src", present)).toBe("/work");
  });

  it("is null for a directory in no project", () => {
    expect(findProjectRoot("/tmp/scratch", presentAmong([]))).toBeNull();
  });
});

describe("findProjectRoot: invariants", () => {
  const MARKERS = ["none", CLAUDE_PROJECT_RULES_DIR, PI_PROJECT_RULES_DIR, ".git"] as const;
  type Marker = (typeof MARKERS)[number];

  /** A start directory `segments` deep, and the marker each directory on its
   *  chain holds, from the filesystem root (index 0) down to the start. */
  const chainArb = fc
    .array(fc.constantFrom("a", "b", "src", "engine"), { maxLength: 6 })
    .chain((segments) => fc.tuple(
      fc.constant(segments),
      fc.array(fc.constantFrom<Marker>(...MARKERS), { minLength: segments.length + 1, maxLength: segments.length + 1 }),
    ));

  const directoryAt = (segments: readonly string[], depth: number): string => `/${segments.slice(0, depth).join("/")}`;

  const scene = (segments: readonly string[], markers: readonly Marker[]) => {
    const directories = markers.map((_, depth) => directoryAt(segments, depth));
    const present = markers.flatMap((marker, depth) => marker === "none" ? [] : [join(directories[depth] ?? "/", marker)]);
    const holdsLayout = (dir: string): boolean =>
      present.includes(join(dir, CLAUDE_PROJECT_RULES_DIR)) || present.includes(join(dir, PI_PROJECT_RULES_DIR));
    return { start: directoryAt(segments, segments.length), directories, present, holdsLayout };
  };

  it("is null exactly when no directory on the chain holds a rules layout or .git", () => {
    fc.assert(fc.property(chainArb, ([segments, markers]) => {
      const { start, present } = scene(segments, markers);
      expect(findProjectRoot(start, presentAmong(present)) === null).toBe(present.length === 0);
    }));
  });

  it("answers the start directory or one above it, never a sibling or a descendant", () => {
    fc.assert(fc.property(chainArb, ([segments, markers]) => {
      const { start, present } = scene(segments, markers);
      const root = findProjectRoot(start, presentAmong(present));
      if (root === null) return;
      expect(root === "/" || start === root || start.startsWith(`${root}/`)).toBe(true);
    }));
  });

  it("answers a rules-holding directory whenever one exists, and none nearer the start holds a layout", () => {
    fc.assert(fc.property(chainArb, ([segments, markers]) => {
      const { start, directories, present, holdsLayout } = scene(segments, markers);
      if (!directories.some(holdsLayout)) return;
      const root = findProjectRoot(start, presentAmong(present));
      expect(root).not.toBeNull();
      expect(holdsLayout(root ?? "")).toBe(true);
      const nearer = directories.filter((dir) => dir.length > (root ?? "").length);
      expect(nearer.some(holdsLayout)).toBe(false);
    }));
  });
});
