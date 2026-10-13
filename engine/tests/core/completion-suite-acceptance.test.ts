import { describe, expect, it } from "vitest";
import {
  acceptanceContractsFromPlan,
  acceptanceExpectation,
  emptyAcceptanceExpectation,
  observeAcceptanceFacts,
  type AcceptanceContract,
  type AcceptanceExpectation,
} from "../../src/core/acceptance-contract";
import {
  evaluateWaveCompletionSuite,
  parseAcceptedWaveCompletionReceipt,
  parseWaveCompletionSuiteResult,
  type AuthorizedWaveCompletionSuite,
  type WaveCompletionSuiteResult,
} from "../../src/core/completion-suite";
import { canonicalJson, type JsonValue } from "../../src/core/review-packet";
import { sha256Hex } from "../../src/core/digest";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import type { ReportTestcase } from "../../src/core/structured-test-report";
import { authorizeWaveCompletionSuite, freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { ActiveWaveGateRegistration, PlanContract } from "../../src/types";
import { value } from "../fixtures/parse-result";
import { evaluateAsRecorded } from "../fixtures/completion-suite-evaluation";

const digest = (fill: string): ArtifactDigest => fill.repeat(64) as ArtifactDigest;
const REPORT_PATH = ".loom/completion-reports/verify.junit.xml";
const REPORT_DIGEST = digest("d");
const ACCEPTANCE = "engine/tests/acceptance/payload.acceptance.test.ts";

const manifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 1,
  kind: "loom-verification-manifest",
  checks: [{
    id: "project:verify",
    scope: "wave",
    executable: "vitest",
    args: ["run", "--reporter=junit", `--outputFile=${REPORT_PATH}`],
    cwd: ".",
    timeoutMs: 60_000,
    report: { kind: "required-file", path: REPORT_PATH },
  }],
}))));

const registration: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.acceptance-gate" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a"),
  revision: 0,
  terminalOutcome: null,
};
const authority: AuthorizedWaveCompletionSuite = value(authorizeWaveCompletionSuite(manifest, registration, digest("b")));

const PLAN: PlanContract = {
  id: "CT-1",
  title: "Payload",
  declaration: {
    kind: "declared",
    types: { kind: "none", reason: "slice" },
    acceptance: [{ path: ACCEPTANCE, anchors: ["AS-003"] }],
    supportedDomain: null,
    statement: "One valid call wins.",
  },
};
const TASKS = [
  { id: "T1", wave: 1, file_list: [ACCEPTANCE], spec_anchors: [] },
  { id: "T2", wave: 2, file_list: ["engine/src/payload.ts"], spec_anchors: ["AS-003"] },
] as const;
const contracts: readonly AcceptanceContract[] = (() => {
  const built = acceptanceContractsFromPlan([PLAN], TASKS);
  if (!built.ok) throw new Error(built.error.join("; "));
  return built.value;
})();
const RED_EXPECTATION = acceptanceExpectation(contracts, TASKS, 1);

const testcase = (name: string, outcome: ReportTestcase["outcome"], classname = "tests/acceptance/payload.acceptance.test.ts"): ReportTestcase =>
  ({ classname, name, outcome, failureType: outcome === "failed" ? "AssertionError" : null });

function result(
  exitCode: number,
  cases: readonly ReportTestcase[] | null,
  expectation: AcceptanceExpectation = RED_EXPECTATION,
  factsDigest: ArtifactDigest = REPORT_DIGEST,
): WaveCompletionSuiteResult {
  const base = {
    kind: "wave-completion-suite-result" as const,
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave" as const,
      outcome: {
        kind: "observed" as const,
        exitCode: check.kind === "project-command" ? exitCode : 0,
        timedOut: false,
        signal: null,
        report: check.reportPolicy.kind === "required-file"
          ? { kind: "produced" as const, path: check.reportPolicy.path, digest: REPORT_DIGEST, byteLength: 10 }
          : { kind: "not-required" as const },
      },
    })),
  };
  if (cases === null) return value(parseWaveCompletionSuiteResult(base));
  const facts = [observeAcceptanceFacts(expectation, "project:verify", factsDigest, { ok: true, value: cases })];
  return value(parseWaveCompletionSuiteResult({ ...base, acceptance: { expectation, facts } }));
}

const RED = [testcase("plain", "passed", "tests/core/other.test.ts"), testcase("payload > AS-003: one call wins", "failed")];

