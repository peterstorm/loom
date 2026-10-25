/**
 * CT-2 acceptance: the brief's owner duties and the owner-verification status.
 *
 * Brief (FR-027, AS-028): `renderTaskImplementationBrief`, the shell behind
 * `helper orchestration brief`, renders a Task's brief from a protected graph
 * on disk that carries the population stamp `owner_obligations` (plan AD-2)
 * and names a real plan. The duty paragraph is asserted inside the brief's
 * `## Invariant Ownership` section.
 *
 * Status (FR-028, AS-029, AS-030): `renderStatus`, the renderer behind
 * `helper orchestration status [--json]`, reads a stamped graph with a live
 * Wave Gate registration and the latest persisted completion result. The
 * result fixture is built the way the gate builds one: the suite is authorized
 * by the production `authorizeWaveCompletionSuite` with the owner check
 * authority that obligations.ts (INV-3's owner) derives from the graph (plan
 * AD-1, AD-4), every authorized check gets an observed outcome, the result
 * carries `ownerVerification` (plan AD-1, CT-1's observation), and it then
 * passes through the production result parser exactly as the shell's persisted
 * result read does. A result the parser refuses is observed as unavailable,
 * as the shell would observe it.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { parseWaveCompletionSuiteResult } from "../../src/core/completion-suite";
import { capturedSpecCheck } from "../../src/core/spec-check";
import type { ArtifactDigest, NonEmpty } from "../../src/core/orchestration-contract";
import type {
  CoverageVerdict,
  InvariantVerdict,
  OwnerObligation,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
  VerifiedMutationFields,
} from "../../src/core/owner-verification/types";
import { ownerCheckAuthority, ownerScopeOf } from "../../src/core/owner-verification/obligations";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { ownerVerificationStatusOf, type StatusDeps } from "../../src/core/loom-status";
import { renderOwnerVerificationStatus, type OwnerVerificationStatusReport } from "../../src/core/owner-verification/status";
import { renderStatus } from "../../src/handlers/helpers/orchestration";
import { renderTaskImplementationBrief } from "../../src/orchestration/implementation-brief";
import { parseTaskGraph } from "../../src/state-manager";
import type { ActiveWaveGateRegistration, TaskGraph, WaveCompletionResultObservation } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { CLOCK, CLOCK_EXEMPTION, FEES, FEES_CLOCK_PLAN_FILE, FEES_CLOCK_PLAN_TEXT, someParagraph } from "../fixtures/owner-families";
import { labelledValue, value } from "../fixtures/parse-result";
import { AFFECTED_RUNNER } from "../fixtures/stop-check-runners";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The shared FEES / CLOCK plan: one verified owned Invariant and one exempt one. */
const PLAN_FILE = FEES_CLOCK_PLAN_FILE;
/** The population stamp, typed by CT-1 so the fixture is the shape the wire admits. */
const OBLIGATIONS: readonly OwnerObligation[] = [FEES, CLOCK];

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/** A protected graph on disk whose one Wave 1 Task declares `fileList`. */
function briefGraph(fileList: readonly string[]): string {
  const root = canonicalTempDir("loom-owner-duties-");
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), FEES_CLOCK_PLAN_TEXT);
  const path = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(path, JSON.stringify({
    current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: PLAN_FILE, wave_gates: {},
    owner_obligations: OBLIGATIONS,
    tasks: [{
      id: "T1", description: "Change the fee family", agent: "code-implementer-agent", wave: 1, depends_on: [],
      file_list: fileList, status: "pending",
    }],
  }));
  return path;
}

/** The rendered brief's `## Invariant Ownership` section. */
function ownershipSection(fileList: readonly string[]): string {
  const rendered = renderTaskImplementationBrief(briefGraph(fileList), LOOM_PACKAGE_ROOT, { taskId: "T1", operatorNotes: [] });
  if (!rendered.ok) throw new Error(`brief refused: ${rendered.error}`);
  const prompt = rendered.value.prompt;
  const start = prompt.indexOf("## Invariant Ownership");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end < 0 ? undefined : end);
}

