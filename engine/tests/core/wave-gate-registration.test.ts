import { describe, expect, it } from "vitest";
import {
  admitWaveGateRegistration,
  installWaveGateRegistration,
  type WaveGateRegistrationCandidate,
} from "../../src/core/wave-gate-registration";
import { waveGateAuthorityDigest } from "../../src/core/wave-review-authority";
import type { ActiveWaveGateRegistration, TaskGraph } from "../../src/types";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  graphFixture,
  protectedGraphFixture,
  taskFixture,
} from "../fixtures/task-lifecycle";

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

/** A registration for `roster` of `graph`, minted by the State File parser. */
const registrationFor = (
  graph: TaskGraph,
  wave: number,
  roster: readonly string[],
  runId = "run.next",
  overrides: Readonly<{ terminalOutcome?: unknown; revision?: number; runsRoot?: string }> = {},
): ActiveWaveGateRegistration => activeWaveGateFixture({
  runId,
  wave,
  authorityDigest: waveGateAuthorityDigest(wave, [...roster], graph),
  ...overrides,
});

const active = (graph: TaskGraph, runId: string, terminalOutcome: unknown = null): ActiveWaveGateRegistration =>
  registrationFor(graph, 1, ROSTER, runId, { terminalOutcome });

const withActive = (registration: ActiveWaveGateRegistration): TaskGraph => ({ ...base, active_wave_gate: registration });
const abandoned = (supersededBy: string | null) =>
  ({ kind: "terminal-abandoned", reason: "reviewed bytes changed", supersededBy });
/** A typed non-abandoned terminal outcome: the run finished with a published result. */
const done = (runId: string) => ({
  kind: "done",
  outcome: { runId, slot: "receipts/effect.wave-done.json", digest: "c".repeat(64), byteLength: 1 },
});

const refusals: ReadonlyArray<readonly [string, (graph: TaskGraph) => readonly [TaskGraph, WaveGateRegistrationCandidate, readonly string[]], string]> = [
  ["outside execute", (graph) => [{ ...graph, current_phase: "architecture" }, candidate(graph), ROSTER],
    "Cannot register Wave Gate run outside execute Phase (current: architecture)"],
  ["a wave other than current_wave", (graph) => [graph, candidate(graph, { wave: 2 }), ROSTER],
    "Cannot register Wave Gate wave 2; protected current_wave is 1"],
  ["a run already in terminal history", (graph) => [
    { ...graph, wave_gate_history: [completedWaveGateFixture({ runId: "run.next", wave: 1 })] }, candidate(graph), ROSTER],
    "Wave Gate run run.next is already terminal"],
  ["an already-completed Wave", (graph) => [
    { ...graph, wave_gate_history: [completedWaveGateFixture({ runId: "run.done", wave: 1 })] }, candidate(graph), ROSTER],
    "Wave 1 is already completed or older than terminal Wave history"],
  ["a Wave another live run owns", (graph) => [withActive(active(graph, "run.live")), candidate(graph), ROSTER],
    "Active Wave Gate run run.live already owns wave 1"],
  ["a non-abandoned terminal predecessor", (graph) => [
    withActive(active(graph, "run.legacy", done("run.legacy"))), candidate(graph), ROSTER],
    "Legacy terminal Wave Gate run run.legacy must be explicitly migrated"],
  ["an abandoned predecessor naming another successor", (graph) => [
    withActive(active(graph, "run.old", abandoned("run.other"))), candidate(graph), ROSTER],
    "Abandoned Wave Gate run run.old authorizes successor run.other, not run.next"],
  ["a published roster that differs from the protected Wave", (graph) => [graph, candidate(graph), ["T1"]],
    "Protected Wave authority changed after Run Directory publication"],
  ["a published roster in a different order", (graph) => [graph, candidate(graph), ["T2", "T1"]],
    "Protected Wave authority changed after Run Directory publication"],
  ["an authority digest that differs from the protected Wave", (graph) => [
    graph, candidate(graph, { authorityDigest: "f".repeat(64) }), ROSTER],
    "Protected Wave authority changed after Run Directory publication"],
];

