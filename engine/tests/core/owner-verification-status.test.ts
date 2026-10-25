/**
 * T11 / AD-10 status half: the one owner-verification status value (the
 * report and its remedies), the persisted-result read that derives it, the
 * next-action merge that consumes it, and the status document both renderers
 * serialize.
 *
 * Unit rows exercise `observedOwnerVerificationStatus` over every verdict
 * kind and blocking finding, `ownerVerificationStatusOf` over every persisted
 * result observation, and `withOwnerVerificationRemedies` over the readiness
 * gate. The shell rows go through `renderStatus` (the renderer behind `helper
 * orchestration status [--json]`) with a stamped graph, a live Wave Gate
 * registration and a persisted completion result authorized exactly as the
 * gate authorizes one.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  observedOwnerVerificationStatus,
  ownerVerificationNotObserved,
  renderOwnerVerificationStatus,
  type OwnerVerificationStatusReport,
} from "../../src/core/owner-verification/status";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { ownerCheckAuthority, ownerScopeOf } from "../../src/core/owner-verification/obligations";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerObligation,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
} from "../../src/core/owner-verification/types";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { parseWaveCompletionSuiteResult } from "../../src/core/completion-suite";
import { capturedSpecCheck } from "../../src/core/spec-check";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import {
  deriveLoomStatusFromParsedGraph,
  ownerVerificationStatusOf,
  withOwnerVerificationRemedies,
  type StatusDeps,
} from "../../src/core/loom-status";
import { renderStatus } from "../../src/handlers/helpers/orchestration";
import { parseTaskGraph } from "../../src/state-manager";
import type {
  ActiveWaveGateRegistration,
  LoomStatus,
  LoomStatusDocument,
  TaskGraph,
  WaveCompletionResultObservation,
} from "../../src/types";
import { labelledValue, value } from "../fixtures/parse-result";
import { AFFECTED_RUNNER } from "../fixtures/stop-check-runners";
import { invariantId, ownerObligation } from "../fixtures/owner-obligation";

const digest = (fill: string): ArtifactDigest => fill.repeat(64) as ArtifactDigest;

const SURVIVOR: SurvivorDiagnostic = {
  mutantId: "c".repeat(64),
  operator: "logical-swap",
  line: 7,
  column: 3,
  original: "&&",
  replacement: "||",
};

const verifiedRun = (fields: Readonly<{ killed: number; timedOut: number; invalid: number; survivors: readonly SurvivorDiagnostic[]; unmutated: number }>, changed = true): MutationVerdict =>
  labelledValue("verified mutation", verifiedMutationOf({ ...fields, ownerChangedInWave: changed }));

const verdict = (invariant: string, coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: invariantId(invariant),
  title: `${invariant} title`,
  owner: `src/${invariant}.ts`,
  matrixTest: `tests/${invariant}.matrix.test.ts`,
  coverage,
  mutation,
});

const observed = (verdicts: readonly InvariantVerdict[], boundMs = 60_000): OwnerVerificationObservation =>
  ({ kind: "verified", obligationsDigest: digest("d"), boundMs, verdicts });

const remediesOf = (observation: OwnerVerificationObservation): readonly string[] =>
  observedOwnerVerificationStatus(observation).remedies;

describe("observedOwnerVerificationStatus: the report", () => {
  it("reports the persisted observation itself, verdicts and bound as the gate judged them, with no status-only copy", () => {
    const observation = observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3 })),
      verdict("INV-2", { kind: "missing", paths: ["src/a.ts"] }, { kind: "exempt", reason: "timing-only" }),
    ], 90_000);
    expect(observedOwnerVerificationStatus(observation).report).toBe(observation);
  });

  it("reports the whole check's infrastructure failure when it could not run", () => {
    const failure = { kind: "plan-drift", detail: "the plan gained INV-9" } as const;
    const observation: OwnerVerificationObservation = { kind: "unavailable", failure };
    expect(observedOwnerVerificationStatus(observation).report).toEqual({ kind: "unavailable", failure });
  });

  it("stores no survivor count beside the survivors: the count is derived where it is rendered", () => {
    const survivors = [SURVIVOR, { ...SURVIVOR, mutantId: "e".repeat(64) }];
    const observation = observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors, unmutated: 0 })),
    ]);
    const { report } = observedOwnerVerificationStatus(observation);
    expect(report.kind === "verified" ? report.verdicts[0]?.mutation : null).not.toHaveProperty("survived");
    expect(renderOwnerVerificationStatus(report).join("\n")).toMatch(/survived 2,/);
  });
});

describe("observedOwnerVerificationStatus: the remedies", () => {
  it("names no remedy without a blocking finding, and none for a status that observed nothing", () => {
    expect(ownerVerificationNotObserved("no persisted completion result").remedies).toEqual([]);
    expect(remediesOf(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 2, timedOut: 0, invalid: 1, survivors: [], unmutated: 0 })),
    ]))).toEqual([]);
  });

  it("AS-030: a missing sibling names the Invariant, the matrix test and the path it must import", () => {
    const [remedy, ...rest] = remediesOf(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/jobs/invoice.ts"] }, { kind: "exempt", reason: "r" }),
    ]));
    expect(rest).toEqual([]);
    expect(remedy).toContain("INV-1");
    expect(remedy).toMatch(/strengthen tests\/INV-1\.matrix\.test\.ts to import/);
    expect(remedy).toContain("src/jobs/invoice.ts");
  });

  it("AS-030: a survivor names the Invariant, its owner line and operator, and both remedies", () => {
    const [remedy] = remediesOf(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 })),
    ]));
    expect(remedy).toContain("INV-1");
    expect(remedy).toContain(`src/INV-1.ts:${SURVIVOR.line}`);
    expect(remedy).toContain(SURVIVOR.operator);
    expect(remedy).toMatch(/strengthen tests\/INV-1\.matrix\.test\.ts to kill it/);
    expect(remedy).toMatch(/declare a mutation exemption with a reason on INV-1/);
  });

  it("names a red baseline and an infrastructure failure with their Invariant", () => {
    const remedies = remediesOf(observed([
      verdict("INV-2", { kind: "covered" }, { kind: "red-baseline", failures: ["row 3"] }),
      verdict("INV-3", { kind: "covered" }, { kind: "infrastructure", failure: { kind: "spawn-failed", detail: "ENOENT" } }),
    ]));
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toMatch(/^INV-2: .*red.*row 3/);
    expect(remedies[1]).toMatch(/^INV-3: infrastructure failure \(spawn-failed\)/);
    expect(remediesOf({ kind: "unavailable", failure: { kind: "runner-missing", detail: "no runner" } }))
      .toEqual(["owner verification: infrastructure failure (runner-missing): no runner"]);
  });
});

describe("renderOwnerVerificationStatus", () => {
  it("renders one line per Invariant with coverage, counts, exemption and the bound", () => {
    const lines = renderOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/x.ts"] }, verifiedRun({ killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3 })),
      verdict("INV-2", { kind: "covered" }, { kind: "exempt", reason: "timing-only" }),
    ], 1_500));
    const text = lines.join("\n");
    expect(text).toContain("- ownerVerification: 2 Invariant(s), bound 1500 ms");
    expect(text).toMatch(/INV-1.*coverage missing src\/x\.ts.*generated 9, killed 5, timed out 2, invalid 1, survived 1, unmutated 3/);
    expect(text).toContain(`src/INV-1.ts:${SURVIVOR.line}:${SURVIVOR.column} (${SURVIVOR.operator})`);
    expect(text).toMatch(/INV-2.*coverage pass.*mutation exempt: timing-only/);
  });

  it("renders a red baseline, an infrastructure failure, coverage infrastructure and an unchanged owner", () => {
    const text = renderOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "infrastructure", failure: { kind: "coverage-bound-exceeded", detail: "too many files" } },
        { kind: "red-baseline", failures: ["row 3"] }),
      verdict("INV-2", { kind: "covered" }, { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "no space" } }),
      verdict("INV-3", { kind: "covered" }, verifiedRun({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 }, false)),
    ])).join("\n");
    expect(text).toMatch(/INV-1.*coverage infrastructure failure \(coverage-bound-exceeded\): too many files; mutation baseline red: row 3/);
    expect(text).toMatch(/INV-2.*mutation infrastructure failure \(worktree-failed\): no space/);
    expect(text).toMatch(/INV-3.*\(owner unchanged in Wave\)/);
  });

  it("renders verdicts in the observation's order and a header alone for a Wave that owes none", () => {
    expect(renderOwnerVerificationStatus(observed([]))).toEqual(["- ownerVerification: 0 Invariant(s), bound 60000 ms"]);
    const text = renderOwnerVerificationStatus(observed([
      verdict("INV-7", { kind: "covered" }, { kind: "exempt", reason: "r" }),
      verdict("INV-2", { kind: "covered" }, { kind: "exempt", reason: "r" }),
    ])).join("\n");
    expect(text.indexOf("INV-7")).toBeLessThan(text.indexOf("INV-2"));
  });

  it("renders not-observed and unavailable reports", () => {
    expect(renderOwnerVerificationStatus({ kind: "not-observed", reason: "the result is unreadable" }).join("\n"))
      .toMatch(/ownerVerification: not observed \(the result is unreadable\)/);
    expect(renderOwnerVerificationStatus({ kind: "unavailable", failure: { kind: "plan-unreadable", detail: "gone" } }).join("\n"))
      .toMatch(/ownerVerification: unavailable \(plan-unreadable\): gone/);
  });
});

// ---------------------------------------------------------------------------
// The persisted result read, the next-action merge and helper orchestration
// status: one value, human and --json
// ---------------------------------------------------------------------------

const PLAN_FILE = ".claude/plans/2026-10-22-ledger.md";
const LEDGER: OwnerObligation = ownerObligation({
  invariant: "INV-1",
  title: "Ledger entries are balanced only by the balancer",
  statement: null,
  owner: "src/core/balance.ts",
  siblings: [{ path: "src/api/post.ts", note: null }],
  matrixTest: "tests/balance.matrix.test.ts",
  mutation: { kind: "verify" },
});
const PLAN_TEXT = [
  "# Plan: ledger", "", "## Invariants", "",
  `### ${LEDGER.invariant}: ${LEDGER.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${LEDGER.owner}\``,
  "**Sibling entry points:**",
  `- \`${LEDGER.siblings[0]!.path}\``,
  `**Matrix test:** \`${LEDGER.matrixTest}\``, "",
].join("\n");

const REGISTRATION: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.owner-status-unit" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a") as ActiveWaveGateRegistration["authorityDigest"],
  revision: 0,
  terminalOutcome: null,
};
const WORKSPACE = digest("b");
const MANIFEST: FrozenVerificationManifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 2, kind: "loom-verification-manifest", checks: [], affectedRunner: AFFECTED_RUNNER,
}))));
const FILES = [LEDGER.owner];
const PROOF = evaluateTaskProof(
  { newTestsRequired: false, declaredArtifacts: FILES },
  { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: FILES, newTestsWritten: false },
);

const GRAPH = Object.freeze({
  current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [], spec_file: null,
  plan_file: PLAN_FILE, wave_gates: {},
  spec_check: capturedSpecCheck({ wave: 1, runAt: "now", criticalFindings: [] }),
  active_wave_gate: REGISTRATION,
  verification_manifest: MANIFEST,
  owner_obligations: [LEDGER],
  tasks: [{
    id: "T1", description: "Change the balancer", agent: "code-implementer-agent", wave: 1, status: "implemented",
    new_tests_required: false, proof: PROOF, depends_on: [], file_list: FILES, files_modified: FILES,
    test_result: { verdict: "trusted-pass" }, test_evidence: "vitest pass", review_status: "passed",
    critical_findings: [], advisory_findings: [],
  }],
});

const parsedGraph = (): TaskGraph => {
  const parsed = parseTaskGraph(JSON.parse(JSON.stringify(GRAPH)));
  if (!parsed.ok) throw new Error(`fixture graph rejected: ${String(parsed.error)}`);
  return parsed.value;
};

const OWNER_CHECK_ID = "loom:owner-verification";

/**
 * The persisted result the gate would write for `verdicts`, observed through
 * the production parser. The owner check exits 1 exactly when owner
 * verification blocks, unless `ownerExit` forces an exit that contradicts it.
 */
