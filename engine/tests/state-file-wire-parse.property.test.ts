/**
 * The State File load boundary over generated graphs.
 *
 * - Parsing is a fixed point under serialization: the graph a valid State
 *   File loads as, written back as JSON and loaded again, is the same graph,
 *   byte for byte, including a Task's nested authority fields. Every writer
 *   persists `parseTaskGraph`'s output, so a parse that changed its own output
 *   on the next load would drift the file on every write. The loaded bytes do
 *   not depend on the order the file wrote its keys in.
 * - `storedTaskErrors`, the all-errors mode, reports every findings rule
 *   beside the one refusal the parse stops at, once each.
 * - A Task field of the wrong type is refused with an error naming that
 *   field, whatever valid graph it sits in.
 * - A key no Task or TaskGraph field names is refused by name, and a valid
 *   graph loads exactly the fields it was given: the loaded graph is built
 *   from parsed fields only, so nothing rides along as raw JSON.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { match } from "ts-pattern";
import { parseStoredTask, parseTaskGraph, storedTaskErrors } from "../src/state-file-wire";
import { redThenGreenScope } from "../src/core/proof-obligations";
import { settleUnavailableImplementation } from "../src/core/implementation-application";
import { parseIsoInstant } from "../src/core/implementation-completion";
import { authorizeImplementationSpawn, createImplementationAttemptContext } from "../src/core/implementation-retry";
import { REVIEWER_PROTOCOL_V2 } from "../src/core/reviewer-contract";
import type { Task, TaskGraph, TaskStatus } from "../src/types";
import { executingGraphFixture, graphFixture, taskFixture, type TaskFixtureInput } from "./fixtures/task-lifecycle";

type TaskShape = Readonly<{
  status: TaskStatus;
  files: readonly string[];
  extras: Readonly<Record<string, unknown>>;
}>;

const STATUSES: readonly TaskStatus[] = ["pending", "implemented", "completed", "failed"];

/** Optional Task fields whose valid values need no other field beside them. */
const arbExtras: fc.Arbitrary<Readonly<Record<string, unknown>>> = fc.record({
  plan_context: fc.string({ maxLength: 12 }),
  review_status: fc.constantFrom("pending", "passed"),
  review_generation: fc.nat({ max: 50 }),
  findings: fc.constant([]),
  critical_findings: fc.constant([]),
  advisory_findings: fc.constant([]),
  refuted_findings: fc.constant([]),
  resolved_findings: fc.constant([]),
  test_result: fc.constant({ verdict: "trusted-pass" }),
  new_test_observation: fc.constantFrom(
    { kind: "not-written", written: false, evidence: "" },
    { kind: "written", written: true, evidence: "added tests/x.test.ts" },
  ),
  spec_anchor_hashes: fc.constant({}),
  failure_reason: fc.string({ maxLength: 8 }),
  start_sha: fc.constant("c".repeat(40)),
  test_evidence: fc.string({ maxLength: 8 }),
  retry_count: fc.nat({ max: 5 }),
  reserved_at: fc.constant("2026-11-21T08:00:00.000Z"),
  spec_anchors: fc.uniqueArray(fc.constantFrom("FR-001", "FR-002"), { maxLength: 2 }),
}, { requiredKeys: [] });

const arbTaskShape: fc.Arbitrary<TaskShape> = fc.record({
  status: fc.constantFrom(...STATUSES),
  files: fc.uniqueArray(fc.constantFrom("src/a.ts", "src/b.ts", "src/c/d.ts", "tests/a.test.ts"), { maxLength: 3 }),
  extras: arbExtras,
});

/**
 * The nested authority one generated Task may carry. Each value is built by
 * the fixture builder or the engine command that writes it, so a generated
 * graph holds only shapes the engine itself persists.
 */
const NESTED_AUTHORITIES = [
  "none",
  "verification-policy",
  "attestation",
  "artifact-baseline",
  "issued-review-packet",
  "review-run",
  "accepted-review",
  "executing-attempt",
  "settled-attempt",
] as const;
type NestedAuthority = (typeof NESTED_AUTHORITIES)[number];

