/**
 * Loom Pi Extension
 *
 * Bridges loom's orchestration engine to pi's extension API.
 * Delegates to engine/src/core/ for all business logic.
 */

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { accessSync, constants as fsConstants, existsSync, unlinkSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Engine core — harness-agnostic, no Claude Code dependency (these do fs I/O)
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
import { guardStateFileDecision } from "../engine/src/core/guard-state-file";
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
// Both harnesses share ONE protected-state read seam, so a Pi gate and a
// Claude gate cannot disagree about what "no active plan" means.
import { realPhaseOrderDeps } from "../engine/src/handlers/pre-tool-use/validate-phase-order";
import { classifyTaskExecutionSpawn, type TaskExecutionSpawn } from "../engine/src/core/validate-task-execution";
import { validateTaskExecutionBatch } from "../engine/src/handlers/task-execution";
import { validateTemplateSubstitution } from "../engine/src/core/validate-template-substitution";
import { classifyPiSpawnItems, expectedSpawnModel } from "../engine/src/core/model-profiles";


// Engine parsers (format-aware)
import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";

// Engine SubagentStop logic (harness-agnostic functions already exported)
import {
  extractTestEvidence,
  collectNewTestEvidence,
  cumulativeModifiedPaths,
  applyUntrustedStopResolution,
} from "../engine/src/handlers/subagent-stop/update-task-status";
import { resolveTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  hasStandaloneReviewContext,
  resolveTaskReviewFindings,
  reviewResolutionLog,
  type ReviewResolution,
} from "../engine/src/core/review-output";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../engine/src/core/spec-check";
import { newWaveGate } from "../engine/src/types";

// `isReviewAgent` lives in `config`, NOT in `core/review-output` beside the three
// functions above it: it reads the review-agent roster, and `core/review-output`
// declares itself free of config so its parse/merge rules stay pure. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook below, not just review capture. `tests/pi-imports.test.ts`
// resolves every engine import in this file against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, taskGraphPath, subagentDir, PHASE_AGENT_MAP, IMPL_AGENTS, PHASE_ORDER, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import { fsSessionRegistry, parseAgentId, parseSessionId, rosterAgentId } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { buildContextOutput } from "../engine/src/handlers/session-start/resume-after-clear";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import * as git from "../engine/src/utils/git";

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import { messagesToClaudeJsonl, parsePiMessages, piResultFinalPayloadCandidates, piStructuredTestDiagnostics, piStructuredTestResult } from "./transcript-adapter";
// FR-033: Pi and Claude Code capture each completed reviewer/verifier output
// into the SAME engine-declared slot under the same refusals. Both drive this
// one runtime; only the native correlator and the payload observation differ.
import {
  captureAuditLine,
  captureHarnessResult,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  type CaptureOutcome,
} from "../engine/src/orchestration/harness-capture-runtime";
import { openRunDirectory } from "../engine/src/orchestration/run-directory-handle";
import {
  readSessionRunBindings,
  type SessionRunBinding,
} from "../engine/src/orchestration/session-run-bindings";
import { captureKey } from "../engine/src/core/harness-capture";
import { materializePiResources } from "./resources";
import { checkAgentSkillPrompt } from "../engine/src/core/agent-skills";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import { canonicalRepositoryPaths } from "../engine/src/utils/repository-path";
import {
  compareAttemptBaseline,
} from "../engine/src/utils/artifact-baseline";
import { planPiWriteGrants } from "../engine/src/core/pi-write-grant-plan";
import {
  consumePiWriteGrant,
  injectPiWriteGrant,
  issuePiWriteGrant,
  revokePiWriteGrant,
  sweepExpiredPiWriteGrants,
  writeTargetViolatesScope,
} from "./write-grant";
import {
  captureLoomRuntimeIdentity,
  loadedRuntimeCompatibility,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../engine/src/runtime-compatibility";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Capture once, while this extension module is loaded. Fresh CLI processes
// hash the checkout again before mutation; a changed checkout therefore cannot
// write a schema this in-memory runtime may not parse.
const LOADED_RUNTIME_IDENTITY = captureLoomRuntimeIdentity(PACKAGE_ROOT);
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_RESOURCE_CACHE = join(PI_AGENT_DIR, "cache", "loom-resources");

/**
 * Fail-closed path existence check. Returns `true` (assume active) for any
 * access error other than ENOENT — prevents EACCES, ELOOP, and other
 * non-absence errors from silently disabling orchestration guards.
 */
function pathExistsFailClosed(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Non-ENOENT error (EACCES, ELOOP, etc.): assume path exists → fail closed.
    process.stderr.write(
      `loom(pi): pathExistsFailClosed cannot access ${path}: ${(error as Error).message} — assuming active (fail closed)\n`,
    );
    return true;
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

/** Stable per-spawn roster identity shared by tool_call and tool_result.
 * Task text is deliberately excluded: Pi substitutes `{previous}` in chain
 * results, so it is not stable across the lifecycle. */
function piSpawnItem(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  const entries = Array.isArray(raw.tasks)
    ? raw.tasks
    : Array.isArray(raw.chain)
      ? raw.chain
      : [raw];
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
  const cwd = typeof entry.cwd === "string"
    ? entry.cwd
    : typeof input.cwd === "string"
      ? input.cwd
      : defaultCwd;
  return resolve(defaultCwd, cwd);
}

/**
 * The `command` a Pi bash call carries, or `""`.
 *
 * The harness types a tool call's `input` as an opaque record, so reading
 * `.command` off it is an unchecked assumption about a value that arrives from
 * outside. An absent or non-string command must read as the empty string (which
 * the guard judges as an empty command line) rather than as `undefined` flowing
 * into a function that expects text.
 */
export function piBashCommand(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "";
  const command = (raw as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

/** Extract the file path(s) a Pi Edit/Write/multi_edit call targets. Returns
 *  [] when the shape is unrecognized — scoped grants then fail closed. */
export function piWriteTargetPaths(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const input = raw as Record<string, unknown>;
  const direct = input.path ?? input.file_path ?? input.filePath;
  if (typeof direct === "string" && direct !== "") return [direct];
  if (Array.isArray(input.edits)) {
    const paths: string[] = [];
    for (const edit of input.edits) {
      if (typeof edit !== "object" || edit === null || Array.isArray(edit)) continue;
      const p = (edit as Record<string, unknown>).path ?? (edit as Record<string, unknown>).file_path;
      if (typeof p === "string" && p !== "" && !paths.includes(p)) paths.push(p);
    }
    return paths;
  }
  return [];
}

export function replacePiSpawnTask(raw: unknown, index: number, task: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Pi subagent input must be an object before write-grant injection");
  }
  const input = raw as Record<string, unknown>;
  piSpawnItem(input, index).task = task;
}

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
 * Capture one finished Pi subagent result into its reserved run-directory slot.
 *
 * Pi's native correlator is `piSpawnRosterId(toolCallId, index, agent)` — the
 * same stable per-spawn identity the lifecycle registry already uses, and the
 * only thing available on both the spawn and result sides of a Pi batch. The
 * spawn side records it beside the reservation; a result whose correlator is
 * absent belongs to some other agent and is ignored, not failed.
 *
 * This is a fail-spawn boundary and therefore throws when exact run/request
 * authority cannot be recorded. The tool-call guard catches the failure,
 * rolls back lifecycle reservations, and refuses dispatch.
 */
export async function recordPiSpawnCorrelators(
  items: readonly Readonly<{ agent: string; task: string }>[],
  rosterIds: readonly string[],
  rawSessionId: string,
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
    consumed.add(request.requestId);
  }
  return runBinding;
}

async function recordPiRequestCaptureRejection(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  diagnostic: string,
): Promise<void> {
  const opened = openRunDirectory(runBinding.runsRoot, runBinding.runDirectory);
  if (!opened.ok) {
    process.stderr.write(
      `loom(pi): recordPiRequestCaptureRejection: cannot open run directory ${runBinding.runDirectory}: ${opened.error.message}\n`,
    );
    return;
  }
  const correlator = opened.value.readHarnessCorrelator(
    "pi", piSpawnRosterId(toolCallId, resultIndex, agentType),
  );
  if (!correlator.ok || correlator.value === null) {
    process.stderr.write(
      `loom(pi): recordPiRequestCaptureRejection: cannot resolve correlator for ${agentType}[${resultIndex}]: ${correlator.ok ? "no binding found" : correlator.error.message}\n`,
    );
    return;
  }
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) {
    process.stderr.write(
      `loom(pi): recordPiRequestCaptureRejection: cannot read issued requests: ${issued.error.message}\n`,
    );
    return;
  }
  const request = issued.value.find(({ requestId }) => requestId === correlator.value?.requestId);
  if (request === undefined) {
    process.stderr.write(
      `loom(pi): recordPiRequestCaptureRejection: correlator request ${correlator.value.requestId} has no issued authority\n`,
    );
    return;
  }
  const existingEvents = await opened.value.readEvents();
  const alreadyRecorded = existingEvents.some(({ event }) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const record = event as Record<string, unknown>;
    return record.kind === "request-capture-rejected" && record.requestId === request.requestId &&
      record.slotId === request.slotId && record.attempt === request.attempt;
  });
  if (alreadyRecorded) return;
  await opened.value.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `capture-rejected:${createHash("sha256").update(`${request.requestId}:${request.attempt}`).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: {
      kind: "request-capture-rejected",
      requestId: request.requestId,
      slotId: request.slotId,
      attempt: request.attempt,
      diagnostic,
    },
  });
}

function piResultAuthorityProblem(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  markers: PiOrchestrationMarkers,
): string | null {
  const opened = openRunDirectory(runBinding.runsRoot, runBinding.runDirectory);
  if (!opened.ok) return opened.error.message;
  const nativeId = piSpawnRosterId(toolCallId, resultIndex, agentType);
  const correlator = opened.value.readHarnessCorrelator("pi", nativeId);
  if (!correlator.ok) return correlator.error.message;
  if (correlator.value === null) return `no durable Pi correlator exists for result index ${resultIndex}`;
  if (correlator.value.requestId !== markers.requestId) {
    return `result marker ${markers.requestId} does not match correlated request ${correlator.value.requestId}`;
  }
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) return issued.error.message;
  const request = issued.value.find(({ requestId }) => requestId === correlator.value?.requestId);
  if (request === undefined) return `correlated request ${correlator.value.requestId} is no longer issued`;
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
    const outcome = await captureHarnessResult({
      harness: "pi",
      runsRoot: runBinding?.runsRoot ?? process.env[RUNS_ROOT_ENV],
      runDirectory: runBinding?.runDirectory ?? process.env[RUN_DIR_ENV],
      nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType),
      // Malformed messages yield NO candidate rather than a guess, so the
      // ambiguity rules reject instead of accepting salvage — the same posture
      // the Claude adapter takes for an unreadable transcript.
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

/** Pi result failure boundary. Missing/malformed exit codes fail closed. */
export function piSubagentResultFailed(result: {
  readonly exitCode?: unknown;
  readonly stopReason?: unknown;
}): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
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

type PiSessionId = NonNullable<ReturnType<typeof parseSessionId>>;

type PiSpawnReservation = Readonly<{
  sessionId: PiSessionId;
  needsTaskGraphLifecycle: boolean;
  orchestrationRunBinding: SessionRunBinding | null;
  items: readonly Readonly<{
    agentType: string;
    rosterId: AgentId;
    taskId: string | null;
    /** The closed lifecycle union, not an independent boolean pair: two
     *  booleans admitted the impossible {implementation: true, standalone:
     *  true} and left the third lifecycle state nameless. The source union's
     *  exhaustiveness carries through the adapter. */
    kind: TaskExecutionSpawn["kind"];
  }>[];
}>;

const MAX_PI_ORCHESTRATION_BATCH_SIZE = 8;

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
      orchestrationRunBinding: binding,
      items: Object.freeze(indexes.map((index) => {
        const item = byIndex.get(index)!;
        return Object.freeze({
          agentType: item.agentType,
          rosterId: item.rosterId,
          taskId: null,
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
  taskGraphPointerOwned: boolean;
}

const emptyParentSessionRuntime = (): PiParentSessionRuntime => ({
  issuedWriteGrants: new Map(),
  spawnReservations: new Map(),
  taskGraphPointerOwned: false,
});

export default function (pi: ExtensionAPI) {
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
    if (runtime.issuedWriteGrants.size === 0 && runtime.spawnReservations.size === 0 &&
        !runtime.taskGraphPointerOwned) {
      parentSessionRuntimes.delete(sessionId);
    }
  };
  const activeChildWriteGrants = new Map<string, {
    agentId: AgentId;
    pointerCreated: boolean;
    /** Present only on scoped (phase/panel) grants: Edit/Write targets must
     *  fall inside one of these artifact dirs. Scopes resolve against
     *  `grantCwd` (the spawn cwd), which is also the base relative targets
     *  are judged against. */
    scopeDirs?: readonly string[];
    grantCwd?: string;
  }>();
  const rejectedChildWriteGrantSessions = new Set<string>();

  // ─── Resource Discovery ───────────────────────────────────────────────
  // Contribute skills from this package that aren't in the pi manifest's
  // auto-discovery (the manifest covers skills/ and commands/ already,
  // but we also register agents dir for the subagent tool).

  // Pi does not expand Claude Code's CLAUDE_PLUGIN_ROOT token in markdown.
  // Render package-owned prompts and skills from THIS extension's import URL;
  // cwd and the Claude plugin cache are never package identity.
  process.env.LOOM_PLUGIN_ROOT = LOADED_RUNTIME_IDENTITY.packageRoot;
  // Commands executed by Pi's Bash tool inherit process environment. This
  // handshake binds every fresh mutating CLI process to the exact source bytes
  // this extension loaded, preventing mutable-checkout split brain.
  process.env[PI_EXTENSION_RUNTIME_ROOT_ENV] = LOADED_RUNTIME_IDENTITY.packageRoot;
  process.env[PI_EXTENSION_RUNTIME_REVISION_ENV] = LOADED_RUNTIME_IDENTITY.revision;
  pi.on("resources_discover", () => {
    const resources = materializePiResources(PACKAGE_ROOT, PI_RESOURCE_CACHE);
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
      if (event.toolName === "subagent") {
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
        const result = shouldBlockDirectEdit(event.toolName, sessionId, () => graphIsActive);
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
          if (targets.length === 0) {
            return {
              block: true,
              reason: "BLOCKED: cannot verify the write target for a scoped phase-agent write grant; refusing the edit.",
            };
          }
          for (const target of targets) {
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
        const result = graphIsActive
          ? guardStateFileDecision(piBashCommand(event.input))
          : { kind: "allow" as const };
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

      // Subagent tool → parse and preflight EVERY single/parallel/chain item
      // before any tracking mutation. A malformed sibling blocks the whole
      // batch; otherwise one parallel item could bypass the gates that the
      // top-level `agent`/`task` fields never represented.
      if (event.toolName === "subagent") {
        currentGuard = "parse-pi-subagent-batch";
        const classifiedItems = classifyPiSpawnItems(event.input);
        if (!classifiedItems.ok) return { block: true, reason: classifiedItems.error.message };
        if (classifiedItems.value.kind === "external") {
          // Loom owns only its catalog outside orchestration. During an active
          // graph, an unknown agent would bypass phase/task/model gates; without
          // one, it belongs to another Pi workflow and must pass through.
          if (graphIsActive) {
            return {
              block: true,
              reason: "External Pi subagents cannot run while a Loom task graph is active",
            };
          }
          return;
        }
        const parsedItems = classifiedItems.value.items;
        if (parsedItems.length > MAX_PI_ORCHESTRATION_BATCH_SIZE) {
          return {
            block: true,
            reason: `Pi transport accepts at most ${MAX_PI_ORCHESTRATION_BATCH_SIZE} requests per subagent call; partition the engine-issued spawn-batch into ordered chunks without changing, dropping, or duplicating requests.`,
          };
        }
        const taskExecutionSpawns = parsedItems.map((item) => classifyTaskExecutionSpawn({
          agentType: item.agent,
          prompt: item.task,
          description: "",
        }));
        const needsTaskGraphLifecycle = taskExecutionSpawns.some((spawn) => spawn.kind !== "standalone");

        // Panel mode's interview stage requires interactive AskUserQuestion: an
        // arch-interviewer-agent must question the USER before writing the
        // digest that drives lens/judge selection. Pi children are headless
        // (no TUI, no question relay — see docs/pi-phase-agent-interviews.md),
        // so the agent can neither ask nor honestly answer. Refuse with an
        // actionable diagnostic instead of letting a fabricated digest drive
        // the panel (or a confusing retry/terminal-block loop).
        const interviewSpawns = parsedItems.filter((item) =>
          stripNamespace(item.agent) === "arch-interviewer-agent");
        if (interviewSpawns.length > 0) {
          return {
            block: true,
            reason: "BLOCKED: `/loom --panel` interview stage cannot run under pi: " +
              "arch-interviewer-agent needs interactive AskUserQuestion, which pi " +
              "children do not support (docs/pi-phase-agent-interviews.md). " +
              "Panel mode currently requires Claude Code for the interview; a " +
              "headless interview path or a question relay is not yet implemented.",
          };
        }

        const requestedScope = (event.input as { agentScope?: unknown }).agentScope ?? "user";
        if (requestedScope !== "user") {
          return {
            block: true,
            reason: `Loom-owned Pi agents require agentScope='user' so the validated generated definition is exactly the definition Pi executes; got ${JSON.stringify(requestedScope)}.`,
          };
        }

        for (const item of parsedItems) {
          const expected = expectedSpawnModel(item.agent, "pi");
          const definitionPath = join(PI_AGENT_DIR, "agents", `${item.agent}.md`);
          const definition = validatePiAgentDefinitionFile(
            definitionPath,
            item.agent,
            PACKAGE_ROOT,
          );
          if (!expected.ok || !definition.ok) {
            return {
              block: true,
              reason: expected.ok
                ? `Pi agent '${item.agent}' must be rendered from active Loom package ${PACKAGE_ROOT}: ${definition.ok ? "unknown definition mismatch" : definition.error}. Run \"${PACKAGE_ROOT}/scripts/sync-pi-agents.sh\" and /reload.`
                : expected.error.message,
            };
          }

          currentGuard = "validate-agent-skill";
          const sourceAgentPath = join(PACKAGE_ROOT, "agents", `${item.agent}.md`);
          let sourceAgent: string;
          try {
            sourceAgent = readFileSync(sourceAgentPath, "utf-8");
          } catch (error) {
            return {
              block: true,
              reason: `Cannot read active Loom agent definition ${sourceAgentPath}: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          const skillCheck = checkAgentSkillPrompt(sourceAgent, item.task);
          if (!skillCheck.ok) {
            return {
              block: true,
              reason: `Pi agent '${item.agent}' skill policy failed: ${skillCheck.error}`,
            };
          }

          currentGuard = "validate-phase-order";
          const phaseResult = validatePhaseOrder(
            { agentType: item.agent, prompt: item.task },
            realPhaseOrderDeps,
          );
          if (phaseResult.kind === "block") return { block: true, reason: phaseResult.message };

          currentGuard = "validate-template-substitution";
          const templateResult = validateTemplateSubstitution(item.task);
          if (templateResult.kind === "block") return { block: true, reason: templateResult.message };

        }

        // Reserve every lifecycle identity before task-state mutation. A roster
        // failure can now refuse the spawn without leaving executing_tasks or
        // artifact baselines claiming work began. The ids include batch ordinal
        // and task text, so repeated verifier/designer types remain distinct.
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
        let taskGraphPointerCreated = false;
        let orchestrationRunBinding: SessionRunBinding | null = null;
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
          if (taskGraphPointerCreated) {
            actions.push({
              label: "remove task-graph pointer",
              run: () => unlinkSync(`${subagentDir()}/${safeSessionId}.task_graph`),
            });
          }
          return runPiCleanupActions(actions);
        };
        try {
          mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
          for (const agentId of rosterIds) {
            await fsSessionRegistry.markActive(safeSessionId, agentId);
            reserved.push(agentId);
          }
          const activeTaskGraphPath = taskGraphPath();
          if (needsTaskGraphLifecycle && existsSync(activeTaskGraphPath)) {
            const taskGraphFile = `${subagentDir()}/${safeSessionId}.task_graph`;
            if (!existsSync(taskGraphFile)) {
              writeFileSync(taskGraphFile, resolve(activeTaskGraphPath));
              taskGraphPointerCreated = true;
            }
          }
          // Bind every Loom-owned Pi native spawn identity to the exact issued
          // request before the harness can dispatch the batch. The durable run
          // directory, not the in-memory lifecycle map below, owns capture
          // authority for both Pi and Claude.
          orchestrationRunBinding = await recordPiSpawnCorrelators(parsedItems, rosterIds, safeSessionId);
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
            try {
              writeGrants.push({
                index,
                token: grant.token,
                task: injectPiWriteGrant(item.task, grant),
                originalTask: item.task,
                injected: false,
              });
            } catch (error) {
              revokePiWriteGrant(grant.token);
              throw error;
            }
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
        let taskResult;
        try {
          const executionMode = Array.isArray((event.input as { chain?: unknown }).chain)
            ? "sequential" as const
            : "parallel" as const;
          taskResult = await validateTaskExecutionBatch(taskExecutionSpawns, executionMode);
        } catch (error) {
          const cleanupErrors = await rollbackLifecycle();
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}${cleanupFailureSuffix(cleanupErrors)}`,
            error instanceof Error ? { cause: error } : undefined,
          );
        }
        if (taskResult.kind === "block") {
          const cleanupErrors = await rollbackLifecycle();
          return { block: true, reason: `${taskResult.message}${cleanupFailureSuffix(cleanupErrors)}` };
        }
        const sessionRuntime = runtimeFor(safeSessionId);
        if (writeGrants.length > 0) {
          sessionRuntime.issuedWriteGrants.set(toolCallId, writeGrants.map((grant) => grant.token));
        }
        if (taskGraphPointerCreated) sessionRuntime.taskGraphPointerOwned = true;
        sessionRuntime.spawnReservations.set(toolCallId, {
          sessionId: safeSessionId,
          needsTaskGraphLifecycle,
          orchestrationRunBinding,
          items: parsedItems.map((item, index) => ({
            agentType: item.agent,
            rosterId: rosterIds[index]!,
            taskId: extractTaskId(item.task),
            kind: taskExecutionSpawns[index]?.kind ?? "non-implementation",
          })),
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
  });

  // ─── Session Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    // Cleanup stale subagent tracking files — the ENGINE's sweep, not a
    // per-file twin: staleness is judged per session GROUP (max mtime across
    // the session's files), and the TTL is the shared STALE_SUBAGENT_TTL_MS,
    // so a live session's roster/ledger can't be reaped out from under a
    // fresh `.machine` anchor.
    sweepStaleSessions(subagentDir(), Date.now() - STALE_SUBAGENT_TTL_MS);
    sweepExpiredPiWriteGrants();
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
      const pointer = `${subagentDir()}/${sessionId}.task_graph`;
      const pointerCreated = !existsSync(pointer);
      if (pointerCreated) writeFileSync(pointer, grant.taskGraphPath, { mode: 0o600 });
      activeChildWriteGrants.set(sessionId, { agentId, pointerCreated, scopeDirs: grant.scopeDirs, grantCwd: grant.cwd });
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
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const rawSessionId = ctx.sessionManager.getSessionId() ?? "";
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
      if (binding.pointerCreated) {
        actions.push({
          label: `remove child task-graph pointer for ${sessionId}`,
          run: () => rmSync(`${subagentDir()}/${sessionId}.task_graph`, { force: true }),
        });
      }
    }
    for (const reservation of parentRuntime?.spawnReservations.values() ?? []) {
      for (const item of reservation.items) {
        actions.push({
          label: `remove shutdown roster entry for ${item.agentType}`,
          run: () => fsSessionRegistry.removeActive(reservation.sessionId, item.rosterId),
        });
      }
    }
    if (sessionId && parentRuntime?.taskGraphPointerOwned) {
      actions.push({
        label: `remove parent task-graph pointer for ${sessionId}`,
        run: () => rmSync(`${subagentDir()}/${sessionId}.task_graph`, { force: true }),
      });
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

  pi.on("before_agent_start", async (_event, _ctx) => {
    const activeTaskGraphPath = taskGraphPath();
    if (!existsSync(activeTaskGraphPath)) return;

    const sm = StateManager.fromPath(activeTaskGraphPath);
    if (!sm) return;

    let state;
    try {
      state = sm.load();
    } catch (err) {
      process.stderr.write(
        `loom(pi): resume context skipped — task graph unreadable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

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


  // ─── PostEdit Lint (tool_result event for edit/write) ─────────────────
  // After edit/write lands on disk, run immediate-tier lint.
  // If violations: inject error content so agent sees and fixes.
  // If pass: return undefined (no injection).
  // If error: fail-closed — inject error content.

  pi.on("tool_result", async (event, _ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "multi_edit") return;

      // Skip if the tool itself errored (file may not exist on disk)
      if (event.isError) return;

      const projectRoot = process.cwd();
      const projectRulesPath = join(projectRoot, PROJECT_RULES_DIR);
      const projectRulesDir = existsSync(projectRulesPath) ? projectRulesPath : null;

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
      // Fail-closed: any error \u2192 inject error content to block the edit
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `\u274c LINT ENGINE ERROR: ${message}` }],
        isError: true,
      };
    }
  });

  // ─── SubagentStop Dispatch (tool_result event) ────────────────────────
  // When a subagent completes, handle phase advancement, task status
  // updates, and review findings — equivalent of SubagentStop hooks.

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "subagent") return;

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

    // Consume only this session's reservation. Capability, roster, and owned
    // pointer cleanup are isolated: one failure is reported but never prevents
    // result reconciliation or the remaining cleanup actions.
    if (typeof toolCallId === "string" && sessionRuntime) {
      sessionRuntime.spawnReservations.delete(toolCallId);
    }
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
    if (reservationRecoveryFailed) return processingErrorResponse();
    let parentPointerCleanupAttempted = false;
    const cleanupParentTaskGraphPointer = async (): Promise<void> => {
      if (parentPointerCleanupAttempted || !resultSessionId || !sessionRuntime?.taskGraphPointerOwned ||
          [...sessionRuntime.spawnReservations.values()].some((entry) => entry.needsTaskGraphLifecycle)) {
        return;
      }
      parentPointerCleanupAttempted = true;
      const errors = await runPiCleanupActions([{
        label: `remove parent task-graph pointer for ${resultSessionId}`,
        run: () => {
          rmSync(`${subagentDir()}/${resultSessionId}.task_graph`, { force: true });
          sessionRuntime.taskGraphPointerOwned = false;
        },
      }]);
      processingErrors.push(...errors);
      for (const error of errors) process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${error}\n`);
      pruneRuntime(resultSessionId, sessionRuntime);
    };

    const finalizeReservedImplementations = async (
      rawResults: readonly unknown[],
    ): Promise<readonly string[]> => {
      if (!reservation || !reservation.items.some((item) => item.kind === "implementation")) return [];
      const manager = StateManager.fromSession(reservation.sessionId);
      if (!manager) {
        const diagnostic = `cannot finalize reserved implementation attempts for session ${reservation.sessionId} — task graph unavailable`;
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
        return [diagnostic];
      }
      const root = git.repositoryRoot() ?? process.cwd();
      try {
        await manager.update((initial) => {
          let state = initial;
          for (const [index, item] of reservation.items.entries()) {
            if (item.kind !== "implementation" || item.taskId === null) continue;
            const raw = rawResults[index];
            const envelope = typeof raw === "object" && raw !== null && !Array.isArray(raw)
              ? raw as Record<string, unknown>
              : null;
            const resultAgent = typeof envelope?.agent === "string"
              ? stripNamespace(envelope.agent)
              : null;
            const succeeded = resultAgent === item.agentType && !piSubagentResultFailed({
              exitCode: envelope?.exitCode,
              stopReason: envelope?.stopReason,
            });
            if (succeeded) continue;

            const task = state.tasks.find((candidate) => candidate.id === item.taskId);
            if (!task) {
              state = {
                ...state,
                executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== item.taskId),
              };
              continue;
            }

            const comparison = compareAttemptBaseline(root, task, { kind: "repository" });
            const { changedDeclaredArtifacts, bytesChangedSinceAttempt } = comparison;
            if (comparison.failure !== null) {
              // Comparison failure cannot prove the old evidence still matches
              // current bytes. The shared helper already failed closed
              // (bytesChangedSinceAttempt: true); retain the concrete
              // diagnostic for the operator.
              process.stderr.write(
                `loom(pi): failed-attempt baseline comparison failed for ${item.taskId}: ${comparison.failure} — invalidating stale evidence\n`,
              );
            }

            if (!bytesChangedSinceAttempt) {
              state = {
                ...state,
                executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== item.taskId),
              };
              continue;
            }

            const failure = resultAgent !== null && resultAgent !== item.agentType
              ? `reserved ${item.agentType} result was returned as ${resultAgent}`
              : envelope === null
                ? "reserved implementation result was missing or malformed"
                : `${item.agentType} failed before implementation evidence completed`;
            state = applyUntrustedStopResolution(state, item.taskId, {
              taskCompleted: false,
              testResult: { verdict: "untrusted", passed: false, label: "pi-implementation-failed" },
              testEvidence: failure,
              // The repository attempt baseline is shared by a parallel batch.
              // Its delta proves stale evidence must be invalidated, but cannot
              // attribute any sibling's paths to this failed task.
              filesModified: [],
              changedDeclaredArtifacts,
              bytesChangedSinceAttempt: true,
              newTestsWritten: false,
              newTestEvidence: "",
            }).state;
          }
          return state;
        });
        return [];
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
    processingErrors.push(...await finalizeReservedImplementations(rawResults));

    // A reservation is the authoritative expected batch. Pi may return a
    // shorter or reordered results array after a child disappears. Reconcile
    // every gate-owned slot before any malformed-details early return so stale
    // review/spec evidence cannot remain authoritative.
    if (reservation) {
      const returnedAgentAt = (index: number): string | null => {
        const raw = rawResults[index];
        if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("agent" in raw)) return null;
        return typeof raw.agent === "string" ? stripNamespace(raw.agent) : null;
      };
      const missingReviews = reservation.orchestrationRunBinding !== null
        ? []
        : reservation.items.flatMap((item, index) =>
            item.kind === "standalone" || item.taskId === null || !isReviewAgent(item.agentType) ||
              returnedAgentAt(index) === item.agentType
              ? []
              : [{ item, index }]);
      const missingSpecChecks = reservation.orchestrationRunBinding !== null
        ? []
        : reservation.items.flatMap((item, index) =>
            item.kind === "standalone" || item.agentType !== "spec-check-invoker" ||
              returnedAgentAt(index) === item.agentType
              ? []
              : [{ item, index }]);
      const missingRunResults = reservation.orchestrationRunBinding === null
        ? []
        : reservation.items.flatMap((item, index) =>
            returnedAgentAt(index) === item.agentType ? [] : [{ item, index }]);
      for (const { item, index } of missingRunResults) {
        const diagnostic = `request-bound result ${index + 1} for ${item.agentType} was missing or mismatched`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}; run transcript was not captured\n`);
      }
      if (missingReviews.length > 0 || missingSpecChecks.length > 0) {
        const manager = StateManager.fromSession(reservation.sessionId);
        if (!manager) {
          const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
            `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId} — task graph unavailable`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        } else {
          const runAt = new Date().toISOString();
          await manager.update((state) => ({
            ...state,
            tasks: state.tasks.map((task) => {
              const failures = missingReviews.filter(({ item }) => item.taskId === task.id);
              return failures.reduce((current, { item, index }) => applyReviewResolution(current, {
                kind: "evidence-failed" as const,
                agent: item.agentType,
                message: `reserved reviewer result ${index + 1} for ${item.agentType} was missing or mismatched`,
              }), task);
            }),
            ...(missingSpecChecks.length === 0
              ? {}
              : {
                  spec_check: {
                    wave: state.current_wave ?? 1,
                    run_at: runAt,
                    verdict: "EVIDENCE_CAPTURE_FAILED" as const,
                    error: missingSpecChecks.map(({ index }) =>
                      `reserved spec-check result ${index + 1} for spec-check-invoker was missing or mismatched`
                    ).join("; "),
                  },
                }),
          }));
          for (const { item, index } of missingReviews) {
            process.stderr.write(
              `loom(pi): reserved reviewer result ${index + 1} for ${item.agentType}/${item.taskId} was missing or mismatched — marking evidence_capture_failed\n`,
            );
          }
          for (const { index } of missingSpecChecks) {
            process.stderr.write(
              `loom(pi): reserved spec-check result ${index + 1} for spec-check-invoker was missing or mismatched — marking evidence_capture_failed\n`,
            );
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
    const results = rawResults as Array<{
      agent: string;
      task: string;
      exitCode: number;
      stopReason?: string;
      messages: unknown;
    }>;
    if (reservation && results.length > reservation.items.length) {
      const diagnostic =
        `subagent tool_result returned ${results.length} result(s) for ${reservation.items.length} reserved slot(s) — surplus evidence ignored`;
      processingErrors.push(diagnostic);
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
    }
    const authorizedResults = reservation ? results.slice(0, reservation.items.length) : results;
    for (const [resultIndex, result] of authorizedResults.entries()) {
      // Per-result error isolation (mirrors dispatch.ts's safeRun): a throw
      // while processing result #1 must not abort results #2..N — that
      // leaves tasks stuck "executing" with zero diagnostics.
      try {
      const agentType = stripNamespace(result.agent);
      const sessionId = _ctx.sessionManager.getSessionId() ?? "unknown";
      const reservedItem = reservation?.items[resultIndex];
      const markers = orchestrationMarkers(
        result.task ?? "",
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
          await recordPiRequestCaptureRejection(
            durableRunBinding, toolCallId, resultIndex, agentType, diagnostic,
          );
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
          process.stderr.write(`loom: subagent flag cleanup failed: ${(err as Error).message}\n`);
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
            message: `${agentType} exited without a successful result`,
          }
        : await capturePiSubagentResult(
            toolCallId,
            resultIndex,
            agentType,
            result.messages,
            durableRunBinding,
          );

      // Standalone review/refutation results are run artifacts. Short-circuit
      // before StateManager resolution so an unrelated local graph is neither
      // read nor mutated merely because it exists. When a run directory is
      // active, however, capture is mandatory evidence: a rejection or missing
      // correlator must be surfaced rather than disguised as a harmless
      // task-state short-circuit.
      if (runBound || reservedItem?.kind === "standalone" || hasStandaloneReviewContext(result.task ?? "")) {
        if (runBound && captureOutcome.kind !== "captured") {
          const detail = captureOutcome.kind === "rejected"
            ? `${captureOutcome.reason}: ${captureOutcome.message}`
            : captureOutcome.kind === "no-reservation"
              ? `no reservation for ${captureOutcome.agentId}`
              : "orchestration run authority was unavailable";
          const diagnostic = `standalone request-bound capture failed for ${agentType}: ${detail}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}; task state untouched\n`);
          if (durableRunBinding !== null) {
            await recordPiRequestCaptureRejection(
              durableRunBinding, toolCallId, resultIndex, agentType, diagnostic,
            );
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
        const detail = captureOutcome.kind === "rejected"
          ? `${captureOutcome.reason}: ${captureOutcome.message}`
          : captureOutcome.kind === "no-reservation"
            ? `no reservation for ${captureOutcome.agentId}`
            : "orchestration run authority was unavailable";
        const diagnostic = `request-bound capture rejected for ${agentType}: ${detail}`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}; protected state unchanged\n`);
        continue;
      }

      const mgr = StateManager.fromSession(sessionId);
      if (!mgr) {
        if (isLoomOwnedResultAgent(agentType)) {
          const diagnostic = `no task graph for session ${JSON.stringify(sessionId)}; ${agentType} completion was NOT applied`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        }
        continue;
      }

      // A failed process may retain valid-looking assistant text. Never parse
      // that text as completion/review/spec evidence, but do persist the
      // failed CAPTURE for gate-owned agents so a healthy sibling or stale pass
      // cannot make the missing evidence disappear.
      if (piSubagentResultFailed(result)) {
        const failure = `${agentType} failed before evidence capture completed (exitCode=${String(result.exitCode)}, stopReason=${String(result.stopReason ?? "unset")})`;
        if (isReviewAgent(agentType)) {
          const failedTaskId = reservedItem?.taskId ?? extractTaskId(result.task ?? "");
          if (failedTaskId === null || !mgr.load().tasks.some((task) => task.id === failedTaskId)) {
            process.stderr.write(
              `loom(pi): ${failure}; trusted task binding is missing or unknown — review evidence NOT stored\n`,
            );
            continue;
          }
          const resolution = { kind: "evidence-failed" as const, agent: agentType, message: failure };
          await mgr.update((s) => ({
            ...s,
            tasks: s.tasks.map((task) =>
              task.id === failedTaskId ? applyReviewResolution(task, resolution) : task
            ),
          }));
          process.stderr.write(reviewResolutionLog(failedTaskId, resolution) + "\n");
          continue;
        }
        if (agentType === "spec-check-invoker") {
          const runAt = new Date().toISOString();
          await mgr.update((s) => ({
            ...s,
            spec_check: {
              wave: s.current_wave ?? 1,
              run_at: runAt,
              verdict: "EVIDENCE_CAPTURE_FAILED" as const,
              error: failure,
            },
          }));
          process.stderr.write(`loom(pi): ${failure} — marking spec-check evidence_capture_failed\n`);
          continue;
        }
        if (IMPL_AGENTS.has(agentType) && !reservedItem) {
          const failedTaskId = extractTaskId(result.task ?? "");
          if (failedTaskId !== null) {
            await mgr.update((s) => ({
              ...s,
              executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== failedTaskId),
            }));
          }
        }
        process.stderr.write(`loom(pi): ${failure} — completion evidence ignored\n`);
        continue;
      }

      // --- Phase agent → advance phase ---
      const completedPhase = PHASE_AGENT_MAP[agentType];
      if (completedPhase) {
        // Parse the untrusted Pi envelope before artifact extraction. A valid
        // envelope with no write calls may still use the documented filesystem
        // fallback; a malformed envelope cannot authorize phase advancement.
        const parsedPhaseMessages = parsePiMessages(result.messages ?? []);
        if (!parsedPhaseMessages.ok) {
          const diagnostic = `${agentType} phase artifact extraction failed: ${parsedPhaseMessages.errors.join("; ")}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic} — phase was not advanced\n`);
          continue;
        }
        try {
          const specDir = mgr.load().spec_dir ?? ".claude/specs";
          for (const msg of parsedPhaseMessages.value) {
            if (msg.role !== "assistant") continue;
            for (const block of msg.content ?? []) {
              if (block.type !== "toolCall" || (block.name !== "write" && block.name !== "Write")) continue;
              const filePath = (block.arguments as Record<string, unknown>)?.path as string
                ?? (block.arguments as Record<string, unknown>)?.file_path as string;
              if (!filePath) continue;
              if (filePath.includes(specDir) && filePath.endsWith("/spec.md")) {
                await mgr.update((s) => ({ ...s, spec_file: filePath }));
              }
              if (filePath.includes(".claude/plans/") && filePath.endsWith(".md")) {
                await mgr.update((s) => ({ ...s, plan_file: filePath }));
              }
            }
          }
        } catch (err) {
          const diagnostic = `${agentType} phase artifact extraction failed: ${err instanceof Error ? err.message : String(err)}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic} — phase was not advanced\n`);
          continue;
        }

        const state = mgr.load();
        const currentIdx = PHASE_ORDER.indexOf(state.current_phase);
        const completedIdx = PHASE_ORDER.indexOf(completedPhase);

        if (!(completedIdx >= 0 && currentIdx > completedIdx)) {
          const transition = resolveTransition(completedPhase, state);
          if (transition) {
            try {
              await mgr.update((s) => ({
                ...s,
                current_phase: transition.nextPhase,
                phase_artifacts: { ...s.phase_artifacts, [completedPhase]: transition.artifact },
                // Also persist spec_file/plan_file if transition found them
                ...(transition.artifact.endsWith("/spec.md") ? { spec_file: transition.artifact } : {}),
                ...(transition.artifact.includes(".claude/plans/") ? { plan_file: transition.artifact } : {}),
                skipped_phases: transition.skipClarify
                  ? ([...new Set([...s.skipped_phases, "clarify" as const])])
                  : s.skipped_phases,
                updated_at: new Date().toISOString(),
              }));
            } catch (err) {
              const diagnostic = `phase advancement failed: ${err instanceof Error ? err.message : String(err)}`;
              processingErrors.push(diagnostic);
              process.stderr.write(`loom: ${diagnostic}\n`);
            }
          }
        }
        continue;
      }

      // --- Impl agent → update task status ---
      if (IMPL_AGENTS.has(agentType)) {
        // Extract task ID from the original task prompt (works in parallel mode)
        // Then get transcript from per-result messages for test evidence
        let taskId = reservedItem?.taskId ?? extractTaskId(result.task ?? "") ?? extractTaskId(
          event.content.filter((c: { type: string }) => c.type === "text").map((c: { type: string; text?: string }) => c.text ?? "").join("\n")
        );
        // Parse per-result messages at the untrusted harness boundary before
        // any consumer dereferences their content.
        const parsedMessages = parsePiMessages(result.messages ?? []);

        // Mirrors the engine's update-task-status: an unextractable task ID
        // must not vanish silently. Exactly one executing task → infer it;
        // ambiguous/empty → warn and clear executing_tasks (never mark tasks
        // failed — that cascades into evidence overwrites downstream).
        if (!taskId) {
          const st = mgr.load();
          const executing = st.executing_tasks ?? [];
          if (executing.length === 1) {
            process.stderr.write(
              `WARNING: ${agentType} task ID extraction failed, inferred task ${executing[0]} from executing_tasks\n`,
            );
            taskId = executing[0];
          } else {
            if (executing.length > 0) {
              process.stderr.write(
                `WARNING: ${agentType} completed without task ID, ${executing.length} tasks executing (ambiguous)\n`,
              );
            } else {
              process.stderr.write(
                `WARNING: ${agentType} completed without task ID and executing_tasks is empty — task status was NOT recorded\n`,
              );
            }
            await mgr.update((s) => ({ ...s, executing_tasks: [] }));
            continue;
          }
        }

        // Pre-lock snapshot: needed for start_sha / new_tests_required in the
        // evidence collection below. The skip guards here are only a cheap
        // fast path — the authoritative re-check runs INSIDE the locked
        // update (TOCTOU, see below).
        const state = mgr.load();
        const task = state.tasks.find((t) => t.id === taskId);
        // Evidence collection below needs a live unresolved task. A stopped
        // missing/completed/trusted task still needs locked execution cleanup;
        // skipping it outright leaves a ghost marker forever.
        if (!task || task.status === "completed") {
          await mgr.update((s) => ({
            ...s,
            executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
          }));
          process.stderr.write(
            `loom(pi): ${taskId} stopped; preserved completed/missing state and cleared executing_tasks\n`,
          );
          continue;
        }

        // parseBashTestOutput deliberately accepts only paired Bash tool calls
        // and results in Claude-compatible JSONL. Passing flattened prose here
        // silently discards every Pi test run as spoofable free text.
        const adaptedTranscript = parsedMessages.ok
          ? messagesToClaudeJsonl(parsedMessages.value)
          : parsedMessages;
        const structuredEvidence = parsedMessages.ok
          ? piStructuredTestResult(parsedMessages.value)
          : parsedMessages;
        if (structuredEvidence.ok && structuredEvidence.value === null) {
          // The wave gate rejects the transcript fallback, so a null structured
          // verdict is a latent blocker: say exactly why, instead of letting the
          // next gate run surface a bare "untrusted-regression-pass" mystery.
          const trace = piStructuredTestDiagnostics(result.messages ?? []);
          if (trace.ok) {
            const summary = trace.value.classifiedCommands.length === 0
              ? "no Bash call was classified as a test run"
              : `verdict=${trace.value.verdict}, classified=[${trace.value.classifiedCommands.join(" | ")}]`;
            process.stderr.write(
              `loom(pi): ${taskId} produced no structured test evidence (${summary}) — transcript fallback used; the wave gate will reject it\n`,
            );
          }
        }
        if (!adaptedTranscript.ok || !structuredEvidence.ok || !parsedMessages.ok) {
          const errors = !parsedMessages.ok
            ? parsedMessages.errors
            : !adaptedTranscript.ok
              ? adaptedTranscript.errors
              : !structuredEvidence.ok
                ? structuredEvidence.errors
                : [];
          const failureReason = `Pi transcript evidence capture failed: ${errors.join("; ")}`;
          const root = git.repositoryRoot() ?? process.cwd();
          await mgr.update((current) => {
            const currentTarget = current.tasks.find((candidate) => candidate.id === taskId);
            if (currentTarget === undefined || currentTarget.status === "completed") {
              return {
                ...current,
                executing_tasks: (current.executing_tasks ?? []).filter((id) => id !== taskId),
              };
            }
            const comparison = compareAttemptBaseline(root, currentTarget, { kind: "repository-or-declared" });
            const changedArtifacts = comparison.changedDeclaredArtifacts;
            const bytesChangedSinceAttempt = comparison.bytesChangedSinceAttempt;
            if (comparison.failure !== null) {
              process.stderr.write(
                `loom(pi): cannot compare malformed-transcript attempt baseline for ${taskId}: ${comparison.failure} — invalidating stale evidence\n`,
              );
            }
            if (!bytesChangedSinceAttempt) {
              return {
                ...current,
                executing_tasks: (current.executing_tasks ?? []).filter((id) => id !== taskId),
                tasks: current.tasks.map((candidate) =>
                  candidate.id === taskId && candidate.status === "pending"
                    ? { ...candidate, failure_reason: failureReason }
                    : candidate
                ),
              };
            }
            return applyUntrustedStopResolution(current, taskId, {
              taskCompleted: false,
              testResult: { verdict: "untrusted", passed: false, label: "pi-transcript-capture-failed" },
              testEvidence: failureReason,
              // Malformed messages provide no task-attributed path evidence.
              // The batch-wide repository delta is invalidation-only.
              filesModified: [],
              changedDeclaredArtifacts: changedArtifacts,
              bytesChangedSinceAttempt,
              newTestsWritten: false,
              newTestEvidence: "",
            }).state;
          });
          process.stderr.write(`loom(pi): ${failureReason} — ${taskId} evidence was not accepted\n`);
          continue;
        }
        const resultMessages = parsedMessages.value;
        const bashOutput = parseBashTestOutput(adaptedTranscript.value);
        const transcriptEvidence = extractTestEvidence(bashOutput);
        const structuredTestEvidence = structuredEvidence.value;
        const testEvidence = structuredTestEvidence ?? transcriptEvidence;

        // files_modified feeds lint-wave-gate's target collection (it
        // collects lint targets EXCLUSIVELY from tasks' files_modified) —
        // parse it from the per-result messages, re-encoded as the pi-format
        // JSONL parseFilesModified's pi branch reads, so the pi path
        // persists the same field the engine path does (round-16 fix: the
        // omission made every wave-gate lint under pi run over an empty set).
        const piJsonl = resultMessages
          .map((m) => JSON.stringify({ type: "message", message: m }))
          .join("\n");
        const rawFilesModified = parseFilesModified(piJsonl, "pi");
        let filesModified: readonly string[];
        try {
          filesModified = canonicalRepositoryPaths(
            git.repositoryRoot() ?? process.cwd(),
            rawFilesModified,
            "Pi transcript files_modified",
          );
        } catch (error) {
          await mgr.update((s) => ({
            ...s,
            executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
          }));
          process.stderr.write(
            `loom(pi): unsafe modified-file evidence for ${taskId}: ${error instanceof Error ? error.message : String(error)} — task left pending\n`,
          );
          continue;
        }

        // The SAME comparison and the SAME fail-closed contract as the other
        // two sites. This one used to catch by dropping the task from
        // executing_tasks and `continue`-ing — no resolution recorded, so an
        // identical comparison failure left the task pending forever here while
        // the sibling paths invalidated its evidence and re-judged it. The
        // helper fails closed (`bytesChangedSinceAttempt: true`, declared
        // artifacts from `file_list`) and this path now falls through to the
        // untrusted resolution below, exactly as the others do.
        const comparison = compareAttemptBaseline(
          git.repositoryRoot() ?? process.cwd(),
          task,
          { kind: "repository-or-declared", extraModifiedPaths: filesModified },
        );
        const changedArtifacts = comparison.changedDeclaredArtifacts;
        const bytesChangedSinceAttempt = comparison.bytesChangedSinceAttempt;
        if (comparison.failure !== null) {
          process.stderr.write(
            `loom(pi): cannot compare declared-artifact baseline for ${taskId}: ${comparison.failure} — invalidating stale evidence\n`,
          );
        }

        // Atomic state write. The completed/trusted-verdict guards above ran
        // on a PRE-LOCK snapshot that a concurrent writer can outdate before
        // this write lands (TOCTOU) — so the decision runs INSIDE the locked
        // update via the shared pure applyUntrustedStopResolution (engine's
        // update-task-status module), which re-finds and re-checks the target.
        // The incoming resolution is ALWAYS untrusted here, so an existing
        // trusted verdict (or a completed task) always stands.
        const resolvedTaskId = taskId;
        let skippedExistingVerdict = false;
        await mgr.update((s) => {
          const currentTarget = s.tasks.find((candidate) => candidate.id === resolvedTaskId);
          const cumulativeFiles = cumulativeModifiedPaths(currentTarget?.files_modified, filesModified);
          const newTestEvidence = git.isGitRepo()
            ? collectNewTestEvidence(
                cumulativeFiles,
                currentTarget?.new_tests_required,
                currentTarget?.start_sha,
              )
            : { written: false, evidence: "" };
          const applied = applyUntrustedStopResolution(s, resolvedTaskId, {
            taskCompleted: true,
            // Pi has no Loom evidence ledger. Preserve the real provenance:
            // paired tool-result evidence may discharge Pi's structured proof
            // policy; flattened transcript output may not.
            testResult: {
              verdict: "untrusted" as const,
              passed: testEvidence.passed,
              label: structuredTestEvidence !== null
                ? `pi-structured: ${structuredTestEvidence.evidence || "test tool result"}`
                : "transcript-regex (fallback)",
            },
            testEvidence: testEvidence.evidence,
            filesModified,
            changedDeclaredArtifacts: changedArtifacts,
            bytesChangedSinceAttempt,
            newTestsWritten: newTestEvidence.written,
            newTestEvidence: newTestEvidence.evidence,
          });
          skippedExistingVerdict = applied.skipped;
          // applyUntrustedStopResolution reconciles impl_complete in both
          // directions in the same locked state transition as the proof.
          return applied.state;
        });

        if (skippedExistingVerdict) {
          process.stderr.write(
            `loom(pi): ${taskId} is completed or carries a trusted verdict this untrusted resolution cannot supersede — leaving it untouched\n`,
          );
        }
        continue;
      }

      // --- Review agent → store findings ---
      if (isReviewAgent(agentType)) {
        const taskId = reservedItem?.taskId ?? extractTaskId(result.task ?? "") ?? extractTaskId(
          event.content.filter((c: { type: string }) => c.type === "text").map((c: { type: string; text?: string }) => c.text ?? "").join("\n")
        );
        if (!taskId) {
          // A review whose task ID is unextractable stores nothing — its
          // findings silently never gate the wave. Say so instead of
          // vanishing (review agents don't sit in executing_tasks, so there
          // is no inference to fall back on).
          process.stderr.write(
            `WARNING: ${agentType} review completed without an extractable task ID — findings NOT stored\n`,
          );
          continue;
        }

        // `tasks.map` over an id no task holds is a total no-op, and the log
        // below asserts the findings were stored regardless. `extractTaskId`
        // falls back to any standalone `T\d+` in the transcript, so a reviewer
        // quoting an unrelated id resolves to a task the graph does not have —
        // and that reviewer's criticals were discarded while stderr reported
        // them recorded. Both harnesses guard it, or they drift.
        const reviewTask = mgr.load().tasks.find((t: { id: string }) => t.id === taskId);
        if (!reviewTask) {
          process.stderr.write(
            `WARNING: ${agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored\n`,
          );
          continue;
        }

        const parsedMessages = parsePiMessages(result.messages ?? []);
        if (!parsedMessages.ok) {
          const message = `Pi review messages are malformed: ${parsedMessages.errors.join("; ")}`;
          const resolution = { kind: "evidence-failed" as const, agent: agentType, message };
          let appliedTask = reviewTask;
          await mgr.update((state) => ({
            ...state,
            tasks: state.tasks.map((task) => {
              if (task.id !== taskId) return task;
              appliedTask = applyReviewResolution(task, resolution);
              return appliedTask;
            }),
          }));
          process.stderr.write(reviewResolutionLog(taskId, resolution, appliedTask, true) + "\n");
          continue;
        }
        const transcriptText = parsedMessages.value
          .filter((message) => message.role === "assistant" || message.role === "toolResult")
          .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text ?? ""))
          .join("\n");

        // Transcript bytes are captured outside the lock; packet generation and
        // scope authority are resolved against the current task INSIDE it. The
        // Claude Code shell uses the same state-ownership boundary.
        let resolution: ReviewResolution = {
          kind: "evidence-failed",
          agent: agentType,
          message: "review task disappeared before evidence could be applied",
        };
        let appliedTask = reviewTask;
        let applicationChanged = false;
        let taskFound = false;
        await mgr.update((s) => ({
          ...s,
          tasks: s.tasks.map((t) => {
            if (t.id !== taskId) return t;
            taskFound = true;
            resolution = constrainReviewResolutionToScope(
              resolveTaskReviewFindings(
                transcriptText,
                agentType,
                t.review_run,
                t.review_generation,
              ),
              [...(t.file_list ?? []), ...(t.files_modified ?? [])],
            );
            appliedTask = applyReviewResolution(t, resolution);
            applicationChanged = appliedTask !== t;
            return appliedTask;
          }),
        }));
        if (!taskFound) {
          process.stderr.write(
            `WARNING: ${agentType} review task ${taskId} disappeared before evidence application — findings NOT stored\n`,
          );
          continue;
        }
        process.stderr.write(
          reviewResolutionLog(taskId, resolution, appliedTask, applicationChanged) + "\n",
        );
        continue;
      }

      // --- Spec-check invoker → store spec-check findings ---
      if (agentType === "spec-check-invoker") {
        const parsedMessages = parsePiMessages(result.messages ?? []);
        if (!parsedMessages.ok) {
          const error = `spec-check-invoker messages are malformed: ${parsedMessages.errors.join("; ")}`;
          await mgr.update((s) => ({
            ...s,
            spec_check: {
              wave: s.current_wave ?? 1,
              run_at: new Date().toISOString(),
              verdict: "EVIDENCE_CAPTURE_FAILED" as const,
              error,
            },
          }));
          process.stderr.write(`loom(pi): ${error} — marking spec-check evidence_capture_failed\n`);
          continue;
        }
        const transcriptText = parsedMessages.value
          .filter((message) => message.role === "assistant" || message.role === "toolResult")
          .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text ?? ""))
          .join("\n");

        const findings = parseSpecCheckOutput(transcriptText);
        const state = mgr.load();
        const wave = findings.wave ?? state.current_wave ?? 1;

        const resolution = reconcileSpecCheck(findings, wave, new Date().toISOString());
        if (resolution.kind === "evidence-failed") {
          process.stderr.write(
            `loom(pi): ${resolution.specCheck.error} — marking spec-check evidence_capture_failed\n`,
          );
          await mgr.update((s) => ({ ...s, spec_check: resolution.specCheck }));
          continue;
        }

        await mgr.update((s) => {
          const updated = { ...s, spec_check: resolution.specCheck };
          if (resolution.specCheck.critical_count > 0) {
            const waveKey = String(wave);
            updated.wave_gates = {
              ...s.wave_gates,
              [waveKey]: {
                ...(s.wave_gates[waveKey] ?? newWaveGate()),
                blocked: true,
              },
            };
          }
          return updated;
        });
        continue;
      }
      } catch (err) {
        // Loud + isolated: name the agent, the task (best effort), and the
        // cause, then continue with the next result.
        let taskIdForLog = "<unknown>";
        try {
          taskIdForLog = extractTaskId(result?.task ?? "") ?? "<unknown>";
        } catch {
          /* best-effort only — the log line must never throw */
        }
        const diagnostic = `result ${resultIndex + 1} for agent ${String(result?.agent ?? "<unknown>")} (task ${taskIdForLog}): ${err instanceof Error ? err.message : String(err)}`;
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
      if (!existsSync(activeTaskGraphPath)) {
        ctx.ui.notify("No active loom orchestration", "info");
        return;
      }

      const sm = StateManager.fromPath(activeTaskGraphPath);
      if (!sm) {
        ctx.ui.notify("Could not load task graph", "error");
        return;
      }

      try {
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
      } catch (e) {
        ctx.ui.notify(`Error: ${(e as Error).message}`, "error");
      }
    },
  });
}
