/**
 * A failed distill pass is restored, not retried (ADR-0068 §5): the shared
 * settlement shell settles a Distill Task attempt once as a trial, writes the
 * attempt's snapshot back when the pure decision says so, and settles again
 * on the restored bytes; persisted through `settleAndPersistExactImplementation`
 * it commits that settlement and only then lets the snapshot go. Ports are
 * in-memory: a fake worktree the byte observation reads, a fake snapshot
 * store, and a fake State File.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DECLARED_ARTIFACT_BASELINE, type ArtifactBaseline } from "../../../src/core/artifact-baseline";
import { sha256Bytes } from "../../../src/core/digest";
import type { DistillSnapshotFailure, DistillSnapshotPort } from "../../../src/core/distill-snapshot";
import { distillSnapshotRef } from "../../../src/core/distill-task";
import {
  buildTaskLocalByteObservation,
  NO_ENGINE_SKELETONS,
  parseNewTestEvidence,
} from "../../../src/core/implementation-application";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  type ImplementationAttemptAuthority,
} from "../../../src/core/implementation-completion";
import { authorizeImplementationSpawn, createImplementationAttemptContext } from "../../../src/core/implementation-retry";
import { DISTILL_AGENT } from "../../../src/core/model-profiles";
import {
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ProofEvaluationPolicy,
} from "../../../src/core/proof-obligations";
import {
  settleAndPersistExactImplementation,
  settleExactImplementation,
  type ExactImplementationSettlement,
  type ExactImplementationSettlementPorts,
  type ExactImplementationTransportFacts,
  type ExactSettlementStatePort,
} from "../../../src/handlers/helpers/exact-implementation-settlement";
import { parseTaskGraph } from "../../../src/state-manager";
import type { Task, TaskGraph, TaskTestResult } from "../../../src/types";
import {
  behaviourPreservedBasis as behaviourPreserved,
  REFUSING_DISTILL_SNAPSHOTS,
  settlementFacts,
} from "../../fixtures/distill-settlement";
import { value } from "../../fixtures/parse-result";
import { protectedGraphFixture, siblingTaskFixture, taskFixture } from "../../fixtures/task-lifecycle";

const ROOT = "/fixture";
const SCOPE = ["src/a.ts", "src/b.ts"] as const;
const OUTSIDE = "docs/notes.md";

type Files = ReadonlyMap<string, string>;

const START: Files = new Map([["src/a.ts", "a v1\n"], ["src/b.ts", "b v1\n"], [OUTSIDE, "notes v1\n"]]);

const baselineOf = (files: Files, artifacts: readonly string[]): ArtifactBaseline<"declared-artifact"> => {
  const captured = DECLARED_ARTIFACT_BASELINE.capture(artifacts, (artifact) => {
    const contents = files.get(artifact);
    return contents === undefined ? { kind: "missing" } : { kind: "sha256", digest: sha256Bytes(Buffer.from(contents, "utf-8")) };
  }, "fixture baseline");
  if (!captured.ok) throw new Error(captured.errors.join("; "));
  return captured.value;
};

const ATTEMPT_BASELINE = baselineOf(START, SCOPE);

function authorityFor(taskId: string, reservationId: string, baseline = ATTEMPT_BASELINE): ImplementationAttemptAuthority {
  const parsed = createImplementationAttemptAuthority({
    taskId,
    wave: 1,
    semanticAttempt: 1,
    reservationId,
    headSha: "a".repeat(40),
    reservedAt: "2026-11-11T00:00:00.000Z",
    taskScopeBaseline: baseline,
    dirtySetBaseline: [],
  });
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

const sibling = (id: string, file: string): Task => siblingTaskFixture({ id, status: "implemented", file_list: [file] });

/** A Wave whose siblings are implemented and whose Task `T3` holds `attempt`. */
function graphWith(attempt: ImplementationAttemptAuthority, agent: string): TaskGraph {
  const admission = authorizeImplementationSpawn({ id: "T3" }, "Task ID: T3");
  if (!admission.ok) throw new Error(admission.error);
  const reserved = taskFixture({
    id: "T3",
    description: "the Wave's third Task",
    agent,
    wave: 1,
    status: "pending",
    depends_on: [],
    file_list: [...SCOPE],
    ...(agent === DISTILL_AGENT ? {} : { new_tests_required: false }),
    active_implementation_attempt: attempt,
    artifact_baseline: ATTEMPT_BASELINE,
    attempt_artifact_baseline: ATTEMPT_BASELINE,
    attempt_repository_baseline: [],
    reserved_at: attempt.reservedAt,
    // As registration stamps a modern attempt, so the Task loads before and after it settles.
    active_implementation_context: createImplementationAttemptContext({ authority: attempt, prompt: "Task ID: T3", admission }),
    implementation_retry_protocol: 2,
    implementation_retry_history_start: 0,
  });
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T3"],
    // A non-Distill `T3` owns the scope itself, so it has no sibling there.
    tasks: agent === DISTILL_AGENT ? [sibling("T1", "src/a.ts"), sibling("T2", "src/b.ts"), reserved] : [reserved],
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  };
}

