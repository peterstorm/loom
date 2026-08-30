/**
 * Loom Pi Extension
 *
 * Bridges Loom's orchestration engine to Pi's extension API.
 * Reuses engine core decisions while owning Pi-specific adapter and handler policy.
 */

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Engine core — harness-agnostic, no Claude Code dependency (these do fs I/O)
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
// The roster read the direct-edit gate needs. It lives in the handler rather
// than in core/ because core may not import the machine's filesystem shell;
// Pi passes the same adapter Claude Code's wrapper does, so both harnesses
// authorize `pi-grant-` capability tokens off the SAME roster.
import { activeRosterProbe } from "../engine/src/handlers/pre-tool-use/block-direct-edits";
import { guardStateFileDecision } from "../engine/src/core/guard-state-file";
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
import { reconcileWaveBlock } from "../engine/src/core/wave-gate-model";
// Both harnesses share ONE protected-state read seam, so a Pi gate and a
// Claude gate cannot disagree about what "no active plan" means.
import { realPhaseOrderDeps } from "../engine/src/handlers/pre-tool-use/validate-phase-order";
import {
  type TaskExecutionRosterObservation,
  type TaskExecutionSpawn,
} from "../engine/src/core/validate-task-execution";
import {
  registerTaskExecutionBatch,
  rollbackTaskExecutionRegistration,
} from "../engine/src/handlers/task-execution";
import { validateTemplateSubstitution } from "../engine/src/core/validate-template-substitution";
import { admitPiSpawnBatch, MAX_PI_ORCHESTRATION_BATCH_SIZE } from "../engine/src/core/spawn-admission";


// Engine SubagentStop logic (harness-agnostic functions already exported)
import { settleUnavailableImplementation } from "../engine/src/core/implementation-application";
import {
  applyReviewResolution,
  hasStandaloneReviewContext,
} from "../engine/src/core/review-output";

// The per-result appliers. Each concern the `tool_result` handler used to hold
// inline is one named, port-injected function there; this file dispatches.
import {
  applyFailedPiResult,
  applyImplementationPiResult,
  applyPhaseAgentPiResult,
  applyReviewPiResult,
  applySpecCheckPiResult,
  currentPiReviewAuthority,
  currentPiSpecCheckAuthority,
  piAllSlotsFailedNote,
  piReviewAuthorityProblem,
  piSpecCheckAuthorityProblem,
  parsePiSubagentResults,
  piSubagentFailureSignals,
  piSubagentResultFailed,
  type PiResultOutcome,
  type PiReviewAttemptAuthority,
  type PiSpecCheckAttemptAuthority,
  type PiSubagentResultEntry,
  type RepositoryProbe,
  type TaskGraphStore,
} from "./subagent-result";

// `isReviewAgent` lives in `config`, NOT in `core/review-output` beside the
// review-output helpers above: it reads the review-agent roster, and `core/review-output`
// declares itself free of config so its parse/merge rules stay pure. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook below, not just review capture. `engine/tests/pi-imports.test.ts`
// resolves every engine import in this file against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, taskGraphPath, subagentDir, PHASE_AGENT_MAP, IMPL_AGENTS, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS, probePathFailClosed } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import type { Task, TaskGraph } from "../engine/src/types";
import {
  anyActiveSubagent,
  bindSessionTaskGraphPointer,
  fsSessionRegistry,
  parseAgentId,
  parseSessionId,
  rollbackSessionTaskGraphPointer,
  rosterAgentId,
  type SessionTaskGraphPointerBinding,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { buildContextOutput } from "../engine/src/handlers/session-start/resume-after-clear";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import {
  alignPiImplementationAuthorities,
  classifyMissingReservedResults,
  unrecordableMissingEvidenceDiagnostic,
} from "./reserved-results";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import * as git from "../engine/src/utils/git";

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import { parsePiMessages, piResultFinalPayloadCandidates } from "./transcript-adapter";
// FR-033: Pi and Claude Code capture each completed reviewer/verifier output
// into the SAME engine-declared slot under the same refusals. Both drive this
// one runtime; only the native correlator and the payload observation differ.
import {
  captureAuditLine,
  captureHarnessResult,
  RUN_DIR_ENV,
  describeCaptureFailure,
  resolveCorrelatedRequest,
  RUNS_ROOT_ENV,
  terminalizeCaptureRejection,
  type CaptureOutcome,
  type CorrelatedRequestResolution,
} from "../engine/src/orchestration/harness-capture-runtime";
import { openRunDirectory, type RunDirHandle } from "../engine/src/orchestration/run-directory-handle";
import {
  parseRegisteredFacadeProgram,
  readStandaloneReviewedSource,
  renderSpawnTask,
  replayStandaloneResultFromEvidence,
  type StandaloneReviewedSource,
} from "../engine/src/handlers/helpers/programs";
import {
  assertAnchoredFilesystemPlatformSupported,
  readRunBytesNoFollow,
} from "../engine/src/orchestration/no-follow-fs";
import {
  readSessionRunBindings,
  type SessionRunBinding,
} from "../engine/src/orchestration/session-run-bindings";
import { captureKey, type CaptureKey } from "../engine/src/core/harness-capture";
import {
  parseArtifactDigest,
  parseContextDigest,
  type ArtifactDigest,
  type ContextDigest,
} from "../engine/src/core/orchestration-contract";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
} from "../engine/src/core/implementation-completion";
import { materializePiResources } from "./resources";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import { buildPiRoutingContext } from "../engine/src/utils/model-routing-context";
import { planPiWriteGrants } from "../engine/src/core/pi-write-grant-plan";
import {
  consumePiWriteGrant,
  injectPiWriteGrant,
  issuePiWriteGrant,
  revokePiWriteGrant,
  sweepExpiredPiWriteGrants,
  writeTargetViolatesScope,
  type IssuedWriteGrant,
} from "./write-grant";
import {
  captureLoomRuntimeIdentity,
  loadedRuntimeCompatibility,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../engine/src/runtime-compatibility";
import {
  LOOM_INTERACTIVE_SUBAGENT_TOOL,
  registerInteractiveSubagentTool,
} from "./interactive-subagent";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Capture once, while this extension module is loaded. Fresh CLI processes
// hash the checkout again before mutation; a changed checkout therefore cannot
// write a schema this in-memory runtime may not parse.
const LOADED_RUNTIME_IDENTITY = captureLoomRuntimeIdentity(PACKAGE_ROOT);
// Also frozen at load. Correct under Pi, which sets the environment before it
// loads any extension — but it makes the FIRST import of this module in a
// process binding, which matters under `bun test`, where all files share one
// process: a test file that imports this module before `pi-extension-review-
// events.test.ts` sets `PI_CODING_AGENT_DIR` pins the real `~/.pi` for the
// whole run and every agent-definition check there resolves the wrong catalog.
// Keep unit tests of this file's pure helpers importing `pi/subagent-result`,
// which reads no environment, rather than pulling this module in early.
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_RESOURCE_CACHE = join(PI_AGENT_DIR, "cache", "loom-resources");
const isPiSpawnTool = (toolName: string): boolean =>
  toolName === "subagent" || toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL;

const LOOM_REVIEW_AUTHORITY_SYMBOL = Symbol.for("@peterstorm/loom/review-authority/v1");

type TrustedReviewCapture = Readonly<{
  requestId: string;
  slotId: string;
  attempt: 1 | 2;
  role: string;
  /** Branded, because this proof compares two 64-hex fields: as plain strings
   *  the context digest and the transcript digest were mutually interchangeable
   *  at the construction site, which is the one place a swap must be impossible.
   */
  contextDigest: ContextDigest;
  digest: ArtifactDigest;
  byteLength: number;
}>;

type TrustedReviewRun = Readonly<{
  binding: SessionRunBinding;
  captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>;
  touchedAt: number;
}>;

type TrustedReviewRoot = Readonly<{
  nextTouch: number;
  runs: ReadonlyMap<string, TrustedReviewRun>;
}>;

type LoomReviewAuthorityReceipt = Readonly<{
  schemaVersion: 1;
  kind: "loom-review-authority-receipt";
  sessionId: string;
  runId: string;
  runsRoot: string;
  runDirectory: string;
  requestIds: readonly string[];
  resultDigest: string;
  reviewedSource: StandaloneReviewedSource;
}>;

const trustedReviewRuns = new Map<string, Map<string, TrustedReviewRoot>>();
const trustedRunIdentity = ({ runsRoot, runDirectory }: Pick<SessionRunBinding, "runsRoot" | "runDirectory">): string =>
  `${runsRoot}\0${runDirectory}`;

/**
 * Fail-closed path existence check. Returns `true` (assume active) for any
 * access error other than ENOENT — prevents EACCES, ELOOP, and other
 * non-absence errors from silently disabling orchestration guards. Delegates
 * to the shared core in config (`probePathFailClosed`): the ENOENT-only-
 * absent semantics have one home; only the operator line stays Pi-specific,
 * and it is regex-pinned by the ELOOP regression test.
 */
function pathExistsFailClosed(path: string): boolean {
  return probePathFailClosed(path, (p, cause) =>
    `loom(pi): pathExistsFailClosed cannot access ${p}: ${cause} — assuming active (fail closed)`);
}

export type PiResumeTaskGraphObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "loaded"; state: ReturnType<StateManager["load"]> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Observe resume authority once; only a proven missing State File is absent. */
export function observePiResumeTaskGraph(
  resolvePath: () => string = taskGraphPath,
  exists: (path: string) => boolean = pathExistsFailClosed,
  open: (path: string) => StateManager | null = StateManager.fromPath,
): PiResumeTaskGraphObservation {
  let path: string;
  try {
    path = resolvePath();
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: `task graph path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    if (!exists(path)) return Object.freeze({ kind: "absent" });
    const manager = open(path);
    if (manager === null) {
      return Object.freeze({ kind: "unavailable", reason: `task graph could not be opened at ${path}` });
    }
    return Object.freeze({ kind: "loaded", state: manager.load() });
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: `task graph unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

const isLoomOwnedResultAgent = (agentType: string): boolean =>
  PHASE_AGENT_MAP[agentType] !== undefined ||
  IMPL_AGENTS.has(agentType) ||
  isReviewAgent(agentType) ||
  agentType === "spec-check-invoker";

const PI_AGENT_ID_MARKER = /<!-- LOOM_PI_AGENT_ID:([a-z0-9-]+) -->/g;
const PI_WRITE_GRANT_MARKER = /<!-- LOOM_PI_WRITE_GRANT:[0-9a-f]{64} -->/;

export function rejectedChildWriteGrantBlock(rejected: boolean): Readonly<{ block: true; reason: string }> | null {
  return rejected
    ? { block: true, reason: "Loom Pi write grant was rejected for this session; direct edits remain blocked." }
    : null;
}

export function piSystemAgentIdentity(systemPrompt: string): string {
  PI_AGENT_ID_MARKER.lastIndex = 0;
  const matches = [...systemPrompt.matchAll(PI_AGENT_ID_MARKER)];
  if (matches.length !== 1) throw new Error("child system prompt must contain exactly one Loom Pi agent identity");
  return matches[0]![1]!;
}

/** The raw batch entry at `index`, whichever spawn shape the caller used
 *  (`tasks`, `chain`, or a bare single entry). Returned by reference: callers
 *  such as `replacePiSpawnTask` write its `task` field in place. */
function piSpawnItem(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  let entries: unknown[];
  if (Array.isArray(raw.tasks)) {
    entries = raw.tasks;
  } else if (Array.isArray(raw.chain)) {
    entries = raw.chain;
  } else {
    entries = [raw];
  }
  const entry = entries[index];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`missing Pi spawn item ${index}`);
  }
  return entry as Record<string, unknown>;
}

export function piSpawnCwd(raw: unknown, index: number, defaultCwd: string): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Pi subagent input must be an object before cwd resolution");
  }
  const input = raw as Record<string, unknown>;
  const entry = piSpawnItem(input, index);
  let cwd: string;
  if (typeof entry.cwd === "string") {
    cwd = entry.cwd;
  } else if (typeof input.cwd === "string") {
    cwd = input.cwd;
  } else {
    cwd = defaultCwd;
  }
  return resolve(defaultCwd, cwd);
}

/** The string command carried by a well-formed Pi bash call. Malformed
 * external input remains distinguishable so an armed state-file guard can fail
 * closed instead of treating input-shape drift as an allowed empty command. */
