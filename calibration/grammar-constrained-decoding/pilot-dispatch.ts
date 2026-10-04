/**
 * Pilot dispatch: the dispatch-to-ingestion counters for ONE attempt.
 *
 * Two halves, kept apart:
 *
 * - `classifyAttemptTranscript` (PURE) folds a settled child transcript
 *   through the engine's OWN observation and selection kernel —
 *   `piEmissionCallFrames` → `observeEmissionCalls` → `selectCanonicalPayload`
 *   / `selectVerdictSource` → the frozen registry parser — and counts model
 *   requests, emission calls, errored tool results (Pi's in-child
 *   validation-retry loop), acknowledgments and follow-up turns. Nothing here
 *   re-implements selection; a calibration that measured a private copy of
 *   the policy would measure the copy.
 * - `piArmDispatch` (I/O SHELL) launches the child exactly as production
 *   does per arm: the extraction-only arm is the launcher's print-mode JSON
 *   child; the emission-enabled arm goes through the INSTALLED production
 *   launcher's `runRpcAgent` readiness barrier (AD-4) with the issued binding
 *   provisioned in `LOOM_EMISSION_BINDING`. Both load the STAGED Loom runtime
 *   (`-ne -e <checkout>/pi/extension.ts`) so the arms share one frozen,
 *   content-addressed runtime. No provider serializer exists here: Pi's own
 *   resolver serializes every request.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { match } from "ts-pattern";
import {
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  type IssuedEmissionBindingOf,
} from "../../engine/src/core/emission-tool";
import { observeEmissionCalls, parseFinalPayload } from "../../engine/src/core/harness-capture";
import { selectCanonicalPayload, selectVerdictSource } from "../../engine/src/core/emission-ingestion";
import { parseContextDigest } from "../../engine/src/core/orchestration-contract/identity";
import { piEmissionCallFrames, piResultFinalPayloadCandidates } from "../../pi/transcript-adapter";
import {
  decideReadinessGate,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  LOOM_EMISSION_BINDING_ENV,
  parseReadinessStageObservation,
} from "../../pi/emission-tool";
import {
  classifyEmissionToolError,
  contentDigest,
  type AttemptObservation,
  type CellKey,
  type PilotArm,
  type RejectionCause,
  type Result,
  type ToolError,
} from "./pilot-core";
import { CELL_PRODUCER } from "./pilot-workload";

// ---------------------------------------------------------------------------
// Issued binding per cell (path-refined, minted by the engine's one mint)
// ---------------------------------------------------------------------------

export type CellBinding =
  | Readonly<{ path: "reviewer"; binding: IssuedEmissionBindingOf<"reviewer-payload">; contextDigest: string }>
  | Readonly<{ path: "verdict"; binding: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">; contextDigest: string }>;

/** Mint the issued binding for one attempt through `issueEmissionBinding`; the
 *  context digest is the content address of the exact prompt the child gets. */
export function mintCellBinding(cell: CellKey, requestId: string, prompt: string): Result<CellBinding, string> {
  const contextDigest = parseContextDigest(contentDigest(prompt));
  if (!contextDigest.ok) return { ok: false, error: contextDigest.error.message };
  const producer = CELL_PRODUCER[cell];
  if (producer.kind === "reviewer-payload") {
    const minted = issueEmissionBinding({ requestId, kind: "reviewer-payload", version: producer.version });
    return minted.ok
      ? { ok: true, value: Object.freeze({ path: "reviewer" as const, binding: minted.value, contextDigest: contextDigest.value }) }
      : { ok: false, error: minted.error.message };
  }
  const minted = issueEmissionBinding({ requestId, kind: producer.kind, version: producer.version });
  return minted.ok
    ? { ok: true, value: Object.freeze({ path: "verdict" as const, binding: minted.value, contextDigest: contextDigest.value }) }
    : { ok: false, error: minted.error.message };
}

// ---------------------------------------------------------------------------
// Pure transcript classification
// ---------------------------------------------------------------------------

/** How the child launch ended, before any payload decision. */
export type LaunchEnd =
  | Readonly<{ kind: "settled" }>
  | Readonly<{ kind: "startup-refused"; reason: string }>
  | Readonly<{ kind: "infrastructure-failure"; reason: string }>
  | Readonly<{ kind: "timeout"; afterMs: number }>;

