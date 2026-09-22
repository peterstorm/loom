import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { createRunDirectory } from "../../../src/orchestration/run-directory-handle";
import {
  handleWaveReviewContext,
  installWaveReviewRuns,
  waveRequests,
  waveSpecCheckScope,
} from "../../../src/handlers/helpers/programs/wave-gate";
import type { RegisteredWaveGateProgram } from "../../../src/handlers/helpers/programs/helpers";
import type { TaskGraph, WaveReviewEpochAuthority } from "../../../src/types";
import { parseTaskGraph, StateManager } from "../../../src/state-manager";
import { taskFixture } from "../../fixtures/task-lifecycle";
import { WAVE_REVIEW_AGENTS } from "../../../src/core/model-profiles";
import { CURRENT_REVIEWER_PROTOCOL } from "../../../src/core/reviewer-contract";
import {
  decideWaveReviewEpochReplay,
  prepareWaveReviewBatch,
  type WaveRequestBatch,
} from "../../../src/core/wave-review-authority";
import { parseSettledFloor, type SettledFloor } from "../../../src/core/requirement-coverage";
import { observeWaveSpecCheckDocuments } from "../../../src/orchestration/wave-spec-check-documents";
import { projectSpecBytes } from "../../../src/orchestration/spec-index-observation";
import {
  parseArtifactDigest,
  parseOrchestrationRunId,
  parseRequestId,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type OrchestrationRunId,
} from "../../../src/core/orchestration-contract";
import { buildContextPacket, encodeByteSection } from "../../../src/core/context-packets";
import { capturedSpecCheck } from "../../../src/core/spec-check";

