import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeSpawnBatchGraph } from "../../../pi/spawn-graph";
import { findTaskGraphPathFrom } from "../../src/config";
import { collectDiff, realDiffDepsAt } from "../../src/handlers/helpers/task-local-completion";

const roots: string[] = [];
const previousPiAgent = process.env.PI_CODING_AGENT;

/**
 * Pin the pi harness for `taskGraphRelatives()` so the relative candidates are
 * deterministic regardless of the ambient launcher environment (the unit
 * script explicitly unsets `PI_CODING_AGENT`). The set lives in `beforeEach`
 * — a module-scope set does not survive the first `afterEach` restore, and
 * the graph-dependent assertions need the pin before every test, not just the
 * first. Restored in `afterEach` to the captured original. Vitest isolates
 * each test file in its own worker, so the pin cannot leak into siblings.
 */
beforeEach(() => {
  process.env.PI_CODING_AGENT = "pi";
});

const graphless = (): string => {
  const root = canonicalTempDir("loom-spawn-graph-");
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
  writeFileSync(join(root, "seed.txt"), "seed\n");
  writeFileSync(join(root, ".gitignore"), ".loom-state/\n");
  execFileSync("git", ["add", "seed.txt", ".gitignore"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root });
  return root;
};

const graphed = (): string => {
  const root = graphless();
  mkdirSync(join(root, ".pi", "state"), { recursive: true });
  writeFileSync(join(root, ".pi", "state", "active_task_graph.json"), "{}\n");
  return root;
};

const batch = (...cwds: readonly string[]) => ({
  tasks: cwds.map((cwd) => ({ agent: "code-implementer-agent", cwd })),
});

afterEach(() => {
  if (previousPiAgent === undefined) delete process.env.PI_CODING_AGENT;
  else process.env.PI_CODING_AGENT = previousPiAgent;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("spawn batch graph observation", () => {
  it("classifies an all-absent batch as the runtime polarity", () => {
    const a = graphless();
    const b = graphless();
    expect(observeSpawnBatchGraph(batch(a, b), "/tmp")).toEqual({ kind: "runtime" });
  });

  it("classifies a single-graph batch as spawn targeting that graph", () => {
    const a = graphed();
    const graphPath = join(a, ".pi", "state", "active_task_graph.json");
    expect(observeSpawnBatchGraph(batch(a, a), "/tmp")).toEqual({ kind: "spawn", graphPath });
  });

  it("refuses a batch whose items resolve to two different graphs", () => {
    const a = graphed();
    const b = graphed();
    expect(observeSpawnBatchGraph(batch(a, b), "/tmp").kind).toBe("diverged");
  });

  it("refuses an absence-first batch whose later item carries a graph", () => {
    // The fixed branch: null is both the not-yet-assigned sentinel and the
    // legitimate no-graph answer, so the collapsed `graphPath === null` guard
    // used to adopt the later graph here via the assignment branch
    // (order-dependent) instead of returning the documented diverged refusal.
    const absent = graphless();
    const withGraph = graphed();
    expect(observeSpawnBatchGraph(batch(absent, withGraph), "/tmp").kind).toBe("diverged");
  });

  it("refuses a graph-first batch whose later item proves absence", () => {
    const withGraph = graphed();
    const absent = graphless();
    expect(observeSpawnBatchGraph(batch(withGraph, absent), "/tmp").kind).toBe("diverged");
  });

  it("resolves a malformed batch to the runtime polarity", () => {
    expect(observeSpawnBatchGraph("not-an-object", "/tmp")).toEqual({ kind: "runtime" });
    expect(observeSpawnBatchGraph(null, "/tmp")).toEqual({ kind: "runtime" });
  });
});

describe("findTaskGraphPathFrom cross-cwd polarity", () => {
  it("returns the repository-root graph for a subdirectory cwd", () => {
    const root = graphed();
    const sub = join(root, "packages", "sub");
    mkdirSync(sub, { recursive: true });
    expect(findTaskGraphPathFrom(sub)).toBe(join(root, ".pi", "state", "active_task_graph.json"));
  });

  it("returns the harness-native creation path when the repository proves no graph", () => {
    const root = graphless();
    expect(findTaskGraphPathFrom(root)).toBe(join(root, ".pi", "state", "active_task_graph.json"));
  });
});

describe("root-explicit settlement diff deps", () => {
  it("keeps a worktree-only untracked file in the untracked arm when the settlement process is rooted elsewhere", () => {
    // The fixed branch: the presence check resolved repository-relative paths
    // against process.cwd(), so a file present only in the rooted repository
    // was classified absent and its bytes silently dropped from new-test
    // evidence — a false `new-tests-not-observed` verdict on real bytes.
    const root = graphless();
    writeFileSync(join(root, "spawned-new.test.ts"), 'it("spawned work", () => { expect(1).toBe(1); });\n');
    const observed = collectDiff(["spawned-new.test.ts"], realDiffDepsAt(root));
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.value).toContain('it("spawned work"');
  });

  it("drops an untracked file that exists nowhere", () => {
    const root = graphless();
    const observed = collectDiff(["missing-new.test.ts"], realDiffDepsAt(root));
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    // No untracked arm entry: the `--no-index` patch against /dev/null never
    // runs, so the joined diff carries only the empty tracked-diff joins.
    expect(observed.value).not.toContain("/dev/null");
  });
});
