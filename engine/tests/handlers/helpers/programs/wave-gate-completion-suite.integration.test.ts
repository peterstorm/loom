import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTaskProof } from "../../../../src/core/proof-obligations";
import { freezeVerificationManifest } from "../../../../src/core/verification-manifest";
import { parseNewTestEvidence, type TaskGraph } from "../../../../src/types";

const ENGINE = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(ENGINE, "src/cli.ts");
const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

const proof = (() => {
  const evaluated = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["source.ts"] },
    {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      filesModified: ["source.ts"],
      newTestsWritten: true,
    },
  );
  if (evaluated.state !== "satisfied") throw new Error("proof fixture must be satisfied");
  return evaluated;
})();

function operatorManifest() {
  const parsed = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: "project:sentinel",
      scope: "wave",
      executable: "node",
      args: ["sentinel.mjs"],
      cwd: ".",
      timeoutMs: 5_000,
      report: { kind: "required-file", path: ".loom/completion-reports/sentinel.txt" },
    }],
  })));
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

function repository(options: Readonly<{
  modern: boolean;
  executing?: boolean;
  suiteOutcome?: "accepted" | "nonzero" | "missing-report";
}> = { modern: true }): string {
  const root = canonicalTempDir("loom-wave-facade-suite-");
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  write(root, ".gitignore", ".loom/completion-reports/\n");
  write(root, "source.ts", "export const value = 1;\n");
  write(root, "sentinel.mjs", `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(".claude/state/active_task_graph.json", "utf8"));
if (state.active_wave_completion_suite !== undefined) process.exit(9);
const outcome = ${JSON.stringify(options.suiteOutcome ?? "accepted")};
if (outcome !== "missing-report") {
  mkdirSync(".loom/completion-reports", { recursive: true });
  const path = ".loom/completion-reports/sentinel.txt";
  const count = (() => {
    try {
      return Number(readFileSync(path, "utf8"));
    } catch (cause) {
      if (cause?.code === "ENOENT") return 0;
      throw new Error(\`cannot read Wave Gate sentinel \${path}\`, { cause });
    }
  })();
  writeFileSync(path, String(count + 1));
}
if (outcome === "nonzero") process.exit(7);
`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");

  const graph: TaskGraph = {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [{
      id: "T1",
      description: "facade completion suite",
      agent: "code-implementer-agent",
      wave: 1,
      status: "implemented",
      proof,
      depends_on: [],
      file_list: ["source.ts"],
      files_modified: ["source.ts"],
      test_result: { verdict: "trusted-pass" },
      new_test_observation: parseNewTestEvidence(true, "fixture new-test evidence"),
      review_status: "pending",
      review_generation: 0,
      critical_findings: [],
      advisory_findings: [],
    }],
    ...(options.executing ? { executing_tasks: ["T1"] } : {}),
    wave_gates: {},
    ...(options.modern ? { verification_manifest: operatorManifest() } : {}),
  };
  const statePath = join(root, ".claude/state/active_task_graph.json");
  write(root, ".claude/state/active_task_graph.json", JSON.stringify(graph, null, 2));
  chmodSync(statePath, 0o444);
  mkdirSync(join(root, ".claude/reviews/wave-gate-runs"), { recursive: true });
  return root;
}

function cli(
  root: string,
  args: readonly string[],
  stdin = "",
  cwd = root,
  statePath = join(root, ".claude/state/active_task_graph.json"),
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOOM_STATE_PATH: statePath,
  };
  delete env.PI_CODING_AGENT;
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync("bun", [CLI, "helper", "orchestration", ...args], {
    cwd,
    env,
    input: stdin,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function start(
  root: string,
  runId: string,
  cwd = root,
  runsRoot = join(root, ".claude/reviews/wave-gate-runs"),
  statePath = join(root, ".claude/state/active_task_graph.json"),
) {
  return cli(root, [
    "start", "wave-gate",
    "--runs-root", runsRoot,
    "--run", runId,
  ], JSON.stringify({ wave: 1 }), cwd, statePath);
}

function resume(root: string, runId: string, cwd = root) {
  return cli(root, [
    "resume",
    "--runs-root", join(root, ".claude/reviews/wave-gate-runs"),
    "--run", runId,
  ], "", cwd);
}

function graph(root: string): TaskGraph {
  return JSON.parse(readFileSync(join(root, ".claude/state/active_task_graph.json"), "utf8")) as TaskGraph;
}

function sentinelCount(root: string): number {
  const path = join(root, ".loom/completion-reports/sentinel.txt");
  try {
    return Number(readFileSync(path, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new Error(`cannot read Wave Gate sentinel ${path}`, { cause });
  }
}

function completionResultArtifact(root: string, runId: string): string {
  const suiteRoot = join(
    root,
    ".claude/reviews/wave-gate-runs",
    runId,
    "artifacts/completion-suites",
  );
  const suiteDigest = readdirSync(suiteRoot)[0];
  if (suiteDigest === undefined) throw new Error("completion suite artifact directory is missing");
  const resultFile = readdirSync(join(suiteRoot, suiteDigest))[0];
  if (resultFile === undefined) throw new Error("completion suite result artifact is missing");
  return join(suiteRoot, suiteDigest, resultFile);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Wave Gate façade completion-suite integration", () => {
  it("treats only an absent Wave Gate sentinel as zero", () => {
    const root = canonicalTempDir("loom-wave-facade-counter-");
    roots.push(root);
    expect(sentinelCount(root)).toBe(0);
    const path = join(root, ".loom/completion-reports/sentinel.txt");
    mkdirSync(path, { recursive: true });

    let observed: unknown;
    try {
      sentinelCount(root);
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toBeInstanceOf(Error);
    if (!(observed instanceof Error)) throw new Error("sentinel failure must preserve an Error cause");
    expect(observed.message).toContain(path);
    expect(observed.cause).toMatchObject({ code: "EISDIR" });
  });

  it("does not execute a modern suite while a current-Wave Task is active", () => {
    const root = repository({ modern: true, executing: true });
    const action = start(root, "run.active-task");
    expect(action.kind).toBe("blocked");
    expect(JSON.stringify(action)).toContain("still executing");
    expect(sentinelCount(root)).toBe(0);
    expect(graph(root).active_wave_completion_suite).toBeUndefined();
  });

  it("runs start, resume, and status from outside cwd against the authoritative target repository", () => {
    const root = repository({ modern: true });
    const outside = canonicalTempDir("loom-wave-facade-outside-");
    roots.push(outside);
    const runId = "run.quiescent";
    const action = start(root, runId, outside);
    expect(action, JSON.stringify(action)).toMatchObject({ kind: "spawn-batch" });
    expect(sentinelCount(root)).toBe(1);

    const installed = graph(root).active_wave_completion_suite;
    expect(installed).toBeDefined();
    const artifact = join(
      root,
      ".claude/reviews/wave-gate-runs",
      runId,
      "artifacts/completion-suites",
      installed!.suiteDigest,
      `${installed!.workspaceDigest}.json`,
    );
    expect(existsSync(artifact)).toBe(true);

    expect(resume(root, runId, outside).kind).toBe("spawn-batch");
    expect(cli(root, ["status", "--json"], "", outside)).toMatchObject({
      facts: { waveCompletionSuiteReadiness: { kind: "known", value: { kind: "accepted" } } },
    });
    expect(sentinelCount(root)).toBe(1);
  });

  it.each([
    ["nonzero", "non-zero-exit", 1],
    ["missing-report", "missing-report", 0],
  ] as const)("status exposes persisted %s rejection without rerunning commands", (suiteOutcome, failureKind, expectedCount) => {
    const root = repository({ modern: true, suiteOutcome });
    const runId = `run.status-${suiteOutcome}`;
    const action = start(root, runId);
    expect(action).toMatchObject({
      kind: "blocked",
      diagnostic: { categories: ["semantic"], checkIds: ["project:sentinel"] },
    });
    expect(sentinelCount(root)).toBe(expectedCount);

    const status = cli(root, ["status", "--json"]);
    expect(status).toMatchObject({
      facts: {
        waveCompletionSuiteReadiness: {
          kind: "known",
          value: {
            kind: "rejected",
            failureKinds: [failureKind],
            checkIds: ["project:sentinel"],
          },
        },
      },
    });
    expect(sentinelCount(root)).toBe(expectedCount);
  });

  it.each(["corrupt", "stale"] as const)(
    "reports a %s persisted result as required/unavailable, never semantic rejection",
    (artifactState) => {
      const root = repository({ modern: true, suiteOutcome: "nonzero" });
      const runId = `run.status-${artifactState}`;
      start(root, runId);
      const artifact = completionResultArtifact(root, runId);
      if (artifactState === "corrupt") {
        writeFileSync(artifact, "{broken\n");
      } else {
        const result = JSON.parse(readFileSync(artifact, "utf8")) as Record<string, unknown>;
        writeFileSync(artifact, JSON.stringify({ ...result, authorityDigest: "d".repeat(64) }));
      }

      const status = cli(root, ["status", "--json"]);
      const readiness = (status.facts as {
        waveCompletionSuiteReadiness: { value: Record<string, unknown> };
      }).waveCompletionSuiteReadiness.value;
      expect(readiness.kind).toBe("required");
      expect(readiness.reason).toBe(
        artifactState === "corrupt" ? "completion-result-unavailable" : "completion-result-invalid",
      );
      expect(readiness.kind).not.toBe("rejected");
      expect(sentinelCount(root)).toBe(1);
    },
  );

  it("preserves the legacy façade path without executing or installing a suite", () => {
    const root = repository({ modern: false });
    const action = start(root, "run.legacy");
    expect(action, JSON.stringify(action)).toMatchObject({ kind: "spawn-batch" });
    expect(sentinelCount(root)).toBe(0);
    expect(graph(root).active_wave_completion_suite).toBeUndefined();
  });

  it("status observes accepted and stale target authority from outside cwd without rerunning commands", () => {
    const root = repository({ modern: true });
    const outside = canonicalTempDir("loom-wave-status-outside-");
    roots.push(outside);
    const runId = "run.status-suite";
    start(root, runId, outside);

    const accepted = cli(root, ["status", "--json"], "", outside);
    expect(accepted).toMatchObject({
      facts: { waveCompletionSuiteReadiness: { kind: "known", value: { kind: "accepted" } } },
    });
    expect(sentinelCount(root)).toBe(1);

    write(root, "source.ts", "export const value = 2;\n");
    const stale = cli(root, ["status", "--json"], "", outside);
    expect(stale).toMatchObject({
      facts: { waveCompletionSuiteReadiness: { kind: "known", value: { kind: "stale" } } },
    });
    expect(sentinelCount(root)).toBe(1);
  });

  it("fails closed for a foreign Run Directory repository or a State File outside Git", () => {
    const root = repository({ modern: true });
    const foreign = repository({ modern: true });
    const outside = canonicalTempDir("loom-wave-authority-outside-");
    roots.push(outside);

    const foreignRun = start(
      root,
      "run.foreign-repository",
      outside,
      join(foreign, ".claude/reviews/wave-gate-runs"),
    );
    expect(foreignRun).toMatchObject({
      kind: "blocked",
      diagnostic: { categories: ["authority"], message: expect.stringContaining("differs from protected TaskGraph repository") },
    });
    expect(sentinelCount(root)).toBe(0);
    expect(sentinelCount(foreign)).toBe(0);
    expect(graph(root).active_wave_completion_suite).toBeUndefined();

    const stateOutsideRoot = canonicalTempDir("loom-wave-state-outside-git-");
    roots.push(stateOutsideRoot);
    const stateOutsideGit = join(stateOutsideRoot, "active_task_graph.json");
    writeFileSync(stateOutsideGit, JSON.stringify(graph(foreign), null, 2));
    chmodSync(stateOutsideGit, 0o444);
    const stateOutside = start(
      foreign,
      "run.state-outside-git",
      outside,
      join(foreign, ".claude/reviews/wave-gate-runs"),
      stateOutsideGit,
    );
    expect(stateOutside).toMatchObject({
      kind: "blocked",
      diagnostic: { categories: ["authority"], message: expect.stringContaining("TaskGraph repository authority is unavailable") },
    });
    expect(sentinelCount(foreign)).toBe(0);
    const protectedOutside = JSON.parse(readFileSync(stateOutsideGit, "utf8")) as TaskGraph;
    expect(protectedOutside.active_wave_completion_suite).toBeUndefined();
  });
});
