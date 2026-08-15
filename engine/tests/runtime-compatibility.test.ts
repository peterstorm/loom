import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { piRuntimeHandshakeRequired } from "../src/handler-routes";
import {
  captureLoomRuntimeIdentity,
  loadedRuntimeCompatibility,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
  piCliMutationCompatibility,
  runtimeRevisionFromEntries,
} from "../src/runtime-compatibility";
import { StateManager } from "../src/state-manager";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "engine", "src", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Loom runtime revision", () => {
  it("content-addresses paths and bytes independently of input order", () => {
    const left = runtimeRevisionFromEntries([
      { path: "pi/extension.ts", bytes: Buffer.from("extension") },
      { path: "engine/src/state-manager.ts", bytes: Buffer.from("state") },
    ]);
    const right = runtimeRevisionFromEntries([
      { path: "engine/src/state-manager.ts", bytes: Buffer.from("state") },
      { path: "pi/extension.ts", bytes: Buffer.from("extension") },
    ]);
    const changed = runtimeRevisionFromEntries([
      { path: "engine/src/state-manager.ts", bytes: Buffer.from("state-v2") },
      { path: "pi/extension.ts", bytes: Buffer.from("extension") },
    ]);

    expect(left).toBe(right);
    expect(changed).not.toBe(left);
    expect(left).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("captures engine/Pi source drift without a manually bumped version", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-runtime-identity-"));
    cleanup.push(root);
    mkdirSync(join(root, "engine", "src"), { recursive: true });
    mkdirSync(join(root, "pi"), { recursive: true });
    writeFileSync(join(root, "engine", "src", "state-manager.ts"), "export const schema = 1;\n");
    writeFileSync(join(root, "pi", "extension.ts"), "export default () => {};\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "engine", "package.json"), "{}\n");
    writeFileSync(join(root, "engine", "bun.lock"), "lock-v1\n");

    const before = captureLoomRuntimeIdentity(root);
    writeFileSync(join(root, "engine", "src", "state-manager.ts"), "export const schema = 2;\n");
    const after = captureLoomRuntimeIdentity(root);

    expect(after.packageRoot).toBe(before.packageRoot);
    expect(after.revision).not.toBe(before.revision);
    expect(loadedRuntimeCompatibility(before, after)).toMatchObject({
      ok: false,
      kind: "revision-mismatch",
    });
  });

  it("requires both Pi handshake fields and keeps non-Pi callers compatible", () => {
    const current = captureLoomRuntimeIdentity(ROOT);
    expect(piCliMutationCompatibility({}, current)).toEqual({ ok: true });
    expect(piCliMutationCompatibility({ PI_CODING_AGENT: "true" }, current)).toMatchObject({
      ok: false,
      kind: "handshake-missing",
      message: expect.stringContaining("no CLI mutation was performed"),
    });
    expect(piCliMutationCompatibility({
      PI_CODING_AGENT: "true",
      [PI_EXTENSION_RUNTIME_ROOT_ENV]: current.packageRoot,
      [PI_EXTENSION_RUNTIME_REVISION_ENV]: current.revision,
    }, current)).toEqual({ ok: true });
  });
});

describe("Pi mutation route policy", () => {
  it("guards registered mutations but leaves status and Agent regeneration available", () => {
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["restart"])).toBe(true);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["status"])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "model-profiles", ["render-pi"])).toBe(false);
    expect(piRuntimeHandshakeRequired("pre-tool-use", "validate-task-execution")).toBe(true);
  });

  it("simulates pre-handshake and N-1 Pi extensions and rejects the N writer before any run mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-runtime-skew-cli-"));
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    const run = join(runsRoot, "run.skew-regression");
    mkdirSync(run, { recursive: true });
    const current = captureLoomRuntimeIdentity(ROOT);
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT: "true" };
    delete baseEnv[PI_EXTENSION_RUNTIME_ROOT_ENV];
    delete baseEnv[PI_EXTENSION_RUNTIME_REVISION_ENV];

    const revisions: readonly [string, NodeJS.ProcessEnv][] = [
      ["pre-handshake", baseEnv],
      ["N-1", {
        ...baseEnv,
        [PI_EXTENSION_RUNTIME_ROOT_ENV]: current.packageRoot,
        [PI_EXTENSION_RUNTIME_REVISION_ENV]: "sha256:" + "0".repeat(64),
      }],
    ];
    for (const [scenario, env] of revisions) {
      const result = spawnSync("bun", [
        CLI,
        "helper", "orchestration", "start", "standalone-review",
        "--runs-root", runsRoot,
        "--run", run,
      ], {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({ kind: "comments", files: ["README.md"], dryRun: false }),
        env,
      });

      expect(result.status, scenario).not.toBe(0);
      expect(result.stderr, scenario).toContain("Loom runtime version skew detected");
      expect(result.stderr, scenario).toContain("Run /reload in Pi");
      expect(readdirSync(run), scenario).toEqual([]);
    }
  });

  it("allows status without a handshake so version skew remains diagnosable", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-runtime-skew-status-"));
    cleanup.push(root);
    const result = spawnSync("bun", [CLI, "helper", "orchestration", "status"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PI_CODING_AGENT: "true",
        [PI_EXTENSION_RUNTIME_ROOT_ENV]: undefined,
        [PI_EXTENSION_RUNTIME_REVISION_ENV]: undefined,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Loom Status v1");
  });
});

describe("protected-state write backstop", () => {
  it("refuses a skewed Pi write before chmod, lock creation, or byte changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-runtime-skew-state-"));
    cleanup.push(root);
    const statePath = join(root, "active_task_graph.json");
    const graph = {
      current_phase: "init",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      tasks: [],
      wave_gates: {},
    };
    writeFileSync(statePath, JSON.stringify(graph, null, 2));
    chmodSync(statePath, 0o444);
    const before = readFileSync(statePath);
    const previous = {
      pi: process.env.PI_CODING_AGENT,
      root: process.env[PI_EXTENSION_RUNTIME_ROOT_ENV],
      revision: process.env[PI_EXTENSION_RUNTIME_REVISION_ENV],
    };
    const current = captureLoomRuntimeIdentity(ROOT);
    process.env.PI_CODING_AGENT = "true";
    process.env[PI_EXTENSION_RUNTIME_ROOT_ENV] = current.packageRoot;
    process.env[PI_EXTENSION_RUNTIME_REVISION_ENV] = "sha256:" + "f".repeat(64);

    try {
      await expect(new StateManager(statePath).update((state) => ({ ...state, updated_at: "never" })))
        .rejects.toThrow("no CLI mutation was performed");
      expect(readFileSync(statePath)).toEqual(before);
      expect(statSync(statePath).mode & 0o777).toBe(0o444);
      expect(readdirSync(root).sort()).toEqual(["active_task_graph.json"]);
    } finally {
      if (previous.pi === undefined) delete process.env.PI_CODING_AGENT;
      else process.env.PI_CODING_AGENT = previous.pi;
      if (previous.root === undefined) delete process.env[PI_EXTENSION_RUNTIME_ROOT_ENV];
      else process.env[PI_EXTENSION_RUNTIME_ROOT_ENV] = previous.root;
      if (previous.revision === undefined) delete process.env[PI_EXTENSION_RUNTIME_REVISION_ENV];
      else process.env[PI_EXTENSION_RUNTIME_REVISION_ENV] = previous.revision;
    }
  });
});
