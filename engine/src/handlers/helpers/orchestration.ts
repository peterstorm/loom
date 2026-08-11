/**
 * Orchestration façade — one deep interface for the parent.
 *
 * Usage:
 *   helper orchestration status [--json] [--wave N]
 *   helper orchestration start <architecture|refutation> --run <run-directory>
 *                              --runs-root <root> < program.json
 *   helper orchestration resume --run <run-directory> --runs-root <root>
 *   helper orchestration submit --run <run-directory> --runs-root <root>
 *                               --request <request-id> --slot <slot-id>
 *                               --attempt <1|2>   (raw bytes on stdin)
 *   helper orchestration correlate --run <run-directory> --runs-root <root>
 *                                  --request <request-id> --harness <pi|claude>
 *                                  --native-id <harness-native-id>
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
import { existsSync } from "node:fs";
import { TASK_GRAPH_PATH } from "../../config";
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
import { readFileSync } from "node:fs";
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
import { createEffectRunner } from "../../orchestration/effect-runner";
import {
  translateLegacyPanelJournal,
  type LegacyArchitecturePanelJournal,
  type LegacyRefutationPanelJournal,
} from "./panel-program";

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
      "  start   <architecture|refutation> --runs-root <root> --run <run-directory> < program.json",
      "  resume  --runs-root <root> --run <run-directory>",
      "  submit  --runs-root <root> --run <run-directory> --request <id> --slot <id> --attempt <1|2>",
      "  correlate --runs-root <root> --run <run-directory> --request <id> --harness <pi|claude> --native-id <id>",
      "  complete --runs-root <root> --run <run-directory> --operation <id> --outcome <succeeded|failed>",
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
}>;

function parseRegisteredPanelProgram(raw: unknown): RegisteredPanelProgram | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 ||
      (record["kind"] !== "architecture" && record["kind"] !== "refutation") ||
      typeof record["input"] !== "object" || record["input"] === null) return null;
  const translated = translateLegacyPanelJournal(record["kind"], { input: record["input"], events: [] });
  return translated.ok
    ? Object.freeze({ schemaVersion: 1, kind: record["kind"], input: translated.value.input })
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
  const requestId = parseRequestId(request.id);
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
  const section = encodeByteSection("panel-request", JSON.stringify({
    panel: registration.kind,
    requestId: request.id,
    outputContract: request.outputContract,
  }));
  if (!section.ok) return { ok: false, message: section.error.message };
  const packet = buildContextPacket({
    requestId: requestId.value,
    role: request.agent,
    requiredSkill: requiredSkill ?? "none",
    outputContract: request.outputContract,
    fixedContext: Object.freeze([]),
    variableContext: Object.freeze([section.value]),
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
  if (panelRequests.length === 0) return { ok: true, action };

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
    context: Object.freeze({
      digest: packet.digest,
      slot: Object.freeze({ kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` }),
    }),
  }));
  return action.type === "spawn-batch"
    ? { ok: true, action: Object.freeze({ ...action, requests: Object.freeze(enriched) }) }
    : { ok: true, action: Object.freeze({ ...action, request: enriched[0] }) };
}

async function driveRegisteredPanel(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<Readonly<{ ok: true; action: unknown }> | Readonly<{ ok: false; message: string }>> {
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
    return materializePanelAction(
      handle,
      registration,
      step.value.action ?? { type: "await-results", runId: handle.runId },
    );
  }

  let step = startRefutationDispatchProgram(translated.value.input);
  if (!step.ok) return { ok: false, message: step.errors.join("\n") };
  for (const event of translated.value.events) {
    const reduced = reduceRefutationProgram(step.value.state, event);
    if (!reduced.ok) return { ok: false, message: JSON.stringify(reduced.error) };
    step = { ok: true, value: reduced.value };
  }
  return materializePanelAction(
    handle,
    registration,
    step.value.action ?? { type: "await-results", runId: handle.runId },
  );
}

async function startOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const panel = args[0];
  if (panel !== "architecture" && panel !== "refutation") {
    return { kind: "error", message: "start requires architecture or refutation" };
  }
  const bound = bindRun(args.slice(1));
  if (!isBound(bound)) return bound;
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    return { kind: "error", message: `program input is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const translated = translateLegacyPanelJournal(panel, raw);
  if (!translated.ok) return { kind: "error", message: translated.error };
  if (translated.value.events.length !== 0) {
    return { kind: "error", message: "a fresh orchestration start cannot import pre-existing events" };
  }
  const registration: RegisteredPanelProgram = Object.freeze({
    schemaVersion: 1,
    kind: panel,
    input: translated.value.input,
  });
  const registered = await bound.value.handle.registerProgram(registration);
  if (!registered.ok) return { kind: "error", message: registered.error.message };
  const driven = await driveRegisteredPanel(bound.value.handle, registration);
  if (!driven.ok) return { kind: "error", message: driven.message };
  process.stdout.write(`${JSON.stringify(driven.action, null, 2)}\n`);
  return { kind: "allow" };
}

/**
 * Resume is idempotent and never silently spawns or decides policy: it reports
 * what the run's durable evidence already says. A run whose authority cannot
 * be read is reported as such rather than restarted, because restarting would
 * discard the very evidence that explains the failure.
 */
