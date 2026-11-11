/**
 * A Distill Task attempt through the real shells (ADR-0068 §5, §9), in real
 * temporary Git repositories: registration snapshots the scope under the
 * attempt's ref and refuses when it cannot; the persisted settlement, the
 * Claude Code stop transport and the Pi result transport restore a pass that
 * could not prove itself and discard the snapshot only after the settlement
 * is persisted; and Proof reconcile leaves a Distill Task exactly as it is.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DistillSnapshotPort } from "../../src/core/distill-snapshot";
import { distillSnapshotRef } from "../../src/core/distill-task";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import {
  productionExactSettlementPorts,
  settleAndPersistExactImplementation,
  type ExactImplementationSettlement,
  type ExactSettlementStatePort,
} from "../../src/handlers/helpers/exact-implementation-settlement";
import reconcileImplementationProof, {
  reconcileTaskFromStoredEvidence,
} from "../../src/handlers/helpers/reconcile-implementation-proof";
import { runUpdateTaskStatus } from "../../src/handlers/subagent-stop/update-task-status";
import { registerTaskExecutionBatch, rollbackTaskExecutionRegistration } from "../../src/handlers/task-execution";
import type { ImplementationAuthorityObservation } from "../../src/implementation-attempt-sidecar";
import { gitDistillSnapshots } from "../../src/orchestration/distill-snapshot";
import { CONFORMANCE_NOT_OWED } from "../../src/core/skeleton/conformance-verdict";
import { StateManager } from "../../src/state-manager";
import { parseNewTestEvidence, type Task, type TaskGraph, type TaskTestResult } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  behaviourPreservedBasis as basisOf,
  distillSnapshotRefs,
  REFUSING_DISTILL_SNAPSHOTS,
  settlementFacts,
} from "../fixtures/distill-settlement";
import { git, gitResult, write } from "../fixtures/git-repository";
import { slot } from "../fixtures/pi-reserved-slot";
import { applyImplementationPiResult } from "../../../pi/subagent-result";
import { graphFixture, protectedGraphFixture, siblingTaskFixture, taskFixture } from "../fixtures/task-lifecycle";

const roots: string[] = [];
const ENVIRONMENT = ["LOOM_STATE_PATH", "CLAUDE_PROJECT_DIR", "LOOM_SUBAGENT_DIR"] as const;
const previous = new Map(ENVIRONMENT.map((name) => [name, process.env[name]] as const));

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SCOPE = ["src/a.ts", "src/b.ts"] as const;
const STATE = ".loom-state/active_task_graph.json";
const NOT_STALE = { kind: "at-registration", anyActiveForGraph: false } as const;

type Repo = Readonly<{ root: string; statePath: string }>;

const sibling = (id: string, file: string): Task => siblingTaskFixture({ id, status: "implemented", file_list: [file] });

const distillTask = (scope: readonly string[] = SCOPE): Task => taskFixture({
  id: "T3", description: "Distill pass for Wave 1", agent: DISTILL_AGENT, wave: 1, depends_on: [], file_list: [...scope],
});

/** A committed repository whose Wave 1 is implemented but for its Distill Task `T3`. */
function repository(tasks: readonly Task[] = [sibling("T1", "src/a.ts"), sibling("T2", "src/b.ts"), distillTask()]): Repo {
  const root = canonicalTempDir("loom-distill-registration-");
  roots.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "loom@example.test"]);
  git(root, ["config", "user.name", "Loom Test"]);
  write(root, ".gitignore", ".loom-state/\nsubagents/\n");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 2;\n");
  write(root, "docs/notes.md", "notes\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "wave 1 implemented"]);
  const statePath = join(root, STATE);
  mkdirSync(join(root, ".loom-state"));
  writeFileSync(statePath, JSON.stringify(graphFixture(tasks), null, 2));
  process.env.LOOM_STATE_PATH = statePath;
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  return { root, statePath };
}

const manager = (repo: Repo): StateManager => {
  const found = StateManager.fromPath(repo.statePath);
  if (found === null) throw new Error("fixture: no State File");
  return found;
};
const taskOf = (repo: Repo, id = "T3"): Task => {
  const task = manager(repo).load().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`fixture: no Task ${id}`);
  return task;
};
const read = (repo: Repo, path: string): string => readFileSync(join(repo.root, path), "utf-8");
const stdout = (repo: Repo, args: readonly string[]): string => gitResult(repo.root, args).stdout.trim();
const distillRefs = (repo: Repo): readonly string[] => distillSnapshotRefs(repo.root);

