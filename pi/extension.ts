/**
 * Loom Pi Extension
 *
 * Bridges Loom's orchestration engine to Pi's extension API.
 * Reuses engine core decisions while owning Pi-specific adapter and handler policy.
 */

import { createHash } from "node:crypto";
import { dirname, join, relative as pathRelative, resolve, sep as pathSep } from "node:path";
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
import { settleSpecCheck } from "../engine/src/core/spec-check";
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
import {
  admitPiSpawnBatch,
  issuedReviewerPayloadClaim,
  MAX_PI_ORCHESTRATION_BATCH_SIZE,
  qualifyIssuedSpawnEmissionRoute,
  type AdmittedSpawnItem,
  type IssuedSpawnEmissionAuthority,
  type SpawnAdmissionPorts,
  type SpawnEmissionExpectation,
} from "../engine/src/core/spawn-admission";
import type { LoomAgentName } from "../engine/src/core/model-profiles";
import { isRecord } from "../engine/src/core/plain-record";


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
  piSilentStopNote,
  parsePiSubagentResults,
  piSubagentFailureSignals,
  piSubagentResultFailed,
  retireCompletedOrMissingImplementation,
  WRITE_TARGET_KEYS,
  writeTargetPathOf,
  type PiResultOutcome,
  type PiReviewAttemptAuthority,
  type PiSpecCheckAttemptAuthority,
  type PiSubagentResultEntry,
  type RepositoryProbe,
} from "./subagent-result";

// `isReviewAgent` lives in `config`, NOT in `core/review-output` beside the
// review-output helpers above: it reads the review-agent roster, and `core/review-output`
// declares itself free of config so its parse/merge rules stay pure. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook below, not just review capture. `engine/tests/pi-imports.test.ts`
// resolves every engine import in this file against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, taskGraphPath, subagentDir, PHASE_AGENT_MAP, IMPL_AGENTS, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS, probePathFailClosed, gitRepositoryRoot, observeTaskGraphProjectBoundary } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import { currentOrchestrationStatus } from "../engine/src/handlers/helpers/orchestration";
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

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import {
  decideEmissionToolRegistration,
  decideReadinessGate,
  describeEmissionRegistrationContradiction,
  emissionReadinessReport,
  emissionToolDefinition,
  EMISSION_HOLD_ENTRY_TYPE,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  LOOM_EMISSION_BINDING_ENV,
  parseEmissionChildProvisioning,
  parseReadinessStageObservation,
  type EmissionHoldPhase,
  type EmissionReadinessExpectation,
  type EmissionToolRegistration,
} from "./emission-tool";
import { parsePiMessages, piEmissionCallFrames, piResultFinalPayloadCandidates } from "./transcript-adapter";
import { selectCanonicalPayload } from "../engine/src/core/emission-ingestion";
import {
  issueEmissionBinding,
  type IssuedEmissionBinding,
  type IssuedEmissionBindingOf,
} from "../engine/src/core/emission-tool";
// FR-033: Pi and Claude Code capture each completed reviewer/verifier output
// into the SAME engine-declared slot under the same refusals. Both drive this
// one runtime; only the native correlator and the payload observation differ.
import {
  captureAuditLine,
  captureCandidates,
  captureHarnessResult,
  captureUnavailable,
  RUN_DIR_ENV,
  describeCaptureFailure,
  resolveCorrelatedRequest,
  RUNS_ROOT_ENV,
  terminalCaptureRefusal,
  terminalizeCaptureRejection,
  type CaptureObservation,
  type CaptureOutcome,
  type CorrelatedRequestResolution,
  type TerminalCaptureRefusal,
} from "../engine/src/orchestration/harness-capture-runtime";
import { openRegisteredRunDirectory, type RunDirHandle } from "../engine/src/orchestration/run-directory-handle";
import {
  parseRegisteredFacadeProgram,
  publishedReviewerRequest,
  readStandaloneReviewedSource,
  renderSpawnTask,
  replayStandaloneResultFromEvidence,
  replayStandaloneCapturedEvidence,
} from "../engine/src/handlers/helpers/programs";
import {
  publishLoomReviewAuthorityBridge,
  type LoomReviewAuthorityReceipt,
} from "../engine/src/handlers/helpers/programs/review-authority-bridge";
import {
  assertAnchoredFilesystemPlatformSupported,
  readRunBytesNoFollow,
} from "../engine/src/orchestration/no-follow-fs";
import {
  readSessionRunBindings,
  type SessionRunBinding,
} from "../engine/src/orchestration/session-run-bindings";
import { captureKey, observeEmissionCalls, type CaptureKey, type FinalPayload } from "../engine/src/core/harness-capture";
import { reduceStandaloneReviewMachine } from "../engine/src/core/standalone-review-machine";
import {
  boundDiagnosticMessage,
  boundedThrownCause,
  describeUnknown,
  failure,
  success,
  type DomainResult,
} from "../engine/src/core/orchestration-contract/identity";
import {
  parseArtifactDigest,
  parseContextDigest,
  parseRequestId,
  type ArtifactDigest,
  type ContextDigest,
  type RequestId,
} from "../engine/src/core/orchestration-contract";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
} from "../engine/src/core/implementation-completion";
import { materializePiResources } from "./resources";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import { runtimeBaselineRestoreForTasks } from "../engine/src/utils/artifact-baseline";
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
import { observeSpawnBatchGraph, spawnEntryAt } from "./spawn-graph";
import { expandImplementationBriefMarkers } from "./implementation-brief-expansion";
import { renderTaskImplementationBrief } from "../engine/src/orchestration/implementation-brief";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Capture once, while this extension module is loaded. Fresh CLI processes
// hash the checkout again before mutation; a changed checkout therefore cannot
// write a schema this in-memory runtime may not parse.
const LOADED_RUNTIME_IDENTITY = captureLoomRuntimeIdentity(PACKAGE_ROOT);
// Resource materialization remains process-scoped: one loaded extension owns
// one content-addressed cache. Spawn-facing agent discovery is session setup
// state instead and is sampled inside the extension factory below.
const PI_RESOURCE_CACHE = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "cache",
  "loom-resources",
);
const isPiSpawnTool = (toolName: string): boolean =>
  toolName === "subagent" || toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL;

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

const trustedReviewRuns = new Map<string, Map<string, TrustedReviewRoot>>();
const trustedRunIdentity = ({ runsRoot, runDirectory }: Pick<SessionRunBinding, "runsRoot" | "runDirectory">): string =>
  `${runsRoot}\0${runDirectory}`;

function updateTrustedReviewRun(
  sessionId: string,
  binding: SessionRunBinding,
  updateCaptures: (captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>) => ReadonlyMap<CaptureKey, TrustedReviewCapture>,
): void {
  const sessionRoots = trustedReviewRuns.get(sessionId) ?? new Map<string, TrustedReviewRoot>();
  trustedReviewRuns.set(sessionId, sessionRoots);
  const rootIdentity = resolve(binding.runsRoot);
  const root = sessionRoots.get(rootIdentity) ?? Object.freeze({
    nextTouch: 1,
    runs: new Map<string, TrustedReviewRun>(),
  });
  const identity = trustedRunIdentity(binding);
  const previous = root.runs.get(identity);
  const runs = new Map(root.runs);
  runs.set(identity, Object.freeze({
    binding,
    captures: updateCaptures(previous?.captures ?? new Map<CaptureKey, TrustedReviewCapture>()),
    touchedAt: previous?.touchedAt ?? root.nextTouch,
  }));
  sessionRoots.set(rootIdentity, Object.freeze({
    nextTouch: previous === undefined ? root.nextTouch + 1 : root.nextTouch,
    runs,
  }));
}

/** First exact standalone spawn selects the current run; retries never reorder runs. */
function touchTrustedReviewRun(sessionId: string, binding: SessionRunBinding): void {
  updateTrustedReviewRun(sessionId, binding, captures => captures);
}

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

function piSystemAgentIdentity(systemPrompt: string): string {
  PI_AGENT_ID_MARKER.lastIndex = 0;
  const matches = [...systemPrompt.matchAll(PI_AGENT_ID_MARKER)];
  if (matches.length !== 1) throw new Error("child system prompt must contain exactly one Loom Pi agent identity");
  return matches[0]![1]!;
}

/** The raw batch entry at `index`, whichever spawn shape the caller used
 *  (`tasks`, `chain`, or a bare single entry). Returned by reference: callers
 *  such as `replacePiSpawnTask` write its `task` field in place. The
 *  batch-shape read lives in `pi/spawn-graph.ts` — one home shared with the
 *  spawn-graph observation, so the two can never disagree about the shape. */
function piSpawnItem(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  const entry = spawnEntryAt(raw, index);
  if (entry === null) throw new Error(`missing Pi spawn item ${index}`);
  return entry;
}

