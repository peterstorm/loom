import { describe, expect, it } from "vitest";
import {
  parseSpecTraceContract,
  specTraceDiagnosticMessages,
} from "../../src/core/spec-trace";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../../src/state-manager";

const task = (
  id: string,
  wave: number,
  spec_anchors: readonly string[],
  spec_contributions: readonly string[],
) => ({ id, wave, spec_anchors, spec_contributions });

const codesOf = (raw: ReturnType<typeof parseSpecTraceContract>): readonly string[] =>
  raw.ok ? [] : raw.diagnostics.map(({ code }) => code);

describe("Requirement trace v2", () => {
  it("accepts contributions culminating in exactly one same-or-later completion Wave", () => {
    const parsed = parseSpecTraceContract(2, [
      task("T1", 1, [], ["FR-1"]),
      task("T2", 2, ["FR-1"], ["FR-1"]),
      task("T3", 2, ["FR-1"], []),
    ]);
    expect(parsed.ok).toBe(false);
    expect(codesOf(parsed)).toContain("overlapping-trace-role");

    expect(parseSpecTraceContract(2, [
      task("T1", 1, [], ["FR-1"]),
      task("T2", 2, ["FR-1"], []),
      task("T3", 2, ["FR-1"], []),
    ]).ok).toBe(true);
  });

  it.each([
    ["duplicate entries", [task("T1", 1, ["FR-1", "FR-1"], [])], "duplicate-trace-entry"],
    ["same-Task overlap", [task("T1", 1, ["FR-1"], ["FR-1"])], "overlapping-trace-role"],
    ["multiple completion Waves", [task("T1", 1, ["FR-1"], []), task("T2", 2, ["FR-1"], [])], "multiple-completion-waves"],
    ["missing completion", [task("T1", 1, [], ["FR-1"])], "missing-completion-wave"],
    ["late contribution", [task("T1", 1, ["FR-1"], []), task("T2", 2, [], ["FR-1"])], "contribution-after-completion"],
  ] as const)("rejects %s with an actionable diagnostic", (_label, tasks, code) => {
    const parsed = parseSpecTraceContract(2, tasks);
    expect(parsed.ok).toBe(false);
    expect(codesOf(parsed)).toContain(code);
    expect(specTraceDiagnosticMessages(parsed).every((message) => message.length > 20)).toBe(true);
  });

  it("keeps legacy completion-only graphs readable but refuses unversioned contributions", () => {
    expect(parseSpecTraceContract(undefined, [{ id: "T1", wave: 1, spec_anchors: ["FR-1", "FR-1"] }]).ok)
      .toBe(true);
    expect(codesOf(parseSpecTraceContract(undefined, [{
      id: "T1", wave: 1, spec_anchors: [], spec_contributions: ["FR-1"],
    }]))).toContain("legacy-contributions");
    expect(codesOf(parseSpecTraceContract(undefined, [], { requireV2: true })))
      .toContain("trace-version-required");
  });

  it("keeps validate-task-graph and StateManager parsing in lockstep", () => {
    const tasks = [
      {
        id: "T1", description: "complete early", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], spec_anchors: ["FR-1"], spec_contributions: [],
      },
      {
        id: "T2", description: "contribute late", agent: "code-implementer-agent", wave: 2,
        status: "pending", depends_on: ["T1"], spec_anchors: [], spec_contributions: ["FR-1"],
      },
    ];
    const graph = {
      spec_trace_version: 2,
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      plan_title: "trace",
      plan_file: "plan.md",
      spec_file: "spec.md",
      tasks,
      wave_gates: {},
    };
    const validated = validateFull(graph);
    const parsed = parseTaskGraph(graph);
    expect(validated.ok).toBe(false);
    expect(parsed.ok).toBe(false);
    if (!validated.ok && !parsed.ok) {
      const traceMessage = validated.errors.find((message) => message.includes("after its Completion Wave"));
      expect(traceMessage).toBeDefined();
      expect(parsed.error).toContain(traceMessage!);
    }
  });
});