function persisted(verdicts: readonly InvariantVerdict[], ownerExit?: number): WaveCompletionResultObservation {
  const owner = ownerCheckAuthority(ownerScopeOf(parsedGraph()), REGISTRATION.wave);
  if (owner === null) throw new Error("fixture graph owes no owner check");
  const ownerVerification: OwnerVerificationObservation = {
    kind: "verified", obligationsDigest: owner.obligationsDigest, boundMs: 2_000, verdicts,
  };
  const exit = ownerExit ?? (remediesOf(ownerVerification).length > 0 ? 1 : 0);
  const authority = value(authorizeWaveCompletionSuite(MANIFEST, REGISTRATION, WORKSPACE, owner));
  const parsed = value(parseWaveCompletionSuiteResult({
    kind: "wave-completion-suite-result",
    runId: authority.runId, wave: authority.wave, revision: authority.revision,
    authorityDigest: authority.authorityDigest, manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest, workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: check.checkId === OWNER_CHECK_ID ? exit : 0,
        timedOut: false, signal: null, report: { kind: "not-required" },
      },
    })),
    ownerVerification,
  }));
  return { kind: "observed", result: parsed };
}

const statusDeps = (result: WaveCompletionResultObservation): StatusDeps => ({
  loadPlanModels: () => ({ kind: "loaded", models: parsePlanModels(PLAN_TEXT) }),
  filePresence: () => ({ ok: true, exists: true }),
  currentWaveWorkspace: { kind: "observed", workspaceDigest: WORKSPACE },
  currentWaveCompletionResult: result,
});