type TaskDraft = Readonly<{ wave: number; shape: TaskShape; dependsOnEarlier: boolean; authority: NestedAuthority }>;

/** An attempt authority lives only on a pending Task the graph lists as executing. */
const holdsAttempt = (authority: NestedAuthority): boolean =>
  authority === "executing-attempt" || authority === "settled-attempt";

/** The Task fields an authority adds before the fixture derives the Task's Proof. */
function authorityInput(authority: NestedAuthority): Partial<TaskFixtureInput> {
  return match(authority)
    .with("verification-policy", () => ({
      verification_policy: {
        regression: { kind: "required" as const },
        new_tests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
      },
    }))
    // Attestation mode dispatches no new work, so its policy waives new tests.
    .with("attestation", () => ({
      implementation_attestation: true as const,
      verification_policy: {
        regression: { kind: "required" as const },
        new_tests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
      },
    }))
    .otherwise(() => ({}));
}

/** The review and baseline authority an engine writer stamps on a built Task. */
function authorityFields(authority: NestedAuthority, task: Task): Readonly<Record<string, unknown>> {
  // A review scope is stored sorted and unique.
  const scope = task.file_list?.length ? [...task.file_list].sort() : ["src/a.ts"];
  return match(authority)
    .with("artifact-baseline", () => ({
      artifact_baseline: (task.file_list ?? []).map((artifact) => ({ artifact, snapshot: { kind: "missing" } })),
    }))
    .with("issued-review-packet", () => ({
      issued_review_packets: [{
        task_id: task.id, packet_id: "b".repeat(64), packet_path: `.claude/reviews/${task.id}.json`,
        base_sha: "a".repeat(40), head_sha: "c".repeat(40), scope,
      }],
    }))
    .with("review-run", () => ({
      review_status: "pending",
      review_generation: 2,
      review_run: {
        generation: 2, packet_id: "b".repeat(64), head_sha: "2".repeat(40), expected_agents: ["code-reviewer"],
        prior_finding_ids: [], evidence: [],
        slot_authority: [{ agent: "code-reviewer", slot_id: "review-slot:current", attempted: 1 }],
      },
    }))
    .with("accepted-review", () => ({
      review_status: "passed",
      review_generation: 1,
      accepted_review_authority: {
        generation: 1, packet_id: "a".repeat(64), head_sha: "b".repeat(40), scope,
        run_id: "run.current", authority_digest: "a".repeat(64),
        reviewer_protocol: REVIEWER_PROTOCOL_V2, subject_digest: "f".repeat(64),
      },
    }))
    .otherwise(() => ({}));
}

const SETTLED_AT = (() => {
  const instant = parseIsoInstant("2026-11-21T09:00:00.000Z", "fixture settlement instant");
  if (!instant.ok) throw new Error(instant.error.errors.join("; "));
  return instant.value;
})();

/**
 * Register each executing Task's attempt the way a modern implementation
 * dispatch does: its `active_implementation_context` and protocol-2 retry
 * lineage, which any attempt history the Task later keeps requires.
 */
function withDispatchLineage(graph: TaskGraph): TaskGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const authority = task.active_implementation_attempt;
      if (authority === undefined) return task;
      const prompt = `Task ID: ${task.id}`;
      const admission = authorizeImplementationSpawn({ id: task.id }, prompt);
      if (!admission.ok) throw new Error(admission.error);
      return {
        ...task,
        active_implementation_context: createImplementationAttemptContext({ authority, prompt, admission }),
        implementation_retry_protocol: 2,
        implementation_retry_history_start: 0,
      };
    }),
  };
}

/**
 * Settle each listed Task's executing attempt as the engine does when its
 * observation is unavailable: the attempt is released into the Task's
 * `implementation_attempt_history` and the Task awaits revalidation.
 */
function settleAttempts(graph: TaskGraph, taskIds: readonly string[]): TaskGraph {
  return taskIds.reduce((state, taskId) => {
    const authority = state.tasks.find((task) => task.id === taskId)?.active_implementation_attempt;
    if (authority === undefined) throw new Error(`fixture Task ${taskId} holds no attempt`);
    const settled = settleUnavailableImplementation(state, authority, SETTLED_AT, "fixture observation unavailable");
    if (settled.kind === "error") throw new Error(`fixture settlement of ${taskId} failed: ${JSON.stringify(settled.error)}`);
    return settled.state;
  }, graph);
}

