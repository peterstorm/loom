/**
 * `extractShellWriteTargets`: the destinations of a literal `mv`, `git mv` or
 * `cp` mint shell FileWrites (FR-034, AS-041), beside the redirect and `tee`
 * targets they always minted. A renamed or copied file therefore appears
 * among a Task's changed files under its NEW path, on both harnesses, because
 * both reach this one rule through `extractEvidence`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractEvidence } from "../../src/machine/extract-evidence";
import { extractShellWriteTargets } from "../../src/machine/shell-write-targets";
import type { HarnessToolCall } from "../../src/machine/harness-tool-call-types";

const bash = (command: string): HarnessToolCall => ({
  tool: "Bash",
  input: { command },
  outcome: { kind: "exited", exit: 0, stdout: "" },
  callId: null,
  cwd: "/repo",
});

describe("extractShellWriteTargets — literal mv, git mv and cp destinations (FR-034)", () => {
  it("AS-041: a literal mv, git mv or cp names its destination as a shell write target", () => {
    expect(extractShellWriteTargets("mv a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("git mv a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("cp a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("mv assets/a.txt assets/moved.txt")).toEqual(["assets/moved.txt"]);
    expect(extractShellWriteTargets("git mv src/legacy.ts src/renamed.ts")).toEqual(["src/renamed.ts"]);
    expect(extractShellWriteTargets("cp README.md README.copy.md")).toEqual(["README.copy.md"]);
  });

  it("AS-041: a renamed file mints a via-shell FileWrite under its new path through extractEvidence", () => {
    for (const command of ["mv a.ts b.ts", "git mv a.ts b.ts", "cp a.ts b.ts"]) {
      expect(extractEvidence(bash(command), () => null)).toEqual([
        { kind: "FileWrite", path: "b.ts", via: "shell" },
      ]);
    }
  });

  it("skips option words, and `--` ends them so a dash-led destination still counts", () => {
    expect(extractShellWriteTargets("mv -f a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("cp -r -p src dst")).toEqual(["dst"]);
    expect(extractShellWriteTargets("git mv -f -k a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("cp --preserve=mode a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("mv -- -a -b")).toEqual(["-b"]);
  });

  it("an option that takes a separate value never reads that value as a path", () => {
    expect(extractShellWriteTargets("mv -S .bak a b")).toEqual(["b"]);
    expect(extractShellWriteTargets("cp --suffix .orig a b")).toEqual(["b"]);
  });

  it("several sources land inside the destination directory, one target per source", () => {
    expect(extractShellWriteTargets("cp a.txt dir/b.txt out")).toEqual(["out/a.txt", "out/b.txt"]);
    expect(extractShellWriteTargets("mv one two dest/")).toEqual(["dest/one", "dest/two"]);
  });

  it("a trailing-slash destination is a directory: the source keeps its basename inside it", () => {
    expect(extractShellWriteTargets("mv src/a.ts lib/")).toEqual(["lib/a.ts"]);
  });

  it("-t / --target-directory name the directory every source lands in", () => {
    expect(extractShellWriteTargets("mv -t dest a b")).toEqual(["dest/a", "dest/b"]);
    expect(extractShellWriteTargets("cp --target-directory=out x/y.txt")).toEqual(["out/y.txt"]);
    expect(extractShellWriteTargets("cp --target-directory out y.txt")).toEqual(["out/y.txt"]);
    expect(extractShellWriteTargets("cp -rt out y.txt")).toEqual(["out/y.txt"]);
  });

  it("is quote-aware and env-prefix tolerant, like the tee scan", () => {
    expect(extractShellWriteTargets(`mv "a file" "b file"`)).toEqual(["b file"]);
    expect(extractShellWriteTargets("LC_ALL=C cp a 'b c'")).toEqual(["b c"]);
    expect(extractShellWriteTargets("/bin/mv a b")).toEqual(["b"]);
  });

  it("reads every segment of a compound line, and composes with redirect targets", () => {
    expect(extractShellWriteTargets("mkdir -p out && cp a out/a; mv b c > log")).toEqual(["out/a", "log", "c"]);
  });

  it("mints nothing for a command that only mentions mv or cp, or names no destination", () => {
    expect(extractShellWriteTargets("echo mv a b")).toEqual([]);
    expect(extractShellWriteTargets("git log mv a b")).toEqual([]);
    expect(extractShellWriteTargets("git status")).toEqual([]);
    expect(extractShellWriteTargets("mv")).toEqual([]);
    expect(extractShellWriteTargets("cp onlysource")).toEqual([]);
    expect(extractShellWriteTargets("mvn test")).toEqual([]);
    expect(extractShellWriteTargets("cpp main.c")).toEqual([]);
  });

  it("every literal `mv <src> <dst>` with plain word paths mints exactly its destination (property)", () => {
    const word = fc.stringMatching(/^[a-z][a-z0-9_.]{0,8}(\/[a-z0-9_.]{1,8}){0,2}$/);
    const head = fc.constantFrom("mv", "git mv", "cp", "cp -r", "mv -f");
    fc.assert(
      fc.property(head, word, word, (h, src, dst) => {
        expect(extractShellWriteTargets(`${h} ${src} ${dst}`)).toEqual([dst]);
      }),
    );
  });
});
