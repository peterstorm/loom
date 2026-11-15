/**
 * The stamping script's shell: what it reads, what it writes, and the exit code
 * CI relies on. `stampsFor` and `applyStamps` are pure and tested beside the
 * core (`core/wire-contract-stamps.test.ts`); this pins the shell around them —
 * the drift tally, `--check` exiting 1 on drift and writing nothing, a normal run
 * restoring the stamped text, and a file that cannot be stamped stopping the run.
 *
 * `runStamping` takes the root it stamps under, so each drift case runs in
 * process against a scratch tree holding copies of the agent files and the
 * fragments. The repository itself is only read. Two cases run the script as
 * CI does, to pin that the entry point hands the run's output and exit code to
 * the process.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStamping, type StampingRun } from "../../scripts/stamp-wire-contract";

const REPO = join(__dirname, "../..");
const SCRIPT = "scripts/stamp-wire-contract.ts";
const AGENT = "agents/code-reviewer.md";
const BOOTSTRAP_END = "<!-- reviewer-bootstrap:end -->";
const CURRENT = "stamped regions and read-coverage bullets match their sources\n";

/** The script as CI runs it: `bun scripts/stamp-wire-contract.ts …` from the root it lives under. */
const cli = (root: string, ...args: readonly string[]): Omit<StampingRun, "status"> & Readonly<{ status: number | null }> => {
  const run = spawnSync("bun", [join(root, SCRIPT), ...args], { cwd: root, encoding: "utf-8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

const scratchTrees: string[] = [];

/** A root the stamping can run under: copies of everything it reads or writes. Real-pathed, so the entry point recognises a copied script. */
function scratchTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stamp-wire-contract-")));
  scratchTrees.push(root);
  cpSync(join(REPO, "agents"), join(root, "agents"), { recursive: true });
  cpSync(join(REPO, "references"), join(root, "references"), { recursive: true });
  return root;
}

/** A scratch tree the script itself runs in: a copy of it, the engine linked. */
function scriptTree(): string {
  const root = scratchTree();
  mkdirSync(join(root, "scripts"));
  cpSync(join(REPO, SCRIPT), join(root, SCRIPT));
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

const drift = (text: string) => text.replace(BOOTSTRAP_END, `drift\n${BOOTSTRAP_END}`);

afterEach(() => {
  for (const root of scratchTrees.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runStamping", () => {
  it("--check passes on the repository and writes nothing", () => {
    expect(runStamping(REPO, ["--check"])).toEqual({ status: 0, stdout: CURRENT, stderr: "" });
  });

  it("--check exits 1 on a drifted region, naming the agent, and leaves the file as it found it", () => {
    const root = scratchTree();
    const original = readFileSync(join(root, AGENT), "utf-8");
    const drifted = edit(root, drift);
    expect(drifted).not.toBe(original);

    const run = runStamping(root, ["--check"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("code-reviewer: ");
    expect(run.stderr).toContain("reviewer-bootstrap");
    expect(readFileSync(join(root, AGENT), "utf-8")).toBe(drifted);
  });

  it("a normal run restores the stamped text, after which --check passes", () => {
    const root = scratchTree();
    const original = readFileSync(join(root, AGENT), "utf-8");
    edit(root, drift);

    expect(runStamping(root, [])).toEqual({ status: 0, stdout: "stamped code-reviewer\ndone (1 file(s) updated)\n", stderr: "" });
    expect(readFileSync(join(root, AGENT), "utf-8")).toBe(original);
    expect(runStamping(root, ["--check"])).toEqual({ status: 0, stdout: CURRENT, stderr: "" });
  });

  it("stops on an agent file it cannot stamp, naming the agent, with or without --check", () => {
    const root = scratchTree();
    edit(root, (text) => text.replace(BOOTSTRAP_END, ""));

    for (const args of [["--check"], []]) {
      const run = runStamping(root, args);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/^code-reviewer: .*\(expected .*\)\n$/s);
    }
  });
});

describe("scripts/stamp-wire-contract.ts as CI runs it", () => {
  it("--check exits 0 on the repository, printing the run", () => {
    expect(cli(REPO, "--check")).toEqual({ status: 0, stdout: CURRENT, stderr: "" });
  });

  it("--check exits 1 on drift, printing the run's report", () => {
    const root = scriptTree();
    edit(root, drift);
    const run = cli(root, "--check");
    expect(run).toEqual(runStamping(root, ["--check"]));
    expect(run.status).toBe(1);
  });
});
