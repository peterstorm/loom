import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec } from "../../src/core/parse-spec";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
  type TaskGraphPopulationCommand,
} from "../../src/core/task-graph-population";
import { defaultVerificationManifest } from "../../src/core/verification-manifest";
import { specIndexObservationOf } from "../../src/core/requirement-coverage";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import { registerTaskExecutionBaseline } from "../../src/core/validate-task-execution";
import type { DeclaredArtifactBaseline } from "../../src/core/artifact-baseline";
import { PHASES, type PlanContract, type TaskGraph } from "../../src/types";
import { parseExportBindings } from "../../src/core/skeleton/bindings";
import type { SkeletonRecord } from "../../src/core/skeleton/types";
import type { SkeletonGraph } from "../../src/core/skeleton/scope";
import { parseTaskGraph } from "../../src/state-file-wire";

const specSource = `# Feature: Population

## User Scenarios

### US1: [P1] Populate a graph

**Acceptance Scenarios:**
- AS-001: Given validated Tasks, When population runs, Then pending Tasks are installed

## Functional Requirements

- FR-001: System MUST populate the TaskGraph through a pure aggregate command

## Out of Scope

- OOS-001: External scheduling

## Appendix: Glossary

| Term | Definition |
|------|------------|
| TaskGraph | Protected orchestration state |
`;

const parsedSpec = parseSpec(specSource);
if (!parsedSpec.ok) throw new Error("population fixture specification must parse");
const parsedDigest = parseArtifactDigest("a".repeat(64));
if (!parsedDigest.ok) throw new Error("population fixture Artifact Digest must parse");
const specIndex = Object.freeze({
  kind: "indexed" as const,
  path: "spec.md",
  contentDigest: parsedDigest.value,
  index: parsedSpec.value,
});

const authoredTask = (id: string, wave: number, anchors: readonly string[] = ["FR-001"]): AuthoredTask =>
  Object.freeze({
    id,
    description: `implement ${id}`,
    agent: "code-implementer-agent",
    wave,
    depends_on: Object.freeze([]),
    spec_anchors: Object.freeze([...anchors]),
    spec_contributions: Object.freeze([]),
    verification_policy: Object.freeze({
      regression: Object.freeze({ kind: "required" as const }),
      new_tests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" as const }),
    }),
    file_list: Object.freeze([`src/${id}.ts`]),
  });

const roster = (tasks: readonly AuthoredTask[]) => {
  const parsed = parseAuthoredTaskRoster(tasks);
  if (!parsed.ok) throw new Error(`invalid authored roster fixture: ${parsed.error}`);
  return parsed.value;
};

/** GIT-captured declared-artifact baseline as the population command receives it. */
const gitBaseline = (path: string, digest: string): readonly DeclaredArtifactBaseline[] =>
  Object.freeze([{ artifact: path, snapshot: { kind: "sha256" as const, digest } }]);
const missingBaseline = (path: string): readonly DeclaredArtifactBaseline[] =>
  Object.freeze([{ artifact: path, snapshot: { kind: "missing" as const } }]);

const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
  current_phase: "decompose",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: "spec.md",
  plan_file: "plan.md",
  tasks: [],
  wave_gates: {},
  ...overrides,
});

const command = (overrides: Partial<TaskGraphPopulationCommand> = {}): TaskGraphPopulationCommand => ({
  planTitle: "Population plan",
  validatedPlanFile: "plan.md",
  authoredSpecFile: "spec.md",
  tasks: roster([authoredTask("T1", 1)]),
  verificationManifest: defaultVerificationManifest(),
  specIndex,
  observedSpecFile: "spec.md",
  force: false,
  proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" },
  contracts: [],
  invariants: [],
  ...overrides,
});

