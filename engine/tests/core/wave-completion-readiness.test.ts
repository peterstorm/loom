import { describe, expect, it } from "vitest";
import {
  checkWaveCompletionSuite,
  commitWaveGateCompletion,
  deriveLoomStatus,
  deriveWaveCompletionSuiteReadiness,
  deriveWaveReadiness,
  evaluateWaveGate,
  type GateDeps,
} from "../../src/core/wave-gate-machine";
import {
  evaluateWaveCompletionSuite,
  type AcceptedWaveCompletionReceipt,
  type WaveCompletionSuiteResult,
} from "../../src/core/completion-suite";
import {
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import type {
  ActiveWaveGateRegistration,
  Task,
  TaskGraph,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../../src/types";

const digest = (fill: string): ArtifactDigest => fill.repeat(64) as ArtifactDigest;
const workspace = (fill: string): WaveWorkspaceObservation => ({
  kind: "observed",
  workspaceDigest: digest(fill),
});

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
}

const registration: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.wave-completion-readiness" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a") as ActiveWaveGateRegistration["authorityDigest"],
  revision: 0,
  terminalOutcome: null,
};

const proof = evaluateTaskProof(
  { newTestsRequired: true, declaredArtifacts: [] },
  {
    taskCompleted: true,
    testResult: { verdict: "trusted-pass" },
    filesModified: [],
    newTestsWritten: true,
  },
);
if (proof.state !== "satisfied") throw new Error("proof fixture must be satisfied");

const task: Task = {
  id: "T1",
  description: "completion readiness",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  proof,
  depends_on: [],
  test_result: { verdict: "trusted-pass" },
  test_evidence: "vitest pass",
  new_tests_written: true,
  new_test_evidence: "focused readiness test",
  review_status: "passed",
  critical_findings: [],
  advisory_findings: [],
};

function manifestWithReport(): FrozenVerificationManifest {
  return valueOf(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: "project:test",
      scope: "wave",
      executable: "bun",
      args: ["test"],
      cwd: ".",
      timeoutMs: 60_000,
      report: { kind: "required-file", path: ".loom/completion-reports/completion.json" },
    }],
  }))));
}

function acceptedReceipt(
  manifest: FrozenVerificationManifest,
  workspaceDigest = digest("b"),
  reportDigest = digest("c"),
  reportByteLength = 10,
): AcceptedWaveCompletionReceipt {
  const authority = valueOf(authorizeWaveCompletionSuite(manifest, registration, workspaceDigest));
  const evaluated = evaluateWaveCompletionSuite(authority, {
    kind: "wave-completion-suite-result",
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: 0,
        timedOut: false,
        signal: null,
        report: check.reportPolicy.kind === "not-required"
          ? { kind: "not-required" }
          : {
              kind: "produced",
              path: check.reportPolicy.path,
              digest: reportDigest,
              byteLength: reportByteLength,
            },
      },
    })),
  });
  if (evaluated.kind !== "accepted") throw new Error("suite fixture must be accepted");
  return evaluated.receipt;
}

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [task],
    wave_gates: {},
    spec_check: {
      wave: 1,
      run_at: "now",
      verdict: "PASSED",
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: [],
    },
    active_wave_gate: registration,
    ...overrides,
  };
}

function deps(
  currentWaveWorkspace?: WaveWorkspaceObservation,
  currentWaveCompletionResult?: WaveCompletionResultObservation,
): GateDeps {
  return {
    loadPlanModels: () => ({
      kind: "loaded",
      models: { lifecycles: [], pipeline: null, invariants: [], strays: [] },
    }),
    filePresence: () => ({ ok: true, exists: true }),
    ...(currentWaveWorkspace === undefined ? {} : { currentWaveWorkspace }),
    ...(currentWaveCompletionResult === undefined ? {} : { currentWaveCompletionResult }),
  };
}

