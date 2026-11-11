/**
 * `skeletonOutcomesOf` (AD-13, FR-030): properties over generated Tasks,
 * bindings, records and observations — exactly one outcome per non-test
 * file_list path, in file_list order, never one for a test file; the
 * derivation is deterministic; and each outcome agrees with the precedence
 * step its inputs select. Hand-written rows pin that precedence order.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isTestFileBySuffixes, DEFAULT_TEST_FILE_SUFFIXES } from "../../src/core/test-file-classification";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { isUntouchedSkeleton, renderSkeletonOutcome } from "../../src/core/skeleton/outcomes";
import { knownSkeletonOutcomes } from "../fixtures/known-skeleton-outcomes";
import { observationArb, SHAS } from "../fixtures/skeleton-arbitraries";
import { binding, frozenManifestWith } from "../fixtures/skeleton-builders";
import { OUTCOME_TEXT } from "../fixtures/skeleton-repo";
import type { ExportBinding, PathObservation, SkeletonRecord } from "../../src/core/skeleton/types";
import type { TaskGraph } from "../../src/types";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

/** Every outcome's rendered wording: the fixture's outcome strings, less the stale flag. */
const { stale: _staleFlag, ...OUTCOME_WORDING } = OUTCOME_TEXT;
const RENDERED: ReadonlySet<string> = new Set(Object.values(OUTCOME_WORDING));

const pathArb = fc.tuple(
  fc.constantFrom("src", "src/main/java/a", "lib", "tests"),
  fc.constantFrom("A", "B", "C", "D", "E", "F"),
  fc.constantFrom(".ts", ".tsx", ".java", ".kt", ".rs", ".test.ts", ".spec.tsx"),
).map(([dir, name, ext]) => `${dir}/${name}${ext}`);

const scenarioArb = fc.record({
  files: fc.uniqueArray(pathArb, { maxLength: 10 }),
  boundMask: fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }),
  recordMask: fc.array(fc.option(fc.constantFrom(...SHAS), { nil: null }), { minLength: 10, maxLength: 10 }),
  observed: fc.array(fc.option(observationArb, { nil: undefined }), { minLength: 10, maxLength: 10 }),
});

type Scenario = Readonly<{
  graph: TaskGraph;
  files: readonly string[];
  bound: ReadonlySet<string>;
  records: ReadonlyMap<string, SkeletonRecord>;
  observations: ReadonlyMap<string, PathObservation>;
}>;

type RawScenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

const build = ({ files, boundMask, recordMask, observed }: RawScenario): Scenario => {
  const bindings: ExportBinding[] = files.filter((_, i) => boundMask[i]).map((path) => binding(path, "CT-1", ["run", "RunFn"]));
  const records = new Map(files.flatMap((path, i): [string, SkeletonRecord][] => {
    const engineSha256 = recordMask[i];
    return engineSha256 === null || engineSha256 === undefined ? [] : [[path, {
      path, contract: "CT-1", language: "typescript", origin: "revision", engineSha256, typesSha256: SHAS[0]!, stale: null,
    }]];
  }));
  const observations = new Map(files.flatMap((path, i): [string, PathObservation][] => {
    const observation = observed[i];
    return observation === undefined ? [] : [[path, observation]];
  }));
  const task = taskFixture({
    id: "T2", description: "T2", agent: "code-implementer-agent", wave: 2, depends_on: [],
    file_list: [...files], spec_anchors: [], spec_contributions: [], new_tests_required: false,
  });
  return {
    graph: { ...graphFixture([task]), export_bindings: bindings, skeletons: [...records.values()] },
    files,
    bound: new Set(bindings.map(({ path }) => path)),
    records,
    observations,
  };
};

