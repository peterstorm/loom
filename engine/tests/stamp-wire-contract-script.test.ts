/**
 * The stamping script's shell: what it reads, what it writes, and the exit code
 * CI relies on. `stampsFor` and `applyStamps` are pure and tested beside the
 * core (`core/wire-contract-stamps.test.ts`); this pins the shell around them —
 * the drift tally, `--check` exiting 1 on drift and writing nothing, a normal run
 * restoring the stamped text, and a file that cannot be stamped stopping the run.
 *
 * The script finds the package by its own location, so each drift case runs a
 * copy of it in a scratch tree holding copies of the agent files and the
 * fragments, with the engine linked in. The repository itself is only read.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(__dirname, "../..");
const SCRIPT = "scripts/stamp-wire-contract.ts";
const AGENT = "agents/code-reviewer.md";
const BOOTSTRAP_END = "<!-- reviewer-bootstrap:end -->";

type Run = Readonly<{ status: number | null; stdout: string; stderr: string }>;

const stamp = (root: string, ...args: readonly string[]): Run => {
  const run = spawnSync("bun", [join(root, SCRIPT), ...args], { cwd: root, encoding: "utf-8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

const scratchTrees: string[] = [];

/** A tree the script can run in: copies of everything it reads or writes, the engine linked. */
function scratchTree(): string {
  const root = mkdtempSync(join(tmpdir(), "stamp-wire-contract-"));
  scratchTrees.push(root);
  mkdirSync(join(root, "scripts"));
  cpSync(join(REPO, SCRIPT), join(root, SCRIPT));
  cpSync(join(REPO, "agents"), join(root, "agents"), { recursive: true });
  cpSync(join(REPO, "references"), join(root, "references"), { recursive: true });
  symlinkSync(join(REPO, "engine"), join(root, "engine"));
  return root;
}

/** Rewrite one agent file in the scratch tree. */
function edit(root: string, change: (text: string) => string): string {
  const path = join(root, AGENT);
  const edited = change(readFileSync(path, "utf-8"));
  writeFileSync(path, edited);
  return edited;
}

afterEach(() => {
  for (const root of scratchTrees.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scripts/stamp-wire-contract.ts", () => {
  it("--check passes on the repository and writes nothing", () => {
    const run = stamp(REPO, "--check");
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("stamped regions and read-coverage bullets match their sources\n");
    expect(run.status).toBe(0);
  });

  it("--check exits 1 on a drifted region, naming the agent, and leaves the file as it found it", () => {
    const root = scratchTree();
    const original = readFileSync(join(root, AGENT), "utf-8");
    const drifted = edit(root, (text) => text.replace(BOOTSTRAP_END, `drift\n${BOOTSTRAP_END}`));
    expect(drifted).not.toBe(original);

    const run = stamp(root, "--check");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("code-reviewer: ");
    expect(run.stderr).toContain("reviewer-bootstrap");
    expect(readFileSync(join(root, AGENT), "utf-8")).toBe(drifted);
  });

  it("a normal run restores the stamped text, after which --check passes", () => {
    const root = scratchTree();
    const original = readFileSync(join(root, AGENT), "utf-8");
    edit(root, (text) => text.replace(BOOTSTRAP_END, `drift\n${BOOTSTRAP_END}`));

    const run = stamp(root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("stamped code-reviewer\n");
    expect(run.stdout).toContain("done (1 file(s) updated)\n");
    expect(readFileSync(join(root, AGENT), "utf-8")).toBe(original);
    expect(stamp(root, "--check").status).toBe(0);
  });

  it("stops on an agent file it cannot stamp, naming the agent, with or without --check", () => {
    const root = scratchTree();
    edit(root, (text) => text.replace(BOOTSTRAP_END, ""));

    for (const args of [["--check"], []]) {
      const run = stamp(root, ...args);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/^code-reviewer: .*\(expected .*\)\n$/s);
    }
  });
});
