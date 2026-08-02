import { describe, it, expect, vi } from "vitest";
import { validateMinimal, validateFull, fixFull } from "../../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../../src/state-manager";

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

  it("rejects a non-array depends_on", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: "T2" }],
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("Task T1: 'depends_on' must be array");
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

  it("drops a refutation record whose pair shape is broken", () => {
    const repaired = fix({
      id: "T1",
      refuted_findings: [
        { finding: wellFormed, refutations: [{ lens: "intent", reason: "deliberate" }] },
        { finding: wellFormed, refutations: [{ lens: "intent" }] },
      ],
    });
    expect(repaired.refuted_findings).toHaveLength(1);
  });

  it("produces a graph the load boundary accepts — repair and rejection agree", () => {
    // The point of the repair path: a graph parseTaskGraph refuses must become
    // one it accepts, or the operator is stuck with no way forward.
    const broken = {
      current_phase: "execute",
      phase_artifacts: {},
      tasks: [{ id: "T1", wave: 1, status: "pending", findings: [{ nonsense: true }], critical_findings: ["orphan"] }],
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
      const graph = { current_phase: "execute", phase_artifacts: {}, tasks: [{ status: "pending", ...task }] };
      expect(parseTaskGraph(graph).ok).toBe(false);
      expect(parseTaskGraph(JSON.parse(fixFull(graph).json)).ok).toBe(true);
    }
  });
});
