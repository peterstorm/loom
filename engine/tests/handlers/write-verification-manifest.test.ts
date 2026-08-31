import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import writeVerificationManifest from "../../src/handlers/helpers/write-verification-manifest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { taskFixture } from "../fixtures/task-lifecycle";
import type { TaskGraph } from "../../src/types";

const originalCwd = process.cwd();
const directories: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.LOOM_STATE_PATH;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

function project(): { readonly root: string; readonly statePath: string } {
  const root = canonicalTempDir("loom-write-verification-manifest-");
  directories.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(dirname(statePath), { recursive: true });
  const graph: TaskGraph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
  };
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
  process.chdir(root);
  return { root, statePath };
}

function source(id = "project:test"): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id,
      scope: "wave",
      executable: "bun",
      args: ["test"],
      cwd: ".",
      timeoutMs: 60_000,
      report: { kind: "not-required" },
    }],
  });
}

describe("write-verification-manifest", () => {
  it("validates and installs canonical operator authority before task population", async () => {
    const { root } = project();

    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");

    const installed = JSON.parse(
      readFileSync(join(root, ".loom", "verification-manifest.json"), "utf-8"),
    ) as { readonly checks: readonly { readonly id: string }[] };
    expect(installed.checks.map((check) => check.id)).toEqual(["project:test"]);
    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");
  });

  it("fails closed on invalid input without creating authority", async () => {
    const { root } = project();

    const result = await writeVerificationManifest("{not-json", []);

    expect(result.kind).toBe("error");
    expect(() => readFileSync(join(root, ".loom", "verification-manifest.json"))).toThrow();
  });

  it("refuses to overwrite different installed authority", async () => {
    project();
    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");

    const result = await writeVerificationManifest(source("project:typecheck"), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("refusing overwrite");
  });

  it("refuses mutation after task population", async () => {
    const { statePath } = project();
    const graph = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    writeFileSync(statePath, JSON.stringify({
      ...graph,
      tasks: [taskFixture({
        id: "T1",
        description: "implement",
        agent: "code-implementer-agent",
        wave: 1,
        status: "pending",
        depends_on: [],
      })],
    }));

    const result = await writeVerificationManifest(source(), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("already frozen");
  });

  it("refuses a symlinked manifest directory", async () => {
    const { root } = project();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".loom"));

    const result = await writeVerificationManifest(source(), []);

    expect(result.kind).toBe("error");
    expect(() => readFileSync(join(outside, "verification-manifest.json"))).toThrow();
  });
});
