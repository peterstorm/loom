/**
 * `waveGateDecisionMismatch` is the guard that stops a Wave advisory decision
 * meant for one Wave Gate run from being applied to a stale or foreign one.
 *
 * It used to be a raw boolean chain inline in `decideOperation`, inside the CLI
 * dispatcher, so its four dimensions had no interface of their own: the only
 * coverage spawned the whole CLI against fixture files and matched stderr, and
 * "wrong run" / "wrong wave" / "wrong authority digest" / "wrong decision id"
 * were indistinguishable from each other in a failure. Each is its own case
 * here, against plain objects.
 */

import { describe, expect, it } from "vitest";
import {
  waveAdvisoryDecisionRequestId,
  waveGateDecisionMismatch,
} from "../../../../src/handlers/helpers/programs/wave-gate";
import type { RegisteredWaveGateProgram } from "../../../../src/handlers/helpers/programs/helpers";
import type { TaskGraph } from "../../../../src/types";

const RUN_ID = "run.wave-decision";
const DIGEST = "a".repeat(64);

const task = (id: string, claim: string): TaskGraph["tasks"][number] => ({
  id,
  wave: 1,
  status: "completed",
  depends_on: [],
  findings: [{ id: `${id}-1`, severity: "advisory", claim }],
} as unknown as TaskGraph["tasks"][number]);

const TASKS = [task("T1", "prefer a named predicate"), task("T2", "tighten the envelope schema")];

const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
  tasks: TASKS,
  wave_gates: {},
  current_wave: 1,
  active_wave_gate: {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: RUN_ID,
    wave: 1,
    authorityDigest: DIGEST,
    revision: 0,
    terminalOutcome: null,
  },
  ...overrides,
} as unknown as TaskGraph);

const registration = (
  overrides: Partial<RegisteredWaveGateProgram> = {},
): RegisteredWaveGateProgram => ({
  schemaVersion: 1,
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds: ["T1", "T2"],
  authorityDigest: DIGEST,
  ...overrides,
});

const pendingDecisionId = (): string => waveAdvisoryDecisionRequestId(RUN_ID, TASKS);

describe("waveGateDecisionMismatch", () => {
  it("admits the exact pending decision for the active run", () => {
    expect(waveGateDecisionMismatch(graph(), registration(), RUN_ID, pendingDecisionId())).toBeNull();
  });

  it("refuses a decision whose run is not the protected active one", () => {
    expect(waveGateDecisionMismatch(graph(), registration(), "run.other", pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses a decision for a different wave than the registration names", () => {
    expect(waveGateDecisionMismatch(graph(), registration({ input: { wave: 2 } }), RUN_ID, pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses a decision whose authority digest drifted from the protected anchor", () => {
    expect(waveGateDecisionMismatch(graph(), registration({ authorityDigest: "b".repeat(64) }), RUN_ID, pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses when no Wave Gate is registered as active at all", () => {
    expect(waveGateDecisionMismatch(graph({ active_wave_gate: undefined }), registration(), RUN_ID, pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses a decision id that is not the exact pending advisory request", () => {
    const mismatch = waveGateDecisionMismatch(graph(), registration(), RUN_ID, "wave-advisory:run.wave-decision:deadbeef");
    expect(mismatch).toContain("is not the exact pending advisory request");
    expect(mismatch).toContain(pendingDecisionId());
  });

  /**
   * The decision id is derived from the advisories of the registration's OWN
   * tasks. A registration naming a subset therefore expects a different id —
   * which is the point: approving "the advisories" must name which ones.
   */
  it("derives the expected id from only the registration's tasks", () => {
    const subset = registration({ taskIds: ["T1"] });
    expect(waveGateDecisionMismatch(graph(), subset, RUN_ID, pendingDecisionId()))
      .toContain("is not the exact pending advisory request");
    expect(waveGateDecisionMismatch(graph(), subset, RUN_ID, waveAdvisoryDecisionRequestId(RUN_ID, [TASKS[0]!])))
      .toBeNull();
  });
});