function statusOf(result: WaveCompletionResultObservation): Readonly<{ human: string; json: Record<string, unknown> }> {
  const graph = JSON.parse(JSON.stringify(GRAPH)) as unknown;
  return {
    human: renderStatus(graph, statusDeps(result), false),
    json: JSON.parse(renderStatus(graph, statusDeps(result), true)) as Record<string, unknown>,
  };
}

const ledgerVerdict = (coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: LEDGER.invariant, title: LEDGER.title, owner: LEDGER.owner, matrixTest: LEDGER.matrixTest, coverage, mutation,
});

const survivorVerdict = (): InvariantVerdict =>
  ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 }));

/** The persisted observation a result fixture carries. */
const ownerVerificationIn = (result: WaveCompletionResultObservation): OwnerVerificationObservation => {
  if (result.kind !== "observed" || result.result.ownerVerification === undefined) throw new Error("fixture carries no owner verification");
  return result.result.ownerVerification;
};

const OWNER_REMEDY = /owner verification blocks the Wave Gate/;

describe("ownerVerificationStatusOf: the persisted result, decided once", () => {
  it("reports no persisted result as not observed, owing no remedy, whether status read none or was given none", () => {
    for (const result of [undefined, { kind: "absent" } as const]) {
      expect(ownerVerificationStatusOf(result)).toEqual({
        report: { kind: "not-observed", reason: "no persisted completion result" }, remedies: [],
      });
    }
  });

  it("reports a persisted result status could not read as not observed, naming the read failure, owing no remedy", () => {
    expect(ownerVerificationStatusOf({ kind: "unavailable", reason: "EIO" })).toEqual({
      report: { kind: "not-observed", reason: "the persisted completion result is unavailable: EIO" }, remedies: [],
    });
  });

  it("reports a persisted result without owner verification as not observed, saying so", () => {
    const authority = value(authorizeWaveCompletionSuite(MANIFEST, REGISTRATION, WORKSPACE, null));
    const result = value(parseWaveCompletionSuiteResult({
      kind: "wave-completion-suite-result",
      runId: authority.runId, wave: authority.wave, revision: authority.revision,
      authorityDigest: authority.authorityDigest, manifestDigest: authority.manifestDigest,
      suiteDigest: authority.suiteDigest, workspaceDigest: authority.workspaceDigest,
      checks: authority.checks.map((check) => ({
        checkId: check.checkId, scope: "wave",
        outcome: { kind: "observed", exitCode: 0, timedOut: false, signal: null, report: { kind: "not-required" } },
      })),
    }));
    expect(ownerVerificationStatusOf({ kind: "observed", result })).toEqual({
      report: { kind: "not-observed", reason: "the persisted completion result carries no owner verification" }, remedies: [],
    });
  });

  it("reports a persisted owner verification as itself, with its blocking findings as remedies", () => {
    const result = persisted([survivorVerdict()]);
    const ownerVerification = ownerVerificationIn(result);
    expect(ownerVerificationStatusOf(result)).toEqual(observedOwnerVerificationStatus(ownerVerification));
    expect(ownerVerificationStatusOf(result).remedies).toHaveLength(1);
  });
});