/** The spawn the engine owes `T3` now: its marker and the appendices its dispatch carries. */
function spawnOf(repo: Repo) {
  const derivation = deriveTaskImplementationDispatch(taskOf(repo));
  if (derivation.kind !== "dispatch") throw new Error(`fixture: T3 is owed no dispatch (${derivation.kind})`);
  const appendix = derivation.dispatch.promptAppendix;
  return {
    kind: "implementation" as const,
    prompt: appendix === null ? "Task ID: T3" : `Task ID: T3\n${appendix}`,
    description: "T3 distill pass",
  };
}

async function register(repo: Repo, snapshots?: DistillSnapshotPort): Promise<ImplementationAttemptAuthority> {
  const outcome = await registerTaskExecutionBatch([spawnOf(repo)], "parallel", NOT_STALE, repo.root, snapshots);
  if (outcome.kind !== "registered") throw new Error(`registration refused: ${outcome.message}`);
  const authority = outcome.authorities[0];
  if (authority === undefined) throw new Error("fixture: registration issued no authority");
  return authority;
}

type SettleOptions = Readonly<{
  taskCompleted?: boolean;
  /** The State File the settlement commits to; the repository's own by default. */
  stateFile?: ExactSettlementStatePort;
  /** The snapshot store; Git's by default. */
  snapshots?: DistillSnapshotPort;
}>;

/** Settle and persist through the one entry point both transports use, with production ports. */
function settle(
  repo: Repo,
  authority: ImplementationAttemptAuthority,
  testResult: TaskTestResult,
  modified: readonly string[],
  { taskCompleted = true, stateFile = manager(repo), snapshots }: SettleOptions = {},
): Promise<ExactImplementationSettlement> {
  return settleAndPersistExactImplementation(
    stateFile,
    settlementFacts(authority, testResult, modified, { taskCompleted }),
    productionExactSettlementPorts(repo.root, repo.statePath),
    snapshots,
  );
}

/** What the repository held the moment a settlement's commit had landed: its snapshot refs, and `T3` as stored. */
type CommitObservation = Readonly<{ refs: readonly string[]; task: Task }>;

/** The repository's State File, observing the repository each time one of its commits has landed. */
function observedStateFile(repo: Repo): Readonly<{ stateFile: ExactSettlementStatePort; commits: readonly CommitObservation[] }> {
  const commits: CommitObservation[] = [];
  return {
    commits,
    stateFile: {
      updateAndReturn: async (mutate) => {
        const committed = await manager(repo).updateAndReturn(mutate);
        commits.push({ refs: distillRefs(repo), task: taskOf(repo) });
        return committed;
      },
    },
  };
}

/** A State File whose lock runs the settlement and whose write then never lands; `lost` holds each state it dropped. */
function crashingStateFile(repo: Repo): Readonly<{ stateFile: ExactSettlementStatePort; lost: readonly TaskGraph[] }> {
  const lost: TaskGraph[] = [];
  return {
    lost,
    stateFile: {
      updateAndReturn: async (mutate) => {
        lost.push(mutate(manager(repo).load()).state);
        throw new Error("fixture: crashed before the State File write");
      },
    },
  };
}

