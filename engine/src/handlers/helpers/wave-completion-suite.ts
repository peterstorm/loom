import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson, type JsonValue } from "../../core/review-packet";
import { parsePlanModels } from "../../core/parse-plan-models";
import { match } from "ts-pattern";
import { ownerScopeOf, ownerVerificationOwed, type OwnerScope } from "../../core/owner-verification/obligations";
import { planModelsIntegrityFailure } from "../../core/owner-verification/plan-integrity";
import { authorizeGraphCompletionSuite } from "../../core/owner-verification/suite-authority";
import { renderOwnerVerificationFailure } from "../../core/owner-verification/verdict";
import type { OwnerInfrastructureFailure, OwnerVerificationObservation } from "../../core/owner-verification/types";
import {
  runOwnerVerification as productionRunOwnerVerification,
  type OwnerVerificationInput,
} from "../../orchestration/owner-verification-runner";
import {
  acceptanceObservation,
  frozenPathDrift,
  graphAcceptanceExpectation,
  frozenPathsToObserve,
  observeAcceptanceFacts,
  owesAcceptance,
  renderAcceptanceFailure,
  renderFrozenPathDrift,
  stampAcceptanceFreezes,
  unprojectableFacts,
  type AcceptanceContract,
  type AcceptanceExpectation,
  type AcceptanceObservation,
} from "../../core/acceptance-contract";
import { parseJunitTestcases } from "../../core/structured-test-report";
import { sha256Bytes } from "../../core/digest";
import type { ArtifactDigest, DomainResult } from "../../core/orchestration-contract";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { observeFrozenDigests } from "../../orchestration/frozen-path-observation";
import {
  FULL_TIER_LINT_CHECK_ID_TEXT,
  boundedFailureMessage,
  evaluateWaveCompletionSuite,
  ownerCheckOf,
  ownerVerificationExitCode,
  parseAcceptedWaveCompletionReceipt,
  parseCompletionCheckId,
  parseWaveCompletionSuiteResult,
  rejectionDisposition,
  type AcceptedWaveCompletionReceipt,
  type AuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionSuite,
  type CompletionCheckId,
  type CompletionCheckResult,
  type OwnerVerificationCheck,
  type RejectedCompletionSuite,
  type WaveCompletionSuiteResult,
} from "../../core/completion-suite";
import type { FrozenVerificationManifest } from "../../core/verification-manifest";
import { canonicalStructuralEquals } from "../../core/orchestration-contract";
import {
  runCompletionCheck as productionRunCompletionCheck,
  type CompletionCheckRunnerResult,
} from "../../orchestration/completion-check-runner";
import type { RunDirHandle } from "../../orchestration/run-directory-handle";
import type { StateManager } from "../../state-manager";
import type {
  HookResult,
  TaskGraph,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../../types";
import {
  observeWorkspaceDigest,
  resolveCanonicalGitRepositoryRoot,
  type CanonicalRepositoryRoot,
  type WorkspaceDigestFailure,
} from "../../utils/workspace-digest";
import { describeCause } from "../../utils/describe-cause";
import { runFullTierWaveLint } from "./lint-wave-gate";

export type WaveCompletionSuiteFailureCategory =
  | "authority"
  | "infrastructure"
  | "semantic"
  | "workspace"
  | "artifact"
  | "state";

export type WaveCompletionSuiteDiagnostic = Readonly<{
  kind: "wave-completion-suite-blocked";
  categories: readonly WaveCompletionSuiteFailureCategory[];
  checkIds: readonly CompletionCheckId[];
  message: string;
}>;

export type EnsureWaveCompletionSuiteResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        kind: "legacy" | "accepted";
        disposition: "not-required" | "reused" | "installed";
        currentWaveWorkspace: WaveWorkspaceObservation;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        diagnostic: WaveCompletionSuiteDiagnostic;
        currentWaveWorkspace: WaveWorkspaceObservation;
      }>;
    }>;

type WaveCompletionRegistration = Readonly<{
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
}>;

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

/** Narrow process I/O port used by the Wave completion shell. */
export type RunCompletionCheck = (
  check: ProjectCommandCheck,
  repositoryRoot: CanonicalRepositoryRoot,
) => Promise<CompletionCheckRunnerResult>;

/** Narrow owner-verification port: the production runner, or a test's fake. */
export type RunOwnerVerification = (input: OwnerVerificationInput) => Promise<OwnerVerificationObservation>;

export type EnsureWaveCompletionSuiteInput = Readonly<{
  handle: RunDirHandle;
  manager: StateManager;
  graph: TaskGraph;
  registration: WaveCompletionRegistration;
  runCompletionCheck?: RunCompletionCheck;
  runOwnerVerification?: RunOwnerVerification;
}>;

type ObservedWorkspace = Extract<WaveWorkspaceObservation, { readonly kind: "observed" }>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

function workspaceFailureMessage(error: WorkspaceDigestFailure): string {
  switch (error.kind) {
    case "workspace-list-drift":
      return `workspace path roster drifted from [${error.before.join(", ")}] to [${error.after.join(", ")}]`;
    case "workspace-file-drift":
      return `workspace path ${error.path} drifted while it was observed`;
    case "workspace-read-failed":
      return `workspace path ${error.path} could not be read: ${error.message}`;
    case "git-command-failed":
      return `Git ${error.operation} failed: ${error.message}`;
    case "invalid-git-output":
      return `Git ${error.operation} returned invalid output: ${error.message}`;
    default:
      return error.message;
  }
}