describe("withOwnerVerificationRemedies: the readiness gate", () => {
  /** The routed status of `result` (remedies already merged) and its owner-verification status. */
  const derived = (result: WaveCompletionResultObservation) => {
    const { ownerVerification: _report, ...status } = deriveLoomStatusFromParsedGraph({ ok: true, value: parsedGraph() }, statusDeps(result));
    return { status, owner: ownerVerificationStatusOf(result) };
  };

  it("adds one reason per remedy when the suite rejected the Wave for owner verification", () => {
    const { status, owner } = derived(persisted([survivorVerdict()]));
    const merged = withOwnerVerificationRemedies(status, owner);
    expect(merged.next.reasons).toHaveLength(status.next.reasons.length + owner.remedies.length);
    expect(merged.next.reasons.at(-1)?.message).toMatch(OWNER_REMEDY);
  });

  it("adds none when the persisted result carries a survivor but the suite was rejected only for another failure kind", () => {
    const { status, owner } = derived(persisted([survivorVerdict()]));
    const suite = status.facts.waveCompletionSuiteReadiness;
    if (suite.kind !== "known" || suite.value.kind !== "rejected") throw new Error("fixture suite must be rejected");
    const otherOnly: LoomStatus = {
      ...status,
      facts: { ...status.facts, waveCompletionSuiteReadiness: { ...suite, value: { ...suite.value, failureKinds: ["non-zero-exit"] } } },
    };
    expect(owner.remedies).not.toEqual([]);
    expect(withOwnerVerificationRemedies(otherOnly, owner)).toBe(otherOnly);
  });

  it("adds none when the suite rejected for owner verification but the status observed nothing to remedy", () => {
    const { status } = derived(persisted([survivorVerdict()]));
    expect(withOwnerVerificationRemedies(status, ownerVerificationNotObserved("no persisted completion result"))).toBe(status);
  });
});