describe("registering a Distill Task attempt", () => {
  it("snapshots the scope as a tree under the attempt's ref, and writes no skeleton", async () => {
    const repo = repository();

    const authority = await register(repo);

    const ref = distillSnapshotRef(authority.authorityDigest);
    expect(distillRefs(repo)).toEqual([ref]);
    expect(stdout(repo, ["cat-file", "-t", ref])).toBe("tree");
    expect(stdout(repo, ["ls-tree", "-r", "--name-only", ref]).split("\n")).toEqual([...SCOPE]);
    expect(stdout(repo, ["cat-file", "blob", `${ref}:src/a.ts`])).toBe("export const a = 1;");
    const task = taskOf(repo);
    expect(task.active_implementation_attempt?.authorityDigest).toBe(authority.authorityDigest);
    expect(task.attempt_artifact_baseline?.map(({ artifact }) => artifact)).toEqual([...SCOPE]);
    expect(task.skeleton_outcomes).toBeUndefined();
    expect(stdout(repo, ["status", "--porcelain"])).toBe("");
  });

  it("snapshots a missing scope path as absent, and registers", async () => {
    const repo = repository([sibling("T1", "src/a.ts"), sibling("T2", "src/b.ts"), distillTask(["src/a.ts", "src/gone.ts"])]);

    const authority = await register(repo);

    expect(stdout(repo, ["ls-tree", "-r", "--name-only", distillSnapshotRef(authority.authorityDigest)])).toBe("src/a.ts");
    expect(existsSync(join(repo.root, "src/gone.ts"))).toBe(false);
  });

  it("refuses the registration when the snapshot cannot be taken, reserving nothing", async () => {
    const repo = repository();
    const before = readFileSync(repo.statePath, "utf-8");
    const failing: DistillSnapshotPort = {
      ...gitDistillSnapshots,
      capture: () => ({ ok: false, error: { kind: "git-failed", command: "write-tree", detail: "exited 128: fatal: unable to write tree" } }),
    };

    const outcome = await registerTaskExecutionBatch([spawnOf(repo)], "parallel", NOT_STALE, repo.root, failing);

    expect(outcome).toMatchObject({ kind: "block" });
    if (outcome.kind !== "block") return;
    expect(outcome.message).toContain("Cannot snapshot the distill scope of T3: git write-tree exited 128");
    expect(readFileSync(repo.statePath, "utf-8")).toBe(before);
    expect(taskOf(repo).active_implementation_attempt).toBeUndefined();
    expect(manager(repo).load().executing_tasks ?? []).toEqual([]);
    expect(distillRefs(repo)).toEqual([]);
  });

  it("leaves a registration of no Distill Task alone: the snapshot store is never called", async () => {
    const pending = taskFixture({ id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: ["src/a.ts"] });
    const repo = repository([pending]);

    const outcome = await registerTaskExecutionBatch(
      [{ kind: "implementation", prompt: "Task ID: T1", description: "" }], "parallel", NOT_STALE, repo.root, REFUSING_DISTILL_SNAPSHOTS,
    );

    expect(outcome.kind).toBe("registered");
    expect(distillRefs(repo)).toEqual([]);
  });

  it("discards the snapshot of a registration that is rolled back", async () => {
    const repo = repository();
    const authority = await register(repo);
    expect(distillRefs(repo)).toHaveLength(1);

    await expect(rollbackTaskExecutionRegistration([authority], repo.root)).resolves.toEqual({ kind: "allow" });

    expect(distillRefs(repo)).toEqual([]);
    expect(taskOf(repo).active_implementation_attempt).toBeUndefined();
  });

  it("rolls back and names the snapshot it left behind when the repository cannot be resolved", async () => {
    const repo = repository();
    const authority = await register(repo);
    const ref = distillSnapshotRef(authority.authorityDigest);
    // The rollback resolves its State File from LOOM_STATE_PATH and its repository from here: no repository.
    const elsewhere = canonicalTempDir("loom-distill-no-repository-");
    roots.push(elsewhere);
    process.env.CLAUDE_PROJECT_DIR = elsewhere;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(rollbackTaskExecutionRegistration([authority])).resolves.toEqual({ kind: "allow" });

    expect(taskOf(repo).active_implementation_attempt).toBeUndefined();
    expect(distillRefs(repo)).toEqual([ref]);
    const notes = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("distill snapshot note"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${ref} left in place for rolled-back T3: cannot resolve repository root and HEAD from ${elsewhere}`);
  });

  it("writes no snapshot note when the rolled-back Task is no Distill Task, whatever the repository", async () => {
    const pending = taskFixture({ id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: ["src/a.ts"] });
    const repo = repository([pending]);
    const outcome = await registerTaskExecutionBatch(
      [{ kind: "implementation", prompt: "Task ID: T1", description: "" }], "parallel", NOT_STALE, repo.root, REFUSING_DISTILL_SNAPSHOTS,
    );
    if (outcome.kind !== "registered") throw new Error(`registration refused: ${outcome.message}`);
    const elsewhere = canonicalTempDir("loom-distill-no-repository-");
    roots.push(elsewhere);
    process.env.CLAUDE_PROJECT_DIR = elsewhere;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(rollbackTaskExecutionRegistration(outcome.authorities, undefined, REFUSING_DISTILL_SNAPSHOTS)).resolves.toEqual({ kind: "allow" });

    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("distill snapshot note"))).toEqual([]);
  });
});

describe("settling a registered Distill Task attempt with the real snapshot store", () => {
  it("restores a pass whose tests fail, persists the restored basis, and only then discards the snapshot", async () => {
    const repo = repository();
    const authority = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");
    rmSync(join(repo.root, "src/b.ts"));
    const { stateFile, commits } = observedStateFile(repo);

    const settled = await settle(repo, authority, { verdict: "trusted-fail" }, [...SCOPE], { stateFile });

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(read(repo, "src/a.ts")).toBe("export const a = 1;\n");
    expect(read(repo, "src/b.ts")).toBe("export const b = 2;\n");
    expect(stdout(repo, ["status", "--porcelain"])).toBe("");
    // The State File on disk loads, and its Proof says what happened.
    const task = protectedGraphFixture(JSON.parse(readFileSync(repo.statePath, "utf-8"))).tasks.find(({ id }) => id === "T3");
    expect(task).toMatchObject({ status: "implemented" });
    expect(task === undefined ? undefined : basisOf(task)).toEqual({ kind: "restored", after: ["proof:regression-tests-failed"] });
    // The snapshot was still there once the settled state was on disk, and is gone now.
    expect(commits).toEqual([
      { refs: [distillSnapshotRef(authority.authorityDigest)], task: expect.objectContaining({ status: "implemented" }) },
    ]);
    expect(distillRefs(repo)).toEqual([]);
  });

  it("keeps a pass its tests prove, on the tests-passed basis", async () => {
    const repo = repository();
    const authority = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");

    const settled = await settle(repo, authority, { verdict: "trusted-pass" }, ["src/a.ts"]);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(read(repo, "src/a.ts")).toBe("export const a = 1 as number;\n");
    expect(basisOf(taskOf(repo))).toEqual({ kind: "tests-passed", provenance: "evidence-ledger" });
    expect(distillRefs(repo)).toEqual([]);
  });

  it("settles a pass that changed nothing on the unchanged basis", async () => {
    const repo = repository();
    const authority = await register(repo);

    const settled = await settle(repo, authority, { verdict: "trusted-pass" }, []);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(basisOf(taskOf(repo))).toEqual({ kind: "unchanged" });
  });

  it("keeps the snapshot when the settled state never lands, and the re-run settles the same Task state", async () => {
    const repo = repository();
    const authority = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");
    const before = readFileSync(repo.statePath, "utf-8");
    const { stateFile, lost } = crashingStateFile(repo);

    // The crash: the settlement restored the bytes, and the State File write never landed.
    await expect(settle(repo, authority, { verdict: "trusted-fail" }, ["src/a.ts"], { stateFile }))
      .rejects.toThrow("crashed before the State File write");

    expect(readFileSync(repo.statePath, "utf-8")).toBe(before);
    expect(read(repo, "src/a.ts")).toBe("export const a = 1;\n");
    expect(distillRefs(repo)).toEqual([distillSnapshotRef(authority.authorityDigest)]);

    const rerun = await settle(repo, authority, { verdict: "trusted-fail" }, ["src/a.ts"]);

    expect(rerun.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(read(repo, "src/a.ts")).toBe("export const a = 1;\n");
    const lostTask = lost[0]?.tasks.find(({ id }) => id === "T3");
    const rerunTask = taskOf(repo);
    expect(lostTask).toMatchObject({ status: "implemented" });
    expect(rerunTask).toMatchObject({ status: "implemented", files_modified: lostTask?.files_modified });
    // The one difference: the bytes already equal the baseline, so the re-run records `unchanged`.
    expect(lostTask === undefined ? undefined : basisOf(lostTask)).toEqual({ kind: "restored", after: ["proof:regression-tests-failed"] });
    expect(basisOf(rerunTask)).toEqual({ kind: "unchanged" });
    expect(distillRefs(repo)).toEqual([]);
  });

  it("restores the scope and retries the attempt for a write outside it; a snapshot whose release was lost is dropped by the retry's registration", async () => {
    const repo = repository();
    const first = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");
    writeFileSync(join(repo.root, "docs/notes.md"), "rewritten by the distiller\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const losingTheRelease: DistillSnapshotPort = {
      ...gitDistillSnapshots,
      discard: () => ({ ok: false, error: { kind: "git-failed", command: "update-ref", detail: "exited 128: fatal: cannot lock ref" } }),
    };

    const settled = await settle(
      repo, first, { verdict: "trusted-pass" }, ["src/a.ts", "docs/notes.md"], { snapshots: losingTheRelease },
    );

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "retry-required" } });
    expect(read(repo, "src/a.ts")).toBe("export const a = 1;\n");
    expect(read(repo, "docs/notes.md")).toBe("rewritten by the distiller\n");
    expect(basisOf(taskOf(repo))).toMatchObject({ kind: "restored" });
    // The settlement stands and says what it could not let go of.
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)))
      .toContain("[loom] distill snapshot note: git update-ref exited 128: fatal: cannot lock ref\n");
    expect(distillRefs(repo)).toEqual([distillSnapshotRef(first.authorityDigest)]);
    git(repo.root, ["checkout", "--", "docs/notes.md"]);

    const second = await register(repo);

    expect(second.authorityDigest).not.toBe(first.authorityDigest);
    expect(distillRefs(repo)).toEqual([distillSnapshotRef(second.authorityDigest)]);
  });

  it("keeps the snapshot of an attempt that settled infrastructure-blocked, across its next registration", async () => {
    const repo = repository();
    const first = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");
    const unrestorable: DistillSnapshotPort = {
      ...gitDistillSnapshots,
      restore: () => ({ ok: false, error: { kind: "scope-path-failed", path: "src/a.ts", detail: "EACCES: permission denied" } }),
    };

    const blocked = await settle(repo, first, { verdict: "trusted-fail" }, ["src/a.ts"], { snapshots: unrestorable });

    expect(blocked.application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });
    expect(blocked.infrastructureReason).toContain("src/a.ts: EACCES: permission denied");
    expect(read(repo, "src/a.ts")).toBe("export const a = 1 as number;\n");
    expect(taskOf(repo)).toMatchObject({ status: "pending" });
    // The bytes the attempt started from are still held, for the operator to restore by hand.
    expect(distillRefs(repo)).toEqual([distillSnapshotRef(first.authorityDigest)]);
    expect(stdout(repo, ["cat-file", "blob", `${distillSnapshotRef(first.authorityDigest)}:src/a.ts`])).toBe("export const a = 1;");
    git(repo.root, ["checkout", "--", "src/a.ts"]);

    const second = await register(repo);

    expect([...distillRefs(repo)].sort()).toEqual(
      [distillSnapshotRef(first.authorityDigest), distillSnapshotRef(second.authorityDigest)].sort(),
    );
  });
});

describe("the Claude Code stop transport", () => {
  /** Arm a registered attempt and return its stop, with an empty evidence epoch: no trusted test run. */
  async function armed(label: string) {
    const repo = repository();
    const authority = await register(repo);
    const sessionId = `claude-distill-${label}-${process.pid}-${Date.now()}`;
    // The session's TaskGraph pointer, where `repository` pointed LOOM_SUBAGENT_DIR.
    const subagents = join(repo.root, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, `${sessionId}.task_graph`), repo.statePath);
    const transcript = join(repo.root, ".loom-state", "transcript.jsonl");
    const observation: ImplementationAuthorityObservation = {
      kind: "authority-observed",
      sidecar: {
        schemaVersion: 1, kind: "claude-implementation-attempt-sidecar",
        sessionId: sessionId as never, agentId: "agent-9" as never,
        canonicalTaskGraphPath: repo.statePath, authority,
      },
    };
    const stop = (written: readonly string[]) => {
      const report = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "**Task ID:** T3\n\nDistill pass done." }] } };
      const writes = written.map((path, index) => ({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${index}`, name: "Write", input: { file_path: join(repo.root, path) } }] },
      }));
      writeFileSync(transcript, [...writes, report].map((record) => JSON.stringify(record)).join("\n") + "\n");
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      return runUpdateTaskStatus(JSON.stringify({
        session_id: sessionId, agent_id: "agent-9", agent_type: DISTILL_AGENT, agent_transcript_path: transcript,
      }), [], { kind: "snapshot", events: [] }, observation);
    };
    return { repo, authority, stop };
  }

  it("restores an unproven pass, settles it implemented, and discards the snapshot once the state is persisted", async () => {
    const { repo, authority, stop } = await armed("restored");
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");

    const result = await stop(["src/a.ts"]);

    expect(result).toEqual({ kind: "passthrough" });
    expect(read(repo, "src/a.ts")).toBe("export const a = 1;\n");
    const task = taskOf(repo);
    expect(task).toMatchObject({ status: "implemented" });
    expect(basisOf(task)).toMatchObject({ kind: "restored" });
    expect(task.implementation_attempt_history).toEqual([
      expect.objectContaining({ authorityDigest: authority.authorityDigest, transition: "implemented" }),
    ]);
    expect(distillRefs(repo)).toEqual([]);
  }, 30_000);

  it("settles an untouched scope implemented with no test run, and discards the snapshot", async () => {
    const { repo, stop } = await armed("unchanged");

    const result = await stop([]);

    expect(result).toEqual({ kind: "passthrough" });
    expect(basisOf(taskOf(repo))).toEqual({ kind: "unchanged" });
    expect(distillRefs(repo)).toEqual([]);
  }, 30_000);
});

