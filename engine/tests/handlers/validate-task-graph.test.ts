import { describe, it, expect, vi } from "vitest";
import {
  validateMinimal,
  validateFull as validateFullImplementation,
  fixFull,
  type ValidationResult,
  type ValidationScope,
} from "../../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../../src/state-manager";

const PERSISTED_LIFECYCLE = {
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
} as const;

/** Most tests focus on task validation; supply the persisted lifecycle invariant explicitly. */
function validateFull(
  json: Record<string, unknown>,
  scope: ValidationScope = "state-file",
): ValidationResult {
  return validateFullImplementation(
    scope === "state-file" ? { ...PERSISTED_LIFECYCLE, ...json } : json,
    scope,
  );
}

/** Narrowing helper: errors of a failed validation, [] when ok */
function errorsOf(r: import("../../src/handlers/helpers/validate-task-graph").ValidationResult): readonly string[] {
  return r.ok ? [] : r.errors;
}

describe("validateMinimal (pure)", () => {
  it("accepts valid minimal graph", () => {
    const result = validateMinimal({
      current_phase: "init",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing current_phase", () => {
    const result = validateMinimal({ phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Missing required field: current_phase");
  });

  it("rejects invalid phase value", () => {
    const result = validateMinimal({ current_phase: "invalid", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("not a valid phase");
  });

  it("rejects non-object phase_artifacts", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: "string", skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("phase_artifacts must be object");
  });

  it("rejects non-array skipped_phases", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: {}, skipped_phases: "string", spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("skipped_phases must be array");
  });

  it("rejects missing spec_file and plan_file keys", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: {}, skipped_phases: [] });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Missing required field: spec_file");
    expect(errorsOf(result)).toContain("Missing required field: plan_file");
  });
});

describe("validateFull (pure)", () => {
  const validTask = {
    id: "T1",
    description: "Implement feature",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
  };

  it("accepts valid task graph", () => {
    const result = validateFull({
      plan_title: "Test plan",
      plan_file: ".claude/plans/plan.md",
      spec_file: ".claude/specs/spec.md",
      tasks: [validTask],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a coercible string current_wave just like the state loader", () => {
    const graph = {
      plan_title: "Test plan",
      plan_file: ".claude/plans/plan.md",
      spec_file: ".claude/specs/spec.md",
      current_wave: "2",
      tasks: [validTask],
    };
    expect(errorsOf(validateFull(graph))).toContain(
      'current_wave must be an integer >= 1 when present, got "2"',
    );
  });

  it("rejects state files missing mandatory lifecycle fields before the loader does", () => {
    const graph = {
      plan_title: "Test plan",
      plan_file: ".claude/plans/plan.md",
      spec_file: ".claude/specs/spec.md",
      tasks: [validTask],
    };
    const result = validateFullImplementation(graph, "state-file");
    expect(errorsOf(result)).toContain("missing current_phase");
    expect(errorsOf(result)).toContain("missing phase_artifacts");
    expect(parseTaskGraph(graph).ok).toBe(false);
  });

  it("keeps decompose payloads independent of persisted lifecycle fields", () => {
    const result = validateFullImplementation({
      plan_title: "Test plan",
      plan_file: ".claude/plans/plan.md",
      spec_file: ".claude/specs/spec.md",
      tasks: [validTask],
    }, "decompose-payload");
    expect(result.ok).toBe(true);
  });

  it("rejects missing required top-level fields", () => {
    const result = validateFull({ tasks: [validTask] });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Missing required field: plan_title");
  });

  it("rejects non-array tasks", () => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: "not-array" });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("'tasks' must be an array");
  });

  it("rejects empty tasks array", () => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: [] });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("'tasks' array is empty");
  });

  it.each([null, 42, "task", []])("returns a validation error for malformed task entry %j", (entry) => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: [entry] });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Task [0]: must be an object");
  });

  it("rejects duplicate task ids", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [validTask, { ...validTask, description: "duplicate" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Duplicate task id: T1");
  });

  it("rejects a non-array depends_on", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: "T2" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Task T1: 'depends_on' must be array");
  });

  it("holds state-file validation in lockstep with the loader for absent execution fields", () => {
    const withoutStatus = { ...validTask } as Record<string, unknown>;
    delete withoutStatus.status;
    const withoutDependencies = { ...validTask } as Record<string, unknown>;
    delete withoutDependencies.depends_on;

    for (const task of [withoutStatus, withoutDependencies]) {
      const graph = { plan_title: "x", plan_file: "x", spec_file: "x", tasks: [task] };
      expect(validateFull(graph).ok).toBe(false);
      expect(parseTaskGraph({
        current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
        spec_file: null, plan_file: null, tasks: [task], wave_gates: {},
      }).ok).toBe(false);
    }
  });

  it("rejects malformed decompose file_list before proof derivation", () => {
    for (const file_list of [["src/x.ts", 42], [""], "src/x.ts"]) {
      const result = validateFull({
        plan_title: "x", plan_file: "x", spec_file: "x",
        tasks: [{ ...validTask, status: undefined, file_list }],
      }, "decompose-payload");
      expect(result.ok).toBe(false);
      expect(errorsOf(result)).toContain("Task T1: 'file_list' must be an array of non-empty strings if present");
    }
  });

  it.each([
    ["absolute", ["/tmp/outside.ts"]],
    ["traversal", ["src/../outside.ts"]],
    ["backslash", ["src\\outside.ts"]],
    ["alias", ["./src/x.ts"]],
    ["duplicate", ["src/x.ts", "src/x.ts"]],
  ])("rejects %s decompose file_list paths", (_label, file_list) => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, status: undefined, file_list }],
    }, "decompose-payload");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array spec_anchors when present", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, spec_anchors: "REQ-1" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Task T1: 'spec_anchors' must be array if present");
  });

  it("rejects a non-boolean new_tests_required when present", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, new_tests_required: "yes" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Task T1: 'new_tests_required' must be boolean if present");
  });

  it("validates task ID format", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, id: "bad-id" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("id must match");
  });

  it("rejects unknown agent", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, agent: "fake-agent" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("unknown agent");
  });

  it("rejects self-dependency", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: ["T1"] }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("self-dependency");
  });

  it("rejects dependency on non-existent task", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: ["T99"] }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("non-existent");
  });

  it("rejects dependency on same-or-later wave", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 1, depends_on: ["T1"] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("deps must be in earlier wave");
  });

  it("accepts valid cross-wave dependency", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 2, depends_on: ["T1"] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects wave gaps (1 → 3)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 3, depends_on: [] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("Wave gap");
  });

  it("detects multiple wave gaps (1 → 3 → 7)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 3, depends_on: [] },
        { ...validTask, id: "T3", wave: 7, depends_on: [] },
      ],
    });
    expect(result.ok).toBe(false);
    const gapErrors = errorsOf(result).filter(e => e.includes("Wave gap"));
    expect(gapErrors).toHaveLength(2);
  });

  it("does not warn when new_tests_required=false and description mentions ADR", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", description: "Write ADR for state-management decision",
          new_tests_required: false, agent: "adr-writer-agent" },
      ],
    });
    expect(result.ok).toBe(true);
    const warned = stderr.mock.calls.some(([msg]) => String(msg).includes("doesn't match no-test patterns"));
    expect(warned).toBe(false);
    stderr.mockRestore();
  });

  it("warns when new_tests_required=false and description has no exempt keyword", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, description: "Implement core auth logic", new_tests_required: false }],
    });
    const warned = stderr.mock.calls.some(([msg]) => String(msg).includes("doesn't match no-test patterns"));
    expect(warned).toBe(true);
    stderr.mockRestore();
  });

  it("accepts ADR task in final wave with impl tasks in earlier waves", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, agent: "code-implementer-agent" },
        { ...validTask, id: "T2", wave: 2, depends_on: ["T1"],
          agent: "adr-writer-agent", description: "Write ADR for choice", new_tests_required: false },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects ADR task in same wave as impl tasks", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, agent: "code-implementer-agent" },
        { ...validTask, id: "T2", wave: 1,
          agent: "adr-writer-agent", description: "Write ADR for choice", new_tests_required: false },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result).some(e => e.includes("ADR task wave"))).toBe(true);
  });

  it("rejects ADR task in non-final wave", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, agent: "code-implementer-agent" },
        { ...validTask, id: "T2", wave: 2, depends_on: ["T1"],
          agent: "adr-writer-agent", description: "ADR doc", new_tests_required: false },
        { ...validTask, id: "T3", wave: 3, depends_on: ["T1"], agent: "code-implementer-agent" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result).some(e => e.includes("must be in the final wave"))).toBe(true);
  });

  it("accepts contiguous waves (1, 2, 3)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 2, depends_on: [] },
        { ...validTask, id: "T3", wave: 3, depends_on: [] },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("handler routes — fixMinimal and the file-arg path (round-10 gap 23)", () => {
  it("--minimal --fix with invalid JSON stdin emits a valid default minimal graph on stdout", async () => {
    const handler = (await import("../../src/handlers/helpers/validate-task-graph")).default;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await handler("{definitely not json", ["--minimal", "--fix"]);
      expect(result.kind).toBe("passthrough");
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      const fixed = JSON.parse(out);
      expect(fixed.current_phase).toBe("init");
      expect(fixed.phase_artifacts).toEqual({});
      expect(fixed.skipped_phases).toEqual([]);
      expect(fixed.spec_file).toBeNull();
      expect(fixed.plan_file).toBeNull();
      // Round-trip: the fixed output itself validates.
      expect(validateMinimal(fixed).ok).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("--minimal --fix preserves valid fields and defaults only the broken ones", async () => {
    const handler = (await import("../../src/handlers/helpers/validate-task-graph")).default;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await handler(
        JSON.stringify({
          current_phase: "execute",       // valid → preserved
          phase_artifacts: ["not", "an", "object"], // invalid → {}
          skipped_phases: "nope",         // invalid → []
          spec_file: "spec.md",           // present → preserved
          // plan_file missing → null
        }),
        ["--minimal", "--fix"],
      );
      expect(result.kind).toBe("passthrough");
      const fixed = JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(""));
      expect(fixed.current_phase).toBe("execute");
      expect(fixed.phase_artifacts).toEqual({});
      expect(fixed.skipped_phases).toEqual([]);
      expect(fixed.spec_file).toBe("spec.md");
      expect(fixed.plan_file).toBeNull();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("file-arg route: a missing file is a typed error, an existing file is read and validated", async () => {
    const handler = (await import("../../src/handlers/helpers/validate-task-graph")).default;
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const missing = await handler("", ["/nonexistent/graph.json"]);
    expect(missing.kind).toBe("error");
    if (missing.kind === "error") expect(missing.message).toContain("File not found");

    const dir = mkdtempSync(join(tmpdir(), "loom-vtg-"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const good = join(dir, "minimal.json");
      writeFileSync(good, JSON.stringify({
        current_phase: "init",
        phase_artifacts: {},
        skipped_phases: [],
        spec_file: null,
        plan_file: null,
      }));
      // stdin is IGNORED when a file arg is present — pass garbage to prove it.
      const result = await handler("{garbage stdin", ["--minimal", good]);
      expect(result.kind).toBe("passthrough");

      const bad = join(dir, "broken.json");
      writeFileSync(bad, "{not json");
      const broken = await handler("", ["--minimal", bad]);
      expect(broken.kind).toBe("error");
      if (broken.kind === "error") expect(broken.message).toContain("Invalid JSON");
    } finally {
      stderrSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fixFull repairs findings WITH their derived views", () => {
  const wellFormed = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: null,
    line: null,
    claim: "unchecked cast",
  };

  const graphOf = (task: Record<string, unknown>) => ({
    current_phase: "execute",
    phase_artifacts: {},
    tasks: [task],
  });
  const fix = (task: Record<string, unknown>) => JSON.parse(fixFull(graphOf(task)).json).tasks[0];

  it("recovers a claim the dropped entry would have taken with it", () => {
    // Dropping ALONE is not a repair, and neither is pruning the view to match.
    // `complete-wave-gate` counts critical_findings, so deleting "orphan" from
    // it turns a blocking wave into a passing one — through the very command
    // the load-boundary diagnostic tells the operator to run. The claim is
    // given identity instead, which is what makes it refutable.
    const repaired = fix({
      id: "T1",
      findings: [wellFormed, { id: "", agent: "", severity: "critical", claim: "orphan" }],
      critical_findings: ["unchecked cast", "orphan"],
      advisory_findings: [],
    });
    expect(repaired.critical_findings).toEqual(["unchecked cast", "orphan"]);
    expect(repaired.findings).toHaveLength(2);
    expect(repaired.findings[1]).toMatchObject({ agent: "recovered-view", claim: "orphan" });
  });

  it("keeps the views in lockstep at every severity, conserving every claim", () => {
    const repaired = fix({
      id: "T1",
      findings: [wellFormed, { ...wellFormed, id: "code-reviewer-2", severity: "advisory", claim: "nit" }],
      critical_findings: ["stale"],
      advisory_findings: ["stale too", "and another"],
    });
    expect(repaired.critical_findings).toEqual(["unchecked cast", "stale"]);
    expect(repaired.advisory_findings).toEqual(["nit", "stale too", "and another"]);
    expect(repaired.findings).toHaveLength(5);
  });

  it("gives a pre-identity task's views identity instead of leaving them orphaned", () => {
    // A graph written before findings had identity carries no `findings` field.
    // Its claims are real and must survive; they also have to become refutable,
    // or the task blocks forever with nothing able to adjudicate it.
    const repaired = fix({
      id: "T1",
      critical_findings: ["from before identity"],
      advisory_findings: ["also from before"],
    });
    expect(repaired.critical_findings).toEqual(["from before identity"]);
    expect(repaired.advisory_findings).toEqual(["also from before"]);
    expect(repaired.findings.map((f: { id: string }) => f.id)).toEqual([
      "recovered-view-1",
      "recovered-view-2",
    ]);
  });

  it("is idempotent — a second --fix changes nothing", () => {
    // The regression this pins: `derived = t.findings !== undefined` used the
    // key the repair itself writes as its "has migrated" predicate. Pass 1 wrote
    // `findings: []` onto a pre-identity task; pass 2 read that as authoritative
    // and re-derived both views from the empty array, deleting the whole review
    // record and passing the wave gate.
    const once = fixFull(graphOf({
      id: "T1",
      critical_findings: ["unresolved blocker"],
      advisory_findings: ["a nit"],
    })).json;
    expect(fixFull(JSON.parse(once)).json).toEqual(once);
    expect(JSON.parse(once).tasks[0].critical_findings).toEqual(["unresolved blocker"]);
  });

  it("re-mints a duplicated id rather than letting one vote delete two findings", () => {
    const repaired = fix({
      id: "T1",
      findings: [wellFormed, { ...wellFormed, claim: "a different claim" }],
      critical_findings: ["unchecked cast", "a different claim"],
    });
    const ids = repaired.findings.map((f: { id: string }) => f.id);
    expect(new Set(ids).size).toBe(2);
    expect(repaired.critical_findings).toEqual(["unchecked cast", "a different claim"]);
  });

  it("reports what it recovered rather than changing the graph silently", () => {
    const { notes } = fixFull(graphOf({ id: "T1", critical_findings: ["silent no more"] }));
    expect(notes).toEqual(['T1: recovered view-only claim into findings — "silent no more"']);
  });

  it("salvages a critical carried ONLY by a malformed entry", () => {
    // The bug this pins, verified against the real CLI. Conservation used to
    // rest entirely on step 2 recovering the dropped entry's claim from the
    // `string[]` view. When the view did NOT hold it — the exact state the load
    // boundary rejects with an installable `repair-task-graph` hint — nothing
    // recovered it and nothing reported it: FindingsRepair had no channel for a
    // drop. The critical was deleted by the one command the engine tells the
    // operator to run, and complete-wave-gate's check 5 then counted zero.
    const { json, notes } = fixFull(graphOf({
      id: "T1",
      findings: [{ severity: "critical", claim: "unchecked cast in the token reducer" }],
      critical_findings: [],
      advisory_findings: [],
      review_status: "blocked",
    }));
    const repaired = JSON.parse(json).tasks[0];
    expect(repaired.critical_findings).toEqual(["unchecked cast in the token reducer"]);
    expect(repaired.findings).toHaveLength(1);
    expect(repaired.findings[0]).toMatchObject({
      agent: "recovered-view",
      id: "recovered-view-1",
      claim: "unchecked cast in the token reducer",
    });
    expect(notes).toEqual([
      'T1: re-minted identity for a malformed findings entry — "unchecked cast in the token reducer"',
    ]);
  });

  it("salvages a singleton findings object instead of treating it as zero entries", () => {
    const { json, notes } = fixFull(graphOf({
      id: "T1",
      findings: { severity: "critical", claim: "singleton blocker" },
      critical_findings: [],
      advisory_findings: [],
      review_status: "blocked",
    }));
    const repaired = JSON.parse(json).tasks[0];
    expect(repaired.critical_findings).toEqual(["singleton blocker"]);
    expect(repaired.findings).toHaveLength(1);
    expect(notes).toEqual([
      'T1: re-minted identity for a malformed findings entry — "singleton blocker"',
    ]);
  });

  it("salvages without double-minting a claim the view also holds", () => {
    // Step 1 runs before step 2 precisely so the salvaged claim is already in
    // `findings` when recoverViewOnlyClaims looks for orphans. Reversed, the
    // claim would be minted twice and the wave gate would count two criticals
    // where the reviewer made one.
    const repaired = fix({
      id: "T1",
      findings: [{ severity: "critical", claim: "unchecked cast" }],
      critical_findings: ["unchecked cast"],
    });
    expect(repaired.findings).toHaveLength(1);
    expect(repaired.critical_findings).toEqual(["unchecked cast"]);
  });

  it("names the data it could not save instead of dropping it in silence", () => {
    // An entry with no usable severity or claim carries nothing to salvage, so
    // it IS lost — which is exactly why it has to be said out loud. A dropped
    // critical is indistinguishable from one that was never found.
    const { notes, dataLoss } = fixFull(graphOf({
      id: "T1",
      findings: [{ severity: "not-a-severity", claim: "" }, { nothing: true }],
      refuted_findings: [{ finding: { bogus: true }, refutations: [] }],
    }));
    expect(notes).toEqual([
      "T1: DROPPED 2 findings entr(y/ies) carrying no usable claim — data lost; check the reviewer output for this task",
      "T1: DROPPED 1 malformed refutation record(s) — audit trail lost; valid nested findings were preserved or returned to the active set",
    ]);
    expect(dataLoss).toEqual(notes);
  });

  it("requires explicit acknowledgement before emitting a lossy repaired graph", async () => {
    const handler = (await import("../../src/handlers/helpers/validate-task-graph")).default;
    const input = JSON.stringify(graphOf({
      id: "T1",
      findings: [{ severity: "not-a-severity", claim: "" }],
    }));
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const refused = await handler(input, ["--fix"]);
      expect(refused).toMatchObject({
        kind: "error",
        message: expect.stringContaining("--accept-data-loss"),
      });
      expect(stdoutSpy).not.toHaveBeenCalled();

      const accepted = await handler(input, ["--fix", "--accept-data-loss"]);
      expect(accepted.kind).toBe("passthrough");
      const repaired = stdoutSpy.mock.calls.map(([text]) => String(text)).join("");
      expect(JSON.parse(repaired).tasks[0].findings).toEqual([]);
      expect(fixFull(JSON.parse(repaired)).json).toBe(repaired);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("stays idempotent once a malformed entry has been salvaged", () => {
    const once = fixFull(graphOf({
      id: "T1",
      findings: [{ severity: "critical", claim: "salvage me" }],
      critical_findings: [],
    })).json;
    const twice = fixFull(JSON.parse(once));
    expect(twice.json).toEqual(once);
    expect(twice.notes, "a repaired graph reports nothing further").toEqual([]);
  });

  it("preserves a valid singleton refutation object as a one-element array", () => {
    const refutation = {
      finding: wellFormed,
      refutations: [{ lens: "intent", reason: "deliberate architecture" }],
    };
    const once = fixFull(graphOf({ id: "T1", refuted_findings: refutation }));
    const repaired = JSON.parse(once.json).tasks[0];
    expect(repaired.refuted_findings).toEqual([refutation]);
    expect(repaired.findings).toEqual([]);
    expect(once.notes).toEqual([]);
    expect(fixFull(JSON.parse(once.json)).json).toBe(once.json);
  });

  it("returns a valid nested finding from a malformed singleton refutation envelope", () => {
    const once = fixFull(graphOf({
      id: "T1",
      refuted_findings: { finding: wellFormed, refutations: [] },
    }));
    const repaired = JSON.parse(once.json).tasks[0];
    expect(repaired.refuted_findings).toEqual([]);
    expect(repaired.findings).toEqual([wellFormed]);
    expect(repaired.critical_findings).toEqual([wellFormed.claim]);
    expect(once.notes).toContain(
      `T1: recovered finding from malformed refutation record — "${wellFormed.claim}"`,
    );
  });

  it("returns a valid nested finding to the active set when its refutation envelope is malformed", () => {
    const once = fixFull(graphOf({
      id: "T1",
      refuted_findings: [{ finding: wellFormed, refutations: [] }],
    }));
    const repaired = JSON.parse(once.json).tasks[0];
    expect(repaired.refuted_findings).toEqual([]);
    expect(repaired.findings).toEqual([wellFormed]);
    expect(repaired.critical_findings).toEqual([wellFormed.claim]);
    expect(once.notes).toContain(
      `T1: recovered finding from malformed refutation record — "${wellFormed.claim}"`,
    );
    const twice = fixFull(JSON.parse(once.json));
    expect(twice.json).toBe(once.json);
    expect(twice.notes).toEqual([]);
  });

  it("drops a refutation record whose pair shape is broken without resurrecting an already-refuted finding", () => {
    const repaired = fix({
      id: "T1",
      refuted_findings: [
        { finding: wellFormed, refutations: [{ lens: "intent", reason: "deliberate" }] },
        { finding: wellFormed, refutations: [{ lens: "intent" }] },
      ],
    });
    expect(repaired.refuted_findings).toHaveLength(1);
    expect(repaired.findings).toEqual([]);
    expect(repaired.critical_findings).toEqual([]);
  });

  it("normalizes an invalid current_wave and reports the repair", () => {
    const input: Record<string, unknown> = graphOf({ id: "T1" });
    input.current_wave = "2";
    const repaired = fixFull(input);
    expect(JSON.parse(repaired.json).current_wave).toBe(1);
    expect(repaired.notes).toContain('normalized invalid current_wave "2" to 1');
  });

  it("produces a graph the load boundary accepts — repair and rejection agree", () => {
    // The point of the repair path: a graph parseTaskGraph refuses must become
    // one it accepts, or the operator is stuck with no way forward.
    const broken = {
      current_phase: "execute",
      phase_artifacts: {},
      tasks: [{
        id: "T1", description: "repair findings", agent: "code-implementer-agent",
        wave: 1, status: "pending", findings: [{ nonsense: true }], critical_findings: ["orphan"],
      }],
    };
    expect(parseTaskGraph(broken).ok).toBe(false);
    expect(parseTaskGraph(JSON.parse(fixFull(broken).json)).ok).toBe(true);
  });

  it("repairs every graph the load boundary rejects for a findings reason", () => {
    // The pairing that matters: rejection without a working repair dead-ends
    // the operator. Duplicate ids and view/array drift are both now rejected,
    // so both must round-trip through --fix.
    const rejected = [
      { id: "T1", wave: 1, findings: [wellFormed, wellFormed], critical_findings: ["unchecked cast", "unchecked cast"] },
      { id: "T1", wave: 1, findings: [wellFormed], critical_findings: [] },
      { id: "T1", wave: 1, findings: [], critical_findings: ["view only"] },
    ];
    for (const task of rejected) {
      const graph = {
        current_phase: "execute",
        phase_artifacts: {},
        tasks: [{
          description: "repair findings", agent: "code-implementer-agent",
          status: "pending", ...task,
        }],
      };
      expect(parseTaskGraph(graph).ok).toBe(false);
      expect(parseTaskGraph(JSON.parse(fixFull(graph).json)).ok).toBe(true);
    }
  });
});

/**
 * Round-14: the operator's validator and the loader must agree on "valid".
 *
 * `validateFull` ran no findings, lockstep, or duplicate-id checks, so
 * `helper validate-task-graph` reported `{ok: true}` on a graph
 * `StateManager.load()` refuses to open — two validators, two rule sets, and the
 * one the load-boundary diagnostic tells the operator to run was the weaker one.
 */
describe("validateFull agrees with the load boundary about the findings aggregate", () => {
  const base = {
    plan_title: "t",
    plan_file: "p.md",
    spec_file: "s.md",
  };
  const task = (fields: Record<string, unknown>) => ({
    id: "T1",
    description: "impl the thing",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    ...fields,
  });
  const graph = (fields: Record<string, unknown>) => ({
    ...base,
    current_phase: "execute",
    phase_artifacts: {},
    wave_gates: {},
    tasks: [task(fields)],
  });

  const CASES: readonly (readonly [string, Record<string, unknown>])[] = [
    ["a view claim no finding accounts for", { findings: [], critical_findings: ["orphan"], advisory_findings: [] }],
    [
      "a finding no view accounts for",
      {
        findings: [{ id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "real" }],
        critical_findings: [],
        advisory_findings: [],
      },
    ],
    ["a non-string in a derived view", { critical_findings: ["real", 42] }],
    [
      "a duplicated finding id",
      {
        findings: [
          { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "a" },
          { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "b" },
        ],
        critical_findings: ["a", "b"],
        advisory_findings: [],
      },
    ],
    ["a malformed findings entry", { findings: [{ severity: "critical", claim: "no id" }] }],
    ["a malformed refutation record", { refuted_findings: [{ finding: null, refutations: [] }] }],
  ];

  it.each(CASES)("both reject %s", (_label, fields) => {
    expect(validateFull(graph(fields)).ok, "validateFull must reject it").toBe(false);
    expect(parseTaskGraph(graph(fields)).ok, "the load boundary must reject it").toBe(false);
  });

  it.each(CASES)("--fix repairs %s so BOTH then accept it", (_label, fields) => {
    const repaired = JSON.parse(fixFull(graph(fields)).json);
    expect(validateFull(repaired).ok).toBe(true);
    expect(parseTaskGraph(repaired).ok).toBe(true);
  });

  it("rejects the same invalid execution-state union as the load boundary", () => {
    const invalid = graph({ status: "nonsense" });
    expect(validateFull(invalid, "state-file").ok).toBe(false);
    expect(parseTaskGraph(invalid).ok).toBe(false);
    expect(errorsOf(validateFull(invalid, "state-file")).join("\n")).toContain("status");
  });

  it("accepts a graph whose findings are in step", () => {
    const inStep = graph({
      findings: [{ id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "real" }],
      critical_findings: ["real"],
      advisory_findings: [],
      review_status: "blocked",
    });
    expect(validateFull(inStep).ok).toBe(true);
    expect(parseTaskGraph(inStep).ok).toBe(true);
  });

  it("does NOT apply the findings rules to the agent-controlled decompose payload", () => {
    // populate-task-graph validates the payload BEFORE sanitizeDecomposedTask
    // strips the execution state a planner must never mint. Holding it to the
    // findings invariants would reject exactly the forged input that
    // sanitization exists to clean, turning a successful strip into a hard fail.
    const forged = graph({ findings: [], critical_findings: ["planted"], advisory_findings: [] });
    expect(validateFull(forged, "decompose-payload").ok).toBe(true);
    expect(validateFull(forged, "state-file").ok).toBe(false);
  });

  it("--fix clears a review record whose evidence-failure pairing is broken", () => {
    // No honest reconstruction exists — nothing on disk says WHICH reviewer's
    // transcript could not be parsed — so the repair clears the record. That is
    // the fail-closed direction: checkReviews counts an unreviewed task as a
    // gate failure, while inventing an agent name would leave a permanent block.
    const broken = graph({ review_status: "evidence_capture_failed" });
    expect(parseTaskGraph(broken).ok).toBe(false);
    const repair = fixFull(broken);
    const repaired = JSON.parse(repair.json);
    expect(repair.notes).toContain(
      "T1: cleared an inconsistent review evidence-failure record and reset review_status to pending",
    );
    expect(repaired.tasks[0].review_status).toBe("pending");
    expect(repaired.tasks[0].review_evidence_failures).toBeUndefined();
    expect(parseTaskGraph(repaired).ok).toBe(true);
  });

  it.each([
    { review_evidence_failures: [42] },
    { review_evidence_failures: [""] },
    { review_evidence_failures: ["code-reviewer", "code-reviewer"] },
  ])(
    "--fix clears an invalid empty-equivalent or duplicate evidence-failure array: $review_evidence_failures",
    ({ review_evidence_failures }) => {
      const broken = graph({ review_status: "pending", review_evidence_failures });
      expect(parseTaskGraph(broken).ok).toBe(false);
      const repaired = JSON.parse(fixFull(broken).json);
      expect(repaired.tasks[0].review_status).toBe("pending");
      expect(repaired.tasks[0].review_evidence_failures).toBeUndefined();
      expect(parseTaskGraph(repaired).ok).toBe(true);
    },
  );

  it("--fix clears stale review_error conservatively and is idempotent", () => {
    const stale = graph({ review_status: "passed", review_error: "old parser failure" });
    expect(validateFull(stale).ok).toBe(false);
    expect(parseTaskGraph(stale).ok).toBe(false);

    const once = fixFull(stale);
    const repaired = JSON.parse(once.json);
    expect(repaired.tasks[0].review_status).toBe("pending");
    expect(repaired.tasks[0].review_error).toBeUndefined();
    expect(parseTaskGraph(repaired).ok).toBe(true);
    expect(fixFull(repaired).json).toBe(once.json);
  });

  it("--fix preserves a well-formed evidence-failure record", () => {
    const valid = graph({
      review_status: "evidence_capture_failed",
      review_error: "CRITICAL_COUNT marker not found",
      review_evidence_failures: ["code-reviewer"],
    });
    expect(parseTaskGraph(valid).ok).toBe(true);
    const repaired = JSON.parse(fixFull(valid).json);
    expect(repaired.tasks[0].review_status).toBe("evidence_capture_failed");
    expect(repaired.tasks[0].review_error).toBe("CRITICAL_COUNT marker not found");
    expect(repaired.tasks[0].review_evidence_failures).toEqual(["code-reviewer"]);
  });
});