function completionReportPaths(graph: TaskGraph): readonly string[] {
  return freezeArray(graph.verification_manifest?.projectChecks.flatMap((check) =>
    check.reportPolicy.kind === "required-file" ? [check.reportPolicy.path] : []) ?? []);
}

/** Observe the current Git-visible workspace from caller-supplied repository authority. */
export function observeCurrentWaveWorkspace(
  graph: TaskGraph,
  authorityStartPath: string,
): WaveWorkspaceObservation {
  const observed = observeWorkspaceDigest(authorityStartPath, {
    completionReportPaths: completionReportPaths(graph),
  });
  return observed.ok
    ? freeze({ kind: "observed", workspaceDigest: observed.value.digest })
    : freeze({ kind: "unavailable", reason: workspaceFailureMessage(observed.error) });
}

type ParsedPersistedCompletionResult = Extract<
  WaveCompletionResultObservation,
  { readonly kind: "observed" | "unavailable" }
>;

function parsePersistedCompletionResultBytes(
  bytes: Uint8Array,
  subject: string,
): ParsedPersistedCompletionResult {
  let raw: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(json) as unknown;
  } catch (cause) {
    return freeze({
      kind: "unavailable",
      reason: `${subject} is not valid UTF-8 JSON: ${describeCause(cause)}`,
    });
  }
  const parsed = parseWaveCompletionSuiteResult(raw);
  return parsed.ok
    ? freeze({ kind: "observed", result: parsed.value })
    : freeze({
        kind: "unavailable",
        reason: `${subject} is malformed: ${parsed.error.errors.join("; ")}`,
      });
}

/** Read, but never execute, the exact persisted result selected by current
 * protected registration, manifest, and already-observed workspace authority. */
export function observeCurrentWaveCompletionResult(
  handle: RunDirHandle,
  graph: TaskGraph,
  workspace: WaveWorkspaceObservation,
): WaveCompletionResultObservation {
  const active = graph.active_wave_gate;
  const manifest = graph.verification_manifest;
  if (active === undefined || active.terminalOutcome !== null || manifest === undefined) {
    return freeze({
      kind: "unavailable",
      reason: "current persisted completion result requires modern nonterminal active Wave authority",
    });
  }
  if (handle.runId !== active.runId) {
    return freeze({
      kind: "unavailable",
      reason: `Run Directory ${handle.runId} does not match active Wave Gate run ${active.runId}`,
    });
  }
  if (workspace.kind === "unavailable") {
    return freeze({
      kind: "unavailable",
      reason: `current workspace authority is unavailable: ${workspace.reason}`,
    });
  }
  const authorized = authorizeGraphCompletionSuite(graph, workspace.workspaceDigest);
  if (!authorized.ok) {
    return freeze({ kind: "unavailable", reason: authorized.error.errors.join("; ") });
  }
  const relativePath = completionResultArtifactPath(authorized.value);
  const persisted = handle.readArtifactBytes(relativePath);
  if (!persisted.ok) {
    return freeze({
      kind: "unavailable",
      reason: `completion result artifact ${relativePath} is unreadable: ${persisted.error.message}`,
    });
  }
  return persisted.value === null
    ? freeze({ kind: "absent" })
    : parsePersistedCompletionResultBytes(
        persisted.value,
        `completion result artifact ${relativePath}`,
      );
}

function diagnostic(
  categories: readonly WaveCompletionSuiteFailureCategory[],
  checkIds: readonly CompletionCheckId[],
  message: string,
): WaveCompletionSuiteDiagnostic {
  return freeze({
    kind: "wave-completion-suite-blocked",
    categories: freezeArray([...new Set(categories)]),
    checkIds: freezeArray([...new Set(checkIds)]),
    message,
  });
}

function blocked(
  currentWaveWorkspace: WaveWorkspaceObservation,
  categories: readonly WaveCompletionSuiteFailureCategory[],
  checkIds: readonly CompletionCheckId[],
  message: string,
): EnsureWaveCompletionSuiteResult {
  return freeze({
    ok: false,
    error: freeze({
      diagnostic: diagnostic(categories, checkIds, message),
      currentWaveWorkspace,
    }),
  });
}

function accepted(
  disposition: "reused" | "installed",
  currentWaveWorkspace: WaveWorkspaceObservation,
): EnsureWaveCompletionSuiteResult {
  return freeze({
    ok: true,
    value: freeze({ kind: "accepted", disposition, currentWaveWorkspace }),
  });
}