/** An execute-phase graph of `drafts`: Tasks in Waves 1..n, each depending only on earlier Waves. */
function graphOfDrafts(drafts: readonly TaskDraft[]): Record<string, unknown> {
  const ordered = [...drafts].sort((left, right) => left.wave - right.wave);
  const tasks: Task[] = ordered.map(({ wave, shape, dependsOnEarlier, authority }, index) => {
    const earlier = ordered.findIndex((draft) => draft.wave < wave);
    const dependsOn = dependsOnEarlier && earlier >= 0 && earlier < index ? [`T${earlier + 1}`] : [];
    // An attesting Task changes no declared file, while the fixture's default
    // satisfied Proof records every declared file as changed: it declares none.
    const files = authority === "attestation" ? [] : shape.files;
    const task = taskFixture({
      id: `T${index + 1}`,
      description: `Task ${index + 1}`,
      agent: "code-implementer-agent",
      wave,
      depends_on: dependsOn,
      file_list: [...files],
      ...(files.length > 0 ? { files_modified: [files[0]] } : {}),
      status: holdsAttempt(authority) ? "pending" : shape.status,
      ...shape.extras,
      ...authorityInput(authority),
    });
    return { ...task, ...authorityFields(authority, task) } as Task;
  });
  const idsWhere = (holds: (authority: NestedAuthority) => boolean) =>
    ordered.flatMap(({ authority }, index) => holds(authority) ? [`T${index + 1}`] : []);
  const attempting = idsWhere(holdsAttempt);
  const base: TaskGraph = graphFixture(tasks);
  const executing = attempting.length === 0 ? base : withDispatchLineage(executingGraphFixture(base, attempting));
  const settled = settleAttempts(executing, idsWhere((authority) => authority === "settled-attempt"));
  return JSON.parse(JSON.stringify(settled)) as Record<string, unknown>;
}

const arbDraft = (authority: fc.Arbitrary<NestedAuthority>): fc.Arbitrary<TaskDraft> =>
  fc.record({ wave: fc.integer({ min: 1, max: 3 }), shape: arbTaskShape, dependsOnEarlier: fc.boolean(), authority });

/** A valid execute-phase graph whose Tasks carry scalar fields only. */
const arbValidGraph = fc.array(arbDraft(fc.constant("none")), { minLength: 1, maxLength: 5 }).map(graphOfDrafts);

/** A valid execute-phase graph whose Tasks may each carry one nested authority. */
const arbAuthorityGraph = fc.array(arbDraft(fc.constantFrom(...NESTED_AUTHORITIES)), { minLength: 1, maxLength: 5 })
  .map(graphOfDrafts);