async function resumeOperation(args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };
  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  if (stored.value !== null) {
    const registration = parseRegisteredPanelProgram(stored.value);
    if (registration === null) return { kind: "error", message: "registered orchestration program is malformed" };
    const driven = await driveRegisteredPanel(bound.value.handle, registration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    process.stdout.write(`${JSON.stringify(driven.action, null, 2)}\n`);
    return { kind: "allow" };
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

  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  if (stored.value !== null) {
    const registration = parseRegisteredPanelProgram(stored.value);
    if (registration === null) return { kind: "error", message: "registered orchestration program is malformed" };
    await bound.value.handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `result:${createHash("sha256").update(`${requestId}:${attempt}`).digest("hex")}`,
      recordedAtMs: Date.now(),
      event: { type: "spawn-outcome", requestId, attempt: Number(attempt), outcome: "succeeded" },
    });
    const driven = await driveRegisteredPanel(bound.value.handle, registration);
    if (!driven.ok) return { kind: "error", message: driven.message };
    process.stdout.write(`${JSON.stringify(driven.action, null, 2)}\n`);
    return { kind: "allow" };
  }

  process.stdout.write(`${JSON.stringify({
    kind: "captured",
    requestId,
    artifact: captured.value,
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
  const recorded = await bound.value.handle.recordHarnessCorrelator({
    schemaVersion: 1,
    harness,
    nativeId,
    requestId: request.requestId,
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
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;
  const operationId = flag(args, "operation");
  const outcome = flag(args, "outcome");
  const error = flag(args, "error");
  if (operationId === null || (outcome !== "succeeded" && outcome !== "failed")) {
    return { kind: "error", message: "--operation and --outcome (succeeded or failed) are required" };
  }
  const stored = bound.value.handle.readProgramRegistration();
  if (!stored.ok) return { kind: "error", message: stored.error.message };
  const registration = stored.value === null ? null : parseRegisteredPanelProgram(stored.value);
  if (registration === null) return { kind: "error", message: "complete requires a registered panel program" };
  const current = await driveRegisteredPanel(bound.value.handle, registration);
  if (!current.ok) return { kind: "error", message: current.message };
  const action = current.action as Record<string, unknown> | null;
  if (action === null || action["type"] !== "engine-operation" || action["operation"] !== operationId) {
    return { kind: "error", message: `registered panel is not awaiting engine operation ${operationId}` };
  }
  await bound.value.handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `engine:${createHash("sha256").update(`${operationId}:${outcome}`).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: {
      type: "engine-outcome",
      operationId,
      outcome,
      ...(error === null ? {} : { error }),
    },
  });
  const next = await driveRegisteredPanel(bound.value.handle, registration);
  if (!next.ok) return { kind: "error", message: next.message };
  process.stdout.write(`${JSON.stringify(next.action, null, 2)}\n`);
  return { kind: "allow" };
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
  if (registered.value !== null) {
    return { kind: "error", message: "registered panel programs do not accept user decisions" };
  }

  const decisionId = flag(args, "request");
  if (decisionId === null) return { kind: "error", message: "--request <decision-id> is required" };
  if (stdin.trim().length === 0) return { kind: "error", message: "a decision must be supplied on stdin" };

  const decision = ((): unknown => {
    try {
      return JSON.parse(stdin) as unknown;
    } catch (error) {
      return { __malformed: error instanceof Error ? error.message : String(error) };
    }
  })();
  if (typeof decision !== "object" || decision === null ||
      typeof (decision as Record<string, unknown>)["__malformed"] === "string") {
    return { kind: "error", message: "decision must be a JSON object" };
  }

  await bound.value.handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `decision:${createHash("sha256").update(decisionId).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: { kind: "user-decision-recorded", decisionId, decision },
  });

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
