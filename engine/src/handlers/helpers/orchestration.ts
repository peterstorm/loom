/**
 * Orchestration façade — one deep interface for the parent.
 *
 * Usage:
 *   helper orchestration status [--json] [--wave N] [--runs-root <wave-gate-runs-root>]
 *   helper orchestration inspect --run <run-directory> --runs-root <root> [--json]
 *   helper orchestration abandon --run <run-directory> --runs-root <root>
 *                                --reason <text> [--superseded-by <run-directory>]
 *   helper orchestration start <architecture|refutation|standalone-review|standalone-disposition|wave-gate|remediation> --run <run-directory>
 *                              --runs-root <root> < program.json
 *   helper orchestration restart --run <exhausted-wave-run> --new-run <fresh-run-directory>
 *                                --runs-root <root>
 *   helper orchestration recover-orphan --run-id <missing-wave-run-id> --wave <N>
 *                                --digest <authority-digest> --new-run <fresh-run-directory>
 *                                --runs-root <root>
 *   helper orchestration resume --run <run-directory> --runs-root <root>
 *   helper orchestration submit --run <run-directory> --runs-root <root>
 *                               --request <request-id> --slot <slot-id>
 *                               --attempt <1|2>   (raw bytes on stdin)
 *   helper orchestration correlate --run <run-directory> --runs-root <root>
 *                                  --request <request-id> --harness <pi|claude>
 *                                  --native-id <harness-native-id> --agent <role>
 *   helper orchestration complete --run <run-directory> --runs-root <root>
 *                                 --operation <operation-id>
 *   helper orchestration decide --run <run-directory> --runs-root <root>
 *                               --request <decision-id>   (decision on stdin)
 *   helper orchestration remediate --task <task-id> --receipt <terminal escalation receipt id>
 *                               --reason <text>
 *   helper orchestration attest --task <task-id> --reason <text>
 *
 * Every `--run`, `--new-run`, and remediation `sourceRun` accepts either the
 * bare run id or a full path to that same direct child of its runs-root. The
 * operations that create a run — `start`, `restart --new-run`, and
 * `recover-orphan --new-run` — create the directory; the runs-root itself must
 * already exist. Every other operation requires the run to exist, because an
 * absent Run Directory is the orphan case recovery adjudicates.
 *
 * Each mutating call parses authority and drives available deterministic work,
 * including event and receipt reconciliation, until the next true external
 * boundary; it then returns exactly one external action. The parent therefore
 * never assembles an action itself or needs to know which program produced it.
 *
 * `submit` is idempotent: an attempt whose bytes already landed keeps the
 * stored evidence and re-emits the run's current action, which is the expected
 * outcome on a harness that captures transcripts itself.
 *
 * `status` is a pure read: it derives ONE `LoomStatus` value and hands it to
 * a renderer. Both renderers project that same value, so the human and JSON
 * forms cannot disagree — neither contains readiness or action policy, and
 * neither re-runs a gate check. If authority cannot be parsed, every fact
 * category is still present as `unavailable` and the sole action is `blocked`,
 * rather than fabricated zero-or-ready values.
 *
 * `inspect` is the same kind of read, aimed at ONE run rather than at the
 * protected graph: run id, registered program, machine state, per-slot capture
 * with the diagnostic that refused it, event tail, and any abandonment marker.
 * It answers "what state is this run in, and is it recoverable or stale?" —
 * which used to mean hand-reading `authority.json`, `program.json`,
 * `checkpoint.json`, and `events/` with `jq` before every replace-or-resume
 * decision. It decides nothing and advances nothing; `resume` remains the only
 * operation that moves a program.
 *
 * `abandon` is the one terminal operation that is NOT a program transition: it
 * records that an operator is finished with a run and, optionally, which run
 * replaced it. Run directories are never deleted — they are the evidence — so
 * without a marker a superseded run sits in the listing indistinguishable from
 * a live one, and the only record of the supersession is a parent session's
 * notes. The marker is immutable, refuses self-supersession, and blocks every
 * operation that would advance the run; nothing is removed.
 */

import { match } from "ts-pattern";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { recordReadCoverageObservation, runReadCoverage } from "../../orchestration/standalone-read-coverage-evidence";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { dirname, join, resolve } from "node:path";
import { isReviewAgent, SUBAGENT_DIR, TASK_GRAPH_PATH } from "../../config";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import { IMPLEMENTATION_BRIEF_MARKER, type ImplementationBrief } from "../../core/implementation-brief";
import { renderTaskImplementationBrief } from "../../orchestration/implementation-brief";
import { parseTaskGraph, StateManager, type ActiveWaveGateAbandonmentResult } from "../../state-manager";
import { observeAnyActiveSubagent } from "../../machine";
import type {
  ActiveWaveGateRegistration,
  HookHandler,
  HookResult,
  LoomStatus,
  WaveCompletionResultObservation,
} from "../../types";
import { deriveWaveReadiness } from "../../core/wave-gate-machine";
import { type GateDeps, type ImplementationReservationStatusObservation } from "../../core/wave-gate-checks";
import {
  deriveLoomStatusFromParsedGraph,
  renderLoomStatusHuman,
  renderLoomStatusJson,
  type ActiveRunDirectoryObservation,
  type AdvisoryApprovalObservation,
} from "../../core/loom-status";
import { inspectFilePresence, loadPlanModelsSource } from "./complete-wave-gate";
import {
  observeCurrentWaveCompletionResult,
  observeCurrentWaveWorkspace,
} from "./wave-completion-suite";
import { createRunDirectory, inspectRunDirectoryEntry, openRegisteredRunDirectory, openRunDirectory, type RunAbandonment, type RunDirHandle } from "../../orchestration/run-directory-handle";
import {
  deriveRunInspection,
  observed,
  renderRunInspectionHuman,
  renderRunInspectionJson,
  unavailable,
  type InspectedEvent,
  type ObservedFact,
  type RemediationInspectionLabel,
  type RunInspectionObservation,
} from "../../core/run-inspection";
import {
  HARNESS_LABEL,
  readSessionRunBindings,
  registerSessionRunBinding,
} from "../../orchestration/session-run-bindings";
import {
  parseStoredAgentRequestAuthority,
  parseEffectId,
  type AgentRequestAuthority,
  type EffectIntent,
} from "../../core/orchestration-contract";
import { expectedSpawnModel } from "../../core/model-profiles";
import { captureKey } from "../../core/harness-capture";
import { translateLegacyPanelJournal } from "./panel-program";
import {
  parseRegisteredPanelProgram,
  registeredPanelProgram,
  type RegisteredPanelProgram,
} from "../../core/legacy-panel-decisions";
import { driveRegisteredPanel, resumeRegisteredPanel, submitRegisteredPanelAttempt } from "./programs/legacy-panel";
import { runDirectoryEffectRunner } from "./programs/run-directory-effects";
import {
  applyWaveFacadeSubmission,
  inspectRemediationFacade,
  inspectStandaloneFacade,
  parseRegisteredFacadeProgram,
  parseRemediationStartInput,
  prepareRemediationFacadeStart,
  parseStandaloneStartInput,
  parseWaveGateStartInput,
  resumeRemediationFacade,
  resumeStandaloneFacade,
  resumeWaveGateFacade,
  recoverOrphanedWaveGateFacade,
  restartWaveGateFacade,
  startRemediationFacade,
  startStandaloneFacade,
  prepareStandaloneSuccessorFacadeStart,
  startPreparedStandaloneSuccessor,
  replayStandaloneCapturedEvidence,
  prepareWaveGateFacadeStart,
  startWaveGateFacade,
  waveAdvisoryDecisionRequestId,
  type FacadeAction,
  type FacadeDriveResult,
  type ProgramParse,
  type RemediationStartInputV2,
  type RegisteredStandaloneProgram,
} from "./programs";
import type { RegisteredWaveGateProgram } from "../../core/wave-gate-program";
import { advisoryDecisionApproved, waveGateDecisionMismatch } from "../../core/wave-gate-membership";
import { parseBoundedReviewerJson } from '../../core/reviewer-protocol';
import { remediateOperation } from "./remediate-implementation-escalation";
import { attestOperation } from "./attest-implementation";
import { renderStandaloneReviewSummary } from "../../core/standalone-review-records";
import { serializeStandaloneReviewMachineState } from "../../core/standalone-review-checkpoint";
import { argumentValue, hasFlag, unconsumedValueArguments } from "./cli-args";
import { REMEDIATION_EVENT_RESOURCE_POLICY } from "./programs/remediation-events";
import { parseStandaloneDispositionStartBytes } from "../../core/standalone-disposition-machine";
import { STANDALONE_LINEAGE_LIMITS, standalonePublicationReferenceSchema } from "../../core/standalone-lineage-contract";
import { projectStandaloneLineageSource } from "../../core/standalone-lineage";
import { type StandaloneDispositionSelection } from "../../core/standalone-review-model";
import { readAuthenticatedStandaloneLineageSource } from "./programs/standalone-source";
import { prepareStandaloneDispositionFacadeStart, startStandaloneDispositionFacade,
  resumeStandaloneDispositionFacade, inspectStandaloneDispositionFacade, readSelectedStandaloneDisposition,
  STANDALONE_DISPOSITION_EVENT_RESOURCE_POLICY } from "./programs/standalone-disposition";

const OPERATIONS = ["status", "inspect", "brief", "start", "restart", "recover-orphan", "resume", "submit", "correlate", "complete", "decide", "abandon", "remediate", "attest"] as const;
type Operation = (typeof OPERATIONS)[number];

const isOperation = (value: string | undefined): value is Operation =>
  value !== undefined && (OPERATIONS as readonly string[]).includes(value);

