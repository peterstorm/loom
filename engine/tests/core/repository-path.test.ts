import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRepositoryPath, parseRepositoryPathSet } from "../../src/core/repository-path";
import { inspectRepositoryPath } from "../../src/utils/repository-path";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-repository-path-"));
  cleanup.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  return root;
}

describe("parseRepositoryPath", () => {
  it("gives relative, absolute, and normalized aliases one canonical identity", () => {
    const root = repository();
    for (const raw of ["src/a.ts", "./src/a.ts", "src/x/../a.ts", join(root, "src", "a.ts")]) {
      const parsed = parseRepositoryPath(root, raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.relative).toBe("src/a.ts");
    }
  });

  it("rejects the repository root, traversal escapes, external absolute paths, and foreign separators", () => {
    const root = repository();
    for (const raw of [".", "../outside.ts", join(tmpdir(), "outside.ts"), "src\\a.ts", "C:\\repo\\a.ts"]) {
      const parsed = parseRepositoryPath(root, raw);
      expect(parsed.ok, raw).toBe(false);
    }
  });

  it("deduplicates after canonicalization rather than before it", () => {
    const root = repository();
    const parsed = parseRepositoryPathSet(root, ["src/a.ts", join(root, "src", "a.ts"), "./src/a.ts"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.map(({ relative }) => relative)).toEqual(["src/a.ts"]);
  });
});

describe("inspectRepositoryPath", () => {
  it("accepts regular files and missing deleted-file paths inside real directories", () => {
    const root = repository();
    expect(inspectRepositoryPath(root, join(root, "src", "a.ts"), "artifact", { mustBeFile: true }))
      .toMatchObject({ relative: "src/a.ts", exists: true });
    expect(inspectRepositoryPath(root, "src/deleted.ts", "artifact", { mustBeFile: true }))
      .toMatchObject({ relative: "src/deleted.ts", exists: false });
  });

  it("rejects both leaf symlinks and symlinked parent directories", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "loom-repository-path-outside-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "secret.ts"), "secret\n");
    symlinkSync(join(outside, "secret.ts"), join(root, "leaf.ts"));
    symlinkSync(outside, join(root, "linked"));
    symlinkSync(join(outside, "missing.ts"), join(root, "dangling.ts"));

    expect(() => inspectRepositoryPath(root, "leaf.ts", "artifact", { mustBeFile: true }))
      .toThrow("must not traverse a symlink");
    expect(() => inspectRepositoryPath(root, "linked/secret.ts", "artifact", { mustBeFile: true }))
      .toThrow("must not traverse a symlink");
    expect(() => inspectRepositoryPath(root, "dangling.ts", "artifact"))
      .toThrow("must not traverse a symlink");
  });
});
