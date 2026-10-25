import { describe, expect, it } from "vitest";
import { commitWaveGateCompletion, deriveWaveReadiness } from "../../src/core/wave-gate-machine";
import { checkWaveCompletionSuite, evaluateWaveGate, type GateDeps } from "../../src/core/wave-gate-checks";
import { deriveWaveCompletionSuiteReadiness } from "../../src/core/wave-completion-suite-readiness";
import {
  deriveLoomStatus,
  deriveLoomStatusFromParsedGraph,
  renderLoomStatusHuman,
  renderLoomStatusJson,
} from "../../src/core/loom-status";
import {
  ownerVerificationExitCode,
  parseAcceptedWaveCompletionReceipt,
  type AcceptedWaveCompletionReceipt,
  type WaveCompletionSuiteResult,
} from "../../src/core/completion-suite";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { authorizeGraphCompletionSuite } from "../../src/core/owner-verification/suite-authority";
import type { InvariantVerdict, OwnerVerificationObservation } from "../../src/core/owner-verification/types";
import { ownerObligation } from "../fixtures/owner-obligation";
import { evaluateAsRecorded } from "../fixtures/completion-suite-evaluation";
import {
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import { capturedSpecCheck } from "../../src/core/spec-check";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import { canonicalJson, type JsonValue } from "../../src/core/review-packet";
import { sha256Hex } from "../../src/core/digest";
import {
  parseNewTestEvidence,
  type ActiveWaveGateRegistration,
  Task,
  TaskGraph,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../../src/types";
import { value } from "../fixtures/parse-result";

const digest = (fill: string): ArtifactDigest => fill.repeat(64) as ArtifactDigest;
const workspace = (fill: string): WaveWorkspaceObservation => ({
  kind: "observed",
  workspaceDigest: digest(fill),
});

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
  new_test_observation: parseNewTestEvidence(true, "focused readiness test"),
  review_status: "passed",
  critical_findings: [],
  advisory_findings: [],
};

function manifestWithReport(): FrozenVerificationManifest {
  return value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
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
  const authority = value(authorizeWaveCompletionSuite(manifest, registration, workspaceDigest, null));
  const evaluated = evaluateAsRecorded(authority, {
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
    spec_check: capturedSpecCheck({ wave: 1, runAt: "now", criticalFindings: [] }),
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
      models: { lifecycles: [], pipeline: null, invariants: [], contracts: [], strays: [] },
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
  const authority = value(authorizeWaveCompletionSuite(manifest, registration, digest("b"), null));
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
  const readiness = value(deriveWaveReadiness(state, deps(observation, completionResult)));
  return {
    digest: readiness.readinessDigest,
    effectId: readiness.completionIntent.effectId,
  };
}

describe("Wave completion suite gate readiness", () => {
  const emptyOperator = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, kind: "loom-verification-manifest", checks: [],
  }))));

  it.each([
    [defaultVerificationManifest(), { kind: "not-configured", reason: "engine-default" }],
    [emptyOperator, { kind: "not-configured", reason: "empty-operator-manifest" }],
    [manifestWithReport(), { kind: "configured", checkIds: ["project:test"] }],
  ] as const)("reports frozen coverage independently of readiness and advancement: %j", (manifest, coverage) => {
    const receipt = acceptedReceipt(manifest);
    for (const [state, observation, expectedKind] of [
      [modernGraph(undefined, manifest), workspace("b"), "required"],
      [modernGraph(receipt, manifest), workspace("b"), "accepted"],
      [modernGraph(receipt, manifest), workspace("d"), "stale"],
      [modernGraph(receipt, manifest), undefined, "required"],
    ] as const) {
      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: state }, deps(observation));
      expect(JSON.parse(renderLoomStatusJson(status))).toMatchObject({
        facts: { waveCompletionSuiteReadiness: { kind: "known", value: {
          kind: expectedKind, projectVerificationCoverage: coverage,
        } } },
      });
      const diagnostic = coverage.kind === "configured" ? "checks configured: project:test" : "NOT CONFIGURED";
      expect(renderLoomStatusHuman(status)).toContain(diagnostic);
      expect(JSON.stringify(checkWaveCompletionSuite(state, 1, observation))).toContain(diagnostic);
    }
    const ready = value(deriveWaveReadiness(modernGraph(receipt, manifest), deps(workspace("b"))));
    expect(ready.gateDecision.verdict.kind).toBe("pass");
    const committed = value(commitWaveGateCompletion(ready, new Map()));
    const changedManifest = manifest.projectChecks.length === 0 ? manifestWithReport() : defaultVerificationManifest();
    const historical = { ...committed.graph, verification_manifest: changedManifest };
    const expectedHistoricalCoverage = coverage.kind === "configured" ? coverage : {
      kind: "not-configured", reason: "historical-unknown",
    };
    expect(deriveLoomStatusFromParsedGraph({ ok: true, value: historical }, deps(workspace("d"))))
      .toMatchObject({ next: { action: { kind: "done" } }, facts: {
        waveCompletionSuiteReadiness: { value: { kind: "accepted", projectVerificationCoverage: expectedHistoricalCoverage } },
      } });
    expect(historical.wave_gate_history).toBe(committed.graph.wave_gate_history);
  });

  it("does not borrow current configuration for schema-v1 history", () => {
    const committed = value(commitWaveGateCompletion(value(deriveWaveReadiness(graph(), deps())), new Map()));
    expect(deriveWaveCompletionSuiteReadiness({ ...committed.graph, verification_manifest: manifestWithReport() }, 1, workspace("d")))
      .toEqual({ kind: "legacy-unavailable", verificationManifestDigest: null });
  });

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
    expect(value(deriveWaveReadiness(state, deps(workspace("b"), observation))).facts.waveCompletionSuiteReadiness)
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
      projectVerificationCoverage: { kind: "configured", checkIds: ["project:test"] },
      verificationManifestDigest: manifest.manifestDigest,
      suiteDigest: observation.kind === "observed" ? observation.result.suiteDigest : "unreachable",
      workspaceDigest: digest("b"),
      failureKinds: [failureKind],
      checkIds: ["project:test"],
    });
    expect(checkWaveCompletionSuite(state, 1, workspace("b"), observation)).toEqual({
      passed: false,
      reason: `FAILED: Wave completion suite rejected (${failureKind}): project:test. Project verification checks configured: project:test (configuration is not a pass).`,
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
    const fact = deriveLoomStatus(value(deriveWaveReadiness(state, deps(workspace("b")))))
      .facts.waveCompletionSuiteReadiness;
    expect(fact).toEqual({
      kind: "known",
      value: {
        kind: "accepted",
        projectVerificationCoverage: { kind: "configured", checkIds: ["project:test"] },
        verificationManifestDigest: manifest.manifestDigest,
        suiteDigest: receipt.suiteDigest,
        resultDigest: receipt.resultDigest,
        workspaceDigest: receipt.workspaceDigest,
        checkCount: receipt.checks.length,
      },
    });
  });

  it.each<readonly [
    string,
    (body: Omit<AcceptedWaveCompletionReceipt, "resultDigest">) => Readonly<Record<string, JsonValue>>,
    string,
  ]>([
    ["run", (body) => ({ ...body, runId: "run.other" }), "run/Wave/revision/authority"],
    ["Wave", (body) => ({ ...body, wave: body.wave + 1 }), "run/Wave/revision/authority"],
    ["revision", (body) => ({ ...body, revision: body.revision + 1 }), "run/Wave/revision/authority"],
    ["registration authority", (body) => ({ ...body, authorityDigest: digest("d") }), "run/Wave/revision/authority"],
    ["manifest", (body) => ({ ...body, manifestDigest: digest("d") }), "manifest digest"],
    ["suite digest", (body) => ({ ...body, suiteDigest: digest("d") }), "exact protected completion roster"],
    ["missing project check", (body) => ({
      ...body, checks: body.checks.filter((check) => check.checkId !== "project:test"),
    }), "exact protected completion roster"],
    ["same-size wrong roster", (body) => ({
      ...body, checks: body.checks.map((check) => check.checkId === "project:test"
        ? { ...check, checkId: "project:other" } : check),
    }), "exact protected completion roster"],
    ["required report omitted", (body) => ({
      ...body, checks: body.checks.map((check) => check.checkId === "project:test"
        ? { ...check, outcome: { ...check.outcome, report: { kind: "not-required" } } } : check),
    }), "project:test contradicts its report policy"],
    ["wrong report path", (body) => ({
      ...body, checks: body.checks.map((check) => check.checkId === "project:test"
        ? { ...check, outcome: { ...check.outcome, report: {
            kind: "produced", path: ".loom/completion-reports/other.json", digest: digest("c"), byteLength: 10,
          } } } : check),
    }), "project:test contradicts its report policy"],
    ["unexpected reserved-check report", (body) => ({
      ...body, checks: body.checks.map((check) => check.checkId === "loom:full-tier-lint"
        ? { ...check, outcome: { ...check.outcome, report: {
            kind: "produced", path: ".loom/completion-reports/other.json", digest: digest("c"), byteLength: 10,
          } } } : check),
    }), "loom:full-tier-lint contradicts its report policy"],
  ])("refuses a parsed accepted receipt with mismatched %s authority", (_label, mutate, diagnostic) => {
    const manifest = manifestWithReport();
    const receipt = value(parseAcceptedWaveCompletionReceipt(acceptedReceipt(manifest)));
    const state = modernGraph(receipt, manifest);
    expect(deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"))).toMatchObject({ kind: "accepted" });
    expect(checkWaveCompletionSuite(state, 1, workspace("b"))).toMatchObject({ passed: true });

    // Recompute integrity only: a canonical receipt is not proof of current protected authority.
    const { resultDigest: originalDigest, ...body } = receipt;
    const changedBody = mutate(body);
    const changed = value(parseAcceptedWaveCompletionReceipt({
      ...changedBody,
      resultDigest: sha256Hex(canonicalJson(changedBody)),
    }));
    expect(changed.resultDigest).not.toBe(originalDigest);
    const mismatched = modernGraph(changed, manifest);
    expect(deriveWaveCompletionSuiteReadiness(mismatched, 1, workspace("b"))).toMatchObject({
      kind: "required",
      reason: "accepted-suite-invalid",
      detail: expect.stringContaining(diagnostic),
      acceptedResultDigest: changed.resultDigest,
      projectVerificationCoverage: { kind: "configured", checkIds: ["project:test"] },
    });
    expect(checkWaveCompletionSuite(mismatched, 1, workspace("b"))).toMatchObject({
      passed: false,
      reason: expect.stringContaining("accepted-suite-invalid"),
    });
    expect(commitWaveGateCompletion(value(deriveWaveReadiness(mismatched, deps(workspace("b")))), new Map())).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("completion readiness is ineligible") },
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
    expect(value(deriveWaveReadiness(state, deps(workspace("d")))).facts.waveCompletionSuiteReadiness)
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
    expect(value(deriveWaveReadiness(state, deps())).facts.waveCompletionSuiteReadiness).toEqual({
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
    const readiness = value(deriveWaveReadiness(modernGraph(undefined), deps(workspace("b"))));
    expect(commitWaveGateCompletion(readiness, new Map())).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("completion readiness is ineligible") },
    });
  });

  it("archives schema v2 and keeps historical accepted suite evidence accepted after live workspace changes", () => {
    const manifest = manifestWithReport();
    const receipt = acceptedReceipt(manifest);
    const state = modernGraph(receipt, manifest);
    const committed = value(commitWaveGateCompletion(
      value(deriveWaveReadiness(state, deps(workspace("b")))), new Map(),
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
      projectVerificationCoverage: { kind: "configured", checkIds: ["project:test"] },
      verificationManifestDigest: manifest.manifestDigest,
      suiteDigest: receipt.suiteDigest,
      resultDigest: receipt.resultDigest,
      workspaceDigest: digest("b"),
      checkCount: receipt.checks.length,
    });
    expect(historicalAfterLiveChange.kind).not.toBe("stale");
  });

  it("writes schema v1 only for field-absent legacy compatibility", () => {
    const committed = value(commitWaveGateCompletion(
      value(deriveWaveReadiness(graph(), deps())), new Map(),
    ));

    expect(committed.completedRegistration.schemaVersion).toBe(1);
    expect("completionSuite" in committed.completedRegistration).toBe(false);
  });
});

