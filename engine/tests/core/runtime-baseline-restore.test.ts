import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureLoomRuntimeIdentity,
  captureLoomRuntimeIdentityRestoring,
} from "../../src/runtime-compatibility";
import { runtimeBaselineRestoreForTasks } from "../../src/utils/artifact-baseline";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type RuntimeBaselineTask = Parameters<typeof runtimeBaselineRestoreForTasks>[1][number];

/** A minimal loom-shaped checkout: the runtime revision domain is exactly
 *  `engine/src` + `pi` + the identity files, so the fixtures mirror that. */
function gitFixture(): { root: string; revision: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-runtime-baseline-")));
  roots.push(root);
  const git = (...args: readonly string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loom@example.test");
  git("config", "user.name", "loom");
  mkdirSync(join(root, "engine", "src", "core"), { recursive: true });
  mkdirSync(join(root, "pi"), { recursive: true });
  writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 1;\n");
  writeFileSync(join(root, "pi", "extension.ts"), "export default () => undefined;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "engine", "package.json"), "{}\n");
  writeFileSync(join(root, "engine", "bun.lock"), "\n");
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  return { root, revision: git("rev-parse", "HEAD").trim() };
}

const taskWith = (overrides: Partial<RuntimeBaselineTask> = {}): RuntimeBaselineTask => ({
  attempt_repository_baseline: [],
  file_list: ["engine/src/core/task.ts"],
  start_sha: "unset",
  ...overrides,
});

describe("runtimeBaselineRestoreForTasks", () => {
  it("restores a declared artifact that was clean at spawn and is dirty now", () => {
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    const restore = runtimeBaselineRestoreForTasks(root, [taskWith({ start_sha: revision })]);
    expect(restore.get("engine/src/core/task.ts")).toBe(revision);
  });

  it("keeps the strict boundary for a path that was already dirty at attempt start", () => {
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    const restore = runtimeBaselineRestoreForTasks(root, [taskWith({
      start_sha: revision,
      attempt_repository_baseline: [{
        artifact: "engine/src/core/task.ts",
        snapshot: { kind: "sha256", digest: "a".repeat(64) },
      }],
    })]);
    expect(restore.has("engine/src/core/task.ts")).toBe(false);
  });

  it("maps an attempt-created file to null (excluded) and skips tasks without a trusted start_sha", () => {
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "created.ts"), "new\n");
    const restore = runtimeBaselineRestoreForTasks(root, [
      taskWith({ file_list: ["engine/src/core/created.ts"], start_sha: revision }),
      taskWith({ file_list: ["engine/src/core/task.ts"], start_sha: undefined }),
      taskWith({ file_list: ["engine/src/core/task.ts"], start_sha: "abc123" }),
    ]);
    expect(restore.get("engine/src/core/created.ts")).toBeNull();
    expect(restore.has("engine/src/core/task.ts")).toBe(false);
  });

  it("never restores an undeclared dirty path", () => {
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    writeFileSync(join(root, "pi", "extension.ts"), "export default () => 1;\n");
    const restore = runtimeBaselineRestoreForTasks(root, [taskWith({ start_sha: revision })]);
    expect(restore.get("engine/src/core/task.ts")).toBe(revision);
    expect(restore.has("pi/extension.ts")).toBe(false);
  });
});

describe("captureLoomRuntimeIdentityRestoring", () => {
  it("hashes a declared, clean-at-spawn artifact at its attempt-start bytes", () => {
    const { root, revision } = gitFixture();
    const clean = captureLoomRuntimeIdentity(root).revision;
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    const drifted = captureLoomRuntimeIdentity(root).revision;
    expect(drifted).not.toBe(clean);
    const restored = captureLoomRuntimeIdentityRestoring(
      root,
      new Map([["engine/src/core/task.ts", revision]]),
    ).revision;
    expect(restored).toBe(clean);
  });

  it("excludes a null-mapped attempt-created file and hashes everything else live", () => {
    const { root, revision } = gitFixture();
    const clean = captureLoomRuntimeIdentity(root).revision;
    writeFileSync(join(root, "engine", "src", "core", "created.ts"), "new\n");
    expect(captureLoomRuntimeIdentity(root).revision).not.toBe(clean);
    const restored = captureLoomRuntimeIdentityRestoring(
      root,
      new Map([["engine/src/core/created.ts", null]]),
    ).revision;
    expect(restored).toBe(clean);
    // The revision must be a real restore, not an unconditional pass-through:
    // an unrelated live edit still drifts.
    writeFileSync(join(root, "pi", "extension.ts"), "export default () => 1;\n");
    expect(captureLoomRuntimeIdentityRestoring(
      root,
      new Map<string, string | null>([["engine/src/core/created.ts", null]]),
    ).revision).not.toBe(clean);
    // With the unrelated drift reverted, restoring the declared attempt-created
    // file (excluded) plus the declared drifted file (baseline bytes) reproduces
    // the attempt-start identity exactly.
    writeFileSync(join(root, "pi", "extension.ts"), "export default () => undefined;\n");
    const bothRestored = captureLoomRuntimeIdentityRestoring(
      root,
      new Map<string, string | null>([
        ["engine/src/core/created.ts", null],
        ["engine/src/core/task.ts", revision],
      ]),
    ).revision;
    expect(bothRestored).toBe(clean);
  });

  it("refuses a non-SHA revision (fail closed, no shell surface)", () => {
    const { root } = gitFixture();
    expect(() => captureLoomRuntimeIdentityRestoring(
      root,
      new Map([["engine/src/core/task.ts", "HEAD; rm -rf /"]]),
    )).toThrow(/non-SHA revision/);
  });
});