describe("owner duties in the implementation brief (CT-2)", () => {
  it("AS-028: FR-027: the owner Task's brief states the matrix test must import the owner and every sibling, and that the owner's changed lines will be mutation-verified", () => {
    const section = ownershipSection([FEES.owner]);

    // Coverage duty: the matrix test must import the owner and every named sibling.
    expect(someParagraph(
      section,
      /must import/i,
      FEES.matrixTest,
      FEES.owner,
      ...FEES.siblings.map(({ path }) => path),
    )).toBe(true);
    // Mutation duty: the owner's lines changed in the Wave are mutation-verified.
    expect(someParagraph(section, /mutation[- ]verif/i, /changed/i, FEES.owner)).toBe(true);
  });

  it("AS-028: FR-027: the matrix-test author's brief for an exempt Invariant states the import duty and names the declared mutation exemption and its reason", () => {
    const section = ownershipSection([CLOCK.matrixTest]);

    expect(someParagraph(
      section,
      /must import/i,
      CLOCK.matrixTest,
      CLOCK.owner,
      ...CLOCK.siblings.map(({ path }) => path),
    )).toBe(true);
    expect(someParagraph(section, /exempt/i, CLOCK_EXEMPTION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const digest = (fill: string): ArtifactDigest => fill.repeat(64) as ArtifactDigest;
const WORKSPACE = digest("b");

const registration: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.owner-verification-status" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a") as ActiveWaveGateRegistration["authorityDigest"],
  revision: 0,
  terminalOutcome: null,
};

/** An operator manifest freezing the affectedRunner owner verification runs through (plan AD-8). */
const MANIFEST: FrozenVerificationManifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 2,
  kind: "loom-verification-manifest",
  checks: [],
  affectedRunner: AFFECTED_RUNNER,
}))));

const STATUS_TASK_FILES: readonly string[] = [FEES.owner, CLOCK.owner];

/** A satisfied Proof, so the completion suite is the Wave's only open prerequisite. */
const proof = evaluateTaskProof(
  { newTestsRequired: false, declaredArtifacts: STATUS_TASK_FILES },
  { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: STATUS_TASK_FILES, newTestsWritten: false },
);
if (proof.state !== "satisfied") throw new Error("proof fixture must be satisfied");

/** The protected graph as stored: one implemented, reviewed Wave 1 Task changing both owners. */
const STATUS_GRAPH = Object.freeze({
  current_phase: "execute",
  current_wave: 1,
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: PLAN_FILE,
  wave_gates: {},
  spec_check: capturedSpecCheck({ wave: 1, runAt: "now", criticalFindings: [] }),
  active_wave_gate: registration,
  verification_manifest: MANIFEST,
  owner_obligations: OBLIGATIONS,
  tasks: [{
    id: "T1",
    description: "Change the fee and clock owners",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    new_tests_required: false,
    proof,
    depends_on: [],
    file_list: STATUS_TASK_FILES,
    files_modified: STATUS_TASK_FILES,
    test_result: { verdict: "trusted-pass" },
    test_evidence: "vitest pass",
    review_status: "passed",
    critical_findings: [],
    advisory_findings: [],
  }],
});

const parsedStatusGraph = (): TaskGraph => {
  const parsed = parseTaskGraph(JSON.parse(JSON.stringify(STATUS_GRAPH)));
  if (!parsed.ok) throw new Error(`status fixture graph rejected: ${String(parsed.error)}`);
  return parsed.value;
};

const OWNER_CHECK_ID = "loom:owner-verification";

/** The tallies of a verified mutation run over a changed owner; `verifiedMutationOf` derives `generated`. */
type VerifiedMutation = Omit<VerifiedMutationFields, "ownerChangedInWave">;

/** INV-1's verdict: a verified mutation run over its changed owner lines. */
const feesVerdict = (coverage: CoverageVerdict, mutation: VerifiedMutation): InvariantVerdict => ({
  invariant: FEES.invariant,
  title: FEES.title,
  owner: FEES.owner,
  matrixTest: FEES.matrixTest,
  coverage,
  mutation: labelledValue("INV-1 verified mutation", verifiedMutationOf({ ...mutation, ownerChangedInWave: true })),
});

/** INV-2's verdict: covered, with its declared exemption recorded. */
const clockVerdict = (): InvariantVerdict => ({
  invariant: CLOCK.invariant,
  title: CLOCK.title,
  owner: CLOCK.owner,
  matrixTest: CLOCK.matrixTest,
  coverage: { kind: "covered" },
  mutation: { kind: "exempt", reason: CLOCK_EXEMPTION },
});

