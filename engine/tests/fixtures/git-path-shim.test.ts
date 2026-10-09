import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { policyBoundGitArgv } from "../../src/utils/git-command-scope";
import { canonicalTempDir } from "./canonical-temp-dir";
import { gitShimScript, shellQuote, withGitShim, type GitShimFault } from "./git-path-shim";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A directory whose path holds both quote characters. */
function quotedDirectory(): string {
  const root = canonicalTempDir("loom-git-shim-");
  roots.push(root);
  const directory = join(root, `it's a "quoted" dir`);
  mkdirSync(directory);
  return directory;
}

/** A stand-in for the real Git: prints each argument it received as `ARG <arg>`. */
function recordingGit(directory: string): string {
  const path = join(directory, "recording git");
  writeFileSync(path, `#!/bin/sh\nfor argument in "$@"; do printf 'ARG %s\\n' "$argument"; done\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Run the shim generated for `fault` over the recording Git, with `argv`. */
function runShim(directory: string, fault: GitShimFault, argv: readonly string[]) {
  const shim = join(directory, "git");
  writeFileSync(shim, gitShimScript(recordingGit(directory), fault));
  chmodSync(shim, 0o755);
  const run = spawnSync(shim, argv, { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, lines: run.stdout.split("\n").filter((line) => line !== "") };
}

const received = (argv: readonly string[]) => argv.map((argument) => `ARG ${argument}`);

describe("the policy-bound git PATH shim", () => {
  it("runs the fault on the logical argv of a matching policy-bound child", () => {
    const directory = quotedDirectory();
    const fault = { command: ["rev-parse", "HEAD"], script: `printf 'FAULT %s\\n' "$@"\nexit 7` };
    const run = runShim(directory, fault, policyBoundGitArgv(["rev-parse", "HEAD", "--verify"]));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(7);
    expect(run.lines).toEqual(["FAULT rev-parse", "FAULT HEAD", "FAULT --verify"]);
  });

  it("falls through to the policy-bound child when the fault does not exit, with paths holding quotes", () => {
    const directory = quotedDirectory();
    const marker = join(directory, `marker 'one'`);
    const fault = { command: ["rev-parse", "HEAD"], script: `: > ${shellQuote(marker)}` };
    const argv = policyBoundGitArgv(["rev-parse", "HEAD"]);
    const run = runShim(directory, fault, argv);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(run.lines).toEqual(received(argv));
  });

  it("gives the fault policy_git (prefix restored) and real_git (arguments as given)", () => {
    const directory = quotedDirectory();
    const fault = { command: ["status"], script: `policy_git "$@"\nreal_git update-ref HEAD 'it'"'"'s'\nexit 0` };
    const run = runShim(directory, fault, policyBoundGitArgv(["status", "--porcelain=v2"]));
    expect(run.status).toBe(0);
    expect(run.lines).toEqual([...received(policyBoundGitArgv(["status", "--porcelain=v2"])), ...received(["update-ref", "HEAD", "it's"])]);
  });

  it("passes a policy-bound child that does not match, and any child outside the policy, through unchanged", () => {
    const directory = quotedDirectory();
    const fault = { command: ["rev-parse", "HEAD"], script: "echo FAULT\nexit 9" };
    for (const argv of [policyBoundGitArgv(["rev-parse", "--show-toplevel"]), policyBoundGitArgv(["rev-parse"]), ["rev-parse", "HEAD"]]) {
      const run = runShim(directory, fault, argv);
      expect(run.status, argv.join(" ")).toBe(0);
      expect(run.lines, argv.join(" ")).toEqual(received(argv));
    }
  });

  it("quotes any string as one shell word", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme" }).filter((value) => !value.includes("\0")), (value) => {
      const echoed = spawnSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
      expect(echoed.stdout).toBe(value);
    }), { numRuns: 60 });
  });

  it("puts the shim first on PATH for the operation only, restoring PATH even on rejection", async () => {
    const directory = quotedDirectory();
    const shimDirectory = join(directory, "shim");
    const before = process.env.PATH;
    const failure = new Error("operation failed");
    await expect(withGitShim(shimDirectory, { command: ["status"], script: "exit 0" }, () => {
      expect(process.env.PATH).toBe(`${shimDirectory}:${before ?? ""}`);
      expect(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()).toBe(join(shimDirectory, "git"));
      throw failure;
    })).rejects.toBe(failure);
    expect(process.env.PATH).toBe(before);
  });
});
