/**
 * A persisted Wave completion result for one stamped ledger graph, built as
 * the gate builds one: the suite authorized through
 * `authorizeWaveCompletionSuite`, the owner check's exit taken from
 * `ownerVerificationExitCode` (the gate's own rule), and the result read back
 * through the production parser `parseWaveCompletionSuiteResult`. Status
 * tests at the core and at the shell share it, so neither re-implements the
 * gate's result construction.
 */

import {
  ownerCheckOf,
  ownerVerificationExitCode,
  parseWaveCompletionSuiteResult,
  type AuthorizedWaveCompletionSuite,
  type WaveCompletionSuiteResult,
} from "../../src/core/completion-suite";
import type { StatusDeps } from "../../src/core/loom-status";
import { ownerCheckAuthority, ownerScopeOf } from "../../src/core/owner-verification/obligations";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerObligation,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
} from "../../src/core/owner-verification/types";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import { capturedSpecCheck } from "../../src/core/spec-check";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { parseTaskGraph } from "../../src/state-manager";
import type { ActiveWaveGateRegistration, TaskGraph, WaveCompletionResultObservation } from "../../src/types";
import { digest } from "./acceptance-fixtures";
import { ownerObligation } from "./owner-obligation";
import { labelledValue, value } from "./parse-result";
import { AFFECTED_RUNNER } from "./stop-check-runners";

export const LEDGER_PLAN_FILE = ".claude/plans/2026-10-22-ledger.md";

/** The ledger graph's one owned Invariant. */
export const LEDGER: OwnerObligation = ownerObligation({
  invariant: "INV-1",
  title: "Ledger entries are balanced only by the balancer",
  statement: null,
  owner: "src/core/balance.ts",
  siblings: [{ path: "src/api/post.ts", note: null }],
  matrixTest: "tests/balance.matrix.test.ts",
  mutation: { kind: "verify" },
});

/** The plan text that declares `LEDGER`. */
export const LEDGER_PLAN_TEXT = [
  "# Plan: ledger", "", "## Invariants", "",
  `### ${LEDGER.invariant}: ${LEDGER.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${LEDGER.owner}\``,
  "**Sibling entry points:**",
  `- \`${LEDGER.siblings[0]!.path}\``,
  `**Matrix test:** \`${LEDGER.matrixTest}\``, "",
].join("\n");

export const LEDGER_REGISTRATION: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.owner-status-unit" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a") as ActiveWaveGateRegistration["authorityDigest"],
  revision: 0,
  terminalOutcome: null,
};

export const LEDGER_WORKSPACE = digest("b");

const MANIFEST: FrozenVerificationManifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 2, kind: "loom-verification-manifest", checks: [], affectedRunner: AFFECTED_RUNNER,
}))));

const FILES = [LEDGER.owner];
const PROOF = evaluateTaskProof(
  { newTestsRequired: false, declaredArtifacts: FILES },
  { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: FILES, newTestsWritten: false },
);

/** The stamped graph, as raw State File JSON: Wave 1 implemented, its gate live, `LEDGER` owed. */
export const LEDGER_GRAPH = Object.freeze({
  current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [], spec_file: null,
  plan_file: LEDGER_PLAN_FILE, wave_gates: {},
  spec_check: capturedSpecCheck({ wave: 1, runAt: "now", criticalFindings: [] }),
  active_wave_gate: LEDGER_REGISTRATION,
  verification_manifest: MANIFEST,
  owner_obligations: [LEDGER],
  tasks: [{
    id: "T1", description: "Change the balancer", agent: "code-implementer-agent", wave: 1, status: "implemented",
    new_tests_required: false, proof: PROOF, depends_on: [], file_list: FILES, files_modified: FILES,
    test_result: { verdict: "trusted-pass" }, test_evidence: "vitest pass", review_status: "passed",
    critical_findings: [], advisory_findings: [],
  }],
});

/** `LEDGER_GRAPH` through the production State File parser. */
export function ledgerGraph(): TaskGraph {
  const parsed = parseTaskGraph(JSON.parse(JSON.stringify(LEDGER_GRAPH)));
  if (!parsed.ok) throw new Error(`fixture graph rejected: ${String(parsed.error)}`);
  return parsed.value;
}

