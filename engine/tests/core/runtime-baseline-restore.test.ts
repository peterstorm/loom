import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { git, gitResult } from "../fixtures/git-repository";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureLoomRuntimeIdentity,
  captureLoomRuntimeIdentityRestoring,
} from "../../src/runtime-compatibility";
import { runtimeBaselineRestoreForTasks } from "../../src/utils/runtime-baseline-restore";
import {
  describeRuntimeBaselineRestoreRefusal,
  runtimeBaselineRestoreAt,
  runtimeBaselineRestoreCandidates,
  type RuntimeBaselineFacts,
} from "../../src/core/runtime-baseline-restore";
import fc from "fast-check";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The restore reads only the repository baseline; `file_list` documents each
 *  fixture's declared intent, which the rules deliberately ignore. */
type RuntimeBaselineTask = Parameters<typeof runtimeBaselineRestoreForTasks>[1][number] & {
  readonly file_list?: readonly string[];
};

/** A minimal loom-shaped checkout: the runtime revision domain is exactly
 *  `engine/src` + `pi` + the identity files, so the fixtures mirror that. */
function gitFixture(): { root: string; revision: string } {
  const root = canonicalTempDir("loom-runtime-baseline-");
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "loom@example.test"]);
  git(root, ["config", "user.name", "loom"]);
  mkdirSync(join(root, "engine", "src", "core"), { recursive: true });
  mkdirSync(join(root, "pi"), { recursive: true });
  writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 1;\n");
  writeFileSync(join(root, "pi", "extension.ts"), "export default () => undefined;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "engine", "package.json"), "{}\n");
  writeFileSync(join(root, "engine", "bun.lock"), "\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  return { root, revision: gitResult(root, ["rev-parse", "HEAD"]).stdout.trim() };
}

const taskWith = (overrides: Partial<RuntimeBaselineTask> = {}): RuntimeBaselineTask => ({
  attempt_repository_baseline: [],
  file_list: ["engine/src/core/task.ts"],
  ...overrides,
});

describe("runtimeBaselineRestoreForTasks", () => {
  it("restores a declared artifact that was clean at spawn and is dirty now", () => {
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    const restore = runtimeBaselineRestoreForTasks(root, [taskWith()]);
    expect(restore.get("engine/src/core/task.ts")).toBe(revision);
  });

  it("keeps the strict boundary for a path that was already dirty at attempt start", () => {
    const { root } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    const restore = runtimeBaselineRestoreForTasks(root, [taskWith({
      attempt_repository_baseline: [{
        artifact: "engine/src/core/task.ts",
        snapshot: { kind: "sha256", digest: "a".repeat(64) },
      }],
    })]);
    expect(restore.has("engine/src/core/task.ts")).toBe(false);
  });

  it("maps an attempt-created file to null (excluded) and stays strict for undeclared dirt", () => {
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "created.ts"), "new\n");
    const restore = runtimeBaselineRestoreForTasks(root, [
      taskWith({ file_list: ["engine/src/core/created.ts"] }),
    ]);
    expect(restore.get("engine/src/core/created.ts")).toBeNull();
    expect(restore.get("engine/src/core/task.ts")).toBeUndefined();
    expect(restore.size).toBe(1);
    // HEAD is content-addressed: the mapped revision IS the attempt-start state.
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it("restores the WHOLE revision domain, not only declared artifacts", () => {
    // An implementation attempt's necessary writes are not bounded by its
    // declared list: the render/wording changes ripple into the dispatch call
    // sites that consume them, and the compiler drives the child there. The
    // settlement exemption must cover the attempt's actual product — any
    // domain file that was clean at spawn and is dirty now.
    const { root, revision } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    writeFileSync(join(root, "pi", "extension.ts"), "export default () => 1;\n");
    writeFileSync(join(root, "engine", "src", "core", "created.ts"), "new\n");
    const restore = runtimeBaselineRestoreForTasks(root, [taskWith()]);
    expect(restore.get("engine/src/core/task.ts")).toBe(revision);
    expect(restore.get("pi/extension.ts")).toBe(revision);
    expect(restore.get("engine/src/core/created.ts")).toBeNull();
  });

  it("excludes attempt-created scratch anywhere in the domain and keeps multi-attempt dirt strict", () => {
    const { root } = gitFixture();
    // Scratch the attempt created (untracked, absent at HEAD) maps to null.
    writeFileSync(join(root, "engine", "src", "core", "scratch.ts"), "notes\n");
    // A path dirty at spawn in ANY in-flight attempt stays strict for all.
    writeFileSync(join(root, "pi", "extension.ts"), "export default () => 1;\n");
    const restore = runtimeBaselineRestoreForTasks(root, [
      taskWith(),
      taskWith({
        file_list: ["docs/other.md"],
        attempt_repository_baseline: [{
          artifact: "pi/extension.ts",
          snapshot: { kind: "sha256", digest: "b".repeat(64) },
        }],
      }),
    ]);
    expect(restore.get("engine/src/core/scratch.ts")).toBeNull();
    expect(restore.has("pi/extension.ts")).toBe(false);
  });

  it("refuses the whole map with its parse cause when any baseline is unparseable", () => {
    const { root } = gitFixture();
    writeFileSync(join(root, "engine", "src", "core", "task.ts"), "export const task = 2;\n");
    expect(() => runtimeBaselineRestoreForTasks(root, [
      taskWith(),
      taskWith({
        // @ts-expect-error hostile baseline shape drives the refusal.
        attempt_repository_baseline: [{ artifact: 42 }],
      }),
    ])).toThrow(
      "an in-flight attempt repository baseline is unparseable, so no runtime-baseline restore applies: " +
      "attempt repository baseline[0].artifact must be non-empty",
    );
  });

  it("needs no baseline at all while the runtime domain is clean", () => {
    const { root } = gitFixture();
    expect(runtimeBaselineRestoreForTasks(root, [
      // @ts-expect-error a clean domain has nothing to restore, so nothing is parsed.
      taskWith({ attempt_repository_baseline: [{ artifact: 42 }] }),
    ]).size).toBe(0);
  });
});

describe("runtime-baseline restoration rules (pure)", () => {
  const facts = (overrides: Partial<RuntimeBaselineFacts> = {}): RuntimeBaselineFacts => ({
    dirtyNow: new Set(["engine/src/a.ts", "engine/src/b.ts", "docs/c.md"]),
    domainPaths: ["engine/src/a.ts", "engine/src/b.ts", "engine/src/clean.ts"],
    attemptRepositoryBaselines: [],
    ...overrides,
  });
  const dirtyAtSpawn = (artifact: string) => [{ artifact, snapshot: { kind: "missing" } }];

  it("restores exactly the domain paths dirty now, mapping each to HEAD or to null when absent there", () => {
    const candidates = runtimeBaselineRestoreCandidates(facts());
    expect(candidates).toEqual({ ok: true, value: ["engine/src/a.ts", "engine/src/b.ts"] });
    if (!candidates.ok) return;
    expect([...runtimeBaselineRestoreAt(candidates.value, "f".repeat(40), new Set(["engine/src/a.ts"]))])
      .toEqual([["engine/src/a.ts", "f".repeat(40)], ["engine/src/b.ts", null]]);
  });

  it("keeps a path strict when ANY attempt saw it dirty at spawn; an attempt without a baseline proves nothing", () => {
    expect(runtimeBaselineRestoreCandidates(facts({
      attemptRepositoryBaselines: [undefined, dirtyAtSpawn("engine/src/b.ts"), []],
    }))).toEqual({ ok: true, value: ["engine/src/a.ts"] });
  });

  it("refuses with every parse error rather than silently restoring nothing", () => {
    const refused = runtimeBaselineRestoreCandidates(facts({
      attemptRepositoryBaselines: [dirtyAtSpawn("engine/src/a.ts"), [{ artifact: "../escape", snapshot: { kind: "missing" } }]],
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.kind).toBe("unparseable-attempt-baseline");
    expect(describeRuntimeBaselineRestoreRefusal(refused.error)).toContain("attempt repository baseline[0].artifact");
  });

  it("property: candidates are always dirty domain paths, and adding dirt at spawn never adds a candidate", () => {
    const path = fc.constantFrom<string>("engine/src/a.ts", "engine/src/b.ts", "pi/c.ts", "docs/d.md");
    fc.assert(fc.property(fc.uniqueArray(path), fc.uniqueArray(path), fc.uniqueArray(path), (dirty, domain, spawn) => {
      const base = runtimeBaselineRestoreCandidates({ dirtyNow: new Set(dirty), domainPaths: domain, attemptRepositoryBaselines: [[]] });
      const stricter = runtimeBaselineRestoreCandidates({
        dirtyNow: new Set(dirty), domainPaths: domain,
        attemptRepositoryBaselines: [spawn.flatMap(dirtyAtSpawn)],
      });
      if (!base.ok || !stricter.ok) throw new Error("well-formed baselines must parse");
      expect(base.value.every((candidate) => dirty.includes(candidate) && domain.includes(candidate))).toBe(true);
      expect(stricter.value.every((candidate) => base.value.includes(candidate) && !spawn.includes(candidate))).toBe(true);
    }));
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
