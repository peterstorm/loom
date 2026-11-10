/**
 * `suggest-spec-anchors`' spec discovery: a spec directory that vanishes
 * between the listing and its stat (ENOENT) is "no latest spec", while every
 * other failure (permissions, I/O) escapes instead of reading as silence.
 * Real directories under a temp root; the stat seam stages the race.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import handler, { findLatestSpec } from "../../../src/handlers/helpers/suggest-spec-anchors";

let root: string;
beforeEach(() => { root = canonicalTempDir("loom-spec-anchors-"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const specDir = (name: string, mtimeSeconds: number, withSpec = true): string => {
  const dir = join(root, "specs", name);
  mkdirSync(dir, { recursive: true });
  if (withSpec) writeFileSync(join(dir, "spec.md"), "- FR-001: export the audit report\n");
  utimesSync(dir, mtimeSeconds, mtimeSeconds);
  return dir;
};

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: staged`), { code });

describe("findLatestSpec", () => {
  it("returns the newest directory that holds a spec.md", () => {
    specDir("older", 1_000);
    specDir("newest-without-spec", 3_000, false);
    specDir("newer", 2_000);
    expect(findLatestSpec(join(root, "specs"))).toBe(join(root, "specs", "newer", "spec.md"));
  });

  it("is null when the specs directory does not exist", () => {
    expect(findLatestSpec(join(root, "absent"))).toBeNull();
  });

  it("reads a directory removed between listing and stat (ENOENT) as no latest spec", () => {
    specDir("vanishing", 1_000);
    expect(findLatestSpec(join(root, "specs"), () => { throw errnoError("ENOENT"); })).toBeNull();
  });

  it.each(["EACCES", "EIO"])("throws a %s failure rather than reading it as no spec", (code) => {
    specDir("unreadable", 1_000);
    expect(() => findLatestSpec(join(root, "specs"), () => { throw errnoError(code); })).toThrow(`${code}: staged`);
  });
});

describe("suggest-spec-anchors handler", () => {
  it("scores the named spec's anchors against the task description", async () => {
    const spec = join(specDir("feature", 1_000), "spec.md");
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await handler("", ["export audit report", spec])).toEqual({ kind: "passthrough" });
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(written.join(""))).toEqual([{ anchor: "FR-001", score: 1, text: "export the audit report" }]);
  });
});
