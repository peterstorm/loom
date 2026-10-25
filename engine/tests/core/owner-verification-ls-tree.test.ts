/**
 * `ownerAtBaseEntry`: what `git ls-tree -z <base> -- <owner>` says about the
 * owner at the Wave base, as a pure function of the command's text (FR-009).
 */

import { describe, expect, it } from "vitest";
import { ownerAtBaseEntry } from "../../src/core/owner-verification/ls-tree";

const SHA1 = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
const SHA256 = "a".repeat(64);

describe("ownerAtBaseEntry", () => {
  it("no output: the owner did not exist at the base", () => {
    expect(ownerAtBaseEntry("")).toEqual({ kind: "absent" });
  });

  it.each([
    ["a regular file", `100644 blob ${SHA1}\tsrc/rules/owner.ts\u0000`, SHA1],
    ["an executable file", `100755 blob ${SHA1}\tsrc/rules/owner.ts\u0000`, SHA1],
    ["a SHA-256 repository's blob", `100644 blob ${SHA256}\tsrc/rules/owner.ts\u0000`, SHA256],
    ["an entry whose NUL terminator was trimmed", `100644 blob ${SHA1}\tsrc/rules/owner.ts`, SHA1],
    ["a path with spaces", `100644 blob ${SHA1}\tsrc/rules/my owner.ts\u0000`, SHA1],
  ])("%s is the file whose blob is diffed", (_case, listing, blob) => {
    expect(ownerAtBaseEntry(listing)).toEqual({ kind: "file", blob });
  });

  it.each([
    ["a symlink blob, whose bytes are a link target", `120000 blob ${SHA1}\tsrc/rules/owner.ts\u0000`],
    ["a directory", `040000 tree ${SHA1}\tsrc/rules/owner.ts\u0000`],
    ["a gitlink (submodule)", `160000 commit ${SHA1}\tsrc/rules/owner.ts\u0000`],
    ["more than one entry", `100644 blob ${SHA1}\ta.ts\u0000100644 blob ${SHA1}\tb.ts\u0000`],
    ["an abbreviated object id", `100644 blob 3b18e51\tsrc/rules/owner.ts\u0000`],
    ["unparseable text", "fatal: not a tree object"],
  ])("%s is not a file at the base", (_case, listing) => {
    expect(ownerAtBaseEntry(listing)).toEqual({ kind: "not-a-file" });
  });
});
