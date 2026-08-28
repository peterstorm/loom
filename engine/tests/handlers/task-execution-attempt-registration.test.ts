import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerTaskExecutionBatch,
} from "../../src/handlers/task-execution";
import {
  createTaskExecutionAuthorityBatch,
  rollbackTaskExecutionAuthorityBatch,
} from "../../src/core/validate-task-execution";
import { evaluateTaskProof, TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import {
  productionExactSettlementPorts,
  settleExactImplementation,
} from "../../src/handlers/helpers/exact-implementation-settlement";
import { StateManager } from "../../src/state-manager";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import { taskFixture } from "../fixtures/task-lifecycle";
import type { TaskGraph } from "../../src/types";

const roots: string[] = [];
const previousState = process.env.LOOM_STATE_PATH;
const previousProject = process.env.CLAUDE_PROJECT_DIR;
const previousSubagents = process.env.LOOM_SUBAGENT_DIR;

function repository(): Readonly<{ root: string; statePath: string; headSha: string }> {
  const root = mkdtempSync(join(tmpdir(), "loom-attempt-registration-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
  writeFileSync(join(root, "seed.txt"), "seed\n");
  writeFileSync(join(root, ".gitignore"), ".loom-state/\n");
  execFileSync("git", ["add", "seed.txt", ".gitignore"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root });
  mkdirSync(join(root, ".loom-state"));
  const statePath = join(root, ".loom-state", "active_task_graph.json");
  process.env.LOOM_STATE_PATH = statePath;
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  return {
    root,
    statePath,
    headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
}

function graph(tasks = [
  taskFixture({ id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["src/a.ts"] }),
  taskFixture({ id: "T2", description: "two", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["src/b.ts"] }),
]): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    tasks,
    wave_gates: {},
  };
}

const spawn = (taskId: string) => ({
  kind: "implementation" as const,
  prompt: `Task ID: ${taskId}`,
  description: "",
});

function writeGraph(path: string, state: TaskGraph): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

afterEach(() => {
  if (previousState === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousState;
  if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProject;
  if (previousSubagents === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = previousSubagents;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("modern implementation attempt registration", () => {
  it("atomically returns ordered cryptographically unique authorities in baseline lockstep", async () => {
    const repo = repository();
    writeGraph(repo.statePath, graph());

    const result = await registerTaskExecutionBatch([spawn("T2"), spawn("T1")]);
    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.authorities.map(({ taskId }) => taskId)).toEqual(["T2", "T1"]);
    expect(new Set(result.authorities.map(({ reservationId }) => reservationId)).size).toBe(2);
    for (const authority of result.authorities) {
      expect(authority.reservationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(authority.semanticAttempt).toBe(1);
      expect(authority.headSha).toBe(repo.headSha);
      expect(authority.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    const stored = JSON.parse(readFileSync(repo.statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual(["T2", "T1"]);
    for (const authority of result.authorities) {
      const task = stored.tasks.find(({ id }) => id === authority.taskId)!;
      expect(task.active_implementation_attempt).toEqual(authority);
      expect(task.reserved_at).toBe(authority.reservedAt);
      expect(task.legacy_execution_reservation).toBeUndefined();
      expect(task.attempt_artifact_baseline).toBeDefined();
      expect(task.attempt_repository_baseline).toBeDefined();
    }
  });

  it("binds a fresh attempt to the first unresolved repository baseline instead of laundering persistent foreign bytes", async () => {
    const repo = repository();
    writeFileSync(join(repo.root, "foreign.ts"), "foreign write from failed attempt\n");
    const task = taskFixture({
      id: "T1",
      description: "retry after foreign write",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      file_list: ["src/a.ts"],
      repository_baseline: [],
      unresolved_repository_paths: ["foreign.ts"],
    });
    writeGraph(repo.statePath, graph([task]));

    const result = await registerTaskExecutionBatch([spawn("T1")]);

    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    const stored = JSON.parse(readFileSync(repo.statePath, "utf8")) as TaskGraph;
    expect(stored.tasks[0]?.repository_baseline).toEqual([]);
    expect(stored.tasks[0]?.attempt_repository_baseline).toEqual([]);
    expect(stored.tasks[0]?.unresolved_repository_paths).toEqual(["foreign.ts"]);
  });

  it("keeps an unreported unowned delta non-positive while a parallel sibling-owned dirty path stays inert", async () => {
    const repo = repository();
    const task = taskFixture({
      id: "T1",
      description: "foreign-write carry",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      file_list: ["src/a.ts"],
      new_tests_required: false,
    });
    const sibling = taskFixture({
      id: "T2",
      description: "parallel sibling owner",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      file_list: ["sibling.ts"],
    });
    writeGraph(repo.statePath, graph([task, sibling]));
    const manager = StateManager.fromPath(repo.statePath);
    if (manager === null) throw new Error("state fixture missing");
    const settle = async (
      authority: ImplementationAttemptAuthority,
      parserModifiedPaths: readonly string[],
      observedAt: string,
      taskCompleted = true,
    ) => manager.update((state) => settleExactImplementation(state, {
      transport: "Pi",
      authority,
      observedAt: observedAt as never,
      parserModifiedPaths,
      parserPathLabel: "integration result paths",
      taskCompleted,
      testResult: { verdict: "trusted-pass" },
      testEvidence: "focused integration pass",
      proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    }, productionExactSettlementPorts(repo.root)).application.state);

    const first = await registerTaskExecutionBatch([spawn("T1")]);
    if (first.kind !== "registered") throw new Error(first.message);
    const retainedBaseline = manager.load().tasks[0]?.repository_baseline;
    mkdirSync(join(repo.root, "src"), { recursive: true });
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo.root, "foreign.ts"), "foreign\n");
    writeFileSync(join(repo.root, "sibling.ts"), "parallel T2 bytes\n");
    await settle(first.authorities[0]!, ["src/a.ts"], "2026-08-25T00:01:00.000Z", false);
    expect(manager.load().tasks[0]).toMatchObject({
      status: "pending",
      repository_baseline: retainedBaseline,
      unresolved_repository_paths: ["foreign.ts"],
    });

    const second = await registerTaskExecutionBatch([spawn("T1")]);
    if (second.kind !== "registered") throw new Error(second.message);
    await settle(second.authorities[0]!, [], "2026-08-25T00:02:00.000Z");
    expect(manager.load().tasks[0]).toMatchObject({
      status: "pending",
      unresolved_repository_paths: ["foreign.ts"],
    });
    expect(manager.load().tasks[0]?.files_modified).not.toContain("sibling.ts");

    rmSync(join(repo.root, "foreign.ts"));
    const third = await registerTaskExecutionBatch([spawn("T1")]);
    if (third.kind !== "registered") throw new Error(third.message);
    await settle(third.authorities[0]!, [], "2026-08-25T00:03:00.000Z");
    expect(manager.load().tasks[0]).toMatchObject({ status: "implemented" });
    expect(manager.load().tasks[0]?.repository_baseline).toBeUndefined();
    expect(readFileSync(join(repo.root, "sibling.ts"), "utf8")).toBe("parallel T2 bytes\n");
  });

  it("writes no TaskGraph bytes when any sibling makes the batch invalid", async () => {
    const repo = repository();
    const state = graph([
      taskFixture({ id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["src/shared.ts"] }),
      taskFixture({ id: "T2", description: "two", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["src/shared.ts"] }),
    ]);
    writeGraph(repo.statePath, state);
    const before = readFileSync(repo.statePath);

    const result = await registerTaskExecutionBatch([spawn("T1"), spawn("T2")]);
    expect(result).toMatchObject({ kind: "block" });
    expect(readFileSync(repo.statePath)).toEqual(before);
  });

  it("reclaims and archives only the exact stale authority before installing its replacement", async () => {
    const repo = repository();
    const baseline = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
    const reservedAt = parseIsoInstant("2020-01-01T00:00:00.000Z");
    const reservationId = parseReservationId("old-reservation");
    if (!reservedAt.ok || !reservationId.ok) throw new Error("fixture parse failed");
    const old = createImplementationAttemptAuthority({
      taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
      headSha: repo.headSha, reservedAt: reservedAt.value,
      taskScopeBaseline: baseline, dirtySetBaseline: [],
    });
    if (!old.ok) throw new Error(old.error.errors.join("; "));
    const task = taskFixture({
      id: "T1", description: "one", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], file_list: ["src/a.ts"],
      active_implementation_attempt: old.value,
      attempt_artifact_baseline: baseline,
      attempt_repository_baseline: [],
      reserved_at: old.value.reservedAt,
      review_status: "passed",
      review_generation: 2,
      test_result: { verdict: "trusted-pass" },
      test_evidence: "trusted unchanged baseline",
    });
    writeGraph(repo.statePath, { ...graph([task]), executing_tasks: ["T1"] });

    const result = await registerTaskExecutionBatch([spawn("T1")]);
    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.authorities[0]?.authorityDigest).not.toBe(old.value.authorityDigest);
    const stored = JSON.parse(readFileSync(repo.statePath, "utf8")) as TaskGraph;
    const updated = stored.tasks[0]!;
    expect(updated.active_implementation_attempt).toEqual(result.authorities[0]);
    expect(updated).toMatchObject({
      review_status: "passed",
      review_generation: 2,
      test_result: { verdict: "trusted-pass" },
      test_evidence: "trusted unchanged baseline",
    });
    expect(updated.implementation_attempt_history).toEqual([
      expect.objectContaining({
        authorityDigest: old.value.authorityDigest,
        reservationId: old.value.reservationId,
        transition: "infrastructure-blocked",
        consumesSemanticAttempt: false,
        failureKinds: ["reservation-reclaimed"],
      }),
    ]);
  });

  it("invalidates passed authority when an abandoned modern attempt changed declared bytes", async () => {
    const repo = repository();
    const baseline = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
    const reservedAt = parseIsoInstant("2020-01-01T00:00:00.000Z");
    const reservationId = parseReservationId("stale-reviewed-attempt");
    if (!reservedAt.ok || !reservationId.ok) throw new Error("fixture parse failed");
    const old = createImplementationAttemptAuthority({
      taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
      headSha: repo.headSha, reservedAt: reservedAt.value,
      taskScopeBaseline: baseline, dirtySetBaseline: [],
    });
    if (!old.ok) throw new Error(old.error.errors.join("; "));
    const proof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: ["src/a.ts"] },
      {
        taskCompleted: true,
        testResult: { verdict: "trusted-pass" },
        filesModified: ["src/a.ts"],
        newTestsWritten: false,
        newTestEvidence: "verification waived",
      },
    );
    if (proof.state !== "satisfied") throw new Error("fixture proof must be satisfied");
    const reviewed = taskFixture({
      id: "T1", description: "reviewed before stale write", agent: "code-implementer-agent", wave: 1,
      status: "implemented", proof, depends_on: [], file_list: ["src/a.ts"], new_tests_required: false,
      active_implementation_attempt: old.value,
      attempt_artifact_baseline: baseline,
      attempt_repository_baseline: [],
      artifact_baseline: baseline,
      repository_baseline: [],
      reserved_at: old.value.reservedAt,
      review_status: "passed",
      review_generation: 4,
      test_result: { verdict: "trusted-pass" },
      test_evidence: "trusted pre-abandonment result",
      new_test_observation: { kind: "not-written", written: false, evidence: "verification waived" },
    });
    writeGraph(repo.statePath, {
      ...graph([reviewed]),
      executing_tasks: ["T1"],
      spec_check: {
        wave: 1,
        run_at: "2020-01-01T00:01:00.000Z",
        verdict: "PASSED",
        critical_count: 0,
        high_count: 0,
        critical_findings: [],
        high_findings: [],
        medium_findings: [],
      },
      wave_gates: {
        "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
      },
    });

    mkdirSync(join(repo.root, "src"), { recursive: true });
    writeFileSync(join(repo.root, "src/a.ts"), "export const staleWrite = true;\n");

    const result = await registerTaskExecutionBatch([spawn("T1")]);
    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    const stored = JSON.parse(readFileSync(repo.statePath, "utf8")) as TaskGraph;
    expect(stored.tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
      review_status: "pending",
      review_generation: 5,
      failure_reason: "infrastructure-blocked: reservation-reclaimed",
    });
    expect(stored.tasks[0]).not.toHaveProperty("test_result");
    expect(stored.tasks[0]).not.toHaveProperty("test_evidence");
    expect(stored.tasks[0]).not.toHaveProperty("new_test_observation");
    expect(stored.spec_check).toBeUndefined();
    expect(stored.wave_gates["1"]).toMatchObject({
      impl_complete: false,
      tests_passed: null,
      reviews_complete: false,
      blocked: false,
    });
    expect(stored.tasks[0]?.implementation_attempt_history).toContainEqual(expect.objectContaining({
      authorityDigest: old.value.authorityDigest,
      failureKinds: ["reservation-reclaimed"],
    }));
  });

  it("an exact rollback cannot clear a late replacement for the same Task", () => {
    const state = graph([taskFixture({ id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["src/a.ts"] })]);
    const baseline = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
    const instant = parseIsoInstant("2026-01-01T00:00:00.000Z");
    const oldId = parseReservationId("old");
    const newId = parseReservationId("new");
    if (!instant.ok || !oldId.ok || !newId.ok) throw new Error("fixture parse failed");
    const oldBatch = createTaskExecutionAuthorityBatch(state, ["T1"], [oldId.value], "1".repeat(40), instant.value,
      new Map([["T1", { proof: baseline, attempt: baseline, repositoryAttempt: [] }]]));
    const newBatch = createTaskExecutionAuthorityBatch(state, ["T1"], [newId.value], "1".repeat(40), instant.value,
      new Map([["T1", { proof: baseline, attempt: baseline, repositoryAttempt: [] }]]));
    if (!oldBatch.ok || !newBatch.ok) throw new Error("authority fixture failed");
    const current: TaskGraph = {
      ...state,
      executing_tasks: ["T1"],
      tasks: [{
        ...state.tasks[0]!,
        active_implementation_attempt: newBatch.plans[0]!.authority,
        attempt_artifact_baseline: baseline,
        attempt_repository_baseline: [],
        reserved_at: instant.value,
      }],
    };
    const rolledBack = rollbackTaskExecutionAuthorityBatch(
      current,
      [oldBatch.plans[0]!.authority],
      instant.value,
    );
    expect(rolledBack).toBe(current);
    expect(rolledBack.executing_tasks).toEqual(["T1"]);
    expect(rolledBack.tasks[0]?.active_implementation_attempt).toEqual(newBatch.plans[0]!.authority);
  });
});