function usage(): HookResult {
  return {
    kind: "error",
    message: [
      "Usage: bun cli.ts helper orchestration <operation> [flags]",
      "",
      "  <run-directory> is a bare run id or a full path to that direct child of",
      "  --runs-root. start/restart/recover-orphan create it; the runs-root must exist.",
      "",
      "  status  [--json] [--wave N] [--runs-root <wave-gate-runs-root>]",
      "          --runs-root <root> --run <run-directory> selects read-only Run inspection",
      "  brief   [--task <task-id>] [--prompt]",
      "          (pure read: engine-rendered implementation brief + spawn invocation for each owed dispatch;",
      "          Pi spawns pass the LOOM_IMPLEMENTATION_BRIEF marker, --prompt adds the full brief for Claude Code)",
      "  inspect --runs-root <root> --run <run-directory> [--json]",
      "          (pure read: program, state, per-slot capture and rejection diagnostics, event tail)",
      "          --lineage returns authenticated source identity, complete Finding Origins, counts and advisory inventory",
      "          --replay derives exact standalone result JSON/digest from registered CLI capture receipts, without current result/checkpoint",
      "          optional exact policy: --disposition <absolute Run directory> --disposition-run <id> --disposition-digest <sha256>",
      "  abandon --runs-root <root> --run <run-directory> --reason <text> [--superseded-by <run-directory>]",
      "          (terminal marker; deletes nothing and refuses every operation that would advance the run)",
      "  start   <architecture|refutation|standalone-review|standalone-disposition|wave-gate|remediation> --runs-root <root> --run <run-directory> < program.json",
      "  restart --runs-root <root> --run <exhausted-wave-run> --new-run <fresh-run-directory>",
      "  recover-orphan --runs-root <root> --run-id <missing-run-id> --wave <N> --digest <sha256> --new-run <fresh-run-directory>",
      "  resume  --runs-root <root> --run <run-directory>",
      "  submit  --runs-root <root> --run <run-directory> --request <id> --slot <id> --attempt <1|2>",
      "          (idempotent: a repeat for a captured attempt keeps the stored bytes)",
      "  correlate --runs-root <root> --run <run-directory> --request <id> --harness <pi|claude> --native-id <id> --agent <role>",
      "  complete --runs-root <root> --run <run-directory> --operation <id>",
      "  decide  --runs-root <root> --run <run-directory> --request <decision-id>",
  "  remediate --task <task-id> --receipt <terminal escalation receipt id> --reason <text>",
  "          (retires the exact terminal implementation escalation so the next status offers a fresh attempt-1 dispatch; prior receipts stay in history)",
  "  attest   --task <task-id> --reason <text>",
  "          (arms implementation re-attestation: rewrites the Task's pending proof to attested obligations + regression-only policy; the next dispatch runs a verify-only child whose writes settle as drift, never as attested)",
    ].join("\n"),
  };
}


