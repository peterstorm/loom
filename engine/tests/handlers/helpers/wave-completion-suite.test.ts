import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTaskProof } from "../../../src/core/proof-obligations";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
} from "../../../src/core/verification-manifest";
import {
  ensureWaveCompletionSuite,
  observeCurrentWaveWorkspace,
} from "../../../src/handlers/helpers/wave-completion-suite";
import type { RegisteredWaveGateProgram } from "../../../src/handlers/helpers/programs/helpers";
import { createRunDirectory, type RunDirHandle } from "../../../src/orchestration/run-directory-handle";
import { StateManager } from "../../../src/state-manager";
import type { ActiveWaveGateRegistration, TaskGraph } from "../../../src/types";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function manifest(mode: string, report = true) {
  const parsed = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: "project:completion",
      scope: "wave",
      executable: mode === "spawn-failure" ? "loom-command-does-not-exist" : "node",
      args: mode === "spawn-failure" ? [] : ["completion-check.mjs", mode],
      cwd: ".",
      timeoutMs: 5_000,
      report: report
        ? { kind: "required-file", path: ".loom/completion-reports/result.txt" }
        : { kind: "not-required" },
    }],
  })));
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

const proof = evaluateTaskProof(
  { newTestsRequired: true, declaredArtifacts: [] },
  { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: [], newTestsWritten: true },
);
if (proof.state !== "satisfied") throw new Error("proof fixture must be satisfied");

function completionScript(): string {
  return `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
const report = ".loom/completion-reports/result.txt";
const state = JSON.parse(readFileSync(".claude/state/active_task_graph.json", "utf8"));
if (state.active_wave_completion_suite !== undefined) process.exit(7);
mkdirSync(".loom/completion-reports", { recursive: true });
const previous = (() => { try { return Number(readFileSync(report, "utf8")); } catch { return 0; } })();
if (mode === "success") writeFileSync(report, String(previous + 1));
else if (mode === "nonzero") {
  writeFileSync(report, String(previous + 1));
  process.exit(2);
}
else if (mode === "missing-report") process.exit(0);
else if (mode === "mutate-workspace") {
  writeFileSync("source.ts", "export const value = 2;\\n");
  writeFileSync(report, String(previous + 1));
} else process.exit(3);
`;
}

type Fixture = Readonly<{
  root: string;
  manager: StateManager;
  handle: RunDirHandle;
  registration: RegisteredWaveGateProgram;
}>;

function fixture(mode: string, report = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "loom-wave-suite-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  write(root, ".gitignore", ".loom/completion-reports/\n");
  write(root, "source.ts", "export const value = 1;\n");
  write(root, "completion-check.mjs", completionScript());
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");

  const active: ActiveWaveGateRegistration = {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: "run.wave-suite" as ActiveWaveGateRegistration["runId"],
    wave: 1,
    authorityDigest: "a".repeat(64) as ActiveWaveGateRegistration["authorityDigest"],
    revision: 0,
    runsRoot: join(root, ".claude/reviews/wave-gate-runs"),
    terminalOutcome: null,
  };
  const graph: TaskGraph = {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [{
      id: "T1",
      description: "run completion suite",
      agent: "code-implementer-agent",
      wave: 1,
      status: "implemented",
      proof,
      depends_on: [],
      test_result: { verdict: "trusted-pass" },
      new_tests_written: true,
      review_status: "pending",
      critical_findings: [],
      advisory_findings: [],
    }],
    wave_gates: {},
    verification_manifest: manifest(mode, report),
    active_wave_gate: active,
  };
  const statePath = join(root, ".claude/state/active_task_graph.json");
  write(root, ".claude/state/active_task_graph.json", JSON.stringify(graph, null, 2));
  chmodSync(statePath, 0o444);
  mkdirSync(active.runsRoot!, { recursive: true });
  const created = createRunDirectory(active.runsRoot!, active.runId);
  if (!created.ok) throw new Error(created.error.message);
  const registration: RegisteredWaveGateProgram = Object.freeze({
    schemaVersion: 1,
    kind: "wave-gate",
    input: Object.freeze({ wave: 1 }),
    taskIds: Object.freeze(["T1"]),
    authorityDigest: active.authorityDigest,
  });
  return { root, manager: new StateManager(statePath), handle: created.value, registration };
}

async function ensure(f: Fixture) {
  return ensureWaveCompletionSuite({
    handle: f.handle,
    manager: f.manager,
    graph: f.manager.load(),
    registration: f.registration,
  });
}

function reportCount(root: string): number {
  try {
    return Number(readFileSync(join(root, ".loom/completion-reports/result.txt"), "utf8"));
  } catch {
    return 0;
  }
}