describe("INV-3: readiness of a stamped graph re-authorizes the owner check from the graph", () => {
  const OWNER = "src/rules/owner.ts";
  const ADMISSION = ownerObligation({
    invariant: "INV-1",
    title: "Admission is decided only by the owner",
    statement: null,
    owner: OWNER,
    siblings: [{ path: "src/rules/sibling-a.ts", note: null }],
    matrixTest: "tests/rules.matrix.test.ts",
    mutation: { kind: "verify" },
  });
  const unchangedRun = value(verifiedMutationOf({
    killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: false,
  }));

  /** A stamped graph whose one Wave-1 Task lists `files`: INV-1 is owed exactly when they change its family. */
  const stampedGraph = (files: readonly string[], receipt?: AcceptedWaveCompletionReceipt): TaskGraph => graph({
    tasks: [{ ...task, file_list: [...files] }],
    verification_manifest: manifestWithReport(),
    owner_obligations: [ADMISSION],
    ...(receipt === undefined ? {} : { active_wave_completion_suite: receipt }),
  });

  type OwnerMutation = InvariantVerdict["mutation"];

  /** The result every check of the graph's own suite would record: project exit, and the owner verdicts with `mutation`. */
  function resultFor(state: TaskGraph, projectExit: number, mutation: OwnerMutation = unchangedRun): WaveCompletionSuiteResult {
    const authority = value(authorizeGraphCompletionSuite(state, digest("b")));
    const owner = authority.checks.find((check) => check.kind === "engine-owner-verification");
    const observation: OwnerVerificationObservation | undefined = owner === undefined || owner.kind !== "engine-owner-verification" ? undefined : {
      kind: "verified",
      obligationsDigest: owner.obligationsDigest,
      boundMs: 0,
      verdicts: owner.owed.map((invariant) => ({
        invariant, title: ADMISSION.title, owner: OWNER, matrixTest: ADMISSION.matrixTest, coverage: { kind: "covered" }, mutation,
      })),
    };
    const ownerExit = observation === undefined ? 0 : ownerVerificationExitCode(observation);
    return {
      kind: "wave-completion-suite-result",
      runId: authority.runId, wave: authority.wave, revision: authority.revision, authorityDigest: authority.authorityDigest,
      manifestDigest: authority.manifestDigest, suiteDigest: authority.suiteDigest, workspaceDigest: authority.workspaceDigest,
      checks: authority.checks.map((check) => ({
        checkId: check.checkId,
        scope: "wave",
        outcome: {
          kind: "observed",
          exitCode: check.kind === "project-command" ? projectExit : check.kind === "engine-owner-verification" ? ownerExit : 0,
          timedOut: false,
          signal: null,
          report: check.reportPolicy.kind === "not-required"
            ? { kind: "not-required" }
            : { kind: "produced", path: check.reportPolicy.path, digest: digest("c"), byteLength: 10 },
        },
      })),
      ...(observation === undefined ? {} : { ownerVerification: observation }),
    };
  }

  function receiptFor(state: TaskGraph): AcceptedWaveCompletionReceipt {
    const evaluated = evaluateAsRecorded(value(authorizeGraphCompletionSuite(state, digest("b"))), resultFor(state, 0));
    if (evaluated.kind !== "accepted") throw new Error(`receipt fixture rejected: ${JSON.stringify(evaluated)}`);
    return evaluated.receipt;
  }

  const observed = (result: WaveCompletionSuiteResult): WaveCompletionResultObservation => ({ kind: "observed", result });

  it("a persisted rejected result is judged against the roster carrying the owner check", () => {
    const state = stampedGraph([OWNER]);
    const result = resultFor(state, 7);
    const unstampedSuite = value(authorizeWaveCompletionSuite(manifestWithReport(), registration, digest("b"), null));
    expect(result.suiteDigest).not.toBe(unstampedSuite.suiteDigest);
    expect(result.checks.map(({ checkId }) => checkId)).toContain("loom:owner-verification");
    expect(deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), observed(result))).toEqual({
      kind: "rejected",
      projectVerificationCoverage: { kind: "configured", checkIds: ["project:test"] },
      verificationManifestDigest: state.verification_manifest!.manifestDigest,
      suiteDigest: result.suiteDigest,
      workspaceDigest: digest("b"),
      failureKinds: ["non-zero-exit"],
      checkIds: ["project:test"],
    });
  });

  it("a persisted result run under the pre-stamp roster is invalid for the stamped graph", () => {
    const stamped = stampedGraph([OWNER]);
    const { owner_obligations: _stamp, ...unstamped } = stamped;
    const preStamp = resultFor(unstamped, 7);
    expect(deriveWaveCompletionSuiteReadiness(stamped, 1, workspace("b"), observed(preStamp))).toMatchObject({
      kind: "required",
      reason: "completion-result-invalid",
      detail: expect.stringContaining("stale-result"),
    });
  });

  it("a semantic rejection beside an undecided owner check stays a rejection, as the gate replays it; the undecided check alone is invalid", () => {
    const state = stampedGraph([OWNER]);
    const undecided: OwnerMutation = { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "no isolated copy" } };
    expect(deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), observed(resultFor(state, 7, undecided))))
      .toMatchObject({ kind: "rejected", failureKinds: ["non-zero-exit"], checkIds: ["project:test"] });
    expect(deriveWaveCompletionSuiteReadiness(state, 1, workspace("b"), observed(resultFor(state, 0, undecided)))).toMatchObject({
      kind: "required",
      reason: "completion-result-invalid",
      detail: expect.stringContaining("owner-verification-infrastructure"),
    });
  });

  it("an accepted receipt whose owner roster the graph no longer authorizes is invalid", () => {
    const receipt = receiptFor(stampedGraph([OWNER]));
    expect(receipt.ownerVerification).toMatchObject({ kind: "verified", verdicts: [{ invariant: "INV-1" }] });
    expect(deriveWaveCompletionSuiteReadiness(stampedGraph([OWNER], receipt), 1, workspace("b")))
      .toMatchObject({ kind: "accepted", resultDigest: receipt.resultDigest, checkCount: 3 });
    // The Wave no longer changes INV-1's family: the authorized owner check owes nothing, so the roster differs.
    expect(deriveWaveCompletionSuiteReadiness(stampedGraph(["src/other.ts"], receipt), 1, workspace("b"))).toMatchObject({
      kind: "required",
      reason: "accepted-suite-invalid",
      detail: "accepted suite does not match the exact protected completion roster",
    });
    // A receipt minted without the stamp cannot satisfy a stamped graph either.
    const { owner_obligations: _stamp, ...unstamped } = stampedGraph([OWNER]);
    expect(deriveWaveCompletionSuiteReadiness(stampedGraph([OWNER], receiptFor(unstamped)), 1, workspace("b")))
      .toMatchObject({ kind: "required", reason: "accepted-suite-invalid" });
  });

  it("a terminal receipt carrying ownerVerification stays accepted from history, whatever the live roster", () => {
    const receipt = receiptFor(stampedGraph([OWNER]));
    const { active_wave_gate: _active, ...rest } = stampedGraph(["src/other.ts"]);
    const terminal: TaskGraph = {
      ...rest,
      wave_gate_history: [{
        schemaVersion: 2,
        kind: "completed-wave-gate",
        runId: registration.runId,
        wave: 1,
        authorityDigest: registration.authorityDigest,
        revision: 1,
        completionReceipt: value(commitWaveGateCompletion(value(deriveWaveReadiness(stampedGraph([OWNER], receipt), deps(workspace("b")))), new Map())).receipt,
        completionSuite: receipt,
      }],
    };
    expect(deriveWaveCompletionSuiteReadiness(terminal, 1, workspace("d"))).toEqual({
      kind: "accepted",
      projectVerificationCoverage: { kind: "configured", checkIds: ["project:test"] },
      verificationManifestDigest: receipt.manifestDigest,
      suiteDigest: receipt.suiteDigest,
      resultDigest: receipt.resultDigest,
      workspaceDigest: digest("b"),
      checkCount: 3,
    });
  });
});