/** The real filesystem seams status reads through. */
const productionGateDeps: GateDeps = {
  loadPlanModels: loadPlanModelsSource,
  filePresence: inspectFilePresence,
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Derive one canonical status value and render it.
 *
 * A missing or malformed graph is NOT an error exit: an operator asking "where
 * am I" when the state file is unreadable needs the answer "authority is
 * unavailable, here is why", not a stack trace. The status contract already
 * represents that case, so it is rendered like any other.
 */
const STATUS_GRAPH_READ_FAILURE: unique symbol = Symbol("status-graph-read-failure");
type StatusGraphReadFailure = Readonly<{
  [STATUS_GRAPH_READ_FAILURE]: true;
  path: string;
  cause: string;
}>;

function parseStatusGraph(rawGraph: unknown): ReturnType<typeof parseTaskGraph> {
  if (typeof rawGraph === "object" && rawGraph !== null && STATUS_GRAPH_READ_FAILURE in rawGraph) {
    const failure = rawGraph as StatusGraphReadFailure;
    return { ok: false, error: `cannot read task graph at ${failure.path}: ${failure.cause}` };
  }
  return parseTaskGraph(rawGraph);
}

function renderParsedStatus(
  parsedGraph: ReturnType<typeof parseStatusGraph>,
  deps: GateDeps,
  asJson: boolean,
  runDirectory: ActiveRunDirectoryObservation,
): string {
  const status = deriveLoomStatusFromParsedGraph(parsedGraph, deps, null, runDirectory);
  return asJson ? renderLoomStatusJson(status) : renderLoomStatusHuman(status);
}

export function renderStatus(
  rawGraph: unknown,
  deps: GateDeps,
  asJson: boolean,
  runDirectory: ActiveRunDirectoryObservation = Object.freeze({ kind: "unverified" }),
): string {
  return renderParsedStatus(parseStatusGraph(rawGraph), deps, asJson, runDirectory);
}

function readGraph(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    return Object.freeze({
      [STATUS_GRAPH_READ_FAILURE]: true as const,
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function canonicalWaveGateRunsRoot(statePath: string): string {
  return join(dirname(dirname(resolve(statePath))), "reviews", "wave-gate-runs");
}

type StatusRunDirectoryBinding =
  | Readonly<{
      kind: "bound";
      observation: Extract<ActiveRunDirectoryObservation, { readonly kind: "present" }>;
      handle: RunDirHandle;
    }>
  | Readonly<{
      kind: "unavailable";
      observation: Exclude<ActiveRunDirectoryObservation, { readonly kind: "present" }>;
    }>;

const unavailableStatusBinding = (
  observation: Exclude<ActiveRunDirectoryObservation, { readonly kind: "present" }>,
): StatusRunDirectoryBinding => Object.freeze({ kind: "unavailable" as const, observation });

const invalidStatusBinding = (
  runId: string,
  path: string,
  message: string,
): StatusRunDirectoryBinding => unavailableStatusBinding(Object.freeze({ kind: "invalid" as const, runId, path, message }));

function activeStatusRun(
  parsedGraph: ReturnType<typeof parseStatusGraph>,
): ActiveWaveGateRegistration | null {
  if (!parsedGraph.ok || parsedGraph.value.active_wave_gate === undefined ||
      parsedGraph.value.active_wave_gate.terminalOutcome !== null) return null;
  return parsedGraph.value.active_wave_gate;
}

function statusRunsRoot(
  active: ActiveWaveGateRegistration,
  args: readonly string[],
  statePath: string,
): string {
  const requestedRoot = argumentValue(args, "--runs-root");
  return active.runsRoot ?? resolve(requestedRoot ?? canonicalWaveGateRunsRoot(statePath));
}

function protectedRunsRootMismatch(active: ActiveWaveGateRegistration, args: readonly string[]): string | null {
  const requestedRoot = argumentValue(args, "--runs-root");
  return active.runsRoot !== undefined && requestedRoot !== null && resolve(requestedRoot) !== active.runsRoot
    ? `requested runs root ${resolve(requestedRoot)} does not match protected root ${active.runsRoot}`
    : null;
}

function statusRunDirectoryBinding(
  parsedGraph: ReturnType<typeof parseStatusGraph>,
  args: readonly string[],
  statePath: string,
): StatusRunDirectoryBinding {
  const active = activeStatusRun(parsedGraph);
  if (active === null) return unavailableStatusBinding(Object.freeze({ kind: "unverified" }));

  const runId = active.runId;
  const mismatch = protectedRunsRootMismatch(active, args);
  if (mismatch !== null) return invalidStatusBinding(runId, join(active.runsRoot ?? "", runId), mismatch);

  const runsRoot = statusRunsRoot(active, args, statePath);
  const expectedPath = join(runsRoot, runId);
  const inspected = inspectRunDirectoryEntry(runsRoot, expectedPath);
  if (!inspected.ok) return invalidStatusBinding(runId, resolve(expectedPath), inspected.error.message);
  if (inspected.value.kind === "absent") {
    return unavailableStatusBinding(Object.freeze({
      kind: "absent" as const,
      runId,
      path: inspected.value.reference.runDirectory,
    }));
  }
  if (inspected.value.kind === "occupied") {
    return invalidStatusBinding(
      runId,
      inspected.value.reference.runDirectory,
      `expected a directory but found ${inspected.value.entryKind}`,
    );
  }
  const opened = openRunDirectory(inspected.value.reference.runsRoot, inspected.value.reference.runDirectory);
  return opened.ok
    ? Object.freeze({
        kind: "bound" as const,
        observation: Object.freeze({ kind: "present" as const, runId, path: opened.value.runDirectory }),
        handle: opened.value,
      })
    : invalidStatusBinding(runId, inspected.value.reference.runDirectory, opened.error.message);
}

function openStatusObservationHandle(
  observation: Extract<ActiveRunDirectoryObservation, { readonly kind: "present" }>,
  boundHandle?: RunDirHandle,
): Readonly<{ ok: true; value: RunDirHandle }> | Readonly<{ ok: false; message: string }> {
  if (boundHandle === undefined) {
    const opened = openRunDirectory(dirname(observation.path), observation.path);
    return opened.ok ? { ok: true, value: opened.value } : { ok: false, message: opened.error.message };
  }
  return boundHandle.runId === observation.runId && boundHandle.runDirectory === observation.path
    ? { ok: true, value: boundHandle }
    : { ok: false, message: "bound Run Directory handle does not match its status observation" };
}

function unavailableCompletionReason(
  observation: Exclude<ActiveRunDirectoryObservation, { readonly kind: "present" }>,
): string {
  if (observation.kind === "unverified") return "authoritative Run Directory observation is unavailable";
  if (observation.kind === "absent") return `authoritative Run Directory does not exist at ${observation.path}`;
  return `authoritative Run Directory is invalid at ${observation.path}: ${observation.message}`;
}

function statusCompletionResult(
  parsedGraph: ReturnType<typeof parseStatusGraph>,
  binding: StatusRunDirectoryBinding,
  workspace: NonNullable<GateDeps["currentWaveWorkspace"]>,
): WaveCompletionResultObservation {
  if (!parsedGraph.ok) {
    return Object.freeze({
      kind: "unavailable" as const,
      reason: `protected graph unavailable before completion result observation: ${parsedGraph.error}`,
    });
  }
  if (binding.kind === "bound") {
    return observeCurrentWaveCompletionResult(binding.handle, parsedGraph.value, workspace);
  }
  return Object.freeze({
    kind: "unavailable" as const,
    reason: unavailableCompletionReason(binding.observation),
  });
}

/** Observe the exact advisory decision without conflating absence and I/O loss. */
async function observedAdvisoryApprovalFromParsed(
  parsed: ReturnType<typeof parseStatusGraph>,
  observation: ActiveRunDirectoryObservation,
  workspace: NonNullable<GateDeps["currentWaveWorkspace"]>,
  boundHandle?: RunDirHandle,
): Promise<AdvisoryApprovalObservation> {
  if (observation.kind !== "present") return Object.freeze({ kind: "not-approved" });
  const unavailable = (reason: string): AdvisoryApprovalObservation => {
    process.stderr.write(
      `orchestration status: cannot determine advisory approval for ${observation.runId}: ${reason}\n`,
    );
    return Object.freeze({ kind: "unavailable", reason });
  };
  if (!parsed.ok) return unavailable(parsed.error);
  const opened = openStatusObservationHandle(observation, boundHandle);
  if (!opened.ok) return unavailable(opened.message);
  const readiness = deriveWaveReadiness(parsed.value, parsed.value.verification_manifest === undefined
    ? productionGateDeps
    : Object.freeze({
        ...productionGateDeps,
        currentWaveWorkspace: workspace,
        currentWaveCompletionResult: observeCurrentWaveCompletionResult(
          opened.value,
          parsed.value,
          workspace,
        ),
      }));
  if (!readiness.ok) return unavailable(readiness.error.reasons.map(({ message }) => message).join("; "));
  const findingCounts = readiness.value.facts.findingCounts;
  if (findingCounts.kind !== "known" || findingCounts.value.advisory === 0) {
    return Object.freeze({ kind: "not-approved" });
  }
  const decisionId = waveAdvisoryDecisionRequestId(observation.runId, readiness.value.waveTasks);
  try {
    const approved = advisoryDecisionApproved(await opened.value.readEvents(), decisionId);
    return Object.freeze({ kind: approved ? "approved" : "not-approved" });
  } catch (error) {
    return unavailable(
      `cannot read advisory decision event log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function statusWorkspaceObservation(
  parsedGraph: ReturnType<typeof parseStatusGraph>,
  statePath: string,
): NonNullable<GateDeps["currentWaveWorkspace"]> {
  return parsedGraph.ok
    ? observeCurrentWaveWorkspace(parsedGraph.value, dirname(resolve(statePath)))
    : Object.freeze({
        kind: "unavailable",
        reason: `protected graph unavailable before Git observation: ${parsedGraph.error}`,
      });
}

export async function observedAdvisoryApproval(
  rawGraph: unknown,
  observation: ActiveRunDirectoryObservation,
  boundHandle?: RunDirHandle,
  statePath: string = TASK_GRAPH_PATH,
): Promise<AdvisoryApprovalObservation> {
  const parsed = parseStatusGraph(rawGraph);
  const workspace = statusWorkspaceObservation(parsed, statePath);
  return observedAdvisoryApprovalFromParsed(parsed, observation, workspace, boundHandle);
}

function implementationReservationObservation(
  parsedGraph: ReturnType<typeof parseStatusGraph>,
  statePath: string,
): ImplementationReservationStatusObservation {
  if (!parsedGraph.ok) {
    return Object.freeze({
      kind: "unavailable",
      reason: `protected graph unavailable before roster observation: ${parsedGraph.error}`,
    });
  }
  const roster = observeAnyActiveSubagent(statePath);
  return roster.kind === "observed"
    ? Object.freeze({
        kind: "observed",
        observedAtMs: Date.now(),
        anyActiveForGraph: roster.anyActiveForGraph,
      })
    : roster;
}

export async function currentOrchestrationStatus(
  args: readonly string[] = [],
  statePath: string = TASK_GRAPH_PATH,
): Promise<string> {
  const status = await deriveCurrentOrchestrationStatus(args, statePath);
  return hasFlag(args, "--json") ? renderLoomStatusJson(status) : renderLoomStatusHuman(status);
}

/** The canonical status of the protected graph, with every shell observation
 *  status depends on. Renderers and the dispatch helpers project this value. */
async function deriveCurrentOrchestrationStatus(
  args: readonly string[],
  statePath: string,
): Promise<LoomStatus> {
  const rawGraph = readGraph(statePath);
  const parsedGraph = parseStatusGraph(rawGraph);
  const binding = statusRunDirectoryBinding(parsedGraph, args, statePath);
  const workspace = statusWorkspaceObservation(parsedGraph, statePath);
  const completionResult = statusCompletionResult(parsedGraph, binding, workspace);
  const statusDeps: GateDeps = Object.freeze({
    ...productionGateDeps,
    currentWaveWorkspace: workspace,
    currentWaveCompletionResult: completionResult,
    implementationReservations: implementationReservationObservation(parsedGraph, statePath),
  });
  const base = binding.observation;
  const observation: ActiveRunDirectoryObservation = binding.kind === "bound"
    ? Object.freeze({
        ...base,
        advisoryApproval: await observedAdvisoryApprovalFromParsed(parsedGraph, base, workspace, binding.handle),
      })
    : base;
  return deriveLoomStatusFromParsedGraph(parsedGraph, statusDeps, null, observation);
}

async function statusOperation(args: readonly string[]): Promise<HookResult> {
  process.stdout.write(`${await currentOrchestrationStatus(args)}\n`);
  return { kind: "allow" };
}

/** `brief`'s whole argument grammar: `--task <id>` and the `--prompt` switch.
 *  Brief answers only while canonical status owes implementation dispatches
 *  for the protected current Wave, so a status selector (`--wave`,
 *  `--runs-root`, `--run`) would have nothing to select; it and any other
 *  argument are refused rather than silently ignored. */
const BRIEF_VALUE_FLAGS: ReadonlySet<string> = new Set(["--task"]);
const BRIEF_SWITCHES: ReadonlySet<string> = new Set(["--prompt"]);

/** One owed dispatch's brief and its exact spawn invocation per harness. */
export type BriefInvocation = Readonly<{
  taskId: string;
  agent: string;
  dispatch: ImplementationBrief["dispatch"];
  pi: Readonly<{ agent: string; task: string }>;
  claude: Readonly<{ subagent_type: string; model: string; description: string }>;
  prompt?: string;
}>;

/**
 * Pure harness projection of one rendered brief. Pi passes the brief MARKER
 * as the task; the Loom extension expands it to the rendered brief before any
 * gate reads the prompt. Claude Code has no expansion seam, so `withPrompt`
 * carries the rendered brief to pass verbatim.
 */
export function briefInvocation(brief: ImplementationBrief, claudeModel: string, withPrompt: boolean): BriefInvocation {
  return Object.freeze({
    taskId: brief.taskId,
    agent: brief.agent,
    dispatch: brief.dispatch,
    pi: Object.freeze({ agent: brief.agent, task: `${IMPLEMENTATION_BRIEF_MARKER}: ${brief.taskId}` }),
    claude: Object.freeze({ subagent_type: brief.agent, model: claudeModel, description: `Implement ${brief.taskId}` }),
    ...(withPrompt ? { prompt: brief.prompt } : {}),
  });
}

/**
 * `brief [--task Tn] [--prompt]` — the engine-rendered implementation brief
 * for every dispatch canonical status owes (or the one named Task), with the
 * exact spawn invocation per harness (`briefInvocation`). A pure read: the
 * spawn gate still registers and authorizes the attempt. Any argument outside
 * that grammar, a status selector included, is refused.
 */
async function briefOperation(args: readonly string[]): Promise<HookResult> {
  const unconsumed = unconsumedValueArguments(args, BRIEF_VALUE_FLAGS).filter((token) => !BRIEF_SWITCHES.has(token));
  if (unconsumed.length > 0) {
    return {
      kind: "error",
      message: `brief takes only --task <id> and --prompt; unknown or unconsumed argument(s): ${unconsumed.join(" ")}`,
    };
  }
  const status = await deriveCurrentOrchestrationStatus([], TASK_GRAPH_PATH);
  const action = status.next.action;
  const recovery = action.kind === "blocked" && action.diagnostic.kind === "wave-gate-not-started"
    ? action.diagnostic.recovery
    : null;
  if (recovery?.kind !== "spawn-wave-implementation") {
    const owed = recovery?.kind ?? (action.kind === "blocked" ? action.diagnostic.kind : action.kind);
    return { kind: "error", message: `canonical status owes no implementation dispatch (next: ${owed}); run status` };
  }
  const requested = argumentValue(args, "--task");
  const dispatches = recovery.dispatches.filter(({ taskId }) => requested === null || taskId === requested);
  if (dispatches.length === 0) {
    return {
      kind: "error",
      message: `Task ${requested} is not in the owed dispatches (${recovery.dispatches.map(({ taskId }) => taskId).join(", ")})`,
    };
  }
  const withPrompt = hasFlag(args, "--prompt");
  const briefs: BriefInvocation[] = [];
  for (const dispatch of dispatches) {
    const rendered = renderTaskImplementationBrief(TASK_GRAPH_PATH, LOOM_PACKAGE_ROOT, dispatch.taskId);
    if (!rendered.ok) return { kind: "error", message: rendered.error };
    const claudeModel = expectedSpawnModel(rendered.value.agent, "claude-code");
    if (!claudeModel.ok) return { kind: "error", message: claudeModel.error.message };
    briefs.push(briefInvocation(rendered.value, claudeModel.value, withPrompt));
  }
  process.stdout.write(`${JSON.stringify({ wave: recovery.wave, briefs }, null, 2)}\n`);
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Run-bound operations
// ---------------------------------------------------------------------------

type RunBinding = Readonly<{ handle: RunDirHandle }>;

/**
 * How a run-bound operation obtains its handle. The two adapters are the whole
 * distinction between the operations that CREATE a run and the ones that resume
 * an existing one: creating makes the directory, resuming fails closed when it
 * is missing, and neither may be reached through the other's flag.
 */
type RunDirectoryBinder = typeof openRunDirectory;

/**
 * Bind to one anchored run directory. Both the runs-root and the run
 * directory are required: the handle proves the run is a direct child of the
 * root it claims, which is what stops a caller naming an arbitrary path.
 */
function bindRun(
  args: readonly string[],
  bind: RunDirectoryBinder = openRunDirectory,
): Readonly<{ ok: true; value: RunBinding }> | HookResult {
  const runsRoot = argumentValue(args, "--runs-root");
  const runDirectory = argumentValue(args, "--run");
  if (runsRoot === null || runDirectory === null) {
    return { kind: "error", message: "both --runs-root and --run are required" };
  }
  const opened = bind(runsRoot, runDirectory);
  return opened.ok
    ? { ok: true, value: { handle: opened.value } }
    : { kind: "error", message: `cannot bind run directory: ${opened.error.message}` };
}

const isBound = (
  value: Readonly<{ ok: true; value: RunBinding }> | HookResult,
): value is Readonly<{ ok: true; value: RunBinding }> => "ok" in value;

/**
 * Bind a run that an operation may still ADVANCE.
 *
 * Abandonment is the operator's terminal decision, so every operation that
 * would move the run refuses one — otherwise a superseded run stays as
 * resumable as its replacement, and the marker would be decoration rather than
 * a state. `inspect` and `abandon` deliberately bind through `bindRun` instead:
 * reading a retired run's evidence is the whole reason it was retained, and a
 * repeat of the identical `abandon` has to stay idempotent.
 *
 * An UNREADABLE marker refuses too. A marked run whose marker cannot be parsed
 * is the case where "advance it anyway" is least defensible — the run may
 * already have a successor holding the same authority.
 */
function bindLiveRun(
  args: readonly string[],
  bind: RunDirectoryBinder = openRunDirectory,
): Readonly<{ ok: true; value: RunBinding }> | HookResult {
  const bound = bindRun(args, bind);
  if (!isBound(bound)) return bound;
  const abandonment = bound.value.handle.readAbandonment();
  if (!abandonment.ok) return { kind: "error", message: abandonment.error.message };
  if (abandonment.value === null) return bound;
  const replacement = abandonment.value.supersededBy === null
    ? "it was not superseded"
    : `superseded by ${abandonment.value.supersededBy}`;
  return {
    kind: "error",
    message: `run ${bound.value.handle.runId} was abandoned (${replacement}): ${abandonment.value.reason} — ` +
      "`inspect` still reads its evidence; advance the run that replaced it instead",
  };
}

// ---------------------------------------------------------------------------
// inspect / abandon
// ---------------------------------------------------------------------------

/** Run a throwing read into an `ObservedFact`, carrying the cause rather than a default. */
async function observing<T>(read: () => Promise<T>, subject: string): Promise<ObservedFact<T>> {
  try {
    return observed(await read());
  } catch (error) {
    return unavailable(`${subject} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const factOf = <T>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ message: string }> }>,
): ObservedFact<T> => result.ok ? observed(result.value) : unavailable(result.error.message);

function observeCaptureRejections(
  handle: RunDirHandle,
  requests: ReturnType<RunDirHandle["readIssuedRequests"]>,
): ObservedFact<ReadonlyMap<string, string>> {
  if (!requests.ok) return unavailable(requests.error.message);
  const markers = new Map<string, string>();
  for (const authority of requests.value) {
    const rejection = handle.readCaptureRejection(authority);
    if (!rejection.ok) return unavailable(rejection.error.message);
    if (rejection.value !== null) markers.set(authority.requestId, rejection.value);
  }
  return observed(markers);
}

async function observeStandaloneReview(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram,
): Promise<Readonly<{ checkpoint: ObservedFact<string | null>; reviewSummary: string | null }>> {
  const inspected = await inspectStandaloneFacade(handle, registration);
  if (!inspected.ok) return { checkpoint: unavailable(inspected.message), reviewSummary: null };
  return {
    checkpoint: observed(serializeStandaloneReviewMachineState(inspected.value)),
    reviewSummary: inspected.value.kind === "done" ? renderStandaloneReviewSummary(inspected.value.result) : null,
  };
}

/**
 * Read one run directory into the observation the projection folds.
 *
 * Every read is independent and every failure is carried, so a run with a
 * corrupt event log still reports its program, state, and slots — the partial
 * answer is exactly what an operator deciding "recoverable or stale?" needs,
 * and a single throw would have withheld all of it.
 */
async function observeRun(handle: RunDirHandle): Promise<RunInspectionObservation & Readonly<{ reviewSummary: string | null }>> {
  const authority = handle.readAuthority();
  const programRegistration = handle.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
  const disposition = programRegistration.ok && typeof programRegistration.value === "object" && programRegistration.value !== null &&
    (programRegistration.value as Record<string, unknown>).kind === "standalone-disposition";
  const requests = handle.readIssuedRequests(disposition ? STANDALONE_LINEAGE_LIMITS.retainedBytes : undefined, disposition ? 128 : undefined);
  let remediationOutcome: ObservedFact<RemediationInspectionLabel | null> = observed(null);
  let checkpoint = await observing(() => handle.readCheckpoint(disposition ? STANDALONE_LINEAGE_LIMITS.retainedBytes : undefined), "checkpoint");
  let reviewSummary: string | null = null;
  let eventPolicy: Parameters<RunDirHandle["readEvents"]>[0] = disposition ? STANDALONE_DISPOSITION_EVENT_RESOURCE_POLICY : undefined;
  if (programRegistration.ok && programRegistration.value !== null) {
    const parsed = parseRegisteredFacadeProgram(programRegistration.value);
    if (parsed.kind === "registered" && parsed.program.kind === "standalone-disposition") {
      const inspected = await inspectStandaloneDispositionFacade(handle, parsed.program);
      checkpoint = inspected.ok ? observed(JSON.stringify(inspected.value)) : unavailable(inspected.message);
    } else if (parsed.kind === "invalid" && typeof programRegistration.value === "object" &&
        programRegistration.value !== null && ["standalone-disposition", "standalone-review"].includes(String((programRegistration.value as Record<string, unknown>).kind))) {
      checkpoint = unavailable(parsed.message);
    } else if (parsed.kind === "registered" && parsed.program.kind === "standalone-review") {
      ({ checkpoint, reviewSummary } = await observeStandaloneReview(handle, parsed.program));
    } else if (parsed.kind === "invalid" &&
        typeof programRegistration.value === "object" && programRegistration.value !== null &&
        (programRegistration.value as Record<string, unknown>)["kind"] === "remediation") {
      remediationOutcome = unavailable(parsed.message);
      eventPolicy = REMEDIATION_EVENT_RESOURCE_POLICY;
    } else if (parsed.kind === "registered" && parsed.program.kind === "remediation") {
      eventPolicy = parsed.program.schemaVersion === 2 ? REMEDIATION_EVENT_RESOURCE_POLICY : undefined;
      const projected = await inspectRemediationFacade(handle, parsed.program);
      remediationOutcome = projected.ok ? observed(projected.label) : unavailable(projected.message);
    }
  }
  const markerRejections = observeCaptureRejections(handle, requests);

  return Object.freeze({
    runId: handle.runId,
    runsRoot: handle.identity.runsRoot,
    runDirectory: handle.runDirectory,
    // The authority's CONTENT is the identity already carried above; only its
    // readability is news, so the fact's payload is deliberately empty.
    authority: authority.ok ? observed<null>(null) : unavailable<null>(authority.error.message),
    programRegistration: factOf(programRegistration),
    checkpoint,
    reviewSummary,
    remediationOutcome,
    requests: factOf(requests),
    capturedAttempts: factOf(handle.readCapturedAttempts()),
    markerRejections,
    events: await observing<readonly InspectedEvent[]>(() => handle.readEvents(eventPolicy), "event log"),
    abandonment: factOf(handle.readAbandonment()),
  });
}

async function inspectLineageOperation(args: readonly string[]): Promise<HookResult> {
  const root = argumentValue(args, "--runs-root");
  const run = argumentValue(args, "--run");
  if (root === null || run === null) return { kind: "error", message: "source inspection requires --runs-root and --run" };
  const locator = argumentValue(args, "--disposition");
  const runId = argumentValue(args, "--disposition-run");
  const dispositionDigest = argumentValue(args, "--disposition-digest");
  const selected = locator === null && runId === null && dispositionDigest === null ? null
    : standalonePublicationReferenceSchema.safeParse({ locator, runId, resultDigest: dispositionDigest });
  if (selected !== null && !selected.success) return { kind: "error", message: "policy inspection requires exact --disposition, --disposition-run and --disposition-digest" };
  const source = await readAuthenticatedStandaloneLineageSource(root, run);
  if (!source.ok) return { kind: "error", message: source.message };
  let selection: StandaloneDispositionSelection = { kind: "historical-decision-unavailable" };
  if (selected !== null && selected.success) {
    const publication = readSelectedStandaloneDisposition(source.value, { locator: selected.data.locator,
      runId: selected.data.runId, dispositionDigest: selected.data.resultDigest });
    if (!publication.ok) return { kind: "error", message: publication.message };
    selection = { kind: "selected-record", disposition: publication.value };
  }
  const projection = projectStandaloneLineageSource(source.value, selection);
  if (!projection.ok) return { kind: "error", message: projection.error.message };
  process.stdout.write(`${JSON.stringify(projection.value, null, 2)}\n`);
  return { kind: "allow" };
}

async function inspectOperation(args: readonly string[]): Promise<HookResult> {
  if (hasFlag(args, "--replay")) {
    const bound = bindRun(args, openRegisteredRunDirectory);
    if (!isBound(bound)) return bound;
    const stored = bound.value.handle.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
    if (!stored.ok) return { kind: "error", message: stored.error.message };
    const registration = parseRegisteredFacadeProgram(stored.value);
    if (registration.kind !== "registered" || registration.program.kind !== "standalone-review") return { kind: "error", message: "evidence replay requires registered standalone authority" };
    const replay = await replayStandaloneCapturedEvidence(bound.value.handle, registration.program);
    if (!replay.ok) return { kind: "error", message: replay.message };
    process.stdout.write(`${JSON.stringify({ kind: "standalone-evidence-replay", digest: replay.digest, json: replay.json })}\n`);
    return { kind: "allow" };
  }
  if (hasFlag(args, "--lineage")) return inspectLineageOperation(args);
  if (["--disposition", "--disposition-run", "--disposition-digest"].some(flag => argumentValue(args, flag) !== null)) {
    return { kind: "error", message: "disposition selection requires --lineage inspection" };
  }
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;
  const observation = await observeRun(bound.value.handle);
  const inspection = deriveRunInspection(observation);
  const asJson = hasFlag(args, "--json");
  const rendered = asJson
    ? renderRunInspectionJson(inspection)
    : renderRunInspectionHuman(inspection);
  // Presentation is derived only after published-result replay, never from raw
  // checkpoint partitions or model-authored counts. No summary artifact exists.
  process.stdout.write(`${rendered}${!asJson && observation.reviewSummary !== null
    ? `\n\n${observation.reviewSummary}` : ""}\n`);
  return { kind: "allow" };
}

/**
 * Tombstone the Wave Gate registration that names this run, if the protected
 * graph carries one.
 *
 * The run-directory marker alone never lifted the state's active authority, so
 * an abandoned Wave Gate run kept owning its Wave forever: `start` refused any
 * successor with "already owns wave" and the only sanctioned escape was the
 * exceptional spec-trace retirement. Stamping the SAME terminal decision — the
 * marker's own runId/reason/supersededBy, re-proven by the state parser — into
 * the registration under the TaskGraph lock closes that loop while keeping
 * history: the tombstone stays in place until a successor start supersedes it
 * or explicit spec-trace retirement clears it; the retirement path can still
 * prove the abandoned run before clearing that active scope.
 *
 * The receipt is emitted before this runs — the marker is already immutable on
 * disk — so a stamp failure cannot unreport the abandonment; the returned
 * error tells the operator to repeat the identical command, which replays the
 * marker idempotently and retries the stamp.
 */
export type WaveGateAbandonmentStampOutcome =
  | Readonly<{ kind: "no-graph" }>
  | ActiveWaveGateAbandonmentResult
  | Readonly<{ kind: "stamp-failed"; message: string }>;

async function stampAbandonedWaveGateRegistration(
  runsRoot: string,
  marker: RunAbandonment,
): Promise<WaveGateAbandonmentStampOutcome> {
  const manager = StateManager.fromPath(TASK_GRAPH_PATH);
  if (manager === null) return Object.freeze({ kind: "no-graph" });
  try {
    return await manager.abandonActiveWaveGateRegistration({
      runsRoot,
      runId: marker.runId,
      reason: marker.reason,
      supersededBy: marker.supersededBy,
    });
  } catch (error) {
    return Object.freeze({
      kind: "stamp-failed",
      message: "run abandonment was recorded in the Run Directory, but the protected Wave Gate registration could not be tombstoned: " +
        `${error instanceof Error ? error.message : String(error)} — repeat the identical abandon command to retry the state stamp`,
    });
  }
}

/**
 * Record that an operator is finished with a run, and by what it was replaced.
 *
 * The replacement is proven to exist as a real direct child of the SAME
 * runs-root before the marker is written. The marker is immutable once placed,
 * so a typo'd or cross-root pointer would be frozen into the run forever —
 * worse than no pointer, because it reads as authoritative.
 */
async function abandonOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;
  const reason = argumentValue(args, "--reason");
  if (reason === null) return { kind: "error", message: "abandon requires --reason <text>" };
  const runsRoot = argumentValue(args, "--runs-root");
  const requested = argumentValue(args, "--superseded-by");
  let supersededBy: string | null = null;
  if (requested !== null) {
    if (runsRoot === null) return { kind: "error", message: "both --runs-root and --run are required" };
    const inspected = inspectRunDirectoryEntry(runsRoot, requested);
    if (!inspected.ok) return { kind: "error", message: `superseding run: ${inspected.error.message}` };
    if (inspected.value.kind !== "directory") {
      return {
        kind: "error",
        message: `superseding run ${requested} is not an existing run directory under ${runsRoot}`,
      };
    }
    supersededBy = inspected.value.reference.runId;
  }
  const abandoned = await bound.value.handle.abandonRun({ supersededBy, reason });
  if (!abandoned.ok) return { kind: "error", message: abandoned.error.message };
  process.stdout.write(`${JSON.stringify(abandoned.value, null, 2)}\n`);
  const stamp = await stampAbandonedWaveGateRegistration(bound.value.handle.identity.runsRoot, abandoned.value);
  if (stamp.kind === "not-targeted") {
    process.stderr.write(
      `orchestration abandon: run ${abandoned.value.runId} was marked abandoned, but no protected Wave Gate registration was tombstoned (${stamp.reason})\n`,
    );
  }
  return stamp.kind === "stamp-failed"
    ? { kind: "error", message: stamp.message }
    : { kind: "allow" };
}

/**
 * The harness session a façade invocation publishes capture authority into.
 *
 * Each harness's subagent hooks learn which run a spawned agent belongs to
 * from a durable SESSION RUN BINDING the façade publishes, never from the
 * environment of the agent itself. Pi announces its session as
 * `PI_SESSION_ID`; Claude Code exposes `CLAUDE_CODE_SESSION_ID` (with
 * `CLAUDECODE=1`) to the Bash commands its main agent runs, and its hooks
 * receive that same id as the payload `session_id`. Pi takes precedence: a Pi
 * process launched from inside Claude Code is still a Pi session.
 */
type BindingSession =
  | Readonly<{ harness: "pi"; sessionVariable: "PI_SESSION_ID"; sessionId: string | undefined }>
  | Readonly<{ harness: "claude-code"; sessionVariable: "CLAUDE_CODE_SESSION_ID"; sessionId: string | undefined }>;

function bindingSessionOf(env: NodeJS.ProcessEnv): BindingSession | null {
  if (env.PI_CODING_AGENT === "true") {
    return { harness: "pi", sessionVariable: "PI_SESSION_ID", sessionId: env.PI_SESSION_ID };
  }
  if (env.CLAUDECODE === "1") {
    return { harness: "claude-code", sessionVariable: "CLAUDE_CODE_SESSION_ID", sessionId: env.CLAUDE_CODE_SESSION_ID };
  }
  return null;
}

async function publishSpawnBinding(
  session: BindingSession,
  handle: RunDirHandle,
  action: Extract<FacadeAction, Readonly<{ kind: "spawn-batch" }>>,
): Promise<HookResult | null> {
  const { sessionId } = session;
  const label = HARNESS_LABEL[session.harness];
  if (sessionId === undefined) {
    return { kind: "error", message: `${label} orchestration spawn publication requires ${session.sessionVariable}` };
  }
  const requests = action.requests;
  if (requests.length === 0) {
    return { kind: "error", message: `${label} orchestration spawn action has no request authority` };
  }
  const requestIds = [];
  for (const [index, request] of requests.entries()) {
    // Re-parsed at the capture-authority boundary: the binding records only
    // authority the stored-request parser admits, never the in-memory value.
    const parsed = parseStoredAgentRequestAuthority(request.authority);
    if (!parsed.ok) {
      return { kind: "error", message: `${label} orchestration spawn request ${index}: ${parsed.error.violations.map(({ message }) => message).join("; ")}` };
    }
    if (parsed.value.runId !== handle.runId) {
      return { kind: "error", message: `${label} orchestration spawn request ${index} belongs to another run` };
    }
    requestIds.push(parsed.value.requestId);
  }
  const registered = await registerSessionRunBinding(SUBAGENT_DIR, sessionId, Object.freeze({
    runId: handle.runId,
    runsRoot: dirname(handle.runDirectory),
    runDirectory: handle.runDirectory,
    requestIds: Object.freeze(requestIds),
    resultDigest: null,
  }), session.harness);
  return registered.ok
    ? null
    : { kind: "error", message: `cannot publish ${label} orchestration capture authority: ${registered.message}` };
}

async function publishCompletionBinding(
  session: BindingSession,
  handle: RunDirHandle,
  action: Extract<FacadeAction, Readonly<{ kind: "done" }>>,
): Promise<HookResult | null> {
  const { sessionId } = session;
  const label = HARNESS_LABEL[session.harness];
  // Only a done action whose outcome is the run's published `result.json`
  // artifact completes a session binding; every other outcome binds nothing.
  const outcome = action.outcome;
  if (typeof outcome !== "object" || !("slot" in outcome) || outcome.slot.kind !== "fixed-artifact-slot" ||
      outcome.slot.path !== "result.json" || !/^[0-9a-f]{64}$/.test(outcome.digest)) return null;
  const resultDigest = outcome.digest;
  if (sessionId === undefined) {
    return { kind: "error", message: `${label} orchestration completion publication requires ${session.sessionVariable}` };
  }
  const bindings = readSessionRunBindings(SUBAGENT_DIR, sessionId, session.harness);
  if (!bindings.ok) {
    return { kind: "error", message: `cannot read ${label} orchestration completion authority: ${bindings.message}` };
  }
  const binding = bindings.value.find(({ runId, runDirectory }) =>
    runId === handle.runId && runDirectory === handle.runDirectory);
  if (binding === undefined) {
    return { kind: "error", message: `cannot bind completed result for unregistered ${label} run ${handle.runId}` };
  }
  const registered = await registerSessionRunBinding(
    SUBAGENT_DIR, sessionId, Object.freeze({ ...binding, resultDigest }), session.harness);
  return registered.ok
    ? null
    : { kind: "error", message: `cannot publish ${label} orchestration completion authority: ${registered.message}` };
}

async function emitRunAction(handle: RunDirHandle, action: FacadeAction): Promise<HookResult> {
  const session = bindingSessionOf(process.env);
  if (session !== null) {
    const failure = action.kind === "spawn-batch" ? await publishSpawnBinding(session, handle, action)
      : action.kind === "done" ? await publishCompletionBinding(session, handle, action)
      : null;
    if (failure !== null) return failure;
  }
  process.stdout.write(`${JSON.stringify(action, null, 2)}\n`);
  return { kind: "allow" };
}

const START_PROGRAMS = ["architecture", "refutation", "standalone-review", "wave-gate", "remediation", "standalone-disposition"] as const;
type StartProgram = (typeof START_PROGRAMS)[number];

const isStartProgram = (value: string | undefined): value is StartProgram =>
  value !== undefined && (START_PROGRAMS as readonly string[]).includes(value);

/**
 * One fully-parsed start request, ready to drive against a Run Directory.
 *
 * Producing this BEFORE the run is bound is what keeps `start` from claiming a
 * Run Directory it then refuses to use. Binding writes the fixed layout and an
 * exclusive `authority.json`, so a payload rejected after that point left a
 * claimed directory behind with no façade action to release it — and, because
 * `registerProgram` admits only a byte-identical re-registration, the operator
 * could not simply correct the payload and retry the same name. The ordering is
 * now structural rather than remembered: the drive needs this value, and this
 * value cannot be built by touching the filesystem.
 */
type StartRequest =
  | Readonly<{ kind: "standalone-review"; input: RegisteredStandaloneProgram["input"] }>
  | Readonly<{ kind: "remediation"; input: RemediationStartInputV2 }>
  | Readonly<{ kind: "wave-gate"; input: RegisteredWaveGateProgram["input"] }>
  | Readonly<{ kind: "panel"; registration: RegisteredPanelProgram }>;

function parseStartRequest(program: Exclude<StartProgram, "standalone-disposition">, stdin: string): ProgramParse<StartRequest> {
  let raw: unknown;
  try {
    if (program === "standalone-review") {
      const decoded = parseBoundedReviewerJson(Buffer.from(stdin), STANDALONE_LINEAGE_LIMITS.retainedBytes);
      if (!decoded.ok) return { ok: false, message: decoded.error.message };
      raw = decoded.value;
    } else raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    return { ok: false, message: `program input is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (program === "standalone-review") {
    const parsed = parseStandaloneStartInput(raw);
    return parsed.ok ? { ok: true, value: Object.freeze({ kind: program, input: parsed.value }) } : parsed;
  }
  if (program === "remediation") {
    const parsed = parseRemediationStartInput(raw);
    return parsed.ok ? { ok: true, value: Object.freeze({ kind: program, input: parsed.value }) } : parsed;
  }
  if (program === "wave-gate") {
    const parsed = parseWaveGateStartInput(raw);
    return parsed.ok ? { ok: true, value: Object.freeze({ kind: program, input: parsed.value }) } : parsed;
  }
  const translated = translateLegacyPanelJournal(program, raw);
  if (!translated.ok) return { ok: false, message: translated.error };
  if (translated.value.events.length !== 0) {
    return { ok: false, message: "a fresh orchestration start cannot import pre-existing events" };
  }
  const registration = registeredPanelProgram(translated.value, raw);
  return { ok: true, value: Object.freeze({ kind: "panel", registration }) };
}

type DirectStartRequest = Exclude<StartRequest, { kind: "remediation" | "wave-gate" }>;

const driveStart = (handle: RunDirHandle, request: DirectStartRequest): Promise<FacadeDriveResult> =>
  match(request)
    .with({ kind: "standalone-review" }, ({ input }) => startStandaloneFacade(handle, input))
    .with({ kind: "panel" }, async ({ registration }) => {
      const registered = await handle.registerProgram(registration);
      return registered.ok
        ? driveRegisteredPanel(handle, registration)
        : { ok: false as const, message: registered.error.message };
    })
    .exhaustive();

/** The Run Directory a start names: both `--runs-root` and `--run`, or the
 *  program's exact usage refusal. */
function startRunLocation(
  args: readonly string[],
  usage: string,
): Readonly<{ ok: true; runsRoot: string; run: string }> | Readonly<{ ok: false; result: HookResult }> {
  const runsRoot = argumentValue(args, "--runs-root");
  const run = argumentValue(args, "--run");
  return runsRoot === null || run === null
    ? { ok: false, result: { kind: "error", message: usage } }
    : { ok: true, runsRoot, run };
}

/** The one start tail: create and bind the live Run Directory, drive the
 *  program the start prepared, and emit its action. Each start arm differs only
 *  in its usage and prepare step and hands its driver here. */
async function driveCreatedRun(
  args: readonly string[],
  drive: (handle: RunDirHandle) => Promise<FacadeDriveResult>,
): Promise<HookResult> {
  const bound = bindLiveRun(args, createRunDirectory);
  if (!isBound(bound)) return bound;
  const driven = await drive(bound.value.handle);
  return driven.ok ? emitRunAction(bound.value.handle, driven.action) : { kind: "error", message: driven.message };
}

async function startOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const program = args[0];
  if (!isStartProgram(program)) {
    return { kind: "error", message: `start requires ${START_PROGRAMS.join(", ")}` };
  }
  const runArgs = args.slice(1);
  if (program === "standalone-disposition") return startDispositionOperation(stdin, runArgs);
  const request = parseStartRequest(program, stdin);
  if (!request.ok) return { kind: "error", message: request.message };
  const startRequest = request.value;
  if (startRequest.kind === "standalone-review" && "schemaVersion" in startRequest.input) {
    const location = startRunLocation(runArgs, "successor start requires --runs-root and --run");
    if (!location.ok) return location.result;
    const prepared = await prepareStandaloneSuccessorFacadeStart(location.runsRoot, location.run, startRequest.input);
    if (!prepared.ok) return { kind: "error", message: prepared.message };
    return driveCreatedRun(runArgs, (handle) => startPreparedStandaloneSuccessor(handle, prepared.value));
  }
  if (startRequest.kind === "remediation") {
    const location = startRunLocation(runArgs, "remediation start requires --runs-root and --run");
    if (!location.ok) return location.result;
    const prepared = await prepareRemediationFacadeStart({
      input: startRequest.input,
      repositoryStartPath: process.cwd(),
      remediationRunsRoot: location.runsRoot,
      remediationRun: location.run,
    });
    if (!prepared.ok) return { kind: "error", message: prepared.message };
    return driveCreatedRun(runArgs, (handle) => startRemediationFacade(handle, prepared.value.registration));
  }
  if (startRequest.kind === "wave-gate") {
    const location = startRunLocation(runArgs, "wave-gate start requires --runs-root and --run");
    if (!location.ok) return location.result;
    const prepared = prepareWaveGateFacadeStart(startRequest.input, location.runsRoot, location.run);
    if (!prepared.ok) return { kind: "error", message: prepared.message };
    return driveCreatedRun(runArgs, (handle) => startWaveGateFacade(handle, prepared.value));
  }
  return driveCreatedRun(runArgs, (handle) => driveStart(handle, startRequest));
}

async function startDispositionOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  if (Buffer.byteLength(stdin) > STANDALONE_LINEAGE_LIMITS.retainedBytes) return { kind: "error", message: "disposition input exceeds byte budget" };
  const input = parseStandaloneDispositionStartBytes(Buffer.from(stdin));
  if (!input.ok) return { kind: "error", message: input.error.message };
  const location = startRunLocation(args, "disposition start requires --runs-root and --run");
  if (!location.ok) return location.result;
  const prepared = await prepareStandaloneDispositionFacadeStart(input.value, location.runsRoot, location.run);
  if (!prepared.ok) return { kind: "error", message: prepared.message };
  return driveCreatedRun(args, (handle) => startStandaloneDispositionFacade(handle, prepared.value));
}

async function recoverOrphanOperation(args: readonly string[]): Promise<HookResult> {
  const runsRoot = argumentValue(args, "--runs-root");
  const runId = argumentValue(args, "--run-id");
  const waveRaw = argumentValue(args, "--wave");
  const authorityDigest = argumentValue(args, "--digest");
  const nextRunDirectory = argumentValue(args, "--new-run");
  if (runsRoot === null || runId === null || waveRaw === null || authorityDigest === null || nextRunDirectory === null) {
    return {
      kind: "error",
      message: "recover-orphan requires --runs-root, --run-id, --wave, --digest, and --new-run",
    };
  }
  if (!/^\d+$/.test(waveRaw) || !Number.isSafeInteger(Number(waveRaw)) || Number(waveRaw) < 1) {
    return { kind: "error", message: "recover-orphan --wave must be a positive safe integer" };
  }
  const next = createRunDirectory(runsRoot, nextRunDirectory);
  if (!next.ok) return { kind: "error", message: `cannot bind replacement run directory: ${next.error.message}` };
  const driven = await recoverOrphanedWaveGateFacade(runsRoot, {
    runId,
    wave: Number(waveRaw),
    authorityDigest,
  }, next.value);
  if (!driven.ok) return { kind: "error", message: driven.message };
  return emitRunAction(next.value, driven.action);
}

async function restartOperation(args: readonly string[]): Promise<HookResult> {
  const previous = bindLiveRun(args);
  if (!isBound(previous)) return previous;
  const runsRoot = argumentValue(args, "--runs-root");
  const nextRunDirectory = argumentValue(args, "--new-run");
  if (runsRoot === null || nextRunDirectory === null) {
    return { kind: "error", message: "restart requires --runs-root, --run, and --new-run" };
  }
  const next = createRunDirectory(runsRoot, nextRunDirectory);
  if (!next.ok) return { kind: "error", message: `cannot bind replacement run directory: ${next.error.message}` };
  const stored = previous.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  const storedParse = stored.value === null ? null : parseRegisteredFacadeProgram(stored.value);
  if (storedParse?.kind === "invalid") {
    return { kind: "error", message: `registered Wave Gate program is invalid: ${storedParse.message}` };
  }
  const registration = storedParse?.kind === "registered" ? storedParse.program : null;
  if (registration === null || registration.kind !== "wave-gate") {
    return { kind: "error", message: "restart currently requires a registered Wave Gate run" };
  }
  const driven = await restartWaveGateFacade(previous.value.handle, next.value, registration);
  if (!driven.ok) return { kind: "error", message: driven.message };
  return emitRunAction(next.value, driven.action);
}

/**
 * Resume is idempotent and never silently spawns or decides policy: it reports
 * what the run's durable evidence already says. A run whose authority cannot
 * be read is reported as such rather than restarted, because restarting would
 * discard the very evidence that explains the failure.
 */
function unregisteredReviewerProblem(handle: RunDirHandle, requests: readonly AgentRequestAuthority[]): string | null {
  for (const request of requests) {
    if (!isReviewAgent(request.role)) continue;
    const packet = handle.readContext(request.contextDigest);
    if (!packet.ok) return `unregistered reviewer context authority unavailable: ${packet.error.message}`;
    if (packet.value.schemaVersion === 2) {
      return "current reviewer requires registered program authority; historical fallback refused";
    }
  }
  return null;
}

async function resumeOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return bound;

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };
  const stored = bound.value.handle.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  if (stored.value !== null) {
    const facadeParse = parseRegisteredFacadeProgram(stored.value);
    if (facadeParse.kind === "invalid") {
      return { kind: "error", message: `registered orchestration program is invalid: ${facadeParse.message}` };
    }
    if (facadeParse.kind === "registered") {
      const facadeRegistration = facadeParse.program;
      const driven = await match(facadeRegistration)
        .with({ kind: "standalone-review" }, (registration) =>
          resumeStandaloneFacade(bound.value.handle, registration))
        .with({ kind: "remediation" }, (registration) =>
          resumeRemediationFacade(bound.value.handle, registration))
        .with({ kind: "standalone-disposition" }, (registration) =>
          resumeStandaloneDispositionFacade(bound.value.handle, registration))
        .with({ kind: "wave-gate" }, (registration) =>
          resumeWaveGateFacade(bound.value.handle, registration))
        .exhaustive();
      if (!driven.ok) return { kind: "error", message: driven.message };
      return emitRunAction(bound.value.handle, driven.action);
    }
    const registration = parseRegisteredPanelProgram(stored.value);
    if (registration === null) return { kind: "error", message: "registered orchestration program is malformed" };
    const driven = await resumeRegisteredPanel(bound.value.handle, registration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }

  const issued = bound.value.handle.readIssuedRequests();
  if (!issued.ok) return { kind: "error", message: issued.error.message };
  const problem = unregisteredReviewerProblem(bound.value.handle, issued.value);
  if (problem !== null) return { kind: "error", message: problem };

  // Historical run without a program registration: retain the read-only v1
  // compatibility response, but never manufacture lifecycle progress.
  process.stdout.write(`${JSON.stringify({
    kind: "resumed",
    runId: authority.value.runId,
    runDirectory: authority.value.runDirectory,
  }, null, 2)}\n`);
  return { kind: "allow" };
}

/**
 * Accept one semantic result's exact bytes into its reserved transcript slot.
 *
 * The bytes arrive on stdin and are written verbatim — never trimmed, joined,
 * or re-encoded — so the stored artifact is byte-identical to what the harness
 * produced. The slot is exclusive, so a duplicate or late submission for an
 * attempt that already landed never overwrites accepted evidence.
 *
 * Submitting an attempt that is ALREADY captured is therefore not an error: it
 * is the expected outcome on a harness that captures transcripts itself, where
 * the parent's follow-up submit confirms what the extension already stored. The
 * stored bytes stay authoritative and the run's current action is emitted, the
 * same as any other submit — so an auto-capturing harness walks the one façade
 * path whose happy-path output used to be a bare sentence on stderr and an
 * exit code indistinguishable from a genuine failure.
 */
type FacadeRegistration = Extract<ReturnType<typeof parseRegisteredFacadeProgram>, { kind: "registered" }>["program"];
type SubmissionBinding = Readonly<{
  handle: RunDirHandle;
  requestId: string;
  attempt: 1 | 2;
  reserved: AgentRequestAuthority;
  facadeRegistration: FacadeRegistration | null;
  panelRegistration: RegisteredPanelProgram | null;
}>;

type SubmissionBindingResult =
  | Readonly<{ ok: true; value: SubmissionBinding }>
  | Readonly<{ ok: false; result: HookResult }>;

function bindSubmission(args: readonly string[]): SubmissionBindingResult {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return { ok: false, result: bound };
  const requestId = argumentValue(args, "--request");
  const slotId = argumentValue(args, "--slot");
  const attempt = argumentValue(args, "--attempt");
  if (requestId === null || slotId === null || (attempt !== "1" && attempt !== "2")) {
    return { ok: false, result: { kind: "error", message: "--request, --slot, and --attempt (1 or 2) are required" } };
  }
  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { ok: false, result: { kind: "error", message: authority.error.message } };
  const issued = bound.value.handle.readIssuedRequests();
  if (!issued.ok) return { ok: false, result: { kind: "error", message: issued.error.message } };
  const reserved = issued.value.find((request) => request.requestId === requestId);
  if (reserved === undefined) {
    return { ok: false, result: { kind: "error", message: `request ${requestId} was never reserved in this run` } };
  }
  if (reserved.slotId !== slotId || String(reserved.attempt) !== attempt) {
    return { ok: false, result: { kind: "error", message: `request ${requestId} is reserved for slot ${reserved.slotId} attempt ${reserved.attempt}, not ${slotId} attempt ${attempt}` } };
  }
  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { ok: false, result: { kind: "error", message: stored.error.message } };
  if (stored.value === null) {
    const problem = unregisteredReviewerProblem(bound.value.handle, issued.value);
    if (problem !== null) return { ok: false, result: { kind: "error", message: problem } };
  }
  const facade = stored.value === null ? null : parseRegisteredFacadeProgram(stored.value);
  if (facade?.kind === "invalid") {
    return { ok: false, result: { kind: "error", message: `registered orchestration program is invalid: ${facade.message}` } };
  }
  const facadeRegistration = facade?.kind === "registered" ? facade.program : null;
  if (facadeRegistration?.kind === "standalone-disposition") {
    return { ok: false, result: { kind: "error", message: "no-agent standalone disposition publication does not accept submissions" } };
  }
  const panelRegistration = stored.value === null ? null : parseRegisteredPanelProgram(stored.value);
  if (stored.value !== null && panelRegistration === null && facadeRegistration === null) {
    return { ok: false, result: { kind: "error", message: "registered orchestration program is malformed" } };
  }
  return { ok: true, value: { handle: bound.value.handle, requestId, attempt: Number(attempt) as 1 | 2,
    reserved, facadeRegistration, panelRegistration } };
}

type CapturedSubmission = Readonly<{ semanticRaw: string; artifact: unknown; alreadyCaptured: boolean }>;

async function captureSubmission(
  binding: SubmissionBinding,
  stdin: string,
): Promise<Readonly<{ ok: true; value: CapturedSubmission }> | Readonly<{ ok: false; result: HookResult }>> {
  const attempts = binding.handle.readCapturedAttempts();
  if (!attempts.ok) return { ok: false, result: { kind: "error", message: attempts.error.message } };
  const alreadyCaptured = attempts.value.has(captureKey(binding.reserved.slotId, binding.reserved.attempt));
  if (alreadyCaptured) {
    const existing = binding.handle.readTranscriptBytes(binding.reserved);
    return existing.ok
      ? { ok: true, value: { semanticRaw: Buffer.from(existing.value).toString("utf-8"), artifact: null, alreadyCaptured } }
      : { ok: false, result: { kind: "error", message: existing.error.message } };
  }
  const effectId = parseEffectId(`effect:capture:${createHash("sha256").update(`${binding.requestId}:${binding.attempt}`).digest("hex")}`);
  if (!effectId.ok) return { ok: false, result: { kind: "error", message: effectId.error.message } };
  const captureIntent: Extract<EffectIntent, { kind: "capture-raw-transcript" }> = {
    kind: "capture-raw-transcript", effectId: effectId.value, runId: binding.reserved.runId,
    request: binding.reserved, bytes: [...Buffer.from(stdin, "utf-8")],
  };
  const captured = await runDirectoryEffectRunner(binding.handle)(captureIntent);
  if (!captured.ok) return { ok: false, result: { kind: "error", message: captured.error.message } };
  return captured.value.kind === "raw-transcript-captured"
    ? { ok: true, value: { semanticRaw: stdin, artifact: captured.value, alreadyCaptured } }
    : { ok: false, result: { kind: "error", message: "transcript capture reconciled to the wrong receipt kind" } };
}

async function dispatchSubmission(binding: SubmissionBinding, capture: CapturedSubmission): Promise<HookResult> {
  const { facadeRegistration, handle, panelRegistration, requestId, reserved } = binding;
  if (facadeRegistration?.kind === "standalone-review") {
    const driven = await resumeStandaloneFacade(handle, facadeRegistration);
    return driven.ok ? emitRunAction(handle, driven.action) : { kind: "error", message: driven.message };
  }
  if (facadeRegistration?.kind === "wave-gate") {
    if (reserved.program === "wave-gate") {
      const applied = await applyWaveFacadeSubmission(handle, reserved, capture.semanticRaw);
      if (!applied.ok) return { kind: "error", message: applied.message };
    }
    const driven = await resumeWaveGateFacade(handle, facadeRegistration);
    return driven.ok ? emitRunAction(handle, driven.action) : { kind: "error", message: driven.message };
  }
  if (panelRegistration !== null) {
    // bindSubmission proved `reserved` is exactly this request id and attempt.
    const driven = await submitRegisteredPanelAttempt(handle, panelRegistration, reserved, capture.semanticRaw);
    return driven.ok ? emitRunAction(handle, driven.action) : { kind: "error", message: driven.message };
  }
  process.stdout.write(`${JSON.stringify(capture.alreadyCaptured
    ? { kind: "already-captured", requestId, slotId: reserved.slotId, attempt: reserved.attempt }
    : { kind: "captured", requestId, artifact: capture.artifact }, null, 2)}\n`);
  return { kind: "allow" };
}

/**
 * The tool outputs a non-capturing harness delivered to the reviewer, read
 * from `--tool-outputs PATH` (a JSON array of strings, in delivery order), or
 * null when none were supplied. They pass through the SAME page verification
 * native capture uses (ADR-0022): a string counts only where it is an exact
 * reader page of the frozen diff, so this input grants no credit native
 * capture would not.
 */
function submittedToolOutputs(args: readonly string[]): Readonly<{ ok: true; value: readonly string[] | null }> | Readonly<{ ok: false; message: string }> {
  const path = argumentValue(args, "--tool-outputs");
  if (path === null) return { ok: true, value: null };
  let raw: unknown;
  try {
    const bytes = readRunBytesNoFollow(path, 64 * 1024 * 1024);
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    return { ok: false, message: `--tool-outputs ${path} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
    ? { ok: true, value: Object.freeze([...raw as string[]]) }
    : { ok: false, message: "--tool-outputs must be a JSON array of strings" };
}

/** Record the submitted attempt's read-coverage observation before its transcript, when the Run requires one. */
async function recordSubmittedReadCoverage(binding: SubmissionBinding, toolOutputs: readonly string[] | null): Promise<string | null> {
  if (binding.facadeRegistration?.kind !== "standalone-review" || binding.reserved.program !== "standalone-review") return null;
  const attempts = binding.handle.readCapturedAttempts();
  if (!attempts.ok) return attempts.error.message;
  if (attempts.value.has(captureKey(binding.reserved.slotId, binding.reserved.attempt))) return null;
  const policy = runReadCoverage(binding.handle);
  if (!policy.ok) return policy.error;
  if (policy.value === null) return toolOutputs === null ? null : "--tool-outputs applies only to a read-coverage standalone review";
  const recorded = await recordReadCoverageObservation(binding.handle, binding.reserved, toolOutputs);
  return recorded.ok ? null : recorded.error;
}

async function submitOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const binding = bindSubmission(args);
  if (!binding.ok) return binding.result;
  const toolOutputs = submittedToolOutputs(args);
  if (!toolOutputs.ok) return { kind: "error", message: toolOutputs.message };
  const coverage = await recordSubmittedReadCoverage(binding.value, toolOutputs.value);
  if (coverage !== null) return { kind: "error", message: coverage };
  const captured = await captureSubmission(binding.value, stdin);
  return captured.ok ? dispatchSubmission(binding.value, captured.value) : captured.result;
}

async function correlateOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return bound;
  const requestId = argumentValue(args, "--request");
  const harness = argumentValue(args, "--harness");
  const nativeId = argumentValue(args, "--native-id");
  if (requestId === null || (harness !== "pi" && harness !== "claude") || nativeId === null) {
    return { kind: "error", message: "--request, --harness (pi or claude), and --native-id are required" };
  }
  const issued = bound.value.handle.readIssuedRequests();
  if (!issued.ok) return { kind: "error", message: issued.error.message };
  const request = issued.value.find((candidate) => candidate.requestId === requestId);
  if (request === undefined) return { kind: "error", message: `request ${requestId} was never reserved in this run` };
  const agent = argumentValue(args, "--agent");
  if (agent === null || agent !== request.role) {
    return { kind: "error", message: `--agent must match reserved request role ${request.role}` };
  }
  const recorded = await bound.value.handle.recordHarnessCorrelator({
    schemaVersion: 1,
    harness,
    nativeId,
    requestId: request.requestId,
    role: request.role,
    attempt: request.attempt,
  });
  if (!recorded.ok) return { kind: "error", message: recorded.error.message };
  process.stdout.write(`${JSON.stringify({
    kind: "correlator-recorded",
    harness,
    nativeId,
    requestId: request.requestId,
    attempt: request.attempt,
  }, null, 2)}\n`);
  return { kind: "allow" };
}

async function completeOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return bound;
  const operationId = argumentValue(args, "--operation");
  if (operationId === null) {
    return { kind: "error", message: "--operation is required" };
  }
  if (argumentValue(args, "--outcome") !== null || argumentValue(args, "--error") !== null) {
    return { kind: "error", message: "deterministic engine operations do not accept caller-attested outcomes" };
  }
  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  const registration = stored.value === null ? null : parseRegisteredPanelProgram(stored.value);
  if (registration === null) return { kind: "error", message: "complete requires a registered panel program" };
  // Compatibility adapter for historical callers. New façade runs execute
  // deterministic operations inside start/resume/submit, so complete merely
  // proves the named operation belongs to the closed vocabulary and returns
  // the already-reconciled next external action.
  const allowed = registration.kind === "architecture"
    ? ["architecture-prepare-candidates", "architecture-prepare-judges", "architecture-aggregate"]
    : ["refutation-prepare-verifiers", "refutation-tally"];
  if (!allowed.includes(operationId)) {
    return { kind: "error", message: `operation ${operationId} does not belong to ${registration.kind}` };
  }
  const next = await driveRegisteredPanel(bound.value.handle, registration);
  if (!next.ok) return { kind: "error", message: next.message };
  return emitRunAction(bound.value.handle, next.action);
}

/**
 * Record a genuine user decision. The decision is durable evidence like any
 * other result, so it lands in the run directory rather than being applied
 * from memory — a crash between the decision and its effect re-reads it on
 * resume instead of losing it.
 */
type DecisionBinding = Readonly<{
  handle: RunDirHandle;
  decisionId: string;
  registration: Extract<FacadeRegistration, { kind: "wave-gate" }> | null;
}>;

function bindDecision(args: readonly string[]): Readonly<{ ok: true; value: DecisionBinding }> |
  Readonly<{ ok: false; result: HookResult }> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return { ok: false, result: bound };
  const registered = bound.value.handle.readProgramRegistration();
  if (!registered.ok) return { ok: false, result: { kind: "error", message: registered.error.message } };
  const parsed = registered.value === null ? null : parseRegisteredFacadeProgram(registered.value);
  if (parsed?.kind === "invalid") {
    return { ok: false, result: { kind: "error", message: `registered orchestration program is invalid: ${parsed.message}` } };
  }
  const facade = parsed?.kind === "registered" ? parsed.program : null;
  if (registered.value !== null && facade?.kind !== "wave-gate") {
    return { ok: false, result: { kind: "error", message: "this registered program does not accept user decisions" } };
  }
  const decisionId = argumentValue(args, "--request");
  return decisionId === null
    ? { ok: false, result: { kind: "error", message: "--request <decision-id> is required" } }
    : { ok: true, value: { handle: bound.value.handle, decisionId,
        registration: facade?.kind === "wave-gate" ? facade : null } };
}

function waveDecisionAuthorityError(binding: DecisionBinding): HookResult | null {
  if (binding.registration === null) return null;
  let graphRaw: unknown;
  try {
    graphRaw = JSON.parse(readFileSync(TASK_GRAPH_PATH, "utf8")) as unknown;
  } catch (error) {
    return { kind: "error", message: `cannot read protected Wave authority: ${error instanceof Error ? error.message : String(error)}` };
  }
  const graph = parseTaskGraph(graphRaw);
  if (!graph.ok) return { kind: "error", message: `protected Wave authority is invalid: ${graph.error}` };
  const mismatch = waveGateDecisionMismatch(
    graph.value, binding.registration, binding.handle.runId, binding.decisionId,
  );
  return mismatch === null ? null : { kind: "error", message: mismatch };
}

function parseUserDecision(stdin: string, waveDecision: boolean): Readonly<{ ok: true; value: object }> |
  Readonly<{ ok: false; result: HookResult }> {
  if (stdin.trim().length === 0) {
    return { ok: false, result: { kind: "error", message: "a decision must be supplied on stdin" } };
  }
  let decision: unknown;
  try {
    decision = JSON.parse(stdin) as unknown;
  } catch (error) {
    return { ok: false, result: { kind: "error", message: `decision must be valid JSON: ${error instanceof Error ? error.message : String(error)}` } };
  }
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
    return { ok: false, result: { kind: "error", message: "decision must be a JSON object" } };
  }
  if (waveDecision && (Object.keys(decision).length !== 1 || (decision as Record<string, unknown>).kind !== "approve")) {
    return { ok: false, result: { kind: "error", message: "Wave advisory decision must be exactly {\"kind\":\"approve\"}" } };
  }
  return { ok: true, value: decision };
}