const TRUSTED_PASS: TaskTestResult = { verdict: "trusted-pass" };
const TRUSTED_FAIL: TaskTestResult = { verdict: "trusted-fail" };
/** A pass the ledger does not vouch for: what "no trusted run after the last edit" settles as. */
const NO_TRUSTED_RUN: TaskTestResult = {
  verdict: "untrusted",
  passed: true,
  label: "no trusted run after the last write",
  provenance: "unverified",
};

const OBSERVED_AT = value(parseIsoInstant("2026-11-11T00:01:00.000Z", "fixture settlement instant"));

/** The settlement facts of `attempt`, observed at one fixed instant so equal inputs settle to equal values. */
const factsFor = (
  attempt: ImplementationAttemptAuthority,
  testResult: TaskTestResult,
  parserModifiedPaths: readonly string[],
  proofEvaluationPolicy: ProofEvaluationPolicy = TRUSTED_LEDGER_ONLY_POLICY,
): ExactImplementationTransportFacts =>
  settlementFacts(attempt, testResult, parserModifiedPaths, { observedAt: OBSERVED_AT, proofEvaluationPolicy });

/** The fake worktree, its settlement ports, and the fake snapshot store over it. */
type World = Readonly<{
  files: Map<string, string>;
  ports: ExactImplementationSettlementPorts;
  snapshots: DistillSnapshotPort;
  calls: string[];
  stored: Map<string, Files>;
  observations: () => number;
}>;

type WorldOptions = Readonly<{
  restoreFailure?: DistillSnapshotFailure;
  /** A restore that reports success and writes nothing back. */
  restoreWritesNothing?: boolean;
}>;