function lintCheckId(): CompletionCheckId {
  const parsed = parseCompletionCheckId(FULL_TIER_LINT_CHECK_ID_TEXT);
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

/** An engine-reserved check's observed result: its exit code, and no report. */
function observedEngineCheckResult(
  checkId: CompletionCheckId,
  exitCode: 0 | 1,
): CompletionCheckResult {
  return freeze({
    checkId,
    scope: "wave",
    outcome: freeze({
      kind: "observed",
      exitCode,
      timedOut: false,
      signal: null,
      report: freeze({ kind: "not-required" }),
    }),
  });
}

/** The lint check's stored result, and the refusal it produced. The result
 *  keeps only the exit code; the refusal reaches the operator's diagnostic. */
type ObservedLint = Readonly<{ result: CompletionCheckResult; refusal: string | null }>;

function observedLintResult(
  graph: TaskGraph,
  wave: number,
  repositoryRoot: string,
): ObservedLint {
  const checkId = lintCheckId();
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  const previousCwd = process.cwd();
  const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
  let lint: ReturnType<typeof runFullTierWaveLint>;
  try {
    process.chdir(repositoryRoot);
    process.env.CLAUDE_PROJECT_DIR = repositoryRoot;
    lint = runFullTierWaveLint(waveTasks);
  } finally {
    process.chdir(previousCwd);
    if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
  }
  return freeze({ result: lintCheckResult(checkId, lint), refusal: lint.kind === "block" ? lint.message : null });
}

/** How the lint refusal reads when the gate has no fresh refusal to show (a replayed result). */
const LINT_REFUSAL_UNAVAILABLE =
  "the stored completion result keeps only the lint's exit code; run `helper lint-wave-gate` for the refusal";

/**
 * A rejection that failed the full-tier lint, with the lint's refusal attached
 * (bounded like any stored failure) — or, for a replayed result, the command
 * that reproduces it. Every other rejection is returned unchanged. Pure.
 */
export function withLintRefusal(
  rejection: WaveCompletionSuiteDiagnostic,
  refusal: string | null,
): WaveCompletionSuiteDiagnostic {
  if (!rejection.checkIds.some((checkId) => checkId === lintCheckId())) return rejection;
  const detail = refusal === null ? LINT_REFUSAL_UNAVAILABLE : boundedFailureMessage(refusal, NO_LINT_RESULT);
  return diagnostic(rejection.categories, rejection.checkIds, `${rejection.message}\n${FULL_TIER_LINT_CHECK_ID_TEXT}: ${detail}`);
}

const NO_LINT_RESULT = "full-tier lint returned no terminal result";

/**
 * The full-tier lint's verdict as the reserved check's result: allow is exit
 * 0, a rule block is exit 1, and anything else (a lint engine error, a result
 * with no verdict) is a spawn failure whose message is bounded to what a
 * completion result may store, so the suite result still parses and the gate
 * reports the lint failure rather than a parser refusal. Pure.
 */
export function lintCheckResult(checkId: CompletionCheckId, lint: HookResult): CompletionCheckResult {
  if (lint.kind === "allow") return observedEngineCheckResult(checkId, 0);
  const message = "message" in lint ? lint.message : NO_LINT_RESULT;
  if (lint.kind === "block" && !message.includes("LINT ENGINE ERROR")) return observedEngineCheckResult(checkId, 1);
  return freeze({
    checkId,
    scope: "wave",
    outcome: freeze({ kind: "spawn-failed", message: boundedFailureMessage(message, NO_LINT_RESULT) }),
  });
}

// ---------------------------------------------------------------------------
// The owner-verification check (G5b AD-1, AD-2)
// ---------------------------------------------------------------------------

/** The owner check's stored result and the observation its exit code reflects. */
type ObservedOwnerCheck = Readonly<{ result: CompletionCheckResult; observation: OwnerVerificationObservation }>;

const ownerUnavailable = (failure: OwnerInfrastructureFailure): OwnerVerificationObservation =>
  freeze({ kind: "unavailable", failure: freeze(failure) });

/** Re-read the plan the graph names and prove it still derives the stamp (FR-002); null when it does. */
function planIntegrityFailure(
  graph: TaskGraph,
  scope: OwnerScope,
  repositoryRoot: CanonicalRepositoryRoot,
): OwnerInfrastructureFailure | null {
  const planFile = graph.plan_file;
  if (typeof planFile !== "string" || planFile.trim().length === 0) {
    return { kind: "plan-unreadable", detail: "the TaskGraph carries owner_obligations but names no plan_file to re-read them from" };
  }
  const planPath = isAbsolute(planFile) ? planFile : join(repositoryRoot, planFile);
  let text: string;
  try {
    text = readFileSync(planPath, "utf-8");
  } catch (cause) {
    return { kind: "plan-unreadable", detail: `plan ${planPath} cannot be read: ${describeCause(cause)}` };
  }
  return planModelsIntegrityFailure(planPath, parsePlanModels(text), scope);
}

/** The real workspace's digest, as the owner run observes it before and after it runs. */
const workspaceDigestOf = (graph: TaskGraph, repositoryRoot: CanonicalRepositoryRoot) =>
  (): DomainResult<ArtifactDigest, string> => {
    const observed = observeCurrentWaveWorkspace(graph, repositoryRoot);
    return observed.kind === "observed"
      ? freeze({ ok: true as const, value: observed.workspaceDigest })
      : freeze({ ok: false as const, error: observed.reason });
  };

/**
 * The owner check's observation. Whenever the check is authorized (the graph
 * carries the stamp, an empty one included) the plan is re-read first; a
 * Wave owing nothing then records `verified []`, and otherwise the owner run
 * decides. The production run never throws (`runOwnerVerification` guards
 * itself); this shell still keeps a last-resort catch for the injected port,
 * turning a throw into the `unexpected-error` infrastructure failure that
 * blocks and never counts as a kill. The workspace check is not skipped on
 * that path: `runSuiteChecks` compares the workspace digest after every
 * check, the owner check included, whatever this observation is.
 */
async function ownerVerificationObservation(
  context: SuiteContext,
  check: OwnerVerificationCheck,
  wave: number,
  manifest: FrozenVerificationManifest,
): Promise<OwnerVerificationObservation> {
  const { graph, repositoryRoot } = context;
  const scope = ownerScopeOf(graph);
  const integrity = planIntegrityFailure(graph, scope, repositoryRoot);
  if (integrity !== null) return ownerUnavailable(integrity);
  const [first, ...rest] = ownerVerificationOwed(scope, wave);
  if (first === undefined) {
    return freeze({ kind: "verified", obligationsDigest: check.obligationsDigest, boundMs: 0, verdicts: freezeArray([]) });
  }
  try {
    return await context.runOwnerVerification({
      root: repositoryRoot,
      graph,
      wave,
      authority: check,
      owed: [first, ...rest],
      manifest,
      observeWorkspace: workspaceDigestOf(graph, repositoryRoot),
    });
  } catch (cause) {
    return ownerUnavailable({ kind: "unexpected-error", detail: `owner verification threw before it decided: ${describeCause(cause)}` });
  }
}

/** The owner check's result when the suite authorizes it; null otherwise. */
async function observeOwnerCheck(
  context: SuiteContext,
  authorized: AuthorizedWaveCompletionSuite,
  wave: number,
  manifest: FrozenVerificationManifest,
): Promise<ObservedOwnerCheck | null> {
  const check = ownerCheckOf(authorized);
  if (check === undefined) return null;
  const observation = await ownerVerificationObservation(context, check, wave, manifest);
  return freeze({ result: observedEngineCheckResult(check.checkId, ownerVerificationExitCode(observation)), observation });
}

type CompletionRepositoryAuthority =
  | Readonly<{ ok: true; repositoryRoot: CanonicalRepositoryRoot }>
  | Readonly<{ ok: false; category: "authority" | "workspace"; reason: string }>;

function completionRepositoryAuthority(
  handle: RunDirHandle,
  manager: StateManager,
): CompletionRepositoryAuthority {
  const runRepository = resolveCanonicalGitRepositoryRoot(handle.runDirectory);
  if (!runRepository.ok) {
    return freeze({
      ok: false,
      category: "workspace",
      reason: `Run Directory repository authority is unavailable: ${workspaceFailureMessage(runRepository.error)}`,
    });
  }
  const stateRepository = resolveCanonicalGitRepositoryRoot(dirname(resolve(manager.getPath())));
  if (!stateRepository.ok) {
    return freeze({
      ok: false,
      category: "authority",
      reason: `protected TaskGraph repository authority is unavailable: ${workspaceFailureMessage(stateRepository.error)}`,
    });
  }
  if (stateRepository.value !== runRepository.value) {
    return freeze({
      ok: false,
      category: "authority",
      reason: `Run Directory repository ${runRepository.value} differs from protected TaskGraph repository ${stateRepository.value}`,
    });
  }
  return freeze({ ok: true, repositoryRoot: runRepository.value });
}

function exactActiveAuthorityProblem(
  graph: TaskGraph,
  handle: RunDirHandle,
  registration: WaveCompletionRegistration,
): string | null {
  const active = graph.active_wave_gate;
  if (registration.input.wave === null || active === undefined || active.terminalOutcome !== null) {
    return "completion suite requires one exact nonterminal active Wave Gate registration";
  }
  if (handle.runId !== active.runId || registration.input.wave !== active.wave ||
      registration.authorityDigest !== active.authorityDigest) {
    return "completion suite run/Wave/authority differs from protected active Wave Gate authority";
  }
  const registeredIds = registration.taskIds;
  const currentIds = graph.tasks.filter((task) => task.wave === active.wave).map((task) => task.id);
  return registeredIds.length === currentIds.length && registeredIds.every((id, index) => id === currentIds[index])
    ? null
    : "completion suite registered Task roster differs from the protected current-Wave roster";
}

/**
 * The acceptance facts of every project check that produced its report, read
 * back and bound to the digest the runner recorded — a report that changed
 * after the check is unprojectable, never re-read as a different run. Absent
 * when the gate owes no contract anything.
 */
function observeAcceptance(
  root: CanonicalRepositoryRoot,
  expectation: AcceptanceExpectation,
  checks: readonly CompletionCheckResult[],
): AcceptanceObservation | undefined {
  if (!owesAcceptance(expectation)) return undefined;
  const facts = checks.flatMap((check) => {
    if (check.outcome.kind !== "observed" || check.outcome.report.kind !== "produced") return [];
    const report = check.outcome.report;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(readRunBytesNoFollow(join(root, report.path)));
    } catch (cause) {
      return [unprojectableFacts(check.checkId, report.digest,
        `report ${report.path} could not be read back: ${describeCause(cause)}`)];
    }
    if (sha256Bytes(bytes) !== report.digest) {
      return [unprojectableFacts(check.checkId, report.digest, `report ${report.path} changed after the check produced it`)];
    }
    return [observeAcceptanceFacts(expectation, check.checkId, report.digest, parseJunitTestcases(bytes))];
  });
  return acceptanceObservation(expectation, facts);
}