describe("parseTaskGraph is a fixed point under serialization", () => {
  it("loads, writes and reloads every valid graph unchanged", () => {
    fc.assert(fc.property(arbValidGraph, (raw) => {
      const first = parseTaskGraph(raw);
      if (!first.ok) throw new Error(`generated graph refused: ${first.error}`);
      const written = JSON.stringify(first.value);
      const second = parseTaskGraph(JSON.parse(written));
      if (!second.ok) throw new Error(`reloaded graph refused: ${second.error}`);
      expect(second.value).toEqual(first.value);
      expect(JSON.stringify(second.value)).toBe(written);
    }), { numRuns: 200, seed: 20261121 });
  });

  // The nested authority fields are rebuilt field by field by their own
  // parsers, the likeliest place for a parse that drops or reshapes a value
  // on its own output.
  it("generates every nested authority field the next property relies on", () => {
    const generated = new Set(fc.sample(arbAuthorityGraph, { numRuns: 200, seed: 20261123 })
      .flatMap((raw) => (raw.tasks as Record<string, unknown>[]).flatMap((task) => Object.keys(task))));
    for (const field of [
      "proof", "verification_policy", "implementation_attestation", "artifact_baseline", "issued_review_packets",
      "review_run", "accepted_review_authority", "active_implementation_attempt", "active_implementation_context",
      "implementation_attempt_history",
    ]) expect(generated).toContain(field);
  });

  it("loads, writes and reloads a Task carrying each nested authority field unchanged", () => {
    fc.assert(fc.property(arbAuthorityGraph, (raw) => {
      const first = parseTaskGraph(raw);
      if (!first.ok) throw new Error(`generated graph refused: ${first.error}`);
      const written = JSON.stringify(first.value);
      const second = parseTaskGraph(JSON.parse(written));
      if (!second.ok) throw new Error(`reloaded graph refused: ${second.error}`);
      expect(JSON.stringify(second.value)).toBe(written);
    }), { numRuns: 200, seed: 20261123 });
  });

  // The loaded graph is assembled from parsed fields in the parser's own
  // order, so its serialization, and every digest taken over it, does not
  // depend on the order the file wrote its top-level and Task keys in.
  it("loads the same bytes whatever order the file wrote its keys in", () => {
    const reversed = (record: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(record).reverse());
    fc.assert(fc.property(fc.oneof(arbValidGraph, arbAuthorityGraph), (raw) => {
      const tasks = raw.tasks as Record<string, unknown>[];
      const shuffled = reversed({ ...raw, tasks: tasks.map(reversed) });
      const inOrder = parseTaskGraph(raw);
      const outOfOrder = parseTaskGraph(shuffled);
      if (!inOrder.ok || !outOfOrder.ok) throw new Error("generated graph refused");
      expect(JSON.stringify(outOfOrder.value)).toBe(JSON.stringify(inOrder.value));
    }), { numRuns: 200, seed: 20261122 });
  });
});

/** One Task field set to a value of the wrong type. */
const WRONG_TYPES: readonly (readonly [field: string, wrong: unknown])[] = [
  ["description", 5],
  ["agent", 5],
  ["wave", "1"],
  ["depends_on", "T1"],
  ["file_list", "src/a.ts"],
  ["files_modified", "src/a.ts"],
  ["status", 5],
  ["proof", 5],
  ["verification_policy", 5],
  ["implementation_attestation", "yes"],
  ["revalidation_required", "yes"],
  ["review_status", 5],
  ["review_generation", "1"],
  ["plan_context", 5],
  ["spec_anchor_hashes", "x"],
  ["test_result", 5],
  ["new_test_observation", 5],
  ["findings", 5],
  ["critical_findings", 5],
  ["advisory_findings", 5],
  ["refuted_findings", 5],
  ["resolved_findings", 5],
  ["artifact_baseline", 5],
  ["attempt_repository_baseline", 5],
  ["repository_baseline", 5],
  ["issued_review_packets", 5],
  ["accepted_review_authority", 5],
  ["review_basis", 5],
  ["implementation_attempt_history", 5],
  ["skeleton_outcomes", 5],
  ["artifact_baseline_recovered_from", 5],
  ["recovered_artifact_writes", 5],
  ["new_tests_required", "yes"],
  ["review_run", 5],
  ["review_error", 5],
  ["review_evidence_failures", 5],
  ["spec_anchors", 5],
  ["spec_anchors", [""]],
  ["test_evidence", 5],
  ["reserved_at", 5],
  ["start_sha", 5],
  ["failure_reason", 5],
  ["retry_count", "1"],
  ["retry_count", -1],
];