export function piBashCommand(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const command = (raw as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

export type PiWriteTargetPathsResult =
  | Readonly<{ ok: true; value: readonly [string, ...string[]] }>
  | Readonly<{ ok: false; error: string }>;

const writeTarget = (input: Record<string, unknown>, path: string): PiWriteTargetPathsResult => {
  const target = input.path ?? input.file_path ?? input.filePath;
  return typeof target === "string" && target !== ""
    ? Object.freeze({ ok: true, value: Object.freeze([target]) as readonly [string] })
    : Object.freeze({ ok: false, error: `${path} must name one non-empty path, file_path, or filePath target` });
};

/** Parse every target before a scoped write can proceed; no partial batch exists. */
export function piWriteTargetPaths(raw: unknown): PiWriteTargetPathsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Object.freeze({ ok: false, error: "write input must be a plain object" });
  }
  const input = raw as Record<string, unknown>;
  if ("path" in input || "file_path" in input || "filePath" in input) return writeTarget(input, "write input");
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return Object.freeze({ ok: false, error: "write input must contain a target or a non-empty edits array" });
  }
  const paths: string[] = [];
  for (const [index, edit] of input.edits.entries()) {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
      return Object.freeze({ ok: false, error: `write input.edits[${index}] must be a plain object` });
    }
    const parsed = writeTarget(edit as Record<string, unknown>, `write input.edits[${index}]`);
    if (!parsed.ok) return parsed;
    const target = parsed.value[0];
    if (!paths.includes(target)) paths.push(target);
  }
  return Object.freeze({ ok: true, value: Object.freeze(paths) as readonly [string, ...string[]] });
}

export function replacePiSpawnTask(raw: unknown, index: number, task: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Pi subagent input must be an object before write-grant injection");
  }
  const input = raw as Record<string, unknown>;
  piSpawnItem(input, index).task = task;
}

/** Stable per-spawn roster identity shared by tool_call and tool_result.
 *  Task text is deliberately excluded: Pi substitutes `{previous}` in chain
 *  results, so it is not stable across the lifecycle. */
export const piSpawnRosterId = (
  toolCallId: unknown,
  index: number,
  agent: string,
) => rosterAgentId(JSON.stringify([
  typeof toolCallId === "string" ? toolCallId : "",
  index,
  agent,
]));

type PiOrchestrationMarkers = Readonly<{
  requestId: string;
  contextDigest: string;
}>;

function orchestrationMarkers(task: string, item: string): PiOrchestrationMarkers | null {
  const requestIds = [...task.matchAll(/^LOOM_REQUEST_ID:[ \t]*(\S+)[ \t]*$/gm)].map((match) => match[1]!);
  const contextDigests = [...task.matchAll(/^LOOM_CONTEXT_DIGEST:[ \t]*(\S+)[ \t]*$/gm)].map((match) => match[1]!);
  if (requestIds.length === 0 && contextDigests.length === 0) return null;
  if (requestIds.length !== 1 || contextDigests.length !== 1) {
    throw new Error(`${item} must carry exactly one LOOM_REQUEST_ID and one LOOM_CONTEXT_DIGEST authority marker`);
  }
  return Object.freeze({ requestId: requestIds[0]!, contextDigest: contextDigests[0]! });
}

function rememberTrustedReviewCapture(
  sessionId: string,
  binding: SessionRunBinding,
  role: string,
  task: string,
  outcome: Extract<CaptureOutcome, { kind: "captured" }>,
): void {
  const markers = orchestrationMarkers(task, `captured ${outcome.receipt.requestId}`);
  if (markers === null || markers.requestId !== outcome.receipt.requestId) {
    throw new Error(`captured request ${outcome.receipt.requestId} is missing its exact task authority markers`);
  }
  const contextDigest = parseContextDigest(markers.contextDigest);
  if (!contextDigest.ok) {
    throw new Error(`captured request ${outcome.receipt.requestId} carries an invalid context marker: ${contextDigest.error.message}`);
  }
  const digest = parseArtifactDigest(outcome.receipt.digest);
  if (!digest.ok) {
    throw new Error(`captured request ${outcome.receipt.requestId} carries an invalid receipt digest: ${digest.error.message}`);
  }
  const sessionRoots = trustedReviewRuns.get(sessionId) ?? new Map<string, TrustedReviewRoot>();
  trustedReviewRuns.set(sessionId, sessionRoots);
  const rootIdentity = resolve(binding.runsRoot);
  const root = sessionRoots.get(rootIdentity) ?? Object.freeze({
    nextTouch: 1,
    runs: new Map<string, TrustedReviewRun>(),
  });
  const identity = trustedRunIdentity(binding);
  const previousRun = root.runs.get(identity);
  const captures = new Map(previousRun?.captures ?? []);
  captures.set(
    captureKey(outcome.receipt.slotId, outcome.receipt.attempt),
    Object.freeze({
      requestId: outcome.receipt.requestId,
      slotId: outcome.receipt.slotId,
      attempt: outcome.receipt.attempt,
      role,
      contextDigest: contextDigest.value,
      digest: digest.value,
      byteLength: outcome.receipt.byteLength,
    }),
  );
  const runs = new Map(root.runs);
  runs.set(identity, Object.freeze({ binding, captures, touchedAt: root.nextTouch }));
  sessionRoots.set(rootIdentity, Object.freeze({ nextTouch: root.nextTouch + 1, runs }));
}

function environmentRunBinding(): SessionRunBinding | null {
  const runsRoot = process.env[RUNS_ROOT_ENV];
  const runDirectory = process.env[RUN_DIR_ENV];
  if (runsRoot === undefined && runDirectory === undefined) return null;
  if (runsRoot === undefined || runDirectory === undefined) {
    throw new Error("Pi orchestration requires both run-root and run-directory authority");
  }
  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) throw new Error(issued.error.message);
  return Object.freeze({
    ...opened.value.identity,
    requestIds: Object.freeze(issued.value.map(({ requestId }) => requestId)),
    resultDigest: null,
  });
}

function sessionRunBinding(
  rawSessionId: string,
  markers: readonly PiOrchestrationMarkers[],
): SessionRunBinding {
  const bindings = readSessionRunBindings(subagentDir(), rawSessionId);
  if (!bindings.ok) throw new Error(bindings.message);
  const requestIds = new Set(markers.map(({ requestId }) => requestId));
  const candidates = bindings.value.filter((binding) =>
    [...requestIds].every((requestId) => binding.requestIds.some((candidate) => candidate === requestId))
  );
  const matches = candidates.filter((binding) => {
    const opened = openRunDirectory(binding.runsRoot, binding.runDirectory);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok) throw new Error(issued.error.message);
    return markers.every((marker) => issued.value.some((request) =>
      request.requestId === marker.requestId && request.contextDigest === marker.contextDigest));
  });
  if (matches.length !== 1) {
    const identities = markers.map(({ requestId, contextDigest }) => `${requestId}@${contextDigest}`).join(", ");
    throw new Error(
      matches.length === 0
        ? `no Pi session run binding contains issued request/context authority ${identities}`
        : `multiple Pi session run bindings contain issued request/context authority ${identities}`,
    );
  }
  return matches[0]!;
}

/**
 * Record Pi spawn correlators into their reserved run-directory slots before dispatch.
 *
 * Pi's native correlator is `piSpawnRosterId(toolCallId, index, agent)` — the
 * same stable per-spawn identity the lifecycle registry already uses, and the
 * only thing available on both the spawn and result sides of a Pi batch. The
 * spawn side records it beside the reservation.
 *
 * What an ABSENT correlator means then depends on whether this result is bound
 * to a run at all. An unbound agent (no session run binding, no request markers)
 * belongs to nobody's run and is left alone — that is the ordinary ad-hoc case,
 * not a failure. A REQUEST-BOUND result whose correlator cannot be resolved is
 * the opposite: `piResultAuthorityProblem` names it, the result loop records it
 * as a processing error, and `persistCaptureRejection` terminalises the
 * reservation, because a run directory exists precisely to collect that result.
 *
 * This is a fail-spawn boundary and therefore throws when exact run/request
 * authority cannot be recorded. The tool-call guard catches the failure,
 * rolls back lifecycle reservations, and refuses dispatch.
 */
export async function recordPiSpawnCorrelators(
  items: readonly Readonly<{ agent: string; task: string }>[],
  rosterIds: readonly string[],
  rawSessionId: string,
  rawInput: unknown,
): Promise<SessionRunBinding | null> {
  if (items.length !== rosterIds.length) throw new Error("Pi correlator roster length does not match spawn batch");
  const parsedMarkers = items.map((item, index) =>
    orchestrationMarkers(item.task, `Pi spawn item ${index + 1}/${item.agent}`));
  const marked = parsedMarkers.filter((markers): markers is PiOrchestrationMarkers => markers !== null);
  const explicit = environmentRunBinding();
  if (marked.length === 0 && explicit === null) return null;
  if (marked.length !== items.length) {
    throw new Error("Pi orchestration spawn batch must not mix request-bound and unbound items");
  }
  const runBinding = explicit ?? sessionRunBinding(rawSessionId, marked);
  const opened = openRunDirectory(runBinding.runsRoot, runBinding.runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) throw new Error(issued.error.message);
  const captured = opened.value.readCapturedAttempts();
  if (!captured.ok) throw new Error(captured.error.message);
  const available = issued.value.filter(
    (request) => !captured.value.has(captureKey(request.slotId, request.attempt)),
  );
  const consumed = new Set<string>();
  const canonicalTasks: string[] = [];

  for (const [index, item] of items.entries()) {
    const markers = parsedMarkers[index]!;
    if (markers === null) throw new Error("Pi orchestration marker completeness invariant failed");
    const exactRequestId = markers.requestId;
    const request = available.find((candidate) => candidate.requestId === exactRequestId);
    if (request === undefined || consumed.has(request.requestId)) {
      throw new Error(`issued request ${exactRequestId} is unavailable for Pi spawn item ${index + 1}/${item.agent}`);
    }
    if (request.role !== item.agent) {
      throw new Error(`issued request ${exactRequestId} belongs to ${request.role}, not Pi spawn item role ${item.agent}`);
    }
    if (request.contextDigest !== markers.contextDigest) {
      throw new Error(`issued request ${exactRequestId} context digest does not match the Pi spawn marker`);
    }
    const nativeId = rosterIds[index];
    if (nativeId === undefined) throw new Error(`Pi spawn item ${index + 1} has no native correlator`);
    const recorded = await opened.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId,
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    canonicalTasks[index] = renderSpawnTask(
      opened.value,
      request,
      "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required result.",
      { standalone: hasStandaloneReviewContext(item.task) },
    );
    consumed.add(request.requestId);
  }
  for (const [index, task] of canonicalTasks.entries()) replacePiSpawnTask(rawInput, index, task);
  return runBinding;
}

/** Resolve one Pi result through the shared harness correlation protocol. */
function piRequestCorrelation(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
): CorrelatedRequestResolution {
  return resolveCorrelatedRequest({
    harness: "pi",
    runsRoot: runBinding.runsRoot,
    runDirectory: runBinding.runDirectory,
    nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType),
  });
}

/**
 * Terminalise one Pi-side capture refusal against its exact reservation.
 *
 * Only the CORRELATION step is Pi-specific here; the tombstone, the journal
 * record, and the audit outcome come from `terminalizeCaptureRejection`, so the
 * two harnesses cannot disagree about what a refusal durably means. Returns the
 * operator-facing failure text, or null when the refusal was recorded cleanly.
 */
async function recordPiRequestCaptureRejection(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  diagnostic: string,
): Promise<string | null> {
  const correlation = piRequestCorrelation(runBinding, toolCallId, resultIndex, agentType);
  if (!correlation.ok) {
    const unresolved = correlation.outcome;
    if (unresolved.kind === "no-reservation") {
      return `cannot resolve correlator for ${agentType}[${resultIndex}]: no binding found`;
    }
    if (unresolved.kind === "not-an-orchestration-run") {
      return `cannot open run directory ${runBinding.runDirectory}: orchestration run authority was unavailable`;
    }
    if (unresolved.kind === "captured") {
      return `cannot resolve correlator for ${agentType}[${resultIndex}]: correlation returned a capture receipt`;
    }
    switch (unresolved.reason) {
      case "run-directory":
        return `cannot open run directory ${runBinding.runDirectory}: ${unresolved.message}`;
      case "correlator":
        return `cannot resolve correlator for ${agentType}[${resultIndex}]: ${unresolved.message}`;
      case "requests":
        return `cannot read issued requests: ${unresolved.message}`;
      case "unknown-request":
        return unresolved.message;
      default:
        return describeCaptureFailure(unresolved);
    }
  }

  const outcome = await terminalizeCaptureRejection(
    correlation.value.handle,
    correlation.value.request,
    { diagnostic },
  );
  return outcome.kind === "rejected" &&
      (outcome.reason === "rejection-persistence" || outcome.reason === "rejection-audit-unsynchronized")
    ? `${agentType}[${resultIndex}] ${outcome.message}`
    : null;
}