/** The graph's contracts with what an accepted receipt observed stamped in:
 *  the contract Wave's Acceptance Freeze, or a revised roster re-recorded. */
function stampedContracts(
  graph: TaskGraph,
  receipt: AcceptedWaveCompletionReceipt,
  root: CanonicalRepositoryRoot,
): DomainResult<readonly AcceptanceContract[] | undefined, string> {
  const contracts = graph.acceptance_contracts;
  if (contracts === undefined || receipt.acceptance === undefined) return freeze({ ok: true as const, value: contracts });
  return stampAcceptanceFreezes(
    contracts,
    receipt.acceptance.expectation,
    receipt.acceptance.facts,
    observeFrozenDigests(root, frozenPathsToObserve(contracts)),
  );
}

function reusableReceipt(
  graph: TaskGraph,
  workspace: Extract<WaveWorkspaceObservation, { readonly kind: "observed" }>,
  expectation: AcceptanceExpectation,
): AcceptedWaveCompletionReceipt | null {
  const active = graph.active_wave_gate;
  const manifest = graph.verification_manifest;
  const rawReceipt = graph.active_wave_completion_suite;
  if (active === undefined || manifest === undefined || rawReceipt === undefined) return null;
  const receipt = parseAcceptedWaveCompletionReceipt(rawReceipt);
  if (!receipt.ok) return null;
  const authority = authorizeGraphCompletionSuite(graph, workspace.workspaceDigest);
  if (!authority.ok) return null;
  const { kind: _acceptedKind, resultDigest: _resultDigest, ...resultAuthority } = receipt.value;
  const evaluation = evaluateWaveCompletionSuite(authority.value, {
    kind: "wave-completion-suite-result",
    ...resultAuthority,
  }, expectation);
  return evaluation.kind === "accepted" ? receipt.value : null;
}