export type AttemptClassification = Readonly<{
  observation: AttemptObservation;
  /** The accepted payload as canonical JSON data (identical form for both
   *  arms, so a blinded assessor cannot infer the arm from formatting). */
  acceptedPayload: unknown;
}>;

type Rec = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.filter(isRecord).filter((block) => block["type"] === "text").map((block) => String(block["text"] ?? "")).join("")
    : typeof content === "string" ? content : "";

const encoder = new TextEncoder();

type PayloadDecision =
  | Readonly<{ kind: "accepted"; source: "emission-tool" | "extraction"; fallbackOverRefusal: boolean; bytes: Uint8Array }>
  | Readonly<{ kind: "rejected"; cause: RejectionCause }>;

function rejected(cause: RejectionCause): PayloadDecision {
  return Object.freeze({ kind: "rejected" as const, cause });
}

function selectPayload(cellBinding: CellBinding, messages: readonly unknown[]): PayloadDecision {
  const frames = piEmissionCallFrames(messages, cellBinding.binding);
  if (!frames.ok) return rejected({ kind: "observation-refused", detail: frames.errors.join("; ") });
  const observation = observeEmissionCalls(frames.value);
  const candidates = piResultFinalPayloadCandidates(messages);
  const finalCandidates = candidates.ok ? candidates.value : [];
  const extracted = (fallbackOverRefusal: boolean, fallback: ReturnType<typeof parseFinalPayload>): PayloadDecision =>
    fallback.ok
      ? Object.freeze({ kind: "accepted" as const, source: "extraction" as const, fallbackOverRefusal, bytes: Uint8Array.from(fallback.value.bytes) })
      : rejected({ kind: "extraction-failure", detail: candidates.ok ? fallback.error.message : candidates.errors.join("; ") });
  if (cellBinding.path === "reviewer") {
    const selection = selectCanonicalPayload(cellBinding.binding, observation, finalCandidates);
    return match(selection)
      .with({ kind: "emission-tool-arguments" }, (chosen): PayloadDecision =>
        Object.freeze({ kind: "accepted" as const, source: "emission-tool" as const, fallbackOverRefusal: false, bytes: Uint8Array.from(chosen.payload.bytes) }))
      .with({ kind: "final-message-extraction" }, (chosen) => extracted(false, chosen.fallback))
      .with({ kind: "extraction-over-refused-call" }, (chosen) => extracted(true, chosen.fallback))
      .with({ kind: "refused-call-no-fallback" }, (chosen) =>
        rejected({ kind: "refused-call-no-fallback", detail: `${chosen.emissionRefusal.code}: ${chosen.emissionRefusal.message}` }))
      .with({ kind: "duplicate-emission-call" }, (chosen) => rejected({ kind: "duplicate-call", calls: chosen.calls.length }))
      .with({ kind: "observation-refused" }, (chosen) =>
        rejected({ kind: "observation-refused", detail: `${chosen.refusal.code}: ${chosen.refusal.message}` }))
      .exhaustive();
  }
  // The verdict path preserves the caller's existing raw input; PR #52's
  // fail-closed final-message admission decides what that raw input is.
  const fallback = parseFinalPayload(finalCandidates);
  const selection = selectVerdictSource(cellBinding.binding, observation, fallback.ok ? fallback.value.text : "");
  return match(selection)
    .with({ kind: "emission-tool-arguments" }, (chosen): PayloadDecision =>
      Object.freeze({ kind: "accepted" as const, source: "emission-tool" as const, fallbackOverRefusal: false, bytes: encoder.encode(chosen.rawJson) }))
    .with({ kind: "final-message-extraction" }, () => extracted(false, fallback))
    .with({ kind: "extraction-over-refused-call" }, () => extracted(true, fallback))
    .with({ kind: "duplicate-emission-call" }, (chosen) => rejected({ kind: "duplicate-call", calls: chosen.calls.length }))
    .with({ kind: "observation-refused" }, (chosen) =>
      rejected({ kind: "observation-refused", detail: `${chosen.refusal.code}: ${chosen.refusal.message}` }))
    .exhaustive();
}

