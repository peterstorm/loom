/**
 * Orchestration façade — one deep interface for the parent.
 *
 * Usage:
 *   helper orchestration status [--json] [--wave N] [--runs-root <wave-gate-runs-root>]
 *   helper orchestration inspect --run <run-directory> --runs-root <root> [--json]
 *   helper orchestration abandon --run <run-directory> --runs-root <root>
 *                                --reason <text> [--superseded-by <run-directory>]
 *   helper orchestration start <architecture|refutation|standalone-review|wave-gate|remediation> --run <run-directory>
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
 *
 * Every `--run`, `--new-run`, and remediation `sourceRun` accepts either the
 * bare run id or a full path to that same direct child of its runs-root. The
 * operations that create a run — `start`, `restart --new-run`, and
 * `recover-orphan --new-run` — create the directory; the runs-root itself must
 * already exist. Every other operation requires the run to exist, because an
 * absent Run Directory is the orphan case recovery adjudicates.
 *
 * Each mutating call parses authority, applies at most one event or receipt
 * reconciliation, persists it, and returns exactly one external action. The
 * parent therefore never assembles an action itself, and never has to know
 * which program produced it.
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SUBAGENT_DIR, TASK_GRAPH_PATH } from "../../config";
import { parseTaskGraph } from "../../state-manager";
import type { HookHandler, HookResult } from "../../types";
import {
  deriveLoomStatusFromParsedGraph,
  deriveWaveReadiness,
  renderLoomStatusHuman,
  renderLoomStatusJson,
  type ActiveRunDirectoryObservation,
  type GateDeps,
} from "../../core/wave-gate-machine";
import { loadPlanModelsSource } from "./complete-wave-gate";
import { createRunDirectory, inspectRunDirectoryEntry, openRunDirectory, type RunDirHandle } from "../../orchestration/run-directory-handle";
import {
  deriveRunInspection,
  observed,
  renderRunInspectionHuman,
  renderRunInspectionJson,
  unavailable,
  type InspectedEvent,
  type ObservedFact,
  type RunInspectionObservation,
} from "../../core/run-inspection";
import { registerSessionRunBinding } from "../../orchestration/session-run-bindings";
import {
  AGENT_REQUIRED_SKILLS,
  parseAgentRequestAuthority,
  parseStoredAgentRequestAuthority,
  parseEffectId,
  parseFixedArtifactSlot,
  parseRequestId,
  parseSlotId,
  type AgentRequestAuthority,
  type EffectIntent,
} from "../../core/orchestration-contract";
import {
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureDispatchProgram,
  startRefutationDispatchProgram,
  type PanelProgramAction,
  type SpawnRequest as PanelSpawnRequest,
} from "../../core/panel-program";
import { resolveModelProfile, lowerModelProfile } from "../../core/model-profiles";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../orchestration/context-packets";
import { countRefutationVotes, defaultRefutationThreshold, parseRefutationVerdict, type RefutationVerdict } from "../../core/review-panel";
import { aggregateVerdicts, candidateFilename, parseArchitectureCandidate, parseArchitectureFinalization, parseJudgeVerdict, type JudgeVerdict } from "../../core/panel-contract";
import type { VerdictEnvelope } from "../../core/panel-kernel";
import { createEffectRunner } from "../../orchestration/effect-runner";
import { captureKey } from "../../core/harness-capture";
import {
  translateLegacyPanelJournal,
  type LegacyArchitecturePanelJournal,
  type LegacyRefutationPanelJournal,
} from "./panel-program";
import {
  applyWaveFacadeSubmission,
  parseRegisteredFacadeProgram,
  parseRemediationStartInput,
  parseStandaloneStartInput,
  parseWaveGateStartInput,
  renderSpawnTask,
  resumeRemediationFacade,
  resumeStandaloneFacade,
  resumeWaveGateFacade,
  recoverOrphanedWaveGateFacade,
  restartWaveGateFacade,
  startRemediationFacade,
  startStandaloneFacade,
  startWaveGateFacade,
  waveAdvisoryDecisionRequestId,
  waveGateDecisionMismatch,
  type FacadeDriveResult,
  type ProgramParse,
  type RegisteredRemediationProgram,
  type RegisteredStandaloneProgram,
  type RegisteredWaveGateProgram,
} from "./programs";
import { argumentValue, hasFlag } from "./cli-args";

const OPERATIONS = ["status", "inspect", "start", "restart", "recover-orphan", "resume", "submit", "correlate", "complete", "decide", "abandon"] as const;
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
      "  inspect --runs-root <root> --run <run-directory> [--json]",
      "          (pure read: program, state, per-slot capture and rejection diagnostics, event tail)",
      "  abandon --runs-root <root> --run <run-directory> --reason <text> [--superseded-by <run-directory>]",
      "          (terminal marker; deletes nothing and refuses every operation that would advance the run)",
      "  start   <architecture|refutation|standalone-review|wave-gate|remediation> --runs-root <root> --run <run-directory> < program.json",
      "  restart --runs-root <root> --run <exhausted-wave-run> --new-run <fresh-run-directory>",
      "  recover-orphan --runs-root <root> --run-id <missing-run-id> --wave <N> --digest <sha256> --new-run <fresh-run-directory>",
      "  resume  --runs-root <root> --run <run-directory>",
      "  submit  --runs-root <root> --run <run-directory> --request <id> --slot <id> --attempt <1|2>",
      "          (idempotent: a repeat for a captured attempt keeps the stored bytes)",
      "  correlate --runs-root <root> --run <run-directory> --request <id> --harness <pi|claude> --native-id <id> --agent <role>",
      "  complete --runs-root <root> --run <run-directory> --operation <id>",
      "  decide  --runs-root <root> --run <run-directory> --request <decision-id>",
    ].join("\n"),
  };
}


/** The real filesystem seams status reads through. */
const productionGateDeps: GateDeps = {
  loadPlanModels: loadPlanModelsSource,
  fileExists: existsSync,
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
export function renderStatus(
  rawGraph: unknown,
  deps: GateDeps,
  asJson: boolean,
  runDirectory: ActiveRunDirectoryObservation = Object.freeze({ kind: "unverified" }),
): string {
  const parsed = parseTaskGraph(rawGraph);
  const status = deriveLoomStatusFromParsedGraph(parsed, deps, null, runDirectory);
  return asJson ? renderLoomStatusJson(status) : renderLoomStatusHuman(status);
}

function readGraph(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    // A parse failure is itself a status fact: hand the boundary something it
    // will reject, so the reason travels through the same contract.
    return { __unreadable: error instanceof Error ? error.message : String(error) };
  }
}

