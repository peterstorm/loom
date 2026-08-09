import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager, parseTaskGraph, resolveTaskGraph } from "../src/state-manager";
import { SUBAGENT_DIR } from "../src/config";
import type { TaskGraph } from "../src/types";
import { derivePendingTaskProof, evaluateTaskProof } from "../src/core/proof-obligations";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `loom-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalGraph(): TaskGraph {
  return {
    current_phase: "init",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
  };
}

describe("StateManager", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    statePath = join(tmpDir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(minimalGraph(), null, 2));
    chmodSync(statePath, 0o444);
  });

  afterEach(() => {
    try { chmodSync(statePath, 0o644); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads state from file", () => {
    const mgr = new StateManager(statePath);
    const state = mgr.load();
    expect(state.current_phase).toBe("init");
    expect(state.tasks).toEqual([]);
  });

  it("updates state atomically", async () => {
    const mgr = new StateManager(statePath);

    await mgr.update((s) => ({
      ...s,
      current_phase: "specify",
    }));

    const updated = mgr.load();
    expect(updated.current_phase).toBe("specify");
  });

  it("restores chmod 444 after update", async () => {
    const mgr = new StateManager(statePath);
    await mgr.update((s) => ({ ...s, current_phase: "brainstorm" }));

    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  it("restores chmod 444 even on error", async () => {
    const mgr = new StateManager(statePath);

    await expect(
      mgr.update(() => { throw new Error("boom"); })
    ).rejects.toThrow("boom");

    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  it("rejects an invalid produced graph before replacing state authority", async () => {
    const mgr = new StateManager(statePath);
    const before = readFileSync(statePath, "utf-8");

    await expect(mgr.update((state) => ({
      ...state,
      current_phase: "not-a-phase",
    } as unknown as TaskGraph))).rejects.toThrow("Refusing to persist invalid task graph");

    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(() => readFileSync(`${statePath}.tmp`, "utf-8")).toThrow();
    expect(statSync(statePath).mode & 0o777).toBe(0o444);
  });

  it("replaces state entirely", async () => {
    const mgr = new StateManager(statePath);
    const newState: TaskGraph = {
      ...minimalGraph(),
      current_phase: "execute",
      tasks: [{ id: "T1", description: "test", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] }],
      wave_gates: {},
    };

    await mgr.replace(newState);

    const loaded = mgr.load();
    expect(loaded.current_phase).toBe("execute");
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].id).toBe("T1");
  });

  it("fromPath returns null for non-existent path", () => {
    expect(StateManager.fromPath("/nonexistent/path.json")).toBeNull();
  });

  it("fromPath returns manager for existing path", () => {
    const mgr = StateManager.fromPath(statePath);
    expect(mgr).not.toBeNull();
    expect(mgr!.getPath()).toBe(statePath);
  });

  it("handles concurrent updates via locking", async () => {
    const mgr = new StateManager(statePath);

    // current_wave is a positive domain value; start at one.
    await mgr.update((s) => ({ ...s, current_wave: 1 }));

    // Run 5 concurrent updates
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mgr.update((s) => ({ ...s, current_wave: (s.current_wave ?? 0) + 1 }))
      )
    );

    const final = mgr.load();
    expect(final.current_wave).toBe(6);
  });

  it("throws on empty file", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, "");
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("Corrupt state file");
  });

  it("throws on truncated JSON", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, '{"current_phase":');
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("invalid JSON");
  });

  it("throws on missing required fields", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, '{"foo": "bar"}');
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("missing current_phase");
  });

  it("throws on non-object JSON (array)", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, '[1, 2, 3]');
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("not an object");
  });
});

describe("parseTaskGraph — disk unions are proven, not cast (parse, don't validate)", () => {
  const validTask = {
    id: "T1",
    description: "impl",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
  };
  const validGraph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [validTask],
    wave_gates: {},
  };

  it("accepts a valid graph, defaulting tasks and wave_gates for early phases", () => {
    const full = parseTaskGraph(validGraph);
    expect(full.ok).toBe(true);

    const early = parseTaskGraph({ current_phase: "init", phase_artifacts: {} });
    expect(early.ok).toBe(true);
    if (early.ok) {
      expect(early.value.tasks).toEqual([]);
      expect(early.value.wave_gates).toEqual({});
    }
  });

  it("shares task-agent authority with validate-task-graph", () => {
    const unknown = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, agent: "not-a-real-agent" }],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("unknown agent");

    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, agent: "code-implementer-agent" }],
    }).ok).toBe(true);
  });

  it("preserves unknown extra fields (legacy tests_passed still visible downstream)", () => {
    const parsed = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, tests_passed: true }],
      updated_at: "2026-01-01",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.value.tasks[0] as unknown as Record<string, unknown>).tests_passed).toBe(true);
      expect(parsed.value.updated_at).toBe("2026-01-01");
    }
  });

  it.each([
    ["description", 42, "description must be a non-empty string"],
    ["description", "", "description must be a non-empty string"],
    ["agent", { name: "code-implementer-agent" }, "agent must be a non-empty string"],
    ["wave", 1.5, "wave must be an integer >= 1"],
    ["wave", 0, "wave must be an integer >= 1"],
  ])("rejects an invalid required task %s field", (field, value, message) => {
    const parsed = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, [field]: value }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it.each([
    ["a non-array", "REQ-1"],
    ["a non-string entry", ["REQ-1", 42]],
    ["a blank entry", ["REQ-1", "  "]],
  ])("rejects %s spec_anchors value at the typed load boundary", (_label, spec_anchors) => {
    const parsed = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, spec_anchors }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("spec_anchors must be an array of non-empty strings");
  });

  it("enforces dependency existence and earlier-wave ordering at the typed load boundary", () => {
    const task2 = { ...validTask, id: "T2", wave: 2, depends_on: ["T1"] };
    expect(parseTaskGraph({ ...validGraph, tasks: [validTask, task2] }).ok).toBe(true);

    const invalid = [
      { tasks: [{ ...validTask, depends_on: ["T1"] }], message: "self-dependency" },
      { tasks: [{ ...validTask, depends_on: ["T99"] }], message: "depends on non-existent" },
      {
        tasks: [validTask, { ...task2, wave: 1 }],
        message: "deps must be in earlier wave",
      },
      {
        tasks: [{ ...validTask, depends_on: ["T2"] }, task2],
        message: "deps must be in earlier wave",
      },
    ];
    for (const { tasks, message } of invalid) {
      const parsed = parseTaskGraph({ ...validGraph, tasks });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(message);
    }
  });

  it.each(["bad:id", " T1", "T 1", "task-1"])(
    "rejects task id %j that cannot form a wave finding identity",
    (id) => {
      const parsed = parseTaskGraph({ ...validGraph, tasks: [{ ...validTask, id }] });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("id must match T\\d+");
    },
  );

  it.each([
    ["absolute", ["/tmp/outside.ts"]],
    ["traversal", ["src/../outside.ts"]],
    ["backslash", ["src\\outside.ts"]],
    ["alias", ["./src/x.ts"]],
    ["duplicate", ["src/x.ts", "src/x.ts"]],
  ])("rejects %s task file_list at the typed load boundary", (_label, file_list) => {
    const parsed = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, file_list }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("enforces status/proof lockstep for proof-bearing graphs", () => {
    const pendingProof = derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: [] });
    const impossible = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, status: "implemented", proof: pendingProof }],
    });
    expect(impossible.ok).toBe(false);
    if (!impossible.ok) expect(impossible.error).toContain("status/proof lockstep");

    const satisfied = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: [] },
      {
        taskCompleted: true,
        testResult: { verdict: "trusted-pass" },
        filesModified: [],
        newTestsWritten: true,
      },
    );
    expect(satisfied.state).toBe("satisfied");
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, status: "implemented", proof: satisfied }],
    }).ok).toBe(true);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, status: "pending", proof: satisfied }],
    }).ok).toBe(false);
  });

  it("binds persisted proof obligations exactly to new_tests_required and file_list", () => {
    const exact = derivePendingTaskProof({
      newTestsRequired: true,
      declaredArtifacts: ["src/a.ts"],
    });
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        new_tests_required: true,
        file_list: ["src/a.ts"],
        proof: exact,
      }],
    }).ok).toBe(true);

    const omittedArtifact = derivePendingTaskProof({
      newTestsRequired: true,
      declaredArtifacts: [],
    });
    const omitted = parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        new_tests_required: true,
        file_list: ["src/a.ts"],
        proof: omittedArtifact,
      }],
    });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.error).toContain("proof obligations do not exactly match");

    const foreignTests = derivePendingTaskProof({
      newTestsRequired: true,
      declaredArtifacts: [],
    });
    const waived = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, new_tests_required: false, proof: foreignTests }],
    });
    expect(waived.ok).toBe(false);
  });

  it("rejects an out-of-union current_phase loudly, naming the value", () => {
    const parsed = parseTaskGraph({ ...validGraph, current_phase: "vibing" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('"vibing"');
  });

  it.each([null, [], "artifact", 42])("rejects non-object phase_artifacts: %j", (phase_artifacts) => {
    const parsed = parseTaskGraph({ ...validGraph, phase_artifacts });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("phase_artifacts must be an object");
  });

  it("rejects unknown phase-artifact keys and non-string artifact paths", () => {
    for (const phase_artifacts of [{ invented: "x.md" }, { architecture: 42 }]) {
      expect(parseTaskGraph({ ...validGraph, phase_artifacts }).ok).toBe(false);
    }
  });

  it("parses adjacent top-level TaskGraph fields instead of admitting impossible values", () => {
    const cases = [
      { skipped_phases: ["invented"] },
      { spec_file: 42 },
      { plan_file: {} },
      { executing_tasks: ["T1", "T1"] },
      { github_issue: 0 },
      { github_repo: 42 },
    ];
    for (const fields of cases) expect(parseTaskGraph({ ...validGraph, ...fields }).ok).toBe(false);
  });

  it("rejects a captured spec check carrying the failed-capture error field", () => {
    const parsed = parseTaskGraph({
      ...validGraph,
      spec_check: {
        wave: 1, run_at: "now", verdict: "PASSED", error: "stale",
        critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("error must be absent");
  });

  it("rejects duplicate task ids at the load boundary", () => {
    const parsed = parseTaskGraph({ ...validGraph, tasks: [validTask, { ...validTask }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("duplicate task id: T1");
  });

  it("rejects an out-of-union task status (drifted 'in_progress' fails at load, not inside .exhaustive())", () => {
    const parsed = parseTaskGraph({ ...validGraph, tasks: [{ ...validTask, status: "in_progress" }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("T1");
      expect(parsed.error).toContain('"in_progress"');
    }
  });

  it("rejects an out-of-union review_status", () => {
    const parsed = parseTaskGraph({ ...validGraph, tasks: [{ ...validTask, review_status: "meh" }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("review_status");
  });

  it("rejects a drifted test_result.verdict — the value that would explode testResultPassed", () => {
    const parsed = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, test_result: { verdict: "passed" } }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("test_result.verdict");
  });

  it("rejects an untrusted test_result missing its passed/label payload", () => {
    const parsed = parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, test_result: { verdict: "untrusted" } }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("untrusted");
  });

  it("accepts every valid verdict shape", () => {
    for (const test_result of [
      { verdict: "trusted-pass" },
      { verdict: "trusted-fail" },
      { verdict: "untrusted", passed: true, label: "transcript-regex (fallback)" },
    ]) {
      const parsed = parseTaskGraph({ ...validGraph, tasks: [{ ...validTask, test_result }] });
      expect(parsed.ok, JSON.stringify(test_result)).toBe(true);
    }
  });

  it("proves files_modified is an array of strings before consumers read it", () => {
    for (const files_modified of ["src/a.ts", ["src/a.ts", 42], null]) {
      const parsed = parseTaskGraph({
        ...validGraph,
        tasks: [{ ...validTask, files_modified }],
      });
      expect(parsed.ok, JSON.stringify(files_modified)).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("files_modified");
    }
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, files_modified: ["src/a.ts"] }],
    }).ok).toBe(true);
  });

  it("parses artifact baselines as an exact discriminated union", () => {
    const valid = [{
      artifact: "src/a.ts",
      snapshot: { kind: "sha256", digest: "a".repeat(64) },
    }, {
      artifact: "src/new.ts",
      snapshot: { kind: "missing" },
    }];
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, file_list: ["src/a.ts", "src/new.ts"], artifact_baseline: valid }],
    }).ok).toBe(true);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        file_list: ["src/a.ts", "src/new.ts"],
        attempt_artifact_baseline: valid,
      }],
    }).ok).toBe(true);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        file_list: ["src/new.ts", "src/a.ts"],
        attempt_artifact_baseline: valid,
      }],
    }).ok).toBe(false);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        file_list: ["src/a.ts"],
        files_modified: ["src/new.ts"],
        attempt_artifact_baseline: valid,
      }],
    }).ok).toBe(true);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        file_list: ["src/new.ts", "src/a.ts"],
        artifact_baseline: valid,
      }],
    }).ok).toBe(false);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, attempt_repository_baseline: valid }],
    }).ok).toBe(true);
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        attempt_repository_baseline: [{
          artifact: "src/a.ts",
          snapshot: { kind: "sha256", digest: "bad" },
        }],
      }],
    }).ok).toBe(false);

    for (const artifact_baseline of [
      "not-an-array",
      [{ artifact: "src/a.ts", snapshot: { kind: "sha256", digest: "bad" } }],
      [{ artifact: "src/a.ts", snapshot: { kind: "unknown" } }],
      [valid[0], valid[0]],
    ]) {
      const parsed = parseTaskGraph({
        ...validGraph,
        tasks: [{ ...validTask, artifact_baseline }],
      });
      expect(parsed.ok, JSON.stringify(artifact_baseline)).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("artifact_baseline");
    }
  });

  it("parses engine-issued packet registrations and rejects authority drift", () => {
    const registration = {
      task_id: "T1",
      packet_id: "b".repeat(64),
      packet_path: ".claude/reviews/T1.json",
      base_sha: "a".repeat(40),
      head_sha: "c".repeat(40),
      scope: ["src/a.ts"],
    };
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, issued_review_packets: [registration] }],
    }).ok).toBe(true);
    for (const issued_review_packets of [
      [{ ...registration, task_id: "T2" }],
      [{ ...registration, packet_path: "../outside.json" }],
      [{ ...registration, packet_id: "bad" }],
      [{ ...registration, scope: ["src/a.ts", "src/a.ts"] }],
      [registration, { ...registration }],
    ]) {
      expect(parseTaskGraph({
        ...validGraph,
        tasks: [{ ...validTask, issued_review_packets }],
      }).ok).toBe(false);
    }
  });

  it("parses only exact Git SHAs as recovered artifact baseline provenance", () => {
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{ ...validTask, artifact_baseline_recovered_from: "a".repeat(40) }],
    }).ok).toBe(true);
    for (const artifact_baseline_recovered_from of ["HEAD~1", "A".repeat(40), "a".repeat(39)]) {
      const parsed = parseTaskGraph({
        ...validGraph,
        tasks: [{ ...validTask, artifact_baseline_recovered_from }],
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("artifact_baseline_recovered_from");
    }
  });

  it("parses recovered write provenance and rejects drift or duplicate packet ids", () => {
    const sha = "a".repeat(40);
    const packet = "b".repeat(64);
    const evidence = [{
      baseline_sha: sha,
      packet_id: packet,
      packet_path: ".claude/reviews/T1.json",
      modified_paths: ["src/a.ts"],
    }];
    expect(parseTaskGraph({
      ...validGraph,
      tasks: [{
        ...validTask,
        file_list: ["src/a.ts"],
        artifact_baseline_recovered_from: sha,
        recovered_artifact_writes: evidence,
      }],
    }).ok).toBe(true);
    for (const recovered_artifact_writes of [
      [{ ...evidence[0], baseline_sha: "c".repeat(40) }],
      [...evidence, { ...evidence[0] }],
      [{ ...evidence[0], packet_path: "../outside.json" }],
      [{ ...evidence[0], modified_paths: ["src/a.ts", "src/a.ts"] }],
      [{ ...evidence[0], modified_paths: [] }],
      [{ ...evidence[0], modified_paths: ["src/outside.ts"] }],
    ]) {
      expect(parseTaskGraph({
        ...validGraph,
        tasks: [{
          ...validTask,
          file_list: ["src/a.ts"],
          artifact_baseline_recovered_from: sha,
          recovered_artifact_writes,
        }],
      }).ok).toBe(false);
    }
  });

  it("rejects non-array tasks and non-object wave_gates", () => {
    expect(parseTaskGraph({ ...validGraph, tasks: "none" }).ok).toBe(false);
    expect(parseTaskGraph({ ...validGraph, wave_gates: [] }).ok).toBe(false);
  });

  it("requires every persisted wave gate field instead of casting partial records", () => {
    const complete = {
      impl_complete: false,
      tests_passed: null,
      reviews_complete: false,
      blocked: false,
    };
    expect(parseTaskGraph({ ...validGraph, wave_gates: { "1": complete } }).ok).toBe(true);
    for (const partial of [{}, { impl_complete: false }, { ...complete, tests_passed: undefined }]) {
      const parsed = parseTaskGraph({ ...validGraph, wave_gates: { "1": partial } });
      expect(parsed.ok, JSON.stringify(partial)).toBe(false);
    }
  });

  it("StateManager.load surfaces the parse error as a contextual throw", () => {
    const dir = makeTmpDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify({ ...validGraph, tasks: [{ ...validTask, status: "in_progress" }] }),
    );
    try {
      const mgr = new StateManager(statePath);
      expect(() => mgr.load()).toThrow(/Corrupt state file.*in_progress/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveTaskGraph — session ids are parsed before naming SUBAGENT_DIR files", () => {
  it("resolves a LOOM_STATE_PATH established after module import", () => {
    const dir = makeTmpDir();
    const latePath = join(dir, "late-active-task-graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    writeFileSync(latePath, JSON.stringify(minimalGraph()));
    process.env.LOOM_STATE_PATH = latePath;
    try {
      expect(resolveTaskGraph()).toBe(latePath);
      expect(StateManager.fromSession("sm-late-binding")?.getPath()).toBe(latePath);
    } finally {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a valid session id resolves through its .task_graph pointer", () => {
    const s = `sm-resolve-${process.pid}-${Date.now()}`;
    const dir = makeTmpDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(minimalGraph()));
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${s}.task_graph`);
    writeFileSync(pointer, statePath);
    try {
      expect(resolveTaskGraph(s)).toBe(statePath);
    } finally {
      rmSync(pointer, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dangling pointer (names a missing graph) falls back to the local graph LOUDLY", () => {
    const s = `sm-dangling-${process.pid}-${Date.now()}`;
    const missing = join(makeTmpDir(), "gone", "active_task_graph.json");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${s}.task_graph`);
    writeFileSync(pointer, missing);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = resolveTaskGraph(s);
      // Never returns the dangling target — falls back to local resolution.
      expect(result).not.toBe(missing);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("names missing graph");
      expect(text).toContain("falling back to local task graph");
    } finally {
      stderrSpy.mockRestore();
      rmSync(pointer, { force: true });
    }
  });

  it("a traversal session id is ignored LOUDLY — no path outside SUBAGENT_DIR is ever read", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Falls back to the local task graph resolution (null when none) —
      // never throws, never reads a `../..`-addressed file.
      const result = resolveTaskGraph("../../etc/passwd");
      expect(result === null || !result.includes("..")).toBe(true);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("invalid session id");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("parseTaskGraph proves findings, not just the fields that always did", () => {
  const validTask = {
    id: "T1",
    description: "impl",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
  };
  const graph = (task: Record<string, unknown>) => ({
    current_phase: "execute",
    phase_artifacts: {},
    tasks: [{ ...validTask, ...task }],
    wave_gates: {},
  });
  const wellFormed = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: "src/x.ts",
    line: 4,
    claim: "unchecked cast",
  };

  it("accepts a task with no findings, and one whose views are in lockstep", () => {
    expect(parseTaskGraph(graph({})).ok).toBe(true);
    expect(parseTaskGraph(graph({ findings: [] })).ok).toBe(true);
    expect(parseTaskGraph(graph({
      findings: [wellFormed],
      critical_findings: ["unchecked cast"],
    })).ok).toBe(true);
    expect(parseTaskGraph(graph({
      refuted_findings: [{ finding: wellFormed, refutations: [{ lens: "intent", reason: "deliberate" }] }],
    })).ok).toBe(true);
  });

  it("accepts the same claim twice — two reviewers may word it identically", () => {
    // A multiset comparison, not a set one. Collapsing duplicates would reject
    // a graph the sanctioned writers are allowed to produce.
    expect(parseTaskGraph(graph({
      findings: [wellFormed, { ...wellFormed, id: "silent-failure-hunter-1", agent: "silent-failure-hunter" }],
      critical_findings: ["unchecked cast", "unchecked cast"],
    })).ok).toBe(true);
  });

  it.each([
    ["findings that are not an array", { findings: {} }],
    ["refuted_findings that are not an array", { refuted_findings: "none" }],
    ["a finding with no id", { findings: [{ ...wellFormed, id: "" }] }],
    ["a finding id with an extra colon", { findings: [{ ...wellFormed, id: "bad:id" }] }],
    ["a finding id with whitespace", { findings: [{ ...wellFormed, id: "bad id" }] }],
    ["a finding with no agent", { findings: [{ ...wellFormed, agent: undefined }] }],
    ["a finding with an unknown severity", { findings: [{ ...wellFormed, severity: "blocker" }] }],
    ["a finding with a non-string claim", { findings: [{ ...wellFormed, claim: 7 }] }],
    // Two findings under one id make applyFindingOutcomes delete BOTH where one
    // was adjudicated, and attach the panel's reasoning to the wrong claim —
    // the failure nextOrdinal forecloses when minting, and nothing caught on read.
    ["two findings sharing an id", {
      findings: [wellFormed, { ...wellFormed, claim: "a different claim" }],
      critical_findings: ["unchecked cast", "a different claim"],
    }],
    // The dangerous drift direction: the gate counts the view, so a critical
    // present only in `findings` never blocks the wave.
    ["a critical present only in findings", { findings: [wellFormed], critical_findings: [] }],
    // The other direction: a claim no finding accounts for can never enter a
    // brief, so no panel can ever adjudicate it.
    ["a claim present only in the view", { findings: [], critical_findings: ["orphan"] }],
    ["an advisory view that outruns findings", {
      findings: [wellFormed],
      critical_findings: ["unchecked cast"],
      advisory_findings: ["nit"],
    }],
    ["a refutation with no refuters", { refuted_findings: [{ finding: wellFormed, refutations: [] }] }],
    ["a refutation missing a reason", { refuted_findings: [{ finding: wellFormed, refutations: [{ lens: "intent" }] }] }],
  ])("rejects %s at the load boundary", (_label, task) => {
    // The type says `readonly Finding[]`; before this the cast asserted it from
    // unvalidated JSON, and a finding missing its `file` key surfaced as an
    // unhandled TypeError from inside a pure panel function rather than as a
    // contract diagnostic.
    const parsed = parseTaskGraph(graph(task));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('tasks[0] ("T1")');
  });

  it("names the repair so a rejected graph is not a dead end", () => {
    const parsed = parseTaskGraph(graph({ findings: [{}] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("repair-task-graph");
  });
});