function withoutActiveReceipt(graph: TaskGraph): TaskGraph {
  const { active_wave_completion_suite: _stale, ...withoutReceipt } = graph;
  return withoutReceipt;
}

async function clearStaleReceipt(
  manager: StateManager,
  graph: TaskGraph,
): Promise<void> {
  const expectedActive = graph.active_wave_gate;
  const expectedManifest = graph.verification_manifest;
  const expectedReceipt = graph.active_wave_completion_suite;
  await manager.update((locked) => {
    if (!canonicalStructuralEquals(locked.active_wave_gate, expectedActive) ||
        !canonicalStructuralEquals(locked.verification_manifest, expectedManifest)) {
      throw new Error("protected Wave registration or verification manifest changed before stale receipt clearing");
    }
    if (locked.active_wave_completion_suite === undefined) return locked;
    if (!canonicalStructuralEquals(locked.active_wave_completion_suite, expectedReceipt)) {
      throw new Error("a concurrent completion receipt replaced the stale receipt before clearing");
    }
    return withoutActiveReceipt(locked);
  });
}

async function executeProjectChecks(
  checks: readonly ProjectCommandCheck[],
  repositoryRoot: CanonicalRepositoryRoot,
  runCompletionCheck: RunCompletionCheck,
): Promise<Readonly<{ ok: true; results: readonly CompletionCheckResult[] }> |
  Readonly<{ ok: false; checkId: CompletionCheckId; message: string }>> {
  const results: CompletionCheckResult[] = [];
  for (const check of checks) {
    const execution = await runCompletionCheck(check, repositoryRoot);
    if (!execution.ok) {
      return {
        ok: false,
        checkId: check.checkId,
        message: `${execution.error.kind}: ${execution.error.message}`,
      };
    }
    results.push(execution.value.checkResult);
  }
  return { ok: true, results: freezeArray(results) };
}

type ReplayedCompletionResult =
  | Readonly<{ kind: "accepted"; receipt: AcceptedWaveCompletionReceipt }>
  | Readonly<{ kind: "semantic-rejected"; diagnostic: WaveCompletionSuiteDiagnostic }>
  | Readonly<{ kind: "artifact-conflict"; checkIds: readonly CompletionCheckId[]; message: string }>;

function evaluationDiagnostic(evaluation: RejectedCompletionSuite): WaveCompletionSuiteDiagnostic {
  const categories: WaveCompletionSuiteFailureCategory[] = [];
  if (evaluation.authorityFailures.length > 0) categories.push("authority");
  if (evaluation.infrastructureFailures.length > 0) categories.push("infrastructure");
  if (evaluation.semanticFailures.length > 0) categories.push("semantic");
  const checkIds = [
    ...evaluation.infrastructureFailures.map((failure) => failure.checkId),
    ...evaluation.semanticFailures.map((failure) => failure.checkId),
    ...evaluation.authorityFailures.flatMap((failure) => {
      switch (failure.kind) {
        case "missing-check-results":
        case "surplus-check-results":
        case "duplicate-check-results":
          return failure.checkIds;
        case "wrong-check-scope":
        case "report-policy-mismatch":
        case "owner-verification-mismatch":
          return [failure.checkId];
        default:
          return [];
      }
    }),
  ];
  const failureKinds = [
    ...evaluation.authorityFailures.map((failure) => failure.kind),
    ...evaluation.infrastructureFailures.map((failure) => failure.kind),
    ...evaluation.semanticFailures.map((failure) => failure.kind),
  ];
  const acceptance = evaluation.semanticFailures.flatMap((failure) =>
    failure.kind === "acceptance-rejected" ? failure.failures.map(renderAcceptanceFailure) : []);
  const mismatches = evaluation.authorityFailures.flatMap((failure) =>
    failure.kind === "owner-verification-mismatch" ? [`${failure.checkId}: ${failure.reason}`] : []);
  return diagnostic(
    categories,
    checkIds,
    `Wave completion suite rejected: ${failureKinds.join(", ")}` +
      detailLines([...acceptance, ...mismatches, ...ownerFindingLines(evaluation)]),
  );
}

/** The owner check's findings, one diagnostic line each: the Invariant, its evidence and the remedy. */
function ownerFindingLines(evaluation: RejectedCompletionSuite): readonly string[] {
  return [...evaluation.infrastructureFailures, ...evaluation.semanticFailures].flatMap((failure) =>
    failure.kind === "owner-verification-infrastructure" || failure.kind === "owner-verification-rejected"
      ? failure.failures.map(renderOwnerVerificationFailure)
      : []);
}

const detailLines = (lines: readonly string[]): string =>
  lines.length === 0 ? "" : `\n${lines.map((line) => `  - ${line}`).join("\n")}`;

function infrastructureEvaluationDiagnostic(evaluation: RejectedCompletionSuite): WaveCompletionSuiteDiagnostic {
  return diagnostic(
    ["infrastructure"],
    evaluation.infrastructureFailures.map((failure) => failure.checkId),
    `Wave completion suite infrastructure failure: ${evaluation.infrastructureFailures
      .map((failure) => failure.kind)
      .join(", ")}` + detailLines(ownerFindingLines(evaluation)),
  );
}