/** INV-1's sibling the sibling-omitting matrix test never imports. */
const MISSING_SIBLING = FEES.siblings[1].path;
const missingSibling: CoverageVerdict = { kind: "missing", paths: [MISSING_SIBLING] satisfies NonEmpty<string> };

/**
 * The latest persisted completion result of the active Wave Gate run, as the
 * status shell observes it: every authorized check observed (the owner check
 * exits 1 exactly when owner verification blocks, as the reserved lint check
 * does), the owner-verification observation attached, then parsed.
 */
function persistedResult(
  verdicts: readonly InvariantVerdict[],
  blocked: boolean,
): WaveCompletionResultObservation {
  const owner = ownerCheckAuthority(ownerScopeOf(parsedStatusGraph()), registration.wave);
  if (owner === null) throw new Error("the stamped status fixture graph owes no owner check");
  const ownerVerification: OwnerVerificationObservation = {
    kind: "verified",
    obligationsDigest: owner.obligationsDigest,
    boundMs: 1_500_000,
    verdicts,
  };
  const authority = value(authorizeWaveCompletionSuite(MANIFEST, registration, WORKSPACE, owner));
  const raw = {
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
        exitCode: blocked && check.checkId === OWNER_CHECK_ID ? 1 : 0,
        timedOut: false,
        signal: null,
        report: { kind: "not-required" },
      },
    })),
    ownerVerification,
  };
  const parsed = parseWaveCompletionSuiteResult(raw);
  return parsed.ok
    ? { kind: "observed", result: parsed.value }
    : { kind: "unavailable", reason: `completion result is malformed: ${parsed.error.errors.join("; ")}` };
}

/** What `helper orchestration status` printed, and the typed owner-verification report its `--json` document carries. */
type StatusOutput = Readonly<{ human: string; json: unknown; report: OwnerVerificationStatusReport }>;

/**
 * `helper orchestration status`, human and `--json`, from one graph and one
 * persisted result. The `--json` document's `ownerVerification` is proven
 * equal to the typed `OwnerVerificationStatusReport` that
 * `ownerVerificationStatusOf` derives from the same result, so every
 * assertion below reads the report through its type, never by walking JSON.
 */
function status(currentWaveCompletionResult: WaveCompletionResultObservation): StatusOutput {
  const deps: StatusDeps = {
    loadPlanModels: () => ({ kind: "loaded", models: parsePlanModels(FEES_CLOCK_PLAN_TEXT) }),
    filePresence: () => ({ ok: true, exists: true }),
    currentWaveWorkspace: { kind: "observed", workspaceDigest: WORKSPACE },
    currentWaveCompletionResult,
  };
  const graph = JSON.parse(JSON.stringify(STATUS_GRAPH)) as unknown;
  const json = JSON.parse(renderStatus(graph, deps, true)) as unknown;
  const { report } = ownerVerificationStatusOf(currentWaveCompletionResult);
  expect(json).toHaveProperty("ownerVerification", JSON.parse(JSON.stringify(report)));
  return { human: renderStatus(graph, deps, false), json, report };
}

/** Invariant `id`'s verdict in a verified report. */
function verdictOf(report: OwnerVerificationStatusReport, id: string): InvariantVerdict {
  if (report.kind !== "verified") throw new Error(`status reports owner verification ${report.kind}, not verified`);
  const verdict = report.verdicts.find(({ invariant }) => invariant === id);
  if (verdict === undefined) throw new Error(`status reports no verdict for ${id}`);
  return verdict;
}

/** The human status line the renderer writes for Invariant `id`. */
function humanLine(human: string, id: string): string {
  const line = human.split("\n").find((candidate) => candidate.startsWith(`  - ${id} `));
  expect(line, `human status has no line for ${id}`).toBeDefined();
  return line!;
}

/** The status's next action and its reasons, as one text. */
const nextActionText = (json: unknown): string =>
  JSON.stringify(typeof json === "object" && json !== null ? (json as Record<string, unknown>).next : null);