const DIGEST = (fill: string): ArtifactDigest => {
  const parsed = parseArtifactDigest(fill.repeat(64));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const decodeRequestId = (raw: string) => {
  const parsed = parseRequestId(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

const projectRootForDocuments = (specFile: string | null, planFile: string | null): string => {
  const document = specFile ?? planFile;
  return document === null ? process.cwd() : dirname(document);
};

const observeDocuments = (
  specFile: string | null,
  planFile: string | null,
  projectRoot = projectRootForDocuments(specFile, planFile),
) => observeWaveSpecCheckDocuments({ specFile, planFile, projectRoot });

describe("registered Wave spec-check scope", () => {
  it("defensively freezes arbitrary trace and file arrays", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 1000 }).map((n) => `FR-${n}`), { maxLength: 8 }),
      fc.uniqueArray(fc.integer({ min: 1, max: 1000 }).map((n) => `src/file-${n}.ts`), { maxLength: 8 }),
      (anchors, files) => {
        const sourceAnchors = [...anchors];
        const sourceFiles = [...files];
        const scope = waveSpecCheckScope([taskFixture({
          id: "T1", description: "scope", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], spec_anchors: sourceAnchors,
          spec_contributions: [], file_list: sourceFiles,
        })]);
        sourceAnchors.push("FR-MUTATED");
        sourceFiles.push("src/mutated.ts");
        expect(scope[0]?.completionAnchors).toEqual(anchors);
        expect(scope[0]?.declaredFiles).toEqual(files);
        expect(Object.isFrozen(scope[0]?.completionAnchors)).toBe(true);
      },
    ));
  });

  it("freezes the exact current-Wave roster, completion claims, contributions, and declared files", () => {
    const runsRoot = canonicalTempDir("loom-wave-spec-scope-");
    cleanup.push(runsRoot);
    const created = createRunDirectory(runsRoot, "run.scope");
    if (!created.ok) throw new Error(created.error.message);

    const completionAnchors = ["FR-1"];
    const contributions = ["FR-1"];
    const declaredFiles = ["src/contribution.ts"];
    const graph: TaskGraph = {
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      wave_gates: {},
      tasks: [
        taskFixture({
          id: "T1", description: "partial implementation", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], spec_anchors: [], spec_contributions: contributions,
          file_list: declaredFiles,
        }),
        taskFixture({
          id: "T2", description: "culminating implementation", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], spec_anchors: completionAnchors, spec_contributions: [],
          file_list: ["src/completion.ts"],
        }),
      ],
    };
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1", "T2"],
      authorityDigest: "a".repeat(64),
    };
    const parsedGraph = parseTaskGraph(graph);
    expect(parsedGraph.ok).toBe(true);
    if (!parsedGraph.ok) return;
    const batch = waveRequests(created.value, registration, parsedGraph.value, 1, process.cwd());
    const specRequest = batch.requests.find(({ authority }) =>
      (authority as AgentRequestAuthority).role === "spec-check-invoker");
    expect(specRequest).toBeDefined();
    const authority = specRequest!.authority as AgentRequestAuthority;
    const context = handleWaveReviewContext(batch.packets, authority.contextDigest);
    expect(context.kind).toBe("loaded");
    if (context.kind !== "loaded" || context.value.subject.role !== "spec-check-invoker") return;
    const scope = context.value.specCheckScope;
    expect(scope).not.toBeNull();
    if (scope === null) return;
    expect(scope).toEqual([
      {
        id: "T1",
        description: "partial implementation",
        completionAnchors: [],
        contributions: ["FR-1"],
        declaredFiles: ["src/contribution.ts"],
        modifiedFiles: [],
      },
      {
        id: "T2",
        description: "culminating implementation",
        completionAnchors: ["FR-1"],
        contributions: [],
        declaredFiles: ["src/completion.ts"],
        modifiedFiles: [],
      },
    ]);

    completionAnchors.push("FR-MUTATED");
    contributions.push("FR-MUTATED");
    declaredFiles.push("src/mutated.ts");
    expect(scope[0]?.contributions).toEqual(["FR-1"]);
    expect(scope[0]?.declaredFiles).toEqual(["src/contribution.ts"]);
    expect(scope[1]?.completionAnchors).toEqual(["FR-1"]);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("installs the exact pure preparation roster, contexts, epoch, and reviewer slots", async () => {
    const root = canonicalTempDir("loom-wave-authority-install-");
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot);
    const created = createRunDirectory(runsRoot, "run.authority-install");
    if (!created.ok) throw new Error(created.error.message);
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1"],
      authorityDigest: "a".repeat(64),
    };
    const parsed = parseTaskGraph({
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1,
        kind: "active-wave-gate",
        runId: created.value.runId,
        wave: 1,
        authorityDigest: registration.authorityDigest,
        revision: 0,
        terminalOutcome: null,
      },
      tasks: [taskFixture({
        id: "T1",
        description: "review exact authority",
        agent: "code-implementer-agent",
        wave: 1,
        status: "implemented",
        depends_on: [],
        review_generation: 3,
        spec_anchors: ["FR-1"],
        spec_contributions: [],
        file_list: ["engine/src/core/wave-review-authority.ts"],
      })],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const statePath = join(root, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(parsed.value));
    const manager = new StateManager(statePath);

    const batch = waveRequests(created.value, registration, parsed.value, 1, root);
    const authorities = batch.requests.map(({ authority }) => authority as AgentRequestAuthority);
    expect(authorities.map(({ role }) => role)).toEqual([
      "spec-check-invoker",
      ...WAVE_REVIEW_AGENTS,
    ]);
    expect(authorities.map(({ modelProfile }) => modelProfile)).toEqual([
      "general-review",
      "general-review",
      "focused-review",
      "focused-review",
      "focused-review",
      "focused-review",
    ]);
    for (const authority of authorities) {
      const context = handleWaveReviewContext(batch.packets, authority.contextDigest);
      expect(context.kind).toBe("loaded");
      if (context.kind !== "loaded") continue;
      expect(context.value.runId).toBe(created.value.runId);
      expect(context.value.batchEpoch).toBe(batch.batchEpoch);
      expect(context.value.subject.role).toBe(authority.role);
      expect(context.value.taskRun?.taskId ?? null).toBe(
        authority.role === "spec-check-invoker" ? null : "T1",
      );
    }

    const staleAuthorityPath = join(root, "stale_active_task_graph.json");
    writeFileSync(staleAuthorityPath, JSON.stringify({
      ...parsed.value,
      active_wave_gate: { ...parsed.value.active_wave_gate!, authorityDigest: "b".repeat(64) },
    }));
    await expect(installWaveReviewRuns(new StateManager(staleAuthorityPath), registration, batch))
      .rejects.toThrow("exact active Wave Gate authority");

    const staleContextPath = join(root, "stale_packet_context_task_graph.json");
    writeFileSync(staleContextPath, JSON.stringify({
      ...parsed.value,
      tasks: parsed.value.tasks.map((task) => ({
        ...task,
        test_result: { verdict: "trusted-pass" },
      })),
    }));
    await expect(installWaveReviewRuns(new StateManager(staleContextPath), registration, batch))
      .rejects.toThrow("packet context changed");

    await installWaveReviewRuns(manager, registration, batch);

    const installed = manager.load();
    const specAuthority = authorities[0]!;
    expect(installed.wave_review_epoch).toEqual({
      runId: created.value.runId,
      wave: 1,
      batchEpoch: batch.batchEpoch,
      specCheckDocuments: batch.specCheckDocuments,
      // The floor the packet rendered, recorded verbatim. Asserted against the
      // batch rather than a literal so a change to the derivation cannot make
      // the epoch and the packet disagree while both still pass.
      settledSpecCheckFloor: batch.settledFloor,
      specCheckSlotAuthority: { slot_id: specAuthority.slotId, attempted: 1 },
    });
    // This fixture records no spec_file, so the honest floor is an absence WITH
    // a stated reason - never a silent zero that would read as "nothing owed".
    expect(batch.settledFloor).toEqual({
      kind: "unprojected",
      reason: "the TaskGraph records no spec_file, so no Spec Index exists to join against",
    });
    const run = installed.tasks[0]!.review_run!;
    expect(run.generation).toBe(3);
    expect(run.expected_agents).toEqual(WAVE_REVIEW_AGENTS);
    expect(run.slot_authority).toEqual(WAVE_REVIEW_AGENTS.map((agent) => ({
      agent,
      slot_id: authorities.find(({ role }) => role === agent)!.slotId,
      attempted: 1,
    })));
    expect(run.packet_id).toBe(batch.taskRuns[0]!.packetId);
    expect(run.head_sha).toBe(batch.batchEpoch);

    const acceptedSpecCheck = capturedSpecCheck({
      wave: 1,
      runAt: "2026-08-30T00:00:00.000Z",
      criticalFindings: [],
    });
    await manager.update((locked) => ({
      ...locked,
      spec_check: acceptedSpecCheck,
      wave_review_epoch: {
        ...locked.wave_review_epoch!,
        specCheckSlotAuthority: { ...locked.wave_review_epoch!.specCheckSlotAuthority!, attempted: 2 },
      },
    }));

    await installWaveReviewRuns(manager, registration, batch);
    expect(manager.load().spec_check).toEqual(acceptedSpecCheck);
    expect(manager.load().wave_review_epoch?.specCheckSlotAuthority?.attempted).toBe(2);

    await manager.update((locked) => {
      const { settledSpecCheckFloor: historicalFloor, ...floorlessEpoch } = locked.wave_review_epoch!;
      void historicalFloor;
      return { ...locked, spec_check: acceptedSpecCheck, wave_review_epoch: floorlessEpoch };
    });
    await installWaveReviewRuns(manager, registration, batch);
    const upgraded = manager.load();
    expect(upgraded.spec_check).toBeUndefined();
    expect(upgraded.wave_review_epoch?.settledSpecCheckFloor).toEqual(batch.settledFloor);
    expect(upgraded.wave_review_epoch?.specCheckSlotAuthority?.attempted).toBe(1);
    expect(upgraded.tasks[0]?.review_run?.packet_id).toBe(batch.taskRuns[0]?.packetId);

    const conflictingGraph = parseTaskGraph({
      ...parsed.value,
      tasks: parsed.value.tasks.map((task) => ({ ...task, review_generation: (task.review_generation ?? 0) + 1 })),
    });
    if (!conflictingGraph.ok) throw new Error(conflictingGraph.error);
    const conflictingBatch = waveRequests(created.value, registration, conflictingGraph.value, 1, root);
    expect(conflictingBatch.batchEpoch).not.toBe(batch.batchEpoch);
    await expect(installWaveReviewRuns(manager, registration, conflictingBatch))
      .rejects.toThrow("packet context changed");
    expect(manager.load().spec_check).toBeUndefined();
    expect(manager.load().wave_review_epoch?.batchEpoch).toBe(batch.batchEpoch);
  });

  it("binds relative spec/Plan bytes to the graph root when cwd is another checkout", () => {
    const graphRoot = canonicalTempDir("loom-wave-graph-root-");
    const runtimeRoot = canonicalTempDir("loom-wave-runtime-root-");
    cleanup.push(graphRoot, runtimeRoot);
    const specFile = ".claude/specs/split/spec.md";
    const planFile = ".claude/plans/split.md";
    for (const root of [graphRoot, runtimeRoot]) {
      mkdirSync(join(root, ".claude", "specs", "split"), { recursive: true });
      mkdirSync(join(root, ".claude", "plans"), { recursive: true });
    }
    writeFileSync(join(graphRoot, specFile), "# Graph specification\n");
    writeFileSync(join(graphRoot, planFile), "# Graph Plan\n");
    writeFileSync(join(runtimeRoot, specFile), "# Foreign runtime specification\n");
    writeFileSync(join(runtimeRoot, planFile), "# Foreign runtime Plan\n");
    const runsRoot = join(runtimeRoot, "runs");
    mkdirSync(runsRoot);
    const created = createRunDirectory(runsRoot, "run.split-root");
    if (!created.ok) throw new Error(created.error.message);
    const parsed = parseTaskGraph({
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: specFile,
      plan_file: planFile,
      wave_gates: {},
      tasks: [taskFixture({
        id: "T1", description: "bind graph documents", agent: "code-implementer-agent", wave: 1,
        status: "implemented", depends_on: [], spec_anchors: [], spec_contributions: [], file_list: [],
      })],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"], authorityDigest: "a".repeat(64),
    };
    const previousCwd = process.cwd();
    process.chdir(runtimeRoot);
    try {
      const batch = waveRequests(created.value, registration, parsed.value, 1, graphRoot);
      const graphDocuments = observeDocuments(specFile, planFile, graphRoot).authority;
      const foreignDocuments = observeDocuments(specFile, planFile, runtimeRoot).authority;
      expect(batch.specCheckDocuments).toEqual(graphDocuments);
      expect(batch.specCheckDocuments).not.toEqual(foreignDocuments);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("refuses a relative Wave document reached through a symlink", () => {
    const graphRoot = canonicalTempDir("loom-wave-symlink-root-");
    const externalRoot = canonicalTempDir("loom-wave-symlink-external-");
    cleanup.push(graphRoot, externalRoot);
    mkdirSync(join(graphRoot, ".claude", "specs"), { recursive: true });
    writeFileSync(join(externalRoot, "spec.md"), "external authority");
    symlinkSync(externalRoot, join(graphRoot, ".claude", "specs", "linked"));

    expect(() => observeDocuments(
      ".claude/specs/linked/spec.md",
      null,
      graphRoot,
    )).toThrow(/cannot read Wave spec-check document/);
  });

  it("refuses an absolute Wave document outside the TaskGraph Project Boundary", () => {
    const graphRoot = canonicalTempDir("loom-wave-absolute-boundary-");
    const externalRoot = canonicalTempDir("loom-wave-absolute-external-");
    cleanup.push(graphRoot, externalRoot);
    const externalSpec = join(externalRoot, "spec.md");
    writeFileSync(externalSpec, "# Foreign specification\n");

    expect(() => observeDocuments(externalSpec, null, graphRoot))
      .toThrow(/outside TaskGraph Project Boundary/);
  });

  it("moves the batch epoch after either exact spec or plan bytes change", () => {
    const root = canonicalTempDir("loom-wave-document-bytes-");
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot);
    const created = createRunDirectory(runsRoot, "run.document-bytes");
    if (!created.ok) throw new Error(created.error.message);
    const specFile = join(root, "spec.md");
    const planFile = join(root, "plan.md");
    writeFileSync(specFile, "spec one");
    writeFileSync(planFile, "plan one");
    const parsed = parseTaskGraph({
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: specFile,
      plan_file: planFile,
      wave_gates: {},
      tasks: [taskFixture({
        id: "T1", description: "bind documents", agent: "code-implementer-agent", wave: 1,
        status: "implemented", depends_on: [], spec_anchors: ["FR-1"], spec_contributions: [], file_list: [],
      })],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1"],
      authorityDigest: "a".repeat(64),
    };

    const first = waveRequests(created.value, registration, parsed.value, 1, root);
    writeFileSync(specFile, "spec two");
    const specChanged = waveRequests(created.value, registration, parsed.value, 1, root);
    writeFileSync(specFile, "spec one");
    writeFileSync(planFile, "plan two");
    const planChanged = waveRequests(created.value, registration, parsed.value, 1, root);

    expect(specChanged.batchEpoch).not.toBe(first.batchEpoch);
    expect(specChanged.specCheckDocuments.spec.contentDigest)
      .not.toBe(first.specCheckDocuments.spec.contentDigest);
    expect(planChanged.batchEpoch).not.toBe(first.batchEpoch);
    expect(planChanged.specCheckDocuments.plan.contentDigest)
      .not.toBe(first.specCheckDocuments.plan.contentDigest);
  });

  it("rejects installation when document bytes drift after unlocked observation", async () => {
    const root = canonicalTempDir("loom-wave-document-install-");
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot);
    const created = createRunDirectory(runsRoot, "run.document-install");
    if (!created.ok) throw new Error(created.error.message);
    const specFile = join(root, "spec.md");
    const planFile = join(root, "plan.md");
    writeFileSync(specFile, "spec");
    writeFileSync(planFile, "plan before");
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1"],
      authorityDigest: "a".repeat(64),
    };
    const parsed = parseTaskGraph({
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: specFile,
      plan_file: planFile,
      wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: created.value.runId,
        wave: 1, authorityDigest: registration.authorityDigest, revision: 0, terminalOutcome: null,
      },
      tasks: [taskFixture({
        id: "T1", description: "reject stale documents", agent: "code-implementer-agent", wave: 1,
        status: "implemented", depends_on: [], spec_anchors: ["FR-1"], spec_contributions: [], file_list: [],
      })],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const statePath = join(root, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(parsed.value));
    const manager = new StateManager(statePath);
    const batch = waveRequests(created.value, registration, parsed.value, 1, root);
    writeFileSync(planFile, "plan after");

    await expect(installWaveReviewRuns(manager, registration, batch))
      .rejects.toThrow("spec-check documents changed");
    expect(manager.load().wave_review_epoch).toBeUndefined();
  });
});

/**
 * What a Wave reviewer slot IS an authority over.
 *
 * Slot and request identity used to hash the whole `registration` object, so
 * adding recovery bookkeeping (`restart`, `orphanRecovery`) or merely re-ordering
 * a caller's JSON keys re-derived every slot in the Wave — orphaning captures
 * already written against the previous ids, and making a slot's identity depend
 * on anything other than the reviewed Wave.
 */
describe("Wave reviewer slot identity projection", () => {
  const graph = parseTaskGraph({
    spec_trace_version: 2,
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    wave_gates: {},
    tasks: [taskFixture({
      id: "T1", description: "review exact authority", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [], review_generation: 1, spec_anchors: ["FR-1"],
      spec_contributions: [], file_list: ["engine/src/core/wave-review-authority.ts"],
    })],
  });
  if (!graph.ok) throw new Error(`wave slot fixture rejected: ${graph.error}`);
  const preparedGraph = graph.value;

  const plain: RegisteredWaveGateProgram = {
    schemaVersion: 1,
    kind: "wave-gate",
    input: { wave: 1 },
    taskIds: ["T1"],
    authorityDigest: "a".repeat(64),
  };

  function identitiesFor(registration: RegisteredWaveGateProgram, attempt: 1 | 2): readonly string[] {
    const runsRoot = canonicalTempDir("loom-wave-slot-identity-");
    cleanup.push(runsRoot);
    const created = createRunDirectory(runsRoot, "run.identity");
    if (!created.ok) throw new Error(created.error.message);
    return waveRequests(created.value, registration, preparedGraph, attempt, process.cwd()).requests.map(({ authority }) =>
      `${(authority as AgentRequestAuthority).slotId}@${(authority as AgentRequestAuthority).requestId}`);
  }

  it("is unchanged by recovery bookkeeping or by the caller's key order", () => {
    const baseline = identitiesFor(plain, 1);

    const restarted: RegisteredWaveGateProgram = {
      ...plain,
      restart: { previousRunId: "run.previous", exhaustedSlots: ["wave-slot:retired"] },
    };
    const orphanRecovered: RegisteredWaveGateProgram = {
      ...plain,
      orphanRecovery: { previousRunId: "run.previous", previousAuthorityDigest: "f".repeat(64) },
    };
    const reordered: RegisteredWaveGateProgram = {
      authorityDigest: plain.authorityDigest,
      taskIds: plain.taskIds,
      input: plain.input,
      kind: plain.kind,
      schemaVersion: plain.schemaVersion,
    } as RegisteredWaveGateProgram;

    expect(identitiesFor(restarted, 1)).toEqual(baseline);
    expect(identitiesFor(orphanRecovered, 1)).toEqual(baseline);
    expect(identitiesFor(reordered, 1)).toEqual(baseline);
  });

  it("changes only reviewer identities when protocol changes, retaining exact spec-check bytes and batch epoch", () => {
    const runId = parseOrchestrationRunId("run.protocol-identity");
    if (!runId.ok) throw new Error(runId.error.message);
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), (generation) => {
      const graph = { ...preparedGraph, tasks: preparedGraph.tasks.map((task) => ({ ...task, review_generation: generation })) };
      const legacy = { ...plain, schemaVersion: 1 as const, input: { wave: 1 } };
      const current = { ...legacy, schemaVersion: 2 as const, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL };
      const workspace = [{ taskId: "T1", scope: ["engine/src/core/wave-review-authority.ts"], headSha: "b".repeat(64) }];
      const observation = observeDocuments(null, null);
      const first = prepareWaveReviewBatch(runId.value, legacy, graph, 1, workspace, observation);
      const second = prepareWaveReviewBatch(runId.value, current, graph, 1, workspace, observation);
      if (!first.ok || !second.ok) throw new Error("versioned preparation must succeed");
      expect(second.value.batchEpoch).toBe(first.value.batchEpoch);
      expect(second.value.requests[0]).toEqual(first.value.requests[0]);
      expect(second.value.packets[0]).toEqual(first.value.packets[0]);
      expect(second.value.settledFloor).toEqual(first.value.settledFloor);
      expect(second.value.packets.slice(1).every(({ schemaVersion }) => schemaVersion === 2)).toBe(true);
      expect(second.value.requests.slice(1)).not.toEqual(first.value.requests.slice(1));
    }), { numRuns: 20, seed: 4301 });
  });

  it("still moves when the reviewed authority itself moves", () => {
    const baseline = identitiesFor(plain, 1);

    expect(identitiesFor({ ...plain, authorityDigest: "b".repeat(64) }, 1)).not.toEqual(baseline);
    expect(identitiesFor(plain, 2)).not.toEqual(baseline);
  });
});