function world(attempt: ImplementationAttemptAuthority, options: WorldOptions = {}): World {
  const files = new Map(START);
  const stored = new Map<string, Files>([[attempt.authorityDigest, new Map(START)]]);
  const calls: string[] = [];
  let observations = 0;
  const changedSinceStart = (): readonly string[] =>
    [...new Set([...START.keys(), ...files.keys()])].filter((path) => START.get(path) !== files.get(path));
  const ports: ExactImplementationSettlementPorts = {
    repository: {
      root: ROOT,
      authoritativeStatePath: `${ROOT}/.claude/state/active_task_graph.json`,
      observeTaskLocal: (args) => {
        observations += 1;
        return buildTaskLocalByteObservation({
          authority: attempt,
          attemptBaseline: ATTEMPT_BASELINE,
          currentAttemptScope: baselineOf(files, SCOPE),
          proofBaseline: ATTEMPT_BASELINE,
          currentProofScope: baselineOf(files, SCOPE),
          parserModifiedPaths: args.parserModifiedPaths,
          priorAttributedPaths: [],
          repositoryChangedPaths: changedSinceStart(),
          siblingOwnedPaths: args.siblingOwnedPaths,
          engineSkeletons: NO_ENGINE_SKELETONS,
        });
      },
    },
    newTests: { collect: () => ({ ok: true, value: parseNewTestEvidence(false, "verification waived") }) },
  };
  const snapshots: DistillSnapshotPort = {
    capture: (_root, digest) => {
      calls.push(`capture ${digest}`);
      stored.set(digest, new Map(files));
      return { ok: true, value: { ref: distillSnapshotRef(digest) } };
    },
    restore: (root, digest, scope) => {
      calls.push(`restore ${root} ${digest} ${scope.join(",")}`);
      if (options.restoreFailure !== undefined) return { ok: false, error: options.restoreFailure };
      const snapshot = stored.get(digest);
      if (snapshot === undefined) return { ok: false, error: { kind: "no-snapshot", ref: distillSnapshotRef(digest) } };
      if (options.restoreWritesNothing !== true) {
        for (const path of scope) {
          const contents = snapshot.get(path);
          if (contents === undefined) files.delete(path);
          else files.set(path, contents);
        }
      }
      return { ok: true, value: { ref: distillSnapshotRef(digest) } };
    },
    discard: (_root, digest) => {
      calls.push(`discard ${digest}`);
      stored.delete(digest);
      return { ok: true, value: { ref: distillSnapshotRef(digest) } };
    },
  };
  return { files, ports, snapshots, calls, stored, observations: () => observations };
}

const settledTask = (settled: ExactImplementationSettlement): Task => {
  const task = settled.application.state.tasks.find(({ id }) => id === "T3");
  if (task === undefined) throw new Error("fixture: T3 missing after settlement");
  return task;
};

const restores = ({ calls }: World): readonly string[] => calls.filter((call) => call.startsWith("restore"));

describe("a Distill Task attempt that changed nothing", () => {
  it("settles implemented on the unchanged basis, observing once and never touching the snapshot", () => {
    const attempt = authorityFor("T3", "distill-unchanged");
    const w = world(attempt);

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_PASS, []), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "unchanged" });
    expect(w.calls).toEqual([]);
    expect(w.observations()).toBe(1);
  });

  it("is still implemented with no trusted test run: changing nothing owes no tests", () => {
    const attempt = authorityFor("T3", "distill-unchanged-no-tests");
    const w = world(attempt);

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, NO_TRUSTED_RUN, []), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "unchanged" });
    expect(restores(w)).toEqual([]);
  });
});