describe("owner verification in helper orchestration status (CT-2)", () => {
  it("AS-029: FR-028: status --json reports per Invariant the coverage pass and the mutants generated, killed, timed out, invalid, survived and unmutated, or the exemption", () => {
    const mutation = { killed: 5, timedOut: 2, invalid: 1, survivors: [], unmutated: 3 };
    const { report } = status(persistedResult([feesVerdict({ kind: "covered" }, mutation), clockVerdict()], false));

    expect(report).toMatchObject({ kind: "verified", boundMs: 1_500_000 });
    const fees = verdictOf(report, FEES.invariant);
    expect(fees.coverage).toEqual({ kind: "covered" });
    expect(fees.mutation).toEqual({
      kind: "verified", generated: 8, killed: 5, timedOut: 2, invalid: 1, survivors: [], unmutated: 3, ownerChangedInWave: true,
    });

    const clock = verdictOf(report, CLOCK.invariant);
    expect(clock.coverage).toEqual({ kind: "covered" });
    expect(clock.mutation).toEqual({ kind: "exempt", reason: CLOCK_EXEMPTION });
  });

  it("AS-029: FR-028: human status reports the same per-Invariant coverage, mutant counts and exemption as --json, from one projection", () => {
    const mutation = { killed: 5, timedOut: 2, invalid: 1, survivors: [], unmutated: 3 };
    const { human, report } = status(persistedResult([feesVerdict({ kind: "covered" }, mutation), clockVerdict()], false));

    // One projection: the human lines are the renderer's lines over the very report --json carries.
    for (const line of renderOwnerVerificationStatus(report)) expect(human).toContain(line);
    expect(humanLine(human, FEES.invariant)).toContain(
      "coverage pass; mutation generated 8, killed 5, timed out 2, invalid 1, survived 0, unmutated 3");
    expect(humanLine(human, CLOCK.invariant)).toContain(`coverage pass; mutation exempt: ${CLOCK_EXEMPTION}`);
  });

  it("AS-029: FR-028: status reports a missing sibling as the Invariant's coverage result", () => {
    const mutation = { killed: 4, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 };
    const { human, report } = status(persistedResult(
      [feesVerdict(missingSibling, mutation), clockVerdict()],
      true,
    ));

    expect(verdictOf(report, FEES.invariant).coverage).toEqual({ kind: "missing", paths: [MISSING_SIBLING] });
    expect(humanLine(human, FEES.invariant)).toContain(`coverage missing ${MISSING_SIBLING}`);
  });

  it("AS-030: FR-028: a gate blocked by a missing sibling names the Invariant and the remedy in the next action: strengthen the matrix test to import it", () => {
    const mutation = { killed: 4, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 };
    const { human, json } = status(persistedResult(
      [feesVerdict(missingSibling, mutation), clockVerdict()],
      true,
    ));

    const next = nextActionText(json);
    expect(next).toContain(FEES.invariant);
    expect(next).toMatch(/strengthen/i);
    expect(next).toContain(FEES.matrixTest);
    expect(next).toMatch(/import/i);
    expect(next).toContain(MISSING_SIBLING);
    // Human output carries the same next action.
    const humanNext = human.slice(human.indexOf("- nextAction"));
    expect(humanNext).toContain(FEES.invariant);
    expect(humanNext).toContain(MISSING_SIBLING);
  });

  it("AS-030: FR-028: a gate blocked by a surviving mutant names the Invariant and the remedy: kill the survivor in the matrix test, or declare a mutation exemption with a reason", () => {
    const survivor: SurvivorDiagnostic = {
      mutantId: "f".repeat(64),
      operator: "comparison-flip",
      line: 12,
      column: 14,
      original: ">",
      replacement: "<=",
    };
    const mutation = { killed: 5, timedOut: 0, invalid: 0, survivors: [survivor], unmutated: 0 };
    const { human, json, report } = status(persistedResult(
      [feesVerdict({ kind: "covered" }, mutation), clockVerdict()],
      true,
    ));

    expect(verdictOf(report, FEES.invariant).mutation).toMatchObject({ kind: "verified", survivors: [survivor] });
    const next = nextActionText(json);
    expect(next).toContain(FEES.invariant);
    expect(next).toMatch(/strengthen/i);
    expect(next).toContain(FEES.matrixTest);
    expect(next).toContain(`${FEES.owner}:${survivor.line}`);
    expect(next).toContain(survivor.operator);
    expect(next).toMatch(/mutation exemption/i);
    expect(next).toMatch(/reason/i);
    const humanNext = human.slice(human.indexOf("- nextAction"));
    expect(humanNext).toContain(FEES.invariant);
    expect(humanNext).toContain(`${FEES.owner}:${survivor.line}`);
  });
});
