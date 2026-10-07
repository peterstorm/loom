import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import {
  classifyPersistedWaveBatch,
  taskReviewScope,
  waveReviewSubjects,
  type PersistedWaveBatchCandidate,
} from "../../src/core/wave-review-authority";

/** The single Task review-scope rule every review issuance path reads. */
describe("taskReviewScope", () => {
  it.each([
    { name: "union of declared and modified paths, de-duplicated and sorted", task: { file_list: ["b.ts", "a.ts"], files_modified: ["a.ts", "c.ts"] }, scope: ["a.ts", "b.ts", "c.ts"] },
    { name: "declared paths only", task: { file_list: ["z.ts", "y.ts"] }, scope: ["y.ts", "z.ts"] },
    { name: "modified paths only", task: { files_modified: ["m.ts"] }, scope: ["m.ts"] },
    { name: "no paths", task: {}, scope: [] },
  ])("$name", ({ task, scope }) => {
    expect(taskReviewScope(task)).toEqual(scope);
  });
});

/** The canonical Wave review batch order: issuance, recovery and labelling read it. */
describe("waveReviewSubjects", () => {
  it("puts spec-check first, then every Task in roster order with every reviewer role in catalog order", () => {
    expect(waveReviewSubjects(["T2", "T1"])).toEqual([
      { role: "spec-check-invoker", taskId: null },
      ...WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T2" })),
      ...WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T1" })),
    ]);
  });

  it("keeps the `{ role, taskId }` key order slot identity hashes", () => {
    // Slot and request ids hash `JSON.stringify(subject)`; a reordered key
    // would re-derive every persisted Wave slot id.
    expect(waveReviewSubjects(["T1"]).map((subject) => JSON.stringify(subject))).toEqual([
      '{"role":"spec-check-invoker","taskId":null}',
      ...WAVE_REVIEW_AGENTS.map((role) => `{"role":"${role}","taskId":"T1"}`),
    ]);
  });
});

describe("classifyPersistedWaveBatch", () => {
  const candidatesOf = (taskIds: readonly string[]): PersistedWaveBatchCandidate<string>[] =>
    waveReviewSubjects(taskIds).map((subject, index) => ({ role: subject.role, taskId: subject.taskId, value: `request-${index}` }));
  const canonical = (taskIds: readonly string[]) => candidatesOf(taskIds).map(({ value }) => value);

  it("property: any permutation of the exact batch classifies as exact, in canonical order", () => {
    const roster = fc.uniqueArray(fc.constantFrom("T1", "T2", "T3", "T4"), { minLength: 1, maxLength: 4 });
    fc.assert(fc.property(roster.chain((taskIds) =>
      fc.tuple(fc.constant(taskIds), fc.shuffledSubarray(candidatesOf(taskIds), { minLength: candidatesOf(taskIds).length }))),
    ([taskIds, shuffled]) => {
      expect(classifyPersistedWaveBatch(taskIds, shuffled)).toEqual({ kind: "exact", ordered: canonical(taskIds) });
    }));
  });

  it("ranks a spec-check request first whatever Task its context names", () => {
    const [spec, ...reviewers] = candidatesOf(["T1"]);
    expect(classifyPersistedWaveBatch(["T1"], [...reviewers, { ...spec!, taskId: "T1" }]))
      .toEqual({ kind: "exact", ordered: canonical(["T1"]) });
  });

  it.each([
    ["a strict prefix", (all: PersistedWaveBatchCandidate<string>[]) => all.slice(0, -1)],
    ["a missing spec-check", (all: PersistedWaveBatchCandidate<string>[]) => all.slice(1)],
    ["a duplicate spec-check in place of a reviewer", (all: PersistedWaveBatchCandidate<string>[]) => [all[0]!, ...all.slice(0, -1)]],
    ["a duplicate reviewer", (all: PersistedWaveBatchCandidate<string>[]) => [...all.slice(0, -1), all[1]!]],
    ["a foreign Task", (all: PersistedWaveBatchCandidate<string>[]) => [...all.slice(0, -1), { ...all.at(-1)!, taskId: "T9" }]],
    ["a reviewer naming no Task", (all: PersistedWaveBatchCandidate<string>[]) => [...all.slice(0, -1), { ...all.at(-1)!, taskId: null }]],
    ["an unknown role", (all: PersistedWaveBatchCandidate<string>[]) => [...all.slice(0, -1), { ...all.at(-1)!, role: "code-implementer-agent" }]],
    ["a surplus request", (all: PersistedWaveBatchCandidate<string>[]) => [...all, { ...all[1]!, value: "surplus" }]],
  ])("classifies %s as incomplete", (_name, mutate) => {
    expect(classifyPersistedWaveBatch(["T1", "T2"], mutate(candidatesOf(["T1", "T2"])))).toEqual({ kind: "incomplete" });
  });
});