function completionResultArtifactPath(authority: AuthorizedWaveCompletionSuite): string {
  return `completion-suites/${authority.suiteDigest}/${authority.workspaceDigest}.json`;
}

/**
 * Where a result whose owner check could not decide is recorded: beside the
 * result slot, named by its own bytes, so the slot stays free for a retry and
 * an identical repeated failure re-publishes the identical record.
 */
function ownerAttemptArtifactPath(authority: AuthorizedWaveCompletionSuite, bytes: readonly number[]): string {
  return `completion-suites/${authority.suiteDigest}/${authority.workspaceDigest}.owner-infrastructure/${sha256Bytes(Uint8Array.from(bytes))}.json`;
}

function replayCompletionResult(
  bytes: Uint8Array,
  authority: AuthorizedWaveCompletionSuite,
  expectation: AcceptanceExpectation,
): ReplayedCompletionResult {
  const parsed = parsePersistedCompletionResultBytes(bytes, "persisted completion result");
  if (parsed.kind === "unavailable") {
    return freeze({
      kind: "artifact-conflict",
      checkIds: freezeArray([]),
      message: parsed.reason,
    });
  }
  const evaluation = evaluateWaveCompletionSuite(authority, parsed.result, expectation);
  if (evaluation.kind === "accepted") {
    return freeze({ kind: "accepted", receipt: evaluation.receipt });
  }
  const rejectedDiagnostic = evaluationDiagnostic(evaluation);
  const conflict = (): ReplayedCompletionResult => freeze({
    kind: "artifact-conflict",
    checkIds: rejectedDiagnostic.checkIds,
    message: `persisted completion result conflicts with current authority: ${rejectedDiagnostic.message}`,
  });
  // The slot holds only terminal results: an owner-undecided one was never published there.
  return match(rejectionDisposition(evaluation))
    .with({ kind: "semantic" }, (): ReplayedCompletionResult => freeze({ kind: "semantic-rejected", diagnostic: rejectedDiagnostic }))
    .with({ kind: "authority" }, { kind: "infrastructure" }, { kind: "owner-undecided" }, conflict)
    .with({ kind: "inexact" }, (): ReplayedCompletionResult => freeze({
      kind: "artifact-conflict",
      checkIds: freezeArray([]),
      message: "persisted completion result has no exact terminal evaluation",
    }))
    .exhaustive();
}

function canonicalResultBytes(result: WaveCompletionSuiteResult): readonly number[] {
  const json = JSON.parse(JSON.stringify(result)) as JsonValue;
  return freezeArray([...new TextEncoder().encode(canonicalJson(json))]);
}

/** Install the receipt and, in the same locked write, the Acceptance Freeze it
 *  observed: the frozen bytes are exactly the bytes the receipt judged. */
async function installAcceptedReceipt(
  manager: StateManager,
  graph: TaskGraph,
  receipt: AcceptedWaveCompletionReceipt,
  contracts: readonly AcceptanceContract[] | undefined,
): Promise<void> {
  const expectedActive = graph.active_wave_gate;
  const expectedManifest = graph.verification_manifest;
  const expectedContracts = graph.acceptance_contracts;
  await manager.update((locked) => {
    if (!canonicalStructuralEquals(locked.active_wave_gate, expectedActive) ||
        !canonicalStructuralEquals(locked.verification_manifest, expectedManifest)) {
      throw new Error("protected Wave registration or verification manifest changed before receipt installation");
    }
    if (!canonicalStructuralEquals(locked.acceptance_contracts, expectedContracts)) {
      throw new Error("protected acceptance contracts changed before receipt installation");
    }
    if (locked.active_wave_completion_suite !== undefined) {
      if (canonicalStructuralEquals(locked.active_wave_completion_suite, receipt)) return locked;
      throw new Error("a conflicting completion receipt already occupies the active Wave authority");
    }
    return {
      ...locked,
      active_wave_completion_suite: receipt,
      ...(contracts === undefined ? {} : { acceptance_contracts: contracts }),
    };
  });
}

async function installAcceptedReceiptAndVerifyWorkspace(
  manager: StateManager,
  graph: TaskGraph,
  receipt: AcceptedWaveCompletionReceipt,
  repositoryRoot: CanonicalRepositoryRoot,
  currentWorkspace: Extract<WaveWorkspaceObservation, { readonly kind: "observed" }>,
): Promise<EnsureWaveCompletionSuiteResult> {
  const contracts = stampedContracts(graph, receipt, repositoryRoot);
  if (!contracts.ok) return blocked(currentWorkspace, ["state"], [], `Acceptance Freeze refused: ${contracts.error}`);
  try {
    await installAcceptedReceipt(manager, graph, receipt, contracts.value);
  } catch (cause) {
    return blocked(currentWorkspace, ["state"], [], describeCause(cause));
  }

  const installedWorkspace = observeCurrentWaveWorkspace(graph, repositoryRoot);
  if (installedWorkspace.kind === "unavailable") {
    return blocked(
      installedWorkspace,
      ["workspace"],
      [],
      `accepted receipt installed but current Wave workspace is unavailable: ${installedWorkspace.reason}`,
    );
  }
  if (installedWorkspace.workspaceDigest !== receipt.workspaceDigest) {
    return blocked(
      installedWorkspace,
      ["workspace"],
      [],
      `accepted receipt became stale after installation: ${receipt.workspaceDigest} -> ${installedWorkspace.workspaceDigest}`,
    );
  }
  return accepted("installed", installedWorkspace);
}