describe("admitWaveGateRegistration", () => {
  it("installs a fresh registration with no predecessor when no Wave Gate owns the Wave", () => {
    expect(admitWaveGateRegistration(base, candidate(base), ROSTER))
      .toEqual({ kind: "install", predecessor: { kind: "none" } });
  });

  it("replays the exact live registration idempotently", () => {
    // The authority digest covers the whole pre-install snapshot, so an exact
    // replay carries the digest minted before its own install.
    const registration = active(base, "run.next");
    const graph = withActive(registration);
    expect(admitWaveGateRegistration(graph, candidate(base), ROSTER)).toEqual({ kind: "replay", existing: registration });
  });

  it.each<readonly [string, (graph: TaskGraph) => ActiveWaveGateRegistration]>([
    ["wave", (graph) => registrationFor(graph, 2, ROSTER)],
    ["runs root", (graph) => registrationFor(graph, 1, ROSTER, "run.next", { runsRoot: "/elsewhere" })],
    ["revision", (graph) => registrationFor(graph, 1, ROSTER, "run.next", { revision: 1 })],
  ])("does not replay a live registration whose %s differs from the candidate", (_field, drifted) => {
    const graph = withActive(drifted(base));
    expect(admitWaveGateRegistration(graph, candidate(base), ROSTER).kind).toBe("refused");
  });

  it("names the abandoned predecessor it installs over, whether it names no successor or this run", () => {
    for (const supersededBy of [null, "run.next"]) {
      const graph = withActive(active(base, "run.old", abandoned(supersededBy)));
      expect(admitWaveGateRegistration(graph, candidate(graph), ROSTER))
        .toEqual({ kind: "install", predecessor: { kind: "abandoned", runId: "run.old" } });
    }
  });

  it.each(refusals)("refuses %s", (_name, scenario, message) => {
    const [graph, registration, roster] = scenario(base);
    const admission = admitWaveGateRegistration(graph, registration, roster);
    expect(admission.kind).toBe("refused");
    if (admission.kind === "refused") expect(admission.message).toContain(message);
  });
});