export function piSpawnCwd(raw: unknown, index: number, defaultCwd: string): string {
  if (!isRecord(raw)) {
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
function piBashCommand(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const command = (raw as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

export type PiWriteTargetPathsResult =
  | Readonly<{ ok: true; value: readonly [string, ...string[]] }>
  | Readonly<{ ok: false; error: string }>;

const writeTarget = (input: Record<string, unknown>, path: string): PiWriteTargetPathsResult => {
  const target = writeTargetPathOf(input);
  return target !== null
    ? Object.freeze({ ok: true, value: Object.freeze([target]) as readonly [string] })
    : Object.freeze({ ok: false, error: `${path} must name one non-empty path, file_path, or filePath target` });
};

/** Parse every target before a scoped write can proceed; no partial batch exists. */
export function piWriteTargetPaths(raw: unknown): PiWriteTargetPathsResult {
  if (!isRecord(raw)) {
    return Object.freeze({ ok: false, error: "write input must be a plain object" });
  }
  const input = raw as Record<string, unknown>;
  if (WRITE_TARGET_KEYS.some((key) => key in input)) return writeTarget(input, "write input");
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return Object.freeze({ ok: false, error: "write input must contain a target or a non-empty edits array" });
  }
  const paths: string[] = [];
  for (const [index, edit] of input.edits.entries()) {
    if (!isRecord(edit)) {
      return Object.freeze({ ok: false, error: `write input.edits[${index}] must be a plain object` });
    }
    const parsed = writeTarget(edit as Record<string, unknown>, `write input.edits[${index}]`);
    if (!parsed.ok) return parsed;
    const target = parsed.value[0];
    if (!paths.includes(target)) paths.push(target);
  }
  return Object.freeze({ ok: true, value: Object.freeze(paths) as readonly [string, ...string[]] });
}

/**
 * Repo-relative write targets for the panel-artifact admission. The raw
 * edit/write input paths arrive from the harness; this shell resolves them
 * against the session cwd and makes them repo-relative, so the guard's
 * admission sees one canonical form and a `..` escape or an
 * outside-the-repo target cannot be proven in-scope. An unobservable
 * repository root cannot prove the target's scope either: fail closed to
 * the role admission, which blocks panel writers.
 */
export const panelGuardTargets = (rawInput: unknown, cwd: string): readonly string[] => {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return [];
  const targets = piWriteTargetPaths(rawInput);
  if (!targets.ok) return [];
  try {
    const repoRoot = gitRepositoryRoot();
    if (repoRoot === null) return [];
    return Object.freeze(targets.value.map((target) =>
      pathRelative(repoRoot, resolve(cwd, target)).split(pathSep).join("/")));
  } catch (e) {
    // The proven answers above (unparseable input, no repository) return
    // silently; an UNEXPECTED probe failure is announced — the handler's
    // activeRosterProbe convention — so a permissions or transport problem is
    // never indistinguishable from "this tool call names no write target".
    // The list still fails closed to the role admission.
    process.stderr.write(
      `loom(pi): cannot resolve write targets against the repository root: ` +
        `${e instanceof Error ? e.message : String(e)} — failing closed to the role admission\n`,
    );
    return [];
  }
};

export function replacePiSpawnTask(raw: unknown, index: number, task: string): void {
  if (!isRecord(raw)) {
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

/**
 * One admitted Pi spawn item carried through the parent shell as a structural
 * value. The core admission has already paired the item, lifecycle guard, and
 * emission expectation; this adapter adds only the transport slot and stable
 * roster identity. Keeping that association intact prevents mixed batches
 * from granting or guarding one child with a sibling's positional metadata.
 */
export type PiSpawnLifecycleAssociation = Readonly<{
  slot: number;
  rosterId: AgentId;
  admission: AdmittedSpawnItem;
}>;

export function associatePiSpawnLifecycle(
  itemAdmissions: readonly AdmittedSpawnItem[],
  toolCallId: string,
): readonly PiSpawnLifecycleAssociation[] {
  return Object.freeze(itemAdmissions.map((admission, slot) => Object.freeze({
    slot,
    rosterId: piSpawnRosterId(toolCallId, slot, admission.item.agent),
    admission,
  })));
}

// ─── Installed subagent launcher port (AD-4 / FR-008 / FR-031) ──────────

export const LOOM_SUBAGENT_LAUNCH_CHANNEL = "loom:subagent-launch:v2";

export type PiSubagentLaunchSlot =
  | Readonly<{ kind: "single"; index: 0 }>
  | Readonly<{ kind: "parallel"; index: number }>
  | Readonly<{ kind: "chain"; index: number }>;

type PiSubagentReadinessClient = Readonly<{
  getCommands: () => Promise<readonly Readonly<{ name: string; source?: string }>[]>;
  invokeReadiness: () => Promise<readonly unknown[]>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  getState: () => Promise<Readonly<{
    model: null | Readonly<{ provider?: string; id?: string; [key: string]: unknown }>;
  }>>;
}>;

type PiEmissionRpcDirective = Readonly<{
  kind: "emission-rpc";
  bindingEnv: string;
  expectedProvider: string;
  expectedModel: string;
  expectedToolName: string;
  verifyReadiness: (
    client: PiSubagentReadinessClient,
  ) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>>;
}>;

export type PiSubagentLaunchReply =
  | Readonly<{ kind: "not-admitted" }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "emission-rpc"; directive: PiEmissionRpcDirective }>;

type PiSubagentLaunchResolveRequest = Readonly<{
  kind: "resolve";
  sessionId: string;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  agent: string;
  task: string;
  cwd: string;
  effectiveModel: Readonly<{ provider: string; id: string }>;
  respond: (reply: Exclude<PiSubagentLaunchReply, { kind: "not-admitted" }>) => void;
}>;

type PiSubagentLaunchCapabilityReply = Readonly<{ kind: "available"; version: 2 }>;

type PiSubagentLaunchCapabilityProbe = Readonly<{
  kind: "capability";
  version: 2;
  respond: (reply: unknown) => void;
}>;

export type PiSubagentLaunchEventBus = Readonly<{
  emit: (channel: string, event: unknown) => void;
  on: (channel: string, handler: (event: unknown) => void) => () => void;
}>;

export type PiEmissionLaunchExpectation = Readonly<{
  sessionId: string;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  agent: string;
  task: string;
  cwd: string;
  expectation: Extract<SpawnEmissionExpectation, { kind: "emission-enabled" }>;
  revision: string;
}>;

type PiEmissionLaunchStage =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

type PiEmissionLaunchAvailability =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type PiEmissionLaunchBridge = Readonly<{
  probe: () => PiEmissionLaunchAvailability;
  stage: (expectations: readonly PiEmissionLaunchExpectation[]) => PiEmissionLaunchStage;
  removeToolCall: (sessionId: string, toolCallId: string) => void;
  removeSession: (sessionId: string) => void;
}>;

const launchSlotKey = (sessionId: string, toolCallId: string, slot: PiSubagentLaunchSlot): string =>
  `${sessionId}\u0000${toolCallId}\u0000${slot.kind}\u0000${slot.index}`;

const sameLaunchSlot = (left: PiSubagentLaunchSlot, right: PiSubagentLaunchSlot): boolean =>
  left.kind === right.kind && left.index === right.index;

const exactFields = (record: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean => {
  const keys = Object.keys(record);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
};

const parsePiSubagentLaunchCapabilityReply = (
  raw: unknown,
): DomainResult<PiSubagentLaunchCapabilityReply, Readonly<{ reason: string }>> => {
  const expected = 'exactly { kind: "available", version: 2 }';
  if (!isRecord(raw)) {
    return failure(Object.freeze({
      reason: `expected ${expected}; received ${describeUnknown(raw)}`,
    }));
  }
  if (!exactFields(raw, ["kind", "version"])) {
    return failure(Object.freeze({
      reason: `expected ${expected}; received an object with incompatible fields`,
    }));
  }
  if (raw.kind !== "available") {
    return failure(Object.freeze({
      reason: `expected ${expected}; received an object with an incompatible kind`,
    }));
  }
  if (raw.version !== 2) {
    return failure(Object.freeze({
      reason: `expected ${expected}; received an object with an incompatible version`,
    }));
  }
  return success(Object.freeze({ kind: "available" as const, version: 2 as const }));
};

const parsePiSubagentLaunchSlot = (raw: unknown): PiSubagentLaunchSlot | null => {
  if (!isRecord(raw) || !exactFields(raw, ["kind", "index"]) ||
      (raw.kind !== "single" && raw.kind !== "parallel" && raw.kind !== "chain") ||
      typeof raw.index !== "number" || !Number.isSafeInteger(raw.index) || raw.index < 0 ||
      (raw.kind === "single" && raw.index !== 0)) return null;
  if (raw.kind === "single") return Object.freeze({ kind: "single" as const, index: 0 as const });
  return raw.kind === "parallel"
    ? Object.freeze({ kind: "parallel" as const, index: raw.index })
    : Object.freeze({ kind: "chain" as const, index: raw.index });
};

/** Correlation-tier fields every resolve event must carry before the bridge
 *  replies at all: without these the event cannot be correlated or answered,
 *  so it is dropped silently (exactly as today). */
type PiSubagentLaunchResolveCorrelation = Readonly<{
  sessionId: string;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  respond: (reply: Exclude<PiSubagentLaunchReply, { kind: "not-admitted" }>) => void;
}>;

type PiSubagentLaunchResolveParse =
  | Readonly<{ kind: "silent" }>
  | Readonly<{ kind: "malformed"; correlation: PiSubagentLaunchResolveCorrelation; reason: string }>
  | Readonly<{ kind: "resolved"; request: PiSubagentLaunchResolveRequest }>;

/** A type-guard, not a truthiness cast: the narrowing carries the reply
 *  signature so the parsed correlation is a validated type, not a `Function`. */
const isPiSubagentLaunchResponder = (
  value: unknown,
): value is PiSubagentLaunchResolveCorrelation["respond"] => typeof value === "function";

const malformedResolve = (
  correlation: PiSubagentLaunchResolveCorrelation,
  reason: string,
): PiSubagentLaunchResolveParse => Object.freeze({ kind: "malformed" as const, correlation, reason });

/** Parse, never cast: a correlated resolve with a malformed agent/task/cwd or
 *  effectiveModel is still ANSWERABLE, so it gets one bounded field-specific
 *  refusal instead of a silent drop or an untyped comparison downstream. The
 *  effectiveModel is admitted only with EXACTLY the string fields provider and
 *  id, so `launchRequestMismatch` reads a guaranteed shape — no optional
 *  chain, no partial trust. */
const parsePiSubagentLaunchResolveRequest = (raw: unknown): PiSubagentLaunchResolveParse => {
  if (!isRecord(raw) || raw.kind !== "resolve" ||
      typeof raw.sessionId !== "string" || typeof raw.toolCallId !== "string" ||
      !isPiSubagentLaunchResponder(raw.respond)) return Object.freeze({ kind: "silent" as const });
  const slot = parsePiSubagentLaunchSlot(raw.slot);
  if (slot === null) return Object.freeze({ kind: "silent" as const });
  const correlation: PiSubagentLaunchResolveCorrelation = Object.freeze({
    sessionId: raw.sessionId,
    toolCallId: raw.toolCallId,
    slot,
    respond: raw.respond,
  });
  if (typeof raw.agent !== "string") return malformedResolve(correlation, "expected a string agent");
  if (typeof raw.task !== "string") return malformedResolve(correlation, "expected a string task");
  if (typeof raw.cwd !== "string") return malformedResolve(correlation, "expected a string cwd");
  const effectiveModel = raw.effectiveModel;
  if (!isRecord(effectiveModel) || !exactFields(effectiveModel, ["provider", "id"])) {
    return malformedResolve(
      correlation,
      "expected effectiveModel to be a record with exactly the string fields provider and id",
    );
  }
  if (typeof effectiveModel.provider !== "string") {
    return malformedResolve(correlation, "expected a string effectiveModel provider");
  }
  if (typeof effectiveModel.id !== "string") {
    return malformedResolve(correlation, "expected a string effectiveModel id");
  }
  return Object.freeze({
    kind: "resolved" as const,
    request: Object.freeze({
      kind: "resolve" as const,
      sessionId: correlation.sessionId,
      toolCallId: correlation.toolCallId,
      slot: correlation.slot,
      agent: raw.agent,
      task: raw.task,
      cwd: raw.cwd,
      effectiveModel: Object.freeze({ provider: effectiveModel.provider, id: effectiveModel.id }),
      respond: correlation.respond,
    }),
  });
};

const launchRequestMismatch = (
  request: PiSubagentLaunchResolveRequest,
  launch: PiEmissionLaunchExpectation,
): "session" | "agent" | "task" | "cwd" | "effective route" | null => {
  if (request.sessionId !== launch.sessionId) return "session";
  if (request.agent !== launch.agent) return "agent";
  if (request.task !== launch.task) return "task";
  if (request.cwd !== launch.cwd) return "cwd";
  if (request.effectiveModel.provider !== launch.expectation.route.provider ||
      request.effectiveModel.id !== launch.expectation.route.model) return "effective route";
  return null;
};

const readinessPayloadFromEntries = (
  entries: readonly unknown[],
): DomainResult<unknown, Readonly<{ message: string }>> => {
  if (entries.length !== 1) {
    return failure({ message: `readiness invocation produced ${entries.length} entries; exactly one is required` });
  }
  const entry = entries[0];
  if (!isRecord(entry) || entry.customType !== EMISSION_READINESS_ENTRY_TYPE || !Object.hasOwn(entry, "data")) {
    return failure({
      message: `readiness invocation did not produce one ${EMISSION_READINESS_ENTRY_TYPE} custom entry`,
    });
  }
  return success(entry.data);
};

const emissionBindingEnvironment = (
  expectation: Extract<SpawnEmissionExpectation, { kind: "emission-enabled" }>,
): string => JSON.stringify({
  requestId: expectation.binding.requestId,
  contextDigest: expectation.contextDigest,
  kind: expectation.binding.kind.kind,
  version: expectation.binding.version,
  toolName: expectation.binding.toolName,
  schemaDigest: expectation.binding.schemaDigest,
});

type PiReadinessVerification = Awaited<ReturnType<PiEmissionRpcDirective["verifyReadiness"]>>;

const readinessRpcRefusal = (operation: string, thrown: unknown): PiReadinessVerification => {
  const cause = boundedThrownCause(thrown, operation);
  return Object.freeze({
    ok: false as const,
    reason: `Emission readiness RPC ${operation} failed (${cause.name}: ${cause.message}). ` +
      "Inspect the child RPC channel, then retry the same issued request after restoring the launcher.",
  });
};

const readinessVerifier = (
  launch: PiEmissionLaunchExpectation,
): PiEmissionRpcDirective["verifyReadiness"] => async (client) => {
  let commands: Awaited<ReturnType<PiSubagentReadinessClient["getCommands"]>>;
  try {
    commands = await client.getCommands();
  } catch (thrown) {
    return readinessRpcRefusal("get_commands", thrown);
  }
  let commandListed: boolean;
  try {
    if (!Array.isArray(commands) || !commands.every((command) =>
      isRecord(command) && typeof command.name === "string" &&
      (command.source === undefined || typeof command.source === "string"))) {
      return Object.freeze({ ok: false as const, reason: "Emission readiness RPC get_commands returned a malformed command inventory" });
    }
    commandListed = commands.some((command) =>
      command.name === EMISSION_READINESS_COMMAND && command.source === "extension");
  } catch (thrown) {
    return readinessRpcRefusal("get_commands response", thrown);
  }
  if (!commandListed) {
    return Object.freeze({
      ok: false as const,
      reason: `Required extension command /${EMISSION_READINESS_COMMAND} is unavailable`,
    });
  }

  // Exactly one invocation in this verifier. The installed launcher also
  // enforces this count and refuses prompt delivery if a verifier cheats.
  let readinessEntries: readonly unknown[];
  try {
    readinessEntries = await client.invokeReadiness();
  } catch (thrown) {
    return readinessRpcRefusal("invoke_readiness", thrown);
  }
  try {
    if (!Array.isArray(readinessEntries)) {
      return Object.freeze({ ok: false as const, reason: "Emission readiness RPC invocation returned a malformed entry list" });
    }
    const payload = readinessPayloadFromEntries(readinessEntries);
    if (!payload.ok) return Object.freeze({ ok: false as const, reason: payload.error.message });
    const expectation: EmissionReadinessExpectation = Object.freeze({
      binding: launch.expectation.binding,
      contextDigest: launch.expectation.contextDigest,
      revision: launch.revision,
      readinessCommand: EMISSION_READINESS_COMMAND,
    });
    const decision = decideReadinessGate(expectation, parseReadinessStageObservation({
      channelAlive: true,
      channelDiagnostic: null,
      commandListed: true,
      readiness: Object.freeze({ kind: "observed" as const, payload: payload.value }),
    }));
    if (decision.kind === "refused") {
      return Object.freeze({ ok: false as const, reason: decision.message });
    }
  } catch (thrown) {
    return readinessRpcRefusal("invoke_readiness response", thrown);
  }

  // Route selection is deliberately after readiness. Both this verifier and
  // the installed launcher observe the exact provider/model before Task prompt.
  try {
    await client.setModel(launch.expectation.route.provider, launch.expectation.route.model);
  } catch (thrown) {
    return readinessRpcRefusal("set_model", thrown);
  }
  let state: Awaited<ReturnType<PiSubagentReadinessClient["getState"]>>;
  try {
    state = await client.getState();
  } catch (thrown) {
    return readinessRpcRefusal("get_state", thrown);
  }
  try {
    if (!isRecord(state) || !isRecord(state.model) ||
        typeof state.model.provider !== "string" || typeof state.model.id !== "string") {
      return Object.freeze({ ok: false as const, reason: "Emission readiness RPC get_state returned no exact provider/model record" });
    }
    if (state.model.provider !== launch.expectation.route.provider ||
        state.model.id !== launch.expectation.route.model) {
      return Object.freeze({
        ok: false as const,
        reason: `the child route ${state.model.provider}/${state.model.id} does not match ` +
          `${launch.expectation.route.provider}/${launch.expectation.route.model}`,
      });
    }
  } catch (thrown) {
    return readinessRpcRefusal("get_state response", thrown);
  }
  return Object.freeze({ ok: true as const });
};

/** Register the synchronous request/reply adapter consumed by the installed
 * normal subagent launcher. The bridge owns no model process; it retains only
 * admitted, request-bound launch capabilities until result/shutdown cleanup. */
export function registerPiEmissionLaunchBridge(
  events: PiSubagentLaunchEventBus | undefined,
): PiEmissionLaunchBridge {
  if (events === undefined) {
    return Object.freeze({
      probe: (): PiEmissionLaunchAvailability => Object.freeze({
        kind: "unavailable" as const,
        reason: "this Pi runtime exposes no extension event bus",
      }),
      stage: (): PiEmissionLaunchStage => Object.freeze({
        ok: false as const,
        reason: "Emission launch unavailable: this Pi runtime exposes no extension event bus",
      }),
      removeToolCall: (): void => undefined,
      removeSession: (): void => undefined,
    });
  }

  const pending = new Map<string, PiEmissionLaunchExpectation>();
  events.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (raw) => {
    const parsed = parsePiSubagentLaunchResolveRequest(raw);
    if (parsed.kind === "silent") return;
    if (parsed.kind === "malformed") {
      // Correlation holds but the launch shape does not: answer EXACTLY ONCE
      // with a bounded, field-specific refusal — never throw, never compare
      // against a cast, never mint a directive from untrusted shape.
      parsed.correlation.respond(Object.freeze({
        kind: "refused" as const,
        reason: `staged emission launch resolve is malformed: ${parsed.reason}`,
      }));
      return;
    }
    const request = parsed.request;
    const key = launchSlotKey(request.sessionId, request.toolCallId, request.slot);
    const launch = pending.get(key);
    if (launch === undefined) return;

    const mismatch = launchRequestMismatch(request, launch);
    if (mismatch !== null) {
      request.respond(Object.freeze({
        kind: "refused" as const,
        reason: `staged emission launch ${request.toolCallId}/${request.slot.kind}[${request.slot.index}] does not match its issued ${mismatch}`,
      }));
      return;
    }

    pending.delete(key);
    request.respond(Object.freeze({
      kind: "emission-rpc" as const,
      directive: Object.freeze({
        kind: "emission-rpc" as const,
        bindingEnv: emissionBindingEnvironment(launch.expectation),
        expectedProvider: launch.expectation.route.provider,
        expectedModel: launch.expectation.route.model,
        expectedToolName: launch.expectation.binding.toolName,
        verifyReadiness: readinessVerifier(launch),
      }),
    }));
  });

  return Object.freeze({
    probe: (): PiEmissionLaunchAvailability => {
      let replies = 0;
      let malformedReplyReason: string | null = null;
      const probe: PiSubagentLaunchCapabilityProbe = Object.freeze({
        kind: "capability",
        version: 2,
        respond: (reply) => {
          replies += 1;
          const parsed = parsePiSubagentLaunchCapabilityReply(reply);
          if (!parsed.ok && malformedReplyReason === null) malformedReplyReason = parsed.error.reason;
        },
      });
      try {
        events.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, probe);
      } catch (thrown) {
        const cause = boundedThrownCause(thrown, "emission launcher capability probe");
        return Object.freeze({
          kind: "unavailable" as const,
          reason: `the installed subagent launcher capability probe failed (${cause.name}: ${cause.message})`,
        });
      }
      if (replies !== 1) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: replies > 1
            ? `multiple launcher capabilities answered ${LOOM_SUBAGENT_LAUNCH_CHANNEL}; reload a single installed launcher`
            : `the installed subagent launcher does not advertise ${LOOM_SUBAGENT_LAUNCH_CHANNEL}`,
        });
      }
      if (malformedReplyReason !== null) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: `the installed subagent launcher returned an incompatible v2 capability response: ${malformedReplyReason}`,
        });
      }
      return Object.freeze({ kind: "available" as const });
    },
    stage: (expectations): PiEmissionLaunchStage => {
      const staged = new Set<string>();
      for (const expectation of expectations) {
        const key = launchSlotKey(expectation.sessionId, expectation.toolCallId, expectation.slot);
        if (staged.has(key) || pending.has(key)) {
          return Object.freeze({
            ok: false as const,
            reason: `emission launch capability already exists for ${expectation.toolCallId}/${expectation.slot.kind}[${expectation.slot.index}]`,
          });
        }
        staged.add(key);
      }
      for (const expectation of expectations) {
        pending.set(
          launchSlotKey(expectation.sessionId, expectation.toolCallId, expectation.slot),
          Object.freeze(expectation),
        );
      }
      return Object.freeze({ ok: true as const });
    },
    removeToolCall: (sessionId, toolCallId): void => {
      for (const [key, launch] of pending) {
        if (launch.sessionId === sessionId && launch.toolCallId === toolCallId) pending.delete(key);
      }
    },
    removeSession: (sessionId): void => {
      for (const [key, launch] of pending) {
        if (launch.sessionId === sessionId) pending.delete(key);
      }
    },
  });
}