function canonicalWaveGateRunsRoot(): string {
  return join(dirname(dirname(resolve(TASK_GRAPH_PATH))), "reviews", "wave-gate-runs");
}

function statusRunDirectoryObservation(rawGraph: unknown, args: readonly string[]): ActiveRunDirectoryObservation {
  const parsed = parseTaskGraph(rawGraph);
  if (!parsed.ok || parsed.value.active_wave_gate === undefined ||
      parsed.value.active_wave_gate.terminalOutcome !== null) return Object.freeze({ kind: "unverified" });
  const active = parsed.value.active_wave_gate;
  const runId = active.runId;
  const requestedRoot = argumentValue(args, "--runs-root");
  const runsRoot = active.runsRoot ?? resolve(requestedRoot ?? canonicalWaveGateRunsRoot());
  if (active.runsRoot !== undefined && requestedRoot !== null && resolve(requestedRoot) !== active.runsRoot) {
    return Object.freeze({
      kind: "invalid",
      runId,
      path: join(active.runsRoot, runId),
      message: `requested runs root ${resolve(requestedRoot)} does not match protected root ${active.runsRoot}`,
    });
  }
  const expectedPath = join(runsRoot, runId);
  const inspected = inspectRunDirectoryEntry(runsRoot, expectedPath);
  if (!inspected.ok) {
    return Object.freeze({
      kind: "invalid",
      runId,
      path: resolve(expectedPath),
      message: inspected.error.message,
    });
  }
  if (inspected.value.kind === "absent") {
    return Object.freeze({ kind: "absent", runId, path: inspected.value.reference.runDirectory });
  }
  if (inspected.value.kind === "directory") {
    return Object.freeze({ kind: "present", runId, path: inspected.value.reference.runDirectory });
  }
  return Object.freeze({
    kind: "invalid",
    runId,
    path: inspected.value.reference.runDirectory,
    message: `expected a directory but found ${inspected.value.entryKind}`,
  });
}

/**
 * Has the operator already approved this run's advisory request?
 *
 * The decision lives in the run's event log, never in the protected graph, so
 * LC-1 cannot derive it — the shell observes it and hands it to the core. Any
 * failure to read reads as "not approved", which keeps status asking for a
 * decision rather than reporting progress that has not happened.
 */
async function observedAdvisoryApproval(
  rawGraph: unknown,
  observation: ActiveRunDirectoryObservation,
): Promise<boolean> {
  if (observation.kind !== "present") return false;
  const parsed = parseTaskGraph(rawGraph);
  if (!parsed.ok) return false;
  const opened = openRunDirectory(dirname(observation.path), observation.path);
  if (!opened.ok) return false;
  const readiness = deriveWaveReadiness(parsed.value, productionGateDeps);
  if (!readiness.ok) return false;
  const decisionId = waveAdvisoryDecisionRequestId(observation.runId, readiness.value.waveTasks);
  try {
    const events = await opened.value.readEvents();
    return events.some(({ event }) => {
      if (typeof event !== "object" || event === null) return false;
      const record = event as Record<string, unknown>;
      const decision = record.decision;
      return record.kind === "user-decision-recorded" && record.decisionId === decisionId &&
        typeof decision === "object" && decision !== null && !Array.isArray(decision) &&
        Object.keys(decision).length === 1 && (decision as Record<string, unknown>).kind === "approve";
    });
  } catch {
    return false;
  }
}

async function statusOperation(args: readonly string[]): Promise<HookResult> {
  const rawGraph = readGraph(TASK_GRAPH_PATH);
  const base = statusRunDirectoryObservation(rawGraph, args);
  const observation: ActiveRunDirectoryObservation = base.kind === "present"
    ? Object.freeze({ ...base, advisoryApproved: await observedAdvisoryApproval(rawGraph, base) })
    : base;
  const output = renderStatus(rawGraph, productionGateDeps, hasFlag(args, "--json"), observation);
  process.stdout.write(`${output}\n`);
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

/**
 * Read one run directory into the observation the projection folds.
 *
 * Every read is independent and every failure is carried, so a run with a
 * corrupt event log still reports its program, state, and slots — the partial
 * answer is exactly what an operator deciding "recoverable or stale?" needs,
 * and a single throw would have withheld all of it.
 */
async function observeRun(handle: RunDirHandle): Promise<RunInspectionObservation> {
  const authority = handle.readAuthority();
  const requests = handle.readIssuedRequests();
  const markerRejections: ObservedFact<ReadonlyMap<string, string>> = requests.ok
    ? ((): ObservedFact<ReadonlyMap<string, string>> => {
        const markers = new Map<string, string>();
        for (const authority of requests.value) {
          const rejection = handle.readCaptureRejection(authority);
          if (!rejection.ok) return unavailable(rejection.error.message);
          if (rejection.value !== null) markers.set(authority.requestId, rejection.value);
        }
        return observed(markers);
      })()
    : unavailable(requests.error.message);

  return Object.freeze({
    runId: handle.runId,
    runsRoot: handle.identity.runsRoot,
    runDirectory: handle.runDirectory,
    // The authority's CONTENT is the identity already carried above; only its
    // readability is news, so the fact's payload is deliberately empty.
    authority: authority.ok ? observed<null>(null) : unavailable<null>(authority.error.message),
    programRegistration: factOf(handle.readProgramRegistration()),
    checkpoint: await observing(() => handle.readCheckpoint(), "checkpoint"),
    requests: factOf(requests),
    capturedAttempts: factOf(handle.readCapturedAttempts()),
    markerRejections,
    events: await observing<readonly InspectedEvent[]>(() => handle.readEvents(), "event log"),
    abandonment: factOf(handle.readAbandonment()),
  });
}

async function inspectOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;
  const inspection = deriveRunInspection(await observeRun(bound.value.handle));
  process.stdout.write(`${hasFlag(args, "--json")
    ? renderRunInspectionJson(inspection)
    : renderRunInspectionHuman(inspection)}\n`);
  return { kind: "allow" };
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
  return { kind: "allow" };
}

