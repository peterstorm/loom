import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import populate from "../../src/handlers/helpers/populate-task-graph";
import type { Task, TaskGraph } from "../../src/types";

/**
 * Exercises the REAL populate-task-graph overwrite guard through the handler's
 * entry point — not a re-implemented copy. The handler resolves LOOM_STATE_PATH
 * lazily (taskGraphPath() at call time), so pointing it at a per-test state file
 * needs no module reload. A model-free plan file passes checkPlanModelBindings
 * trivially, so control reaches the overwrite guard at populate-task-graph.ts:126.
 */

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  delete process.env.LOOM_STATE_PATH;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-populate-guard-"));
  dirs.push(dir);
  return dir;
}

/** A readable plan declaring no models — the binding check passes trivially. */
function modelFreePlan(dir: string): string {
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# Plan\n\nNo models.\n");
  return planFile;
}

function writeState(dir: string, planFile: string, tasks: Task[]): string {
  const statePath = join(dir, "active_task_graph.json");
  const state: TaskGraph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: planFile,
    tasks,
    wave_gates: {},
  };
  writeFileSync(statePath, JSON.stringify(state));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

function existingTask(id: string, status: Task["status"]): Task {
  return { id, description: "x", agent: "code-implementer-agent", wave: 1, status, depends_on: [] };
}

const REQUIRED_VERIFICATION = Object.freeze({
  regression: Object.freeze({ kind: "required" as const }),
  new_tests: Object.freeze({ kind: "required" as const }),
});

function decomposeJson(planFile: string): string {
  return JSON.stringify({
    spec_trace_version: 2,
    plan_title: "t",
    spec_file: "spec.md",
    plan_file: planFile,
    tasks: [{ id: "T9", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: [], verification_policy: REQUIRED_VERIFICATION, plan_context: "", file_list: ["src/other.ts"] }],
  });
}

describe("populate-task-graph — state authority diagnostics", () => {
  it("reports a present-but-unreadable graph instead of calling it absent", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    process.env.LOOM_STATE_PATH = dir;

    const result = await populate(decomposeJson(plan), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain(`Cannot read task graph at ${dir}`);
      expect(result.message).not.toContain("No task graph");
    }
  });
});

describe("populate-task-graph — overwrite guard (funneled through the real handler)", () => {
  it("blocks overwriting a graph with a non-pending task (no --force)", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, [
      existingTask("T1", "implemented"),
      existingTask("T2", "pending"),
    ]);
    const result = await populate(decomposeJson(plan), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("non-pending");
    // The guard actually prevented the write — the old tasks survive.
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
  });

  it("allows overwriting a non-pending graph WITH --force (guard bypassed, tasks replaced)", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, [existingTask("T1", "completed")]);
    const result = await populate(decomposeJson(plan), ["--force"]);
    expect(result.kind).toBe("passthrough");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks.map((t) => t.id)).toEqual(["T9"]);
  });

  it("allows overwriting when every existing task is pending (no --force needed)", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, [existingTask("T1", "pending"), existingTask("T2", "pending")]);
    const result = await populate(decomposeJson(plan), []);
    expect(result.kind).toBe("passthrough");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks.map((t) => t.id)).toEqual(["T9"]);
  });
});

describe("populate-task-graph — argument parsing", () => {
  it.each([
    { args: ["--issue", "abc"], diagnostic: "positive integer" },
    { args: ["--issue", "0"], diagnostic: "positive integer" },
    { args: ["--issue", "-1"], diagnostic: "positive integer" },
    { args: ["--issue", "1.5"], diagnostic: "positive integer" },
    { args: ["--issue", "9007199254740992"], diagnostic: "safe positive integer" },
    { args: ["--issue", "--fix"], diagnostic: "requires a positive integer" },
  ])("rejects malformed issue authority: $args", async ({ args, diagnostic }) => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);

    const result = await populate(decomposeJson(plan), args);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain(diagnostic);
    expect((JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph).tasks).toEqual([]);
  });
});