describe("a Distill Task attempt that changed its scope and proved it", () => {
  it("settles implemented on the tests-passed basis and keeps the bytes", () => {
    const attempt = authorityFor("T3", "distill-proven");
    const w = world(attempt);
    w.files.set("src/a.ts", "a distilled\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_PASS, ["src/a.ts"]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "tests-passed", provenance: "evidence-ledger" });
    expect(w.files.get("src/a.ts")).toBe("a distilled\n");
    expect(restores(w)).toEqual([]);
    expect(w.observations()).toBe(1);
  });

  it("counts a write no tool call reported: the raw byte delta is what is judged", () => {
    const attempt = authorityFor("T3", "distill-unreported");
    const w = world(attempt);
    w.files.set("src/b.ts", "b rewritten by a shell command\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_FAIL, []), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "restored", after: ["proof:regression-tests-failed"] });
    expect(w.files.get("src/b.ts")).toBe("b v1\n");
  });
});

describe("a Distill Task attempt that changed its scope and could not prove it", () => {
  it.each([
    ["failing tests", TRUSTED_FAIL, "proof:regression-tests-failed"],
    ["no trusted run after the last write", NO_TRUSTED_RUN, "proof:untrusted-regression-pass"],
  ] as const)("is restored after %s and settles implemented on the restored basis", (_label, testResult, reason) => {
    const attempt = authorityFor("T3", `distill-restored-${reason}`);
    const w = world(attempt);
    w.files.set("src/a.ts", "a distilled\n");
    w.files.delete("src/b.ts");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, testResult, ["src/a.ts", "src/b.ts"]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented", receipt: { transition: "implemented", failureKinds: [] } } });
    expect(settled).not.toHaveProperty("infrastructureReason");
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "restored", after: [reason] });
    expect(Object.fromEntries(w.files)).toEqual(Object.fromEntries(START));
    expect(restores(w)).toEqual([`restore ${ROOT} ${attempt.authorityDigest} src/a.ts,src/b.ts`]);
    expect(w.observations()).toBe(2);
  });

  it("stores a Proof the State File reads back with the restored basis and its reasons", () => {
    const attempt = authorityFor("T3", "distill-restored-round-trip");
    const w = world(attempt);
    w.files.set("src/a.ts", "a distilled\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_FAIL, ["src/a.ts"]), w.ports, w.snapshots);
    const reloaded = protectedGraphFixture(JSON.parse(JSON.stringify(settled.application.state)));

    const task = reloaded.tasks.find(({ id }) => id === "T3");
    expect(task).toMatchObject({ status: "implemented", files_modified: [], test_result: TRUSTED_FAIL });
    expect(task?.active_implementation_attempt).toBeUndefined();
    expect(task === undefined ? undefined : behaviourPreserved(task)).toEqual({ kind: "restored", after: ["proof:regression-tests-failed"] });
    expect(task?.implementation_attempt_history).toEqual([
      expect.objectContaining({ authorityDigest: attempt.authorityDigest, transition: "implemented", failureKinds: [] }),
    ]);
  });

  it("restores the scope and still fails the attempt for a write outside it", () => {
    const attempt = authorityFor("T3", "distill-out-of-scope");
    const w = world(attempt);
    w.files.set("src/a.ts", "a distilled\n");
    w.files.set(OUTSIDE, "notes rewritten by the distiller\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_PASS, ["src/a.ts"]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({
      kind: "applied",
      transition: { kind: "retry-required", receipt: { failureKinds: ["task-byte-scope-violation"] } },
    });
    expect(w.files.get("src/a.ts")).toBe("a v1\n");
    // The engine holds no bytes for a path outside the scope: it is not restored.
    expect(w.files.get(OUTSIDE)).toBe("notes rewritten by the distiller\n");
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "restored", after: ["task-byte-scope-violation"] });
    expect(settledTask(settled)).toMatchObject({ status: "pending", retry_count: 1 });
  });

  it("does not restore for a write outside the scope alone: the scope is as the snapshot holds it", () => {
    const attempt = authorityFor("T3", "distill-only-out-of-scope");
    const w = world(attempt);
    w.files.set(OUTSIDE, "notes rewritten by the distiller\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_PASS, []), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "retry-required" } });
    expect(behaviourPreserved(settledTask(settled))).toEqual({ kind: "unchanged" });
    expect(restores(w)).toEqual([]);
  });
});

