/**
 * T11 / AD-10 status half: the pure owner-verification projection, its remedy
 * text, and the one projection both status renderers serialize.
 *
 * Unit rows exercise `projectOwnerVerificationStatus` over every verdict kind
 * and `ownerVerificationRemedies` over every blocking finding. The shell rows
 * go through `renderStatus` (the renderer behind `helper orchestration status
 * [--json]`) with a stamped graph, a live Wave Gate registration and a
 * persisted completion result authorized exactly as the gate authorizes one.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ownerVerificationRemedies,
  projectOwnerVerificationStatus,
  renderOwnerVerificationStatus,
  type OwnerVerificationStatusReport,
} from "../../src/core/owner-verification/status";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { ownerCheckAuthority } from "../../src/core/owner-verification/obligations";
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
import type { StatusDeps } from "../../src/core/loom-status";
import { renderStatus } from "../../src/handlers/helpers/orchestration";
import { parseTaskGraph } from "../../src/state-manager";
import type { ActiveWaveGateRegistration, LoomStatusDocument, WaveCompletionResultObservation } from "../../src/types";
import { labelledValue, value } from "../fixtures/parse-result";
import { AFFECTED_RUNNER } from "../fixtures/stop-check-runners";

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
  invariant,
  title: `${invariant} title`,
  owner: `src/${invariant}.ts`,
  matrixTest: `tests/${invariant}.matrix.test.ts`,
  coverage,
  mutation,
});

const observed = (verdicts: readonly InvariantVerdict[], boundMs = 60_000): OwnerVerificationObservation =>
  ({ kind: "verified", obligationsDigest: digest("d"), boundMs, verdicts });

const entries = (report: OwnerVerificationStatusReport) => {
  if (report.kind !== "verified") throw new Error(`expected a verified report, got ${report.kind}`);
  return report.invariants;
};

describe("projectOwnerVerificationStatus", () => {
  it("reports not-observed when no persisted result carries owner verification", () => {
    expect(projectOwnerVerificationStatus(undefined)).toEqual({
      kind: "not-observed", reason: "no persisted completion result carries owner verification",
    });
  });

  it("reports the whole check's infrastructure failure when it could not run", () => {
    const failure = { kind: "plan-drift", detail: "the plan gained INV-9" } as const;
    expect(projectOwnerVerificationStatus({ kind: "unavailable", failure })).toEqual({ kind: "unavailable", failure });
  });

  it("projects coverage pass and every mutant count of a verified run, with the bound", () => {
    const report = projectOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3 })),
    ], 90_000));
    expect(report).toMatchObject({ kind: "verified", boundMs: 90_000 });
    expect(entries(report)).toEqual([{
      invariant: "INV-1",
      title: "INV-1 title",
      owner: "src/INV-1.ts",
      matrixTest: "tests/INV-1.matrix.test.ts",
      coverage: { result: "pass" },
      mutation: {
        result: "verified",
        ownerChangedInWave: true,
        generated: 9,
        killed: 5,
        timedOut: 2,
        invalid: 1,
        survivors: [SURVIVOR],
        unmutated: 3,
      },
    }]);
  });

  it("stores no survivor count beside the survivors: the count is derived where it is rendered", () => {
    const survivors = [SURVIVOR, { ...SURVIVOR, mutantId: "e".repeat(64) }];
    const report = projectOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors, unmutated: 0 })),
    ]));
    expect(entries(report)[0]?.mutation).not.toHaveProperty("survived");
    expect(renderOwnerVerificationStatus(report).join("\n")).toMatch(/survived 2,/);
  });

  it("projects missing coverage paths and coverage infrastructure failures", () => {
    const failure = { kind: "coverage-bound-exceeded", detail: "too many files" } as const;
    const [missing, broken] = entries(projectOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/a.ts", "src/b.ts"] }, { kind: "exempt", reason: "r" }),
      verdict("INV-2", { kind: "infrastructure", failure }, { kind: "exempt", reason: "r" }),
    ])));
    expect(missing?.coverage).toEqual({ result: "missing", paths: ["src/a.ts", "src/b.ts"] });
    expect(broken?.coverage).toEqual({ result: "infrastructure", failure });
  });

  it("projects an exemption, a red baseline, a mutation infrastructure failure and an unchanged owner", () => {
    const failure = { kind: "worktree-failed", detail: "no space" } as const;
    const statuses = entries(projectOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "covered" }, { kind: "exempt", reason: "timing-only" }),
      verdict("INV-2", { kind: "covered" }, { kind: "red-baseline", failures: ["row 3"] }),
      verdict("INV-3", { kind: "covered" }, { kind: "infrastructure", failure }),
      verdict("INV-4", { kind: "covered" }, verifiedRun({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 }, false)),
    ])));
    expect(statuses.map((status) => status.mutation)).toEqual([
      { result: "exempt", reason: "timing-only" },
      { result: "red-baseline", failures: ["row 3"] },
      { result: "infrastructure", failure },
      {
        result: "verified", ownerChangedInWave: false,
        generated: 0, killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0,
      },
    ]);
  });

  it("projects verdicts in the observation's order and records none for a Wave that owes none", () => {
    expect(entries(projectOwnerVerificationStatus(observed([])))).toEqual([]);
    const order = entries(projectOwnerVerificationStatus(observed([
      verdict("INV-7", { kind: "covered" }, { kind: "exempt", reason: "r" }),
      verdict("INV-2", { kind: "covered" }, { kind: "exempt", reason: "r" }),
    ]))).map((status) => status.invariant);
    expect(order).toEqual(["INV-7", "INV-2"]);
  });
});

describe("ownerVerificationRemedies", () => {
  it("names no remedy without an observation or without a blocking finding", () => {
    expect(ownerVerificationRemedies(undefined)).toEqual([]);
    expect(ownerVerificationRemedies(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 2, timedOut: 0, invalid: 1, survivors: [], unmutated: 0 })),
    ]))).toEqual([]);
  });

  it("AS-030: a missing sibling names the Invariant, the matrix test and the path it must import", () => {
    const [remedy, ...rest] = ownerVerificationRemedies(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/jobs/invoice.ts"] }, { kind: "exempt", reason: "r" }),
    ]));
    expect(rest).toEqual([]);
    expect(remedy).toContain("INV-1");
    expect(remedy).toMatch(/strengthen tests\/INV-1\.matrix\.test\.ts to import/);
    expect(remedy).toContain("src/jobs/invoice.ts");
  });

  it("AS-030: a survivor names the Invariant, its owner line and operator, and both remedies", () => {
    const [remedy] = ownerVerificationRemedies(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 })),
    ]));
    expect(remedy).toContain("INV-1");
    expect(remedy).toContain(`src/INV-1.ts:${SURVIVOR.line}`);
    expect(remedy).toContain(SURVIVOR.operator);
    expect(remedy).toMatch(/strengthen tests\/INV-1\.matrix\.test\.ts to kill it/);
    expect(remedy).toMatch(/declare a mutation exemption with a reason on INV-1/);
  });

  it("names a red baseline and an infrastructure failure with their Invariant", () => {
    const remedies = ownerVerificationRemedies(observed([
      verdict("INV-2", { kind: "covered" }, { kind: "red-baseline", failures: ["row 3"] }),
      verdict("INV-3", { kind: "covered" }, { kind: "infrastructure", failure: { kind: "spawn-failed", detail: "ENOENT" } }),
    ]));
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toMatch(/^INV-2: .*red.*row 3/);
    expect(remedies[1]).toMatch(/^INV-3: infrastructure failure \(spawn-failed\)/);
    expect(ownerVerificationRemedies({ kind: "unavailable", failure: { kind: "runner-missing", detail: "no runner" } }))
      .toEqual(["owner verification: infrastructure failure (runner-missing): no runner"]);
  });
});

describe("renderOwnerVerificationStatus", () => {
  it("renders one line per Invariant with coverage, counts, exemption and the bound", () => {
    const lines = renderOwnerVerificationStatus(projectOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/x.ts"] }, verifiedRun({ killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3 })),
      verdict("INV-2", { kind: "covered" }, { kind: "exempt", reason: "timing-only" }),
    ], 1_500)));
    const text = lines.join("\n");
    expect(text).toContain("bound 1500 ms");
    expect(text).toMatch(/INV-1.*coverage missing src\/x\.ts.*generated 9, killed 5, timed out 2, invalid 1, survived 1, unmutated 3/);
    expect(text).toContain(`src/INV-1.ts:${SURVIVOR.line}:${SURVIVOR.column} (${SURVIVOR.operator})`);
    expect(text).toMatch(/INV-2.*coverage pass.*mutation exempt: timing-only/);
  });

  it("renders not-observed and unavailable reports", () => {
    expect(renderOwnerVerificationStatus({ kind: "not-observed", reason: "the result is unreadable" }).join("\n"))
      .toMatch(/ownerVerification: not observed \(the result is unreadable\)/);
    expect(renderOwnerVerificationStatus({ kind: "unavailable", failure: { kind: "plan-unreadable", detail: "gone" } }).join("\n"))
      .toMatch(/ownerVerification: unavailable \(plan-unreadable\): gone/);
  });
});

// ---------------------------------------------------------------------------
// helper orchestration status: one projection, human and --json
// ---------------------------------------------------------------------------

const PLAN_FILE = ".claude/plans/2026-10-22-ledger.md";
const LEDGER: OwnerObligation = {
  invariant: "INV-1",
  title: "Ledger entries are balanced only by the balancer",
  statement: null,
  owner: "src/core/balance.ts",
  siblings: [{ path: "src/api/post.ts", note: null }],
  matrixTest: "tests/balance.matrix.test.ts",
  mutation: { kind: "verify" },
};
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

/** The persisted result the gate would write for `verdicts`, observed through the production parser. */
function persisted(verdicts: readonly InvariantVerdict[]): WaveCompletionResultObservation {
  const parsedGraph = parseTaskGraph(JSON.parse(JSON.stringify(GRAPH)));
  if (!parsedGraph.ok) throw new Error(`fixture graph rejected: ${String(parsedGraph.error)}`);
  const owner = ownerCheckAuthority(parsedGraph.value, REGISTRATION.wave);
  if (owner === null) throw new Error("fixture graph owes no owner check");
  const ownerVerification: OwnerVerificationObservation = {
    kind: "verified", obligationsDigest: owner.obligationsDigest, boundMs: 2_000, verdicts,
  };
  const blocked = ownerVerificationRemedies(ownerVerification).length > 0;
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
        exitCode: blocked && check.checkId === "loom:owner-verification" ? 1 : 0,
        timedOut: false, signal: null, report: { kind: "not-required" },
      },
    })),
    ownerVerification,
  }));
  return { kind: "observed", result: parsed };
}