/** Accepted ingestion: the selected bytes must pass the frozen registry's
 *  parser for the issued kind/version (the same parse the engine applies). */
function ingest(cell: CellKey, bytes: Uint8Array): Result<unknown, string> {
  const producer = CELL_PRODUCER[cell];
  const versions: Readonly<Partial<Record<string, Readonly<{ parsePayload: (raw: Uint8Array) => Result<unknown, Readonly<{ code: string; message: string }>> }>>>> =
    EMISSION_TOOL_SPECS[producer.kind].schemaVersions;
  const parser = versions[producer.version];
  if (parser === undefined) return { ok: false, error: `frozen registry carries no ${cell} parser` };
  const parsed = parser.parsePayload(bytes);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: `${parsed.error.code}: ${parsed.error.message}` };
}

export type TranscriptInput = Readonly<{
  cell: CellKey;
  cellBinding: CellBinding;
  messages: readonly unknown[];
  attempt: number;
  elapsedMs: number;
  readinessMs: number | null;
  launch: LaunchEnd;
}>;

export function classifyAttemptTranscript(input: TranscriptInput): AttemptClassification {
  const toolName = input.cellBinding.binding.toolName;
  const records = input.messages.filter(isRecord);
  const callIds = new Set<string>();
  for (const message of records) {
    if (message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
    for (const block of message["content"].filter(isRecord)) {
      if (block["type"] === "toolCall" && block["name"] === toolName && typeof block["id"] === "string") callIds.add(block["id"]);
    }
  }
  const emissionResults = records
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message["role"] === "toolResult" && message["toolName"] === toolName);
  const toolErrors: ToolError[] = emissionResults
    .filter(({ message }) => message["isError"] === true)
    .map(({ message }) => classifyEmissionToolError(textOf(message["content"])));
  const firstAck = emissionResults.find(({ message }) => message["isError"] === false);
  const assistantIndices = records.flatMap((message, index) => (message["role"] === "assistant" ? [index] : []));
  const counters = {
    attempt: input.attempt,
    elapsedMs: input.elapsedMs,
    readinessMs: input.readinessMs,
    modelRequests: assistantIndices.length,
    emissionCalls: callIds.size,
    toolErrors: Object.freeze(toolErrors),
    toolAcknowledged: firstAck !== undefined,
    followUpTurnsAfterAck: firstAck === undefined ? 0 : assistantIndices.filter((index) => index > firstAck.index).length,
  };
  const end = (outcome: AttemptObservation["outcome"], acceptedPayload: unknown = null): AttemptClassification =>
    Object.freeze({ observation: Object.freeze({ ...counters, outcome: Object.freeze(outcome) }), acceptedPayload });
  return match(input.launch)
    .with({ kind: "startup-refused" }, (launch) => end({ kind: "startup-refused", reason: launch.reason }))
    .with({ kind: "infrastructure-failure" }, (launch) => end({ kind: "infrastructure-failure", reason: launch.reason }))
    .with({ kind: "timeout" }, (launch) => end({ kind: "timeout", afterMs: launch.afterMs }))
    .with({ kind: "settled" }, () => {
      const decision = selectPayload(input.cellBinding, input.messages);
      if (decision.kind === "rejected") return end({ kind: "rejected", cause: decision.cause });
      const ingested = ingest(input.cell, decision.bytes);
      if (!ingested.ok) return end({ kind: "rejected", cause: { kind: "payload-refused", detail: ingested.error } });
      const canonical: unknown = JSON.parse(new TextDecoder().decode(decision.bytes));
      return end({
        kind: "accepted",
        source: decision.source,
        fallbackOverRefusal: decision.fallbackOverRefusal,
        payloadDigest: contentDigest(JSON.stringify(canonical)),
      }, canonical);
    })
    .exhaustive();
}

// ---------------------------------------------------------------------------
// The live Pi shell
// ---------------------------------------------------------------------------

export type ArmRequest = Readonly<{
  cell: CellKey;
  arm: PilotArm;
  attempt: number;
  prompt: string;
  cellBinding: CellBinding;
}>;

/** The dispatch port: one attempt of one arm, launched and classified. */
export type ArmDispatch = (request: ArmRequest) => Promise<AttemptClassification>;

