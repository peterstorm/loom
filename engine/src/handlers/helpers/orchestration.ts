/**
 * Orchestration façade — one deep interface for the parent.
 *
 * Usage:
 *   helper orchestration status [--json] [--wave N]
 *   helper orchestration start <architecture|refutation|standalone-review|wave-gate|remediation> --run <run-directory>
 *                              --runs-root <root> < program.json
 *   helper orchestration resume --run <run-directory> --runs-root <root>
 *   helper orchestration submit --run <run-directory> --runs-root <root>
 *                               --request <request-id> --slot <slot-id>
 *                               --attempt <1|2>   (raw bytes on stdin)
 *   helper orchestration correlate --run <run-directory> --runs-root <root>
 *                                  --request <request-id> --harness <pi|claude>
 *                                  --native-id <harness-native-id> --agent <role>
 *   helper orchestration decide --run <run-directory> --runs-root <root>
 *                               --request <decision-id>   (decision on stdin)
 *
 * Each mutating call parses authority, applies at most one event or receipt
 * reconciliation, persists it, and returns exactly one external action. The
 * parent therefore never assembles an action itself, and never has to know
 * which program produced it.
 *
 * `status` is a pure read: it derives ONE `LoomStatus` value and hands it to
 * a renderer. Both renderers project that same value, so the human and JSON
 * forms cannot disagree — neither contains readiness or action policy, and
 * neither re-runs a gate check. If authority cannot be parsed, every fact
 * category is still present as `unavailable` and the sole action is `blocked`,
 * rather than fabricated zero-or-ready values.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SUBAGENT_DIR, TASK_GRAPH_PATH } from "../../config";
import { parseTaskGraph } from "../../state-manager";
import type { HookHandler, HookResult } from "../../types";
import {
  deriveLoomStatusFromParsedGraph,
  renderLoomStatusHuman,
  renderLoomStatusJson,
  type GateDeps,
} from "../../core/wave-gate-machine";
import { loadPlanModelsSource } from "./complete-wave-gate";
import { openRunDirectory, type RunDirHandle } from "../../orchestration/run-directory-handle";
import { registerSessionRunBinding } from "../../orchestration/session-run-bindings";
import {
  AGENT_REQUIRED_SKILLS,
  parseAgentRequestAuthority,
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
import { parseRefutationVerdict, type RefutationVerdict } from "../../core/review-panel";
import { aggregateVerdicts, candidateFilename, parseJudgeVerdict, type JudgeVerdict } from "../../core/panel-contract";
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
  resumeRemediationFacade,
  resumeStandaloneFacade,
  resumeWaveGateFacade,
  startRemediationFacade,
  startStandaloneFacade,
  startWaveGateFacade,
  waveAdvisoryDecisionRequestId,
} from "./orchestration-programs";

const OPERATIONS = ["status", "start", "resume", "submit", "correlate", "complete", "decide"] as const;
type Operation = (typeof OPERATIONS)[number];

const isOperation = (value: string | undefined): value is Operation =>
  value !== undefined && (OPERATIONS as readonly string[]).includes(value);

function usage(): HookResult {
  return {
    kind: "error",
    message: [
      "Usage: bun cli.ts helper orchestration <operation> [flags]",
      "",
      "  status  [--json] [--wave N]",
      "  start   <architecture|refutation|standalone-review|wave-gate|remediation> --runs-root <root> --run <run-directory> < program.json",
      "  resume  --runs-root <root> --run <run-directory>",
      "  submit  --runs-root <root> --run <run-directory> --request <id> --slot <id> --attempt <1|2>",
      "  correlate --runs-root <root> --run <run-directory> --request <id> --harness <pi|claude> --native-id <id> --agent <role>",
      "  complete --runs-root <root> --run <run-directory> --operation <id>",
      "  decide  --runs-root <root> --run <run-directory> --request <decision-id>",
    ].join("\n"),
  };
}

function flag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const hasFlag = (args: readonly string[], name: string): boolean => args.includes(`--${name}`);

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
): string {
  const parsed = parseTaskGraph(rawGraph);
  const status = deriveLoomStatusFromParsedGraph(parsed, deps);
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

function statusOperation(args: readonly string[]): HookResult {
  const output = renderStatus(readGraph(TASK_GRAPH_PATH), productionGateDeps, hasFlag(args, "json"));
  process.stdout.write(`${output}\n`);
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Run-bound operations
// ---------------------------------------------------------------------------

type RunBinding = Readonly<{ handle: RunDirHandle }>;

/**
 * Bind to one anchored run directory. Both the runs-root and the run
 * directory are required: the handle proves the run is a direct child of the
 * root it claims, which is what stops a caller naming an arbitrary path.
 */