describe("evaluateWaveCompletionSuite — acceptance at the Wave Gate", () => {
  it("accepts a contract-Wave run whose only failures are the RED acceptance testcases, and the receipt proves the excusal", () => {
    const evaluation = evaluateWaveCompletionSuite(authority, result(1, RED), RED_EXPECTATION);
    expect(evaluation.kind).toBe("accepted");
    if (evaluation.kind !== "accepted") return;
    expect(evaluation.receipt.acceptance?.expectation).toEqual(RED_EXPECTATION);
    expect(evaluation.receipt.checks.find(({ checkId }) => checkId === "project:verify")?.outcome).toMatchObject({ exitCode: 1 });
    expect(parseAcceptedWaveCompletionReceipt(JSON.parse(JSON.stringify(evaluation.receipt)))).toEqual({ ok: true, value: evaluation.receipt });
    // A historical re-evaluation judges the receipt under the expectation it recorded.
    const { kind: _kind, resultDigest: _digest, ...body } = evaluation.receipt;
    expect(evaluateAsRecorded(authority, { ...body, kind: "wave-completion-suite-result" }).kind)
      .toBe("accepted");
  });

  it("rejects acceptance that is not RED with the named acceptance failures", () => {
    const evaluation = evaluateWaveCompletionSuite(authority, result(0, [testcase("payload > AS-003: one call wins", "passed")]), RED_EXPECTATION);
    expect(evaluation).toMatchObject({
      kind: "rejected",
      authorityFailures: [],
      semanticFailures: [{
        kind: "acceptance-rejected",
        checkId: "project:verify",
        failures: [{ kind: "acceptance-not-red", contract: "CT-1" }],
      }],
    });
  });

  it("keeps the non-zero exit when a failure leaves the acceptance files", () => {
    const evaluation = evaluateWaveCompletionSuite(authority, result(1, [...RED, testcase("breaks", "failed", "tests/core/other.test.ts")]), RED_EXPECTATION);
    expect(evaluation).toMatchObject({ kind: "rejected", semanticFailures: [{ kind: "non-zero-exit", checkId: "project:verify" }] });
  });

  it("refuses a result judged under another expectation, and facts bound to another report", () => {
    expect(evaluateWaveCompletionSuite(authority, result(1, null), RED_EXPECTATION)).toMatchObject({
      kind: "rejected",
      authorityFailures: [{ kind: "acceptance-expectation-mismatch" }],
    });
    expect(evaluateWaveCompletionSuite(authority, result(1, RED, RED_EXPECTATION, digest("e")), RED_EXPECTATION)).toMatchObject({
      kind: "rejected",
      authorityFailures: [{ kind: "unbound-acceptance-facts", checkIds: ["project:verify"] }],
    });
  });

  it("refuses an explicit acceptance observation for a gate that owes nothing: absence is the one encoding", () => {
    const none = emptyAcceptanceExpectation(1);
    const { acceptance: _acceptance, ...plain } = result(0, null);
    expect(parseWaveCompletionSuiteResult({ ...plain, acceptance: { expectation: none, facts: [] } })).toMatchObject({
      ok: false,
      error: { errors: [expect.stringContaining("must be absent when the gate owes no contract anything")] },
    });
  });

  it("behaves exactly as before when the gate owes no contract", () => {
    const none = emptyAcceptanceExpectation(1);
    expect(evaluateWaveCompletionSuite(authority, result(0, null), none).kind).toBe("accepted");
    expect(evaluateWaveCompletionSuite(authority, result(1, null), none)).toMatchObject({
      kind: "rejected",
      semanticFailures: [{ kind: "non-zero-exit" }],
    });
  });

  it("refuses an accepted receipt whose non-zero exit its own acceptance does not excuse", () => {
    const evaluation = evaluateWaveCompletionSuite(authority, result(1, RED), RED_EXPECTATION);
    if (evaluation.kind !== "accepted") throw new Error("fixture must be accepted");
    const { resultDigest: _digest, acceptance: _acceptance, ...body } = evaluation.receipt;
    const forged = { ...body, resultDigest: sha256Hex(canonicalJson(body as unknown as JsonValue)) };
    expect(parseAcceptedWaveCompletionReceipt(forged)).toMatchObject({
      ok: false,
      error: { errors: [expect.stringContaining("is not a successful completion result")] },
    });
  });
});