function piResultAuthorityProblem(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  markers: PiOrchestrationMarkers,
): string | null {
  const correlation = piRequestCorrelation(runBinding, toolCallId, resultIndex, agentType);
  if (!correlation.ok) {
    const unresolved = correlation.outcome;
    if (unresolved.kind === "no-reservation") {
      return `no durable Pi correlator exists for result index ${resultIndex}`;
    }
    if (unresolved.kind === "not-an-orchestration-run") {
      return "orchestration run authority was unavailable";
    }
    return unresolved.kind === "captured"
      ? "correlation returned a capture receipt instead of request authority"
      : unresolved.message;
  }
  const { request } = correlation.value;
  if (request.requestId !== markers.requestId) {
    return `result marker ${markers.requestId} does not match correlated request ${request.requestId}`;
  }
  return request.contextDigest === markers.contextDigest
    ? null
    : `result context marker does not match correlated request ${request.requestId}`;
}

export async function capturePiSubagentResult(
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  messages: unknown,
  runBinding: SessionRunBinding | null = null,
): Promise<CaptureOutcome> {
  try {
    const candidates = piResultFinalPayloadCandidates(messages ?? []);
    const runsRoot = runBinding?.runsRoot ?? process.env[RUNS_ROOT_ENV];
    const runDirectory = runBinding?.runDirectory ?? process.env[RUN_DIR_ENV];
    const hasRunAuthority = runsRoot !== undefined || runDirectory !== undefined;
    const outcome: CaptureOutcome = !candidates.ok && hasRunAuthority
      ? {
          kind: "rejected",
          reason: "transcript-shape",
          message: candidates.errors.join("; "),
        }
      : await captureHarnessResult({
          harness: "pi",
          runsRoot,
          runDirectory,
          nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType),
          candidates: candidates.ok ? candidates.value : [],
        });
    const audit = captureAuditLine("loom(pi): capture-orchestration-result", outcome);
    if (audit !== null) process.stderr.write(audit);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`loom(pi): capture-orchestration-result crashed for ${agentType}: ${message}\n`);
    return { kind: "rejected", reason: "capture-crashed", message };
  }
}

export interface PiCleanupAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

/** Run every cleanup action even when an earlier capability/roster operation fails. */
export async function runPiCleanupActions(
  actions: readonly PiCleanupAction[],
): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      errors.push(`${action.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

const cleanupFailureSuffix = (errors: readonly string[]): string =>
  errors.length === 0 ? "" : ` Cleanup failures: ${errors.join("; ")}`;

type PiWriteGrantInjectionPorts = Readonly<{
  inject(task: string, grant: IssuedWriteGrant): string;
  revoke(token: string): void | Promise<void>;
}>;

/** Inject an issued capability without allowing failed direct revocation to hide the injection cause. */
export async function injectPiWriteGrantWithRevocation(
  task: string,
  grant: IssuedWriteGrant,
  spawnIndex: number,
  ports: PiWriteGrantInjectionPorts = {
    inject: injectPiWriteGrant,
    revoke: revokePiWriteGrant,
  },
): Promise<string> {
  try {
    return ports.inject(task, grant);
  } catch (injectionError) {
    const cleanupErrors = await runPiCleanupActions([{
      label: `directly revoke write grant for spawn item ${spawnIndex + 1}`,
      run: () => ports.revoke(grant.token),
    }]);
    throw new Error(
      `write-grant injection failed: ${injectionError instanceof Error ? injectionError.message : String(injectionError)}` +
        cleanupFailureSuffix(cleanupErrors),
      { cause: injectionError },
    );
  }
}

type PiSessionId = NonNullable<ReturnType<typeof parseSessionId>>;

type PiSpawnReservation = Readonly<{
  sessionId: PiSessionId;
  needsTaskGraphLifecycle: boolean;
  /**
   * Was a Loom task graph active for this session when the batch was spawned?
   *
   * Recorded at spawn because the RESULT side cannot infer it: "no task graph
   * now" is both the ad-hoc case (there was never one, so there is nothing to
   * apply) and the corruption case (one existed and vanished mid-run, so real
   * completion evidence is being dropped). Collapsing them made every ad-hoc
   * spawn report `completion was NOT applied` as a failure. Keeping the spawn
   * instant's answer lets the result side stay silent for the first and keep
   * failing loudly for the second.
   */
  graphActiveAtSpawn: boolean;
  orchestrationRunBinding: SessionRunBinding | null;
  pointerBinding: SessionTaskGraphPointerBinding | null;
  items: readonly Readonly<{
    agentType: string;
    rosterId: AgentId;
    taskId: string | null;
    implementationAuthority: ImplementationAttemptAuthority | null;
    reviewAuthority: PiReviewAttemptAuthority | null;
    specCheckAuthority: PiSpecCheckAttemptAuthority | null;
    /** The closed lifecycle union, not an independent boolean pair: two
     *  booleans admitted the impossible {implementation: true, standalone:
     *  true} and left the third lifecycle state nameless. The source union's
     *  exhaustiveness carries through the adapter. */
    kind: TaskExecutionSpawn["kind"];
  }>[];
}>;

/**
 * Did this batch run outside orchestration entirely?
 *
 * True only when a reservation PROVES no task graph was active at spawn. An
 * absent reservation (unknown provenance, legacy call, recovery failure)
 * answers false, so every existing missing-state diagnostic keeps firing —
 * this predicate can only silence a case it can positively account for.
 */
function spawnedWithoutTaskGraph(reservation: PiSpawnReservation | undefined): boolean {
  return reservation !== undefined && !reservation.graphActiveAtSpawn;
}

function reservedImplementationFailure(
  expectedAgent: string,
  expectedTaskId: string,
  authorityTaskId: string,
  entry: PiSubagentResultEntry | undefined,
): string | null {
  if (entry === undefined) return "reserved implementation result was missing";
  if (!entry.ok) return `reserved implementation result was malformed: ${entry.problem}`;
  const resultAgent = stripNamespace(entry.result.agent);
  if (resultAgent !== expectedAgent) {
    return `reserved ${expectedAgent} result was returned as ${resultAgent}`;
  }
  const parsedMessages = parsePiMessages(entry.result.messages);
  if (!parsedMessages.ok) {
    return `reserved implementation transcript was malformed: ${parsedMessages.errors.join("; ")}`;
  }
  const returnedTaskId = extractTaskId(entry.result.task);
  if (returnedTaskId === null || returnedTaskId !== expectedTaskId || returnedTaskId !== authorityTaskId) {
    return `reserved implementation result Task identity mismatch: returned=${returnedTaskId ?? "missing"}, ` +
      `reserved=${expectedTaskId}, authority=${authorityTaskId}`;
  }
  return piSubagentResultFailed(entry.result)
    ? `${expectedAgent} failed before implementation evidence completed`
    : null;
}

function recoverPiSpawnReservation(
  rawSessionId: string,
  toolCallId: string,
): PiSpawnReservation | null {
  const sessionId = parseSessionId(rawSessionId);
  if (sessionId === null) throw new Error(`invalid Pi result session id ${JSON.stringify(rawSessionId)}`);
  const bindings = readSessionRunBindings(subagentDir(), sessionId);
  if (!bindings.ok) throw new Error(bindings.message);
  const recovered: PiSpawnReservation[] = [];
  const inaccessibleBindings: string[] = [];

  for (const binding of bindings.value) {
    const opened = openRunDirectory(binding.runsRoot, binding.runDirectory);
    if (!opened.ok) {
      inaccessibleBindings.push(`${binding.runId}: ${opened.error.message}`);
      continue;
    }
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok) {
      inaccessibleBindings.push(`${binding.runId}: ${issued.error.message}`);
      continue;
    }
    const eligible = issued.value.filter((request) =>
      binding.requestIds.some((requestId) => requestId === request.requestId));
    const byIndex = new Map<number, { agentType: string; rosterId: AgentId }>();
    let correlatorFailure: string | null = null;
    for (const request of eligible) {
      for (let index = 0; index < MAX_PI_ORCHESTRATION_BATCH_SIZE; index += 1) {
        const nativeId = piSpawnRosterId(toolCallId, index, request.role);
        const correlator = opened.value.readHarnessCorrelator("pi", nativeId);
        if (!correlator.ok) {
          correlatorFailure = correlator.error.message;
          break;
        }
        if (correlator.value?.requestId !== request.requestId) continue;
        const previous = byIndex.get(index);
        if (previous !== undefined && previous.rosterId !== nativeId) {
          throw new Error(`Pi tool call ${toolCallId} has conflicting durable correlators at result index ${index}`);
        }
        byIndex.set(index, { agentType: request.role, rosterId: nativeId });
      }
      if (correlatorFailure !== null) break;
    }
    if (correlatorFailure !== null) {
      inaccessibleBindings.push(`${binding.runId}: ${correlatorFailure}`);
      continue;
    }
    if (byIndex.size === 0) continue;
    const indexes = [...byIndex.keys()].sort((left, right) => left - right);
    if (indexes.some((index, ordinal) => index !== ordinal)) {
      throw new Error(`Pi tool call ${toolCallId} durable correlators do not form a contiguous result roster`);
    }
    recovered.push(Object.freeze({
      sessionId,
      needsTaskGraphLifecycle: false,
      // A durably recovered reservation exists because a run directory issued
      // it, so it is orchestration work by construction. The spawn instant is
      // unrecoverable here, and `true` is the fail-closed answer: it keeps
      // every missing-state diagnostic loud rather than silencing one on a
      // guess.
      graphActiveAtSpawn: true,
      orchestrationRunBinding: binding,
      pointerBinding: null,
      items: Object.freeze(indexes.map((index) => {
        const item = byIndex.get(index)!;
        return Object.freeze({
          agentType: item.agentType,
          rosterId: item.rosterId,
          taskId: null,
          implementationAuthority: null,
          reviewAuthority: null,
          specCheckAuthority: null,
          kind: "standalone" as const,
        });
      })),
    }));
  }
  if (recovered.length > 1) {
    throw new Error(`Pi tool call ${toolCallId} is bound to multiple orchestration runs`);
  }
  if (inaccessibleBindings.length > 0) {
    throw new Error(
      `Pi tool call ${toolCallId} could not be recovered unambiguously; inaccessible session bindings: ${inaccessibleBindings.join("; ")}`,
    );
  }
  return recovered[0] ?? null;
}

interface PiParentSessionRuntime {
  readonly issuedWriteGrants: Map<string, readonly string[]>;
  readonly spawnReservations: Map<string, PiSpawnReservation>;
}

const emptyParentSessionRuntime = (): PiParentSessionRuntime => ({
  issuedWriteGrants: new Map(),
  spawnReservations: new Map(),
});

export function standaloneCompletionCheckpointProblem(checkpoint: string): string | null {
  try {
    const parsed = JSON.parse(checkpoint) as { kind?: unknown };
    return parsed.kind === "done" ? null : "review is not done";
  } catch (error) {
    return `completion checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type TrustedRunVerification =
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "accepted"; receipt: LoomReviewAuthorityReceipt }>;

function trustedCaptureProblem(handle: RunDirHandle, run: TrustedReviewRun): string | null {
  const issued = handle.readIssuedRequests();
  const captured = handle.readCapturedAttempts();
  if (!issued.ok) return issued.error.message;
  if (!captured.ok) return captured.error.message;
  for (const key of captured.value) {
    const authority = issued.value.find((request) =>
      captureKey(request.slotId, request.attempt) === key);
    const trusted = run.captures.get(key);
    if (authority === undefined || trusted === undefined || authority.requestId !== trusted.requestId ||
        authority.role !== trusted.role || authority.contextDigest !== trusted.contextDigest) {
      return `captured slot ${key} was not witnessed with identical request authority`;
    }
    const bytes = handle.readTranscriptBytes(authority);
    if (!bytes.ok) return bytes.error.message;
    const digest = createHash("sha256").update(bytes.value).digest("hex");
    if (digest !== trusted.digest || bytes.value.byteLength !== trusted.byteLength) {
      return `captured slot ${key} changed after Pi witnessed it`;
    }
  }
  const absentWitness = [...run.captures.keys()].find((key) => !captured.value.has(key));
  if (absentWitness !== undefined) {
    return `witnessed slot ${absentWitness} is absent from the Run Directory`;
  }
  return run.captures.size === 0 ? "no transcript capture was witnessed" : null;
}