describe("a restore that does not put the scope back is infrastructure", () => {
  it("blocks on a failed restore, never a semantic failure, and names the snapshot it kept", () => {
    const attempt = authorityFor("T3", "distill-restore-failed");
    const w = world(attempt, { restoreFailure: { kind: "scope-path-failed", path: "src/a.ts", detail: "EACCES: permission denied" } });
    w.files.set("src/a.ts", "a distilled\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_FAIL, ["src/a.ts"]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({
      kind: "applied",
      transition: { kind: "infrastructure-blocked", receipt: { transition: "infrastructure-blocked", consumesSemanticAttempt: false } },
    });
    expect(settled.infrastructureReason).toContain("distill restore of T3 failed: src/a.ts: EACCES: permission denied");
    expect(settled.infrastructureReason).toContain(distillSnapshotRef(attempt.authorityDigest));
    expect(settled.infrastructureReason).toContain("proof:regression-tests-failed");
    expect(settledTask(settled)).toMatchObject({ status: "pending", revalidation_required: true });
    expect(settledTask(settled).retry_count).toBeUndefined();
  });

  it("blocks when no snapshot exists, without claiming one was kept", () => {
    const attempt = authorityFor("T3", "distill-no-snapshot");
    const w = world(attempt);
    w.stored.clear();
    w.files.set("src/a.ts", "a distilled\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_FAIL, ["src/a.ts"]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });
    expect(settled.infrastructureReason).toContain("no distill snapshot is stored under");
    expect(settled.infrastructureReason).not.toContain("are kept as the Git tree");
  });

  it("blocks when the re-observation still shows a scope path differing from the attempt baseline", () => {
    const attempt = authorityFor("T3", "distill-restore-incomplete");
    const w = world(attempt, { restoreWritesNothing: true });
    w.files.set("src/a.ts", "a distilled\n");

    const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_FAIL, ["src/a.ts"]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });
    expect(settled.infrastructureReason).toContain("left src/a.ts differing from the attempt baseline");
    expect(w.observations()).toBe(2);
  });
});

const COMMIT = "commit";

/**
 * An in-memory State File over `initial`. A commit is recorded in `calls`,
 * beside the snapshot store's own calls, so their order can be read. With
 * `commitFails` the settlement runs and its state is then refused.
 */
function stateFileOver(initial: TaskGraph, calls: string[], commitFails = false): ExactSettlementStatePort & { current: () => TaskGraph } {
  let current = initial;
  return {
    current: () => current,
    updateAndReturn: async (mutate) => {
      const produced = mutate(value(parseTaskGraph(current)));
      if (commitFails) throw new Error("fixture: the State File write did not land");
      current = produced.state;
      calls.push(COMMIT);
      return produced.value;
    },
  };
}