function piSubagentLaunchSlot(raw: unknown, index: number): PiSubagentLaunchSlot {
  if (isRecord(raw) && Array.isArray(raw.chain)) return Object.freeze({ kind: "chain" as const, index });
  if (isRecord(raw) && Array.isArray(raw.tasks)) return Object.freeze({ kind: "parallel" as const, index });
  if (index !== 0) throw new Error(`single Pi subagent launch cannot address slot ${index}`);
  return Object.freeze({ kind: "single" as const, index: 0 });
}

type PiReservedEmissionLaunch = Readonly<{
  slot: PiSubagentLaunchSlot;
  binding: IssuedEmissionBindingOf<"reviewer-payload">;
  contextDigest: ContextDigest;
}>;

const isReviewerEmissionBinding = (
  binding: IssuedEmissionBinding,
): binding is IssuedEmissionBindingOf<"reviewer-payload"> =>
  binding.kind.kind === "reviewer-payload";

const reservedReviewerEmissionLaunch = (
  expectation: SpawnEmissionExpectation,
  rawInput: unknown,
  index: number,
): PiReservedEmissionLaunch | null => {
  if (expectation.kind !== "emission-enabled" || !isReviewerEmissionBinding(expectation.binding)) return null;
  return Object.freeze({
    slot: piSubagentLaunchSlot(rawInput, index),
    binding: expectation.binding,
    contextDigest: expectation.contextDigest,
  });
};

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
  updateTrustedReviewRun(sessionId, binding, previous => {
    const captures = new Map(previous);
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
    return captures;
  });
}

function environmentRunBinding(): SessionRunBinding | null {
  const runsRoot = process.env[RUNS_ROOT_ENV];
  const runDirectory = process.env[RUN_DIR_ENV];
  if (runsRoot === undefined && runDirectory === undefined) return null;
  if (runsRoot === undefined || runDirectory === undefined) {
    throw new Error("Pi orchestration requires both run-root and run-directory authority");
  }
  const opened = openRegisteredRunDirectory(runsRoot, runDirectory);
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
    const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
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

type PiRegisteredReviewProgram =
  | Readonly<{ kind: "standalone-review" | "wave-gate"; schemaVersion: 1 }>
  | Readonly<{
      kind: "standalone-review" | "wave-gate";
      schemaVersion: 2;
      reviewerProtocol: Readonly<{ schemaDigest: string }>;
    }>
  | Readonly<{
      kind: "standalone-review";
      schemaVersion: 3;
      reviewerProtocol: Readonly<{ schemaDigest: string }>;
    }>;

type PiIssuedReviewRequest = Readonly<{
  runId: string;
  requestId: RequestId;
  contextDigest: ContextDigest;
  program: string;
  role: string;
}>;

export type PiIssuedReviewRequestClass =
  | Readonly<{
      kind: "review-program-emission";
      claim: ReturnType<typeof issuedReviewerPayloadClaim>;
    }>
  | Readonly<{
      kind: "refutation-panel-extraction";
      claim: ReturnType<typeof issuedReviewerPayloadClaim>;
    }>;

/**
 * Classify one exactly reserved request against its enclosing registered
 * review program. A refutation panel is a child program of standalone-review
 * or wave-gate, not a second facade registration. Until that child request
 * carries its own issued emission descriptor, its authenticated capability is
 * deliberately represented by the archived no-schema claim: the parent gate
 * therefore preserves final-message extraction and cannot infer a tool from
 * the verifier Agent's broader catalog eligibility.
 */
export function classifyPiIssuedReviewRequest(
  registeredRunId: string,
  program: PiRegisteredReviewProgram,
  request: PiIssuedReviewRequest,
): DomainResult<PiIssuedReviewRequestClass, Readonly<{ message: string }>> {
  if (request.runId !== registeredRunId) {
    return failure({ message: `request ${request.requestId} belongs to another orchestration run` });
  }
  if (request.program === program.kind) {
    return success({
      kind: "review-program-emission",
      claim: issuedReviewerPayloadClaim(program, request),
    });
  }
  if (request.program === "refutation-panel" && request.role === "review-verifier-agent") {
    return success({
      kind: "refutation-panel-extraction",
      claim: issuedReviewerPayloadClaim({ schemaVersion: 1 }, request),
    });
  }
  return failure({ message: `request ${request.requestId} has no matching registered review program` });
}

type PublishedPiReviewRouteAuthority = Readonly<{
  role: LoomAgentName;
  harnessBinding: Readonly<{
    pi: Readonly<{ provider: string; model: string }>;
  }>;
}>;

/**
 * Qualify one classified request from its exact authenticated publication.
 * The request's frozen Pi provider/model binding is the only route input:
 * task text, role eligibility, and the parent's mutable model cannot upgrade
 * extraction-only authority. A hard qualification refusal remains a typed
 * authority failure for the spawn gate rather than a silent degradation.
 */
export function qualifyPiIssuedReviewRequest(
  classified: PiIssuedReviewRequestClass,
  published: PublishedPiReviewRouteAuthority,
): DomainResult<IssuedSpawnEmissionAuthority, Readonly<{ message: string }>> {
  const route = qualifyIssuedSpawnEmissionRoute(classified.claim, published, true);
  if (route.kind === "refused") {
    return failure({
      message: `emission route qualification refused for request ${classified.claim.requestId}: ${route.reason}`,
    });
  }
  return success({ role: published.role, claim: classified.claim, route });
}

/** Authenticate a descriptor against this session's reserved Run Directory
 *  request before the pure admission may enable an emission capability. */
/** Route qualification is the one substitutable pure adapter in this read:
 * RunDirectory reservation, registration, and publication authentication stay
 * fixed here. Production uses the frozen issued route; acceptance supplies the
 * explicit capable-route adapter already used by the T6 projection fixtures. */
export type PiIssuedReviewRouteQualifier = typeof qualifyPiIssuedReviewRequest;

export function readPiIssuedSpawnRequest(
  sessionId: string | null,
  requestId: RequestId,
  contextDigest: ContextDigest,
  agent: LoomAgentName,
  qualifyRoute: PiIssuedReviewRouteQualifier = qualifyPiIssuedReviewRequest,
): ReturnType<SpawnAdmissionPorts["readIssuedRequest"]> {
  if (sessionId === null) return failure({ message: "Pi session identity is unavailable" });
  try {
    const binding = environmentRunBinding() ?? sessionRunBinding(sessionId, [{ requestId, contextDigest }]);
    const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
    if (!opened.ok) return failure({ message: opened.error.message });
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok) return failure({ message: issued.error.message });
    const matches = issued.value.filter((candidate) => candidate.requestId === requestId);
    if (matches.length !== 1 || matches[0]!.contextDigest !== contextDigest || matches[0]!.role !== agent) {
      return failure({ message: `no unique reserved ${agent} request ${requestId} binds context ${contextDigest}` });
    }
    const request = matches[0]!;
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) return failure({ message: stored.error.message });
    const registration = parseRegisteredFacadeProgram(stored.value);
    if (registration.kind !== "registered" ||
        (registration.program.kind !== "wave-gate" && registration.program.kind !== "standalone-review")) {
      return failure({ message: `request ${requestId} has no matching registered review program` });
    }
    const classified = classifyPiIssuedReviewRequest(opened.value.runId, registration.program, request);
    if (!classified.ok) return classified;
    // Reservation and registration do not issue a spawn. The exact immutable
    // publication receipt must independently authenticate this same authority.
    const published = publishedReviewerRequest(opened.value, request);
    if (!published.ok) return failure({ message: published.message });
    return qualifyRoute(classified.value, published.value.authority);
  } catch (error) {
    return failure({ message: error instanceof Error ? error.message : String(error) });
  }
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
async function recordPiSpawnCorrelators(
  itemAdmissions: readonly AdmittedSpawnItem[],
  rosterIds: readonly string[],
  rawSessionId: string,
  rawInput: unknown,
): Promise<SessionRunBinding | null> {
  if (itemAdmissions.length !== rosterIds.length) throw new Error("Pi correlator roster length does not match spawn batch");
  const parsedMarkers = itemAdmissions.map(({ item }, index) =>
    orchestrationMarkers(item.task, `Pi spawn item ${index + 1}/${item.agent}`));
  const marked = parsedMarkers.filter((markers): markers is PiOrchestrationMarkers => markers !== null);
  const explicit = environmentRunBinding();
  if (marked.length === 0 && explicit === null) return null;
  if (marked.length !== itemAdmissions.length) {
    throw new Error("Pi orchestration spawn batch must not mix request-bound and unbound items");
  }
  const runBinding = explicit ?? sessionRunBinding(rawSessionId, marked);
  const opened = openRegisteredRunDirectory(runBinding.runsRoot, runBinding.runDirectory);
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

  for (const [index, admission] of itemAdmissions.entries()) {
    const { item } = admission;
    const markers = parsedMarkers[index]!;
    if (markers === null) throw new Error("Pi orchestration marker completeness invariant failed");
    const exactRequestId = markers.requestId;
    const request = available.find((candidate) => candidate.requestId === exactRequestId);
    if (request === undefined || consumed.has(request.requestId)) {
      throw new Error(`issued request ${exactRequestId} is unavailable for Pi spawn item ${index + 1}/${item.agent}`);
    }
    const captureRejection = opened.value.readCaptureRejection(request);
    if (!captureRejection.ok) throw new Error(captureRejection.error.message);
    if (captureRejection.value !== null) {
      const retryAuthority = request.attempt === 1
        ? "a new attempt-2 issuance is required"
        : "attempt 2 is terminal; no further issuance is permitted";
      throw new Error(
        `issued request ${exactRequestId} attempt ${request.attempt} is terminally rejected; ${retryAuthority}`,
      );
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
    // Emission admission already authenticated this exact task's issuance
    // markers and descriptor. Re-rendering through the durable fallback here
    // could erase a descriptor selected by an explicit transport-route adapter;
    // extraction-only tasks retain the established canonical re-render.
    canonicalTasks[index] = admission.emissionExpectation.kind === "emission-enabled"
      ? item.task
      : renderSpawnTask(
          opened.value,
          request,
          "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required result.",
          { standalone: hasStandaloneReviewContext(item.task) },
        );
    consumed.add(request.requestId);
  }
  for (const [index, task] of canonicalTasks.entries()) replacePiSpawnTask(rawInput, index, task);
  if (itemAdmissions.some(({ item }) => hasStandaloneReviewContext(item.task))) {
    touchTrustedReviewRun(rawSessionId, runBinding);
  }
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
    terminalCaptureRefusal("capture-rejection", diagnostic),
  );
  return outcome.kind === "retriable-failure" ||
      (outcome.kind === "terminal-rejection" && outcome.reason === "rejection-audit-unsynchronized")
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

type PiEmissionStartupRefusalMarker = Readonly<{
  kind: "emission-startup-refused";
  sessionId: PiSessionId;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  requestId: RequestId;
  contextDigest: ContextDigest;
  toolName: string;
  phase: "before-task-prompt";
  reason: string;
}>;

type PiEmissionStartupMarkerObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed"; reason: string }>
  | Readonly<{ kind: "parsed"; marker: PiEmissionStartupRefusalMarker }>;

/** Parse only the installed launcher's closed pre-prompt outcome. This is
 * transport evidence, not model text: stderr, errorMessage, and guessed stop
 * reasons deliberately have no constructor here. */
function parsePiEmissionStartupMarker(rawResult: unknown): PiEmissionStartupMarkerObservation {
  if (!isRecord(rawResult) || !Object.hasOwn(rawResult, "launchOutcome")) {
    return Object.freeze({ kind: "absent" as const });
  }
  const raw = rawResult.launchOutcome;
  const fields = [
    "kind", "sessionId", "toolCallId", "slot", "requestId", "contextDigest", "toolName", "phase", "reason",
  ] as const;
  if (!isRecord(raw) || !exactFields(raw, fields)) {
    return Object.freeze({ kind: "malformed" as const, reason: "launchOutcome is not the exact startup-refusal record" });
  }
  if (raw.kind !== "emission-startup-refused" || raw.phase !== "before-task-prompt") {
    return Object.freeze({ kind: "malformed" as const, reason: "launchOutcome does not attest the before-task-prompt phase" });
  }
  const sessionId = typeof raw.sessionId === "string" ? parseSessionId(raw.sessionId) : null;
  const requestId = parseRequestId(raw.requestId);
  const contextDigest = parseContextDigest(raw.contextDigest);
  const parsedSlot = parsePiSubagentLaunchSlot(raw.slot);
  if (sessionId === null || !requestId.ok || !contextDigest.ok ||
      typeof raw.toolCallId !== "string" || raw.toolCallId.length === 0 ||
      typeof raw.toolName !== "string" || raw.toolName.length === 0 ||
      typeof raw.reason !== "string" || raw.reason.length === 0 || Buffer.byteLength(raw.reason, "utf8") > 1024 ||
      parsedSlot === null) {
    return Object.freeze({ kind: "malformed" as const, reason: "launchOutcome carries malformed identity, slot, or reason fields" });
  }
  return Object.freeze({
    kind: "parsed" as const,
    marker: Object.freeze({
      kind: "emission-startup-refused" as const,
      sessionId,
      toolCallId: raw.toolCallId,
      slot: parsedSlot,
      requestId: requestId.value,
      contextDigest: contextDigest.value,
      toolName: raw.toolName,
      phase: "before-task-prompt" as const,
      reason: raw.reason,
    }),
  });
}

type PiEmissionStartupClassification =
  | Readonly<{ kind: "ordinary" }>
  | Readonly<{ kind: "untrusted-marker"; reason: string }>
  | Readonly<{ kind: "proven-startup-refusal"; marker: PiEmissionStartupRefusalMarker }>;

function classifyPiEmissionStartupRefusal(input: Readonly<{
  rawResult: unknown;
  result: Extract<PiSubagentResultEntry, { ok: true }>["result"];
  reservation: PiSpawnReservation;
  reservedItem: PiSpawnReservation["items"][number];
  runBinding: SessionRunBinding;
  toolCallId: unknown;
  resultIndex: number;
  agentType: string;
}>): PiEmissionStartupClassification {
  let observed: PiEmissionStartupMarkerObservation;
  try {
    observed = parsePiEmissionStartupMarker(input.rawResult);
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "launchOutcome");
    return Object.freeze({
      kind: "untrusted-marker" as const,
      reason: `launchOutcome inspection failed (${cause.name}: ${cause.message})`,
    });
  }
  if (observed.kind === "absent") return Object.freeze({ kind: "ordinary" as const });
  if (observed.kind === "malformed") {
    return Object.freeze({ kind: "untrusted-marker" as const, reason: observed.reason });
  }
  const expected = input.reservedItem.emissionLaunch;
  const marker = observed.marker;
  if (expected === null || input.result.exitCode === 0 ||
      !Array.isArray(input.result.messages) || input.result.messages.length !== 0 ||
      marker.sessionId !== input.reservation.sessionId || marker.toolCallId !== input.toolCallId ||
      !sameLaunchSlot(marker.slot, expected.slot) || marker.requestId !== expected.binding.requestId ||
      marker.contextDigest !== expected.contextDigest || marker.toolName !== expected.binding.toolName) {
    return Object.freeze({
      kind: "untrusted-marker" as const,
      reason: "launchOutcome does not exactly match the reserved failed launch and its empty pre-prompt transcript",
    });
  }
  const correlation = piRequestCorrelation(input.runBinding, input.toolCallId, input.resultIndex, input.agentType);
  if (!correlation.ok || correlation.value.request.requestId !== expected.binding.requestId ||
      correlation.value.request.contextDigest !== expected.contextDigest) {
    return Object.freeze({
      kind: "untrusted-marker" as const,
      reason: "launchOutcome has no independently authenticated issued request binding",
    });
  }
  return Object.freeze({ kind: "proven-startup-refusal" as const, marker });
}

