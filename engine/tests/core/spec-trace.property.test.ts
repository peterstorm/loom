import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpecTraceContract } from "../../src/core/spec-trace";
import { prepareSpecTraceUpgrade } from "../../src/core/spec-trace-migration";
import type { TaskGraph } from "../../src/types";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../../src/state-manager";

const anchorArbitrary = fc.integer({ min: 1, max: 1000 }).map((n) => `FR-${n}`);

const codesOf = (result: ReturnType<typeof parseSpecTraceContract>): readonly string[] =>
  result.ok ? [] : result.diagnostics.map(({ code }) => code);

describe("Requirement trace properties", () => {
  it("any generated contribution schedule at or before one completion Wave is valid", () => {
    fc.assert(fc.property(
      fc.uniqueArray(anchorArbitrary, { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 6 }),
      fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 0, maxLength: 12 }),
      (anchors, completionWave, rawContributionWaves) => {
        const contributionWaves = rawContributionWaves.map((wave) => Math.min(wave, completionWave));
        const tasks = [
          ...contributionWaves.map((wave, index) => ({
            id: `C${index + 1}`,
            wave,
            spec_anchors: [],
            spec_contributions: [anchors[index % anchors.length]!],
          })),
          ...anchors.map((anchor, index) => ({
            id: `F${index + 1}`,
            wave: completionWave,
            spec_anchors: [anchor],
            spec_contributions: [],
          })),
        ];
        expect(parseSpecTraceContract(2, tasks).ok).toBe(true);
      },
    ), { numRuns: 250 });
  });

  it("moving any contribution after its unique completion always fails closed", () => {
    fc.assert(fc.property(
      anchorArbitrary,
      fc.integer({ min: 1, max: 20 }),
      (anchor, completionWave) => {
        const tasks = [
          {
            id: "T1", description: "complete", agent: "code-implementer-agent", status: "pending" as const,
            depends_on: [], wave: completionWave, spec_anchors: [anchor], spec_contributions: [],
          },
          {
            id: "T2", description: "late", agent: "code-implementer-agent", status: "pending" as const,
            depends_on: ["T1"], wave: completionWave + 1, spec_anchors: [], spec_contributions: [anchor],
          },
        ];
        const result = parseSpecTraceContract(2, tasks);
        expect(codesOf(result)).toContain("contribution-after-completion");
        const graph = {
          spec_trace_version: 2,
          current_phase: "execute",
          phase_artifacts: {},
          skipped_phases: [],
          plan_title: "trace",
          plan_file: "plan.md",
          spec_file: "spec.md",
          wave_gates: {},
          tasks,
        };
        const validation = validateFull(graph);
        const parsed = parseTaskGraph(graph);
        expect(validation.ok).toBe(false);
        expect(parsed.ok).toBe(false);
        if (!validation.ok && !parsed.ok) {
          const message = validation.errors.find((error) => error.includes("after its Completion Wave"));
          expect(message).toBeDefined();
          expect(parsed.error).toContain(message!);
        }
      },
    ));
  });

  it("duplicating any v2 trace array member always fails closed", () => {
    fc.assert(fc.property(anchorArbitrary, fc.boolean(), (anchor, duplicateContribution) => {
      const result = parseSpecTraceContract(2, [{
        id: "T1",
        wave: 1,
        spec_anchors: duplicateContribution ? [] : [anchor, anchor],
        spec_contributions: duplicateContribution ? [anchor, anchor] : [],
      }]);
      expect(codesOf(result)).toContain("duplicate-trace-entry");
    }));
  });

  it("legacy upgrade is idempotent and preserves every non-trace Task field", () => {
    fc.assert(fc.property(anchorArbitrary, fc.nat({ max: 1000 }), (anchor, generation) => {
      const graph: TaskGraph = {
        current_phase: "execute",
        current_wave: 1,
        phase_artifacts: {},
        skipped_phases: [],
        spec_file: "spec.md",
        plan_file: "plan.md",
        wave_gates: {},
        tasks: [
          {
            id: "T1", description: "partial", agent: "code-implementer-agent", wave: 1,
            status: "pending", depends_on: [], spec_anchors: [], review_generation: generation,
            findings: [], critical_findings: [], advisory_findings: [], refuted_findings: [], resolved_findings: [],
          },
          {
            id: "T2", description: "complete", agent: "code-implementer-agent", wave: 1,
            status: "pending", depends_on: [], spec_anchors: [anchor], review_generation: generation,
            findings: [], critical_findings: [], advisory_findings: [], refuted_findings: [], resolved_findings: [],
          },
        ],
      };
      const input = {
        spec_trace_version: 2,
        tasks: [
          { id: "T1", spec_anchors: [], spec_contributions: [anchor] },
          { id: "T2", spec_anchors: [anchor], spec_contributions: [] },
        ],
      };
      const upgraded = prepareSpecTraceUpgrade(graph, input);
      expect(upgraded.ok).toBe(true);
      if (!upgraded.ok) return;
      const stripTrace = ({ spec_anchors: _a, spec_contributions: _c, ...task }: TaskGraph["tasks"][number]) => task;
      expect(upgraded.value.graph.tasks.map(stripTrace)).toEqual(graph.tasks.map(stripTrace));
      const replay = prepareSpecTraceUpgrade(upgraded.value.graph, input);
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.value.kind).toBe("already-v2");
    }), { numRuns: 150 });
  });
});