/** The suite authorized for the ledger graph's live gate: with its owner check, or without one (`null`). */
export function ledgerAuthority(withOwnerCheck: boolean): AuthorizedWaveCompletionSuite {
  const owner = withOwnerCheck ? ownerCheckAuthority(ownerScopeOf(ledgerGraph()), LEDGER_REGISTRATION.wave) : null;
  if (withOwnerCheck && owner === null) throw new Error("fixture graph owes no owner check");
  return value(authorizeWaveCompletionSuite(MANIFEST, LEDGER_REGISTRATION, LEDGER_WORKSPACE, owner));
}

/**
 * The persisted result of `authority`, read back through the production
 * parser: every check observed with the exit `exitOf` names, and the owner
 * verification observation when there is one.
 */
export function suiteResultOf(
  authority: AuthorizedWaveCompletionSuite,
  exitOf: (check: AuthorizedWaveCompletionSuite["checks"][number]) => number,
  ownerVerification?: OwnerVerificationObservation,
): WaveCompletionSuiteResult {
  return value(parseWaveCompletionSuiteResult({
    kind: "wave-completion-suite-result",
    runId: authority.runId, wave: authority.wave, revision: authority.revision,
    authorityDigest: authority.authorityDigest, manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest, workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: { kind: "observed", exitCode: exitOf(check), timedOut: false, signal: null, report: { kind: "not-required" } },
    })),
    ...(ownerVerification === undefined ? {} : { ownerVerification }),
  }));
}

/**
 * The persisted result the gate would write for `verdicts`. The owner check
 * exits as the gate's rule says (1 exactly when owner verification blocks),
 * unless `ownerExit` forces an exit that contradicts it; every other check
 * exits 0.
 */
export function persistedOwnerResult(verdicts: readonly InvariantVerdict[], ownerExit?: number): WaveCompletionResultObservation {
  const authority = ledgerAuthority(true);
  const owner = ownerCheckOf(authority);
  if (owner === undefined) throw new Error("fixture suite authorizes no owner check");
  const ownerVerification: OwnerVerificationObservation = {
    kind: "verified", obligationsDigest: owner.obligationsDigest, boundMs: 2_000, verdicts,
  };
  const ownerExitCode = ownerExit ?? ownerVerificationExitCode(ownerVerification);
  const result = suiteResultOf(authority, (check) => check === owner ? ownerExitCode : 0, ownerVerification);
  return { kind: "observed", result };
}

/** The persisted observation a result fixture carries. */
export function ownerVerificationIn(result: WaveCompletionResultObservation): OwnerVerificationObservation {
  if (result.kind !== "observed" || result.result.ownerVerification === undefined) throw new Error("fixture carries no owner verification");
  return result.result.ownerVerification;
}

/** Status dependencies over the ledger plan and workspace, reading `result` as the current Wave's persisted result. */
export const ledgerStatusDeps = (result: WaveCompletionResultObservation): StatusDeps => ({
  loadPlanModels: () => ({ kind: "loaded", models: parsePlanModels(LEDGER_PLAN_TEXT) }),
  filePresence: () => ({ ok: true, exists: true }),
  currentWaveWorkspace: { kind: "observed", workspaceDigest: LEDGER_WORKSPACE },
  currentWaveCompletionResult: result,
});

// ---------------------------------------------------------------------------
// Verdicts the ledger's persisted results carry
// ---------------------------------------------------------------------------

/** One surviving mutant, as the gate records it. */
export const SURVIVOR: SurvivorDiagnostic = {
  mutantId: "c".repeat(64),
  operator: "logical-swap",
  line: 7,
  column: 3,
  original: "&&",
  replacement: "||",
};

/** A verified mutation run through its one constructor; the owner changed in the Wave unless `changed` is false. */
export const verifiedRun = (
  fields: Readonly<{ killed: number; timedOut: number; invalid: number; survivors: readonly SurvivorDiagnostic[]; unmutated: number }>,
  changed = true,
): MutationVerdict => labelledValue("verified mutation", verifiedMutationOf({ ...fields, ownerChangedInWave: changed }));

/** `LEDGER`'s verdict with the given halves. */
export const ledgerVerdict = (coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: LEDGER.invariant, title: LEDGER.title, owner: LEDGER.owner, matrixTest: LEDGER.matrixTest, coverage, mutation,
});

/** `LEDGER` covered, with one surviving mutant: a verdict that blocks. */
export const survivorVerdict = (): InvariantVerdict =>
  ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 }));