function statusOf(result: WaveCompletionResultObservation): Readonly<{ human: string; json: Record<string, unknown> }> {
  const deps: StatusDeps = {
    loadPlanModels: () => ({ kind: "loaded", models: parsePlanModels(PLAN_TEXT) }),
    filePresence: () => ({ ok: true, exists: true }),
    currentWaveWorkspace: { kind: "observed", workspaceDigest: WORKSPACE },
    currentWaveCompletionResult: result,
  };
  const graph = JSON.parse(JSON.stringify(GRAPH)) as unknown;
  return {
    human: renderStatus(graph, deps, false),
    json: JSON.parse(renderStatus(graph, deps, true)) as Record<string, unknown>,
  };
}

const ledgerVerdict = (coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: LEDGER.invariant, title: LEDGER.title, owner: LEDGER.owner, matrixTest: LEDGER.matrixTest, coverage, mutation,
});

describe("helper orchestration status: owner verification", () => {
  it("AS-029: --json carries the projection and human status renders the very same projection", () => {
    const result = persisted([ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 4, timedOut: 1, invalid: 0, survivors: [], unmutated: 2 }))]);
    const { human, json } = statusOf(result);
    const expected = projectOwnerVerificationStatus(result.kind === "observed" ? result.result.ownerVerification : undefined);
    expect(json.ownerVerification).toEqual(expected);
    for (const line of renderOwnerVerificationStatus(expected)) expect(human).toContain(line);
  });

  it("AS-029: without a persisted result, --json and human status report owner verification as not observed", () => {
    const { human, json } = statusOf({ kind: "absent" });
    expect(json.ownerVerification).toEqual({ kind: "not-observed", reason: "no persisted completion result carries owner verification" });
    expect(human).toMatch(/- ownerVerification: not observed/);
  });

  it("the status document type is exactly the shape --json emits, ownerVerification included", () => {
    expectTypeOf<LoomStatusDocument["ownerVerification"]>().toEqualTypeOf<OwnerVerificationStatusReport | undefined>();
    const keys: readonly (keyof LoomStatusDocument)[] = ["schemaVersion", "facts", "next", "ownerVerification"];
    const { json } = statusOf({ kind: "absent" });
    expect(Object.keys(json).sort()).toEqual([...keys].sort());
  });

  it("an unavailable persisted completion result is reported as not observed, naming why, never as no result", () => {
    const { human, json } = statusOf({ kind: "unavailable", reason: "EIO: i/o error reading the completion result" });
    expect(json.ownerVerification).toEqual({
      kind: "not-observed",
      reason: "the persisted completion result is unavailable: EIO: i/o error reading the completion result",
    });
    expect(human).toContain("- ownerVerification: not observed (the persisted completion result is unavailable: EIO: i/o error reading the completion result)");
  });

  it("AS-030: a gate the suite rejected for a survivor names the Invariant and the remedy in the next action", () => {
    const { human, json } = statusOf(persisted([
      ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 })),
    ]));
    const next = JSON.stringify(json.next);
    expect(next).toContain("INV-1");
    expect(next).toContain(`${LEDGER.owner}:${SURVIVOR.line}`);
    expect(next).toMatch(/strengthen tests\/balance\.matrix\.test\.ts to kill it, or declare a mutation exemption with a reason on INV-1/);
    expect(human.slice(human.indexOf("- nextAction"))).toContain(`${LEDGER.owner}:${SURVIVOR.line}`);
  });

  it("AS-030: a passing owner verification adds no remedy to the next action", () => {
    const { json } = statusOf(persisted([
      ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 3, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 })),
    ]));
    expect(JSON.stringify(json.next)).not.toMatch(/strengthen|mutation exemption/);
  });
});
