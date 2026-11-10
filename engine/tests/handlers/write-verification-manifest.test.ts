import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  readdirSync,
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

function manifestPath(root: string): string {
  return join(root, ".loom", "verification-manifest.json");
}

function installedCheckIds(root: string): readonly string[] {
  const installed = JSON.parse(readFileSync(manifestPath(root), "utf-8")) as {
    readonly checks: readonly { readonly id: string }[];
  };
  return installed.checks.map((check) => check.id);
}

describe("write-verification-manifest", () => {
  it("validates and installs canonical operator authority before task population", async () => {
    const { root } = project();

    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");

    expect(installedCheckIds(root)).toEqual(["project:test"]);
    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");
  });

  it("fails closed on invalid input without creating authority", async () => {
    const { root } = project();

    const result = await writeVerificationManifest("{not-json", []);

    expect(result.kind).toBe("error");
    expect(() => readFileSync(join(root, ".loom", "verification-manifest.json"))).toThrow();
  });

  it("refuses to overwrite different installed authority and names --replace", async () => {
    const { root } = project();
    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");
    const before = readFileSync(manifestPath(root), "utf-8");

    const result = await writeVerificationManifest(source("project:typecheck"), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("refusing overwrite");
      expect(result.message).toContain("--replace");
    }
    expect(readFileSync(manifestPath(root), "utf-8")).toBe(before);
  });

  it("treats an installed manifest that differs only in formatting as the same authority", async () => {
    const { root } = project();
    mkdirSync(join(root, ".loom"));
    const handWritten = JSON.stringify(JSON.parse(source()), null, 7);
    writeFileSync(manifestPath(root), handWritten);

    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");
    expect(readFileSync(manifestPath(root), "utf-8")).toBe(handWritten);
  });

  it("replaces different authority with --replace before task population, leaving no staged file", async () => {
    const { root } = project();
    expect((await writeVerificationManifest(source(), [])).kind).toBe("passthrough");

    const result = await writeVerificationManifest(source("project:typecheck"), ["--replace"]);

    expect(result.kind).toBe("passthrough");
    expect(installedCheckIds(root)).toEqual(["project:typecheck"]);
    expect(readdirSync(join(root, ".loom"))).toEqual(["verification-manifest.json"]);
  });

  it("replaces an invalid installed manifest only with --replace", async () => {
    const { root } = project();
    mkdirSync(join(root, ".loom"));
    writeFileSync(manifestPath(root), "{broken");

    const refused = await writeVerificationManifest(source(), []);
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") expect(refused.message).toContain("not a valid verification manifest");
    expect(readFileSync(manifestPath(root), "utf-8")).toBe("{broken");

    expect((await writeVerificationManifest(source(), ["--replace"])).kind).toBe("passthrough");
    expect(installedCheckIds(root)).toEqual(["project:test"]);
  });

  it("refuses unknown arguments without touching the manifest", async () => {
    const { root } = project();

    const result = await writeVerificationManifest(source(), ["--replce"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("unexpected arguments");
    expect(() => readFileSync(manifestPath(root))).toThrow();
  });

  it("refuses to replace through a symlinked manifest file", async () => {
    const { root } = project();
    mkdirSync(join(root, ".loom"));
    const outside = join(root, "outside.json");
    writeFileSync(outside, source());
    symlinkSync(outside, manifestPath(root));

    const result = await writeVerificationManifest(source("project:typecheck"), ["--replace"]);

    expect(result.kind).toBe("error");
    expect(readFileSync(outside, "utf-8")).toBe(source());
  });

  it("refuses mutation after task population, with or without --replace", async () => {
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

    for (const args of [[], ["--replace"]]) {
      const result = await writeVerificationManifest(source(), args);

      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.message).toContain("already frozen");
    }
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