export type PiDispatchConfig = Readonly<{
  repoRoot: string;
  piCommand: string;
  /** The installed production launcher module exporting `runRpcAgent`. */
  launcherModule: string;
  provider: string;
  model: string;
  thinking: string;
  /** Read-only investigation tools both arms get (the emission tool is added on the emission arm only). */
  tools: readonly string[];
  stagedRevision: string;
  timeoutMs: number;
  readinessTimeoutMs: number;
}>;

type RpcLaunchOutcome =
  | Readonly<{ ok: true; stderr: string }>
  | Readonly<{ ok: false; kind: string; phase: "before-task-prompt" | "task-prompt-sent"; reason: string; stderr: string }>;

type ReadinessClient = Readonly<{
  getCommands: () => Promise<readonly Readonly<{ name: string; source?: string }>[]>;
  invokeReadiness: () => Promise<readonly unknown[]>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  getState: () => Promise<Readonly<{ model: null | Readonly<{ provider?: string; id?: string }> }>>;
}>;

type RunRpcAgent = (input: Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  task: string;
  directive: Readonly<{
    kind: "emission-rpc";
    bindingEnv: string;
    expectedProvider: string;
    expectedModel: string;
    expectedToolName: string;
    verifyReadiness: (client: ReadinessClient) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>>;
  }>;
  signal?: AbortSignal;
  readinessTimeoutMs?: number;
  onMessage: (message: unknown) => void;
}>) => Promise<RpcLaunchOutcome>;

const stagedExtension = (config: PiDispatchConfig): string => join(config.repoRoot, "pi", "extension.ts");

/**
 * The emission arm's readiness verification: the launcher's barrier holds the
 * task prompt until this resolves ok. It applies the loom-owned pure gate
 * (`decideReadinessGate`) to the child's bound readiness entry — request,
 * context digest, kind/version/tool/schema digest, active flag and the
 * STAGED runtime revision — then binds and re-observes the exact route.
 */
function readinessVerifier(config: PiDispatchConfig, cellBinding: CellBinding, onReady: () => void) {
  return async (client: ReadinessClient): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>> => {
    const commands = await client.getCommands();
    if (!commands.some((command) => command.name === EMISSION_READINESS_COMMAND && command.source === "extension")) {
      return { ok: false, reason: `Required extension command /${EMISSION_READINESS_COMMAND} is unavailable` };
    }
    const entries = await client.invokeReadiness();
    const [entry] = entries;
    if (entries.length !== 1 || !isRecord(entry) || entry["customType"] !== EMISSION_READINESS_ENTRY_TYPE) {
      return { ok: false, reason: `readiness invocation did not produce exactly one ${EMISSION_READINESS_ENTRY_TYPE} entry` };
    }
    const contextDigest = parseContextDigest(cellBinding.contextDigest);
    if (!contextDigest.ok) return { ok: false, reason: contextDigest.error.message };
    const decision = decideReadinessGate(
      { binding: cellBinding.binding, contextDigest: contextDigest.value, revision: config.stagedRevision, readinessCommand: EMISSION_READINESS_COMMAND },
      parseReadinessStageObservation({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: { kind: "observed", payload: entry["data"] },
      }),
    );
    if (decision.kind === "refused") return { ok: false, reason: decision.message };
    await client.setModel(config.provider, config.model);
    const state = await client.getState();
    if (state.model?.provider !== config.provider || state.model.id !== config.model) {
      return { ok: false, reason: `the child route ${state.model?.provider}/${state.model?.id} does not match ${config.provider}/${config.model}` };
    }
    onReady();
    return { ok: true };
  };
}

/** The provisioning claims pi/extension.ts parses (`parseEmissionChildProvisioning`). */
function emissionBindingEnv({ binding, contextDigest }: ArmRequest["cellBinding"]): string {
  return JSON.stringify({
    requestId: binding.requestId, contextDigest, kind: binding.kind.kind,
    version: binding.version, toolName: binding.toolName, schemaDigest: binding.schemaDigest,
  });
}

function emissionArgs(config: PiDispatchConfig, toolName: string): readonly string[] {
  return [
    "--mode", "rpc", "--no-session", "-ne", "-e", stagedExtension(config),
    "--provider", config.provider, "--model", config.model, "--thinking", config.thinking,
    "--tools", [...config.tools, toolName].join(","),
  ];
}

