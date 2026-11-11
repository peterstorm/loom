/**
 * Skeletons and a Distill Task (ADR-0068 §9): it holds no export binding, so
 * `skeletonOutcomesOf` never reports `skeleton-written` for it and the planner
 * derives no write. That its recorded outcomes load is proven against a real
 * State File in `handlers/task-execution-distill-skeletons.test.ts`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { productionFiles, skeletonHolderFiles } from "../../src/core/skeleton/graph-view";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { skeletonOutcomesOf } from "../../src/core/skeleton/outcomes";
import type { ExportBinding, PathObservation, PathSkeletonOutcome, SkeletonRecord } from "../../src/core/skeleton/types";
import { planTaskSkeletons } from "../../src/orchestration/skeleton-materialization";
import type { TaskGraph } from "../../src/types";
import { observationArb, SHAS } from "../fixtures/skeleton-arbitraries";
import { binding, unwrap } from "../fixtures/skeleton-builders";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const pathArb = fc.tuple(
  fc.constantFrom("src", "src/main/java/a", "lib"),
  fc.constantFrom("A", "B", "C", "D", "E", "F"),
  fc.constantFrom(".ts", ".tsx", ".java", ".kt", ".rs"),
).map(([dir, name, ext]) => `${dir}/${name}${ext}`);

const scenarioArb = fc.record({
  files: fc.uniqueArray(pathArb, { minLength: 1, maxLength: 8 }),
  boundMask: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
  recordMask: fc.array(fc.option(fc.constantFrom(...SHAS), { nil: null }), { minLength: 8, maxLength: 8 }),
  observed: fc.array(fc.option(observationArb, { nil: undefined }), { minLength: 8, maxLength: 8 }),
});

type RawScenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

/** A Wave whose implementer `T2` and Distill Task `T9` list the same files. */
function build({ files, boundMask, recordMask, observed }: RawScenario) {
  const bindings: ExportBinding[] = files.filter((_, i) => boundMask[i]).map((path) => binding(path, "CT-1", ["run", "RunFn"]));
  const records = files.flatMap((path, i): SkeletonRecord[] => {
    const engineSha256 = recordMask[i];
    return engineSha256 === null || engineSha256 === undefined ? [] : [{
      path, contract: "CT-1", language: "typescript", origin: "spawn", engineSha256, typesSha256: SHAS[0] ?? "", stale: null,
    }];
  });
  const observations = new Map(files.flatMap((path, i): [string, PathObservation][] => {
    const observation = observed[i];
    return observation === undefined ? [] : [[path, observation]];
  }));
  const holder = taskFixture({
    id: "T2", description: "T2", agent: "code-implementer-agent", wave: 2, depends_on: [],
    file_list: [...files], spec_anchors: [], spec_contributions: [], new_tests_required: false,
  });
  const distill = taskFixture({
    id: "T9", description: "distill", agent: DISTILL_AGENT, wave: 2, depends_on: [],
    file_list: [...files], spec_anchors: [], spec_contributions: [],
  });
  const graph: TaskGraph = { ...graphFixture([holder, distill]), export_bindings: bindings, skeletons: records };
  return { graph, files, bound: new Set(bindings.map(({ path }) => path)), observations };
}

const outcomesOf = (graph: TaskGraph, taskId: string, observations: ReadonlyMap<string, PathObservation>): readonly PathSkeletonOutcome[] =>
  unwrap(skeletonOutcomesOf(graph, taskId, observations), `skeletonOutcomesOf(${taskId})`);

describe("skeletonHolderFiles", () => {
  it("is every production file of an implementer and none of a Distill Task's", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph } = build(raw);
      const [holder, distill] = graph.tasks;
      if (holder === undefined || distill === undefined) throw new Error("fixture tasks");
      expect(skeletonHolderFiles(graph, holder)).toEqual(productionFiles(graph, holder));
      expect(skeletonHolderFiles(graph, distill)).toEqual([]);
      // Conformance scope still reads every file the Distill Task lists.
      expect(productionFiles(graph, distill)).toEqual(productionFiles(graph, holder));
    }));
  });
});

describe("a Distill Task's skeleton outcomes", () => {
  it("property: never skeleton-written; a present path exists; an absent path keeps the holder's reason or has no outcome", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, files, bound, observations } = build(raw);
      const distill = new Map(outcomesOf(graph, "T9", observations).map(({ path, outcome }) => [path, outcome] as const));
      const holder = new Map(outcomesOf(graph, "T2", observations).map(({ path, outcome }) => [path, outcome] as const));
      for (const path of files) {
        const observation = observations.get(path) ?? { kind: "absent" };
        const outcome = distill.get(path);
        expect(outcome?.kind).not.toBe("skeleton-written");
        if (observation.kind === "present") {
          expect(outcome).toEqual({ kind: "exists-not-skeletonized" });
        } else if (bound.has(path) && skeletonLanguageOf(path).kind === "supported") {
          // A holder would be given a Skeleton here; a Distill Task is given nothing, and says nothing.
          expect(holder.get(path)).toEqual({ kind: "skeleton-written", origin: "spawn" });
          expect(outcome).toBeUndefined();
        } else {
          expect(outcome).toEqual(holder.get(path));
        }
      }
      expect([...distill.keys()]).toEqual(files.filter((path) => distill.has(path)));
    }), { numRuns: 300 });
  });

  it("property: the planner derives no write for it, whatever is on disk", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, observations } = build(raw);
      const plan = planTaskSkeletons(graph, "T9", observations, new Map());
      expect(plan).toMatchObject({ ok: true, value: { taskId: "T9", actions: [] } });
    }), { numRuns: 200 });
  });

  it("an untouched engine skeleton is its holder's: the holder reports it written, the Distill Task that it exists", () => {
    const [sha] = SHAS;
    if (sha === undefined) throw new Error("fixture digest");
    const { graph, observations } = build({
      files: ["src/A.ts"], boundMask: [true, false, false, false, false, false, false, false],
      recordMask: [sha, null, null, null, null, null, null, null],
      observed: [{ kind: "present", sha256: sha, canonicalSha256: sha }, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    });
    expect(outcomesOf(graph, "T2", observations)).toEqual([{ path: "src/A.ts", outcome: { kind: "skeleton-written", origin: "spawn" } }]);
    expect(outcomesOf(graph, "T9", observations)).toEqual([{ path: "src/A.ts", outcome: { kind: "exists-not-skeletonized" } }]);
  });
});