function observedResult(
  manifest: FrozenVerificationManifest,
  projectOutcome: Readonly<{
    exitCode: number;
    report: Readonly<
      { kind: "missing" } |
      { kind: "produced" }
    >;
  }>,
): WaveCompletionResultObservation {
  const authority = valueOf(authorizeWaveCompletionSuite(manifest, registration, digest("b")));
  const result: WaveCompletionSuiteResult = {
    kind: "wave-completion-suite-result",
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: check.kind === "project-command" ? projectOutcome.exitCode : 0,
        timedOut: false,
        signal: null,
        report: check.reportPolicy.kind === "not-required"
          ? { kind: "not-required" }
          : projectOutcome.report.kind === "missing"
            ? { kind: "missing", path: check.reportPolicy.path }
            : {
                kind: "produced",
                path: check.reportPolicy.path,
                digest: digest("c"),
                byteLength: 10,
              },
      },
    })),
  };
  return { kind: "observed", result };
}

function modernGraph(
  receipt: AcceptedWaveCompletionReceipt | undefined,
  manifest: FrozenVerificationManifest = defaultVerificationManifest(),
): TaskGraph {
  return graph({
    verification_manifest: manifest,
    ...(receipt === undefined ? {} : { active_wave_completion_suite: receipt }),
  });
}

function readinessIdentity(
  state: TaskGraph,
  observation: WaveWorkspaceObservation | undefined,
  completionResult?: WaveCompletionResultObservation,
) {
  const readiness = valueOf(deriveWaveReadiness(state, deps(observation, completionResult)));
  return {
    digest: readiness.readinessDigest,
    effectId: readiness.completionIntent.effectId,
  };
}