type RegisteredPanelProgram = Readonly<{
  schemaVersion: 1;
  kind: "architecture" | "refutation";
  input: LegacyArchitecturePanelJournal["input"] | LegacyRefutationPanelJournal["input"];
  /** Exact immutable caller context from which role-specific packets derive. */
  context: unknown;
}>;

function parseRegisteredPanelProgram(raw: unknown): RegisteredPanelProgram | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 ||
      (record["kind"] !== "architecture" && record["kind"] !== "refutation") ||
      typeof record["input"] !== "object" || record["input"] === null) return null;
  const translated = translateLegacyPanelJournal(record["kind"], { input: record["input"], events: [] });
  return translated.ok
    ? Object.freeze({
        schemaVersion: 1,
        kind: record["kind"],
        input: translated.value.input,
        context: Object.hasOwn(record, "context") ? record["context"] : record["input"],
      })
    : null;
}

/**
 * The runner for effects a run directory serves ENTIRELY on its own.
 *
 * All three outside ports are unreachable by construction: an operation routed
 * here that reaches for git or protected wave state is a routing bug, and it
 * should fail loudly rather than be served. `submitOperation`'s transcript
 * capture built this same three-stub runner inline instead of calling it, so a
 * change to what "unreachable" means here would have silently missed one of the
 * two run-directory-only paths.
 */
/**
 * Record how one semantic attempt settled, keyed so a replay is a no-op.
 *
 * The dedup key is derived from the RESERVED request id and attempt (the pair
 * that names the slot on disk), while the event carries the LOGICAL request id
 * the panel program reasons about — the two differ for a retried panel attempt,
 * and both call sites had to get that pairing right independently. One function
 * now owns it, because a dedup key that drifted from the slot identity would
 * make a replayed submission mint a second outcome for the same attempt.
 */
async function appendSpawnOutcome(
  handle: RunDirHandle,
  reservedRequestId: string,
  attempt: 1 | 2,
  logicalRequestId: string,
  problem: string | null,
): Promise<void> {
  await handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `result:${createHash("sha256").update(`${reservedRequestId}:${attempt}`).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: {
      type: "spawn-outcome",
      requestId: logicalRequestId,
      attempt,
      outcome: problem === null ? "succeeded" : "failed",
      ...(problem === null ? {} : { error: problem }),
    },
  });
}

const facadeEffectRunner = (handle: RunDirHandle) => {
  const unreachablePort = async (): Promise<never> => {
    throw new Error("effect port is unreachable for this run-directory operation");
  };
  return createEffectRunner({
    handle,
    ports: {
      commitProtectedWaveState: unreachablePort,
      inspectGitRemediation: unreachablePort,
      installVerifiedIndex: unreachablePort,
    },
    resolveArtifacts: () => [],
  });
};

type MaterializedPanelRequest = Readonly<{
  request: PanelSpawnRequest;
  authority: AgentRequestAuthority;
  packet: ContextPacket;
}>;

function materializePanelRequest(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  request: PanelSpawnRequest,
): Readonly<{ ok: true; value: MaterializedPanelRequest }> | Readonly<{ ok: false; message: string }> {
  const requestId = parseRequestId(
    request.attempt === 1 ? request.id : `${request.id}:attempt-${request.attempt}`,
  );
  const slotId = parseSlotId(`slot:${createHash("sha256").update(request.id).digest("hex").slice(0, 32)}`);
  const profile = resolveModelProfile(request.modelProfile);
  const role = request.agent as keyof typeof AGENT_REQUIRED_SKILLS;
  if (!requestId.ok || !slotId.ok || !profile.ok || !Object.hasOwn(AGENT_REQUIRED_SKILLS, role)) {
    return {
      ok: false,
      message: !requestId.ok ? requestId.error.message
        : !slotId.ok ? slotId.error.message
        : !profile.ok ? profile.error.message
        : `unknown panel agent ${request.agent}`,
    };
  }
  const requiredSkill = AGENT_REQUIRED_SKILLS[role];
  const authoritySection = encodeByteSection("panel-authority", JSON.stringify({
    panel: registration.kind,
    input: registration.input,
    context: registration.context,
  }));
  if (!authoritySection.ok) return { ok: false, message: authoritySection.error.message };
  const requestSection = encodeByteSection("panel-request", JSON.stringify({
    panel: registration.kind,
    logicalRequestId: request.id,
    requestId: requestId.value,
    attempt: request.attempt,
    role: request.agent,
    outputContract: request.outputContract,
  }));
  if (!requestSection.ok) return { ok: false, message: requestSection.error.message };
  const packet = buildContextPacket({
    requestId: requestId.value,
    role: request.agent,
    requiredSkill: requiredSkill ?? "none",
    outputContract: request.outputContract,
    fixedContext: Object.freeze([authoritySection.value]),
    variableContext: Object.freeze([requestSection.value]),
  });
  if (!packet.ok) return { ok: false, message: packet.error.message };
  const outputSlot = parseFixedArtifactSlot(
    `transcripts/${slotId.value}/attempt-${request.attempt}.raw`,
  );
  if (!outputSlot.ok) return { ok: false, message: outputSlot.error.message };
  const authority = parseAgentRequestAuthority({
    runId: handle.runId,
    requestId: requestId.value,
    slotId: slotId.value,
    program: registration.kind === "architecture" ? "architecture-panel" : "refutation-panel",
    role,
    attempt: request.attempt,
    modelProfile: profile.value.id,
    harnessBinding: {
      pi: lowerModelProfile(profile.value, "pi"),
      claude: lowerModelProfile(profile.value, "claude-code"),
    },
    requiredSkill,
    contextDigest: packet.value.digest,
    outputSlot: outputSlot.value,
  });
  return authority.ok
    ? { ok: true, value: Object.freeze({ request, authority: authority.value, packet: packet.value }) }
    : { ok: false, message: authority.error.violations.map(({ message }) => message).join("; ") };
}

async function materializePanelAction(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  action: PanelProgramAction | Readonly<{ type: "await-results"; runId: string }>,
): Promise<Readonly<{ ok: true; action: unknown }> | Readonly<{ ok: false; message: string }>> {
  const panelRequests = action.type === "spawn-batch"
    ? action.requests
    : action.type === "await-user"
      ? [action.request]
      : [];
  if (panelRequests.length === 0) {
    if (action.type === "done") return { ok: true, action: Object.freeze({ kind: "done", ...action, type: undefined }) };
    if (action.type === "blocked") return { ok: true, action: Object.freeze({ kind: "blocked", runId: handle.runId, diagnostic: action }) };
    return { ok: true, action };
  }

  const materialized: MaterializedPanelRequest[] = [];
  for (const request of panelRequests) {
    const parsed = materializePanelRequest(handle, registration, request);
    if (!parsed.ok) return parsed;
    materialized.push(parsed.value);
  }
  for (const entry of materialized) {
    const published = await handle.publishContext(entry.packet);
    if (!published.ok) return { ok: false, message: published.error.message };
  }
  const effectId = parseEffectId(`effect:reserve:${createHash("sha256").update(JSON.stringify(
    materialized.map(({ authority }) => authority.requestId),
  )).digest("hex")}`);
  if (!effectId.ok) return { ok: false, message: effectId.error.message };
  const runEffect = facadeEffectRunner(handle);
  const reserved = await runEffect({
    kind: "reserve-agent-requests",
    effectId: effectId.value,
    runId: handle.runId,
    requests: materialized.map(({ authority }) => authority) as [AgentRequestAuthority, ...AgentRequestAuthority[]],
  });
  if (!reserved.ok) return { ok: false, message: reserved.error.message };

  const enriched = materialized.map(({ request, authority, packet }) => Object.freeze({
    ...request,
    authority,
    // Harness adapters execute this exact task text. The marker binds a Pi
    // batch item to one issued request without reconstructing authority from
    // role or lexical request ordering.
    task: renderSpawnTask(handle, authority, `Read the immutable context packet at LOOM_CONTEXT_PATH, then ${request.outputContract}`),
    context: Object.freeze({
      digest: packet.digest,
      slot: Object.freeze({ kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` }),
    }),
  }));
  return { ok: true, action: Object.freeze({
    kind: "spawn-batch",
    runId: handle.runId,
    requests: Object.freeze(enriched),
  }) };
}

