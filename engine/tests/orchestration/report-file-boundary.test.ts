import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  closeAnchoredDirectory,
  openDirectoryNoFollow,
  readRunBytesNoFollow,
  removeDirectoryRegularFileNoFollow,
  removeRunRegularFileNoFollow,
} from "../../src/orchestration/no-follow-fs";

const roots: string[] = [];
const fixture = () => {
  const root = canonicalTempDir("loom-report-boundary-");
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("descriptor-anchored report reset and bounded read", () => {
  it("cannot redirect unlink when the retained parent is renamed and replaced by a foreign symlink", () => {
    const root = fixture();
    const parent = join(root, "reports");
    const foreign = join(root, "foreign");
    mkdirSync(parent);
    mkdirSync(foreign);
    writeFileSync(join(parent, "report.xml"), "stale");
    writeFileSync(join(foreign, "report.xml"), "foreign sentinel");
    const anchor = openDirectoryNoFollow(parent);
    try {
      renameSync(parent, join(root, "moved"));
      symlinkSync(foreign, parent);
      if (process.platform === "darwin") {
        // Darwin has no descriptor-relative unlink: the re-proof refuses the
        // planted symlink with ELOOP instead of unlinking through it, and BOTH
        // reports survive — the redirect is impossible in either direction.
        expect(() => removeDirectoryRegularFileNoFollow(anchor, "report.xml"))
          .toThrow(/report reset requires descriptor-anchored unlink.*re-proof failed.*ELOOP|too many symbolic/i);
        expect(existsSync(join(root, "moved", "report.xml"))).toBe(true);
        expect(readFileSync(join(foreign, "report.xml"), "utf8")).toBe("foreign sentinel");
        return;
      }
      removeDirectoryRegularFileNoFollow(anchor, "report.xml");
      expect(existsSync(join(root, "moved", "report.xml"))).toBe(false);
      expect(readFileSync(join(foreign, "report.xml"), "utf8")).toBe("foreign sentinel");
    } finally { closeAnchoredDirectory(anchor); }
  });

  it("preserves directories and foreign symlink targets; only ENOENT is absence", () => {
    const root = fixture();
    mkdirSync(join(root, "directory"));
    writeFileSync(join(root, "foreign"), "sentinel");
    symlinkSync("foreign", join(root, "link"));
    expect(() => removeRunRegularFileNoFollow(join(root, "directory"))).toThrow(/regular file/);
    expect(() => removeRunRegularFileNoFollow(join(root, "link"))).toThrow(/regular file/);
    expect(readFileSync(join(root, "foreign"), "utf8")).toBe("sentinel");
    expect(() => removeRunRegularFileNoFollow(join(root, "missing-parent", "absent"))).not.toThrow();
    expect(() => removeRunRegularFileNoFollow(join(root, "foreign", "not-directory"))).toThrow();
  });

  it("propagates real permission failure without removing the report", () => {
    expect(process.getuid?.()).not.toBe(0);
    const root = fixture();
    const parent = join(root, "readonly");
    mkdirSync(parent);
    writeFileSync(join(parent, "report"), "stale");
    chmodSync(parent, 0o500);
    try {
      expect(() => removeRunRegularFileNoFollow(join(parent, "report"))).toThrow(/EACCES|EPERM/);
      expect(readFileSync(join(parent, "report"), "utf8")).toBe("stale");
    } finally { chmodSync(parent, 0o700); }
  });

  it("accepts limit and refuses limit+1, empty limit, directories, and symlinks", () => {
    const root = fixture();
    const path = join(root, "report");
    writeFileSync(path, "1234");
    expect(readRunBytesNoFollow(path, 4).toString()).toBe("1234");
    expect(() => readRunBytesNoFollow(path, 3)).toThrow(/byte limit/);
    expect(() => readRunBytesNoFollow(root, 4)).toThrow(/regular file/);
    symlinkSync("report", join(root, "link"));
    expect(() => readRunBytesNoFollow(join(root, "link"), 4)).toThrow();
    writeFileSync(path, "");
    expect(readRunBytesNoFollow(path, 0).byteLength).toBe(0);
    writeFileSync(path, "1");
    expect(() => readRunBytesNoFollow(path, 0)).toThrow(/byte limit/);
  });
});