describe("Wave completion suite gate readiness", () => {
  it("fails a modern graph that has no accepted suite or persisted result", () => {
    const state = modernGraph(undefined);
    const observation = { kind: "absent" } as const;
    const decision = evaluateWaveGate(state, null, deps(workspace("b"), observation));

    expect(decision.verdict).toMatchObject({ kind: "fail" });
    expect(decision.checks[4]).toMatchObject({ passed: false });
    expect(checkWaveCompletionSuite(state, 1, workspace("b"), observation)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("accepted-suite-missing"),
    });
    expect(valueOf(deriveWaveReadiness(state, deps(workspace("b"), observation))).facts.waveCompletionSuiteReadiness)
      .toMatchObject({ kind: "known", value: { kind: "required", reason: "accepted-suite-missing" } });
  });

  it.each([
    ["non-zero-exit", { exitCode: 7, report: { kind: "produced" as const } }],
    ["missing-report", { exitCode: 0, report: { kind: "missing" as const } }],
  ] as const)("exposes exact semantic rejection %s from the current persisted result", (failureKind, outcome) => {
    const manifest = manifestWithReport();
    const state = modernGraph(undefined, manifest);
    const observation = observedResult(manifest, outcome);
    const readiness = deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), observation);

    expect(readiness).toEqual({
      kind: "rejected",
      verificationManifestDigest: manifest.manifestDigest,
      suiteDigest: observation.kind === "observed" ? observation.result.suiteDigest : "unreachable",
      workspaceDigest: digest("b"),
      failureKinds: [failureKind],
      checkIds: ["project:test"],
    });
    expect(checkWaveCompletionSuite(state, 1, workspace("b"), observation)).toEqual({
      passed: false,
      reason: `FAILED: Wave completion suite rejected (${failureKind}): project:test.`,
    });
  });

  it("keeps an accepted persisted result required until its protected receipt is recovered", () => {
    const manifest = manifestWithReport();
    const state = modernGraph(undefined, manifest);
    const observation = observedResult(manifest, { exitCode: 0, report: { kind: "produced" } });

    expect(deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), observation)).toMatchObject({
      kind: "required",
      reason: "accepted-suite-missing",
      detail: expect.stringContaining("receipt recovery required"),
    });
  });

  it("fails closed without semantic labels for unavailable, malformed, or stale result evidence", () => {
    const manifest = manifestWithReport();
    const state = modernGraph(undefined, manifest);
    const unavailable = deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), {
      kind: "unavailable",
      reason: "persisted result is corrupt JSON",
    });
    expect(unavailable).toMatchObject({
      kind: "required",
      reason: "completion-result-unavailable",
      detail: "persisted result is corrupt JSON",
    });

    const observed = observedResult(manifest, { exitCode: 7, report: { kind: "produced" } });
    if (observed.kind !== "observed") throw new Error("fixture must be observed");
    const stale: WaveCompletionResultObservation = {
      kind: "observed",
      result: { ...observed.result, authorityDigest: digest("d") },
    };
    expect(deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), stale)).toMatchObject({
      kind: "required",
      reason: "completion-result-invalid",
      detail: expect.stringContaining("stale-result"),
    });
  });

  it("accepts only an exact receipt for the currently observed workspace", () => {
    const manifest = manifestWithReport();
    const receipt = acceptedReceipt(manifest);
    const state = modernGraph(receipt, manifest);
    const decision = evaluateWaveGate(state, null, deps(workspace("b")));

    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: null });
    expect(decision.checks[4]).toMatchObject({ passed: true });
    const fact = deriveLoomStatus(valueOf(deriveWaveReadiness(state, deps(workspace("b")))))
      .facts.waveCompletionSuiteReadiness;
    expect(fact).toEqual({
      kind: "known",
      value: {
        kind: "accepted",
        verificationManifestDigest: manifest.manifestDigest,
        suiteDigest: receipt.suiteDigest,
        resultDigest: receipt.resultDigest,
        workspaceDigest: receipt.workspaceDigest,
        checkCount: receipt.checks.length,
      },
    });
  });

  it("fails closed for missing, unavailable, and stale current workspace observations", () => {
    const manifest = manifestWithReport();
    const receipt = acceptedReceipt(manifest);
    const state = modernGraph(receipt, manifest);

    expect(evaluateWaveGate(state, null, deps()).verdict).toMatchObject({
      kind: "fail",
      reason: expect.stringContaining("workspace-observation-missing"),
    });
    expect(evaluateWaveGate(state, null, deps({ kind: "unavailable", reason: "git status failed" })).verdict)
      .toMatchObject({ kind: "fail", reason: expect.stringContaining("git status failed") });
    expect(evaluateWaveGate(state, null, deps(workspace("d"))).verdict)
      .toMatchObject({ kind: "fail", reason: expect.stringContaining("stale") });
    expect(valueOf(deriveWaveReadiness(state, deps(workspace("d")))).facts.waveCompletionSuiteReadiness)
      .toMatchObject({
        kind: "known",
        value: {
          kind: "stale",
          acceptedWorkspaceDigest: digest("b"),
          currentWorkspaceDigest: digest("d"),
        },
      });
  });

  it("preserves direct legacy compatibility with an explicit legacy-unavailable summary", () => {
    const state = graph();
    const decision = evaluateWaveGate(state, null, deps());

    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: null });
    expect(decision.checks[4]).toEqual({
      passed: true,
      summary: "4. Wave completion suite: legacy-unavailable (verification_manifest and active receipt absent).",
    });
    expect(valueOf(deriveWaveReadiness(state, deps())).facts.waveCompletionSuiteReadiness).toEqual({
      kind: "known",
      value: { kind: "legacy-unavailable", verificationManifestDigest: null },
    });
  });
});