/** Everything one suite execution reads, fixed once the active authority is proven. */
type SuiteContext = Readonly<{
  handle: RunDirHandle;
  manager: StateManager;
  graph: TaskGraph;
  repositoryRoot: CanonicalRepositoryRoot;
  before: ObservedWorkspace;
  expectation: AcceptanceExpectation;
  runCompletionCheck: RunCompletionCheck;
  runOwnerVerification: RunOwnerVerification;
}>;

/**
 * Observe, execute, evaluate, publish, and install one modern Wave completion suite.
 * The interface is deliberately deep: callers receive only current workspace
 * authority plus an accepted/rejected disposition, never subprocess details.
 */
export async function ensureWaveCompletionSuite(
  input: EnsureWaveCompletionSuiteInput,
): Promise<EnsureWaveCompletionSuiteResult> {
  const { handle, manager, registration } = input;
  let graph = input.graph;
  if (graph.verification_manifest === undefined) {
    const currentWaveWorkspace = observeCurrentWaveWorkspace(graph, handle.runDirectory);
    return freeze({ ok: true, value: freeze({ kind: "legacy", disposition: "not-required", currentWaveWorkspace }) });
  }

  const repository = completionRepositoryAuthority(handle, manager);
  if (!repository.ok) {
    const unavailable = freeze({ kind: "unavailable" as const, reason: repository.reason });
    return blocked(unavailable, [repository.category], [], repository.reason);
  }
  const repositoryRoot = repository.repositoryRoot;
  const activeProblem = exactActiveAuthorityProblem(graph, handle, registration);
  if (activeProblem !== null) {
    const current = observeCurrentWaveWorkspace(graph, repositoryRoot);
    return blocked(current, ["authority"], [], activeProblem);
  }

  const before = observeCurrentWaveWorkspace(graph, repositoryRoot);
  if (before.kind === "unavailable") {
    return blocked(before, ["workspace"], [], `current Wave workspace unavailable: ${before.reason}`);
  }
  // `exactActiveAuthorityProblem` proved the registration names this Wave.
  const contracts = graph.acceptance_contracts ?? [];
  const expectation = graphAcceptanceExpectation(graph, registration.input.wave!);
  const drift = frozenPathDrift(contracts, observeFrozenDigests(repositoryRoot, frozenPathsToObserve(contracts)));
  if (drift.length > 0) return blocked(before, ["artifact"], [], renderFrozenPathDrift(drift));
  if (reusableReceipt(graph, before, expectation) !== null) return accepted("reused", before);

  if (graph.active_wave_completion_suite !== undefined) {
    try {
      await clearStaleReceipt(manager, graph);
      graph = manager.load();
    } catch (cause) {
      return blocked(before, ["state"], [], describeCause(cause));
    }
  }

  return runAuthorizedSuite({
    handle, manager, graph, repositoryRoot, before, expectation,
    runCompletionCheck: input.runCompletionCheck ?? productionRunCompletionCheck,
    runOwnerVerification: input.runOwnerVerification ?? productionRunOwnerVerification,
  });
}

/** Authorize the Wave's suite, then replay its persisted result or execute it afresh. */
async function runAuthorizedSuite(context: SuiteContext): Promise<EnsureWaveCompletionSuiteResult> {
  const { handle, manager, graph, repositoryRoot, before, expectation } = context;
  const active = graph.active_wave_gate;
  const manifest = graph.verification_manifest;
  if (active === undefined || manifest === undefined) {
    return blocked(before, ["authority"], [], "modern completion authority disappeared before suite execution");
  }
  const authorized = authorizeGraphCompletionSuite(graph, before.workspaceDigest);
  if (!authorized.ok) {
    return blocked(before, ["authority"], [], authorized.error.errors.join("; "));
  }
  const relativePath = completionResultArtifactPath(authorized.value);
  const persistedBytes = handle.readArtifactBytes(relativePath);
  if (!persistedBytes.ok) {
    return blocked(
      before,
      ["artifact"],
      [],
      `completion result artifact ${relativePath} is occupied but unreadable: ${persistedBytes.error.message}`,
    );
  }
  if (persistedBytes.value === null) return executeSuite(context, authorized.value, active.wave, manifest);
  const replayed = replayCompletionResult(persistedBytes.value, authorized.value, expectation);
  if (replayed.kind === "accepted") {
    return installAcceptedReceiptAndVerifyWorkspace(manager, graph, replayed.receipt, repositoryRoot, before);
  }
  if (replayed.kind === "semantic-rejected") {
    const rejection = withLintRefusal(replayed.diagnostic, null);
    return blocked(before, rejection.categories, rejection.checkIds, rejection.message);
  }
  return blocked(before, ["artifact"], replayed.checkIds, `${relativePath}: ${replayed.message}`);
}

/** The suite's checks, run outside the protected-state lock, and the result they observed. */
type ExecutedSuite = Readonly<{ result: WaveCompletionSuiteResult; lintRefusal: string | null }>;

/**
 * Run every authorized check against an unchanged workspace: the reserved
 * lint, the project checks, and the owner check when the suite authorizes it.
 */