describe("skeletonOutcomesOf: properties", () => {
  it("exactly one outcome per non-test path, in file_list order, none for a test file", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, files, observations } = build(raw);
      const outcomes = knownSkeletonOutcomes(graph, "T2", observations);
      expect(outcomes.map(({ path }) => path)).toEqual(files.filter((path) => !isTestFileBySuffixes(path, DEFAULT_TEST_FILE_SUFFIXES)));
      for (const { outcome } of outcomes) expect(RENDERED.has(renderSkeletonOutcome(outcome))).toBe(true);
    }), { numRuns: 300 });
  });

  it("is deterministic", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, observations } = build(raw);
      expect(knownSkeletonOutcomes(graph, "T2", observations)).toEqual(knownSkeletonOutcomes(graph, "T2", observations));
    }), { numRuns: 200 });
  });

  it("each outcome is the one its precedence step selects", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, bound, records, observations } = build(raw);
      for (const { path, outcome } of knownSkeletonOutcomes(graph, "T2", observations)) {
        const observation = observations.get(path) ?? { kind: "absent" };
        const record = records.get(path);
        const target = skeletonLanguageOf(path);
        const want = observation.kind === "present"
          ? isUntouchedSkeleton(record, observation.sha256, observation.canonicalSha256)
            ? { kind: "skeleton-written", origin: record?.origin ?? "spawn" }
            : { kind: "exists-not-skeletonized" }
          : !bound.has(path)
          ? { kind: "no-bound-exports" }
          : target.kind === "unsupported"
          ? { kind: "unsupported-language", reason: target.reason }
          : { kind: "skeleton-written", origin: "spawn" };
        expect(outcome).toEqual(want);
      }
    }), { numRuns: 300 });
  });
});

/** One path's outcome, its inputs named: bound or not, the engine digest its
 *  record holds (if recorded), and what is on disk (absent when omitted). */
const outcomeAt = (
  path: string,
  inputs: Readonly<{ bound: boolean; recorded: string | null; observation?: PathObservation }>,
) => {
  const { graph, observations } = build({ files: [path], boundMask: [inputs.bound], recordMask: [inputs.recorded], observed: [inputs.observation] });
  const [only] = knownSkeletonOutcomes(graph, "T2", observations);
  return only?.outcome;
};

const [ENGINE_SHA, EDITED_SHA, CANONICAL_SHA] = SHAS as [string, string, string];
const onDisk = (sha256: string, canonicalSha256: string | null = null): PathObservation => ({ kind: "present", sha256, canonicalSha256 });

describe("skeletonOutcomesOf: precedence, by example (present, then untouched, then bound, then language)", () => {
  it("an untouched skeleton is written with its record's origin, even unbound and in an unsupported language", () => {
    expect(outcomeAt("src/A.kt", { bound: false, recorded: ENGINE_SHA, observation: onDisk(ENGINE_SHA) }))
      .toEqual({ kind: "skeleton-written", origin: "revision" });
  });

  it("canonical bytes with no record are adopted as a spawn skeleton", () => {
    expect(outcomeAt("src/A.ts", { bound: true, recorded: null, observation: onDisk(CANONICAL_SHA, CANONICAL_SHA) }))
      .toEqual({ kind: "skeleton-written", origin: "spawn" });
  });

  it("any other present file exists, even bound in a supported language", () => {
    expect(outcomeAt("src/A.ts", { bound: true, recorded: ENGINE_SHA, observation: onDisk(EDITED_SHA, CANONICAL_SHA) }))
      .toEqual({ kind: "exists-not-skeletonized" });
  });

  it("an absent unbound file has no bound exports, whatever its language", () => {
    expect(outcomeAt("src/A.ts", { bound: false, recorded: null })).toEqual({ kind: "no-bound-exports" });
    expect(outcomeAt("src/A.rs", { bound: false, recorded: null })).toEqual({ kind: "no-bound-exports" });
  });

  it("an absent bound file is unsupported only after the binding is found", () => {
    expect(outcomeAt("src/A.rs", { bound: true, recorded: null })).toEqual({ kind: "unsupported-language", reason: "other-extension" });
  });

  it("an absent bound file in a supported language is a skeleton to write, whatever its record holds", () => {
    expect(outcomeAt("src/A.ts", { bound: true, recorded: ENGINE_SHA })).toEqual({ kind: "skeleton-written", origin: "spawn" });
  });
});

describe("skeletonOutcomesOf: the frozen test-file classification decides test paths", () => {
  it("a manifest's suffixes, not the engine default, exclude test files", () => {
    const task = taskFixture({
      id: "T2", description: "T2", agent: "code-implementer-agent", wave: 2, depends_on: [],
      file_list: ["src/main/java/a/PricingTest.java", "src/a.test.ts"], spec_anchors: [], spec_contributions: [], new_tests_required: false,
    });
    const graph: TaskGraph = {
      ...graphFixture([task]),
      verification_manifest: frozenManifestWith(["Test.java"]),
    };
    expect(knownSkeletonOutcomes(graph, "T2", new Map()).map(({ path }) => path)).toEqual(["src/a.test.ts"]);
  });
});
