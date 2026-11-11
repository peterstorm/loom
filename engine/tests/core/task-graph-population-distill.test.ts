/**
 * ADR-0068 §1–§2: population adds the Distill Tasks. At most one per Wave,
 * after the authored Tasks, with exactly the fields the State File load
 * boundary then demands; none when the operator switched the pass off or a
 * Wave has no implementation file; an authored Task naming the distill agent
 * is refused; and re-population replaces the roster instead of adding to it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isDistillTask } from "../../src/core/distill-task";
import { DECISION_RECORD_AGENT, DISTILL_AGENT } from "../../src/core/model-profiles";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
  type TaskGraphPopulationCommand,
} from "../../src/core/task-graph-population";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  legacyDefaultVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { DISTILL_VERIFICATION_POLICY, serializeVerificationPolicy } from "../../src/core/verification-policy";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { PlanContract, Task, TaskGraph } from "../../src/types";

const authoredTask = (id: string, wave: number, files: readonly string[], agent = "code-implementer-agent"): AuthoredTask =>
  Object.freeze({
    id,
    description: `implement ${id}`,
    agent,
    wave,
    depends_on: Object.freeze([]),
    spec_anchors: Object.freeze([]),
    spec_contributions: Object.freeze([]),
    verification_policy: Object.freeze({
      regression: Object.freeze({ kind: "required" as const }),
      new_tests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" as const }),
    }),
    file_list: Object.freeze([...files]),
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
  spec_file: null,
  plan_file: "plan.md",
  tasks: [],
  wave_gates: {},
  ...overrides,
});

const command = (overrides: Partial<TaskGraphPopulationCommand> = {}): TaskGraphPopulationCommand => ({
  planTitle: "Distill plan",
  validatedPlanFile: "plan.md",
  tasks: roster([authoredTask("T1", 1, ["src/a.ts"])]),
  verificationManifest: defaultVerificationManifest(),
  specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } },
  observedSpecFile: null,
  force: false,
  proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" },
  contracts: [],
  invariants: [],
  ...overrides,
});

const operatorManifest = (document: Readonly<Record<string, unknown>>): FrozenVerificationManifest => {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    ...document,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
};

const populated = (overrides: Partial<TaskGraphPopulationCommand> = {}, existing: TaskGraph = graph()): TaskGraph => {
  const result = populateTaskGraph(existing, command(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
};

const distillTasksOf = (state: TaskGraph): readonly Task[] => state.tasks.filter(isDistillTask);

const viaDisk = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Distill contract",
  declaration: {
    kind: "declared",
    types: { kind: "file", path: "src/contract-types.ts" },
    acceptance: [{ path: "tests/contract.acceptance.test.ts", anchors: ["AS-001"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: "The contract freezes its types and acceptance tests.",
  },
};

describe("population adds one Distill Task per eligible Wave", () => {
  const twoWaves = roster([
    authoredTask("T1", 1, ["src/a.ts", "tests/a.test.ts"]),
    authoredTask("T2", 1, ["src/b.ts", "src/a.ts"]),
    authoredTask("T3", 2, ["src/c.ts"]),
  ]);

  it("appends them after the authored Tasks, numbered after the highest authored id, in Wave order", () => {
    const state = populated({ tasks: twoWaves });
    expect(state.tasks.map(({ id, wave, agent }) => [id, wave, agent])).toEqual([
      ["T1", 1, "code-implementer-agent"],
      ["T2", 1, "code-implementer-agent"],
      ["T3", 2, "code-implementer-agent"],
      ["T4", 1, DISTILL_AGENT],
      ["T5", 2, DISTILL_AGENT],
    ]);
  });

  it("writes exactly the fields ADR-0068 §2 names, and nothing an authored Task would carry besides", () => {
    const [first] = distillTasksOf(populated({ tasks: twoWaves }));
    expect(first).toEqual({
      id: "T4",
      description: expect.stringContaining("Distill pass for Wave 1"),
      agent: DISTILL_AGENT,
      wave: 1,
      status: "pending",
      depends_on: [],
      spec_anchors: [],
      spec_contributions: [],
      verification_policy: serializeVerificationPolicy(DISTILL_VERIFICATION_POLICY),
      // The Wave's implementation files, deduplicated in first-appearance order; the test file is left out.
      file_list: ["src/a.ts", "src/b.ts"],
      proof: derivePendingTaskProof({
        verificationPolicy: DISTILL_VERIFICATION_POLICY,
        declaredArtifacts: ["src/a.ts", "src/b.ts"],
        declaredArtifactExpectation: "preserved",
      }),
      review_status: "pending",
      review_generation: 0,
      findings: [],
      critical_findings: [],
      advisory_findings: [],
      refuted_findings: [],
      resolved_findings: [],
    });
    expect(first?.proof?.obligations).toEqual([{ kind: "task-completed" }, { kind: "behaviour-preserved" }]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("stamps start_sha as every Task gets it, and never a population artifact_baseline", () => {
    const revision = "b".repeat(40);
    const state = populated({
      tasks: twoWaves,
      proofBoundary: {
        kind: "captured",
        revision,
        baselines: new Map(twoWaves.map((task) => [
          task.id,
          task.file_list.map((artifact) => ({ artifact, snapshot: { kind: "missing" as const } })),
        ])),
      },
    });
    for (const task of distillTasksOf(state)) {
      expect(task.start_sha).toBe(revision);
      expect("artifact_baseline" in task).toBe(false);
    }
    expect(state.tasks.find(({ id }) => id === "T1")?.artifact_baseline).toBeDefined();
  });

  it("never creates a Wave: the Wave Gates and reported Waves are the authored ones", () => {
    const result = populateTaskGraph(graph(), command({ tasks: twoWaves }));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.waves).toEqual([1, 2]);
    expect(Object.keys(result.value.state.wave_gates)).toEqual(["1", "2"]);
  });

  it("leaves a contract's frozen paths and its contract Task out of the scope", () => {
    const state = populated({
      contracts: [CONTRACT],
      verificationManifest: operatorManifest({
        checks: [{
          id: "project:verify",
          scope: "wave",
          executable: "npm",
          args: ["run", "verify"],
          cwd: ".",
          timeoutMs: 60_000,
          report: { kind: "required-file", path: ".loom/completion-reports/verify.junit.xml" },
        }],
      }),
      tasks: roster([
        authoredTask("T1", 1, ["src/contract-types.ts", "tests/contract.acceptance.test.ts", "src/stub.ts"]),
        authoredTask("T2", 1, ["src/impl.ts"]),
      ]),
    });
    expect(distillTasksOf(state).map(({ file_list }) => file_list)).toEqual([["src/impl.ts"]]);
    expect(parseTaskGraph(viaDisk(state)).ok).toBe(true);
  });
});

describe("population adds no Distill Task", () => {
  it("when the operator's manifest says distillPass off", () => {
    const state = populated({ verificationManifest: operatorManifest({ distillPass: "off" }) });
    expect(distillTasksOf(state)).toEqual([]);
    expect(state.tasks.map(({ id }) => id)).toEqual(["T1"]);
  });

  it("adds it when the operator's manifest says distillPass on, or declares nothing", () => {
    expect(distillTasksOf(populated({ verificationManifest: operatorManifest({ distillPass: "on" }) }))).toHaveLength(1);
    expect(distillTasksOf(populated({ verificationManifest: operatorManifest({}) }))).toHaveLength(1);
  });

  it("for a Wave whose Tasks list only test files", () => {
    const state = populated({
      tasks: roster([authoredTask("T1", 1, ["tests/a.test.ts"]), authoredTask("T2", 2, ["src/b.ts"])]),
    });
    expect(distillTasksOf(state).map(({ id, wave }) => [id, wave])).toEqual([["T3", 2]]);
  });

  it("for a Wave of ADR Tasks, whose documents are not code", () => {
    const state = populated({
      tasks: roster([
        authoredTask("T1", 1, ["src/a.ts"]),
        authoredTask("T2", 2, ["docs/adr/ADR-0001-a.md"], DECISION_RECORD_AGENT),
      ]),
    });
    expect(distillTasksOf(state).map(({ wave }) => wave)).toEqual([1]);
  });

  it("when the frozen manifest carries no Test-File Classification", () => {
    expect(distillTasksOf(populated({ verificationManifest: legacyDefaultVerificationManifest() }))).toEqual([]);
  });
});

describe("an authored Task naming the distill agent is refused", () => {
  const authored = [authoredTask("T1", 1, ["src/a.ts"]), authoredTask("T2", 1, ["src/a.ts"], DISTILL_AGENT)];
  const REFUSAL = /Task T2: agent 'distill-agent' is engine-only; the distill pass is engine-added.*Remove the Task/;

  it("by the authored roster parser", () => {
    const parsed = parseAuthoredTaskRoster(authored);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(REFUSAL);
  });

  it("by population itself, for a caller that bypassed the parser", () => {
    const result = populateTaskGraph(graph(), { ...command(), tasks: authored as unknown as TaskGraphPopulationCommand["tasks"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("authored-distill-task");
      expect(result.error.message).toMatch(REFUSAL);
    }
  });

  it("by decompose-payload validation, before population is reached", () => {
    const validation = validateFull({
      spec_trace_version: 2,
      plan_title: "Distill plan",
      plan_file: "plan.md",
      spec_file: "spec.md",
      tasks: authored,
    }, "decompose-payload");
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.some((error) => REFUSAL.test(error))).toBe(true);
  });

  it("and an authored policy cannot claim the distill-pass waiver either", () => {
    const validation = validateFull({
      spec_trace_version: 2,
      plan_title: "Distill plan",
      plan_file: "plan.md",
      spec_file: "spec.md",
      tasks: [{ ...authoredTask("T1", 1, ["src/a.ts"]), verification_policy: serializeVerificationPolicy(DISTILL_VERIFICATION_POLICY) }],
    }, "decompose-payload");
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.join("\n")).toMatch(/verification_policy\.regression\.reason must be one of/);
  });
});

describe("a populated graph with Distill Tasks is State File authority", () => {
  it("round-trips through the State File parser unchanged", () => {
    const state = populated({
      tasks: roster([authoredTask("T1", 1, ["src/a.ts", "tests/a.test.ts"]), authoredTask("T2", 2, ["src/b.ts"])]),
    });
    const parsed = parseTaskGraph(viaDisk(state));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(viaDisk(parsed.value)).toEqual(viaDisk(state));
    expect(parsed.value.tasks.filter(isDistillTask).map(({ id }) => id)).toEqual(["T3", "T4"]);
  });

  it("re-population with --force replaces an earlier graph's Distill Tasks instead of adding to them", () => {
    const first = populated();
    expect(first.tasks.map(({ id }) => id)).toEqual(["T1", "T2"]);
    const again = populated({ force: true }, first);
    expect(viaDisk(again)).toEqual(viaDisk(first));
    const widened = populated({
      force: true,
      tasks: roster([authoredTask("T1", 1, ["src/a.ts"]), authoredTask("T2", 1, ["src/b.ts"])]),
    }, first);
    expect(widened.tasks.map(({ id, agent }) => [id, agent])).toEqual([
      ["T1", "code-implementer-agent"],
      ["T2", "code-implementer-agent"],
      ["T3", DISTILL_AGENT],
    ]);
    expect(parseTaskGraph(viaDisk(widened)).ok).toBe(true);
  });
});

describe("property: for any authored roster, population's output loads and no Wave has two Distill Tasks", () => {
  const FILES = ["src/a.ts", "src/b.ts", "src/c.tsx", "tests/a.test.ts", "tests/b.spec.ts", "docs/notes.md"] as const;
  const AGENTS = ["code-implementer-agent", "ts-test-agent", DECISION_RECORD_AGENT] as const;
  const authoredRoster = fc
    .array(
      fc.record({
        wave: fc.integer({ min: 1, max: 3 }),
        files: fc.uniqueArray(fc.constantFrom(...FILES), { maxLength: 4 }),
        agent: fc.constantFrom(...AGENTS),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map((drafts) => {
      // Waves must be contiguous from 1: rank the drawn Waves.
      const waves = [...new Set(drafts.map(({ wave }) => wave))].sort((left, right) => left - right);
      return drafts.map((draft, index) =>
        authoredTask(`T${index + 1}`, waves.indexOf(draft.wave) + 1, draft.files, draft.agent));
    });

  it("holds for the engine default and for both operator settings", () => {
    const manifests = [
      defaultVerificationManifest(),
      operatorManifest({ distillPass: "off" }),
      operatorManifest({ distillPass: "on", testFileSuffixes: [".spec.ts"] }),
    ];
    fc.assert(fc.property(authoredRoster, fc.constantFrom(...manifests), (tasks, verificationManifest) => {
      const state = populated({ tasks: roster(tasks), verificationManifest });
      const parsed = parseTaskGraph(viaDisk(state));
      expect(parsed.ok ? null : parsed.error).toBeNull();
      const distill = distillTasksOf(state);
      expect(new Set(distill.map(({ wave }) => wave)).size).toBe(distill.length);
      expect(state.tasks.slice(0, tasks.length).map(({ id }) => id)).toEqual(tasks.map(({ id }) => id));
      expect(state.tasks.slice(tasks.length).every(isDistillTask)).toBe(true);
      // The scope is its Wave siblings' files and nothing else.
      for (const task of distill) {
        const siblingFiles = tasks.filter(({ wave }) => wave === task.wave).flatMap(({ file_list }) => file_list);
        expect((task.file_list ?? []).every((path) => siblingFiles.includes(path))).toBe(true);
      }
      // Idempotent: populating again over the result changes nothing.
      expect(viaDisk(populated({ tasks: roster(tasks), verificationManifest, force: true }, state))).toEqual(viaDisk(state));
    }));
  });
});
