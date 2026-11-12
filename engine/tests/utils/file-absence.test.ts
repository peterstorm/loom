/**
 * The one absence rule the mutation checks read files by: only ENOENT,
 * ENOTDIR and EISDIR read as "not there"; every other refusal stays a
 * refusal, so an unreadable file never passes for a deleted one.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { ABSENCE_CODES, isAbsence, readFileOrAbsence } from "../../src/utils/file-absence";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = canonicalTempDir("loom-file-absence-");
  temporary.push(directory);
  return directory;
}

const errno = (code: unknown): Error => Object.assign(new Error(String(code)), { code });

describe("isAbsence", () => {
  it.each(["ENOENT", "ENOTDIR", "EISDIR"])("reads %s as absence", (code) => {
    expect(isAbsence(errno(code))).toBe(true);
  });

  it.each(["EACCES", "ELOOP", "EIO", "EMFILE", "ENAMETOOLONG"])("reads %s as a refusal, never absence", (code) => {
    expect(isAbsence(errno(code))).toBe(false);
  });

  it("reads a throw that carries no errno code as a refusal", () => {
    expect(isAbsence(new Error("boom"))).toBe(false);
    expect(isAbsence("ENOENT")).toBe(false);
    expect(isAbsence(null)).toBe(false);
    expect(isAbsence({ code: 2 })).toBe(false);
  });

  it("property: a code is absence exactly when it is one of the three absence codes", () => {
    fc.assert(fc.property(fc.oneof(fc.constantFrom(...ABSENCE_CODES, "EACCES", "EIO"), fc.string()), (code) => {
      expect(isAbsence(errno(code))).toBe(ABSENCE_CODES.has(code));
    }));
  });
});

describe("readFileOrAbsence", () => {
  it("reads a file's bytes", () => {
    const path = join(tempDir(), "a.txt");
    writeFileSync(path, "abc");
    expect(readFileOrAbsence(path)).toEqual({ kind: "bytes", bytes: new TextEncoder().encode("abc") });
  });

  it("reads a missing file, a path through a file, and a directory as absent", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "file"), "");
    mkdirSync(join(directory, "folder"));
    expect(readFileOrAbsence(join(directory, "missing"))).toEqual({ kind: "absent" });
    expect(readFileOrAbsence(join(directory, "file", "below"))).toEqual({ kind: "absent" });
    expect(readFileOrAbsence(join(directory, "folder"))).toEqual({ kind: "absent" });
  });

  it.skipIf(process.getuid?.() === 0)("reads a file it may not open as refused, never absent", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "secret"), "x");
    chmodSync(directory, 0o000);
    const read = readFileOrAbsence(join(directory, "secret"));
    expect(read.kind).toBe("refused");
  });
});