describe("persisting a settlement and releasing its snapshot", () => {
  /** A Distill Task attempt over `edit`ed files, settled and persisted through the seam. */
  const persist = async (
    label: string,
    testResult: TaskTestResult,
    edit: (files: Map<string, string>) => void,
    options: WorldOptions & Readonly<{ commitFails?: boolean }> = {},
  ) => {
    const attempt = authorityFor("T3", `distill-persist-${label}`);
    const w = world(attempt, options);
    edit(w.files);
    const stateFile = stateFileOver(graphWith(attempt, DISTILL_AGENT), w.calls, options.commitFails);
    const settling = settleAndPersistExactImplementation(stateFile, factsFor(attempt, testResult, ["src/a.ts"]), w.ports, w.snapshots);
    return { attempt, w, stateFile, settling };
  };
  const distilled = (files: Map<string, string>) => files.set("src/a.ts", "a distilled\n");
  const discard = (attempt: ImplementationAttemptAuthority): string => `discard ${attempt.authorityDigest}`;

  it("never discards inside the settlement itself: nothing is persisted yet", () => {
    const attempt = authorityFor("T3", "distill-trial-only");
    const w = world(attempt);
    distilled(w.files);

    settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, TRUSTED_FAIL, ["src/a.ts"]), w.ports, w.snapshots);

    expect(w.stored.has(attempt.authorityDigest)).toBe(true);
    expect(restores(w)).toHaveLength(1);
  });

  it("restores, commits the settled state, and only then discards the snapshot", async () => {
    const { attempt, w, stateFile, settling } = await persist("restored", TRUSTED_FAIL, distilled);

    const settled = await settling;

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(w.calls).toEqual([`restore ${ROOT} ${attempt.authorityDigest} src/a.ts,src/b.ts`, COMMIT, discard(attempt)]);
    expect(stateFile.current()).toBe(settled.application.state);
    expect(w.stored.has(attempt.authorityDigest)).toBe(false);
  });

  it("discards after an implemented settlement and after a semantic failure, each after its commit", async () => {
    const implemented = await persist("implemented", TRUSTED_PASS, distilled);
    expect((await implemented.settling).application).toMatchObject({ transition: { kind: "implemented" } });
    expect(implemented.w.calls).toEqual([COMMIT, discard(implemented.attempt)]);

    const failed = await persist("retry", TRUSTED_PASS, (files) => files.set(OUTSIDE, "out of scope\n"));
    expect((await failed.settling).application).toMatchObject({ transition: { kind: "retry-required" } });
    expect(failed.w.calls).toEqual([COMMIT, discard(failed.attempt)]);
  });

  it("releases nothing when the commit is rejected: a re-run still has the snapshot to restore from", async () => {
    const { attempt, w, stateFile, settling } = await persist("commit-lost", TRUSTED_FAIL, distilled, { commitFails: true });
    const before = stateFile.current();

    await expect(settling).rejects.toThrow("the State File write did not land");

    expect(w.calls).toEqual([`restore ${ROOT} ${attempt.authorityDigest} src/a.ts,src/b.ts`]);
    expect(w.stored.has(attempt.authorityDigest)).toBe(true);
    expect(stateFile.current()).toBe(before);
  });

  it("keeps the snapshot of an attempt that settled infrastructure-blocked", async () => {
    const { attempt, w, settling } = await persist("blocked", TRUSTED_FAIL, distilled, {
      restoreFailure: { kind: "scope-path-failed", path: "src/a.ts", detail: "EACCES: permission denied" },
    });

    expect((await settling).application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });

    expect(w.calls).toEqual([`restore ${ROOT} ${attempt.authorityDigest} src/a.ts,src/b.ts`, COMMIT]);
    expect(w.stored.has(attempt.authorityDigest)).toBe(true);
  });

  it("keeps the snapshot of a result the settlement ignored", async () => {
    const attempt = authorityFor("T3", "distill-late");
    const replacement = authorityFor("T3", "distill-replacement");
    const w = world(attempt);
    const stateFile = stateFileOver(graphWith(replacement, DISTILL_AGENT), w.calls);

    const ignored = await settleAndPersistExactImplementation(stateFile, factsFor(attempt, TRUSTED_PASS, []), w.ports, w.snapshots);

    expect(ignored.application).toMatchObject({ kind: "ignored" });
    expect(w.calls).toEqual([COMMIT]);
  });

  it("never asks the store about a Task that is no Distill Task", async () => {
    const attempt = authorityFor("T3", "implementer-release");
    const w = world(attempt);
    w.files.set("src/a.ts", "a implemented\n");
    w.files.set("src/b.ts", "b implemented\n");
    const stateFile = stateFileOver(graphWith(attempt, "code-implementer-agent"), w.calls);

    const settled = await settleAndPersistExactImplementation(stateFile, factsFor(attempt, TRUSTED_PASS, [...SCOPE]), w.ports, w.snapshots);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(w.calls).toEqual([COMMIT]);
  });

  it("property: the snapshot goes exactly when a semantic settlement was committed, and never before the commit", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<TaskTestResult>(TRUSTED_PASS, TRUSTED_FAIL, NO_TRUSTED_RUN),
      fc.constantFrom("keep", "edit", "delete"),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      async (testResult, scopeEdit, outside, restoreFails, commitFails) => {
        const { attempt, w, settling } = await persist("property", testResult, (files) => {
          if (scopeEdit === "edit") files.set("src/a.ts", "a distilled\n");
          if (scopeEdit === "delete") files.delete("src/a.ts");
          if (outside) files.set(OUTSIDE, "out of scope\n");
        }, {
          commitFails,
          ...(restoreFails ? { restoreFailure: { kind: "git-failed", command: "cat-file", detail: "exited 128" } } : {}),
        });

        const settled = await settling.catch(() => null);

        const discarded = w.calls.includes(discard(attempt));
        const semantic = settled?.application.kind === "applied" && settled.application.transition.kind !== "infrastructure-blocked";
        expect(discarded).toBe(semantic);
        expect(w.stored.has(attempt.authorityDigest)).toBe(!semantic);
        if (discarded) expect(w.calls.indexOf(COMMIT)).toBeLessThan(w.calls.indexOf(discard(attempt)));
        if (commitFails) expect(settled).toBeNull();
      },
    ), { numRuns: 80 });
  });
});