async function dispatchEmission(config: PiDispatchConfig, request: ArmRequest): Promise<AttemptClassification> {
  const imported: unknown = await import(config.launcherModule);
  const runRpcAgent = isRecord(imported) && typeof imported["runRpcAgent"] === "function" ? imported["runRpcAgent"] as RunRpcAgent : null;
  const started = performance.now();
  const messages: unknown[] = [];
  const classify = (launch: LaunchEnd, readinessMs: number | null): AttemptClassification => classifyAttemptTranscript({
    cell: request.cell, cellBinding: request.cellBinding, messages, attempt: request.attempt,
    elapsedMs: performance.now() - started, readinessMs, launch,
  });
  if (runRpcAgent === null) {
    return classify({ kind: "infrastructure-failure", reason: `${config.launcherModule} exports no runRpcAgent` }, null);
  }
  const { binding } = request.cellBinding;
  const bindingEnv = emissionBindingEnv(request.cellBinding);
  let readinessMs: number | null = null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  try {
    const outcome = await runRpcAgent({
      command: config.piCommand,
      args: emissionArgs(config, binding.toolName),
      cwd: config.repoRoot,
      env: { ...process.env, [LOOM_EMISSION_BINDING_ENV]: bindingEnv },
      task: request.prompt,
      directive: {
        kind: "emission-rpc",
        bindingEnv,
        expectedProvider: config.provider,
        expectedModel: config.model,
        expectedToolName: binding.toolName,
        verifyReadiness: readinessVerifier(config, request.cellBinding, () => { readinessMs = performance.now() - started; }),
      },
      signal: abort.signal,
      readinessTimeoutMs: config.readinessTimeoutMs,
      onMessage: (message) => { messages.push(message); },
    });
    if (outcome.ok) return classify({ kind: "settled" }, readinessMs);
    if (abort.signal.aborted) return classify({ kind: "timeout", afterMs: config.timeoutMs }, readinessMs);
    return classify(outcome.phase === "before-task-prompt"
      ? { kind: "startup-refused", reason: outcome.reason }
      : { kind: "infrastructure-failure", reason: outcome.reason }, readinessMs);
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchExtraction(config: PiDispatchConfig, request: ArmRequest): Promise<AttemptClassification> {
  const started = performance.now();
  const messages: unknown[] = [];
  const malformed: string[] = [];
  const launch = await new Promise<LaunchEnd>((resolve) => {
    const child = spawn(config.piCommand, [
      "--mode", "json", "-p", "--no-session", "-ne", "-e", stagedExtension(config),
      "--provider", config.provider, "--model", config.model, "--thinking", config.thinking,
      "--tools", config.tools.join(","),
      `Task: ${request.prompt}`,
    ], { cwd: config.repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, config.timeoutMs);
    const consume = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event: unknown = JSON.parse(line);
        if (isRecord(event) && event["type"] === "message_end" && isRecord(event["message"])) messages.push(event["message"]);
      } catch (error) {
        malformed.push(error instanceof Error ? error.message : String(error));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf-8")).slice(-65_536); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ kind: "infrastructure-failure", reason: `spawn ${config.piCommand}: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      consume(buffer);
      if (timedOut) resolve({ kind: "timeout", afterMs: config.timeoutMs });
      else if (code !== 0) resolve({ kind: "infrastructure-failure", reason: stderr.trim() || `pi exited ${code}` });
      else if (malformed.length > 0) resolve({ kind: "infrastructure-failure", reason: `Pi JSON stream contained ${malformed.length} malformed line(s): ${malformed.join("; ")}` });
      else resolve({ kind: "settled" });
    });
  });
  return classifyAttemptTranscript({
    cell: request.cell, cellBinding: request.cellBinding, messages, attempt: request.attempt,
    elapsedMs: performance.now() - started, readinessMs: null, launch,
  });
}

/** The production Pi adapter of the dispatch port. */
export function piArmDispatch(config: PiDispatchConfig): ArmDispatch {
  return (request) => request.arm === "emission-enabled" ? dispatchEmission(config, request) : dispatchExtraction(config, request);
}
