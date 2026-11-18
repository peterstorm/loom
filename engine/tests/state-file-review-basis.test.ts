/**
 * The State File boundary for a re-reviewed Task's narrowing fields (ADR-0093):
 * `accepted_review_authority.narrowing` and the Task's `review_basis`.
 *
 * Both are admitted exactly and only on a current-protocol acceptance, parsed
 * by the one acceptance rule the loader already applies, and a Task without
 * them loads byte-identically.
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../src/state-manager";
import { REVIEWER_PROTOCOL_V2 } from "../src/core/reviewer-contract";

const PACKET = "a".repeat(64);
const HEAD = "b".repeat(40);

const validTask = {
  id: "T1",
  description: "impl",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  depends_on: [],
} as const;

const graph = (tasks: readonly unknown[]) => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks,
  wave_gates: {},
});

const narrowing = () => ({
  from: ["code-reviewer", "comment-analyzer", "pr-test-analyzer"],
  change: ["comment", "test"],
  basis: { run_id: "run.previous", authority_digest: "c".repeat(64), packet_id: "d".repeat(64), head_sha: "e".repeat(64) },
});

/** A current acceptance at `generation`, as `record-review-acceptance` writes it. */
const currentAcceptance = (generation: number) => ({
  generation,
  packet_id: PACKET,
  head_sha: HEAD,
  scope: ["src/a.ts", "src/x.ts"],
  run_id: "run.current",
  authority_digest: "a".repeat(64),
  reviewer_protocol: REVIEWER_PROTOCOL_V2,
  subject_digest: "f".repeat(64),
});

/** A reopened Task: generation advanced past the acceptance its basis keeps. */
const reopenedTask = (basis: unknown) => ({ ...validTask, review_generation: 2, review_basis: basis });

/** A Task whose current acceptance closed generation 1. */
const acceptedTask = (authority: unknown) => ({ ...validTask, review_generation: 1, review_status: "passed", accepted_review_authority: authority });

const loads = (task: unknown) => {
  const raw = JSON.parse(JSON.stringify(graph([task])));
  const parsed = parseTaskGraph(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/**
 * `task` as the loader writes it back: a pending Task gains its derived Proof
 * on first load, so the byte-identical round trip is checked from there.
 */
const settled = (task: unknown): unknown => JSON.parse(JSON.stringify(loads(task).tasks[0]));

/** The loader's bytes for `task` equal its own, once settled. */
const expectByteIdentical = (task: unknown) => {
  const written = settled(task);
  expect(JSON.stringify(loads(written).tasks[0])).toBe(JSON.stringify(written));
};

const refusal = (task: unknown): string => {
  const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graph([task]))));
  expect(parsed.ok, "expected the loader to refuse this Task").toBe(false);
  return parsed.ok ? "" : parsed.error;
};

describe("Task.review_basis at the State File boundary", () => {
  it("loads a current basis from an earlier generation and round-trips it byte-identically", () => {
    const task = reopenedTask({ ...currentAcceptance(1), narrowing: narrowing() });
    const loaded = loads(task);
    expect(loaded.tasks[0]?.review_basis).toEqual(task.review_basis);
    expect(JSON.stringify(loaded.tasks[0]?.review_basis)).toBe(JSON.stringify(task.review_basis));
    expectByteIdentical(task);
  });

  it("loads a basis with no acceptance beside it, and refuses one beside a live acceptance, which supersedes it", () => {
    const { subject_digest: _sealed, ...unsealed } = currentAcceptance(1);
    expect(loads(reopenedTask(unsealed)).tasks[0]?.review_basis).toEqual(unsealed);
    expect(refusal({ ...acceptedTask(currentAcceptance(1)), review_basis: currentAcceptance(0) }))
      .toContain("review_basis cannot stand beside an accepted_review_authority");
  });

  it("refuses a legacy basis: one with no reviewer protocol", () => {
    const { reviewer_protocol: _protocol, subject_digest: _sealed, ...legacy } = currentAcceptance(1);
    expect(refusal(reopenedTask(legacy))).toContain("review_basis");
  });

  it.each([
    ["not an object", () => "basis"],
    ["unsorted scope", () => ({ ...currentAcceptance(1), scope: ["src/x.ts", "src/a.ts"] })],
    ["empty scope", () => ({ ...currentAcceptance(1), scope: [] })],
    ["non-canonical scope path", () => ({ ...currentAcceptance(1), scope: ["./src/a.ts"] })],
    ["unknown field", () => ({ ...currentAcceptance(1), extra: true })],
    ["missing run authority", () => {
      const { run_id: _run, ...rest } = currentAcceptance(1);
      return rest;
    }],
    ["unsupported descriptor", () => ({ ...currentAcceptance(1), reviewer_protocol: { ...REVIEWER_PROTOCOL_V2, version: 3 } })],
    ["short packet id", () => ({ ...currentAcceptance(1), packet_id: "a" })],
    ["malformed subject digest", () => ({ ...currentAcceptance(1), subject_digest: "nope" })],
    ["malformed narrowing", () => ({ ...currentAcceptance(1), narrowing: { ...narrowing(), change: ["code"] } })],
  ])("refuses a malformed basis: %s", (_case, basis) => {
    expect(refusal(reopenedTask(basis()))).toContain("review_basis");
  });

  it("leaves a Task without the field byte-identical", () => {
    const task = acceptedTask(currentAcceptance(1));
    expectByteIdentical(task);
    expect(Object.hasOwn(loads(task).tasks[0] ?? {}, "review_basis")).toBe(false);
    expect(JSON.stringify(loads(task).tasks[0]?.accepted_review_authority)).toBe(JSON.stringify(task.accepted_review_authority));
  });
});

describe("accepted_review_authority.narrowing at the State File boundary", () => {
  it("loads a narrowing on a current acceptance and round-trips it", () => {
    const task = acceptedTask({ ...currentAcceptance(1), narrowing: narrowing() });
    const loaded = loads(task);
    expect(JSON.stringify(loaded.tasks[0]?.accepted_review_authority)).toBe(JSON.stringify(task.accepted_review_authority));
    expectByteIdentical(task);
  });

  it("refuses a narrowing on a legacy acceptance", () => {
    const { reviewer_protocol: _protocol, subject_digest: _sealed, ...legacy } = currentAcceptance(1);
    expect(refusal(acceptedTask({ ...legacy, narrowing: narrowing() })))
      .toContain("accepted_review_authority.narrowing must be a narrowing record on a current acceptance");
  });

  it.each([
    ["an unknown change class", { ...narrowing(), change: ["code"] }],
    ["change classes out of canonical order", { ...narrowing(), change: ["test", "comment"] }],
    ["an empty roster", { ...narrowing(), from: [] }],
    ["a repeated role", { ...narrowing(), from: ["code-reviewer", "code-reviewer"] }],
    ["a short basis head", { ...narrowing(), basis: { ...narrowing().basis, head_sha: HEAD } }],
    ["an extra key", { ...narrowing(), extra: 1 }],
    ["null", null],
  ])("refuses a malformed narrowing: %s", (_case, malformed) => {
    expect(refusal(acceptedTask({ ...currentAcceptance(1), narrowing: malformed })))
      .toContain("accepted_review_authority.narrowing must be a narrowing record on a current acceptance");
  });
});
