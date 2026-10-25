import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BASE_WAVE_REVIEW_AGENTS,
  OWNER_MAPPED_WAVE_REVIEW_AGENTS,
  waveReviewRoster,
} from "../../src/core/agent-catalog-projections";
import {
  classifyPersistedWaveBatch,
  taskReviewScope,
  waveReviewSubjects,
  type PersistedWaveBatchCandidate,
  type WaveTaskReviewRoster,
} from "../../src/core/wave-review-authority";

/** Plain Tasks: every one on the base roster. */
const base = (...taskIds: readonly string[]): readonly WaveTaskReviewRoster[] =>
  taskIds.map((taskId) => ({ taskId, roster: BASE_WAVE_REVIEW_AGENTS }));

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
  it("puts spec-check first, then every Task in registration order with every role of its roster in roster order", () => {
    expect(waveReviewSubjects(base("T2", "T1"))).toEqual([
      { role: "spec-check-invoker", taskId: null },
      ...BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T2" })),
      ...BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T1" })),
    ]);
  });

  it("FR-022: an owner-mapped Task's subjects add architecture-tech-lead after its base five; other Tasks keep exactly five", () => {
    const subjects = waveReviewSubjects([
      { taskId: "T1", roster: OWNER_MAPPED_WAVE_REVIEW_AGENTS },
      { taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS },
    ]);
    expect(subjects).toEqual([
      { role: "spec-check-invoker", taskId: null },
      ...BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T1" })),
      { role: "architecture-tech-lead", taskId: "T1" },
      ...BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T2" })),
    ]);
    expect(subjects.filter(({ taskId }) => taskId === "T1")).toHaveLength(6);
    expect(subjects.filter(({ taskId }) => taskId === "T2")).toHaveLength(5);
  });

  it("keeps the `{ role, taskId }` key order slot identity hashes", () => {
    // Slot and request ids hash `JSON.stringify(subject)`; a reordered key
    // would re-derive every persisted Wave slot id.
    expect(waveReviewSubjects(base("T1")).map((subject) => JSON.stringify(subject))).toEqual([
      '{"role":"spec-check-invoker","taskId":null}',
      ...BASE_WAVE_REVIEW_AGENTS.map((role) => `{"role":"${role}","taskId":"T1"}`),
    ]);
  });
});

describe("classifyPersistedWaveBatch", () => {
  const candidatesOf = (rosters: readonly WaveTaskReviewRoster[]): PersistedWaveBatchCandidate<string>[] =>
    waveReviewSubjects(rosters).map((subject, index) => ({ role: subject.role, taskId: subject.taskId, value: `request-${index}` }));
  const canonical = (rosters: readonly WaveTaskReviewRoster[]) => candidatesOf(rosters).map(({ value }) => value);

  it("property: any permutation of the exact batch classifies as exact, in canonical order, whatever each Task's roster", () => {
    const rosters = fc.uniqueArray(fc.constantFrom("T1", "T2", "T3", "T4"), { minLength: 1, maxLength: 4 })
      .chain((taskIds) => fc.tuple(...taskIds.map((taskId) =>
        fc.boolean().map((ownerMapped): WaveTaskReviewRoster => ({ taskId, roster: waveReviewRoster(ownerMapped) })))));
    fc.assert(fc.property(rosters.chain((taskRosters) =>
      fc.tuple(fc.constant(taskRosters), fc.shuffledSubarray(candidatesOf(taskRosters), { minLength: candidatesOf(taskRosters).length }))),
    ([taskRosters, shuffled]) => {
      expect(classifyPersistedWaveBatch(taskRosters, shuffled)).toEqual({ kind: "exact", ordered: canonical(taskRosters) });
    }));
  });

  it("ranks a spec-check request first whatever Task its context names", () => {
    const [spec, ...reviewers] = candidatesOf(base("T1"));
    expect(classifyPersistedWaveBatch(base("T1"), [...reviewers, { ...spec!, taskId: "T1" }]))
      .toEqual({ kind: "exact", ordered: canonical(base("T1")) });
  });

  it("FR-022: a persisted five-reviewer batch is incomplete against an owner-mapped Task's derived roster", () => {
    const ownerMapped = [{ taskId: "T1", roster: OWNER_MAPPED_WAVE_REVIEW_AGENTS }] as const;
    expect(classifyPersistedWaveBatch(ownerMapped, candidatesOf(base("T1")))).toEqual({ kind: "incomplete" });
    expect(classifyPersistedWaveBatch(base("T1"), candidatesOf(ownerMapped))).toEqual({ kind: "incomplete" });
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
    expect(classifyPersistedWaveBatch(base("T1", "T2"), mutate(candidatesOf(base("T1", "T2"))))).toEqual({ kind: "incomplete" });
  });
});
