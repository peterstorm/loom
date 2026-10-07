/**
 * Proof Boundary Observation: the parse boundary for the persisted
 * captured-or-absent record of TaskGraph Population's proof boundary, and its
 * State File round trip (legacy graphs carry none and stay that way).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  parseProofBoundaryObservation,
  renderProofBoundaryNotice,
  type ProofBoundaryObservation,
} from "../../src/core/proof-boundary-observation";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { TaskGraph } from "../../src/types";

const SHA40 = "0123456789abcdef0123456789abcdef01234567";

const graph = (extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: "plan.md",
  tasks: [],
  wave_gates: {},
  ...extra,
} satisfies Partial<TaskGraph> & Record<string, unknown>);

describe("parseProofBoundaryObservation", () => {
  it("round-trips both arms exactly", () => {
    const observations: readonly ProofBoundaryObservation[] = [
      { kind: "captured", revision: SHA40 },
      { kind: "captured", revision: "f".repeat(64) },
      { kind: "absent", cause: "no Git repository root: not a repository" },
    ];
    for (const observation of observations) {
      expect(parseProofBoundaryObservation(JSON.parse(JSON.stringify(observation)))).toEqual({ ok: true, value: observation });
    }
  });

  it("property: a captured revision is admitted exactly when it is a bare 40- or 64-hex SHA", () => {
    fc.assert(fc.property(fc.string({ maxLength: 70 }), (revision) => {
      const admitted = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(revision);
      expect(parseProofBoundaryObservation({ kind: "captured", revision }).ok).toBe(admitted);
    }), { numRuns: 200 });
  });

  it.each([
    ["a non-object", "captured"],
    ["an unknown kind", { kind: "partial", cause: "x" }],
    ["an empty cause", { kind: "absent", cause: "  " }],
    ["a non-string cause", { kind: "absent", cause: 7 }],
    ["a surplus field", { kind: "captured", revision: SHA40, baselines: [] }],
    ["a captured arm carrying a cause", { kind: "captured", cause: "x" }],
  ])("refuses %s", (_label, raw) => {
    expect(parseProofBoundaryObservation(raw).ok).toBe(false);
  });

  it("renders a notice only for the absent arm", () => {
    expect(renderProofBoundaryNotice({ kind: "captured", revision: SHA40 })).toBeNull();
    expect(renderProofBoundaryNotice({ kind: "absent", cause: "HEAD is unborn" })).toBe(
      "Task proof boundaries NOT captured: HEAD is unborn; each Task's first dispatch stamps its own boundary.",
    );
  });
});

describe("TaskGraph proof_boundary_observation", () => {
  it("keeps a legacy graph without the field unknown rather than inventing an arm", () => {
    const parsed = parseTaskGraph(graph());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).not.toHaveProperty("proof_boundary_observation");
  });

  it("reads both persisted arms and refuses a malformed one at the load boundary", () => {
    for (const observation of [{ kind: "captured", revision: SHA40 }, { kind: "absent", cause: "unreadable HEAD" }]) {
      const parsed = parseTaskGraph(graph({ proof_boundary_observation: observation }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.proof_boundary_observation).toEqual(observation);
    }
    const malformed = parseTaskGraph(graph({ proof_boundary_observation: { kind: "captured", revision: "main" } }));
    expect(malformed.ok).toBe(false);
  });
});