describe("the Pi result transport", () => {
  /** Deliver `T3`'s Pi result for a registered attempt, under an empty evidence epoch: no trusted test run. */
  async function delivered(messagesOf: (repo: Repo) => unknown) {
    const repo = repository();
    const authority = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");
    const outcome = await applyImplementationPiResult({
      store: manager(repo),
      repository: { root: () => repo.root, isRepo: () => true },
      authoritativeStatePath: repo.statePath,
      agentType: DISTILL_AGENT,
      result: { agent: DISTILL_AGENT, task: "Task ID: T3", exitCode: 0, messages: messagesOf(repo) },
      reservedSlot: slot({ agentType: DISTILL_AGENT, taskId: "T3", implementationAuthority: authority }),
      parentPrompt: "",
      ledger: { kind: "read", events: [] },
    });
    return { repo, authority, outcome };
  }

  it("restores an unproven pass, settles it implemented, and discards the snapshot once the state is persisted", async () => {
    const { repo, authority } = await delivered((at) => [
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: join(at.root, "src/a.ts") } }] },
      { role: "assistant", content: [{ type: "text", text: "**Task ID:** T3\n\nDistill pass done." }] },
    ]);

    expect(read(repo, "src/a.ts")).toBe("export const a = 1;\n");
    const task = taskOf(repo);
    expect(task).toMatchObject({ status: "implemented" });
    expect(basisOf(task)).toMatchObject({ kind: "restored" });
    expect(task.implementation_attempt_history).toEqual([
      expect.objectContaining({ authorityDigest: authority.authorityDigest, transition: "implemented" }),
    ]);
    expect(distillRefs(repo)).toEqual([]);
  });

  it("keeps the snapshot of a result it settles as infrastructure, with the pass still on disk", async () => {
    // No transcript to read: the attempt is infrastructure-blocked before any scope is judged.
    const { repo, authority, outcome } = await delivered(() => null);

    expect(outcome.processingErrors.join("\n")).toContain("Pi transcript evidence capture failed");
    expect(taskOf(repo).implementation_attempt_history).toEqual([
      expect.objectContaining({ authorityDigest: authority.authorityDigest, transition: "infrastructure-blocked" }),
    ]);
    expect(read(repo, "src/a.ts")).toBe("export const a = 1 as number;\n");
    expect(distillRefs(repo)).toEqual([distillSnapshotRef(authority.authorityDigest)]);
  });
});

