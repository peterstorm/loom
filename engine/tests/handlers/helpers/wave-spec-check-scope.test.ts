import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createRunDirectory } from "../../../src/orchestration/run-directory-handle";
import {
  handleWaveReviewContext,
  installWaveReviewRuns,
  waveRequests,
  waveSpecCheckScope,
} from "../../../src/handlers/helpers/programs/wave-gate";
import type { RegisteredWaveGateProgram } from "../../../src/handlers/helpers/programs/helpers";
import type { TaskGraph } from "../../../src/types";
import { parseTaskGraph, StateManager } from "../../../src/state-manager";
import type { AgentRequestAuthority } from "../../../src/core/orchestration-contract";
import { taskFixture } from "../../fixtures/task-lifecycle";
import { WAVE_REVIEW_AGENTS } from "../../../src/core/model-profiles";
import { prepareWaveReviewBatch } from "../../../src/core/wave-review-authority";
import { observeWaveSpecCheckDocuments } from "../../../src/orchestration/wave-spec-check-documents";
import { projectSpecBytes } from "../../../src/orchestration/spec-index-observation";
import { parseOrchestrationRunId, parseRequestId } from "../../../src/core/orchestration-contract";

const decodeRequestId = (raw: string) => {
  const parsed = parseRequestId(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};
import { buildContextPacket, encodeByteSection } from "../../../src/core/context-packets";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

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
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-spec-scope-"));
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
    const batch = waveRequests(created.value, registration, parsedGraph.value, 1);
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
    const root = mkdtempSync(join(tmpdir(), "loom-wave-authority-install-"));
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

    const batch = waveRequests(created.value, registration, parsed.value, 1);
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
      specCheckSlotAuthority: { slot_id: specAuthority.slotId, attempted: 1 },
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

    const acceptedSpecCheck = {
      wave: 1,
      run_at: "2026-08-30T00:00:00.000Z",
      verdict: "PASSED" as const,
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: [],
    };
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

    const conflictingGraph = parseTaskGraph({
      ...parsed.value,
      tasks: parsed.value.tasks.map((task) => ({ ...task, review_generation: (task.review_generation ?? 0) + 1 })),
    });
    if (!conflictingGraph.ok) throw new Error(conflictingGraph.error);
    const conflictingBatch = waveRequests(created.value, registration, conflictingGraph.value, 1);
    expect(conflictingBatch.batchEpoch).not.toBe(batch.batchEpoch);
    await expect(installWaveReviewRuns(manager, registration, conflictingBatch))
      .rejects.toThrow("packet context changed");
    expect(manager.load().spec_check).toEqual(acceptedSpecCheck);
    expect(manager.load().wave_review_epoch?.batchEpoch).toBe(batch.batchEpoch);
  });

  it("moves the batch epoch after either exact spec or plan bytes change", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-wave-document-bytes-"));
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

    const first = waveRequests(created.value, registration, parsed.value, 1);
    writeFileSync(specFile, "spec two");
    const specChanged = waveRequests(created.value, registration, parsed.value, 1);
    writeFileSync(specFile, "spec one");
    writeFileSync(planFile, "plan two");
    const planChanged = waveRequests(created.value, registration, parsed.value, 1);

    expect(specChanged.batchEpoch).not.toBe(first.batchEpoch);
    expect(specChanged.specCheckDocuments.spec.contentDigest)
      .not.toBe(first.specCheckDocuments.spec.contentDigest);
    expect(planChanged.batchEpoch).not.toBe(first.batchEpoch);
    expect(planChanged.specCheckDocuments.plan.contentDigest)
      .not.toBe(first.specCheckDocuments.plan.contentDigest);
  });

  it("rejects installation when document bytes drift after unlocked observation", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-wave-document-install-"));
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
    const batch = waveRequests(created.value, registration, parsed.value, 1);
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
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-slot-identity-"));
    cleanup.push(runsRoot);
    const created = createRunDirectory(runsRoot, "run.identity");
    if (!created.ok) throw new Error(created.error.message);
    return waveRequests(created.value, registration, preparedGraph, attempt).requests.map(({ authority }) =>
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

  const coverageSectionOf = (specFile: string | null, tasks: TaskGraph["tasks"]): string => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-coverage-"));
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
    });
    if (!parsedGraph.ok) throw new Error("graph fixture must parse");
    const batch = waveRequests(created.value, {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: tasks.map(({ id }) => id),
      authorityDigest: "a".repeat(64),
    }, parsedGraph.value, 1);
    const specRequest = batch.requests.find(({ authority }) =>
      (authority as AgentRequestAuthority).role === "spec-check-invoker");
    const digest = (specRequest!.authority as AgentRequestAuthority).contextDigest;
    const packet = batch.packets.find((candidate) => candidate.digest === digest);
    const section = packet?.fixedContext.find(({ label }) => label === "requirement-coverage");
    if (section === undefined) throw new Error("spec-check packet must carry a requirement-coverage section");
    return new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(section.bytes));
  };

  const specFileIn = (contents: string): string => {
    const root = mkdtempSync(join(tmpdir(), "loom-coverage-spec-"));
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
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-coverage-subject-"));
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
    }, parsedGraph.value, 1);
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

  it("reports an altered recorded hash as corrupt authority, end to end through the packet", () => {
    const rendered = coverageSectionOf(specFileIn(spec), [taskFixture({
      id: "T1", description: "claims FR-001", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], spec_anchors: ["FR-001"], spec_contributions: [],
      file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
      spec_anchor_hashes: { "FR-001": "deadbeef" },
    })]);
    expect(rendered).toContain("have been altered");
    expect(rendered).not.toContain("no hash was recorded");
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
    const root = mkdtempSync(join(tmpdir(), "loom-guard-spec-"));
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
    const honest = observeWaveSpecCheckDocuments(specFile, null);
    const mismatched = Object.freeze({
      authority: honest.authority,
      specIndex: observeWaveSpecCheckDocuments(other, null).specIndex,
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
    const honest = observeWaveSpecCheckDocuments(specFile, null);
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

  it("accepts the honest single-read observation the shell produces", () => {
    const specFile = specFileIn(spec);
    const prepared = prepareWaveReviewBatch(
      runId(), registration, graphWith(specFile), 1, workspace,
      observeWaveSpecCheckDocuments(specFile, null),
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