function bindRun(args: readonly string[]): Readonly<{ ok: true; value: RunBinding }> | HookResult {
  const runsRoot = flag(args, "runs-root");
  const runDirectory = flag(args, "run");
  if (runsRoot === null || runDirectory === null) {
    return { kind: "error", message: "both --runs-root and --run are required" };
  }
  const opened = openRunDirectory(runsRoot, runDirectory);
  return opened.ok
    ? { ok: true, value: { handle: opened.value } }
    : { kind: "error", message: `cannot bind run directory: ${opened.error.message}` };
}

const isBound = (
  value: Readonly<{ ok: true; value: RunBinding }> | HookResult,
): value is Readonly<{ ok: true; value: RunBinding }> => "ok" in value;

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
    task: `LOOM_REQUEST_ID: ${authority.requestId}\nLOOM_CONTEXT_DIGEST: ${packet.digest}\n${request.outputContract}`,
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
          task: `LOOM_REQUEST_ID: ${authority.requestId}\nLOOM_CONTEXT_DIGEST: ${authority.contextDigest}\nComplete the exact pending panel request.`,
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
      const parsed = parseAgentRequestAuthority((request as Record<string, unknown>)["authority"]);
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

async function startOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const program = args[0];
  if (program !== "architecture" && program !== "refutation" && program !== "standalone-review" &&
      program !== "wave-gate" && program !== "remediation") {
    return { kind: "error", message: "start requires architecture, refutation, standalone-review, wave-gate, or remediation" };
  }
  const bound = bindRun(args.slice(1));
  if (!isBound(bound)) return bound;
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    return { kind: "error", message: `program input is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (program === "standalone-review") {
    const parsed = parseStandaloneStartInput(raw);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    const driven = await startStandaloneFacade(bound.value.handle, parsed.value);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }
  if (program === "remediation") {
    const parsed = parseRemediationStartInput(raw);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    const driven = await startRemediationFacade(bound.value.handle, parsed.value);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }
  if (program === "wave-gate") {
    const parsed = parseWaveGateStartInput(raw);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    const driven = await startWaveGateFacade(bound.value.handle, parsed.value);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }
  const panel = program;
  const translated = translateLegacyPanelJournal(panel, raw);
  if (!translated.ok) return { kind: "error", message: translated.error };
  if (translated.value.events.length !== 0) {
    return { kind: "error", message: "a fresh orchestration start cannot import pre-existing events" };
  }
  const registration: RegisteredPanelProgram = Object.freeze({
    schemaVersion: 1,
    kind: panel,
    input: translated.value.input,
    context: raw,
  });
  const registered = await bound.value.handle.registerProgram(registration);
  if (!registered.ok) return { kind: "error", message: registered.error.message };
  const driven = await driveRegisteredPanel(bound.value.handle, registration);
  if (!driven.ok) return { kind: "error", message: driven.message };
  return emitRunAction(bound.value.handle, driven.action);
}

/**
 * Resume is idempotent and never silently spawns or decides policy: it reports
 * what the run's durable evidence already says. A run whose authority cannot
 * be read is reported as such rather than restarted, because restarting would
 * discard the very evidence that explains the failure.
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
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `result:${createHash("sha256").update(`${request.requestId}:${request.attempt}`).digest("hex")}`,
      recordedAtMs: Date.now(),
      event: {
        type: "spawn-outcome",
        requestId: logicalRequestId,
        attempt: request.attempt,
        outcome: problem === null ? "succeeded" : "failed",
        ...(problem === null ? {} : { error: problem }),
      },
    });
  }
  return { ok: true };
}

async function resumeOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };
  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  if (stored.value !== null) {
    const facadeRegistration = parseRegisteredFacadeProgram(stored.value);
    if (facadeRegistration !== null) {
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
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "architecture candidate must be a JSON object";
      }
      const record = value as Record<string, unknown>;
      const expectedCandidate = candidateFilename(lens);
      return record["lens"] === lens && record["candidate"] === expectedCandidate &&
        typeof record["artifact"] === "string" && record["artifact"].trim().length > 0
        ? null
        : `architecture candidate must bind lens ${lens}, candidate ${expectedCandidate}, and a non-empty artifact`;
    } catch (error) {
      return `architecture candidate is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const judgeMatch = /^architecture:judge:(\d+)$/.exec(logicalRequestId);
  if (judgeMatch !== null) {
    const criterion = input.judgeCriteria[Number(judgeMatch[1]) - 1];
    if (criterion === undefined) return `request ${logicalRequestId} is not a canonical judge slot`;
    const verdict = parseJudgeVerdict(raw, criterion, input.candidateLenses.map(candidateFilename));
    return verdict.ok ? null : verdict.errors.join("; ");
  }

  if (logicalRequestId === "architecture:finalize") {
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "architecture finalization must be a JSON object";
      }
      const record = value as Record<string, unknown>;
      const candidates = new Set(input.candidateLenses.map(candidateFilename));
      return typeof record["selectedCandidate"] === "string" && candidates.has(record["selectedCandidate"] as never) &&
        typeof record["planArtifact"] === "string" && record["planArtifact"].trim().length > 0
        ? null
        : "architecture finalization must select a canonical candidate and name a non-empty plan artifact";
    } catch (error) {
      return `architecture finalization is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return `request ${logicalRequestId} is not a canonical architecture result slot`;
}

/**
 * Accept one semantic result's exact bytes into its reserved transcript slot.
 *
 * The bytes arrive on stdin and are written verbatim — never trimmed, joined,
 * or re-encoded — so the stored artifact is byte-identical to what the harness
 * produced. The slot is exclusive, so a duplicate or late submission for an
 * attempt that already landed is refused rather than allowed to overwrite
 * accepted evidence.
 */
async function submitOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const requestId = flag(args, "request");
  const slotId = flag(args, "slot");
  const attempt = flag(args, "attempt");
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
  const facadeRegistration = stored.value === null ? null : parseRegisteredFacadeProgram(stored.value);
  const registration = stored.value === null ? null : parseRegisteredPanelProgram(stored.value);
  if (stored.value !== null && registration === null && facadeRegistration === null) {
    return { kind: "error", message: "registered orchestration program is malformed" };
  }

  const attempts = bound.value.handle.readCapturedAttempts();
  if (!attempts.ok) return { kind: "error", message: attempts.error.message };
  const alreadyCaptured = attempts.value.has(captureKey(reserved.slotId, reserved.attempt));
  let semanticRaw = stdin;
  let capturedArtifact: unknown = null;

  if (alreadyCaptured && registration !== null) {
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
    const unreachablePort = async (): Promise<never> => { throw new Error("effect port is unreachable for transcript capture"); };
    const runEffect = createEffectRunner({
      handle: bound.value.handle,
      ports: {
        commitProtectedWaveState: unreachablePort,
        inspectGitRemediation: unreachablePort,
        installVerifiedIndex: unreachablePort,
      },
      resolveArtifacts: () => [],
    });
    const captured = await runEffect(captureIntent);
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
    await bound.value.handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `result:${createHash("sha256").update(`${requestId}:${attempt}`).digest("hex")}`,
      recordedAtMs: Date.now(),
      event: {
        type: "spawn-outcome",
        requestId: logicalRequestId,
        attempt: numericAttempt,
        outcome: problem === null ? "succeeded" : "failed",
        ...(problem === null ? {} : { error: problem }),
      },
    });
    const driven = await driveRegisteredPanel(bound.value.handle, registration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    return emitRunAction(bound.value.handle, driven.action);
  }

  process.stdout.write(`${JSON.stringify({
    kind: "captured",
    requestId,
    artifact: capturedArtifact,
  }, null, 2)}\n`);
  return { kind: "allow" };
}

async function correlateOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;
  const requestId = flag(args, "request");
  const harness = flag(args, "harness");
  const nativeId = flag(args, "native-id");
  if (requestId === null || (harness !== "pi" && harness !== "claude") || nativeId === null) {
    return { kind: "error", message: "--request, --harness (pi or claude), and --native-id are required" };
  }
  const issued = bound.value.handle.readIssuedRequests();
  if (!issued.ok) return { kind: "error", message: issued.error.message };
  const request = issued.value.find((candidate) => candidate.requestId === requestId);
  if (request === undefined) return { kind: "error", message: `request ${requestId} was never reserved in this run` };
  const agent = flag(args, "agent");
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
    const threshold = Math.floor(input.lenses.length / 2) + 1;
    const outcomes = input.criticalFindingIds.map((findingId) => {
      const votes = verdicts.map((verdict, index) => Object.freeze({
        lens: input.lenses[index]!,
        vote: verdict.entries.find((entry) => entry.findingId === findingId)!,
      }));
      const refutations = votes.filter(({ vote }) => vote.verdict === "refuted");
      return Object.freeze({
        finding_id: findingId,
        survives: refutations.length < threshold,
        refuted_by: Object.freeze(refutations.map(({ lens }) => lens)),
        votes: Object.freeze(votes),
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
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;
  const operationId = flag(args, "operation");
  if (operationId === null) {
    return { kind: "error", message: "--operation is required" };
  }
  if (flag(args, "outcome") !== null || flag(args, "error") !== null) {
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
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const registered = bound.value.handle.readProgramRegistration();
  if (!registered.ok) return { kind: "error", message: registered.error.message };
  const facadeRegistration = registered.value === null ? null : parseRegisteredFacadeProgram(registered.value);
  if (registered.value !== null && facadeRegistration?.kind !== "wave-gate") {
    return { kind: "error", message: "this registered program does not accept user decisions" };
  }

  const decisionId = flag(args, "request");
  if (decisionId === null) return { kind: "error", message: "--request <decision-id> is required" };
  if (facadeRegistration?.kind === "wave-gate") {
    let graphRaw: unknown;
    try { graphRaw = JSON.parse(readFileSync(TASK_GRAPH_PATH, "utf8")) as unknown; }
    catch (error) { return { kind: "error", message: `cannot read protected Wave authority: ${error instanceof Error ? error.message : String(error)}` }; }
    const graph = parseTaskGraph(graphRaw);
    if (!graph.ok) return { kind: "error", message: `protected Wave authority is invalid: ${graph.error}` };
    if (graph.value.active_wave_gate?.runId !== bound.value.handle.runId ||
        graph.value.active_wave_gate.wave !== facadeRegistration.input.wave ||
        graph.value.active_wave_gate.authorityDigest !== facadeRegistration.authorityDigest) {
      return { kind: "error", message: "protected active Wave Gate authority differs from this decision run" };
    }
    const expectedDecisionId = waveAdvisoryDecisionRequestId(
      bound.value.handle.runId,
      graph.value.tasks.filter(({ id }) => facadeRegistration.taskIds.includes(id)),
    );
    if (decisionId !== expectedDecisionId) {
      return { kind: "error", message: `decision request ${decisionId} is not the exact pending advisory request ${expectedDecisionId}` };
    }
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
    case "start":
      return startOperation(stdin, rest);
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