describe("Proof reconcile and a Distill Task", () => {
  it("returns a Distill Task unchanged whatever evidence it is handed", () => {
    const undispatched = distillTask();
    const reconciled = reconcileTaskFromStoredEvidence(
      undispatched, [...SCOPE], parseNewTestEvidence(true, "2 new test methods"), true, undefined, CONFORMANCE_NOT_OWED,
    );
    expect(reconciled).toBe(undispatched);
  });

  it("does not throw for a Wave whose Distill Task is undispatched, and leaves it byte for byte", async () => {
    const repo = repository();
    const before = taskOf(repo);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await reconcileImplementationProof("", ["--wave", "1"]);

    // The pass is still owed, so the Wave is honestly reported as unproven.
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("still has 1 task(s) with unsatisfied implementation proof") });
    expect(taskOf(repo)).toEqual(before);
    expect(before.proof?.state).toBe("pending");
  });

  it("does not flip the Proof of a Distill Task settled on the restored basis, even after its scope moved on", async () => {
    const repo = repository();
    const authority = await register(repo);
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 1 as number;\n");
    // Unproven AND never completed: the scope is restored and the Proof still
    // fails (`task-not-completed`), so reconcile would re-evaluate any other Task here.
    await settle(repo, authority, { verdict: "trusted-fail" }, ["src/a.ts"], { taskCompleted: false });
    const settledTask = taskOf(repo);
    expect(settledTask).toMatchObject({ status: "pending", proof: { state: "failed" } });
    expect(basisOf(settledTask)).toEqual({
      kind: "restored",
      after: ["proof:regression-tests-failed", "proof:task-not-completed"],
    });
    // The scope's bytes now differ from every baseline the Task ever held.
    writeFileSync(join(repo.root, "src/a.ts"), "export const a = 100;\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reconcileImplementationProof("", ["--wave", "1"]);

    expect(taskOf(repo)).toEqual(settledTask);
  });
});