async function runSuiteChecks(
  context: SuiteContext,
  authorized: AuthorizedWaveCompletionSuite,
  wave: number,
  manifest: FrozenVerificationManifest,
): Promise<DomainResult<ExecutedSuite, EnsureWaveCompletionSuiteResult>> {
  const { graph, repositoryRoot, before, expectation } = context;
  const lint = observedLintResult(graph, wave, repositoryRoot);
  const projectChecks = authorized.checks.filter((check): check is ProjectCommandCheck => check.kind === "project-command");
  const projectResults = await executeProjectChecks(projectChecks, repositoryRoot, context.runCompletionCheck);
  if (!projectResults.ok) {
    return freeze({ ok: false, error: blocked(
      before,
      ["infrastructure"],
      [projectResults.checkId],
      `completion check ${projectResults.checkId} infrastructure failure: ${projectResults.message}`,
    ) });
  }
  const owner = await observeOwnerCheck(context, authorized, wave, manifest);
  const after = unchangedWorkspace(graph, repositoryRoot, before);
  if (!after.ok) return after;
  const acceptance = observeAcceptance(repositoryRoot, expectation, projectResults.results);
  const parsedResult = parseWaveCompletionSuiteResult({
    kind: "wave-completion-suite-result",
    runId: authorized.runId,
    wave: authorized.wave,
    revision: authorized.revision,
    authorityDigest: authorized.authorityDigest,
    manifestDigest: authorized.manifestDigest,
    suiteDigest: authorized.suiteDigest,
    workspaceDigest: authorized.workspaceDigest,
    checks: freezeArray([lint.result, ...(owner === null ? [] : [owner.result]), ...projectResults.results]),
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(owner === null ? {} : { ownerVerification: owner.observation }),
  });
  if (!parsedResult.ok) return freeze({ ok: false, error: blocked(before, ["authority"], [], parsedResult.error.errors.join("; ")) });
  return freeze({ ok: true, value: freeze({ result: parsedResult.value, lintRefusal: lint.refusal }) });
}

/** The workspace after the checks ran: it must be the very workspace they were authorized for. */
function unchangedWorkspace(
  graph: TaskGraph,
  repositoryRoot: CanonicalRepositoryRoot,
  before: ObservedWorkspace,
): DomainResult<ObservedWorkspace, EnsureWaveCompletionSuiteResult> {
  const after = observeCurrentWaveWorkspace(graph, repositoryRoot);
  if (after.kind === "unavailable") {
    return freeze({ ok: false, error: blocked(after, ["workspace"], [], `post-suite Wave workspace unavailable: ${after.reason}`) });
  }
  return after.workspaceDigest === before.workspaceDigest
    ? freeze({ ok: true, value: after })
    : freeze({ ok: false, error: blocked(
        after,
        ["workspace"],
        [],
        `Wave workspace drifted during completion checks: ${before.workspaceDigest} -> ${after.workspaceDigest}`,
      ) });
}

/** Publish the result bytes at `relativePath` in the Run Directory; null on success, else why publication failed. */
async function publishResult(handle: RunDirHandle, relativePath: string, bytes: readonly number[]): Promise<string | null> {
  const published = await handle.publishArtifactSet([{ relativePath, bytes }]);
  return published.ok ? null : `completion result artifact publication failed: ${published.error.message}`;
}

/**
 * Execute, evaluate and publish the suite, then install an accepted receipt.
 * The result slot holds every terminal result, accepted or rejected; only a
 * rejection whose sole failures are the owner check's undecided findings
 * (`owner-undecided`) is published as an attempt record beside the slot: the
 * evidence persists, and a retry at the same workspace runs the check again.
 */
async function executeSuite(
  context: SuiteContext,
  authorized: AuthorizedWaveCompletionSuite,
  wave: number,
  manifest: FrozenVerificationManifest,
): Promise<EnsureWaveCompletionSuiteResult> {
  const { handle, manager, graph, repositoryRoot, before, expectation } = context;
  const executed = await runSuiteChecks(context, authorized, wave, manifest);
  if (!executed.ok) return executed.error;
  const { result, lintRefusal } = executed.value;
  const evaluation = evaluateWaveCompletionSuite(authorized, result, expectation);
  if (evaluation.kind === "rejected") return rejectSuite(context, authorized, evaluation, result, lintRefusal);
  const failed = await publishResult(handle, completionResultArtifactPath(authorized), canonicalResultBytes(result));
  if (failed !== null) return blocked(before, ["artifact"], [], failed);
  return installAcceptedReceiptAndVerifyWorkspace(manager, graph, evaluation.receipt, repositoryRoot, before);
}

/** Block on a rejected result, publishing it first where its disposition says it belongs. */
async function rejectSuite(
  context: SuiteContext,
  authorized: AuthorizedWaveCompletionSuite,
  rejection: RejectedCompletionSuite,
  result: WaveCompletionSuiteResult,
  lintRefusal: string | null,
): Promise<EnsureWaveCompletionSuiteResult> {
  const { handle, before } = context;
  const blockedBy = (rejected: WaveCompletionSuiteDiagnostic): EnsureWaveCompletionSuiteResult =>
    blocked(before, rejected.categories, rejected.checkIds, rejected.message);
  const disposition = rejectionDisposition(rejection);
  if (disposition.kind === "authority") return blockedBy(evaluationDiagnostic(rejection));
  if (disposition.kind === "infrastructure") return blockedBy(infrastructureEvaluationDiagnostic(rejection));
  if (disposition.kind === "inexact") return blocked(before, ["authority"], [], "Wave completion suite rejected without an exact terminal result");
  const bytes = canonicalResultBytes(result);
  const destination = disposition.kind === "owner-undecided" ? ownerAttemptArtifactPath(authorized, bytes) : completionResultArtifactPath(authorized);
  const failed = await publishResult(handle, destination, bytes);
  if (failed !== null) return blocked(before, ["artifact"], [], failed);
  return blockedBy(withLintRefusal(evaluationDiagnostic(rejection), lintRefusal));
}
