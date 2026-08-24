import { dirname, resolve } from "node:path";
import { canonicalJson, type JsonValue } from "../../core/review-packet";
import {
  FULL_TIER_LINT_CHECK_ID_TEXT,
  evaluateWaveCompletionSuite,
  parseAcceptedWaveCompletionReceipt,
  parseCompletionCheckId,
  parseWaveCompletionSuiteResult,
  type AcceptedWaveCompletionReceipt,
  type AuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionSuite,
  type CompletionCheckId,
  type CompletionCheckResult,
  type NonEmptyString,
  type WaveCompletionSuiteResult,
} from "../../core/completion-suite";
import {
  authorizeWaveCompletionSuite,
  parseFrozenVerificationManifest,
} from "../../core/verification-manifest";
import { canonicalStructuralEquals } from "../../core/orchestration-contract";
import { runCompletionCheck } from "../../orchestration/completion-check-runner";
import type { RunDirHandle } from "../../orchestration/run-directory-handle";
import type { StateManager } from "../../state-manager";
import type {
  TaskGraph,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../../types";
import {
  observeWorkspaceDigest,
  resolveCanonicalGitRepositoryRoot,
  type WorkspaceDigestFailure,
} from "../../utils/workspace-digest";
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

export type EnsureWaveCompletionSuiteInput = Readonly<{
  handle: RunDirHandle;
  manager: StateManager;
  graph: TaskGraph;
  registration: WaveCompletionRegistration;
}>;

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

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
      reason: `${subject} is not valid UTF-8 JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
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
  const authorized = authorizeWaveCompletionSuite(manifest, active, workspace.workspaceDigest);
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

function observedLintResult(
  graph: TaskGraph,
  wave: number,
  repositoryRoot: string,
): CompletionCheckResult {
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
  if (lint.kind === "allow") {
    return freeze({
      checkId,
      scope: "wave",
      outcome: freeze({
        kind: "observed",
        exitCode: 0,
        timedOut: false,
        signal: null,
        report: freeze({ kind: "not-required" }),
      }),
    });
  }
  const message = "message" in lint ? lint.message : "full-tier lint returned no terminal result";
  const lintEngineFailure = message.startsWith("🚫 WAVE-GATE LINT ENGINE ERROR:") ||
    message.includes("LINT ENGINE ERROR");
  if (lint.kind === "block" && !lintEngineFailure) {
    return freeze({
      checkId,
      scope: "wave",
      outcome: freeze({
        kind: "observed",
        exitCode: 1,
        timedOut: false,
        signal: null,
        report: freeze({ kind: "not-required" }),
      }),
    });
  }
  return freeze({
    checkId,
    scope: "wave",
    outcome: freeze({
      kind: "spawn-failed",
      message: message as NonEmptyString,
    }),
  });
}

type CompletionRepositoryAuthority =
  | Readonly<{ ok: true; repositoryRoot: Parameters<typeof runCompletionCheck>[1] }>
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

function reusableReceipt(
  graph: TaskGraph,
  workspace: Extract<WaveWorkspaceObservation, { readonly kind: "observed" }>,
): AcceptedWaveCompletionReceipt | null {
  const active = graph.active_wave_gate;
  const manifest = graph.verification_manifest;
  const rawReceipt = graph.active_wave_completion_suite;
  if (active === undefined || manifest === undefined || rawReceipt === undefined) return null;
  const parsedManifest = parseFrozenVerificationManifest(manifest);
  const receipt = parseAcceptedWaveCompletionReceipt(rawReceipt);
  if (!parsedManifest.ok || !receipt.ok) return null;
  const authority = authorizeWaveCompletionSuite(parsedManifest.value, active, workspace.workspaceDigest);
  if (!authority.ok) return null;
  const value = receipt.value;
  if (value.runId !== authority.value.runId || value.wave !== authority.value.wave ||
      value.revision !== authority.value.revision || value.authorityDigest !== authority.value.authorityDigest ||
      value.manifestDigest !== authority.value.manifestDigest || value.suiteDigest !== authority.value.suiteDigest ||
      value.workspaceDigest !== authority.value.workspaceDigest || value.checks.length !== authority.value.checks.length) {
    return null;
  }
  return value.checks.every((check, index) => {
    const expected = authority.value.checks[index];
    if (expected === undefined || check.checkId !== expected.checkId || check.scope !== expected.scope ||
        check.outcome.kind !== "observed") return false;
    return expected.reportPolicy.kind === "not-required"
      ? check.outcome.report.kind === "not-required"
      : check.outcome.report.kind === "produced" && check.outcome.report.path === expected.reportPolicy.path;
  }) ? value : null;
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
  repositoryRoot: Parameters<typeof runCompletionCheck>[1],
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

function evaluationDiagnostic(
  evaluation: Extract<ReturnType<typeof evaluateWaveCompletionSuite>, { readonly kind: "rejected" }>,
): WaveCompletionSuiteDiagnostic {
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
  return diagnostic(categories, checkIds, `Wave completion suite rejected: ${failureKinds.join(", ")}`);
}

function infrastructureEvaluationDiagnostic(
  evaluation: Extract<ReturnType<typeof evaluateWaveCompletionSuite>, { readonly kind: "rejected" }>,
): WaveCompletionSuiteDiagnostic {
  return diagnostic(
    ["infrastructure"],
    evaluation.infrastructureFailures.map((failure) => failure.checkId),
    `Wave completion suite infrastructure failure: ${evaluation.infrastructureFailures
      .map((failure) => failure.kind)
      .join(", ")}`,
  );
}

function completionResultArtifactPath(authority: AuthorizedWaveCompletionSuite): string {
  return `completion-suites/${authority.suiteDigest}/${authority.workspaceDigest}.json`;
}

function replayCompletionResult(
  bytes: Uint8Array,
  authority: AuthorizedWaveCompletionSuite,
): ReplayedCompletionResult {
  const parsed = parsePersistedCompletionResultBytes(bytes, "persisted completion result");
  if (parsed.kind === "unavailable") {
    return freeze({
      kind: "artifact-conflict",
      checkIds: freezeArray([]),
      message: parsed.reason,
    });
  }
  const evaluation = evaluateWaveCompletionSuite(authority, parsed.result);
  if (evaluation.kind === "accepted") {
    return freeze({ kind: "accepted", receipt: evaluation.receipt });
  }
  const rejectedDiagnostic = evaluationDiagnostic(evaluation);
  if (evaluation.authorityFailures.length > 0 || evaluation.infrastructureFailures.length > 0) {
    return freeze({
      kind: "artifact-conflict",
      checkIds: rejectedDiagnostic.checkIds,
      message: `persisted completion result conflicts with current authority: ${rejectedDiagnostic.message}`,
    });
  }
  if (evaluation.semanticFailures.length > 0) {
    return freeze({ kind: "semantic-rejected", diagnostic: rejectedDiagnostic });
  }
  return freeze({
    kind: "artifact-conflict",
    checkIds: freezeArray([]),
    message: "persisted completion result has no exact terminal evaluation",
  });
}

function canonicalResultBytes(result: WaveCompletionSuiteResult): readonly number[] {
  const json = JSON.parse(JSON.stringify(result)) as JsonValue;
  return freezeArray([...new TextEncoder().encode(canonicalJson(json))]);
}

async function installAcceptedReceipt(
  manager: StateManager,
  graph: TaskGraph,
  receipt: AcceptedWaveCompletionReceipt,
): Promise<void> {
  const expectedActive = graph.active_wave_gate;
  const expectedManifest = graph.verification_manifest;
  await manager.update((locked) => {
    if (!canonicalStructuralEquals(locked.active_wave_gate, expectedActive) ||
        !canonicalStructuralEquals(locked.verification_manifest, expectedManifest)) {
      throw new Error("protected Wave registration or verification manifest changed before receipt installation");
    }
    if (locked.active_wave_completion_suite !== undefined) {
      if (canonicalStructuralEquals(locked.active_wave_completion_suite, receipt)) return locked;
      throw new Error("a conflicting completion receipt already occupies the active Wave authority");
    }
    return { ...locked, active_wave_completion_suite: receipt };
  });
}

async function installAcceptedReceiptAndVerifyWorkspace(
  manager: StateManager,
  graph: TaskGraph,
  receipt: AcceptedWaveCompletionReceipt,
  repositoryRoot: Parameters<typeof runCompletionCheck>[1],
  currentWorkspace: Extract<WaveWorkspaceObservation, { readonly kind: "observed" }>,
): Promise<EnsureWaveCompletionSuiteResult> {
  try {
    await installAcceptedReceipt(manager, graph, receipt);
  } catch (cause) {
    return blocked(currentWorkspace, ["state"], [], cause instanceof Error ? cause.message : String(cause));
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
    return freeze({
      ok: true,
      value: freeze({
        kind: "legacy",
        disposition: "not-required",
        currentWaveWorkspace: observeCurrentWaveWorkspace(graph, handle.runDirectory),
      }),
    });
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
  if (reusableReceipt(graph, before) !== null) return accepted("reused", before);

  if (graph.active_wave_completion_suite !== undefined) {
    try {
      await clearStaleReceipt(manager, graph);
      graph = manager.load();
    } catch (cause) {
      return blocked(before, ["state"], [], cause instanceof Error ? cause.message : String(cause));
    }
  }

  const active = graph.active_wave_gate;
  const manifest = graph.verification_manifest;
  if (active === undefined || manifest === undefined) {
    return blocked(before, ["authority"], [], "modern completion authority disappeared before suite execution");
  }
  const authorized = authorizeWaveCompletionSuite(manifest, active, before.workspaceDigest);
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
  if (persistedBytes.value !== null) {
    const replayed = replayCompletionResult(persistedBytes.value, authorized.value);
    if (replayed.kind === "accepted") {
      return installAcceptedReceiptAndVerifyWorkspace(
        manager,
        graph,
        replayed.receipt,
        repositoryRoot,
        before,
      );
    }
    if (replayed.kind === "semantic-rejected") {
      return blocked(
        before,
        replayed.diagnostic.categories,
        replayed.diagnostic.checkIds,
        replayed.diagnostic.message,
      );
    }
    return blocked(before, ["artifact"], replayed.checkIds, `${relativePath}: ${replayed.message}`);
  }

  const lintResult = observedLintResult(graph, active.wave, repositoryRoot);
  const projectChecks = authorized.value.checks.filter(
    (check): check is ProjectCommandCheck => check.kind === "project-command",
  );
  const projectResults = await executeProjectChecks(projectChecks, repositoryRoot);
  if (!projectResults.ok) {
    return blocked(
      before,
      ["infrastructure"],
      [projectResults.checkId],
      `completion check ${projectResults.checkId} infrastructure failure: ${projectResults.message}`,
    );
  }
  const checks = freezeArray([lintResult, ...projectResults.results]);

  const after = observeCurrentWaveWorkspace(graph, repositoryRoot);
  if (after.kind === "unavailable") {
    return blocked(after, ["workspace"], [], `post-suite Wave workspace unavailable: ${after.reason}`);
  }
  if (after.workspaceDigest !== before.workspaceDigest) {
    return blocked(
      after,
      ["workspace"],
      [],
      `Wave workspace drifted during completion checks: ${before.workspaceDigest} -> ${after.workspaceDigest}`,
    );
  }

  const parsedResult = parseWaveCompletionSuiteResult({
    kind: "wave-completion-suite-result",
    runId: authorized.value.runId,
    wave: authorized.value.wave,
    revision: authorized.value.revision,
    authorityDigest: authorized.value.authorityDigest,
    manifestDigest: authorized.value.manifestDigest,
    suiteDigest: authorized.value.suiteDigest,
    workspaceDigest: authorized.value.workspaceDigest,
    checks,
  });
  if (!parsedResult.ok) {
    return blocked(after, ["authority"], [], parsedResult.error.errors.join("; "));
  }
  const result = parsedResult.value;
  const evaluation = evaluateWaveCompletionSuite(authorized.value, result);
  if (evaluation.kind === "rejected" && evaluation.authorityFailures.length > 0) {
    const rejection = evaluationDiagnostic(evaluation);
    return blocked(after, rejection.categories, rejection.checkIds, rejection.message);
  }
  if (evaluation.kind === "rejected" && evaluation.infrastructureFailures.length > 0) {
    const rejection = infrastructureEvaluationDiagnostic(evaluation);
    return blocked(after, rejection.categories, rejection.checkIds, rejection.message);
  }
  if (evaluation.kind === "rejected" && evaluation.semanticFailures.length === 0) {
    return blocked(after, ["authority"], [], "Wave completion suite rejected without an exact terminal result");
  }

  const published = await handle.publishArtifactSet([{
    relativePath,
    bytes: canonicalResultBytes(result),
  }]);
  if (!published.ok) {
    return blocked(after, ["artifact"], [], `completion result artifact publication failed: ${published.error.message}`);
  }
  if (evaluation.kind === "rejected") {
    const rejection = evaluationDiagnostic(evaluation);
    return blocked(after, rejection.categories, rejection.checkIds, rejection.message);
  }

  return installAcceptedReceiptAndVerifyWorkspace(
    manager,
    graph,
    evaluation.receipt,
    repositoryRoot,
    after,
  );
}