async function decideOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const binding = bindDecision(args);
  if (!binding.ok) return binding.result;
  const authorityError = waveDecisionAuthorityError(binding.value);
  if (authorityError !== null) return authorityError;
  const decision = parseUserDecision(stdin, binding.value.registration !== null);
  if (!decision.ok) return decision.result;
  const { handle, decisionId, registration } = binding.value;
  await handle.appendEvent({
    schemaVersion: 1, sequence: 0,
    dedupKey: `decision:${createHash("sha256").update(decisionId).digest("hex")}`,
    recordedAtMs: Date.now(), event: { kind: "user-decision-recorded", decisionId, decision: decision.value },
  });
  if (registration !== null) {
    const driven = await resumeWaveGateFacade(handle, registration);
    return driven.ok ? emitRunAction(handle, driven.action) : { kind: "error", message: driven.message };
  }
  process.stdout.write(`${JSON.stringify({ kind: "decision-recorded", decisionId }, null, 2)}\n`);
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];
  if (!isOperation(operation)) return usage();
  const rest = args.slice(1);

  switch (operation) {
    case "status":
      return argumentValue(rest, "--run") === null ? statusOperation(rest) : inspectOperation(rest);
    case "inspect":
      return inspectOperation(rest);
    case "brief":
      return briefOperation(rest);
    case "abandon":
      return abandonOperation(rest);
    case "start":
      return startOperation(stdin, rest);
    case "restart":
      return restartOperation(rest);
    case "recover-orphan":
      return recoverOrphanOperation(rest);
    case "resume":
      return resumeOperation(rest);
    case "submit":
      return submitOperation(stdin, rest);
    case "correlate":
      return correlateOperation(rest);
    case "complete":
      return completeOperation(rest);
    case "decide":
      return decideOperation(stdin, rest);
    case "remediate":
      return remediateOperation(rest);
    case "attest":
      return attestOperation(rest);
  }
};

export default handler;