function resultArtifactAuthority(f: Fixture) {
  const graph = f.manager.load();
  const workspace = observeCurrentWaveWorkspace(graph, f.root);
  if (workspace.kind !== "observed" || graph.active_wave_gate === undefined || graph.verification_manifest === undefined) {
    throw new Error("fixture must carry observable modern completion authority");
  }
  const authorized = authorizeWaveCompletionSuite(
    graph.verification_manifest,
    graph.active_wave_gate,
    workspace.workspaceDigest,
  );
  if (!authorized.ok) throw new Error(authorized.error.errors.join("; "));
  return authorized.value;
}

function resultArtifactRelativePath(f: Fixture): string {
  const authority = resultArtifactAuthority(f);
  return `completion-suites/${authority.suiteDigest}/${authority.workspaceDigest}.json`;
}

async function publishRawResultArtifact(f: Fixture, raw: unknown): Promise<void> {
  const published = await f.handle.publishArtifactSet([{
    relativePath: resultArtifactRelativePath(f),
    bytes: [...new TextEncoder().encode(typeof raw === "string" ? raw : JSON.stringify(raw))],
  }]);
  if (!published.ok) throw new Error(published.error.message);
}

async function removeActiveReceipt(f: Fixture): Promise<void> {
  await f.manager.update((locked) => {
    const { active_wave_completion_suite: _removed, ...withoutReceipt } = locked;
    return withoutReceipt;
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("modern Wave completion suite shell", () => {
  it("rejects report exclusions outside the protected completion-report root", () => {
    const parsed = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      kind: "loom-verification-manifest",
      checks: [{
        id: "project:laundered-report",
        scope: "wave",
        executable: "node",
        args: ["completion-check.mjs", "success"],
        cwd: ".",
        timeoutMs: 5_000,
        report: { kind: "required-file", path: "source.ts" },
      }],
    })));
    expect(parsed).toMatchObject({
      ok: false,
      error: { errors: [expect.stringContaining(".loom/completion-reports/")] },
    });
  });

  it("executes in the Run Directory repository from an outside cwd, publishes, installs, and reuses", async () => {
    const f = fixture("success");
    const first = await ensure(f);
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true,
      value: { kind: "accepted", disposition: "installed" },
    });
    expect(reportCount(f.root)).toBe(1);

    const receipt = f.manager.load().active_wave_completion_suite;
    expect(receipt).toBeDefined();
    const artifact = join(
      f.handle.runDirectory,
      "artifacts/completion-suites",
      receipt!.suiteDigest,
      `${receipt!.workspaceDigest}.json`,
    );
    const published = JSON.parse(readFileSync(artifact, "utf8")) as { checks: unknown[] };
    expect(published.checks).toHaveLength(2);

    const repeated = await ensure(f);
    expect(repeated).toMatchObject({ ok: true, value: { disposition: "reused" } });
    expect(reportCount(f.root)).toBe(1);
  });

  it("returns semantic categories for nonzero and missing-report outcomes without installing a receipt", async () => {
    for (const mode of ["nonzero", "missing-report"] as const) {
      const f = fixture(mode);
      const result = await ensure(f);
      expect(result).toMatchObject({
        ok: false,
        error: {
          diagnostic: {
            categories: ["semantic"],
            checkIds: ["project:completion"],
          },
        },
      });
      expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
    }
  });

  it("leaves infrastructure failures unpublished so environment repair can retry", async () => {
    const f = fixture("spawn-failure", false);
    const relativePath = resultArtifactRelativePath(f);
    const failed = await ensure(f);
    expect(failed).toMatchObject({
      ok: false,
      error: { diagnostic: { categories: ["infrastructure"], checkIds: ["project:completion"] } },
    });
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
    expect(f.handle.readArtifactBytes(relativePath)).toEqual({ ok: true, value: null });

    const repairedBin = mkdtempSync(join(tmpdir(), "loom-wave-suite-bin-"));
    roots.push(repairedBin);
    const repairedExecutable = join(repairedBin, "loom-command-does-not-exist");
    writeFileSync(repairedExecutable, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(repairedExecutable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${repairedBin}:${previousPath ?? ""}`;
    try {
      expect(await ensure(f)).toMatchObject({
        ok: true,
        value: { kind: "accepted", disposition: "installed" },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const persisted = f.handle.readArtifactBytes(relativePath);
    expect(persisted.ok && persisted.value !== null).toBe(true);
  });

  it("recovers an accepted receipt from its immutable result after a publication-to-state crash", async () => {
    const f = fixture("success");
    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    expect(reportCount(f.root)).toBe(1);

    await removeActiveReceipt(f);
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();

    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    expect(f.manager.load().active_wave_completion_suite).toBeDefined();
    expect(reportCount(f.root)).toBe(1);
  });

  it("replays a persisted exact semantic rejection without rerunning checks", async () => {
    const f = fixture("nonzero");
    const first = await ensure(f);
    expect(first).toMatchObject({
      ok: false,
      error: { diagnostic: { categories: ["semantic"], checkIds: ["project:completion"] } },
    });
    expect(reportCount(f.root)).toBe(1);

    const replayed = await ensure(f);
    expect(replayed).toEqual(first);
    expect(reportCount(f.root)).toBe(1);
  });

  it.each([
    "malformed",
    "stale",
    "authority-rejected",
    "infrastructure-failure",
  ] as const)("blocks an occupied %s result artifact without executing commands", async (variant) => {
    const f = fixture("success");
    if (variant === "malformed") {
      await publishRawResultArtifact(f, "{not-json");
    } else {
      const authority = resultArtifactAuthority(f);
      const staleWorkspaceDigest = authority.workspaceDigest === "f".repeat(64)
        ? "e".repeat(64)
        : "f".repeat(64);
      const checks = variant === "infrastructure-failure"
        ? authority.checks.map((check) => ({
            checkId: check.checkId,
            scope: "wave",
            outcome: check.kind === "project-command"
              ? { kind: "spawn-failed", message: "persisted spawn failure" }
              : {
                  kind: "observed",
                  exitCode: 0,
                  timedOut: false,
                  signal: null,
                  report: { kind: "not-required" },
                },
          }))
        : [];
      await publishRawResultArtifact(f, {
        ...authority,
        kind: "wave-completion-suite-result",
        ...(variant === "stale" ? { workspaceDigest: staleWorkspaceDigest } : {}),
        checks,
      });
    }

    expect(await ensure(f)).toMatchObject({
      ok: false,
      error: { diagnostic: { categories: ["artifact"] } },
    });
    expect(reportCount(f.root)).toBe(0);
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
  });

  it("blocks a workspace-mutating check before artifact or receipt installation", async () => {
    const f = fixture("mutate-workspace");
    const result = await ensure(f);
    expect(result).toMatchObject({ ok: false, error: { diagnostic: { categories: ["workspace"] } } });
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
  });

  it("clears a stale receipt under authority before rerunning and leaves the replacement reusable", async () => {
    const f = fixture("success");
    const initial = await ensure(f);
    expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    const firstDigest = f.manager.load().active_wave_completion_suite!.workspaceDigest;
    write(f.root, "source.ts", "export const value = 3;\n");

    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    const replacement = f.manager.load().active_wave_completion_suite!;
    expect(replacement.workspaceDigest).not.toBe(firstDigest);
    expect(reportCount(f.root)).toBe(2);
    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "reused" } });
    expect(reportCount(f.root)).toBe(2);
  });

  it("requires an authority start path for workspace observation", () => {
    const f = fixture("success");
    const outside = mkdtempSync(join(tmpdir(), "loom-wave-suite-no-git-"));
    roots.push(outside);
    expect(observeCurrentWaveWorkspace(f.manager.load(), outside)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("Git resolve-root failed"),
    });
    expect(observeCurrentWaveWorkspace(f.manager.load(), f.handle.runDirectory)).toMatchObject({
      kind: "observed",
    });
  });

  it("fails closed when Run Directory and protected TaskGraph repository authority differ", async () => {
    const f = fixture("success");
    const foreignRepository = mkdtempSync(join(tmpdir(), "loom-wave-suite-foreign-git-"));
    roots.push(foreignRepository);
    git(foreignRepository, "init", "-q");
    const foreignRunsRoot = join(foreignRepository, ".claude/reviews/wave-gate-runs");
    mkdirSync(foreignRunsRoot, { recursive: true });
    const foreignHandle = createRunDirectory(foreignRunsRoot, f.handle.runId);
    if (!foreignHandle.ok) throw new Error(foreignHandle.error.message);

    const result = await ensureWaveCompletionSuite({
      handle: foreignHandle.value,
      manager: f.manager,
      graph: f.manager.load(),
      registration: f.registration,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostic: {
          categories: ["authority"],
          message: expect.stringContaining("differs from protected TaskGraph repository"),
        },
      },
    });
    expect(reportCount(f.root)).toBe(0);
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
  });

  it("fails closed when the protected TaskGraph path has no Git authority", async () => {
    const f = fixture("success");
    const outside = mkdtempSync(join(tmpdir(), "loom-wave-suite-state-no-git-"));
    roots.push(outside);
    const statePath = join(outside, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(f.manager.load(), null, 2));
    chmodSync(statePath, 0o444);
    const manager = new StateManager(statePath);

    const result = await ensureWaveCompletionSuite({
      handle: f.handle,
      manager,
      graph: manager.load(),
      registration: f.registration,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostic: {
          categories: ["authority"],
          message: expect.stringContaining("TaskGraph repository authority is unavailable"),
        },
      },
    });
    expect(reportCount(f.root)).toBe(0);
    expect(manager.load().active_wave_completion_suite).toBeUndefined();
  });
});