describe("a Task that is no Distill Task is never restored", () => {
  const editArb = fc.record({
    a: fc.constantFrom("keep", "edit", "delete"),
    b: fc.constantFrom("keep", "edit", "delete"),
    outside: fc.boolean(),
  });
  const testResultArb = fc.constantFrom<TaskTestResult>(TRUSTED_PASS, TRUSTED_FAIL, NO_TRUSTED_RUN);
  const policyArb = fc.constantFrom(TRUSTED_LEDGER_ONLY_POLICY, PI_STRUCTURED_EVIDENCE_POLICY);

  const apply = (files: Map<string, string>, path: string, edit: string): void => {
    if (edit === "edit") files.set(path, `${path} rewritten\n`);
    if (edit === "delete") files.delete(path);
  };

  it("property: one observation, one settlement, bytes untouched, the snapshot store never called", () => {
    fc.assert(fc.property(editArb, testResultArb, policyArb, (edits, testResult, policy) => {
      const attempt = authorityFor("T3", "implementer-property");
      const w = world(attempt);
      apply(w.files, "src/a.ts", edits.a);
      apply(w.files, "src/b.ts", edits.b);
      if (edits.outside) w.files.set(OUTSIDE, "out of scope\n");
      const after = [...w.files];
      const state = graphWith(attempt, "code-implementer-agent");
      const facts = factsFor(attempt, testResult, [...SCOPE], policy);

      const settled = settleExactImplementation(state, facts, w.ports, w.snapshots);

      expect(w.calls).toEqual([]);
      expect(w.observations()).toBe(1);
      expect([...w.files]).toEqual(after);
      // The same facts settle to the same value with no snapshot store at all
      // to consult: the result is the single settlement, nothing more.
      expect(settleExactImplementation(state, facts, w.ports, REFUSING_DISTILL_SNAPSHOTS)).toEqual(settled);
    }), { numRuns: 60 });
  });

  it("property: a Distill Task over the same edits is restored exactly when its trial fails and the scope changed", () => {
    fc.assert(fc.property(editArb, testResultArb, (edits, testResult) => {
      const attempt = authorityFor("T3", "distill-property");
      const w = world(attempt);
      apply(w.files, "src/a.ts", edits.a);
      apply(w.files, "src/b.ts", edits.b);
      if (edits.outside) w.files.set(OUTSIDE, "out of scope\n");
      const scopeChanged = edits.a !== "keep" || edits.b !== "keep";
      const wouldFail = edits.outside || (scopeChanged && testResult !== TRUSTED_PASS);

      const settled = settleExactImplementation(graphWith(attempt, DISTILL_AGENT), factsFor(attempt, testResult, []), w.ports, w.snapshots);

      expect(restores(w).length).toBe(scopeChanged && wouldFail ? 1 : 0);
      expect(settled.application.kind).toBe("applied");
      if (settled.application.kind !== "applied") return;
      expect(settled.application.transition.kind).toBe(edits.outside ? "retry-required" : "implemented");
      if (scopeChanged && wouldFail) {
        expect(w.files.get("src/a.ts")).toBe(START.get("src/a.ts"));
        expect(w.files.get("src/b.ts")).toBe(START.get("src/b.ts"));
        expect(behaviourPreserved(settledTask(settled))).toMatchObject({ kind: "restored" });
      }
    }), { numRuns: 80 });
  });
});