const captureSelectedPiPayload = (payload: FinalPayload): CaptureObservation =>
  captureCandidates(Object.freeze([Object.freeze({ origin: payload.origin, text: payload.text })]));

/**
 * Pure Pi transcript decision for one authenticated reviewer emission binding.
 * The adapter observes finalized execution, then the shared core selects once;
 * this shell projection only translates that closed decision into the existing
 * capture runtime vocabulary.
 */
function piReviewerCaptureFromObservation(
  issued: IssuedEmissionBindingOf<"reviewer-payload">,
  observation: ReturnType<typeof observeEmissionCalls>,
  candidates: Extract<ReturnType<typeof piResultFinalPayloadCandidates>, { ok: true }>["value"],
): CaptureObservation {
  const selection = selectCanonicalPayload(issued, observation, candidates);
  switch (selection.kind) {
    case "emission-tool-arguments":
      return captureSelectedPiPayload(selection.payload);
    case "final-message-extraction":
    case "extraction-over-refused-call":
      return selection.fallback.ok
        ? captureSelectedPiPayload(selection.fallback.value)
        : terminalCaptureRefusal(selection.fallback.error.reason, selection.fallback.error.message);
    case "duplicate-emission-call":
      return terminalCaptureRefusal(
        "ambiguous-emission-call",
        "result carried multiple distinct emission tool calls; exactly one successfully executed call is allowed",
      );
    case "refused-call-no-fallback":
      return terminalCaptureRefusal(
        "emission-and-extraction-refused",
        `emission arguments were refused [${selection.emissionRefusal.code}]: ${selection.emissionRefusal.message}; ` +
          `final-message extraction was refused [${selection.extraction.reason}]: ${selection.extraction.message}`,
      );
    case "observation-refused":
      return terminalCaptureRefusal(selection.refusal.code, selection.refusal.message);
  }
}

export function piReviewerCaptureObservation(
  messages: unknown,
  issued: IssuedEmissionBindingOf<"reviewer-payload">,
): CaptureObservation {
  const frames = piEmissionCallFrames(messages, issued);
  if (!frames.ok) {
    return terminalCaptureRefusal("emission-observation", frames.errors.join("; "));
  }
  const observation = observeEmissionCalls(frames.value);
  const candidates = piResultFinalPayloadCandidates(messages, "standalone-successor");
  if (candidates.ok) return piReviewerCaptureFromObservation(issued, observation, candidates.value);

  // The independent scanner may still prove one successfully executed,
  // correctly bound emission when an unrelated transcript entry is malformed.
  // Empty fallback candidates cannot authorize extraction, so the SAME shared
  // decision runs once more over them: the emission-selected arm still captures
  // via captureSelectedPiPayload, and every other arm's own typed refusal is
  // RETAINED and composed with the transcript scan's refusal — the scan's
  // diagnostics can never erase the selection arm's own code or message.
  const selectionOutcome = piReviewerCaptureFromObservation(issued, observation, Object.freeze([]));
  if (selectionOutcome.kind === "terminal-refusal") {
    return terminalCaptureRefusal(
      selectionOutcome.reason,
      `${selectionOutcome.message}; the independent transcript scan also refused: ${candidates.errors.join("; ")}`,
    );
  }
  return selectionOutcome;
}

const archivedReviewerCaptureObservation = (messages: unknown): CaptureObservation => {
  const candidates = piResultFinalPayloadCandidates(messages ?? [], "standalone-successor");
  return candidates.ok
    ? captureCandidates(candidates.value)
    : terminalCaptureRefusal("transcript-shape", candidates.errors.join("; "));
};

/** The production capture decision after request/program/publication authority
 * has been authenticated. Archived reviewer-v1 and refutation requests retain
 * explicit final-message extraction. Current review programs must mint their
 * exact issued v2/v3 binding; a malformed binding is unavailable evidence and
 * can never be reclassified as an archived extraction result. */
export function piIssuedReviewerCaptureObservation(
  classified: PiIssuedReviewRequestClass,
  messages: unknown,
): CaptureObservation {
  if (classified.kind === "refutation-panel-extraction" || classified.claim.version === "v1") {
    return archivedReviewerCaptureObservation(messages);
  }
  const claim = classified.claim;
  const issued = issueEmissionBinding({
    requestId: claim.requestId,
    kind: "reviewer-payload" as const,
    version: claim.version,
    schemaDigest: claim.schemaDigest,
  });
  if (!issued.ok) {
    return captureUnavailable(
      "emission-binding",
      boundDiagnosticMessage(
        `issued reviewer emission binding is unavailable [${issued.error.code}]: ${issued.error.message}`,
      ),
    );
  }
  return piReviewerCaptureObservation(messages ?? [], issued.value);
}

const captureUnclaimedProgramObservation = (
  registration: unknown | null,
  messages: unknown,
): CaptureObservation => {
  if (registration !== null) {
    return captureUnavailable(
      "program-registration",
      "program registration is unavailable: program registration does not name a registered orchestration program",
    );
  }
  // Proven file absence cannot authorize semantic parsing, but the bounded
  // structural walk still rejects hostile decoded input terminally.
  const bounded = piResultFinalPayloadCandidates(messages ?? [], "standalone-successor");
  return bounded.ok
    ? captureUnavailable("program-registration", "program registration is unavailable: program registration does not name a registered orchestration program")
    : terminalCaptureRefusal("transcript-shape", bounded.errors.join("; "));
};

export async function capturePiSubagentResult(
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  messages: unknown,
  runBinding: SessionRunBinding | null = null,
  observationRefusal: TerminalCaptureRefusal | null = null,
): Promise<CaptureOutcome> {
  const runsRoot = runBinding?.runsRoot ?? process.env[RUNS_ROOT_ENV];
  const runDirectory = runBinding?.runDirectory ?? process.env[RUN_DIR_ENV];
  const observe = (): CaptureObservation => {
    if (observationRefusal !== null) return observationRefusal;
    const correlation = resolveCorrelatedRequest({ harness: "pi", runsRoot, runDirectory,
      nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType) });
    if (!correlation.ok) {
      return captureUnavailable("request-correlation", describeCaptureFailure(correlation.outcome));
    }
    const { handle, request } = correlation.value;
    const registration = handle.readProgramRegistration(16_777_216);
    if (!registration.ok) {
      return captureUnavailable("program-registration", `program registration is unavailable: ${registration.error.message}`);
    }
    const parsedRegistration = parseRegisteredFacadeProgram(registration.value);
    if (parsedRegistration.kind === "invalid") {
      return captureUnavailable("program-registration", `program registration is unavailable: ${parsedRegistration.message}`);
    }
    if (parsedRegistration.kind === "unclaimed") {
      return captureUnclaimedProgramObservation(registration.value, messages);
    }
    if (parsedRegistration.program.kind === "wave-gate" || parsedRegistration.program.kind === "standalone-review") {
      const classified = classifyPiIssuedReviewRequest(handle.runId, parsedRegistration.program, request);
      if (!classified.ok) {
        return captureUnavailable("program-registration", classified.error.message);
      }
      const published = publishedReviewerRequest(handle, request, 16_777_216);
      if (!published.ok) {
        return captureUnavailable("request-publication", `reviewer request publication is unavailable: ${published.message}`);
      }
      const captureAuthority: PiIssuedReviewRequestClass = classified.value.kind === "review-program-emission"
        ? Object.freeze({
            kind: "review-program-emission" as const,
            claim: issuedReviewerPayloadClaim(parsedRegistration.program, published.value.authority),
          })
        : classified.value;
      return piIssuedReviewerCaptureObservation(captureAuthority, messages ?? []);
    }
    return archivedReviewerCaptureObservation(messages);
  };
  const outcome = await captureHarnessResult({
    harness: "pi",
    runsRoot,
    runDirectory,
    nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType),
    observe,
  });
  const audit = captureAuditLine("loom(pi): capture-orchestration-result", outcome);
  if (audit !== null) process.stderr.write(audit);
  return outcome;
}

