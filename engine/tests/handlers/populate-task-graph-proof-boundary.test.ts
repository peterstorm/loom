import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { git, write } from "../fixtures/git-repository";
import type { TaskGraph } from "../../src/types";

/**
 * Population's proof boundary: an absent boundary is reported in the
 * population result (not only on stderr), an unreadable capture source still
 * degrades to absent, and a defect inside baseline capture propagates instead
 * of passing as a benign absence. Baseline capture is replaced per test so the
 * failure class is exact.
 */

const capture = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("../../src/utils/declared-artifact-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/declared-artifact-snapshot")>();
  return {
    ...actual,
    captureDeclaredArtifactBaselineAtRevision: (...args: Parameters<typeof actual.captureDeclaredArtifactBaselineAtRevision>) => {
      if (capture.failure !== null) throw capture.failure;
      return actual.captureDeclaredArtifactBaselineAtRevision(...args);
    },
  };
});

const { default: populate } = await import("../../src/handlers/helpers/populate-task-graph");

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  capture.failure = null;
  delete process.env.LOOM_STATE_PATH;
  delete process.env.CLAUDE_PROJECT_DIR;
});

function project(repository: boolean): Readonly<{ dir: string; statePath: string; planFile: string }> {
  const dir = canonicalTempDir("loom-populate-proof-boundary-");
  dirs.push(dir);
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# Plan\n\nNo models.\n");
  if (repository) {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
    git(dir, ["config", "user.name", "Fixture"]);
    write(dir, "src/other.ts", "export {};\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "seed"]);
  }
  const statePath = join(dir, ".claude", "state", "active_task_graph.json");
  mkdirSync(dirname(statePath), { recursive: true });
  const state: TaskGraph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: planFile,
    tasks: [],
    wave_gates: {},
  };
  writeFileSync(statePath, JSON.stringify(state));
  process.env.LOOM_STATE_PATH = statePath;
  process.env.CLAUDE_PROJECT_DIR = dir;
  return { dir, statePath, planFile };
}

const decompose = (planFile: string): string => JSON.stringify({
  spec_trace_version: 2,
  plan_title: "t",
  spec_file: "spec.md",
  plan_file: planFile,
  tasks: [{
    id: "T9", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [],
    spec_anchors: [], spec_contributions: [],
    verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
    plan_context: "", file_list: ["src/other.ts"],
  }],
});

const populatedTask = (statePath: string) =>
  (JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph).tasks[0];

describe("populate-task-graph proof boundary", () => {
  it("reports an absent boundary and its cause in the population result", async () => {
    const { planFile } = project(false);
    const result = await populate(decompose(planFile), []);
    expect(result.kind).toBe("passthrough");
    if (result.kind !== "passthrough") return;
    expect(result.systemMessage).toContain("Task proof boundaries NOT captured: no Git repository root");
    expect(result.systemMessage).toContain("each Task's first dispatch stamps its own boundary");
  });

  it("captures the boundary in a repository and reports no absence", async () => {
    const { planFile, statePath } = project(true);
    const result = await populate(decompose(planFile), []);
    expect(result.kind).toBe("passthrough");
    if (result.kind !== "passthrough") return;
    expect(result.systemMessage).not.toContain("NOT captured");
    expect(populatedTask(statePath)).toBeDefined();
  });

  it("degrades an unreadable capture source to an absent boundary it reports", async () => {
    const { planFile } = project(true);
    capture.failure = new Error("declared artifact src/other.ts is unreadable");
    const result = await populate(decompose(planFile), []);
    expect(result.kind).toBe("passthrough");
    if (result.kind !== "passthrough") return;
    expect(result.systemMessage).toContain("Task proof boundaries NOT captured: declared artifact src/other.ts is unreadable");
  });

  it.each([
    new TypeError("cannot read properties of undefined"),
    new ReferenceError("baseline is not defined"),
    new RangeError("invalid array length"),
  ])("propagates a capture defect (%s) instead of degrading the boundary", async (defect) => {
    const { planFile, statePath } = project(true);
    const before = readFileSync(statePath, "utf-8");
    capture.failure = defect;
    await expect(populate(decompose(planFile), [])).rejects.toBe(defect);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });
});
