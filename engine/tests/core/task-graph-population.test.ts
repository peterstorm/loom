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
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import type { TaskGraph } from "../../src/types";

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
  ...overrides,
});

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

  it.each([
    {
      label: "no spec file",
      specFile: null,
      availability: Object.freeze({
        kind: "unavailable" as const,
        reason: Object.freeze({ kind: "no-spec-file" as const }),
      }),
    },
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
  ])("persists and deeply freezes the prepared $label observation", ({ specFile, availability }) => {
    const result = populateTaskGraph(
      graph({ spec_file: specFile }),
      command({
        authoredSpecFile: undefined,
        specIndex: availability,
        observedSpecFile: specFile,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = result.value.state.spec_index_observation;
    expect(observation).toEqual(availability);
    expect(Object.isFrozen(observation)).toBe(true);
    if (observation?.kind === "unavailable") {
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
      reason: Object.freeze({ kind: "unreadable" as const, path: "spec.md", reason: "EIO" }),
    });
    const result = populateTaskGraph(
      graph({ spec_index_observation: stale }),
      command({ specIndex: unavailable, force: true }),
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
      orphaned_wave_gate_history: [{ stale: true }] as never,
      spec_trace_wave_gate_retirements: [{ stale: true }] as never,
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
      "orphaned_wave_gate_history",
      "spec_trace_wave_gate_retirements",
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