async function nextRegisteredPanelAction(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<Readonly<{ ok: true; action: PanelProgramAction | Readonly<{ type: "await-results"; runId: string }> }> |
  Readonly<{ ok: false; message: string }>> {
  const records = await handle.readEvents();
  const translated = translateLegacyPanelJournal(registration.kind, {
    input: registration.input,
    events: records.map(({ event }) => event),
  });
  if (!translated.ok) return { ok: false, message: translated.error };

  if (translated.value.panel === "architecture") {
    let step = startArchitectureDispatchProgram(translated.value.input);
    if (!step.ok) return { ok: false, message: step.errors.join("\n") };
    for (const event of translated.value.events) {
      const reduced = reduceArchitectureProgram(step.value.state, event);
      if (!reduced.ok) return { ok: false, message: JSON.stringify(reduced.error) };
      step = { ok: true, value: reduced.value };
    }
    return { ok: true, action: step.value.action ?? { type: "await-results", runId: handle.runId } };
  }

  let step = startRefutationDispatchProgram(translated.value.input);
  if (!step.ok) return { ok: false, message: step.errors.join("\n") };
  for (const event of translated.value.events) {
    const reduced = reduceRefutationProgram(step.value.state, event);
    if (!reduced.ok) return { ok: false, message: JSON.stringify(reduced.error) };
    step = { ok: true, value: reduced.value };
  }
  return { ok: true, action: step.value.action ?? { type: "await-results", runId: handle.runId } };
}

/**
 * Drive deterministic operations internally until the program reaches a true
 * external boundary. Publication precedes the immutable success event; resume
 * safely republishes byte-identical artifacts after a publication→event crash.
 */
async function driveRegisteredPanel(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<Readonly<{ ok: true; action: unknown }> | Readonly<{ ok: false; message: string }>> {
  for (let operationCount = 0; operationCount <= 4; operationCount += 1) {
    const next = await nextRegisteredPanelAction(handle, registration);
    if (!next.ok) return next;
    if (next.action.type === "await-results") {
      const issued = handle.readIssuedRequests();
      const captured = handle.readCapturedAttempts();
      if (!issued.ok) return { ok: false, message: issued.error.message };
      if (!captured.ok) return { ok: false, message: captured.error.message };
      const pending = issued.value.filter((request) => !captured.value.has(captureKey(request.slotId, request.attempt)));
      return { ok: true, action: Object.freeze({
        kind: "spawn-batch",
        runId: handle.runId,
        requests: Object.freeze(pending.map((authority) => Object.freeze({
          authority,
          context: Object.freeze({
            digest: authority.contextDigest,
            slot: Object.freeze({ kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` }),
          }),
          task: renderSpawnTask(handle, authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending panel request."),
        }))),
      }) };
    }
    if (next.action.type !== "engine-operation") {
      return materializePanelAction(handle, registration, next.action);
    }
    const operationId = next.action.operation;
    const executed = executeDeterministicPanelOperation(handle, registration, operationId);
    if (!executed.ok) return executed;
    const published = await handle.publishArtifactSet(executed.artifacts);
    if (!published.ok) return { ok: false, message: published.error.message };
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `engine:${createHash("sha256").update(`${operationId}:succeeded`).digest("hex")}`,
      recordedAtMs: Date.now(),
      event: { type: "engine-outcome", operationId, outcome: "succeeded" },
    });
  }
  return { ok: false, message: "panel emitted more deterministic operations than its closed operation vocabulary allows" };
}

async function emitRunAction(handle: RunDirHandle, action: unknown): Promise<HookResult> {
  if (typeof action === "object" && action !== null &&
      (action as Record<string, unknown>)["kind"] === "spawn-batch" &&
      process.env.PI_CODING_AGENT === "true") {
    const sessionId = process.env.PI_SESSION_ID;
    if (sessionId === undefined) {
      return { kind: "error", message: "Pi orchestration spawn publication requires PI_SESSION_ID" };
    }
    const requests = (action as Record<string, unknown>)["requests"];
    if (!Array.isArray(requests) || requests.length === 0) {
      return { kind: "error", message: "Pi orchestration spawn action has no request authority" };
    }
    const requestIds = [];
    for (const [index, request] of requests.entries()) {
      if (typeof request !== "object" || request === null) {
        return { kind: "error", message: `Pi orchestration spawn request ${index} is malformed` };
      }
      const parsed = parseStoredAgentRequestAuthority((request as Record<string, unknown>)["authority"]);
      if (!parsed.ok) {
        return {
          kind: "error",
          message: `Pi orchestration spawn request ${index}: ${parsed.error.violations.map(({ message }) => message).join("; ")}`,
        };
      }
      if (parsed.value.runId !== handle.runId) {
        return { kind: "error", message: `Pi orchestration spawn request ${index} belongs to another run` };
      }
      requestIds.push(parsed.value.requestId);
    }
    const registered = await registerSessionRunBinding(SUBAGENT_DIR, sessionId, Object.freeze({
      runId: handle.runId,
      runsRoot: dirname(handle.runDirectory),
      runDirectory: handle.runDirectory,
      requestIds: Object.freeze(requestIds),
    }));
    if (!registered.ok) {
      return { kind: "error", message: `cannot publish Pi orchestration capture authority: ${registered.message}` };
    }
  }
  process.stdout.write(`${JSON.stringify(action, null, 2)}\n`);
  return { kind: "allow" };
}

const START_PROGRAMS = ["architecture", "refutation", "standalone-review", "wave-gate", "remediation"] as const;
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
  | Readonly<{ kind: "remediation"; input: RegisteredRemediationProgram["input"] }>
  | Readonly<{ kind: "wave-gate"; input: RegisteredWaveGateProgram["input"] }>
  | Readonly<{ kind: "panel"; registration: RegisteredPanelProgram }>;

function parseStartRequest(program: StartProgram, stdin: string): ProgramParse<StartRequest> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
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
  const registration: RegisteredPanelProgram = Object.freeze({
    schemaVersion: 1,
    kind: program,
    input: translated.value.input,
    context: raw,
  });
  return { ok: true, value: Object.freeze({ kind: "panel", registration }) };
}

const driveStart = (handle: RunDirHandle, request: StartRequest): Promise<FacadeDriveResult> =>
  match(request)
    .with({ kind: "standalone-review" }, ({ input }) => startStandaloneFacade(handle, input))
    .with({ kind: "remediation" }, ({ input }) => startRemediationFacade(handle, input))
    .with({ kind: "wave-gate" }, ({ input }) => startWaveGateFacade(handle, input))
    .with({ kind: "panel" }, async ({ registration }) => {
      const registered = await handle.registerProgram(registration);
      return registered.ok
        ? driveRegisteredPanel(handle, registration)
        : { ok: false as const, message: registered.error.message };
    })
    .exhaustive();

async function startOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const program = args[0];
  if (!isStartProgram(program)) {
    return { kind: "error", message: `start requires ${START_PROGRAMS.join(", ")}` };
  }
  const request = parseStartRequest(program, stdin);
  if (!request.ok) return { kind: "error", message: request.message };
  const bound = bindLiveRun(args.slice(1), createRunDirectory);
  if (!isBound(bound)) return bound;
  const driven = await driveStart(bound.value.handle, request.value);
  if (!driven.ok) return { kind: "error", message: driven.message };
  return emitRunAction(bound.value.handle, driven.action);
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
 * Fold every captured-but-unsettled panel attempt into a `spawn-outcome` event.
 *
 * A transcript can be captured into its reserved slot without the program yet
 * having judged it — the capture and the judgement are separate writes. This
 * replays each such attempt through `panelSubmissionProblem` and records the
 * verdict, keyed so a repeat is a no-op. It decides no policy of its own.
 */
async function reconcileCapturedPanelResults(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>> {
  const events = await handle.readEvents();
  const settled = new Set(events.flatMap(({ event }) => {
    if (typeof event !== "object" || event === null) return [];
    const record = event as Record<string, unknown>;
    return record["type"] === "spawn-outcome" && typeof record["requestId"] === "string" &&
      (record["attempt"] === 1 || record["attempt"] === 2)
      ? [`${record["requestId"]}:${record["attempt"]}`]
      : [];
  }));
  const issued = handle.readIssuedRequests();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return { ok: false, message: captured.error.message };

  for (const request of issued.value) {
    if (!captured.value.has(captureKey(request.slotId, request.attempt))) continue;
    const logicalRequestId = logicalPanelRequestId(request.requestId, request.attempt);
    if (settled.has(`${logicalRequestId}:${request.attempt}`)) continue;
    const bytes = handle.readTranscriptBytes(request);
    if (!bytes.ok) return { ok: false, message: bytes.error.message };
    const problem = panelSubmissionProblem(
      registration,
      logicalRequestId,
      Buffer.from(bytes.value).toString("utf-8"),
    );
    await appendSpawnOutcome(handle, request.requestId, request.attempt, logicalRequestId, problem);
  }
  return { ok: true };
}

/**
 * Resume is idempotent and never silently spawns or decides policy: it reports
 * what the run's durable evidence already says. A run whose authority cannot
 * be read is reported as such rather than restarted, because restarting would
 * discard the very evidence that explains the failure.
 */
async function resumeOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return bound;

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };
  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  if (stored.value !== null) {
    const facadeParse = parseRegisteredFacadeProgram(stored.value);
    if (facadeParse.kind === "invalid") {
      return { kind: "error", message: `registered orchestration program is invalid: ${facadeParse.message}` };
    }
    if (facadeParse.kind === "registered") {
      const facadeRegistration = facadeParse.program;
      const driven = facadeRegistration.kind === "standalone-review"
        ? await resumeStandaloneFacade(bound.value.handle, facadeRegistration)
        : facadeRegistration.kind === "remediation"
          ? await resumeRemediationFacade(bound.value.handle, facadeRegistration)
          : await resumeWaveGateFacade(bound.value.handle, facadeRegistration);
      if (!driven.ok) return { kind: "error", message: driven.message };
      return emitRunAction(bound.value.handle, driven.action);
    }
    const registration = parseRegisteredPanelProgram(stored.value);
    if (registration === null) return { kind: "error", message: "registered orchestration program is malformed" };
    const reconciled = await reconcileCapturedPanelResults(bound.value.handle, registration);
    if (!reconciled.ok) return { kind: "error", message: reconciled.message };
    const driven = await driveRegisteredPanel(bound.value.handle, registration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }

  // Historical run without a program registration: retain the read-only v1
  // compatibility response, but never manufacture lifecycle progress.
  process.stdout.write(`${JSON.stringify({
    kind: "resumed",
    runId: authority.value.runId,
    runDirectory: authority.value.runDirectory,
  }, null, 2)}\n`);
  return { kind: "allow" };
}

function logicalPanelRequestId(requestId: string, attempt: 1 | 2): string {
  return attempt === 2 && requestId.endsWith(":attempt-2")
    ? requestId.slice(0, -":attempt-2".length)
    : requestId;
}

function panelSubmissionProblem(
  registration: RegisteredPanelProgram,
  logicalRequestId: string,
  raw: string,
): string | null {
  if (registration.kind === "refutation") {
    const match = /^refutation:verifier:(\d+)$/.exec(logicalRequestId);
    const input = registration.input as LegacyRefutationPanelJournal["input"];
    const index = match === null ? -1 : Number(match[1]) - 1;
    const lens = input.lenses[index];
    if (lens === undefined) return `request ${logicalRequestId} is not a canonical verifier slot`;
    const parsed = parseRefutationVerdict(raw, lens, input.criticalFindingIds);
    return parsed.ok ? null : parsed.errors.join("; ");
  }

  const input = registration.input as LegacyArchitecturePanelJournal["input"];
  const candidateMatch = /^architecture:candidate:(\d+)$/.exec(logicalRequestId);
  if (candidateMatch !== null) {
    const index = Number(candidateMatch[1]) - 1;
    const lens = input.candidateLenses[index];
    if (lens === undefined) return `request ${logicalRequestId} is not a canonical candidate slot`;
    const parsed = parseArchitectureCandidate(raw, lens);
    return parsed.ok ? null : parsed.errors.join("; ");
  }

  const judgeMatch = /^architecture:judge:(\d+)$/.exec(logicalRequestId);
  if (judgeMatch !== null) {
    const criterion = input.judgeCriteria[Number(judgeMatch[1]) - 1];
    if (criterion === undefined) return `request ${logicalRequestId} is not a canonical judge slot`;
    const verdict = parseJudgeVerdict(raw, criterion, input.candidateLenses.map(candidateFilename));
    return verdict.ok ? null : verdict.errors.join("; ");
  }

  if (logicalRequestId === "architecture:finalize") {
    const parsed = parseArchitectureFinalization(raw, input.candidateLenses.map(candidateFilename));
    return parsed.ok ? null : parsed.errors.join("; ");
  }

  return `request ${logicalRequestId} is not a canonical architecture result slot`;
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
async function submitOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return bound;

  const requestId = argumentValue(args, "--request");
  const slotId = argumentValue(args, "--slot");
  const attempt = argumentValue(args, "--attempt");
  if (requestId === null || slotId === null || (attempt !== "1" && attempt !== "2")) {
    return { kind: "error", message: "--request, --slot, and --attempt (1 or 2) are required" };
  }

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };

  const issued = bound.value.handle.readIssuedRequests();
  if (!issued.ok) return { kind: "error", message: issued.error.message };
  const reserved = issued.value.find((request) => request.requestId === requestId);
  if (reserved === undefined) {
    return { kind: "error", message: `request ${requestId} was never reserved in this run` };
  }
  if (reserved.slotId !== slotId || String(reserved.attempt) !== attempt) {
    return {
      kind: "error",
      message: `request ${requestId} is reserved for slot ${reserved.slotId} attempt ${reserved.attempt}, not ${slotId} attempt ${attempt}`,
    };
  }

  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  const facadeParse = stored.value === null ? null : parseRegisteredFacadeProgram(stored.value);
  if (facadeParse?.kind === "invalid") {
    return { kind: "error", message: `registered orchestration program is invalid: ${facadeParse.message}` };
  }
  const facadeRegistration = facadeParse?.kind === "registered" ? facadeParse.program : null;
  const registration = stored.value === null ? null : parseRegisteredPanelProgram(stored.value);
  if (stored.value !== null && registration === null && facadeRegistration === null) {
    return { kind: "error", message: "registered orchestration program is malformed" };
  }

  const attempts = bound.value.handle.readCapturedAttempts();
  if (!attempts.ok) return { kind: "error", message: attempts.error.message };
  const alreadyCaptured = attempts.value.has(captureKey(reserved.slotId, reserved.attempt));
  let semanticRaw = stdin;
  let capturedArtifact: unknown = null;

  // Every registration kind reads its semantics off the stored bytes when the
  // slot already holds them. This branch was added for the legacy panel path
  // alone, so a façade run — the only kind an auto-capturing harness produces —
  // fell through to a capture that could only fail on its own exclusive write.
  if (alreadyCaptured) {
    const existing = bound.value.handle.readTranscriptBytes(reserved);
    if (!existing.ok) return { kind: "error", message: existing.error.message };
    semanticRaw = Buffer.from(existing.value).toString("utf-8");
  } else {
    const effectId = parseEffectId(`effect:capture:${createHash("sha256").update(`${requestId}:${attempt}`).digest("hex")}`);
    if (!effectId.ok) return { kind: "error", message: effectId.error.message };
    const captureIntent: Extract<EffectIntent, { kind: "capture-raw-transcript" }> = {
      kind: "capture-raw-transcript",
      effectId: effectId.value,
      runId: reserved.runId,
      request: reserved,
      bytes: [...Buffer.from(stdin, "utf-8")],
    };
    const captured = await facadeEffectRunner(bound.value.handle)(captureIntent);
    if (!captured.ok) return { kind: "error", message: captured.error.message };
    if (captured.value.kind !== "raw-transcript-captured") {
      return { kind: "error", message: "transcript capture reconciled to the wrong receipt kind" };
    }
    capturedArtifact = captured.value;
  }

  if (facadeRegistration?.kind === "standalone-review") {
    const driven = await resumeStandaloneFacade(bound.value.handle, facadeRegistration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }
  if (facadeRegistration?.kind === "wave-gate") {
    if (reserved.program === "wave-gate") {
      const applied = await applyWaveFacadeSubmission(bound.value.handle, reserved, semanticRaw);
      if (!applied.ok) return { kind: "error", message: applied.message };
    }
    const driven = await resumeWaveGateFacade(bound.value.handle, facadeRegistration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }

  if (registration !== null) {
    const numericAttempt = Number(attempt) as 1 | 2;
    const logicalRequestId = logicalPanelRequestId(requestId, numericAttempt);
    const problem = panelSubmissionProblem(registration, logicalRequestId, semanticRaw);
    await appendSpawnOutcome(bound.value.handle, requestId, numericAttempt, logicalRequestId, problem);
    const driven = await driveRegisteredPanel(bound.value.handle, registration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }

  // An unregistered run has no action to emit, so the confirmation IS the
  // output — and it names which of the two outcomes happened rather than
  // reporting a captured artifact that, on the idempotent path, is null.
  process.stdout.write(`${JSON.stringify(alreadyCaptured
    ? { kind: "already-captured", requestId, slotId: reserved.slotId, attempt: reserved.attempt }
    : { kind: "captured", requestId, artifact: capturedArtifact }, null, 2)}\n`);
  return { kind: "allow" };
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

type DeterministicOperationArtifact = Readonly<{ relativePath: string; bytes: readonly number[] }>;

function operationArtifact(relativePath: string, value: unknown): DeterministicOperationArtifact {
  return Object.freeze({
    relativePath,
    bytes: Object.freeze([...Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8")]),
  });
}

function capturedPanelRaw(
  handle: RunDirHandle,
  logicalRequestId: string,
): Readonly<{ ok: true; raw: string }> | Readonly<{ ok: false; message: string }> {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return { ok: false, message: captured.error.message };
  const candidates = issued.value
    .filter((request) => logicalPanelRequestId(request.requestId, request.attempt) === logicalRequestId &&
      captured.value.has(captureKey(request.slotId, request.attempt)))
    .sort((left, right) => right.attempt - left.attempt);
  const request = candidates[0];
  if (request === undefined) return { ok: false, message: `operation is missing captured result for ${logicalRequestId}` };
  const bytes = handle.readTranscriptBytes(request);
  return bytes.ok
    ? { ok: true, raw: Buffer.from(bytes.value).toString("utf-8") }
    : { ok: false, message: bytes.error.message };
}

function executeDeterministicPanelOperation(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  operationId: string,
): Readonly<{ ok: true; artifacts: readonly DeterministicOperationArtifact[] }> |
  Readonly<{ ok: false; message: string }> {
  if (registration.kind === "refutation") {
    const input = registration.input as LegacyRefutationPanelJournal["input"];
    if (operationId === "refutation-prepare-verifiers") {
      return {
        ok: true,
        artifacts: Object.freeze([operationArtifact("operations/refutation-prepare-verifiers.json", {
          schemaVersion: 1, runId: handle.runId, findingIds: input.criticalFindingIds, lenses: input.lenses,
        })]),
      };
    }
    if (operationId !== "refutation-tally") {
      return { ok: false, message: `unsupported refutation operation ${operationId}` };
    }
    const verdicts: VerdictEnvelope<RefutationVerdict>[] = [];
    for (let index = 0; index < input.lenses.length; index += 1) {
      const logicalRequestId = `refutation:verifier:${index + 1}`;
      const captured = capturedPanelRaw(handle, logicalRequestId);
      if (!captured.ok) return captured;
      const parsed = parseRefutationVerdict(captured.raw, input.lenses[index]!, input.criticalFindingIds);
      if (!parsed.ok) return { ok: false, message: parsed.errors.join("; ") };
      verdicts.push(parsed.value);
    }
    // The threshold formula and the k-of-n rule are DOMAIN rules and live in
    // the core (`defaultRefutationThreshold` / `countRefutationVotes`), which
    // the persistent panel path already delegates to. This branch used to
    // reimplement both inline, so the same votes could be adjudicated two ways
    // by two code paths with nothing to keep them in step.
    const threshold = defaultRefutationThreshold(input.lenses.length);
    const outcomes = input.criticalFindingIds.map((findingId) => {
      const judgements = verdicts.map((verdict, index) => Object.freeze({
        lens: input.lenses[index]!,
        entry: verdict.entries.find((entry) => entry.findingId === findingId)!,
      }));
      const tallied = countRefutationVotes(judgements, threshold);
      return Object.freeze({
        finding_id: findingId,
        survives: tallied.survives,
        refuted_by: Object.freeze(tallied.refutations.map(({ lens }) => lens)),
        votes: Object.freeze(judgements.map(({ lens, entry }) => Object.freeze({ lens, vote: entry }))),
      });
    });
    const result = Object.freeze({
      schemaVersion: 1,
      kind: "refutation-panel-result",
      runId: handle.runId,
      lenses: input.lenses,
      threshold,
      outcomes: Object.freeze(outcomes),
    });
    return {
      ok: true,
      artifacts: Object.freeze([
        operationArtifact("operations/refutation-tally.json", result),
        operationArtifact("result.json", result),
      ]),
    };
  }

  const input = registration.input as LegacyArchitecturePanelJournal["input"];
  const candidates = input.candidateLenses.map(candidateFilename);
  if (operationId === "architecture-prepare-candidates") {
    return {
      ok: true,
      artifacts: Object.freeze([operationArtifact("operations/architecture-prepare-candidates.json", {
        schemaVersion: 1, runId: handle.runId, lenses: input.candidateLenses, candidates,
      })]),
    };
  }
  if (operationId === "architecture-prepare-judges") {
    const accepted = [];
    for (let index = 0; index < input.candidateLenses.length; index += 1) {
      const captured = capturedPanelRaw(handle, `architecture:candidate:${index + 1}`);
      if (!captured.ok) return captured;
      const problem = panelSubmissionProblem(registration, `architecture:candidate:${index + 1}`, captured.raw);
      if (problem !== null) return { ok: false, message: problem };
      accepted.push(JSON.parse(captured.raw) as unknown);
    }
    return {
      ok: true,
      artifacts: Object.freeze([operationArtifact("operations/architecture-prepare-judges.json", {
        schemaVersion: 1, candidates: accepted, criteria: input.judgeCriteria,
      })]),
    };
  }
  if (operationId === "architecture-aggregate") {
    const verdicts: JudgeVerdict[] = [];
    for (let index = 0; index < input.judgeCriteria.length; index += 1) {
      const captured = capturedPanelRaw(handle, `architecture:judge:${index + 1}`);
      if (!captured.ok) return captured;
      const parsed = parseJudgeVerdict(captured.raw, input.judgeCriteria[index]!, candidates);
      if (!parsed.ok) return { ok: false, message: parsed.errors.join("; ") };
      verdicts.push(parsed.value);
    }
    const ranking = aggregateVerdicts(verdicts, input.judgeCriteria, candidates);
    if (!ranking.ok) return { ok: false, message: ranking.errors.join("; ") };
    return {
      ok: true,
      artifacts: Object.freeze([
        operationArtifact("operations/architecture-aggregate.json", {
          schemaVersion: 1, kind: "architecture-ranking", runId: handle.runId, ranking: ranking.value,
        }),
        operationArtifact("ranking.json", ranking.value),
      ]),
    };
  }
  return { ok: false, message: `unsupported architecture operation ${operationId}` };
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
async function decideOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const bound = bindLiveRun(args);
  if (!isBound(bound)) return bound;

  const registered = bound.value.handle.readProgramRegistration();
  if (!registered.ok) return { kind: "error", message: registered.error.message };
  const registeredParse = registered.value === null ? null : parseRegisteredFacadeProgram(registered.value);
  if (registeredParse?.kind === "invalid") {
    return { kind: "error", message: `registered orchestration program is invalid: ${registeredParse.message}` };
  }
  const facadeRegistration = registeredParse?.kind === "registered" ? registeredParse.program : null;
  if (registered.value !== null && facadeRegistration?.kind !== "wave-gate") {
    return { kind: "error", message: "this registered program does not accept user decisions" };
  }

  const decisionId = argumentValue(args, "--request");
  if (decisionId === null) return { kind: "error", message: "--request <decision-id> is required" };
  if (facadeRegistration?.kind === "wave-gate") {
    let graphRaw: unknown;
    try { graphRaw = JSON.parse(readFileSync(TASK_GRAPH_PATH, "utf8")) as unknown; }
    catch (error) { return { kind: "error", message: `cannot read protected Wave authority: ${error instanceof Error ? error.message : String(error)}` }; }
    const graph = parseTaskGraph(graphRaw);
    if (!graph.ok) return { kind: "error", message: `protected Wave authority is invalid: ${graph.error}` };
    const mismatch = waveGateDecisionMismatch(
      graph.value, facadeRegistration, bound.value.handle.runId, decisionId,
    );
    if (mismatch !== null) return { kind: "error", message: mismatch };
  }
  if (stdin.trim().length === 0) return { kind: "error", message: "a decision must be supplied on stdin" };

  const decision = ((): unknown => {
    try {
      return JSON.parse(stdin) as unknown;
    } catch (error) {
      return { __malformed: error instanceof Error ? error.message : String(error) };
    }
  })();
  if (typeof decision !== "object" || decision === null || Array.isArray(decision) ||
      typeof (decision as Record<string, unknown>)["__malformed"] === "string") {
    return { kind: "error", message: "decision must be a JSON object" };
  }
  if (facadeRegistration?.kind === "wave-gate" && (
    Object.keys(decision).length !== 1 || (decision as Record<string, unknown>).kind !== "approve"
  )) {
    return { kind: "error", message: "Wave advisory decision must be exactly {\"kind\":\"approve\"}" };
  }

  await bound.value.handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `decision:${createHash("sha256").update(decisionId).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: { kind: "user-decision-recorded", decisionId, decision },
  });

  if (facadeRegistration?.kind === "wave-gate") {
    const driven = await resumeWaveGateFacade(bound.value.handle, facadeRegistration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
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
      return statusOperation(rest);
    case "inspect":
      return inspectOperation(rest);
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
  }
};

export default handler;