describe("Requirement Coverage Projection in the spec-check packet", () => {
  const spec = `# Feature: Coverage wiring

## User Scenarios

### US1: [P1] Project coverage

**Acceptance Scenarios:**
- AS-001: Given a claim, When the gate runs, Then a structural verdict exists

## Functional Requirements

- FR-001: System MUST project structural verdicts before any model reads a file
- FR-002: System MUST name Requirements no Task claims

## Out of Scope

- OOS-001: Symbol-level source indexing

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Spec Index | A deterministic projection of specification entries |
`;

  const coverageSectionOf = (
    specFile: string | null,
    tasks: TaskGraph["tasks"],
    graphOverrides: Partial<TaskGraph> = {},
  ): string => {
    const runsRoot = canonicalTempDir("loom-wave-coverage-");
    cleanup.push(runsRoot);
    const created = createRunDirectory(runsRoot, "run.coverage");
    if (!created.ok) throw new Error(created.error.message);
    const parsedGraph = parseTaskGraph({
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: specFile,
      plan_file: null,
      wave_gates: {},
      tasks,
      ...graphOverrides,
    });
    if (!parsedGraph.ok) throw new Error("graph fixture must parse");
    const batch = waveRequests(created.value, {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: tasks.map(({ id }) => id),
      authorityDigest: "a".repeat(64),
    }, parsedGraph.value, 1, projectRootForDocuments(parsedGraph.value.spec_file, parsedGraph.value.plan_file));
    const specRequest = batch.requests.find(({ authority }) =>
      (authority as AgentRequestAuthority).role === "spec-check-invoker");
    const digest = (specRequest!.authority as AgentRequestAuthority).contextDigest;
    const packet = batch.packets.find((candidate) => candidate.digest === digest);
    const section = packet?.fixedContext.find(({ label }) => label === "requirement-coverage");
    if (section === undefined) throw new Error("spec-check packet must carry a requirement-coverage section");
    return new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(section.bytes));
  };

  const specFileIn = (contents: string): string => {
    const root = canonicalTempDir("loom-coverage-spec-");
    cleanup.push(root);
    mkdirSync(join(root, "specs"), { recursive: true });
    const path = join(root, "specs", "spec.md");
    writeFileSync(path, contents, "utf8");
    return path;
  };

  it("settles structural verdicts in the packet the spec-check Agent reads", () => {
    const rendered = coverageSectionOf(specFileIn(spec), [
      taskFixture({
        id: "T1", description: "claims an excluded item", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], spec_anchors: ["OOS-001"], spec_contributions: [],
        file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
      }),
      taskFixture({
        id: "T2", description: "claims a real Requirement but touched nothing",
        agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
        file_list: ["src/b.ts"], files_modified: [],
      }),
    ]);
    expect(rendered).toContain("Out-of-Scope item cannot be completed");
    expect(rendered).toContain("modified no files");
    // FR-002 is claimed by no Task at any Wave — planned by nobody.
    expect(rendered).toContain("FR-002 — CRITICAL: no Task in the graph claims it");
  });

  it("only the spec-check subject receives the projection", () => {
    const runsRoot = canonicalTempDir("loom-wave-coverage-subject-");
    cleanup.push(runsRoot);
    const created = createRunDirectory(runsRoot, "run.subject");
    if (!created.ok) throw new Error(created.error.message);
    const parsedGraph = parseTaskGraph({
      spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {},
      skipped_phases: [], spec_file: specFileIn(spec), plan_file: null, wave_gates: {},
      tasks: [taskFixture({
        id: "T1", description: "implements FR-001", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
        file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
      })],
    });
    if (!parsedGraph.ok) throw new Error("graph fixture must parse");
    const batch = waveRequests(created.value, {
      schemaVersion: 1, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"],
      authorityDigest: "a".repeat(64),
    }, parsedGraph.value, 1, projectRootForDocuments(parsedGraph.value.spec_file, parsedGraph.value.plan_file));
    for (const request of batch.requests) {
      const authority = request.authority as AgentRequestAuthority;
      const packet = batch.packets.find((candidate) => candidate.digest === authority.contextDigest);
      const hasCoverage = packet?.fixedContext.some(({ label }) => label === "requirement-coverage") ?? false;
      expect(hasCoverage).toBe(authority.role === "spec-check-invoker");
    }
    expect(WAVE_REVIEW_AGENTS.length).toBeGreaterThan(0);
  });

  it("states an unavailable projection rather than passing silently", () => {
    const rendered = coverageSectionOf(null, [taskFixture({
      id: "T1", description: "claims FR-001", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
      file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
    })]);
    expect(rendered).toContain("UNAVAILABLE");
    expect(rendered).toContain("never a pass");
  });

  it("reports and floors an altered recorded hash end to end through the packet", () => {
    const rendered = coverageSectionOf(specFileIn(spec), [taskFixture({
      id: "T1", description: "claims FR-001", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
      file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
      spec_anchor_hashes: { "FR-001": "deadbeef" },
    })]);
    expect(rendered).toContain("have been altered");
    expect(rendered).not.toContain("no hash was recorded");
    expect(rendered).toMatch(/CRITICAL: Task "T1" claim "FR-001" .*have been altered/u);
  });

  it("uses the durable population reason when the Wave Gate explains a missing Requirement hash", () => {
    const specFile = specFileIn(spec);
    const rendered = coverageSectionOf(specFile, [taskFixture({
      id: "T1", description: "claims FR-001", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], spec_anchors: ["FR-001", "FR-002", "AS-001"], spec_contributions: [],
      file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
    })], {
      spec_index_observation: {
        kind: "unavailable",
        reason: {
          kind: "unparsed",
          path: specFile,
          contentDigest: DIGEST("d"),
          errors: [{ kind: "missing-section", section: "Functional Requirements" }],
        },
      },
    });

    expect(rendered).toContain("drift is unverifiable because no hash was recorded");
    expect(rendered).toContain("population Spec Index was unavailable");
    expect(rendered).toContain("missing required section ## Functional Requirements");
  });

  it("reports drift when the specification changed after the hashes were recorded", () => {
    const drifted = spec.replace(
      "System MUST project structural verdicts before any model reads a file",
      "System MUST project structural verdicts, reworded after the claim was made",
    );
    const rendered = coverageSectionOf(specFileIn(drifted), [taskFixture({
      id: "T1", description: "claims FR-001", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
      file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
      spec_anchor_hashes: { "FR-001": "0".repeat(64) },
    })]);
    expect(rendered).toContain("its text changed since the claim");
  });
});