describe("storedTaskErrors, the all-errors mode", () => {
  const task = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...(JSON.parse(JSON.stringify(taskFixture({ id: "T1", description: "Task 1", agent: "code-implementer-agent", wave: 1, depends_on: [], status: "pending" }))) as Record<string, unknown>),
    ...overrides,
  });
  const scope = redThenGreenScope(undefined, []);

  it("reports every findings rule beside the refusal the parse stops at, once each", () => {
    const errors = storedTaskErrors(task({ description: "", findings: 5, critical_findings: [1] }), 0, scope);
    expect(errors).toEqual([
      'tasks[0] ("T1"): findings must be an array when present',
      'tasks[0] ("T1"): critical_findings[0] must be a string, got 1 (repair and install atomically with: helper repair-task-graph)',
      'tasks[0] ("T1"): description must be a non-empty string, got ""',
    ]);
  });

  it("is the parse's one refusal when no findings rule breaks, and empty for a loadable Task", () => {
    const valid = task({});
    expect(parseStoredTask(valid, 0, scope).ok).toBe(true);
    expect(storedTaskErrors(valid, 0, scope)).toEqual([]);
    expect(storedTaskErrors(task({ wave: 0 }), 0, scope)).toEqual([
      'tasks[0] ("T1"): wave must be an integer >= 1 within the safe-integer range, got 0',
    ]);
  });

  it("does not repeat the findings refusal the parse also stops at", () => {
    const errors = storedTaskErrors(task({ findings: 5 }), 0, scope);
    expect(errors).toEqual(['tasks[0] ("T1"): findings must be an array when present']);
  });
});

describe("a Task field of the wrong type is refused by name", () => {
  it("names the mutated field in the load error", () => {
    fc.assert(fc.property(
      arbValidGraph,
      fc.nat(),
      fc.constantFrom(...WRONG_TYPES),
      (raw, pick, [field, wrong]) => {
        const tasks = raw.tasks as Record<string, unknown>[];
        const index = pick % tasks.length;
        const mutated = { ...raw, tasks: tasks.map((task, at) => at === index ? { ...task, [field]: wrong } : task) };
        const parsed = parseTaskGraph(mutated);
        if (parsed.ok) throw new Error(`a wrong-typed ${field} loaded`);
        // The field itself, not a longer one containing it (`findings` in `critical_findings`).
        expect(parsed.error).toMatch(new RegExp(`(?<![a-z_])${field}(?![a-z_])`));
      },
    ), { numRuns: 400, seed: 20261121 });
  });
});

/** A key no Task or TaskGraph field names: every field is snake_case without an `x_` prefix. */
const arbUnknownKey = fc.stringMatching(/^[a-z]{1,10}$/).map((word) => `x_${word}`);

describe("a key no Task or TaskGraph field names is refused by name", () => {
  it("refuses an unknown Task key in any valid graph", () => {
    fc.assert(fc.property(arbValidGraph, fc.nat(), arbUnknownKey, fc.jsonValue(), (raw, pick, key, value) => {
      const tasks = raw.tasks as Record<string, unknown>[];
      const index = pick % tasks.length;
      const mutated = { ...raw, tasks: tasks.map((task, at) => at === index ? { ...task, [key]: value } : task) };
      const parsed = parseTaskGraph(mutated);
      if (parsed.ok) throw new Error(`an unknown Task key ${key} loaded`);
      expect(parsed.error).toBe(
        `tasks[${index}] ("T${index + 1}"): unknown Task field ${JSON.stringify(key)}; the State File stores only the fields this engine writes`,
      );
    }), { numRuns: 200, seed: 20261122 });
  });

  it("refuses an unknown TaskGraph key in any valid graph", () => {
    fc.assert(fc.property(arbValidGraph, arbUnknownKey, fc.jsonValue(), (raw, key, value) => {
      expect(parseTaskGraph({ ...raw, [key]: value })).toEqual({
        ok: false,
        error: `unknown TaskGraph field ${JSON.stringify(key)}; the State File stores only the fields this engine writes`,
      });
    }), { numRuns: 200, seed: 20261122 });
  });

  it("loads every generated Task field it was given, and no other", () => {
    fc.assert(fc.property(arbValidGraph, (raw) => {
      const parsed = parseTaskGraph(raw);
      if (!parsed.ok) throw new Error(`generated graph refused: ${parsed.error}`);
      const tasks = raw.tasks as Record<string, unknown>[];
      parsed.value.tasks.forEach((task, index) => {
        expect(Object.keys(task).sort()).toEqual(Object.keys(tasks[index]!).sort());
      });
      expect(Object.keys(parsed.value).sort()).toEqual(Object.keys(raw).sort());
    }), { numRuns: 200, seed: 20261122 });
  });
});