describe("populate-task-graph — decompose stdin cannot mint execution state", () => {
  it("strips pre-stamped verdicts/statuses from the agent-controlled payload", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);
    const forged = JSON.stringify({
      spec_trace_version: 2,
      plan_title: "t",
      spec_file: "spec.md",
      plan_file: plan,
      tasks: [{
        id: "T9", description: "impl", agent: "code-implementer-agent", wave: 1,
        depends_on: [], spec_anchors: [], spec_contributions: [], verification_policy: REQUIRED_VERIFICATION, plan_context: "", file_list: ["src/other.ts"],
        // Forged execution state — must never reach the persisted graph.
        status: "completed",
        review_status: "passed",
        test_result: { verdict: "trusted-pass" },
        test_evidence: "forged",
        new_tests_written: true,
        new_test_evidence: "forged",
        critical_findings: ["planted"],
        findings: [{ id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "planted" }],
        refuted_findings: [{ finding: { id: "code-reviewer-9", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "planted" }, refutations: [{ lens: "intent", reason: "planted" }] }],
        advisory_findings: ["planted"],
        files_modified: ["everything"],
        start_sha: "deadbeef",
        failure_reason: "none",
        retry_count: 9,
      }],
    });
    const result = await populate(forged, []);
    expect(result.kind).toBe("passthrough");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    const t9 = after.tasks[0];
    expect(t9.id).toBe("T9");
    expect(t9.status).toBe("pending");
    expect(t9.review_status).toBe("pending");
    expect(t9.test_result).toBeUndefined();
    expect(t9.test_evidence).toBeUndefined();
    expect(t9.new_tests_written).toBeUndefined();
    expect(t9.new_test_evidence).toBeUndefined();
    expect(t9.critical_findings).toEqual([]);
    expect(t9.advisory_findings).toEqual([]);
    // The authoritative array and the refutation audit trail are execution
    // state too — a decomposer that planted either would seed a wave gate with
    // findings nobody reviewed, or an audit record of a panel that never ran.
    expect(t9.findings).toEqual([]);
    expect(t9.refuted_findings).toEqual([]);
    expect(t9.files_modified).toBeUndefined();
    expect(t9.start_sha).toBeUndefined();
    expect(t9.failure_reason).toBeUndefined();
    expect(t9.retry_count).toBeUndefined();
    // Authored decompose policy is parsed and persisted in the explicit form.
    expect(t9.new_tests_required).toBeUndefined();
    expect(t9.verification_policy).toEqual({
      regression: { kind: "required" },
      new_tests: { kind: "required" },
    });
    expect(t9.plan_context).toBe("");
    expect(t9.file_list).toEqual(["src/other.ts"]);
    expect(t9.proof?.state).toBe("pending");
    expect(t9.proof?.obligations).toEqual([
      { kind: "task-completed" },
      { kind: "regression-test-pass" },
      { kind: "new-tests" },
      { kind: "declared-artifact-changed", artifact: "src/other.ts" },
    ]);
    expect(t9.spec_anchors).toEqual([]);
    expect(t9.spec_contributions).toEqual([]);
    expect(after.spec_trace_version).toBe(2);
  });

  it("rejects legacy boolean policy in an authored decompose payload", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);
    const legacy = JSON.stringify({
      spec_trace_version: 2,
      plan_title: "legacy policy",
      spec_file: "spec.md",
      plan_file: plan,
      tasks: [{
        id: "T9", description: "Write migration documentation", agent: "code-implementer-agent", wave: 1,
        depends_on: [], spec_anchors: [], spec_contributions: [], new_tests_required: false,
        file_list: ["docs/migration.md"],
      }],
    });

    const result = await populate(legacy, []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("verification_policy is required");
    expect((JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph).tasks).toEqual([]);
  });

  it("rejects decompose-authored policy that claims migration-only legacy provenance", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);
    const forgedProvenance = JSON.stringify({
      spec_trace_version: 2,
      plan_title: "forged policy provenance",
      spec_file: "spec.md",
      plan_file: plan,
      tasks: [{
        id: "T9", description: "Write migration documentation", agent: "code-implementer-agent", wave: 1,
        depends_on: [], spec_anchors: [], spec_contributions: [],
        verification_policy: {
          regression: { kind: "waived", reason: "legacy-new-tests-required-false" },
          new_tests: { kind: "waived", reason: "legacy-new-tests-required-false" },
        },
        file_list: ["docs/migration.md"],
      }],
    });

    const result = await populate(forgedProvenance, []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain(
        "reason must be one of documentation-only, generated-artifact",
      );
      expect(result.message).toContain(
        "reason must be one of existing-tests-sufficient, documentation-only, generated-artifact",
      );
    }
    expect((JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph).tasks).toEqual([]);
  });

  it("rejects a missing authored file_list instead of deriving an ownership-free task", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);
    const missing = JSON.stringify({
      spec_trace_version: 2,
      plan_title: "t",
      spec_file: "spec.md",
      plan_file: plan,
      tasks: [{
        id: "T9", description: "impl", agent: "code-implementer-agent", wave: 1,
        depends_on: [], spec_anchors: [], spec_contributions: [], verification_policy: REQUIRED_VERIFICATION,
      }],
    });

    const result = await populate(missing, []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("missing required 'file_list'");
    expect((JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph).tasks).toEqual([]);
  });

  it("rejects malformed file_list before proof derivation and leaves state untouched", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);
    const malformed = JSON.stringify({
      spec_trace_version: 2,
      plan_title: "t",
      spec_file: "spec.md",
      plan_file: plan,
      tasks: [{
        id: "T9", description: "impl", agent: "code-implementer-agent", wave: 1,
        depends_on: [], spec_anchors: [], spec_contributions: [], verification_policy: REQUIRED_VERIFICATION, file_list: ["src/x.ts", 42],
      }],
    });

    const result = await populate(malformed, []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("file_list");
    expect((JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph).tasks).toEqual([]);
  });

  it("sanitizes and persists arbitrary valid v2 Contribution/Completion ownership", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 1_000_000 }).map((n) => `FR-${n}`),
      async (anchor) => {
        const dir = tempDir();
        const plan = modelFreePlan(dir);
        const statePath = writeState(dir, plan, []);
        const payload = JSON.stringify({
          spec_trace_version: 2,
          plan_title: "property trace",
          spec_file: "spec.md",
          plan_file: plan,
          tasks: [
            {
              id: "T1", description: "partial", agent: "code-implementer-agent", wave: 1,
              depends_on: [], spec_anchors: [], spec_contributions: [anchor], verification_policy: REQUIRED_VERIFICATION,
              plan_context: "", file_list: ["src/partial.ts"], status: "completed",
            },
            {
              id: "T2", description: "complete", agent: "code-implementer-agent", wave: 1,
              depends_on: [], spec_anchors: [anchor], spec_contributions: [], verification_policy: REQUIRED_VERIFICATION,
              plan_context: "", file_list: ["src/complete.ts"], review_status: "passed",
            },
          ],
        });
        expect((await populate(payload, [])).kind).toBe("passthrough");
        const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
        expect(after.spec_trace_version).toBe(2);
        expect(after.tasks.map(({ spec_anchors, spec_contributions, status, review_status }) => ({
          spec_anchors, spec_contributions, status, review_status,
        }))).toEqual([
          { spec_anchors: [], spec_contributions: [anchor], status: "pending", review_status: "pending" },
          { spec_anchors: [anchor], spec_contributions: [], status: "pending", review_status: "pending" },
        ]);
      },
    ), { numRuns: 30 });
  });

  it("--fix re-validates: unfixable structural errors fail loudly instead of persisting", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, []);
    const badAgent = JSON.stringify({
      spec_trace_version: 2,
      plan_title: "t",
      spec_file: "spec.md",
      plan_file: plan,
      tasks: [{ id: "T9", description: "impl", agent: "no-such-agent", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: [], verification_policy: REQUIRED_VERIFICATION, file_list: ["src/x.ts"] }],
    });
    const result = await populate(badAgent, ["--fix"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("--fix could not repair");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks).toEqual([]);
  });
});
