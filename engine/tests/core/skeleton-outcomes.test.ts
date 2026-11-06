/**
 * `skeletonOutcomes` (AD-13, FR-030): properties over generated Tasks,
 * bindings, records and observations — exactly one outcome per non-test
 * file_list path, in file_list order, never one for a test file; the
 * derivation is deterministic; and each outcome agrees with the precedence
 * step its inputs select.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isTestFileBySuffixes, DEFAULT_TEST_FILE_SUFFIXES } from "../../src/core/test-file-classification";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { isUntouchedSkeleton, renderSkeletonOutcome, skeletonOutcomes } from "../../src/core/skeleton/outcomes";
import type { SkeletonGraph } from "../../src/core/skeleton/scope";
import type { ExportBinding, Identifier, PathObservation, SkeletonRecord } from "../../src/core/skeleton/types";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const RENDERED = new Set([
  "skeleton written",
  "no bound exports, no skeleton",
  "contract has no types file, no skeletons",
  "unsupported language, no skeleton",
  "exists, not skeletonized",
]);

const SHAS = ["a", "b", "c"].map((fill) => fill.repeat(64));

const pathArb = fc.tuple(
  fc.constantFrom("src", "src/main/java/a", "lib", "tests"),
  fc.constantFrom("A", "B", "C", "D", "E", "F"),
  fc.constantFrom(".ts", ".tsx", ".java", ".kt", ".rs", ".test.ts", ".spec.tsx"),
).map(([dir, name, ext]) => `${dir}/${name}${ext}`);

const observationArb: fc.Arbitrary<PathObservation> = fc.oneof(
  fc.constant<PathObservation>({ kind: "absent" }),
  fc.record({
    kind: fc.constant("present" as const),
    sha256: fc.constantFrom(...SHAS),
    canonicalSha256: fc.option(fc.constantFrom(...SHAS), { nil: null }),
  }),
);

const scenarioArb = fc.record({
  files: fc.uniqueArray(pathArb, { maxLength: 10 }),
  boundMask: fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }),
  recordMask: fc.array(fc.option(fc.constantFrom(...SHAS), { nil: null }), { minLength: 10, maxLength: 10 }),
  observed: fc.array(fc.option(observationArb, { nil: undefined }), { minLength: 10, maxLength: 10 }),
});

type Scenario = Readonly<{
  graph: SkeletonGraph;
  files: readonly string[];
  bound: ReadonlySet<string>;
  records: ReadonlyMap<string, SkeletonRecord>;
  observations: ReadonlyMap<string, PathObservation>;
}>;

type RawScenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

const build = ({ files, boundMask, recordMask, observed }: RawScenario): Scenario => {
  const bindings: ExportBinding[] = files.filter((_, i) => boundMask[i]).map((path) => ({
    path,
    contract: "CT-1",
    exports: [{ name: "run" as Identifier, alias: "RunFn" as Identifier }],
  }));
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

describe("skeletonOutcomes: properties", () => {
  it("exactly one outcome per non-test path, in file_list order, none for a test file", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, files, observations } = build(raw);
      const outcomes = skeletonOutcomes(graph, "T2", observations);
      expect(outcomes.map(({ path }) => path)).toEqual(files.filter((path) => !isTestFileBySuffixes(path, DEFAULT_TEST_FILE_SUFFIXES)));
      for (const { outcome } of outcomes) expect(RENDERED.has(renderSkeletonOutcome(outcome))).toBe(true);
    }), { numRuns: 300 });
  });

  it("is deterministic", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, observations } = build(raw);
      expect(skeletonOutcomes(graph, "T2", observations)).toEqual(skeletonOutcomes(graph, "T2", observations));
    }), { numRuns: 200 });
  });

  it("each outcome is the one its precedence step selects", () => {
    fc.assert(fc.property(scenarioArb, (raw) => {
      const { graph, bound, records, observations } = build(raw);
      for (const { path, outcome } of skeletonOutcomes(graph, "T2", observations)) {
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

/** The `.loom/verification-manifest.json` bytes, frozen as population freezes them. */
function manifestWithSuffixes(testFileSuffixes: readonly string[]): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], schemaVersion: 2, testFileSuffixes,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

describe("skeletonOutcomes: the frozen test-file classification decides test paths", () => {
  it("a manifest's suffixes, not the engine default, exclude test files", () => {
    const task = taskFixture({
      id: "T2", description: "T2", agent: "code-implementer-agent", wave: 2, depends_on: [],
      file_list: ["src/main/java/a/PricingTest.java", "src/a.test.ts"], spec_anchors: [], spec_contributions: [], new_tests_required: false,
    });
    const graph: SkeletonGraph = {
      ...graphFixture([task]),
      verification_manifest: manifestWithSuffixes(["Test.java"]),
    };
    expect(skeletonOutcomes(graph, "T2", new Map()).map(({ path }) => path)).toEqual(["src/a.test.ts"]);
  });
});