const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Population contract",
  declaration: {
    kind: "declared",
    types: { kind: "file", path: "src/population-contract.ts" },
    acceptance: [{ path: "tests/population.acceptance.test.ts", anchors: ["AS-001"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: "Population installs pending Tasks.",
  },
};

describe("populateTaskGraph aggregate command", () => {
  it("installs sanitized pending Tasks, Requirement hashes, and exact Wave gates", () => {
    const result = populateTaskGraph(graph({
      active_wave_completion_suite: { stale: true } as never,
    }), command({
      tasks: roster([authoredTask("T1", 1), authoredTask("T2", 2, ["AS-001"])]),
      issue: 43,
      repo: "peterstorm/loom",
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waves).toEqual([1, 2]);
    expect(Object.keys(result.value.state.wave_gates)).toEqual(["1", "2"]);
    expect(result.value.state).toMatchObject({
      spec_trace_version: 2,
      plan_title: "Population plan",
      plan_file: "plan.md",
      spec_file: "spec.md",
      current_wave: 1,
      executing_tasks: [],
      github_issue: 43,
      github_repo: "peterstorm/loom",
    });
    expect(result.value.state.active_wave_completion_suite).toBeUndefined();
    expect(result.value.state.spec_index_observation).toEqual({
      kind: "indexed",
      path: "spec.md",
      contentDigest: parsedDigest.value,
    });
    expect(result.value.state.spec_index_observation).not.toHaveProperty("index");
    expect(Object.isFrozen(result.value.state.spec_index_observation)).toBe(true);
    expect(result.value.state.tasks).toEqual([
      expect.objectContaining({
        id: "T1",
        status: "pending",
        review_status: "pending",
        review_generation: 0,
        spec_anchor_hashes: { "FR-001": parsedSpec.value.frs[0]!.contentHash },
      }),
      expect.objectContaining({
        id: "T2",
        status: "pending",
        spec_anchor_hashes: { "AS-001": parsedSpec.value.scenarios[0]!.contentHash },
      }),
    ]);
  });

  it("stamps the GIT proof boundary at the population revision, and the first dispatch preserves it", () => {
    const populationRevision = "b".repeat(40);
    const result = populateTaskGraph(graph(), command({
      tasks: roster([authoredTask("T1", 1), authoredTask("T2", 2, ["AS-001"])]),
      proofBoundary: {
        kind: "captured",
        baselines: new Map([
          ["T1", gitBaseline("src/T1.ts", parsedDigest.value)],
          ["T2", missingBaseline("src/T2.ts")],
        ]),
        revision: populationRevision,
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.proof_boundary_observation).toEqual({ kind: "captured", revision: populationRevision });
    const [first, second] = result.value.state.tasks;
    // The boundary always predates the Task's production (INV-DF1): captured at
    // the population revision, BEFORE any work exists.
    expect(first).toMatchObject({
      id: "T1",
      status: "pending",
      start_sha: populationRevision,
      artifact_baseline: [{ artifact: "src/T1.ts", snapshot: { kind: "sha256", digest: parsedDigest.value } }],
    });
    expect(second).toMatchObject({
      id: "T2",
      start_sha: populationRevision,
      artifact_baseline: [{ artifact: "src/T2.ts", snapshot: { kind: "missing" } }],
    });

    // First dispatch: registerTaskExecutionBaseline prefers task.start_sha and
    // task.artifact_baseline, so the population-time boundary survives the
    // dispatch-time refresh and Proof keeps seeing all bytes produced by the task.
    const dispatchProofBaseline = gitBaseline("src/T1.ts", "d".repeat(64));
    const registered = registerTaskExecutionBaseline(first!, "c".repeat(40), dispatchProofBaseline);
    expect(registered.start_sha).toBe(populationRevision);
    expect(registered.artifact_baseline).toEqual(gitBaseline("src/T1.ts", parsedDigest.value));
    expect(registered.attempt_artifact_baseline).toEqual(dispatchProofBaseline);
  });

  it("leaves the proof boundary absent when Git could not capture it, and the first dispatch stamps its own", () => {
    const result = populateTaskGraph(graph(), command());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The absence and its cause persist on the graph, not only in the shell's notice.
    expect(result.value.state.proof_boundary_observation).toEqual({ kind: "absent", cause: "fixture: no Git repository root" });
    const task = result.value.state.tasks[0]!;
    expect(task).not.toHaveProperty("artifact_baseline");
    expect(task).not.toHaveProperty("start_sha");

    const registered = registerTaskExecutionBaseline(
      task,
      "c".repeat(40),
      gitBaseline("src/T1.ts", parsedDigest.value),
    );
    expect(registered.start_sha).toBe("c".repeat(40));
    expect(registered.artifact_baseline).toEqual(gitBaseline("src/T1.ts", parsedDigest.value));
  });

  it("defensively refuses an empty authored roster at the exported boundary", () => {
    const forged = { ...command(), tasks: [] } as unknown as TaskGraphPopulationCommand;
    expect(populateTaskGraph(graph(), forged)).toMatchObject({
      ok: false,
      error: { kind: "no-tasks" },
    });
  });

  it.each([
    ["zero", [authoredTask("T1", 0)]],
    ["unsafe", [authoredTask("T1", Number.MAX_SAFE_INTEGER + 1)]],
    ["gap", [authoredTask("T1", 1), authoredTask("T3", 3)]],
  ])("refuses %s Wave topology before it becomes command authority", (_label, tasks) => {
    expect(parseAuthoredTaskRoster(tasks)).toMatchObject({ ok: false });
    const forged = { ...command(), tasks } as unknown as TaskGraphPopulationCommand;
    expect(populateTaskGraph(graph(), forged)).toMatchObject({
      ok: false,
      error: { kind: "invalid-task-waves" },
    });
  });

  it("returns typed overwrite refusal and preserves the aggregate", () => {
    const existing = graph({
      tasks: [{ ...authoredTask("T0", 1), status: "completed" } as never],
    });
    const result = populateTaskGraph(existing, command());

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "non-pending-tasks", message: expect.stringContaining("--force") },
    });
    expect(existing.tasks[0]?.status).toBe("completed");
  });

  it("persists and deeply freezes the prepared 'no spec file' observation of a plan with no Requirement trace", () => {
    const availability = Object.freeze({
      kind: "unavailable" as const,
      reason: Object.freeze({ kind: "no-spec-file" as const }),
    });
    const result = populateTaskGraph(
      graph({ spec_file: null }),
      command({ authoredSpecFile: undefined, specIndex: availability, observedSpecFile: null, tasks: roster([authoredTask("T1", 1, [])]) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = result.value.state.spec_index_observation;
    expect(observation).toEqual(availability);
    expect(Object.isFrozen(observation)).toBe(true);
    if (observation?.kind === "unavailable") expect(Object.isFrozen(observation.reason)).toBe(true);
  });

  it.each([
    {
      label: "unreadable spec",
      specFile: "spec.md",
      availability: Object.freeze({
        kind: "unavailable" as const,
        reason: Object.freeze({ kind: "unreadable" as const, path: "spec.md", reason: "EACCES" }),
      }),
    },
    {
      label: "invalid encoding",
      specFile: "spec.md",
      availability: Object.freeze({
        kind: "unavailable" as const,
        reason: Object.freeze({
          kind: "invalid-encoding" as const,
          path: "spec.md",
          contentDigest: parsedDigest.value,
          reason: "invalid UTF-8",
        }),
      }),
    },
    {
      label: "unparsed spec",
      specFile: "spec.md",
      availability: Object.freeze({
        kind: "unavailable" as const,
        reason: Object.freeze({
          kind: "unparsed" as const,
          path: "spec.md",
          contentDigest: parsedDigest.value,
          errors: Object.freeze([Object.freeze({
            kind: "missing-section" as const,
            section: "Functional Requirements" as const,
          })] as const),
        }),
      }),
    },
  ])("refuses a declared spec with a prepared $label observation, even with no Requirement trace", ({ specFile, availability }) => {
    const existing = graph({ spec_file: specFile });
    const result = populateTaskGraph(
      existing,
      command({
        authoredSpecFile: undefined,
        specIndex: availability,
        observedSpecFile: specFile,
        tasks: roster([authoredTask("T1", 1, [])]),
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "spec-index-unavailable" } });
    expect(existing.tasks).toEqual([]);
    // The observation the refusal names still compacts and freezes deeply.
    const observation = specIndexObservationOf(availability);
    expect(observation).toEqual(availability);
    expect(Object.isFrozen(observation)).toBe(true);
    if (observation.kind === "unavailable") {
      expect(Object.isFrozen(observation.reason)).toBe(true);
      if (observation.reason.kind === "unparsed") {
        expect(Object.isFrozen(observation.reason.errors)).toBe(true);
        expect(Object.isFrozen(observation.reason.errors[0])).toBe(true);
      }
    }
  });

  it("replaces a stale population observation whenever it replaces Tasks", () => {
    const stale = Object.freeze({
      kind: "indexed" as const,
      path: "spec.md",
      contentDigest: parsedDigest.value,
    });
    const unavailable = Object.freeze({
      kind: "unavailable" as const,
      reason: Object.freeze({ kind: "no-spec-file" as const }),
    });
    const result = populateTaskGraph(
      graph({ spec_file: null, spec_index_observation: stale }),
      command({
        authoredSpecFile: undefined, specIndex: unavailable, observedSpecFile: null, force: true,
        tasks: roster([authoredTask("T1", 1, [])]),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.spec_index_observation).toEqual(unavailable);
    expect(result.value.state.spec_index_observation).not.toEqual(stale);
  });

  it("removes every Wave authority tied to Tasks replaced by population", () => {
    const result = populateTaskGraph(graph({
      active_wave_completion_suite: { stale: true } as never,
      active_wave_gate: { stale: true } as never,
      wave_review_epoch: { stale: true } as never,
      spec_check: { stale: true } as never,
      wave_gate_history: [{ stale: true }] as never,
      wave_reopening_history: [{ stale: true }] as never,
      task_reopening_history: [{ stale: true }] as never,
      orphaned_wave_gate_history: [{ stale: true }] as never,
      spec_trace_wave_gate_retirements: [{ stale: true }] as never,
      spec_trace_amendments: [{ stale: true }] as never,
    }), command({ force: true }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const field of [
      "active_wave_completion_suite",
      "active_wave_gate",
      "wave_review_epoch",
      "spec_check",
      "wave_gate_history",
      "wave_reopening_history",
      "task_reopening_history",
      "orphaned_wave_gate_history",
      "spec_trace_wave_gate_retirements",
      "spec_trace_amendments",
    ] as const) {
      expect(result.value.state[field], field).toBeUndefined();
    }
  });

  it("detects locked spec_file drift without stamping hashes from another document", () => {
    const result = populateTaskGraph(graph({ spec_file: "changed.md" }), command());

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "spec-authority-changed",
        message: expect.stringContaining("changed from spec.md to changed.md"),
      },
    });
  });

  it("rejects a Spec Index that does not name the observed document", () => {
    const result = populateTaskGraph(graph(), command({
      specIndex: { ...specIndex, path: "other.md" },
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "spec-observation-mismatch" },
    });
  });

  it("derives exactly one pending gate and sanitized Task per canonical Wave", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 8 }),
      (waveCount) => {
        const waves = Array.from({ length: waveCount }, (_, index) => index + 1);
        const tasks = roster([
          authoredTask("T1", 1),
          ...waves.slice(1).map((wave) => authoredTask(`T${wave}`, wave)),
        ]);
        const result = populateTaskGraph(graph(), command({ tasks }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.waves).toEqual(waves);
        expect(Object.keys(result.value.state.wave_gates).map(Number)).toEqual(waves);
        expect(result.value.state.tasks).toHaveLength(tasks.length);
        for (const task of result.value.state.tasks) {
          expect(task).toMatchObject({
            status: "pending",
            review_status: "pending",
            findings: [],
            critical_findings: [],
            advisory_findings: [],
          });
        }
      },
    ));
  });
});

describe("populateTaskGraph stamps the plan's Acceptance Contracts", () => {
  // T1 writes CT-1 in Wave 1; T2 completes AS-001 in Wave 2; T3 is later work.
  const contractRoster = () => roster([
    { ...authoredTask("T1", 1, []), file_list: ["src/population-contract.ts", "tests/population.acceptance.test.ts"] },
    { ...authoredTask("T2", 2, ["AS-001"]), depends_on: ["T1"] },
    authoredTask("T3", 3),
  ]);

  it("persists each contract awaiting RED and waives task-level regression only inside its red window", () => {
    const result = populateTaskGraph(graph(), command({ tasks: contractRoster(), contracts: [CONTRACT] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.acceptance_contracts).toEqual([{
      schemaVersion: 1,
      id: "CT-1",
      title: "Population contract",
      statement: "Population installs pending Tasks.",
      contractTask: "T1",
      types: { kind: "file", path: "src/population-contract.ts" },
      acceptance: [{ path: "tests/population.acceptance.test.ts", anchors: ["AS-001"] }],
      supportedDomain: null,
      freeze: { state: "awaiting-red" },
      revisions: [],
    }]);
    const regression = Object.fromEntries(result.value.state.tasks.map(({ id, verification_policy }) =>
      [id, verification_policy?.regression]));
    expect(regression).toEqual({
      T1: { kind: "waived", reason: "acceptance-red-window" },
      T2: { kind: "waived", reason: "acceptance-red-window" },
      T3: { kind: "required" },
    });
    // The proof derives from the stamped policy: no regression obligation to fail.
    expect(result.value.state.tasks[0]!.proof!.obligations.map(({ kind }) => kind)).not.toContain("regression-test-pass");
    expect(result.value.state.tasks[2]!.proof!.obligations.map(({ kind }) => kind)).toContain("regression-test-pass");
  });

  it("keeps an authored regression waiver's own reason inside the window", () => {
    const tasks = roster([
      {
        ...authoredTask("T1", 1, []),
        file_list: ["src/population-contract.ts", "tests/population.acceptance.test.ts"],
        verification_policy: {
          regression: { kind: "waived", reason: "documentation-only" },
          new_tests: { kind: "required" },
        },
      },
      { ...authoredTask("T2", 2, ["AS-001"]), depends_on: ["T1"] },
    ]);
    const result = populateTaskGraph(graph(), command({ tasks, contracts: [CONTRACT] }));
    expect(result.ok && result.value.state.tasks[0]!.verification_policy?.regression)
      .toEqual({ kind: "waived", reason: "documentation-only" });
  });

  it("refuses a contract no single Task writes, and drops stale contracts on re-population without one", () => {
    expect(populateTaskGraph(graph(), command({ contracts: [CONTRACT] }))).toMatchObject({
      ok: false,
      error: { kind: "invalid-contracts" },
    });
    const first = populateTaskGraph(graph(), command({ tasks: contractRoster(), contracts: [CONTRACT] }));
    if (!first.ok) throw new Error(first.error.message);
    const repopulated = populateTaskGraph(first.value.state, command({ force: true }));
    expect(repopulated.ok && repopulated.value.state.acceptance_contracts).toBeUndefined();
  });
});

describe("populateTaskGraph owns the decompose → execute transition (issue #50 Gap 1)", () => {
  it("moves decompose → execute in the same write that installs the Tasks", () => {
    const result = populateTaskGraph(
      graph({ current_phase: "decompose", phase_artifacts: { architecture: "plan.md" } }),
      command(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.current_phase).toBe("execute");
    expect(result.value.state.phase_artifacts).toEqual({ architecture: "plan.md", decompose: "task_graph" });
    expect(result.value.state.tasks.map(({ id }) => id)).toEqual(["T1"]);
  });

  it("re-population during execute stays in execute", () => {
    const result = populateTaskGraph(
      graph({ current_phase: "execute", phase_artifacts: { decompose: "task_graph" } }),
      command(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.current_phase).toBe("execute");
    expect(result.value.state.phase_artifacts).toEqual({ decompose: "task_graph" });
  });

  it("succeeds exactly from decompose or execute, and success is always a populated execute graph", () => {
    fc.assert(fc.property(fc.constantFrom(...PHASES), (phase) => {
      const result = populateTaskGraph(graph({ current_phase: phase }), command());
      expect(result.ok).toBe(phase === "decompose" || phase === "execute");
      if (result.ok) {
        expect(result.value.state.current_phase).toBe("execute");
        expect(result.value.state.tasks.length).toBeGreaterThan(0);
      } else {
        expect(result.error).toEqual({
          kind: "phase-not-populatable",
          message: "populate-task-graph requires current_phase decompose (first population) or execute " +
            `(re-population), got ${phase}; finish the earlier phases first`,
        });
      }
    }));
  });
});

describe("populateTaskGraph stamps the plan's export bindings (AD-4)", () => {
  // T1 writes CT-1 in Wave 1; T2 implements the bound files in Wave 2.
  const boundRoster = () => roster([
    { ...authoredTask("T1", 1, []), file_list: ["src/population-contract.ts", "tests/population.acceptance.test.ts"] },
    { ...authoredTask("T2", 2, ["AS-001"]), depends_on: ["T1"], file_list: ["src/T2.ts", "src/T2-extra.ts"] },
  ]);
  const declaration = (text: string) => parseExportBindings(`**Export bindings:**\n${text}\n`);
  const BOTH = declaration("- `src/T2.ts` — CT-1: run: RunFn\n- `src/T2-extra.ts` — CT-1: extra: RunFn, more: RunFn");
  const boundCommand = (overrides: Partial<TaskGraphPopulationCommand> = {}) =>
    command({ tasks: boundRoster(), contracts: [CONTRACT], exportBindings: BOTH, ...overrides });
  const skeletonRecord = (path: string, contract = "CT-1"): SkeletonRecord => Object.freeze({
    path,
    contract,
    language: "typescript",
    origin: "spawn",
    engineSha256: "e".repeat(64),
    typesSha256: "f".repeat(64),
    stale: null,
  });

  it("stamps the validated bindings in plan order", () => {
    const result = populateTaskGraph(graph(), boundCommand());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.export_bindings).toEqual(BOTH.bindings);
    expect(result.value.state.export_bindings?.map(({ path }) => path)).toEqual(["src/T2.ts", "src/T2-extra.ts"]);
    expect(Object.isFrozen(result.value.state.export_bindings)).toBe(true);
  });

  it("stamps an empty list when the plan binds nothing, so a binding added later reads as drift", () => {
    const omitted = populateTaskGraph(graph(), command());
    expect(omitted.ok && omitted.value.state.export_bindings).toEqual([]);
    const empty = populateTaskGraph(graph(), command({ exportBindings: { bindings: [], problems: [] } }));
    expect(empty.ok && empty.value.state.export_bindings).toEqual([]);
  });

  it.each([
    ["an unknown contract", "- `src/T2.ts` — CT-9: run: RunFn", /src\/T2\.ts.*CT-9/],
    ["a malformed binding line", "- `src/T2.ts` — run: RunFn", /src\/T2\.ts/],
    ["a path no Task implements", "- `src/nowhere.ts` — CT-1: run: RunFn", /src\/nowhere\.ts.*file_list/],
    ["a frozen path", "- `src/population-contract.ts` — CT-1: run: RunFn", /frozen path of CT-1/],
  ])("refuses %s, so no graph is ever stamped with a binding plan validation refuses", (_label, text, message) => {
    const result = populateTaskGraph(graph(), boundCommand({ exportBindings: declaration(text) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-export-bindings");
    expect(result.error.message).toMatch(message);
  });

  it("loads back through the State File wire unchanged", () => {
    const result = populateTaskGraph(graph(), boundCommand());
    if (!result.ok) throw new Error(result.error.message);
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(result.value.state)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.export_bindings).toEqual(BOTH.bindings);
  });

  it("FR-031: re-population keeps each engine-written record whose path stays bound to its contract, and drops the rest", () => {
    const first = populateTaskGraph(graph(), boundCommand());
    if (!first.ok) throw new Error(first.error.message);
    const recorded: SkeletonGraph = {
      ...first.value.state,
      skeletons: [skeletonRecord("src/T2-extra.ts"), skeletonRecord("src/T2.ts"), skeletonRecord("src/T2.tsx", "CT-9")],
      tasks: first.value.state.tasks.map((entry) => entry.id === "T2"
        ? { ...entry, skeleton_outcomes: [{ path: "src/T2.ts", outcome: { kind: "skeleton-written", origin: "spawn" } }] }
        : entry),
    };

    const narrowed = populateTaskGraph(recorded, boundCommand({
      force: true,
      exportBindings: declaration("- `src/T2.ts` — CT-1: run: RunFn"),
    }));
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.value.state.skeletons).toEqual([skeletonRecord("src/T2.ts")]);
    // Outcomes are recorded at each registration, never carried across population.
    expect(narrowed.value.state.tasks.every((entry) => !("skeleton_outcomes" in entry))).toBe(true);
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(narrowed.value.state)));
    expect(parsed.ok && parsed.value.skeletons).toEqual([skeletonRecord("src/T2.ts")]);

    const unbound = populateTaskGraph(recorded, boundCommand({ force: true, exportBindings: { bindings: [], problems: [] } }));
    expect(unbound.ok).toBe(true);
    if (unbound.ok) expect("skeletons" in unbound.value.state).toBe(false);
  });
});