describe("Wave spec-check authority guards", () => {
  const spec = `# Feature: Guarded

## User Scenarios

### US1: [P1] Guard the projection

**Acceptance Scenarios:**
- AS-001: Given an observation, When it names another document, Then preparation fails

## Functional Requirements

- FR-001: System MUST bind the projection to the protected spec_file

## Out of Scope

- OOS-001: Symbol-level source indexing

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Spec Index | A deterministic projection of specification entries |
`;

  const specFileIn = (contents: string): string => {
    const root = canonicalTempDir("loom-guard-spec-");
    cleanup.push(root);
    const path = join(root, "spec.md");
    writeFileSync(path, contents, "utf8");
    return path;
  };

  const graphWith = (specFile: string | null, modified: readonly string[] = ["src/a.ts"]) => {
    const parsed = parseTaskGraph({
      spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {},
      skipped_phases: [], spec_file: specFile, plan_file: null, wave_gates: {},
      tasks: [taskFixture({
        id: "T1", description: "implements FR-001", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
        file_list: ["src/a.ts"], files_modified: [...modified],
      })],
    });
    if (!parsed.ok) throw new Error("graph fixture must parse");
    return parsed.value;
  };

  const registration = {
    schemaVersion: 1 as const, kind: "wave-gate" as const, input: { wave: 1 },
    taskIds: ["T1"], authorityDigest: "a".repeat(64),
  };

  const runId = () => {
    const parsed = parseOrchestrationRunId("run.guard");
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  };

  const workspace = [{ taskId: "T1", headSha: "b".repeat(64), scope: ["src/a.ts"] }];

  it("refuses an observation whose Spec Index names another document", () => {
    // The guard exists so a projection can never be published under a document
    // it was not derived from. Deleting it used to leave every test green.
    const specFile = specFileIn(spec);
    const other = specFileIn(spec.replace("FR-001", "FR-002"));
    const honest = observeDocuments(specFile, null);
    const mismatched = Object.freeze({
      authority: honest.authority,
      specIndex: observeDocuments(other, null).specIndex,
    });
    const prepared = prepareWaveReviewBatch(
      runId(), registration, graphWith(specFile), 1, workspace, mismatched,
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.message).toContain("does not name the protected spec_file");
  });

  it("refuses an index parsed from bytes other than the observed document", () => {
    // Same path, different bytes: only the digest comparison catches this, and
    // it is what makes the module's "one read" claim true rather than asserted.
    const specFile = specFileIn(spec);
    const honest = observeDocuments(specFile, null);
    const forged = Object.freeze({
      authority: honest.authority,
      specIndex: projectSpecBytes(specFile, Buffer.from(spec.replace("FR-001", "FR-009"), "utf8")),
    });
    const prepared = prepareWaveReviewBatch(
      runId(), registration, graphWith(specFile), 1, workspace, forged,
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.message).toContain("parsed from bytes other than");
  });

  it("refuses an unparsed result derived from different bytes at the same path", () => {
    const specFile = specFileIn(spec);
    const honest = observeDocuments(specFile, null);
    const mismatched = Object.freeze({
      authority: honest.authority,
      specIndex: projectSpecBytes(specFile, Buffer.from("# not a canonical specification", "utf8")),
    });
    const prepared = prepareWaveReviewBatch(
      runId(), registration, graphWith(specFile), 1, workspace, mismatched,
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.message).toContain("parsed from bytes other than");
  });

  it("accepts the honest single-read observation the shell produces", () => {
    const specFile = specFileIn(spec);
    const prepared = prepareWaveReviewBatch(
      runId(), registration, graphWith(specFile), 1, workspace,
      observeDocuments(specFile, null),
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.ok).toBe(true);
  });

  it("carries the Task's real modified files into the spec-check scope", () => {
    // Hardcoding this to the empty array used to leave every test green, while
    // it is the field that separates "declared nothing" from "modified nothing".
    const scope = waveSpecCheckScope(graphWith(specFileIn(spec), ["src/a.ts", "src/b.ts"]).tasks);
    expect(scope[0]?.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("wave-review-authority spec-check scope decoding", () => {
  const base = {
    runId: "run.decode", wave: 1, authorityDigest: "a".repeat(64), batchEpoch: "b".repeat(64),
    subject: { role: "spec-check-invoker", taskId: null }, taskRun: null, task: null, packetId: null,
    specFile: null, planFile: null,
    specCheckDocuments: { spec: { path: null, contentDigest: null }, plan: { path: null, contentDigest: null } },
  };

  const packetFor = (scope: unknown) => {
    const section = encodeByteSection("wave-review-authority", JSON.stringify({ ...base, specCheckScope: scope }));
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: decodeRequestId("request:" + "c".repeat(64)), role: "spec-check-invoker", requiredSkill: "none",
      outputContract: "decode", fixedContext: [section.value], variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    return packet.value;
  };

  it("loads a scope entry published before modifiedFiles existed", () => {
    // A packet a schema generation behind is not damaged bytes. Refusing it
    // reported an engine's own persisted packet as corrupt and blocked a Wave
    // Gate that merely outlived an upgrade.
    const packet = packetFor([{
      id: "T1", description: "legacy", completionAnchors: ["FR-1"], contributions: [], declaredFiles: ["a.ts"],
    }]);
    const context = handleWaveReviewContext([packet], packet.digest);
    expect(context.kind).toBe("loaded");
    if (context.kind !== "loaded" || context.value.specCheckScope === null) return;
    expect(context.value.specCheckScope[0]?.modifiedFiles).toEqual([]);
  });

  it("loads the current shape and rejects a blank modified path", () => {
    const current = packetFor([{
      id: "T1", description: "current", completionAnchors: ["FR-1"], contributions: [],
      declaredFiles: ["a.ts"], modifiedFiles: ["a.ts"],
    }]);
    expect(handleWaveReviewContext([current], current.digest).kind).toBe("loaded");

    const blank = packetFor([{
      id: "T1", description: "blank", completionAnchors: ["FR-1"], contributions: [],
      declaredFiles: ["a.ts"], modifiedFiles: ["  "],
    }]);
    expect(handleWaveReviewContext([blank], blank.digest).kind).toBe("corrupt");
  });

  it("accepts repeated modified paths, which the state schema also accepts", () => {
    // A stricter decoder than the StateManager would reject a packet the engine
    // itself built one step earlier from a graph that was accepted.
    const repeated = packetFor([{
      id: "T1", description: "repeated", completionAnchors: ["FR-1"], contributions: [],
      declaredFiles: ["a.ts"], modifiedFiles: ["a.ts", "a.ts"],
    }]);
    expect(handleWaveReviewContext([repeated], repeated.digest).kind).toBe("loaded");
  });
});

describe("an installed epoch is replayed only when it is the same epoch", () => {
  const RUN_ID = ((): OrchestrationRunId => {
    const parsed = parseOrchestrationRunId("run.replay");
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  })();
  const OTHER_RUN_ID = ((): OrchestrationRunId => {
    const parsed = parseOrchestrationRunId("run.other");
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  })();
  const documents = Object.freeze({
    spec: Object.freeze({ path: "spec.md", contentDigest: DIGEST("a") }),
    plan: Object.freeze({ path: null, contentDigest: null }),
  });
  const batch = (settledFloor: SettledFloor): WaveRequestBatch => Object.freeze({
    batchEpoch: DIGEST("b"),
    specCheckDocuments: documents,
    settledFloor,
    requests: Object.freeze([]),
    packets: Object.freeze([]),
    taskRuns: Object.freeze([]),
  });
  const epoch = (floor?: SettledFloor): WaveReviewEpochAuthority => Object.freeze({
    runId: RUN_ID,
    wave: 1,
    batchEpoch: DIGEST("b"),
    specCheckDocuments: documents,
    specCheckSlotAuthority: Object.freeze({ slot_id: "wave-slot:spec-check", attempted: 1 as const }),
    ...(floor === undefined ? {} : { settledSpecCheckFloor: floor }),
  });
  const settled = (count: number): SettledFloor => {
    const parsed = parseSettledFloor({
      kind: "settled",
      count,
      criticalFindings: Array.from({ length: count }, (_, at) => `required ${at + 1}`),
    });
    if (parsed === null) throw new Error("fixture settled floor must parse");
    return parsed;
  };
  const legacySettled = (count: number): SettledFloor => {
    const parsed = parseSettledFloor({ kind: "settled", count });
    if (parsed === null) throw new Error("fixture legacy floor must parse");
    return parsed;
  };
  const replay = (existing: WaveReviewEpochAuthority | undefined, floor: SettledFloor) =>
    decideWaveReviewEpochReplay(existing, batch(floor), RUN_ID, 1, "wave-slot:spec-check");

  it("classifies an epoch whose recorded floor matches as exact", () => {
    expect(replay(epoch(settled(3)), settled(3))).toEqual({ kind: "exact" });
  });

  it("classifies an epoch whose recorded floor differs as different", () => {
    // `batchEpoch` covers neither `spec_anchor_hashes` nor out-of-Wave
    // `spec_anchors`, so two batches can agree on the digest and still disagree
    // on the number the Agent would be shown. Retaining the stale one would
    // reopen the divergence recording the floor was meant to close.
    expect(replay(epoch(settled(3)), settled(4))).toEqual({ kind: "different" });
    expect(replay(epoch(settled(3)), { kind: "unprojected", reason: "no spec_file" }))
      .toEqual({ kind: "different" });
  });

  it("classifies historical floor authority as an explicit upgrade", () => {
    expect(replay(epoch(), settled(3))).toEqual({ kind: "upgrade-floor" });
    expect(replay(epoch(legacySettled(3)), settled(3))).toEqual({ kind: "upgrade-floor" });
    expect(replay(epoch(legacySettled(2)), settled(3))).toEqual({ kind: "different" });
  });

  it("classifies an absent installed epoch as different", () => {
    expect(replay(undefined, settled(3))).toEqual({ kind: "different" });
  });

  it("refuses a different run, Wave, batch digest, documents, or spec-check slot", () => {
    const same = batch(settled(3));
    expect(decideWaveReviewEpochReplay(epoch(settled(3)), same, OTHER_RUN_ID, 1, "wave-slot:spec-check"))
      .toEqual({ kind: "different" });
    expect(decideWaveReviewEpochReplay(epoch(settled(3)), same, RUN_ID, 2, "wave-slot:spec-check"))
      .toEqual({ kind: "different" });
    expect(decideWaveReviewEpochReplay(epoch(settled(3)), same, RUN_ID, 1, "wave-slot:other"))
      .toEqual({ kind: "different" });
    expect(decideWaveReviewEpochReplay(
      { ...epoch(settled(3)), batchEpoch: DIGEST("c") },
      same, RUN_ID, 1, "wave-slot:spec-check",
    )).toEqual({ kind: "different" });
    expect(decideWaveReviewEpochReplay(
      { ...epoch(settled(3)), specCheckDocuments: {
        spec: { path: "spec.md", contentDigest: DIGEST("f") }, plan: { path: null, contentDigest: null },
      } },
      same, RUN_ID, 1, "wave-slot:spec-check",
    )).toEqual({ kind: "different" });
  });
});