describe("helper orchestration status: owner verification", () => {
  it("AS-029: --json carries the persisted observation as the report and human status renders that very report", () => {
    const result = persisted([ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 4, timedOut: 1, invalid: 0, survivors: [], unmutated: 2 }))]);
    const { human, json } = statusOf(result);
    const expected: OwnerVerificationStatusReport = ownerVerificationIn(result);
    expect(json.ownerVerification).toEqual(expected);
    for (const line of renderOwnerVerificationStatus(expected)) expect(human).toContain(line);
  });

  it("AS-029: without a persisted result, --json and human status report owner verification as not observed", () => {
    const { human, json } = statusOf({ kind: "absent" });
    expect(json.ownerVerification).toEqual({ kind: "not-observed", reason: "no persisted completion result" });
    expect(human).toMatch(/- ownerVerification: not observed/);
  });

  it("the status document type requires ownerVerification and is exactly the shape --json emits", () => {
    expectTypeOf<LoomStatusDocument["ownerVerification"]>().toEqualTypeOf<OwnerVerificationStatusReport>();
    expectTypeOf<ReturnType<typeof deriveLoomStatusFromParsedGraph>>().toEqualTypeOf<LoomStatusDocument>();
    expectTypeOf<LoomStatus>().not.toHaveProperty("ownerVerification");
    const keys: readonly (keyof LoomStatusDocument)[] = ["schemaVersion", "facts", "next", "ownerVerification"];
    const { json } = statusOf({ kind: "absent" });
    expect(Object.keys(json).sort()).toEqual([...keys].sort());
  });

  it("an unavailable persisted completion result is reported as not observed, naming why, and names no remedy", () => {
    const { human, json } = statusOf({ kind: "unavailable", reason: "EIO: i/o error reading the completion result" });
    expect(json.ownerVerification).toEqual({
      kind: "not-observed",
      reason: "the persisted completion result is unavailable: EIO: i/o error reading the completion result",
    });
    expect(human).toContain("- ownerVerification: not observed (the persisted completion result is unavailable: EIO: i/o error reading the completion result)");
    expect(JSON.stringify(json.next)).not.toMatch(OWNER_REMEDY);
  });

  it("AS-030: a gate the suite rejected for a survivor names the Invariant and the remedy in the next action", () => {
    const { human, json } = statusOf(persisted([survivorVerdict()]));
    const next = JSON.stringify(json.next);
    expect(next).toContain("INV-1");
    expect(next).toContain(`${LEDGER.owner}:${SURVIVOR.line}`);
    expect(next).toMatch(/strengthen tests\/balance\.matrix\.test\.ts to kill it, or declare a mutation exemption with a reason on INV-1/);
    expect(human.slice(human.indexOf("- nextAction"))).toContain(`${LEDGER.owner}:${SURVIVOR.line}`);
  });

  it("a persisted survivor the suite did not reject for owner verification (its owner exit contradicts it) is reported but names no remedy", () => {
    const { human, json } = statusOf(persisted([survivorVerdict()], 0));
    expect(JSON.stringify(json.facts)).not.toContain("owner-verification-rejected");
    expect(JSON.stringify(json.ownerVerification)).toContain(SURVIVOR.mutantId);
    expect(human).toContain(`survivor at ${LEDGER.owner}:${SURVIVOR.line}`);
    expect(JSON.stringify(json.next)).not.toMatch(OWNER_REMEDY);
  });

  it("AS-030: a passing owner verification adds no remedy to the next action", () => {
    const { json } = statusOf(persisted([
      ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 3, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 })),
    ]));
    expect(JSON.stringify(json.next)).not.toMatch(/strengthen|mutation exemption/);
  });
});