describe("installWaveGateRegistration", () => {
  it("installs a fresh registration over an otherwise untouched graph", () => {
    const registration = registrationFor(base, 1, ROSTER);
    const decision = installWaveGateRegistration(base, registration, ROSTER);
    expect(decision).toEqual({ kind: "installed", state: { ...base, active_wave_gate: registration }, registration });
  });

  it("replays the exact live registration without producing a new graph", () => {
    const registration = registrationFor(base, 1, ROSTER);
    const graph = withActive(registration);
    expect(installWaveGateRegistration(graph, registration, ROSTER)).toEqual({ kind: "replayed", registration });
  });

  it.each<readonly [string, Readonly<{ revision?: number; terminalOutcome?: unknown }>]>([
    ["a revision past 0", { revision: 1 }],
    ["a terminal outcome", { terminalOutcome: abandoned(null) }],
  ])("refuses a registration carrying %s before admission, even over its own live anchor", (_name, drift) => {
    const stale = registrationFor(base, 1, ROSTER, "run.next", drift);
    for (const graph of [base, withActive(stale)]) {
      expect(installWaveGateRegistration(graph, stale, ROSTER)).toEqual({
        kind: "refused",
        message: "A fresh active Wave Gate registration must start at revision 0 without a terminal outcome",
      });
    }
  });

  it.each(refusals)("refuses %s with the admission's message", (_name, scenario, message) => {
    const [graph, refused, roster] = scenario(base);
    const registration = activeWaveGateFixture({
      runId: refused.runId,
      wave: refused.wave,
      authorityDigest: refused.authorityDigest,
    });
    const decision = installWaveGateRegistration(graph, registration, roster);
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") expect(decision.message).toContain(message);
  });

  describe("over an abandoned predecessor", () => {
    const authority = (runId: string) => ({
      generation: 6, packet_id: "a".repeat(64), head_sha: "b".repeat(64), scope: ["src/a.ts"],
      run_id: runId, authority_digest: "c".repeat(64),
    });
    const WAVE_8 = ["T13", "T14"] as const;
    const wave8Task = (id: string, wave: number, extra: Record<string, unknown>) => ({
      ...taskFixture({ id, description: id, agent: "code-implementer-agent", wave, depends_on: [], status: "completed" }),
      ...extra,
    });
    const abandonedGraphRaw = {
      current_phase: "execute",
      current_wave: 8,
      phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null, wave_gates: {},
      tasks: [
        wave8Task("T13", 8, { review_status: "passed", review_generation: 6,
          findings: [{ id: "pr-test-analyzer-1", severity: "advisory", claim: "c", file: null, line: null, agent: "pr-test-analyzer" }],
          advisory_findings: ["c"],
          accepted_review_authority: authority("run.abandoned") }),
        wave8Task("T14", 8, { review_status: "passed", accepted_review_authority: authority("run.other") }),
        wave8Task("T1", 1, { review_status: "passed", accepted_review_authority: authority("run.abandoned") }),
      ],
      spec_check: { wave: 8, run_at: "now", verdict: "EVIDENCE_CAPTURE_FAILED", error: "e", cause: "transcript" },
      wave_review_epoch: { runId: "run.abandoned", wave: 8, batchEpoch: "f".repeat(64) },
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.abandoned", wave: 8, authorityDigest: "d".repeat(64),
        revision: 0, runsRoot: "/runs",
        terminalOutcome: { kind: "terminal-abandoned", reason: "exhausted", supersededBy: null },
      },
    };
    const abandonedGraph = protectedGraphFixture(abandonedGraphRaw);

    const install = (graph: TaskGraph): TaskGraph => {
      const registration = registrationFor(graph, 8, WAVE_8);
      const decision = installWaveGateRegistration(graph, registration, WAVE_8);
      if (decision.kind !== "installed") throw new Error(`expected an install, got ${JSON.stringify(decision)}`);
      expect(decision.state.active_wave_gate).toBe(registration);
      return decision.state;
    };

    it("retires the abandoned run's epoch and spec-check and reopens only the reviews it accepted", () => {
      // Production regression: abandoning an exhausted Wave 8 gate left its
      // review epoch behind, so the successor's registration was refused as
      // "wave_review_epoch must match active_wave_gate run/Wave authority".
      const next = install(abandonedGraph);
      expect(next.wave_review_epoch).toBeUndefined();
      expect(next.spec_check).toBeUndefined();
      const [t13, t14, t1] = next.tasks;
      expect(t13).toMatchObject({ review_status: "pending", review_generation: 6 });
      expect(t13?.accepted_review_authority).toBeUndefined();
      expect(t13?.findings).toEqual(abandonedGraph.tasks[0]!.findings);
      expect(t14).toMatchObject({ review_status: "passed", accepted_review_authority: { run_id: "run.other" } });
      expect(t1).toMatchObject({ review_status: "passed", accepted_review_authority: { run_id: "run.abandoned" } });
    });

    const blockedBySpecCheck = (criticalFindings: readonly string[]) => protectedGraphFixture({
      ...abandonedGraphRaw,
      wave_gates: { "8": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: true } },
      tasks: abandonedGraphRaw.tasks.map((task) => task.id === "T14" ? { ...task, critical_findings: criticalFindings } : task),
      spec_check: {
        wave: 8, run_at: "now", verdict: "BLOCKED", critical_count: 1, high_count: 0,
        critical_findings: ["Current Wave has no Requirement Completion Claims or valid Requirement Contributions"],
        high_findings: [], medium_findings: [],
      },
    });

    it("clears a block whose only cause was the retired spec-check", () => {
      // Production regression: abandoning a Wave 9 gate whose spec-check settled
      // a CRITICAL left wave_gates["9"].blocked behind with no cause, and the
      // successor's registration was refused as a causeless block.
      const next = install(blockedBySpecCheck([]));
      expect(next.spec_check).toBeUndefined();
      expect(next.wave_gates["8"]).toMatchObject({ blocked: false, impl_complete: true });
      expect(next.wave_gates["1"]).toBeUndefined();
    });

    it("keeps a block that a surviving critical review Finding still causes", () => {
      const next = install(blockedBySpecCheck(["still broken"]));
      expect(next.wave_gates["8"]).toMatchObject({ blocked: true });
    });
  });
});
