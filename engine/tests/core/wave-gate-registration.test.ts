import { describe, expect, it } from "vitest";
import { admitWaveGateRegistration, type WaveGateRegistrationCandidate } from "../../src/core/wave-gate-registration";
import { waveGateAuthorityDigest } from "../../src/core/wave-review-authority";
import type { ActiveWaveGateRegistration, TaskGraph } from "../../src/types";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const base = graphFixture([
  taskFixture({ id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, depends_on: [] }),
  taskFixture({ id: "T2", description: "two", agent: "code-implementer-agent", wave: 1, depends_on: [] }),
  taskFixture({ id: "T3", description: "later", agent: "code-implementer-agent", wave: 2, depends_on: [] }),
]);
const ROSTER = ["T1", "T2"] as const;

const candidate = (graph: TaskGraph, overrides: Partial<WaveGateRegistrationCandidate> = {}): WaveGateRegistrationCandidate => ({
  runId: "run.next",
  wave: 1,
  authorityDigest: waveGateAuthorityDigest(1, [...ROSTER], graph),
  runsRoot: "/runs",
  ...overrides,
});

const active = (
  graph: TaskGraph,
  runId: string,
  terminalOutcome: unknown = null,
): ActiveWaveGateRegistration => ({
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId,
  wave: 1,
  authorityDigest: waveGateAuthorityDigest(1, [...ROSTER], graph),
  revision: 0,
  runsRoot: "/runs",
  terminalOutcome,
} as unknown as ActiveWaveGateRegistration);

const withActive = (registration: ActiveWaveGateRegistration): TaskGraph => ({ ...base, active_wave_gate: registration });
const abandoned = (supersededBy: string | null) =>
  ({ kind: "terminal-abandoned", reason: "reviewed bytes changed", supersededBy });

describe("admitWaveGateRegistration", () => {
  it("installs a fresh registration when no Wave Gate owns the Wave", () => {
    expect(admitWaveGateRegistration(base, candidate(base), ROSTER)).toEqual({ kind: "install", supersedesAbandoned: false });
  });

  it("replays the exact live registration idempotently", () => {
    // The authority digest covers the whole pre-install snapshot, so an exact
    // replay carries the digest minted before its own install.
    const registration = active(base, "run.next");
    const graph = withActive(registration);
    expect(admitWaveGateRegistration(graph, candidate(base), ROSTER)).toEqual({ kind: "replay", existing: registration });
  });

  it("installs over an abandoned predecessor that names no successor or names this run", () => {
    for (const supersededBy of [null, "run.next"]) {
      const graph = withActive(active(base, "run.old", abandoned(supersededBy)));
      expect(admitWaveGateRegistration(graph, candidate(graph), ROSTER)).toEqual({ kind: "install", supersedesAbandoned: true });
    }
  });

  it.each<[string, (graph: TaskGraph) => readonly [TaskGraph, WaveGateRegistrationCandidate, readonly string[]], string]>([
    ["outside execute", (graph) => [{ ...graph, current_phase: "architecture" }, candidate(graph), ROSTER],
      "Cannot register Wave Gate run outside execute Phase (current: architecture)"],
    ["a wave other than current_wave", (graph) => [graph, candidate(graph, { wave: 2 }), ROSTER],
      "Cannot register Wave Gate wave 2; protected current_wave is 1"],
    ["a run already in terminal history", (graph) => [
      { ...graph, wave_gate_history: [{ runId: "run.next", wave: 0 }] } as unknown as TaskGraph, candidate(graph), ROSTER],
      "Wave Gate run run.next is already terminal"],
    ["an already-completed Wave", (graph) => [
      { ...graph, wave_gate_history: [{ runId: "run.done", wave: 1 }] } as unknown as TaskGraph, candidate(graph), ROSTER],
      "Wave 1 is already completed or older than terminal Wave history"],
    ["a Wave another live run owns", (graph) => [withActive(active(graph, "run.live")), candidate(graph), ROSTER],
      "Active Wave Gate run run.live already owns wave 1"],
    ["a non-abandoned terminal predecessor", (graph) => [
      withActive(active(graph, "run.legacy", { kind: "terminal-completed" })), candidate(graph), ROSTER],
      "Legacy terminal Wave Gate run run.legacy must be explicitly migrated"],
    ["an abandoned predecessor naming another successor", (graph) => [
      withActive(active(graph, "run.old", abandoned("run.other"))), candidate(graph), ROSTER],
      "Abandoned Wave Gate run run.old authorizes successor run.other, not run.next"],
    ["a published roster that differs from the protected Wave", (graph) => [graph, candidate(graph), ["T1"]],
      "Protected Wave authority changed after Run Directory publication"],
    ["an authority digest that differs from the protected Wave", (graph) => [
      graph, candidate(graph, { authorityDigest: "f".repeat(64) }), ROSTER],
      "Protected Wave authority changed after Run Directory publication"],
  ])("refuses %s", (_name, scenario, message) => {
    const [graph, registration, roster] = scenario(base);
    const admission = admitWaveGateRegistration(graph, registration, roster);
    expect(admission.kind).toBe("refused");
    if (admission.kind === "refused") expect(admission.message).toContain(message);
  });
});