describe("Wave completion authority and atomic commit", () => {
  it("changes readiness digest and intent for every receipt/workspace observation change", () => {
    const manifest = manifestWithReport();
    const baselineReceipt = acceptedReceipt(manifest);
    const baseline = modernGraph(baselineReceipt, manifest);
    const baselineIdentity = readinessIdentity(baseline, workspace("b"));
    const variants = [
      [modernGraph(acceptedReceipt(manifest, digest("b"), digest("d")), manifest), workspace("b")],
      [modernGraph(acceptedReceipt(manifest, digest("b"), digest("c"), 11), manifest), workspace("b")],
      [modernGraph(acceptedReceipt(manifest, digest("d")), manifest), workspace("d")],
      [baseline, workspace("d")],
      [baseline, { kind: "unavailable", reason: "git unavailable A" } as const],
      [baseline, { kind: "unavailable", reason: "git unavailable B" } as const],
      [baseline, undefined],
    ] as const;

    const identities = variants.map(([state, observation]) => readinessIdentity(state, observation));
    for (const identity of identities) {
      expect(identity.digest).not.toBe(baselineIdentity.digest);
      expect(identity.effectId).not.toBe(baselineIdentity.effectId);
    }
    expect(new Set(identities.map(({ digest: value }) => value)).size).toBe(identities.length);
    expect(new Set(identities.map(({ effectId }) => effectId)).size).toBe(identities.length);
  });

  it("binds every applicable persisted-result observation into completion authority", () => {
    const manifest = manifestWithReport();
    const state = modernGraph(undefined, manifest);
    const observations: readonly WaveCompletionResultObservation[] = [
      { kind: "absent" },
      { kind: "unavailable", reason: "artifact unavailable A" },
      { kind: "unavailable", reason: "artifact unavailable B" },
      observedResult(manifest, { exitCode: 7, report: { kind: "produced" } }),
      observedResult(manifest, { exitCode: 0, report: { kind: "missing" } }),
    ];
    const identities = observations.map((observation) =>
      readinessIdentity(state, workspace("b"), observation));

    expect(new Set(identities.map(({ digest: value }) => value)).size).toBe(observations.length);
    expect(new Set(identities.map(({ effectId }) => effectId)).size).toBe(observations.length);
  });

  it("ignores persisted-result observations once a protected receipt exists", () => {
    const manifest = manifestWithReport();
    const state = modernGraph(acceptedReceipt(manifest), manifest);
    expect(readinessIdentity(state, workspace("b"), { kind: "absent" })).toEqual(
      readinessIdentity(state, workspace("b"), {
        kind: "unavailable",
        reason: "irrelevant after protected receipt",
      }),
    );
  });

  it("refuses modern completion without a current accepted suite", () => {
    const readiness = valueOf(deriveWaveReadiness(modernGraph(undefined), deps(workspace("b"))));
    expect(commitWaveGateCompletion(readiness)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("completion readiness is ineligible") },
    });
  });

  it("archives schema v2 and keeps historical accepted suite evidence accepted after live workspace changes", () => {
    const manifest = manifestWithReport();
    const receipt = acceptedReceipt(manifest);
    const state = modernGraph(receipt, manifest);
    const committed = valueOf(commitWaveGateCompletion(
      valueOf(deriveWaveReadiness(state, deps(workspace("b")))),
    ));

    expect(committed.completedRegistration).toEqual({
      schemaVersion: 2,
      kind: "completed-wave-gate",
      runId: registration.runId,
      wave: 1,
      authorityDigest: registration.authorityDigest,
      revision: 1,
      completionReceipt: committed.receipt,
      completionSuite: receipt,
    });
    expect(committed.graph.active_wave_completion_suite).toBeUndefined();
    expect(committed.graph.active_wave_gate).toBeUndefined();
    expect(committed.graph.wave_gate_history).toEqual([committed.completedRegistration]);
    expect(deriveWaveCompletionSuiteReadiness(committed.graph, 1, workspace("b")))
      .toMatchObject({ kind: "accepted", resultDigest: receipt.resultDigest });
    const historicalAfterLiveChange = deriveWaveCompletionSuiteReadiness(committed.graph, 1, workspace("d"));
    expect(historicalAfterLiveChange).toEqual({
      kind: "accepted",
      verificationManifestDigest: manifest.manifestDigest,
      suiteDigest: receipt.suiteDigest,
      resultDigest: receipt.resultDigest,
      workspaceDigest: digest("b"),
      checkCount: receipt.checks.length,
    });
    expect(historicalAfterLiveChange.kind).not.toBe("stale");
  });

  it("writes schema v1 only for field-absent legacy compatibility", () => {
    const committed = valueOf(commitWaveGateCompletion(
      valueOf(deriveWaveReadiness(graph(), deps())),
    ));

    expect(committed.completedRegistration.schemaVersion).toBe(1);
    expect("completionSuite" in committed.completedRegistration).toBe(false);
  });
});