export interface PiCleanupAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export type PiStartupSweep = Readonly<{ name: string; run: () => void }>;
export type PiStartupSweepSource = () => readonly PiStartupSweep[];
export type PiStartupSweepPorts = Readonly<{
  /** Return false only when the channel is unavailable and wrote nothing. */
  writeDiagnostic: (diagnostic: string) => boolean;
  /** Return false when this session has no UI. */
  notifyWarning: (message: string) => boolean;
  /** Process-level fallback, kept explicit so its failure is observable. */
  writeStderr: (diagnostic: string) => boolean;
}>;

type UnreportedStartupSweepFailure = Readonly<{
  error: Error;
  message: string;
  reportingFailures: readonly string[];
}>;

const startupError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Run every startup hygiene sweep and reporting route before surfacing wholly unreported failures. */
export function runPiStartupSweeps(
  sweeps: readonly PiStartupSweep[],
  ports: PiStartupSweepPorts,
): void {
  const unreported: UnreportedStartupSweepFailure[] = [];
  for (const sweep of sweeps) {
    try {
      sweep.run();
    } catch (error) {
      const sweepError = startupError(error);
      const message = `session_start sweep failed: ${sweep.name}: ${sweepError.message}; ` +
        "startup continues because authority is checked at consumption";
      const diagnostic = sweepError.stack ?? sweepError.message;
      const reportingFailures: string[] = [];
      let reported = false;
      const attemptReport = (label: string, report: () => boolean): void => {
        try {
          if (report()) reported = true;
          else reportingFailures.push(`${label} unavailable`);
        } catch (reportError) {
          reportingFailures.push(
            `${label} failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
          );
        }
      };

      attemptReport("diagnostic writer", () =>
        ports.writeDiagnostic(`loom(pi): ${message}\n${diagnostic}\n`));
      attemptReport("warning notifier", () =>
        ports.notifyWarning(`Loom ${message}${cleanupFailureSuffix(reportingFailures)}`));
      attemptReport("stderr fallback", () =>
        ports.writeStderr(`loom(pi): ${message}${cleanupFailureSuffix(reportingFailures)}\n`));

      if (!reported) {
        unreported.push(Object.freeze({
          error: sweepError,
          message,
          reportingFailures: Object.freeze([...reportingFailures]),
        }));
      }
    }
  }
  if (unreported.length > 0) {
    const details = unreported.map(({ message, reportingFailures }) =>
      `${message}${cleanupFailureSuffix(reportingFailures)}`).join(" | ");
    throw new AggregateError(
      unreported.map(({ error }) => error),
      `Loom session_start sweep failure(s) reached no reporting channel: ${details}`,
    );
  }
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

const productionPiStartupSweeps: PiStartupSweepSource = () => Object.freeze([
  Object.freeze({
    name: "sweepStaleSessions",
    run: (): void => { sweepStaleSessions(subagentDir(), Date.now() - STALE_SUBAGENT_TTL_MS); },
  }),
  Object.freeze({ name: "sweepExpiredPiWriteGrants", run: (): void => sweepExpiredPiWriteGrants() }),
]);

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
    emissionLaunch: PiReservedEmissionLaunch | null;
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
    const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
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
          emissionLaunch: null,
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

type ActiveChildWriteGrantScope = Readonly<{
  scopeDirs?: readonly string[];
  grantCwd?: string;
}>;

type ActiveChildWriteGrant = ActiveChildWriteGrantScope & (
  | Readonly<{ kind: "active"; agentId: AgentId; pointerBinding: SessionTaskGraphPointerBinding }>
  | Readonly<{ kind: "roster-cleanup-pending"; agentId: AgentId; pointerBinding: null }>
  | Readonly<{ kind: "pointer-cleanup-pending"; agentId: null; pointerBinding: SessionTaskGraphPointerBinding }>
);

const emptyParentSessionRuntime = (): PiParentSessionRuntime => ({
  issuedWriteGrants: new Map(),
  spawnReservations: new Map(),
});

const retainSpawnCleanupDebt = (
  runtime: PiParentSessionRuntime,
  toolCallId: string,
  reservation: PiSpawnReservation,
): void => {
  if (reservation.items.length === 0 && reservation.pointerBinding === null) {
    runtime.spawnReservations.delete(toolCallId);
  } else {
    runtime.spawnReservations.set(toolCallId, Object.freeze(reservation));
  }
};

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

async function verifyTrustedReviewRun(
  input: Readonly<{ sessionId: string }>,
  run: TrustedReviewRun,
): Promise<TrustedRunVerification> {
  const reject = (message: string): TrustedRunVerification => ({
    kind: "rejected",
    message: `${run.binding.runId}: ${message}`,
  });
  const opened = openRegisteredRunDirectory(run.binding.runsRoot, run.binding.runDirectory);
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
  const replayed = program.program.schemaVersion === 3
    ? await replayStandaloneCapturedEvidence(opened.value, program.program, run.captures)
    : replayStandaloneResultFromEvidence(opened.value, program.program, run.captures);
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
  if (program.program.schemaVersion === 3) {
    const receipt = opened.value.readReceipt(replayed.ready.publicationIntent.effectId, 16_384);
    if (!receipt.ok || receipt.value?.kind !== "artifact-set-published") return reject("successor result publication receipt is unavailable");
    const published = reduceStandaloneReviewMachine(replayed.ready, { kind: "result-published", result: JSON.parse(replayed.json), receipt: receipt.value });
    if (!published.ok || published.value.kind !== "done") return reject("successor result publication receipt differs from native replay");
  }
  const reviewedSource = readStandaloneReviewedSource(opened.value, program.program, 16_777_216,
    replayed.ready.authority.schemaVersion === 3 ? replayed.ready.authority.successor : undefined);
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

/**
 * The runtime-baseline restoration map for the implementation settlements this
 * batch finalizes: the named tasks' declared artifacts, provably clean at their
 * attempt start, hashed at those attempt-start bytes by the write boundary's
 * revision comparison. An implementation attempt's declared artifacts may live
 * inside the runtime revision domain, and the attempt writing them is the
 * product — without this restoration the settlement reads its own authorized
 * writes as runtime drift and refuses the state update that records its
 * outcome. Any proven-unrestorable input yields an empty map, which keeps the
 * strict full-domain comparison in force (fail closed).
 */
function implementationBaselineRestoreFor(
  manager: StateManager,
  taskIds: readonly string[],
): ReadonlyMap<string, string | null> {
  if (taskIds.length === 0) return new Map();
  try {
    const state = manager.load();
    const tasks = state.tasks.filter((task) => taskIds.includes(task.id));
    if (tasks.length === 0) return new Map();
    const boundary = observeTaskGraphProjectBoundary(manager.getPath());
    if (boundary.kind !== "git-repository") return new Map();
    return runtimeBaselineRestoreForTasks(boundary.root, tasks);
  } catch (error) {
    process.stderr.write(
      `loom(pi): implementation runtime-baseline restore unavailable, strict revision comparison stays: ` +
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return new Map();
  }
}

async function verifyTrustedStandaloneReview(input: Readonly<{ cwd: string; sessionId: string }>): Promise<LoomReviewAuthorityReceipt> {
  const sessionRoots = trustedReviewRuns.get(input.sessionId);
  if (sessionRoots === undefined) throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId}`);
  const expectedRoot = resolve(input.cwd, ".claude/reviews/review-and-fix-runs");
  const root = sessionRoots.get(expectedRoot);
  if (root === undefined || root.runs.size === 0) {
    throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId} and root ${expectedRoot}`);
  }
  const current = [...root.runs.entries()].reduce((latest, candidate) =>
    candidate[1].touchedAt > latest[1].touchedAt ? candidate : latest);
  const outcome = await verifyTrustedReviewRun(input, current[1]);
  if (trustedReviewRuns.get(input.sessionId)?.get(expectedRoot) !== root) {
    throw new Error("current witnessed Standalone Review changed during verification; no older authority accepted");
  }
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

export default function (
  pi: ExtensionAPI,
  startupSweepSource: PiStartupSweepSource = productionPiStartupSweeps,
  qualifyIssuedRoute: PiIssuedReviewRouteQualifier = qualifyPiIssuedReviewRequest,
) {
  assertAnchoredFilesystemPlatformSupported();
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  registerInteractiveSubagentTool(pi, PACKAGE_ROOT, piAgentDir);
  publishLoomReviewAuthorityBridge(globalThis, { verify: verifyTrustedStandaloneReview });
  const emissionLaunchBridge = registerPiEmissionLaunchBridge(
    pi.events as unknown as PiSubagentLaunchEventBus | undefined,
  );

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
  /** Scoped write policy plus exact outstanding child cleanup authority. */
  const activeChildWriteGrants = new Map<string, ActiveChildWriteGrant>();
  const rejectedChildWriteGrantSessions = new Set<string>();

  // ─── Resource Discovery ───────────────────────────────────────────────
  // The package.json "pi" manifest declares NO raw skills or prompt
  // templates (empty arrays): pi would otherwise load the unrendered trees
  // AND the rendered copies below, warn about every same-name collision,
  // and keep the unrendered file first. This handler is therefore the
  // package's single skill/prompt source — RENDERED, content-addressed
  // copies (package-relative tokens expanded) under the Loom resource
  // cache — and materialization is fatal on failure so a broken install
  // cannot silently ship unexpanded ${CLAUDE_PLUGIN_ROOT} paths.

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
        const result = shouldBlockDirectEdit(
          event.toolName,
          sessionId,
          () => graphIsActive,
          activeRosterProbe,
          panelGuardTargets(event.input, ctx.cwd),
        );
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
        //
        // Which graph authority does this batch target? The spawn's declared
        // cwd is the boundary-trusted source: the graph that governs a
        // repository lives IN that repository, so a batch whose items declare
        // a linked worktree is an orchestration dispatch against the
        // worktree's graph even when the orchestrator runtime is rooted in the
        // main checkout. The observation runs BEFORE the admission because the
        // admission's gates consume the polarity; a malformed batch resolves
        // to the runtime polarity and the admission's parse still refuses it.
        const batchGraph = observeSpawnBatchGraph(event.input, ctx.cwd);
        if (batchGraph.kind === "diverged") {
          return { block: true, reason: `BLOCKED: ${batchGraph.reason}.` };
        }
        const spawnGraphPath = batchGraph.kind === "spawn" ? batchGraph.graphPath : null;
        const orchestrationGraphActive = spawnGraphPath !== null || graphIsActive;
        const orchestrationGraphPath = spawnGraphPath ?? taskGraphPath();
        // Expand implementation brief markers BEFORE admission, so every gate
        // below judges the exact engine-rendered brief the child receives.
        currentGuard = "implementation-brief-expansion";
        const briefs = expandImplementationBriefMarkers(event.input, (taskId) =>
          renderTaskImplementationBrief(orchestrationGraphPath, PACKAGE_ROOT, taskId));
        if (!briefs.ok) return { block: true, reason: briefs.reason };
        const routing = buildPiRoutingContext();
        const admission = admitPiSpawnBatch(event.input, {
          graphActive: orchestrationGraphActive,
          transport: event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL ? "interactive-rpc" : "headless",
          packageRoot: PACKAGE_ROOT,
          validateDefinition: (agent) =>
            validatePiAgentDefinitionFile(join(piAgentDir, "agents", `${agent}.md`), agent, PACKAGE_ROOT, routing.context),
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
            return validateTemplateSubstitution(task, orchestrationGraphActive);
          },
          readIssuedRequest: (requestId, contextDigest, agent) => {
            currentGuard = "expected-emission-capability";
            return readPiIssuedSpawnRequest(safeSessionId, requestId, contextDigest, agent, qualifyIssuedRoute);
          },
        });
        if (admission.kind === "block") {
          currentGuard = admission.guard;
          return { block: true, reason: admission.reason };
        }
        if (admission.kind === "pass-through") return;
        const emissionEnabledItems = admission.itemAdmissions.filter(
          ({ emissionExpectation }) => emissionExpectation.kind === "emission-enabled",
        );
        if (emissionEnabledItems.length > 0) {
          currentGuard = "emission-launcher-capability";
          if (event.toolName !== "subagent") {
            return {
              block: true,
              reason: "Emission-enabled requests require the installed normal subagent launcher; interactive transport cannot provision the readiness barrier.",
            };
          }
          const launcherCapability = emissionLaunchBridge.probe();
          if (launcherCapability.kind === "unavailable") {
            return {
              block: true,
              reason: `Emission-enabled spawn refused: ${launcherCapability.reason}. ` +
                "Inspect/install/reload the shared launcher before retrying; Loom will not silently send a JSON-only prompt.",
            };
          }
        }
        const needsTaskGraphLifecycle = admission.needsTaskGraphLifecycle;

        // Reserve every lifecycle identity before task-state mutation. A roster
        // failure can now refuse the spawn without leaving executing_tasks or
        // artifact baselines claiming work began. The ids hash the tool call,
        // the batch ordinal, and the agent type — task text is deliberately
        // excluded (see `piSpawnRosterId`) — so repeated verifier/designer types in
        // one batch remain distinct without the id moving when the prompt does.
        currentGuard = "subagent-tracking";
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
        type LifecycleWriteGrant = Readonly<{
          token: string;
          task: string;
          originalTask: string;
          injected: boolean;
        }>;
        type SpawnLifecycleState = PiSpawnLifecycleAssociation & Readonly<{
          dispatchTaskExecutionSpawn: TaskExecutionSpawn;
          writeGrant: LifecycleWriteGrant | null;
          reviewAuthority: PiReviewAttemptAuthority | null;
          implementationAuthority: ImplementationAttemptAuthority | null;
        }>;
        let spawnLifecycle: readonly SpawnLifecycleState[] = Object.freeze(
          associatePiSpawnLifecycle(admission.itemAdmissions, toolCallId).map((association) => Object.freeze({
            ...association,
            dispatchTaskExecutionSpawn: association.admission.taskExecutionSpawn,
            writeGrant: null,
            reviewAuthority: null,
            implementationAuthority: null,
          })),
        );
        const replaceLifecycleState = (replacement: SpawnLifecycleState): void => {
          spawnLifecycle = Object.freeze(spawnLifecycle.map((state) =>
            state.slot === replacement.slot ? replacement : state));
        };
        const reserved: AgentId[] = [];
        let taskGraphPointerBinding: SessionTaskGraphPointerBinding | null = null;
        let orchestrationRunBinding: SessionRunBinding | null = null;
        let specCheckAuthority: PiSpecCheckAttemptAuthority | null = null;
        let emissionLaunchStaged = false;
        const grantRollbackActions = (revoked: Set<string>): readonly PiCleanupAction[] =>
          spawnLifecycle.flatMap(({ slot, writeGrant }): readonly PiCleanupAction[] => writeGrant === null ? [] : [
            {
              label: `revoke write grant for spawn item ${slot + 1}`,
              run: () => {
                revokePiWriteGrant(writeGrant.token);
                revoked.add(writeGrant.token);
              },
            },
            ...(writeGrant.injected ? [{
              label: `restore child prompt for spawn item ${slot + 1}`,
              run: () => replacePiSpawnTask(event.input, slot, writeGrant.originalTask),
            }] : []),
          ]);
        const rosterRollbackActions = (removed: Set<AgentId>): readonly PiCleanupAction[] =>
          [...reserved].reverse().map((agentId) => ({
            label: `remove active roster entry ${agentId}`,
            run: async () => {
              await fsSessionRegistry.removeActive(safeSessionId, agentId);
              removed.add(agentId);
            },
          }));
        const retainAdmissionCleanupDebt = (
          revoked: ReadonlySet<string>,
          removed: ReadonlySet<AgentId>,
          pointerReleased: boolean,
        ): void => {
          const remainingGrantTokens = spawnLifecycle
            .flatMap(({ writeGrant }) => writeGrant === null ? [] : [writeGrant.token])
            .filter((token) => !revoked.has(token));
          const remainingRosterIds = new Set(reserved.filter((agentId) => !removed.has(agentId)));
          const remainingPointerBinding = pointerReleased ? null : taskGraphPointerBinding;
          if (remainingGrantTokens.length === 0 && remainingRosterIds.size === 0 && remainingPointerBinding === null) return;
          const runtime = runtimeFor(safeSessionId);
          if (remainingGrantTokens.length > 0) {
            runtime.issuedWriteGrants.set(toolCallId, Object.freeze(remainingGrantTokens));
          }
          retainSpawnCleanupDebt(runtime, toolCallId, {
            sessionId: safeSessionId,
            needsTaskGraphLifecycle,
            graphActiveAtSpawn: orchestrationGraphActive,
            orchestrationRunBinding,
            pointerBinding: remainingPointerBinding,
            items: Object.freeze(spawnLifecycle.flatMap((state) =>
              remainingRosterIds.has(state.rosterId)
                ? [Object.freeze({
                    agentType: state.admission.item.agent,
                    rosterId: state.rosterId,
                    taskId: extractTaskId(state.admission.item.task),
                    implementationAuthority: null,
                    reviewAuthority: null,
                    specCheckAuthority: null,
                    emissionLaunch: reservedReviewerEmissionLaunch(
                      state.admission.emissionExpectation,
                      event.input,
                      state.slot,
                    ),
                    kind: state.dispatchTaskExecutionSpawn.kind,
                  })]
                : [])),
          });
        };
        const rollbackLifecycle = async (): Promise<readonly string[]> => {
          const revokedGrantTokens = new Set<string>();
          const removedRosterIds = new Set<AgentId>();
          let pointerReleased = false;
          const pointerActions: PiCleanupAction[] = [];
          if (taskGraphPointerBinding !== null) {
            const ownedPointer = taskGraphPointerBinding;
            pointerActions.push({
              label: "roll back task-graph pointer",
              run: async () => {
                const result = await rollbackSessionTaskGraphPointer(ownedPointer);
                if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
                pointerReleased = true;
              },
            });
          }
          const errors = await runPiCleanupActions([
            ...(emissionLaunchStaged ? [{
              label: `remove emission launch capabilities for ${toolCallId}`,
              run: () => {
                emissionLaunchBridge.removeToolCall(safeSessionId, toolCallId);
                emissionLaunchStaged = false;
              },
            }] : []),
            ...grantRollbackActions(revokedGrantTokens),
            ...rosterRollbackActions(removedRosterIds),
            ...pointerActions,
          ]);
          retainAdmissionCleanupDebt(revokedGrantTokens, removedRosterIds, pointerReleased);
          return errors;
        };
        // Observe graph activity before this prospective batch writes its own
        // roster rows. Those rows prove only that admission is in progress;
        // treating them as an older reservation's liveness makes a timestamped
        // reservation stranded by process death unrecoverable forever. Keep the
        // observation typed so the registration core can limit this ordering
        // exception to current-protocol (timestamped) reservations.
        const rosterObservation: TaskExecutionRosterObservation | undefined =
          orchestrationGraphActive && spawnLifecycle.some(({ admission }) =>
            admission.taskExecutionSpawn.kind === "implementation")
            ? {
                kind: "pre-roster-current-protocol",
                anyActiveForGraph: anyActiveSubagent(orchestrationGraphPath),
              }
            : undefined;
        try {
          mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
          for (const { rosterId } of spawnLifecycle) {
            await fsSessionRegistry.markActive(safeSessionId, rosterId);
            reserved.push(rosterId);
          }
          if (needsTaskGraphLifecycle && pathExistsFailClosed(orchestrationGraphPath)) {
            taskGraphPointerBinding = await bindSessionTaskGraphPointer(
              safeSessionId,
              orchestrationGraphPath,
            );
          }
          // Bind every Loom-owned Pi native spawn identity to the exact issued
          // request before the harness can dispatch the batch. The durable run
          // directory, not the in-memory lifecycle map below, owns capture
          // authority for both Pi and Claude.
          orchestrationRunBinding = await recordPiSpawnCorrelators(
            spawnLifecycle.map(({ admission }) => admission),
            spawnLifecycle.map(({ rosterId }) => rosterId),
            safeSessionId,
            event.input,
          );
          const unboundSpecChecks = orchestrationRunBinding === null
            ? spawnLifecycle.filter(({ admission }) => admission.item.agent === "spec-check-invoker")
            : [];
          if (orchestrationGraphActive && unboundSpecChecks.length > 0) {
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
            ? spawnLifecycle.filter(({ admission }) =>
                isReviewAgent(admission.item.agent) && admission.taskExecutionSpawn.kind !== "standalone")
            : [];
          if (orchestrationGraphActive && unboundReviewers.length > 0) {
            const manager = StateManager.fromLocalSession(safeSessionId);
            if (manager === null) throw new Error("protected Pi reviewer spawn has no TaskGraph authority");
            const reviewGraph = manager.load();
            spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => {
              const { item, taskExecutionSpawn } = state.admission;
              if (!isReviewAgent(item.agent) || taskExecutionSpawn.kind === "standalone") return state;
              const taskId = extractTaskId(item.task);
              const authority = taskId === null ? null : currentPiReviewAuthority(reviewGraph, item.agent, taskId);
              if (authority === null) {
                throw new Error(`protected Pi reviewer ${item.agent} lacks exact current Task/Review Run authority`);
              }
              return Object.freeze({ ...state, reviewAuthority: authority });
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
          const grantPlan = planPiWriteGrants(
            spawnLifecycle.map(({ admission }) => admission.item),
            spawnLifecycle.map(({ admission }) => admission.taskExecutionSpawn),
            orchestrationGraphActive,
          );
          if (!grantPlan.ok) throw new Error(grantPlan.error);
          if (grantPlan.requirements.length !== spawnLifecycle.length) {
            throw new Error("Pi write-grant plan lost its structural spawn association");
          }
          for (const [slot, requirement] of grantPlan.requirements.entries()) {
            if (requirement.kind === "none") continue;
            const state = spawnLifecycle[slot];
            if (state === undefined || state.slot !== slot) {
              throw new Error(`Pi write-grant slot ${slot + 1} lost its admitted spawn association`);
            }
            const item = state.admission.item;
            const grant = issuePiWriteGrant({
              agent: item.agent,
              taskId: requirement.taskId,
              cwd: piSpawnCwd(event.input, slot, ctx.cwd),
              taskGraphPath: orchestrationGraphPath,
              ...(requirement.kind === "scoped" ? { scopeDirs: requirement.scopeDirs } : {}),
            });
            // Track the issued token on the paired item before prompt injection
            // can fail. If immediate revocation also fails, outer rollback
            // retries this exact association instead of orphaning a sibling's
            // grant.
            replaceLifecycleState(Object.freeze({
              ...state,
              writeGrant: Object.freeze({
                token: grant.token,
                task: item.task,
                originalTask: item.task,
                injected: false,
              }),
            }));
            const task = await injectPiWriteGrantWithRevocation(item.task, grant, slot);
            const tracked = spawnLifecycle[slot];
            if (tracked === undefined || tracked.writeGrant === null) {
              throw new Error(`Pi write-grant slot ${slot + 1} lost its issued grant association`);
            }
            replaceLifecycleState(Object.freeze({
              ...tracked,
              writeGrant: Object.freeze({ ...tracked.writeGrant, task }),
            }));
          }
          // Mutate before task-state validation. Rollback restores prompts and
          // revokes grants, leaving no post-validation operation that can fail
          // after executing_tasks/baselines have committed.
          for (const state of spawnLifecycle) {
            if (state.writeGrant === null) continue;
            replacePiSpawnTask(event.input, state.slot, state.writeGrant.task);
            replaceLifecycleState(Object.freeze({
              ...state,
              writeGrant: Object.freeze({ ...state.writeGrant, injected: true }),
            }));
          }
          spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => {
            const spawn = state.admission.taskExecutionSpawn;
            if (spawn.kind !== "implementation") return state;
            if (!isRecord(event.input)) {
              throw new Error("Pi implementation input became malformed before dispatch registration");
            }
            const prompt = piSpawnItem(event.input as Record<string, unknown>, state.slot).task;
            if (typeof prompt !== "string") {
              throw new Error(`Pi implementation spawn item ${state.slot + 1} lost its child-visible prompt`);
            }
            return Object.freeze({
              ...state,
              dispatchTaskExecutionSpawn: Object.freeze({ ...spawn, prompt }),
            });
          }));

          const launchExpectations = spawnLifecycle.flatMap((state): readonly PiEmissionLaunchExpectation[] => {
            const expectation = state.admission.emissionExpectation;
            if (expectation.kind !== "emission-enabled") return [];
            if (!isRecord(event.input)) {
              throw new Error("Pi emission input became malformed before launcher provisioning");
            }
            const finalTask = piSpawnItem(event.input as Record<string, unknown>, state.slot).task;
            if (typeof finalTask !== "string") {
              throw new Error(`Pi emission spawn item ${state.slot + 1} lost its final child task`);
            }
            return [Object.freeze({
              sessionId: safeSessionId,
              toolCallId,
              slot: piSubagentLaunchSlot(event.input, state.slot),
              agent: state.admission.item.agent,
              task: finalTask,
              cwd: piSpawnCwd(event.input, state.slot, ctx.cwd),
              expectation,
              revision: LOADED_RUNTIME_IDENTITY.revision,
            })];
          });
          if (launchExpectations.length > 0) {
            const staged = emissionLaunchBridge.stage(launchExpectations);
            if (!staged.ok) throw new Error(staged.reason);
            emissionLaunchStaged = true;
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
          taskRegistration = orchestrationGraphActive
            ? await registerTaskExecutionBatch(
                spawnLifecycle.map(({ dispatchTaskExecutionSpawn }) => dispatchTaskExecutionSpawn),
                executionMode,
                rosterObservation,
                spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, ctx.cwd),
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
        const alignment = orchestrationGraphActive
          ? alignPiImplementationAuthorities(
              spawnLifecycle.map(({ admission }) => admission.item),
              spawnLifecycle.map(({ dispatchTaskExecutionSpawn }) => dispatchTaskExecutionSpawn),
              taskRegistration.authorities,
            )
          : {
              ok: true as const,
              authoritiesBySlot: Object.freeze(spawnLifecycle.map(() => null)),
            };
        if (!alignment.ok) {
          const registrationRollback = await rollbackTaskExecutionRegistration(
            taskRegistration.authorities,
            spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, ctx.cwd),
          );
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
        if (alignment.authoritiesBySlot.length !== spawnLifecycle.length) {
          const registrationRollback = await rollbackTaskExecutionRegistration(
            taskRegistration.authorities,
            spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, ctx.cwd),
          );
          const cleanupErrors = await rollbackLifecycle();
          return {
            block: true,
            reason: `BLOCKED: implementation authority alignment lost its structural spawn association${cleanupFailureSuffix([
              ...(registrationRollback.kind === "block" ? [registrationRollback.message] : []),
              ...cleanupErrors,
            ])}`,
          };
        }
        spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => Object.freeze({
          ...state,
          implementationAuthority: alignment.authoritiesBySlot[state.slot] ?? null,
        })));
        const sessionRuntime = runtimeFor(safeSessionId);
        const issuedGrantTokens = spawnLifecycle.flatMap(({ writeGrant }) =>
          writeGrant === null ? [] : [writeGrant.token]);
        if (issuedGrantTokens.length > 0) {
          sessionRuntime.issuedWriteGrants.set(toolCallId, Object.freeze(issuedGrantTokens));
        }
        sessionRuntime.spawnReservations.set(toolCallId, {
          sessionId: safeSessionId,
          needsTaskGraphLifecycle,
          graphActiveAtSpawn: orchestrationGraphActive,
          orchestrationRunBinding,
          pointerBinding: taskGraphPointerBinding,
          items: Object.freeze(spawnLifecycle.map((state) => ({
            agentType: state.admission.item.agent,
            rosterId: state.rosterId,
            taskId: extractTaskId(state.admission.item.task),
            implementationAuthority: state.implementationAuthority,
            reviewAuthority: state.reviewAuthority,
            specCheckAuthority: state.admission.item.agent === "spec-check-invoker" ? specCheckAuthority : null,
            emissionLaunch: reservedReviewerEmissionLaunch(
              state.admission.emissionExpectation,
              event.input,
              state.slot,
            ),
            kind: state.dispatchTaskExecutionSpawn.kind,
          }))),
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

  pi.on("session_start", async (_event, ctx) => {
    // Cleanup stale subagent tracking files — the ENGINE's sweep, not a
    // per-file twin: staleness is judged per session GROUP (max mtime across
    // the session's files), and the TTL is the shared STALE_SUBAGENT_TTL_MS,
    // so a live session's roster/ledger can't be reaped out from under a
    // fresh `.machine` anchor.
    //
    // Each sweep is guarded on its own: a crash in one must not prevent the
    // other. Hygiene is not authority — expired or invalid grants are still
    // refused at consumption — but a failure that reaches no diagnostic, UI,
    // or stderr route escapes as one post-batch aggregate so the harness can
    // surface it instead of silently losing the only operator signal.
    runPiStartupSweeps(startupSweepSource(), {
      writeDiagnostic: (diagnostic) => { process.stderr.write(diagnostic); return true; },
      notifyWarning: (message) => {
        if (!ctx.hasUI) return false;
        ctx.ui.notify(message, "warning");
        return true;
      },
      writeStderr: (diagnostic) => { process.stderr.write(diagnostic); return true; },
    });
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
      activeChildWriteGrants.set(sessionId, {
        kind: "active",
        agentId,
        pointerBinding,
        scopeDirs: grant.scopeDirs,
        grantCwd: grant.cwd,
      });
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
      const cleanupErrors: readonly string[] = orphanedBinding === null
        ? Object.freeze([])
        : await runPiCleanupActions([{
            label: `remove partial child roster entry ${orphanedBinding.agentId}`,
            run: () => fsSessionRegistry.removeActive(orphanedBinding.sessionId, orphanedBinding.agentId),
          }]);
      for (const cleanupError of cleanupErrors) {
        process.stderr.write(`loom(pi): child write-grant cleanup failed: ${cleanupError}\n`);
      }
      if (orphanedBinding !== null && cleanupErrors.length > 0) {
        activeChildWriteGrants.set(orphanedBinding.sessionId, {
          kind: "roster-cleanup-pending",
          agentId: orphanedBinding.agentId,
          pointerBinding: null,
        });
      }
      const message = `loom(pi): child write grant rejected — edits remain blocked: ${error instanceof Error ? error.message : String(error)}` +
        cleanupFailureSuffix(cleanupErrors);
      process.stderr.write(message + "\n");
      return {
        message: { customType: "loom-write-grant-error", content: message, display: false },
      };
    }
    return undefined;
  });

  // ─── Emission Readiness (launcher barrier, AD-4/FR-008) ───────────────
  // An emission-enabled child is PROVISIONED by its launcher with the issued
  // binding before any prompt exists (LOOM_EMISSION_BINDING). The child never
  // self-declares readiness: the launcher discovers /loom-emission-readiness
  // via get_commands, invokes it through the RPC prompt command (extension
  // commands execute without a model request — proven by
  // probes/emission-readiness), and receives the bound readiness payload via
  // entry_appended. The in-child awaited before_agent_start hold is the
  // defense-in-depth layer: a prompt delivered without the readiness exchange
  // WEDGES here — holds gate, throws are caught-and-continued by pi and can
  // never carry this barrier. A non-emission child (no provisioning env) has
  // no hold, and the command refuses explicitly when invoked.
  const emissionChild = parseEmissionChildProvisioning(process.env[LOOM_EMISSION_BINDING_ENV]);
  // The one transition a child's registration takes, wrapping the side
  // effect that makes it true (pi.registerTool): unregistered → registered.
  // The transition DECISION is pure (pi/emission-tool.ts); the shell applies
  // it — this field is the child's process-local aggregate, the same posture
  // as parentSessionRuntimes above.
  const emissionRegistrationState: { state: EmissionToolRegistration } = { state: { kind: "unregistered" } };
  type EmissionHold =
    | Readonly<{ kind: "unprovisioned" }>
    | Readonly<{ kind: "armed"; wait: Promise<void>; release: () => void }>
    | Readonly<{ kind: "released" }>;
  const armEmissionHold = (): EmissionHold => {
    const deferred = Promise.withResolvers<void>();
    return Object.freeze({ kind: "armed" as const, wait: deferred.promise, release: () => deferred.resolve() });
  };
  const emissionHoldState: { current: EmissionHold } = {
    current: emissionChild.kind === "not-provisioned"
      ? Object.freeze({ kind: "unprovisioned" as const })
      : armEmissionHold(),
  };
  const appendEmissionHoldDiagnostic = (phase: EmissionHoldPhase): void => {
    try {
      pi.appendEntry(EMISSION_HOLD_ENTRY_TYPE, { phase });
    } catch (thrown) {
      // Diagnostics never carry the barrier: append failure is visible, while
      // the armed hold below remains the operation that gates the prompt.
      const cause = boundedThrownCause(thrown, "emission hold diagnostic append");
      process.stderr.write(
        `loom(pi): emission hold ${phase} diagnostic append failed (${cause.name}: ${cause.message}); the hold remains fail-closed\n`,
      );
    }
  };

  pi.registerCommand(EMISSION_READINESS_COMMAND, {
    description: "Emission readiness: register the issued emission tool, verify it active, report the bound readiness payload.",
    handler: async () => {
      // Local narrowed copy of the once-parsed provisioning: the handler
      // narrows its own view (closure narrowing of the outer const is not
      // assumed).
      const provisioned = emissionChild;
      if (provisioned.kind === "not-provisioned") {
        throw new Error(
          "loom-emission-readiness is only for emission-enabled children: no LOOM_EMISSION_BINDING is provisioned in this child. " +
            "Remediation: the launcher barrier provisions the issued emission binding before readiness.",
        );
      }
      if (provisioned.kind === "provisioning-refused") {
        throw new Error(
          `the provisioned LOOM_EMISSION_BINDING is unusable [${provisioned.code}]: ${provisioned.reason}. ` +
            "Remediation: respawn the child with the issued emission binding.",
        );
      }
      const registration = decideEmissionToolRegistration(emissionRegistrationState.state, provisioned.binding);
      if (registration.kind === "contradictory") {
        throw new Error(
          `${describeEmissionRegistrationContradiction(registration)}. ` +
            "Remediation: spawn a fresh child for each issued request — a child holds exactly one binding.",
        );
      }
      if (registration.kind === "register") {
        const definition = emissionToolDefinition(provisioned.binding);
        // THE confined TypeBox claim at the ONE pi registration surface: the
        // parameters ARE the frozen bytes parsed once (one schema, no second
        // contract — FR-021/SC-006); pi's registerTool types them as a
        // TypeBox schema, and the byte-match guard is the contract suite's.
        pi.registerTool(definition as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
        emissionRegistrationState.state = { kind: "registered", binding: provisioned.binding };
      }
      const active = pi.getActiveTools().includes(provisioned.binding.toolName);
      const report = emissionReadinessReport(provisioned, {
        revision: LOADED_RUNTIME_IDENTITY.revision,
        active,
        childPid: process.pid,
        registeredTools: pi.getAllTools().map((tool) => tool.name),
      });
      pi.appendEntry(EMISSION_READINESS_ENTRY_TYPE, report);
      // The hold releases only when the registered tool is in the ACTUAL
      // active set: an honestly-inactive tool is reported (the gate refuses)
      // and its prompts stay wedged — fail-closed, never silently degraded.
      const hold = emissionHoldState.current;
      if (active && hold.kind === "armed") {
        emissionHoldState.current = Object.freeze({ kind: "released" as const });
        hold.release();
      }
      return undefined;
    },
  });

  pi.on("before_agent_start", async () => {
    const hold = emissionHoldState.current;
    if (hold.kind !== "armed") return undefined;
    appendEmissionHoldDiagnostic("entered");
    await hold.wait;
    appendEmissionHoldDiagnostic("resolved");
    return undefined;
  });

  // Fail-safe hold resolution (AD-4's cleanup arm): a provisioned child whose
  // hold is still ARMED at session shutdown must not leave its awaited
  // before_agent_start handler pending forever — the wedged coroutine cannot
  // outlive the session it gates. Releasing at shutdown admits no model
  // request (the session is ending), so the barrier stays fail-closed for
  // every prompt; the shutdown-released entry is the honest forensic marker
  // that readiness never opened on this child. An already-released (or
  // never-armed) hold is inert here.
  pi.on("session_shutdown", async () => {
    const hold = emissionHoldState.current;
    if (hold.kind !== "armed") return;
    emissionHoldState.current = Object.freeze({ kind: "released" as const });
    hold.release();
    appendEmissionHoldDiagnostic("shutdown-released");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const rawSessionId = ctx.sessionManager.getSessionId() ?? "";
    trustedReviewRuns.delete(rawSessionId);
    const sessionId = parseSessionId(rawSessionId);
    if (sessionId !== null) emissionLaunchBridge.removeSession(sessionId);
    const binding = activeChildWriteGrants.get(rawSessionId);
    const actions: PiCleanupAction[] = [];
    const revokedTokens = new Set<string>();
    const removedRosterIds = new Set<AgentId>();
    const releasedPointers = new Set<SessionTaskGraphPointerBinding>();

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
          run: () => {
            revokePiWriteGrant(token);
            revokedTokens.add(token);
          },
        });
      }
    }
    const childAgentId = binding?.agentId ?? null;
    if (sessionId && childAgentId !== null) {
      actions.push({
        label: `remove child roster entry ${childAgentId}`,
        run: async () => {
          await fsSessionRegistry.removeActive(sessionId, childAgentId);
          removedRosterIds.add(childAgentId);
        },
      });
    }
    const childPointer = binding?.pointerBinding ?? null;
    if (sessionId && childPointer !== null) {
      actions.push({
        label: `roll back child task-graph pointer for ${sessionId}`,
        run: async () => {
          const result = await rollbackSessionTaskGraphPointer(childPointer);
          if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
          releasedPointers.add(childPointer);
        },
      });
    }
    for (const reservation of parentRuntime?.spawnReservations.values() ?? []) {
      for (const item of reservation.items) {
        actions.push({
          label: `remove shutdown roster entry for ${item.agentType}`,
          run: async () => {
            await fsSessionRegistry.removeActive(reservation.sessionId, item.rosterId);
            removedRosterIds.add(item.rosterId);
          },
        });
      }
      if (reservation.pointerBinding !== null) {
        const pointerBinding = reservation.pointerBinding;
        actions.push({
          label: `release shutdown task-graph pointer lease for ${reservation.sessionId}`,
          run: async () => {
            const result = await rollbackSessionTaskGraphPointer(pointerBinding);
            if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
            releasedPointers.add(pointerBinding);
          },
        });
      }
    }

    const cleanupErrors = await runPiCleanupActions(actions);
    // Retire each successfully released capability independently. Retaining an
    // entire aggregate after one failure retries already-released pointer
    // leases as `not-owned`, turning a recoverable cleanup debt permanent.
    if (sessionId && parentRuntime !== undefined) {
      for (const [toolCallId, tokens] of parentRuntime.issuedWriteGrants) {
        const remaining = tokens.filter((token) => !revokedTokens.has(token));
        if (remaining.length === 0) parentRuntime.issuedWriteGrants.delete(toolCallId);
        else parentRuntime.issuedWriteGrants.set(toolCallId, Object.freeze(remaining));
      }
      for (const [toolCallId, reservation] of parentRuntime.spawnReservations) {
        const items = reservation.items.filter((item) => !removedRosterIds.has(item.rosterId));
        const pointerBinding = reservation.pointerBinding !== null && releasedPointers.has(reservation.pointerBinding)
          ? null
          : reservation.pointerBinding;
        retainSpawnCleanupDebt(parentRuntime, toolCallId, {
          ...reservation,
          items: Object.freeze(items),
          pointerBinding,
        });
      }
      pruneRuntime(sessionId, parentRuntime);
    }
    if (binding !== undefined) {
      const agentId = binding.agentId !== null && removedRosterIds.has(binding.agentId) ? null : binding.agentId;
      const pointerBinding = binding.pointerBinding !== null && releasedPointers.has(binding.pointerBinding)
        ? null
        : binding.pointerBinding;
      if (agentId === null && pointerBinding === null) {
        activeChildWriteGrants.delete(rawSessionId);
      } else if (agentId !== null && pointerBinding !== null) {
        activeChildWriteGrants.set(rawSessionId, { ...binding, kind: "active", agentId, pointerBinding });
      } else if (agentId !== null) {
        activeChildWriteGrants.set(rawSessionId, {
          ...binding,
          kind: "roster-cleanup-pending",
          agentId,
          pointerBinding: null,
        });
      } else if (pointerBinding !== null) {
        activeChildWriteGrants.set(rawSessionId, {
          ...binding,
          kind: "pointer-cleanup-pending",
          agentId: null,
          pointerBinding,
        });
      }
    }
    const parentCleanupComplete = sessionId === null || !parentSessionRuntimes.has(sessionId);
    if (!activeChildWriteGrants.has(rawSessionId) && parentCleanupComplete) {
      rejectedChildWriteGrantSessions.delete(rawSessionId);
    }
    for (const cleanupError of cleanupErrors) {
      process.stderr.write(`loom(pi): shutdown cleanup failed: ${cleanupError}\n`);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors.map((error) => new Error(error)),
        `Loom Pi session shutdown cleanup failed: ${cleanupErrors.join("; ")}`,
      );
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
    if (typeof toolCallId === "string") emissionLaunchBridge.removeToolCall(rawSessionId, toolCallId);
    const resultSessionId = parseSessionId(rawSessionId);
    let sessionRuntime = resultSessionId === null
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
        if (reservation !== undefined) {
          sessionRuntime = runtimeFor(resultSessionId);
          sessionRuntime.spawnReservations.set(toolCallId, reservation);
        }
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

    // Retire successful grant, roster, and pointer cleanup independently. The
    // session aggregate keeps only failed authority so shutdown can retry a
    // transient result-time failure without replaying released capabilities.
    const revokedGrantTokens = new Set<string>();
    const removedRosterIds = new Set<AgentId>();
    const cleanupActions: PiCleanupAction[] = grantTokens.map((token, index) => ({
      label: `revoke write grant ${index + 1}`,
      run: () => {
        revokePiWriteGrant(token);
        revokedGrantTokens.add(token);
      },
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
          run: async () => {
            await fsSessionRegistry.removeActive(reservedSessionId, item.rosterId);
            removedRosterIds.add(item.rosterId);
          },
        });
      }
    }
    const cleanupErrors = await runPiCleanupActions(cleanupActions);
    processingErrors.push(...cleanupErrors);
    for (const cleanupError of cleanupErrors) {
      process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${cleanupError}\n`);
    }
    if (typeof toolCallId === "string" && sessionRuntime) {
      const remainingGrantTokens = grantTokens.filter((token) => !revokedGrantTokens.has(token));
      if (remainingGrantTokens.length === 0) sessionRuntime.issuedWriteGrants.delete(toolCallId);
      else sessionRuntime.issuedWriteGrants.set(toolCallId, Object.freeze(remainingGrantTokens));

      const storedReservation = sessionRuntime.spawnReservations.get(toolCallId);
      if (storedReservation !== undefined) {
        const remainingItems = storedReservation.items.filter((item) => !removedRosterIds.has(item.rosterId));
        retainSpawnCleanupDebt(sessionRuntime, toolCallId, {
          ...storedReservation,
          items: Object.freeze(remainingItems),
        });
      }
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
        const storedReservation = sessionRuntime.spawnReservations.get(toolCallId);
        if (storedReservation !== undefined) {
          retainSpawnCleanupDebt(sessionRuntime, toolCallId, {
            ...storedReservation,
            pointerBinding: null,
          });
        }
      }
      if (sessionRuntime) pruneRuntime(resultSessionId, sessionRuntime);
    };

    const settleReservedImplementationCrash = async (
      item: PiSpawnReservation["items"][number] | undefined,
      diagnostic: string,
    ): Promise<readonly string[]> => {
      if (item?.kind !== "implementation" || item.implementationAuthority === null) return [];
      const finalizedAt = parseIsoInstant(new Date().toISOString(), "Pi crash-settlement instant");
      if (!finalizedAt.ok) return [finalizedAt.error.errors.join("; ")];
      try {
        const manager = StateManager.fromLocalSession(reservation?.sessionId ?? "");
        if (manager === null) return [`cannot settle crashed reserved implementation ${item.taskId ?? "unknown"}: task graph unavailable`];
        const applied = await manager.updateAndReturn((state) => {
          const settlement = settleUnavailableImplementation(
            state,
            item.implementationAuthority!,
            finalizedAt.value,
            diagnostic,
          );
          if (settlement.kind === "error") throw new Error(JSON.stringify(settlement.error));
          return { state: settlement.state, value: settlement };
        });
        if (applied.kind === "ignored") {
          process.stderr.write(
            `loom(pi): crashed result for ${item.taskId ?? "unknown"} was ${applied.reason}; current authority preserved\n`,
          );
        }
        return [];
      } catch (error) {
        return [
          `cannot settle crashed reserved implementation ${item.taskId ?? "unknown"}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        ];
      }
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
      // Restore the reserved attempts' declared artifacts to their attempt-start
      // bytes for the write boundary's revision comparison, so the settlement of
      // an attempt that (correctly) wrote engine/src or pi files is not refused
      // as runtime drift. Unprovable inputs yield an empty map: strict stays.
      const finalizeRestore = implementationBaselineRestoreFor(
        manager,
        reservation.items.flatMap((item) =>
          item.kind === "implementation" && item.taskId !== null ? [item.taskId] : []),
      );
      if (finalizeRestore.size > 0) {
        try {
          manager = StateManager.fromLocalSession(reservation.sessionId, finalizeRestore) ?? manager;
        } catch (error) {
          process.stderr.write(
            `loom(pi): baseline-restored manager construction failed; strict comparison stays: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
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
            const retired = retireCompletedOrMissingImplementation(state, item.taskId, item);
            if (retired.retired) {
              state = retired.state;
              logs.push(`retired completed/missing implementation reservation for ${item.taskId}`);
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

    const rawDetails: unknown = event.details;
    const details = isRecord(rawDetails)
      ? rawDetails as Record<string, unknown>
      : null;
    const hasResults = details !== null && Object.hasOwn(details, "results");
    const rawResults = hasResults && Array.isArray(details.results) ? details.results : [];
    // Exact per-entry parsing precedes finalization. A matching-agent/exit-0
    // shell is not a successful implementation envelope until transcript shape
    // and exact returned Task identity have both parsed.
    const entries = parsePiSubagentResults(rawResults);
    if (!spawnedWithoutTaskGraph(reservation)) {
      processingErrors.push(...await finalizeReservedImplementations(entries));
    }
    // Silent-stop observability: an exit-0 result with no assistant text is the
    // failure mode the appliers cannot name — they parse the empty transcript
    // and report "not ready"/"no structured evidence" without the stopReason
    // that discriminates it. The note is stderr-only: the state side above
    // already settled or preserved what it owns, and a processing error here
    // would turn a settled batch into an orchestration failure.
    for (const entry of entries) {
      if (!entry.ok) continue;
      const note = piSilentStopNote(entry.result);
      if (note !== null) process.stderr.write(`loom(pi): ${note}\n`);
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
        const diagnostic = "no typed pre-prompt outcome exists; terminal capture rejection";
        const resultDiagnostic =
          `request-bound result ${index + 1} for ${item.agentType} was absent or unusable; ${diagnostic}`;
        const captureDiagnostic =
          `request-bound result ${index + 1} for ${item.agentType} was missing or mismatched; ${diagnostic}`;
        processingErrors.push(resultDiagnostic);
        process.stderr.write(`loom(pi): ${resultDiagnostic}\n`);
        const runBinding = reservation.orchestrationRunBinding;
        if (runBinding === null) {
          const failure = `cannot terminalize absent or unusable ${item.agentType}[${index}]: reservation lost its run binding`;
          processingErrors.push(failure);
          process.stderr.write(`loom(pi): ${failure}\n`);
        } else {
          await persistCaptureRejection(runBinding, index, item.agentType, captureDiagnostic);
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
              const reviewedState: TaskGraph = { ...state, tasks };
              const specAuthorityProblems: string[] = [];
              let settledState = reviewedState;
              if (missingSpecChecks.length > 1) {
                specAuthorityProblems.push("multiple reserved spec-check slots were missing; no unique authority exists");
              } else if (missingSpecChecks.length === 1) {
                const missing = missingSpecChecks[0]!;
                const authority = missing.item.specCheckAuthority;
                const problem = piSpecCheckAuthorityProblem(state, authority);
                if (problem !== null || authority === null) {
                  specAuthorityProblems.push(problem ?? "reserved spec-check authority is absent");
                } else {
                  settledState = settleSpecCheck(reviewedState, {
                    kind: "capture-failure",
                    wave: authority.wave,
                    runAt,
                    error: `reserved spec-check result ${missing.index + 1} for spec-check-invoker was missing or mismatched`,
                  }).state;
                }
              }
              return {
                state: settledState,
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

    if (!hasResults) {
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

        const startupClassification = durableRunBinding !== null && reservation !== undefined && reservedItem !== undefined
          ? classifyPiEmissionStartupRefusal({
              rawResult: rawResults[resultIndex],
              result,
              reservation,
              reservedItem,
              runBinding: durableRunBinding,
              toolCallId,
              resultIndex,
              agentType,
            })
          : Object.freeze({ kind: "ordinary" as const });
        if (startupClassification.kind === "untrusted-marker") {
          const diagnostic = `untrusted emission launch outcome for ${agentType}[${resultIndex}]: ${startupClassification.reason}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}; applying the ordinary failed-result lifecycle\n`);
        }
        if (startupClassification.kind === "proven-startup-refusal") {
          const marker = startupClassification.marker;
          const diagnostic =
            `Emission startup refused before the Task prompt for issued request ${marker.requestId} ` +
            `(${agentType}, ${marker.toolName}): ${marker.reason}. ` +
            "Correct the launcher/readiness infrastructure and retry this same issued request with a new subagent tool call.";
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic} Semantic capture authority was retained.\n`);
          continue;
        }

        // Request-bound capture runs BEFORE the standalone short-circuit and
        // before any StateManager resolution — the same two orderings dispatch.ts
        // documents as load-bearing on the Claude side. Standalone results are
        // precisely the ones a run directory exists to collect, so capturing
        // after that `continue` would capture nothing for exactly the flows this
        // path serves; and capture must record evidence before any handler acts
        // on it. It reads only the run directory it is pointed at, never a State
        // File, so a run beside an active wave cannot cross into it.
        const agentFailure = piSubagentResultFailed(result) && runBound
          ? terminalCaptureRefusal(
              "agent-failed",
              `${agentType} exited without a successful result (${piSubagentFailureSignals(result)})`,
            )
          : null;
        const captureOutcome = await capturePiSubagentResult(
          toolCallId,
          resultIndex,
          agentType,
          result.messages,
          durableRunBinding,
          agentFailure,
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
        if (captureOutcome.kind === "terminal-rejection" ||
            captureOutcome.kind === "retriable-failure" ||
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
        // Implementation settlement in this batch may have written declared
        // engine/src/pi artifacts: restore those attempts' declared, clean-at-spawn
        // artifacts to their attempt-start bytes for the write boundary's revision
        // comparison (see implementationBaselineRestoreFor). Unprovable inputs yield
        // an empty map and the strict full-domain comparison stays.
        let settlementMgr = mgr;
        try {
          const state = mgr.load();
          const settleTaskIds = [
            ...new Set([
              ...(state.executing_tasks ?? []),
              ...(reservation?.items ?? []).flatMap((item) => item.taskId === null ? [] : [item.taskId]),
            ]),
          ];
          const settleRestore = implementationBaselineRestoreFor(mgr, settleTaskIds);
          if (settleRestore.size > 0) {
            settlementMgr = StateManager.fromLocalSession(sessionId, settleRestore) ?? mgr;
          }
        } catch (error) {
          process.stderr.write(
            `loom(pi): implementation runtime-baseline restore unavailable, strict revision comparison stays: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        const store = settlementMgr;
        // One observation owns both Pi adapters. A Git failure throws and the
        // per-result shell records infrastructure failure; it never substitutes
        // the runtime checkout or cwd for the TaskGraph's project boundary.
        const projectBoundary = observeTaskGraphProjectBoundary(mgr.getPath());
        const repository: RepositoryProbe = {
          root: () => projectBoundary.root,
          isRepo: () => projectBoundary.kind === "git-repository",
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
            projectBoundary,
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
            // Phase artifacts and implementation settlement consume the same
            // TaskGraph Project Boundary observed above.
            phaseArtifactBaseDir: projectBoundary.root,
          }));
          continue;
        }

        // --- Impl agent → update task status ---
        if (IMPL_AGENTS.has(agentType)) {
          emit(await applyImplementationPiResult({
            store,
            repository,
            authoritativeStatePath: mgr.getPath(),
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
            projectBoundary,
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
        const settlementErrors = await settleReservedImplementationCrash(
          reservation?.items[resultIndex],
          diagnostic,
        );
        processingErrors.push(diagnostic, ...settlementErrors);
        process.stderr.write(
          `loom(pi): subagent-stop processing failed for ${diagnostic} — continuing with remaining results\n`,
        );
        for (const settlementError of settlementErrors) {
          process.stderr.write(`loom(pi): ${settlementError}\n`);
        }
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
        const rendered = await currentOrchestrationStatus([], activeTaskGraphPath);
        ctx.ui.notify(rendered, rendered.includes("- location: unavailable (") ? "error" : "info");
      } catch (error) {
        ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