function verifyTrustedReviewRun(
  input: Readonly<{ sessionId: string }>,
  run: TrustedReviewRun,
): TrustedRunVerification {
  const reject = (message: string): TrustedRunVerification => ({
    kind: "rejected",
    message: `${run.binding.runId}: ${message}`,
  });
  const opened = openRunDirectory(run.binding.runsRoot, run.binding.runDirectory);
  if (!opened.ok) return reject(opened.error.message);
  const programRaw = opened.value.readProgramRegistration();
  if (!programRaw.ok || programRaw.value === null) {
    return reject(programRaw.ok ? "registered program is missing" : programRaw.error.message);
  }
  const program = parseRegisteredFacadeProgram(programRaw.value);
  if (program.kind !== "registered" || program.program.kind !== "standalone-review") {
    return reject("registered program is not a valid Standalone Review");
  }
  const captureProblem = trustedCaptureProblem(opened.value, run);
  if (captureProblem !== null) return reject(captureProblem);
  const replayed = replayStandaloneResultFromEvidence(opened.value, program.program, run.captures);
  if (!replayed.ok) return reject(`engine evidence replay did not prove completion: ${replayed.message}`);
  let resultBytes: Buffer;
  try {
    resultBytes = readRunBytesNoFollow(join(opened.value.runDirectory, "result.json"));
  } catch (error) {
    return reject(`cannot read canonical result artifact: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!resultBytes.equals(Buffer.from(replayed.json, "utf8"))) {
    return reject("result.json does not match checkpoint-independent evidence replay");
  }
  const reviewedSource = readStandaloneReviewedSource(opened.value, program.program);
  if (!reviewedSource.ok) return reject(`reviewed source attestation failed: ${reviewedSource.message}`);
  return { kind: "accepted", receipt: Object.freeze({
    schemaVersion: 1,
    kind: "loom-review-authority-receipt",
    sessionId: input.sessionId,
    runId: run.binding.runId,
    runsRoot: run.binding.runsRoot,
    runDirectory: run.binding.runDirectory,
    requestIds: Object.freeze([...new Set([...run.captures.values()].map(({ requestId }) => requestId))].sort()),
    resultDigest: replayed.digest,
    reviewedSource: reviewedSource.value,
  }) };
}

async function verifyTrustedStandaloneReview(input: Readonly<{ cwd: string; sessionId: string }>): Promise<unknown> {
  const sessionRoots = trustedReviewRuns.get(input.sessionId);
  if (sessionRoots === undefined) throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId}`);
  const expectedRoot = resolve(input.cwd, ".claude/reviews/review-and-fix-runs");
  const root = sessionRoots.get(expectedRoot);
  if (root === undefined || root.runs.size === 0) {
    throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId} and root ${expectedRoot}`);
  }
  const current = [...root.runs.entries()].reduce((latest, candidate) =>
    candidate[1].touchedAt > latest[1].touchedAt ? candidate : latest);
  const outcome = verifyTrustedReviewRun(input, current[1]);
  if (outcome.kind === "rejected") {
    throw new Error(`current witnessed Standalone Review rejected: ${outcome.message}`);
  }
  // Exact accepted replay is idempotent. Once accepted, older witnesses for
  // this root are retired so they can never make a later verification
  // ambiguous or become fallback authority after a new run is touched.
  sessionRoots.set(expectedRoot, Object.freeze({
    nextTouch: root.nextTouch,
    runs: new Map([[current[0], current[1]]]),
  }));
  return outcome.receipt;
}

export default function (pi: ExtensionAPI) {
  assertAnchoredFilesystemPlatformSupported();
  registerInteractiveSubagentTool(pi, PACKAGE_ROOT, PI_AGENT_DIR);
  (globalThis as unknown as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_SYMBOL] = Object.freeze({
    verify: verifyTrustedStandaloneReview,
  });

  // A Pi process may host overlapping sessions. Parent reservations and
  // capabilities are therefore aggregates owned by one parsed session, never
  // process-global maps whose shutdown can consume another session's state.
  const parentSessionRuntimes = new Map<PiSessionId, PiParentSessionRuntime>();
  const runtimeFor = (sessionId: PiSessionId): PiParentSessionRuntime => {
    const existing = parentSessionRuntimes.get(sessionId);
    if (existing) return existing;
    const created = emptyParentSessionRuntime();
    parentSessionRuntimes.set(sessionId, created);
    return created;
  };
  const pruneRuntime = (sessionId: PiSessionId, runtime: PiParentSessionRuntime): void => {
    if (runtime.issuedWriteGrants.size === 0 && runtime.spawnReservations.size === 0) {
      parentSessionRuntimes.delete(sessionId);
    }
  };
  const activeChildWriteGrants = new Map<string, {
    agentId: AgentId;
    pointerBinding: SessionTaskGraphPointerBinding;
    /** Present only on scoped (phase/panel) grants: Edit/Write targets must
     *  fall inside one of these artifact dirs. Scopes resolve against
     *  `grantCwd` (the spawn cwd), which is also the base relative targets
     *  are judged against. */
    scopeDirs?: readonly string[];
    grantCwd?: string;
  }>();
  const rejectedChildWriteGrantSessions = new Set<string>();

  // ─── Resource Discovery ───────────────────────────────────────────────
  // The package.json "pi" manifest declares the raw skills/ and command
  // templates so the package loads first-class without this handler. This
  // handler adds the RENDERED, content-addressed copies (package-relative
  // tokens expanded) under the Loom resource cache — the paths the extension
  // and spawn admission actually read.

  // Pi does not expand Claude Code's CLAUDE_PLUGIN_ROOT token in markdown.
  // Render package-owned prompts and skills from THIS extension's import URL;
  // cwd and the Claude plugin cache are never package identity.
  process.env.LOOM_PLUGIN_ROOT = LOADED_RUNTIME_IDENTITY.packageRoot;
  // Make package-relative references work in Pi subprocesses (notably the
  // subagent example extension, which inherits process.env when it spawns `pi`).
  process.env.CLAUDE_PLUGIN_ROOT = LOADED_RUNTIME_IDENTITY.packageRoot;
  // Commands executed by Pi's Bash tool inherit process environment. This
  // handshake binds every fresh mutating CLI process to the exact source bytes
  // this extension loaded, preventing mutable-checkout split brain.
  process.env[PI_EXTENSION_RUNTIME_ROOT_ENV] = LOADED_RUNTIME_IDENTITY.packageRoot;
  process.env[PI_EXTENSION_RUNTIME_REVISION_ENV] = LOADED_RUNTIME_IDENTITY.revision;
  pi.on("resources_discover", () => {
    let resources;
    try {
      resources = materializePiResources(PACKAGE_ROOT, PI_RESOURCE_CACHE);
    } catch (error) {
      // Name the failure, then RE-THROW: a swallowed crash would make Pi
      // discover zero Loom resources and continue as if the package were
      // intentionally quiet — the breakage would only surface later, as
      // missing skills, far from its cause. Failing discovery loudly keeps
      // the operator at the point of failure.
      process.stderr.write(
        `loom(pi): resource materialization failed — skills/agents unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      throw error;
    }
    return {
      promptPaths: [...resources.promptPaths],
      skillPaths: [...resources.skillPaths],
    };
  });
  // ─── PreToolUse Guards (tool_call event) ──────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    // Fail CLOSED on a crashed guard: an uncaught throw in this chain has
    // undefined polarity in pi (whether the tool proceeds is the harness's
    // choice) — a guard that dies must block, loudly naming itself, or a
    // crash in e.g. guardStateFile silently waves state-file writes through.
    let currentGuard = "session-id";
    try {
      // Re-hash only before a spawn, where stale parser/policy code matters.
      // Ordinary read/edit tools stay cheap. A future source update is caught
      // here even before the agent asks a fresh CLI mutator to run.
      if (isPiSpawnTool(event.toolName)) {
        currentGuard = "runtime-compatibility";
        const compatibility = loadedRuntimeCompatibility(
          LOADED_RUNTIME_IDENTITY,
          captureLoomRuntimeIdentity(PACKAGE_ROOT),
        );
        if (!compatibility.ok) return { block: true, reason: compatibility.message };
      }

      const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
      const safeSessionId = parseSessionId(sessionId);
      const graphIsActive = pathExistsFailClosed(taskGraphPath()) ||
        rejectedChildWriteGrantSessions.has(sessionId) ||
        (safeSessionId !== null && pathExistsFailClosed(`${subagentDir()}/${safeSessionId}.task_graph`));

      // Block direct edits during orchestration
      if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "multi_edit") {
        currentGuard = "block-direct-edits";
        const rejectedGrant = rejectedChildWriteGrantBlock(rejectedChildWriteGrantSessions.has(sessionId));
        if (rejectedGrant !== null) return rejectedGrant;
        const result = shouldBlockDirectEdit(event.toolName, sessionId, () => graphIsActive, activeRosterProbe);
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
        // Phase/panel agents hold SCOPED grants: Edit/Write may target only the
        // artifact dirs the grant names. Unscoped (implementation) grants and
        // ungranted sessions are untouched. A scoped session whose target
        // cannot be verified fails closed.
        const granted = activeChildWriteGrants.get(sessionId);
        if (granted !== undefined && granted.scopeDirs !== undefined && granted.scopeDirs.length > 0) {
          const targets = piWriteTargetPaths(event.input);
          if (!targets.ok) {
            return {
              block: true,
              reason: `BLOCKED: cannot verify every write target for a scoped phase-agent write grant: ${targets.error}; refusing the edit.`,
            };
          }
          for (const target of targets.value) {
            const violation = writeTargetViolatesScope(target, granted.scopeDirs, granted.grantCwd ?? ctx.cwd);
            if (violation !== null) {
              return {
                block: true,
                reason: `BLOCKED: ${violation}.\nAllowed write scope: ${granted.scopeDirs.join(", ")}`,
              };
            }
          }
        }
      }

      // Guard state file from bash writes
      if (event.toolName === "bash") {
        currentGuard = "guard-state-file";
        const command = graphIsActive ? piBashCommand(event.input) : "";
        let result: ReturnType<typeof guardStateFileDecision> = { kind: "allow" };
        if (command === null) {
          result = { kind: "block", message: "BLOCKED: malformed Pi bash input while the Loom state-file guard is active." };
        } else if (graphIsActive) {
          result = guardStateFileDecision(command);
        }
        // Call-start stamp (PRODUCER only — pi has no PostToolUse evidence
        // recorder yet, so nothing on the pi side consumes these stamps;
        // they exist so the engine's recorder can order artifacts if it
        // reads the same session): decided FIRST, stamped AFTER, in its own
        // catch — a thrown stamp write must never change the guard's
        // polarity (and must not trip the fail-closed outer catch). The
        // tool-call id is read defensively; absent → no stamp, and the
        // engine recorder fails closed on artifact-backed reports.
        try {
          const toolUseId = (event as { toolCallId?: unknown }).toolCallId;
          if (safeSessionId !== null && typeof toolUseId === "string" && toolUseId !== "") {
            await fsSessionRegistry.recordCallStart(safeSessionId, toolUseId, Date.now());
          }
        } catch (err) {
          process.stderr.write(
            `loom(pi): call-start stamp failed (guard decision unaffected): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
      }

      // Subagent tool → the pure Spawn Admission core decides; this shell only
      // implements its ports over the real filesystem/state and applies the
      // decision. A malformed sibling blocks the whole batch; otherwise one
      // parallel item could bypass the gates that the top-level `agent`/`task`
      // fields never represented. `currentGuard` tracks the executing gate for
      // fail-closed attribution: the port wrappers stamp it before their I/O,
      // and a block stamps the guard the core named.
      if (isPiSpawnTool(event.toolName)) {
        currentGuard = "parse-pi-subagent-batch";
        if (event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL && !ctx.hasUI) {
          return {
            block: true,
            reason: "loom_interactive_subagent requires a parent TUI or RPC UI client; refusing to start an unanswerable interview.",
          };
        }
        // A spawn's rendered agent may carry the declared binding or a
        // routing-authorized inherit of the (local) parent model; the routing
        // context is observed once per batch for the definition check.
        const routing = buildPiRoutingContext();
        const admission = admitPiSpawnBatch(event.input, {
          graphActive: graphIsActive,
          transport: event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL ? "interactive-rpc" : "headless",
          packageRoot: PACKAGE_ROOT,
          validateDefinition: (agent) =>
            validatePiAgentDefinitionFile(join(PI_AGENT_DIR, "agents", `${agent}.md`), agent, PACKAGE_ROOT, routing.context),
          readSourceAgent: (agent) => {
            currentGuard = "validate-agent-skill";
            const sourceAgentPath = join(PACKAGE_ROOT, "agents", `${agent}.md`);
            try {
              return { ok: true, content: readFileSync(sourceAgentPath, "utf-8") };
            } catch (error) {
              return {
                ok: false,
                error: `Cannot read active Loom agent definition ${sourceAgentPath}: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          },
          checkPhaseOrder: (agent, task) => {
            currentGuard = "validate-phase-order";
            return validatePhaseOrder({ agentType: agent, prompt: task }, realPhaseOrderDeps);
          },
          checkTemplateSubstitution: (task) => {
            currentGuard = "validate-template-substitution";
            return validateTemplateSubstitution(task, graphIsActive);
          },
        });
        if (admission.kind === "block") {
          currentGuard = admission.guard;
          return { block: true, reason: admission.reason };
        }
        if (admission.kind === "pass-through") return;
        const parsedItems = admission.items;
        const taskExecutionSpawns = admission.taskExecutionSpawns;
        const needsTaskGraphLifecycle = admission.needsTaskGraphLifecycle;

        // Reserve every lifecycle identity before task-state mutation. A roster
        // failure can now refuse the spawn without leaving executing_tasks or
        // artifact baselines claiming work began. The ids hash the tool call,
        // the batch ordinal, and the agent type — task text is deliberately
        // excluded (see `piSpawnRosterId`) — so repeated verifier/designer types in
        // one batch remain distinct without the id moving when the prompt does.
        currentGuard = "subagent-tracking";
        const safeSessionId = parseSessionId(sessionId);
        if (safeSessionId === null) {
          return {
            block: true,
            reason: `Cannot record Loom subagent lifecycle evidence for invalid session id ${JSON.stringify(sessionId)}; refusing spawn.`,
          };
        }
        const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
        if (typeof toolCallId !== "string" || toolCallId === "") {
          return {
            block: true,
            reason: "Cannot bind Loom subagent lifecycle cleanup without a subagent toolCallId; refusing spawn.",
          };
        }
        const existingRuntime = parentSessionRuntimes.get(safeSessionId);
        if (existingRuntime?.spawnReservations.has(toolCallId) ||
            existingRuntime?.issuedWriteGrants.has(toolCallId)) {
          return {
            block: true,
            reason: `Duplicate Pi subagent toolCallId ${JSON.stringify(toolCallId)} in session ${safeSessionId}; refusing spawn.`,
          };
        }
        const rosterIds = parsedItems.map((item, index) =>
          piSpawnRosterId(toolCallId, index, item.agent),
        );
        const reserved: Array<(typeof rosterIds)[number]> = [];
        const writeGrants: Array<{ index: number; token: string; task: string; originalTask: string; injected: boolean }> = [];
        let taskGraphPointerBinding: SessionTaskGraphPointerBinding | null = null;
        let orchestrationRunBinding: SessionRunBinding | null = null;
        let reviewAuthoritiesBySlot: readonly (PiReviewAttemptAuthority | null)[] =
          Object.freeze(parsedItems.map(() => null));
        let specCheckAuthority: PiSpecCheckAttemptAuthority | null = null;
        const rollbackLifecycle = async (): Promise<readonly string[]> => {
          const actions: PiCleanupAction[] = [];
          for (const grant of writeGrants) {
            actions.push({
              label: `revoke write grant for spawn item ${grant.index + 1}`,
              run: () => revokePiWriteGrant(grant.token),
            });
            if (grant.injected) {
              actions.push({
                label: `restore child prompt for spawn item ${grant.index + 1}`,
                run: () => replacePiSpawnTask(event.input, grant.index, grant.originalTask),
              });
            }
          }
          for (const agentId of [...reserved].reverse()) {
            actions.push({
              label: `remove active roster entry ${agentId}`,
              run: () => fsSessionRegistry.removeActive(safeSessionId, agentId),
            });
          }
          if (taskGraphPointerBinding !== null) {
            const ownedPointer = taskGraphPointerBinding;
            actions.push({
              label: "roll back task-graph pointer",
              run: async () => {
                const result = await rollbackSessionTaskGraphPointer(ownedPointer);
                if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
              },
            });
          }
          return runPiCleanupActions(actions);
        };
        // Observe graph activity before this prospective batch writes its own
        // roster rows. Those rows prove only that admission is in progress;
        // treating them as an older reservation's liveness makes a timestamped
        // reservation stranded by process death unrecoverable forever. Keep the
        // observation typed so the registration core can limit this ordering
        // exception to current-protocol (timestamped) reservations.
        const rosterObservation: TaskExecutionRosterObservation | undefined =
          graphIsActive && taskExecutionSpawns.some(({ kind }) => kind === "implementation")
            ? {
                kind: "pre-roster-current-protocol",
                anyActiveForGraph: anyActiveSubagent(taskGraphPath()),
              }
            : undefined;
        try {
          mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
          for (const agentId of rosterIds) {
            await fsSessionRegistry.markActive(safeSessionId, agentId);
            reserved.push(agentId);
          }
          const activeTaskGraphPath = taskGraphPath();
          if (needsTaskGraphLifecycle && pathExistsFailClosed(activeTaskGraphPath)) {
            taskGraphPointerBinding = await bindSessionTaskGraphPointer(
              safeSessionId,
              activeTaskGraphPath,
            );
          }
          // Bind every Loom-owned Pi native spawn identity to the exact issued
          // request before the harness can dispatch the batch. The durable run
          // directory, not the in-memory lifecycle map below, owns capture
          // authority for both Pi and Claude.
          orchestrationRunBinding = await recordPiSpawnCorrelators(parsedItems, rosterIds, safeSessionId, event.input);
          const unboundSpecChecks = orchestrationRunBinding === null
            ? parsedItems.filter(({ agent }) => agent === "spec-check-invoker")
            : [];
          if (graphIsActive && unboundSpecChecks.length > 0) {
            if (unboundSpecChecks.length !== 1) {
              throw new Error("a protected Pi spawn may reserve exactly one unbound spec-check slot");
            }
            const manager = StateManager.fromLocalSession(safeSessionId);
            if (manager === null) throw new Error("protected Pi spec-check spawn has no TaskGraph authority");
            specCheckAuthority = currentPiSpecCheckAuthority(manager.load());
            if (specCheckAuthority === null) {
              throw new Error("protected Pi spec-check spawn lacks exact current Wave slot/attempt authority");
            }
          }
          const unboundReviewers = orchestrationRunBinding === null
            ? parsedItems.filter(({ agent }, index) =>
                isReviewAgent(agent) && taskExecutionSpawns[index]?.kind !== "standalone")
            : [];
          if (graphIsActive && unboundReviewers.length > 0) {
            const manager = StateManager.fromLocalSession(safeSessionId);
            if (manager === null) throw new Error("protected Pi reviewer spawn has no TaskGraph authority");
            const reviewGraph = manager.load();
            reviewAuthoritiesBySlot = Object.freeze(parsedItems.map((item, index) => {
              if (!isReviewAgent(item.agent) || taskExecutionSpawns[index]?.kind === "standalone") return null;
              const taskId = extractTaskId(item.task);
              const authority = taskId === null ? null : currentPiReviewAuthority(reviewGraph, item.agent, taskId);
              if (authority === null) {
                throw new Error(`protected Pi reviewer ${item.agent} lacks exact current Task/Review Run authority`);
              }
              return authority;
            }));
          }
          // Implementation items get the classic whole-session capability bound
          // to their task-graph Task ID. Phase/panel agents (non-implementation)
          // get a SCOPED capability bound to their prompt-derived artifact dirs
          // (".claude/specs/{slug}/", ".claude/plans/", panel candidate dirs) —
          // the Pi analogue of the phase-agent write exemption Claude Code gets
          // via subagent PIDs, and the capability the phase templates promise.
          // Read-only spawns (standalone reviews, verifiers, panel judges,
          // decompose, spec-check) get nothing even when their prompts NAME
          // artifact paths — a judge's candidate paths are reads, not write
          // scope. And OUTSIDE orchestration nobody gets one at all:
          // block-direct-edits allows every edit when no task graph exists, so
          // a grant would authorize nothing that was not already permitted,
          // while its Task ID requirement refused the spawn outright.
          const grantPlan = planPiWriteGrants(parsedItems, taskExecutionSpawns, graphIsActive);
          if (!grantPlan.ok) throw new Error(grantPlan.error);
          for (const [index, requirement] of grantPlan.requirements.entries()) {
            if (requirement.kind === "none") continue;
            const item = parsedItems[index]!;
            const grant = issuePiWriteGrant({
              agent: item.agent,
              taskId: requirement.taskId,
              cwd: piSpawnCwd(event.input, index, ctx.cwd),
              taskGraphPath: taskGraphPath(),
              ...(requirement.kind === "scoped" ? { scopeDirs: requirement.scopeDirs } : {}),
            });
            // Track the issued token before prompt injection can fail. If its
            // immediate revocation also fails, the outer rollback retries this
            // exact token and reports both failures instead of orphaning it.
            const trackedGrant = {
              index,
              token: grant.token,
              task: item.task,
              originalTask: item.task,
              injected: false,
            };
            writeGrants.push(trackedGrant);
            trackedGrant.task = await injectPiWriteGrantWithRevocation(item.task, grant, index);
          }
          // Mutate before task-state validation. Rollback restores prompts and
          // revokes grants, leaving no post-validation operation that can fail
          // after executing_tasks/baselines have committed.
          for (const grant of writeGrants) {
            replacePiSpawnTask(event.input, grant.index, grant.task);
            grant.injected = true;
          }
        } catch (error) {
          const cleanupErrors = await rollbackLifecycle();
          return {
            block: true,
            reason: `Cannot record Loom subagent lifecycle evidence; refusing spawn: ${error instanceof Error ? error.message : String(error)}${cleanupFailureSuffix(cleanupErrors)}`,
          };
        }

        currentGuard = "validate-task-execution";
        let taskRegistration;
        try {
          const executionMode = event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL ||
              Array.isArray((event.input as { chain?: unknown }).chain)
            ? "sequential" as const
            : "parallel" as const;
          taskRegistration = graphIsActive
            ? await registerTaskExecutionBatch(
                taskExecutionSpawns,
                executionMode,
                rosterObservation,
              )
            : { kind: "registered" as const, authorities: Object.freeze([]) };
        } catch (error) {
          const cleanupErrors = await rollbackLifecycle();
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}${cleanupFailureSuffix(cleanupErrors)}`,
            error instanceof Error ? { cause: error } : undefined,
          );
        }
        if (taskRegistration.kind === "block") {
          const cleanupErrors = await rollbackLifecycle();
          return { block: true, reason: `${taskRegistration.message}${cleanupFailureSuffix(cleanupErrors)}` };
        }
        const alignment = graphIsActive
          ? alignPiImplementationAuthorities(
              parsedItems,
              taskExecutionSpawns,
              taskRegistration.authorities,
            )
          : {
              ok: true as const,
              authoritiesBySlot: Object.freeze(parsedItems.map(() => null)),
            };
        if (!alignment.ok) {
          const registrationRollback = await rollbackTaskExecutionRegistration(taskRegistration.authorities);
          const cleanupErrors = await rollbackLifecycle();
          const rollbackErrors = [
            ...(registrationRollback.kind === "block" ? [registrationRollback.message] : []),
            ...cleanupErrors,
          ];
          return {
            block: true,
            reason: `BLOCKED: ${alignment.error}${cleanupFailureSuffix(rollbackErrors)}`,
          };
        }
        const sessionRuntime = runtimeFor(safeSessionId);
        if (writeGrants.length > 0) {
          sessionRuntime.issuedWriteGrants.set(toolCallId, writeGrants.map((grant) => grant.token));
        }
        sessionRuntime.spawnReservations.set(toolCallId, {
          sessionId: safeSessionId,
          needsTaskGraphLifecycle,
          graphActiveAtSpawn: graphIsActive,
          orchestrationRunBinding,
          pointerBinding: taskGraphPointerBinding,
          items: parsedItems.map((item, index) => {
            const taskId = extractTaskId(item.task);
            return {
              agentType: item.agent,
              rosterId: rosterIds[index]!,
              taskId,
              implementationAuthority: alignment.authoritiesBySlot[index] ?? null,
              reviewAuthority: reviewAuthoritiesBySlot[index] ?? null,
              specCheckAuthority: item.agent === "spec-check-invoker" ? specCheckAuthority : null,
              kind: taskExecutionSpawns[index]?.kind ?? "non-implementation",
            };
          }),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `loom(pi): tool_call guard '${currentGuard}' crashed — blocking the call (fail-closed): ${message}\n`,
      );
      return {
        block: true,
        reason: `loom guard '${currentGuard}' crashed (failing closed): ${message}`,
      };
    }
    // Every guard passed: no opinion, let the call proceed.
    return undefined;
  });

  // ─── Session Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    // Cleanup stale subagent tracking files — the ENGINE's sweep, not a
    // per-file twin: staleness is judged per session GROUP (max mtime across
    // the session's files), and the TTL is the shared STALE_SUBAGENT_TTL_MS,
    // so a live session's roster/ledger can't be reaped out from under a
    // fresh `.machine` anchor.
    //
    // Each sweep is guarded on its own: a crash in one must not prevent the
    // other, and neither must escape the `session_start` handler as an
    // unhandled rejection. Hygiene, not authority — expired or invalid
    // grants are independently refused by `consumePiWriteGrant` at the
    // actual authority boundary, so a missed sweep costs one session's
    // cleanup, never a write.
    for (const sweep of [
      {
        name: "sweepStaleSessions",
        run: (): void => { sweepStaleSessions(subagentDir(), Date.now() - STALE_SUBAGENT_TTL_MS); },
      },
      { name: "sweepExpiredPiWriteGrants", run: (): void => sweepExpiredPiWriteGrants() },
    ]) {
      try {
        sweep.run();
      } catch (error) {
        process.stderr.write(
          `loom(pi): session_start sweep failed: ${sweep.name}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  });

  // Each Pi subagent is a separate `pi --no-session` process. Parent-session
  // roster entries therefore cannot authorize child Edit/Write calls. Consume
  // the one-time capability injected into THIS child's task and bind its own
  // session before the first model turn.
  pi.on("before_agent_start", async (event, ctx) => {
    let partialBinding: { sessionId: NonNullable<ReturnType<typeof parseSessionId>>; agentId: AgentId } | null = null;
    try {
      if (!PI_WRITE_GRANT_MARKER.test(event.prompt)) return;
      const childAgent = piSystemAgentIdentity(event.systemPrompt);
      const grant = consumePiWriteGrant(event.prompt, ctx.cwd, childAgent);
      if (!grant) return;
      const sessionId = parseSessionId(ctx.sessionManager.getSessionId() ?? "");
      const agentId = parseAgentId(grant.agentId);
      if (!sessionId || !agentId) throw new Error("child session or grant agent identity is invalid");
      await fsSessionRegistry.markActive(sessionId, agentId);
      partialBinding = { sessionId, agentId };
      const pointerBinding = await bindSessionTaskGraphPointer(sessionId, grant.taskGraphPath);
      activeChildWriteGrants.set(sessionId, { agentId, pointerBinding, scopeDirs: grant.scopeDirs, grantCwd: grant.cwd });
      partialBinding = null;
      process.stderr.write(`loom(pi): activated child write grant for ${grant.taskId}/${sessionId}\n`);
    } catch (error) {
      const rejectedSession = ctx.sessionManager.getSessionId() ?? "";
      if (parseSessionId(rejectedSession)) rejectedChildWriteGrantSessions.add(rejectedSession);
      // Bound to a const before the closure captures it: `partialBinding` is a
      // mutable outer `let`, so the narrowing from the `if` does not survive
      // into the deferred `run`, and the cleanup would dereference whatever the
      // variable held when it finally ran rather than what was checked.
      const orphanedBinding = partialBinding;
      if (orphanedBinding !== null) {
        const cleanupErrors = await runPiCleanupActions([{
          label: `remove partial child roster entry ${orphanedBinding.agentId}`,
          run: () => fsSessionRegistry.removeActive(orphanedBinding.sessionId, orphanedBinding.agentId),
        }]);
        for (const cleanupError of cleanupErrors) {
          process.stderr.write(`loom(pi): child write-grant cleanup failed: ${cleanupError}\n`);
        }
      }
      const message = `loom(pi): child write grant rejected — edits remain blocked: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(message + "\n");
      return {
        message: { customType: "loom-write-grant-error", content: message, display: false },
      };
    }
    return undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const rawSessionId = ctx.sessionManager.getSessionId() ?? "";
    trustedReviewRuns.delete(rawSessionId);
    const sessionId = parseSessionId(rawSessionId);
    const binding = activeChildWriteGrants.get(rawSessionId);
    const actions: PiCleanupAction[] = [];

    // Capabilities are the security boundary: schedule this session's every
    // revocation before fallible roster/pointer housekeeping, then execute all
    // actions regardless of individual failures. Other sessions are untouched.
    const parentRuntime = sessionId ? parentSessionRuntimes.get(sessionId) : undefined;
    let grantOrdinal = 0;
    for (const tokens of parentRuntime?.issuedWriteGrants.values() ?? []) {
      for (const token of tokens) {
        grantOrdinal++;
        actions.push({
          label: `revoke outstanding write grant ${grantOrdinal}`,
          run: () => revokePiWriteGrant(token),
        });
      }
    }
    if (sessionId && binding) {
      actions.push({
        label: `remove child roster entry ${binding.agentId}`,
        run: () => fsSessionRegistry.removeActive(sessionId, binding.agentId),
      });
      actions.push({
        label: `roll back child task-graph pointer for ${sessionId}`,
        run: async () => {
          const result = await rollbackSessionTaskGraphPointer(binding.pointerBinding);
          if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
        },
      });
    }
    for (const reservation of parentRuntime?.spawnReservations.values() ?? []) {
      for (const item of reservation.items) {
        actions.push({
          label: `remove shutdown roster entry for ${item.agentType}`,
          run: () => fsSessionRegistry.removeActive(reservation.sessionId, item.rosterId),
        });
      }
      if (reservation.pointerBinding !== null) {
        const pointerBinding = reservation.pointerBinding;
        actions.push({
          label: `release shutdown task-graph pointer lease for ${reservation.sessionId}`,
          run: async () => {
            const result = await rollbackSessionTaskGraphPointer(pointerBinding);
            if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
          },
        });
      }
    }

    const cleanupErrors = await runPiCleanupActions(actions);
    // Failed revocation/cleanup remains retryable on the next shutdown event.
    // Dropping these maps after a failure would orphan the capability while
    // erasing the only in-process record that can revoke it.
    if (cleanupErrors.length === 0) {
      if (sessionId) parentSessionRuntimes.delete(sessionId);
      activeChildWriteGrants.delete(rawSessionId);
      rejectedChildWriteGrantSessions.delete(rawSessionId);
    }
    for (const cleanupError of cleanupErrors) {
      process.stderr.write(`loom(pi): shutdown cleanup failed: ${cleanupError}\n`);
    }
  });

  // ─── Resume Context (before_agent_start) ──────────────────────────────
  // If there's an active task graph in execute phase, inject context
  // so the LLM knows where we are (equivalent of resume-after-clear).

  pi.on("before_agent_start", async (_event, ctx) => {
    const failResumeContext = (reason: string) => {
      const message = `Loom resume context unavailable: ${reason}`;
      process.stderr.write(`loom(pi): ${message}\n`);
      ctx.ui.notify(message, "error");
      ctx.abort();
      return {
        message: {
          customType: "loom-context-error",
          content: `${message}. Do not proceed with this turn.`,
          display: true,
        },
      };
    };

    const observation = observePiResumeTaskGraph();
    if (observation.kind === "absent") return;
    if (observation.kind === "unavailable") return failResumeContext(observation.reason);
    const state = observation.state;
    if (state.current_phase !== "execute" || state.tasks.length === 0) return;

    const output = buildContextOutput(state, PACKAGE_ROOT);
    return {
      message: {
        customType: "loom-context",
        content: output,
        display: false,
      },
    };
  });


  // ─── PostEdit Lint (tool_result event for edit/write/multi_edit) ──────
  // After edit/write lands on disk, run immediate-tier lint.
  // If violations: report error content so the agent can remediate the landed edit.
  // If pass: return undefined (no injection).
  // If the lint engine errors: report the failure; this post-edit hook cannot roll back the mutation.

  pi.on("tool_result", async (event, _ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "multi_edit") return;

      // Skip if the tool itself errored (file may not exist on disk)
      if (event.isError) return;

      const projectRoot = process.cwd();
      const projectRulesPath = join(projectRoot, PROJECT_RULES_DIR);
      const projectRulesDir = pathExistsFailClosed(projectRulesPath) ? projectRulesPath : null;

      const loomDefaultRulesDir = join(PACKAGE_ROOT, "lint-rules");
      const response = processToolResult(
        event.toolName,
        event.input,
        (filePath) => lintFile(filePath, "immediate", loomDefaultRulesDir, projectRulesDir)
      );

      if (response) {
        return {
          content: response.content.map(c => ({ type: c.type as "text", text: c.text })),
          isError: response.isError,
        };
      }
    } catch (error: unknown) {
      // Fail-closed: return error feedback so the agent must repair the edit
      // already on disk; this post-edit hook does not roll the write back.
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `\u274c LINT ENGINE ERROR: ${message}` }],
        isError: true,
      };
    }
    return undefined;
  });

  // ─── SubagentStop Dispatch (tool_result event) ────────────────────────
  // When a subagent completes, handle phase advancement, task status
  // updates, and review findings — equivalent of SubagentStop hooks.

  pi.on("tool_result", async (event, _ctx) => {
    if (!isPiSpawnTool(event.toolName)) return;

    const processingErrors: string[] = [];
    const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
    const rawSessionId = _ctx.sessionManager.getSessionId() ?? "";
    const resultSessionId = parseSessionId(rawSessionId);
    const sessionRuntime = resultSessionId === null
      ? undefined
      : parentSessionRuntimes.get(resultSessionId);
    const inMemoryReservation = typeof toolCallId === "string"
      ? sessionRuntime?.spawnReservations.get(toolCallId)
      : undefined;
    let reservation = inMemoryReservation;
    let reservationRecoveryFailed = false;
    if (reservation === undefined && typeof toolCallId === "string" && resultSessionId !== null) {
      try {
        reservation = recoverPiSpawnReservation(resultSessionId, toolCallId) ?? undefined;
      } catch (error) {
        reservationRecoveryFailed = true;
        const diagnostic = `durable Pi orchestration reservation recovery failed: ${error instanceof Error ? error.message : String(error)}`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
      }
    }
    const grantTokens = typeof toolCallId === "string"
      ? sessionRuntime?.issuedWriteGrants.get(toolCallId) ?? []
      : [];

    // Roster and grant cleanup may consume immediately, but the reservation is
    // the retry capability for its pointer lease. Retain it until exact pointer
    // release succeeds; shutdown can retry a transient result-time failure.
    const cleanupActions: PiCleanupAction[] = grantTokens.map((token, index) => ({
      label: `revoke write grant ${index + 1}`,
      run: () => revokePiWriteGrant(token),
    }));
    // Same reason as the write-grant cleanup above: `reservation` is a mutable
    // `let`, so the optional-chain guard on the loop header does not narrow it
    // inside the deferred `run`. Capture the checked value.
    const cleanedReservation = reservation;
    if (cleanedReservation !== undefined) {
      const { sessionId: reservedSessionId } = cleanedReservation;
      for (const item of cleanedReservation.items) {
        cleanupActions.push({
          label: `remove reserved roster entry for ${item.agentType}`,
          run: () => fsSessionRegistry.removeActive(reservedSessionId, item.rosterId),
        });
      }
    }
    const cleanupErrors = await runPiCleanupActions(cleanupActions);
    processingErrors.push(...cleanupErrors);
    for (const cleanupError of cleanupErrors) {
      process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${cleanupError}\n`);
    }
    if (typeof toolCallId === "string" && sessionRuntime &&
        !cleanupErrors.some((error) => error.startsWith("revoke write grant "))) {
      sessionRuntime.issuedWriteGrants.delete(toolCallId);
    }
    if (typeof toolCallId === "string" && sessionRuntime && reservation?.pointerBinding === null) {
      sessionRuntime.spawnReservations.delete(toolCallId);
    }
    if (resultSessionId && sessionRuntime) pruneRuntime(resultSessionId, sessionRuntime);
    const processingErrorResponse = () => processingErrors.length === 0
      ? undefined
      : {
          content: [{
            type: "text" as const,
            text: `Loom Pi subagent evidence processing failed:\n- ${processingErrors.join("\n- ")}`,
          }],
          isError: true,
        };
    const persistCaptureRejection = async (
      runBinding: SessionRunBinding,
      resultIndex: number,
      agentType: string,
      diagnostic: string,
    ): Promise<void> => {
      const failure = await recordPiRequestCaptureRejection(
        runBinding,
        toolCallId,
        resultIndex,
        agentType,
        diagnostic,
      );
      if (failure === null) return;
      processingErrors.push(failure);
      process.stderr.write(`loom(pi): ${failure}\n`);
    };
    if (reservationRecoveryFailed) return processingErrorResponse();
    let parentPointerCleanupAttempted = false;
    const cleanupParentTaskGraphPointer = async (): Promise<void> => {
      if (parentPointerCleanupAttempted || !resultSessionId || reservation?.pointerBinding === null ||
          reservation?.pointerBinding === undefined) return;
      parentPointerCleanupAttempted = true;
      const pointerBinding = reservation.pointerBinding;
      const errors = await runPiCleanupActions([{
        label: `release parent task-graph pointer lease for ${resultSessionId}`,
        run: async () => {
          const result = await rollbackSessionTaskGraphPointer(pointerBinding);
          if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
        },
      }]);
      processingErrors.push(...errors);
      for (const error of errors) process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${error}\n`);
      if (errors.length === 0 && typeof toolCallId === "string" && sessionRuntime) {
        sessionRuntime.spawnReservations.delete(toolCallId);
      }
      if (sessionRuntime) pruneRuntime(resultSessionId, sessionRuntime);
    };

    const finalizeReservedImplementations = async (
      entries: readonly PiSubagentResultEntry[],
    ): Promise<readonly string[]> => {
      if (!reservation || !reservation.items.some((item) => item.kind === "implementation")) return [];
      let manager: StateManager | null;
      try {
        manager = StateManager.fromLocalSession(reservation.sessionId);
      } catch (error) {
        // Guarded like the sibling `manager.update` below. This handler has no
        // top-level try/catch, so an unguarded throw here — resolveTaskGraph
        // REFUSES its local fallback and throws for any non-ENOENT read of the
        // session pointer (EACCES/EIO/ELOOP/ENOTDIR) — would escape the whole
        // `tool_result` handler: no finalization, no per-result evidence loop,
        // no capture terminalization, zero diagnostics, tasks stuck
        // `executing`. The throw becomes a diagnostic and the batch continues.
        const diagnostic = `cannot finalize reserved implementation attempts for session ${reservation.sessionId} ` +
          `— task graph pointer unreadable: ${error instanceof Error ? error.message : String(error)}`;
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
        return [diagnostic];
      }
      if (!manager) {
        // Ad-hoc: no graph existed at spawn, so there is no attempt record to
        // finalize and nothing was lost.
        if (spawnedWithoutTaskGraph(reservation)) {
          process.stderr.write(
            `loom(pi): ad-hoc implementation spawn for session ${reservation.sessionId} — no task graph to finalize\n`,
          );
          return [];
        }
        const diagnostic = `cannot finalize reserved implementation attempts for session ${reservation.sessionId} — task graph unavailable`;
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
        return [diagnostic];
      }
      const finalizedAt = parseIsoInstant(new Date().toISOString(), "Pi finalization instant");
      if (!finalizedAt.ok) return [finalizedAt.error.errors.join("; ")];
      try {
        const committed = await manager.updateAndReturn((initial) => {
          let state: TaskGraph = initial;
          const diagnostics: string[] = [];
          const logs: string[] = [];
          for (const [index, item] of reservation.items.entries()) {
            if (item.kind !== "implementation" || item.taskId === null) continue;
            if (item.implementationAuthority === null) {
              logs.push(
                `implementation slot ${index + 1}/${item.taskId} has no exact attempt authority — current reservation preserved`,
              );
              continue;
            }
            const failure = reservedImplementationFailure(
              item.agentType,
              item.taskId,
              item.implementationAuthority.taskId,
              entries[index],
            );
            if (failure === null) continue;

            const applied = settleUnavailableImplementation(
              state,
              item.implementationAuthority,
              finalizedAt.value,
              failure,
            );
            if (applied.kind === "error") {
              const diagnostic = `Oracle could not finalize ${item.taskId}: ${JSON.stringify(applied.error)}`;
              diagnostics.push(diagnostic);
              logs.push(`${diagnostic}; current attempt preserved`);
              continue;
            }
            state = applied.state;
            if (applied.kind === "ignored" && applied.reason === "stale") {
              logs.push(`late result for ${item.taskId} does not match its current attempt authority — replacement preserved`);
            }
          }
          return {
            state,
            value: Object.freeze({
              diagnostics: Object.freeze(diagnostics),
              logs: Object.freeze(logs),
            }),
          };
        });
        // The callback may accumulate in-memory diagnostics, but performs no
        // external I/O. Emit only after the protected-state commit proves they
        // describe durable state.
        for (const line of committed.logs) process.stderr.write(`loom(pi): ${line}\n`);
        return committed.diagnostics;
      } catch (error) {
        const diagnostic = `reserved implementation finalization failed: ${error instanceof Error ? error.message : String(error)}`;
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
        return [diagnostic];
      }
    };

    const details = event.details as Record<string, unknown> | undefined;
    const rawResults = details && "results" in details && Array.isArray(details.results)
      ? details.results
      : [];
    // Exact per-entry parsing precedes finalization. A matching-agent/exit-0
    // shell is not a successful implementation envelope until transcript shape
    // and exact returned Task identity have both parsed.
    const entries = parsePiSubagentResults(rawResults);
    if (!spawnedWithoutTaskGraph(reservation)) {
      processingErrors.push(...await finalizeReservedImplementations(entries));
    }

    // A reservation is the authoritative expected batch. Pi may return a
    // shorter or reordered results array after a child disappears. Reconcile
    // every gate-owned slot before any malformed-details early return so stale
    // review/spec evidence cannot remain authoritative.
    if (reservation) {
      const { reviews: missingReviews, specChecks: missingSpecChecks, runResults: missingRunResults } =
        classifyMissingReservedResults(
          reservation.items,
          rawResults,
          reservation.orchestrationRunBinding !== null,
        );
      for (const { item, index } of missingRunResults) {
        const diagnostic = `request-bound result ${index + 1} for ${item.agentType} was missing or mismatched`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}; run transcript was not captured\n`);
        const runBinding = reservation.orchestrationRunBinding;
        if (runBinding === null) {
          const failure = `cannot terminalize missing ${item.agentType}[${index}]: reservation lost its run binding`;
          processingErrors.push(failure);
          process.stderr.write(`loom(pi): ${failure}\n`);
        } else {
          await persistCaptureRejection(runBinding, index, item.agentType, diagnostic);
        }
      }
      // An ad-hoc batch has no State File to mark, so the persistence arm below
      // cannot run — which used to skip the whole reporting block, and a reserved
      // reviewer that died without returning left no trace anywhere. There is no
      // protected state to record an evidence failure against, so this stays
      // operator-visible rather than an orchestration failure; what must not
      // happen is silence.
      const missingGateOwned = missingReviews.length > 0 || missingSpecChecks.length > 0;
      if (missingGateOwned && spawnedWithoutTaskGraph(reservation)) {
        const diagnostic = unrecordableMissingEvidenceDiagnostic({
          sessionId: reservation.sessionId,
          reviews: missingReviews.length,
          specChecks: missingSpecChecks.length,
        });
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
      }
      if (missingGateOwned && !spawnedWithoutTaskGraph(reservation)) {
        let manager: StateManager | null = null;
        let pointerReadFailed = false;
        try {
          manager = StateManager.fromLocalSession(reservation.sessionId);
        } catch (error) {
          // Guarded exactly like the sibling `manager.update` below. This
          // handler has no top-level try/catch, so an unguarded throw here —
          // resolveTaskGraph refuses its local fallback and throws for any
          // non-ENOENT read of the session pointer (EACCES/EIO/ELOOP/ENOTDIR)
          // — would escape the whole `tool_result` handler, skipping the
          // per-result evidence loop below and leaving tasks stuck
          // `executing` with zero diagnostics. The throw becomes a
          // processing error and the batch continues.
          pointerReadFailed = true;
          const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
            `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId} ` +
            `— task graph pointer unreadable: ${error instanceof Error ? error.message : String(error)}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        }
        if (pointerReadFailed) {
          // The diagnostic was already recorded above: the pointer is
          // present-but-unreadable, not absent, so the ad-hoc and
          // "task graph unavailable" arms do not apply. The batch continues
          // to the per-result evidence loop below.
        } else if (!manager) {
          const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
            `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId} — task graph unavailable`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        } else {
          const runAt = new Date().toISOString();
          // Guarded exactly like the sibling `manager.update` in
          // `finalizeReservedImplementations` above. This handler has no
          // top-level try/catch, so an unguarded throw here (corrupt state
          // JSON, lock contention, disk failure) escaped the whole
          // `tool_result` handler — skipping the per-result evidence loop
          // below, whose own comment demands that one failure must not abort
          // the rest of the batch — and left tasks stuck `executing` with zero
          // `processingErrors` and zero stderr. The throw now becomes a
          // diagnostic and the batch continues.
          try {
            const settled = await manager.updateAndReturn((state) => {
              const appliedReviewIndexes: number[] = [];
              const tasks = state.tasks.map<Task>((task) => {
                const failures = missingReviews.filter(({ item }) => item.taskId === task.id);
                return failures.reduce<Task>((current, { item, index }) => {
                  if (piReviewAuthorityProblem(current, item.agentType, item.reviewAuthority) !== null) {
                    return current;
                  }
                  const next = applyReviewResolution(current, {
                    kind: "evidence-failed" as const,
                    agent: item.agentType,
                    message: `reserved reviewer result ${index + 1} for ${item.agentType} was missing or mismatched`,
                  });
                  if (next !== current) appliedReviewIndexes.push(index);
                  return next;
                }, task);
              });
              const specAuthorityProblems: string[] = [];
              let specCheckPatch: Pick<TaskGraph, "spec_check"> | undefined;
              if (missingSpecChecks.length > 1) {
                specAuthorityProblems.push("multiple reserved spec-check slots were missing; no unique authority exists");
              } else if (missingSpecChecks.length === 1) {
                const missing = missingSpecChecks[0]!;
                const authority = missing.item.specCheckAuthority;
                const problem = piSpecCheckAuthorityProblem(state, authority);
                if (problem !== null || authority === null) {
                  specAuthorityProblems.push(problem ?? "reserved spec-check authority is absent");
                } else {
                  specCheckPatch = {
                    spec_check: {
                      wave: authority.wave,
                      run_at: runAt,
                      verdict: "EVIDENCE_CAPTURE_FAILED" as const,
                      error: `reserved spec-check result ${missing.index + 1} for spec-check-invoker was missing or mismatched`,
                    },
                  };
                }
              }
              const specCheck = specCheckPatch?.spec_check;
              return {
                state: {
                  ...state,
                  tasks,
                  ...(specCheckPatch ?? {}),
                  ...(specCheck === undefined
                    ? {}
                    : { wave_gates: reconcileWaveBlock(state.wave_gates, tasks, specCheck, specCheck.wave) }),
                },
                value: Object.freeze({
                  appliedReviewIndexes: Object.freeze(appliedReviewIndexes),
                  specAuthorityProblems: Object.freeze(specAuthorityProblems),
                }),
              };
            });
            for (const { item, index } of missingReviews) {
              if (settled.appliedReviewIndexes.includes(index)) {
                process.stderr.write(
                  `loom(pi): reserved reviewer result ${index + 1} for ${item.agentType}/${item.taskId} was missing or mismatched — marking evidence_capture_failed\n`,
                );
              } else {
                const diagnostic = `reserved reviewer result ${index + 1} for ${item.agentType}/${item.taskId} was not applied under locked current review authority`;
                processingErrors.push(diagnostic);
                process.stderr.write(`loom(pi): ${diagnostic}\n`);
              }
            }
            for (const { index } of missingSpecChecks) {
              process.stderr.write(
                settled.specAuthorityProblems.length === 0
                  ? `loom(pi): reserved spec-check result ${index + 1} for spec-check-invoker was missing or mismatched — marking evidence_capture_failed\n`
                  : `loom(pi): reserved spec-check result ${index + 1} was not applied: ${settled.specAuthorityProblems.join("; ")}\n`,
              );
            }
            processingErrors.push(...settled.specAuthorityProblems);
          } catch (error) {
            // The per-item lines above stay inside the `try`: they announce
            // evidence that was RECORDED, and printing them after a failed
            // write would report a state change that never happened.
            const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
              `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId}: ` +
              `${error instanceof Error ? error.message : String(error)}`;
            processingErrors.push(diagnostic);
            process.stderr.write(`loom(pi): ${diagnostic}\n`);
          }
        }
      }
    }

    if (!details || !("results" in details)) {
      const diagnostic = "subagent tool_result is missing details.results — successful evidence was not applied";
      processingErrors.push(diagnostic);
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
      await cleanupParentTaskGraphPointer();
      return processingErrorResponse();
    }

    // Shape guard: a pi version drifting details.results away from an array
    // must be a LOUD no-op, not a silent one (or a throw mid-dispatch).
    if (!Array.isArray(details.results)) {
      const diagnostic =
        `subagent tool_result has unrecognized details.results shape (${typeof details.results}) — successful evidence was not applied`;
      processingErrors.push(diagnostic);
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
      await cleanupParentTaskGraphPointer();
      return processingErrorResponse();
    }
    // Per-element parse, not a cast: the array-shape guard above says nothing
    // about any individual element, and `agent`/`task`/`exitCode` are read as
    // guaranteed strings and numbers downstream.
    if (reservation && entries.length > reservation.items.length) {
      const diagnostic =
        `subagent tool_result returned ${entries.length} result(s) for ${reservation.items.length} reserved slot(s) — surplus evidence ignored`;
      processingErrors.push(diagnostic);
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
    }
    const authorizedEntries = reservation ? entries.slice(0, reservation.items.length) : entries;
    const allSlotsFailed = piAllSlotsFailedNote(
      authorizedEntries.flatMap((entry) => (entry.ok ? [entry.result] : [])),
    );
    if (allSlotsFailed !== null) process.stderr.write(`loom(pi): ${allSlotsFailed}\n`);
    for (const [resultIndex, entry] of authorizedEntries.entries()) {
      // A malformed element keeps its slot rather than shifting the ones after
      // it, and is reported as loudly as the array-level shape drift above.
      if (!entry.ok) {
        processingErrors.push(entry.problem);
        process.stderr.write(`loom(pi): ${entry.problem}\n`);
        continue;
      }
      const result = entry.result;
      // Per-result error isolation (mirrors dispatch.ts's safeRun): a throw
      // while processing result #1 must not abort results #2..N — that
      // leaves tasks stuck "executing" with zero diagnostics.
      try {
        const agentType = stripNamespace(result.agent);
        const sessionId = _ctx.sessionManager.getSessionId() ?? "unknown";
        const reservedItem = reservation?.items[resultIndex];
        const markers = orchestrationMarkers(
          result.task,
          `Pi result ${resultIndex + 1}/${agentType}`,
        );
        const durableRunBinding = reservation?.orchestrationRunBinding ??
          (markers !== null && resultSessionId !== null
            ? sessionRunBinding(resultSessionId, [markers])
            : null);
        const runBound = durableRunBinding !== null ||
          process.env[RUNS_ROOT_ENV] !== undefined || process.env[RUN_DIR_ENV] !== undefined;
        if (reservedItem && agentType !== reservedItem.agentType) {
          const diagnostic =
            `result ${resultIndex + 1} agent ${JSON.stringify(agentType)} does not match reserved ${JSON.stringify(reservedItem.agentType)}`;
          if (runBound) processingErrors.push(`request-bound ${diagnostic}`);
          process.stderr.write(`loom(pi): ${diagnostic} — evidence ignored\n`);
          continue;
        }
        if (durableRunBinding !== null) {
          const authorityProblem = markers === null
            ? `request-bound result ${resultIndex + 1}/${agentType} has no request/context markers`
            : piResultAuthorityProblem(durableRunBinding, toolCallId, resultIndex, agentType, markers);
          if (authorityProblem !== null) {
            const diagnostic = `request-bound result authority rejected for ${agentType}: ${authorityProblem}`;
            processingErrors.push(diagnostic);
            process.stderr.write(`loom(pi): ${diagnostic}; transcript was not captured\n`);
            await persistCaptureRejection(durableRunBinding, resultIndex, agentType, diagnostic);
            continue;
          }
        }

        // Cleanup subagent flag. Parse the session id before interpolating it
        // into the SUBAGENT_DIR path (path-traversal guard); an unsafe id could
        // never have named a tracking file, so there is nothing to clean up.
        const safeSessionId = parseSessionId(sessionId);
        if (safeSessionId === null) {
          process.stderr.write(
            `loom: invalid session id ${JSON.stringify(sessionId)} — subagent flag cleanup skipped\n`,
          );
        } else if (!reservedItem) {
          // Compatibility for a result emitted by an older Pi call that predates
          // reservation capture. New calls always release above from authority.
          try {
            const rosterId = piSpawnRosterId(toolCallId, resultIndex, agentType);
            await fsSessionRegistry.removeActive(safeSessionId, rosterId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const diagnostic = `subagent flag cleanup failed for ${agentType}/${safeSessionId}: ${message}`;
            processingErrors.push(diagnostic);
            process.stderr.write(`loom: ${diagnostic}\n`);
          }
        }

        // Request-bound capture runs BEFORE the standalone short-circuit and
        // before any StateManager resolution — the same two orderings dispatch.ts
        // documents as load-bearing on the Claude side. Standalone results are
        // precisely the ones a run directory exists to collect, so capturing
        // after that `continue` would capture nothing for exactly the flows this
        // path serves; and capture must record evidence before any handler acts
        // on it. It reads only the run directory it is pointed at, never a State
        // File, so a run beside an active wave cannot cross into it.
        const captureOutcome: CaptureOutcome = piSubagentResultFailed(result) && runBound
          ? {
              kind: "rejected",
              reason: "agent-failed",
              message: `${agentType} exited without a successful result (${piSubagentFailureSignals(result)})`,
            }
          : await capturePiSubagentResult(
              toolCallId,
              resultIndex,
              agentType,
              result.messages,
              durableRunBinding,
            );
        if (captureOutcome.kind === "captured" && durableRunBinding !== null && resultSessionId !== null) {
          try {
            rememberTrustedReviewCapture(resultSessionId, durableRunBinding, agentType, result.task, captureOutcome);
          } catch (error) {
            const diagnostic = `cannot retain process-local review authority for ${agentType}: ${error instanceof Error ? error.message : String(error)}`;
            processingErrors.push(diagnostic);
            process.stderr.write(`loom(pi): ${diagnostic}\n`);
          }
        }

        // Standalone review/refutation results are run artifacts. Short-circuit
        // before StateManager resolution so an unrelated local graph is neither
        // read nor mutated merely because it exists. When a run directory is
        // active, however, capture is mandatory evidence: a rejection or missing
        // correlator must be surfaced rather than disguised as a harmless
        // task-state short-circuit.
        if (runBound || reservedItem?.kind === "standalone" || hasStandaloneReviewContext(result.task)) {
          if (runBound && captureOutcome.kind !== "captured") {
            const detail = describeCaptureFailure(captureOutcome);
            const diagnostic = `standalone request-bound capture failed for ${agentType}: ${detail}`;
            processingErrors.push(diagnostic);
            process.stderr.write(`loom(pi): ${diagnostic}; task state untouched\n`);
            if (durableRunBinding !== null) {
              await persistCaptureRejection(durableRunBinding, resultIndex, agentType, diagnostic);
            }
          } else {
            process.stderr.write(
              piSubagentResultFailed(result)
                ? `loom(pi): failed standalone ${agentType} result ignored — task state untouched\n`
                : `loom(pi): ${agentType} belongs to a standalone review run — task state untouched\n`,
            );
          }
          continue;
        }

        // Any Loom-owned result under explicit run authority must have exact
        // request-bound evidence before protected state can change. Only truly
        // unrelated legacy agents may retain the no-reservation compatibility
        // path.
        if (captureOutcome.kind === "rejected" ||
            (runBound && isLoomOwnedResultAgent(agentType) && captureOutcome.kind !== "captured")) {
          const detail = describeCaptureFailure(captureOutcome);
          const diagnostic = `request-bound capture rejected for ${agentType}: ${detail}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}; protected state unchanged\n`);
          continue;
        }

        if (spawnedWithoutTaskGraph(reservation)) {
          process.stderr.write(
            `loom(pi): ad-hoc ${agentType} completion — no TaskGraph existed at spawn, protected state untouched\n`,
          );
          continue;
        }

        const mgr = StateManager.fromLocalSession(sessionId);
        if (!mgr) {
          if (isLoomOwnedResultAgent(agentType)) {
            const diagnostic = `no task graph for session ${JSON.stringify(sessionId)}; ${agentType} completion was NOT applied`;
            processingErrors.push(diagnostic);
            process.stderr.write(`loom(pi): ${diagnostic}\n`);
          }
          continue;
        }

        // Each concern below is one named applier in `pi/subagent-result`, taking
        // the state store and the repository as ports. They decide and persist;
        // this dispatcher owns stderr and owns which of their diagnostics count as
        // orchestration processing errors.
        const store: TaskGraphStore = mgr;
        const repository: RepositoryProbe = {
          root: () => git.repositoryRoot() ?? process.cwd(),
          isRepo: () => git.isGitRepo(),
        };
        const parentPrompt = event.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { type: string; text?: string }) => c.text ?? "")
          .join("\n");
        const emit = (applied: PiResultOutcome): void => {
          processingErrors.push(...applied.processingErrors);
          for (const line of applied.log) process.stderr.write(`${line}\n`);
        };

        // A failed process may retain valid-looking assistant text. Never parse
        // that text as completion/review/spec evidence. Persist gate-owned
        // failure only under exact current reserved authority, so stale evidence
        // cannot overwrite a newer slot while a healthy sibling remains visible.
        if (piSubagentResultFailed(result)) {
          emit(await applyFailedPiResult({
            store,
            agentType,
            result,
            reservedSlot: reservedItem,
            now: new Date().toISOString(),
          }));
          continue;
        }

        // --- Phase agent → advance phase ---
        const completedPhase = PHASE_AGENT_MAP[agentType];
        if (completedPhase) {
          emit(await applyPhaseAgentPiResult({
            store,
            agentType,
            completedPhase,
            result,
            now: new Date().toISOString(),
          }));
          continue;
        }

        // --- Impl agent → update task status ---
        if (IMPL_AGENTS.has(agentType)) {
          emit(await applyImplementationPiResult({
            store,
            repository,
            agentType,
            result,
            reservedSlot: reservedItem,
            parentPrompt,
          }));
          continue;
        }

        // --- Review agent → store findings ---
        if (isReviewAgent(agentType)) {
          emit(await applyReviewPiResult({
            store,
            agentType,
            result,
            reservedSlot: reservedItem,
            parentPrompt,
          }));
          continue;
        }

        // --- Spec-check invoker → store spec-check findings ---
        if (agentType === "spec-check-invoker") {
          emit(await applySpecCheckPiResult({
            store,
            result,
            reservedSlot: reservedItem,
            now: new Date().toISOString(),
          }));
          continue;
        }
      } catch (err) {
        // Loud + isolated: name the agent, the task (best effort), and the
        // cause, then continue with the next result.
        let taskIdForLog = "<unknown>";
        let taskIdFailure = "";
        try {
          taskIdForLog = extractTaskId(result?.task ?? "") ?? "<unknown>";
        } catch (error) {
          taskIdFailure = `; task-id extraction failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        const diagnostic = `result ${resultIndex + 1} for agent ${String(result?.agent ?? "<unknown>")} (task ${taskIdForLog}${taskIdFailure}): ${err instanceof Error ? err.message : String(err)}`;
        processingErrors.push(diagnostic);
        process.stderr.write(
          `loom(pi): subagent-stop processing failed for ${diagnostic} — continuing with remaining results\n`,
        );
      }
    }

    await cleanupParentTaskGraphPointer();
    return processingErrorResponse();
  });

  // ─── Commands ─────────────────────────────────────────────────────────

  pi.registerCommand("loom-status", {
    description: "Show current loom orchestration status",
    handler: async (_args, ctx) => {
      const activeTaskGraphPath = taskGraphPath();
      if (!pathExistsFailClosed(activeTaskGraphPath)) {
        ctx.ui.notify("No active loom orchestration", "info");
        return;
      }

      try {
        const sm = StateManager.fromPath(activeTaskGraphPath);
        if (!sm) {
          ctx.ui.notify("Could not load task graph", "error");
          return;
        }
        const state = sm.load();
        const totalTasks = state.tasks.length;
        const completed = state.tasks.filter(t => t.status === "completed").length;
        const failed = state.tasks.filter(t => t.status === "failed").length;
        const pending = state.tasks.filter(t => t.status === "pending").length;

        ctx.ui.notify(
          [
            `Phase: ${state.current_phase}`,
            `Wave: ${state.current_wave ?? 1}`,
            `Tasks: ${completed}/${totalTasks} done, ${pending} pending, ${failed} failed`,
            state.github_issue ? `Issue: #${state.github_issue}` : "",
          ].filter(Boolean).join(" | "),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
