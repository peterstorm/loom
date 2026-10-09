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
 *   the policy would measure the copy. The extraction-only arm is offered no
 *   emission tool, so its transcript is classified by final-message
 *   extraction alone — the PR #52-only baseline — with no emission counters.
 *   Only an attempt left WITHOUT an accepted payload after ingestion — a
 *   kernel rejection, or an accepted decision the frozen parser refuses — is
 *   then read for a provider error ending its last model turn
 *   (`providerFailure`): an infrastructure failure, never a semantic rejection.
 * - `piArmDispatch` (I/O SHELL) launches the child exactly as production
 *   does per arm: the extraction-only arm is the launcher's print-mode JSON
 *   child; the emission-enabled arm goes through the INSTALLED production
 *   launcher's `runRpcAgent` readiness barrier (AD-4, loaded through the
 *   `loadLauncher` port — `importRpcLauncher` in production, a plain fake in
 *   tests) with the issued binding (minted upstream by the pure
 *   `pilot-binding.ts`; this adapter only consumes it) provisioned in
 *   `LOOM_EMISSION_BINDING`. Both load the STAGED Loom runtime
 *   (`-ne -e <checkout>/pi/extension.ts`) so the arms share one frozen,
 *   content-addressed runtime. No provider serializer exists here: Pi's own
 *   resolver serializes every request.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { match } from "ts-pattern";
import { parseFinalPayload } from "../../engine/src/core/harness-capture";
import { observeEmissionCalls } from "../../engine/src/core/emission-observation";
import { selectCanonicalPayload, selectVerdictSource } from "../../engine/src/core/emission-ingestion";
import { parseContextDigest } from "../../engine/src/core/orchestration-contract/identity";
import { piEmissionCallFrames, piResultFinalPayloadCandidates } from "../../pi/transcript-adapter";
import {
  LOOM_EMISSION_BINDING_ENV,
} from "../../pi/emission-tool";
import { EMISSION_READINESS_COMMAND, EMISSION_READINESS_ENTRY_TYPE } from "../../pi/emission-readiness-protocol";
import { decideReadinessGate, parseReadinessStageObservation } from "../../pi/emission-readiness-gate";
import { err, errorMessage, ok, type Result } from "../kernel";
import { isRecord, piContentText, readPiJsonLine, settlePiJsonStream, type PiJsonLine, type PiMessage } from "../pi-json-stream";
import type { CellBinding } from "./pilot-binding";
import {
  classifyEmissionToolError,
  type AttemptObservation,
  type EmissionArmAttempt,
  type ExtractionArmAttempt,
  type RejectionCause,
  type ToolError,
} from "./pilot-observation";
import { contentDigest, PILOT_CELLS, type CellKey, type PilotArm } from "./pilot-vocabulary";

// ---------------------------------------------------------------------------
// Pure transcript classification
// ---------------------------------------------------------------------------

/** How the child launch ended, before any payload decision. */
export type LaunchEnd =
  | Readonly<{ kind: "settled" }>
  | Readonly<{ kind: "startup-refused"; reason: string }>
  | Readonly<{ kind: "infrastructure-failure"; reason: string }>
  | Readonly<{ kind: "timeout"; afterMs: number }>;

/** The extraction-only arm passes no readiness barrier, so it is never refused at startup. */
export type ExtractionLaunchEnd = Exclude<LaunchEnd, { kind: "startup-refused" }>;

export type AttemptClassification = Readonly<{
  observation: AttemptObservation;
  /** The accepted payload as canonical JSON data (identical form for both
   *  arms, so a blinded assessor cannot infer the arm from formatting). */
  acceptedPayload: unknown;
}>;

const encoder = new TextEncoder();

/** Which source an accepted payload came from; the fallback flag exists only on extraction. */
type AcceptedSource =
  | Readonly<{ source: "emission-tool"; fallbackOverRefusal: false }>
  | Readonly<{ source: "extraction"; fallbackOverRefusal: boolean }>;

type Accepted<S extends AcceptedSource> = Readonly<{ kind: "accepted"; selection: S; bytes: Uint8Array }>;
type Rejected<C extends RejectionCause> = Readonly<{ kind: "rejected"; cause: C }>;

/** Final-message extraction: accepted from the extraction source, or an extraction failure. */
type ExtractionDecision<F extends boolean> =
  | Accepted<Readonly<{ source: "extraction"; fallbackOverRefusal: F }>>
  | Rejected<Extract<RejectionCause, { kind: "extraction-failure" }>>;

type PayloadDecision = Accepted<AcceptedSource> | Rejected<RejectionCause>;

const EMISSION_TOOL = Object.freeze({ source: "emission-tool" as const, fallbackOverRefusal: false as const });

function accepted<S extends AcceptedSource>(selection: S, bytes: ArrayLike<number>): Accepted<S> {
  return Object.freeze({ kind: "accepted" as const, selection, bytes: Uint8Array.from(bytes) });
}

function rejected<C extends RejectionCause>(cause: C): Rejected<C> {
  return Object.freeze({ kind: "rejected" as const, cause });
}

/** PR #52's fail-closed final-message admission over the transcript's final payload candidates. */
function extractFinalMessage<F extends boolean>(
  fallbackOverRefusal: F,
  candidates: ReturnType<typeof piResultFinalPayloadCandidates>,
  fallback: ReturnType<typeof parseFinalPayload>,
): ExtractionDecision<F> {
  return fallback.ok
    ? accepted({ source: "extraction" as const, fallbackOverRefusal }, fallback.value.bytes)
    : rejected({ kind: "extraction-failure" as const, detail: candidates.ok ? fallback.error.message : candidates.errors.join("; ") });
}

/** The extraction-only arm: the PR #52-only baseline is offered no emission
 *  tool and observes no emission call, so its decision is the final message alone. */
function selectExtractionPayload(messages: readonly unknown[]): ExtractionDecision<false> {
  const candidates = piResultFinalPayloadCandidates(messages);
  return extractFinalMessage(false, candidates, parseFinalPayload(candidates.ok ? candidates.value : []));
}

/** The emission-enabled arm: the engine's own observation and selection kernel. */
function selectEmissionPayload(cellBinding: CellBinding, messages: readonly unknown[]): PayloadDecision {
  const frames = piEmissionCallFrames(messages, cellBinding.binding);
  if (!frames.ok) return rejected({ kind: "observation-refused", detail: frames.errors.join("; ") });
  const observation = observeEmissionCalls(frames.value);
  const candidates = piResultFinalPayloadCandidates(messages);
  const finalCandidates = candidates.ok ? candidates.value : [];
  if (cellBinding.path === "reviewer") {
    const selection = selectCanonicalPayload(cellBinding.binding, observation, finalCandidates);
    return match(selection)
      .with({ kind: "emission-tool-arguments" }, (chosen): PayloadDecision => accepted(EMISSION_TOOL, chosen.payload.bytes))
      .with({ kind: "final-message-extraction" }, (chosen) => extractFinalMessage(false, candidates, chosen.fallback))
      .with({ kind: "extraction-over-refused-call" }, (chosen) => extractFinalMessage(true, candidates, chosen.fallback))
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
    .with({ kind: "emission-tool-arguments" }, (chosen): PayloadDecision => accepted(EMISSION_TOOL, encoder.encode(chosen.rawJson)))
    .with({ kind: "final-message-extraction" }, () => extractFinalMessage(false, candidates, fallback))
    .with({ kind: "extraction-over-refused-call" }, () => extractFinalMessage(true, candidates, fallback))
    .with({ kind: "duplicate-emission-call" }, (chosen) => rejected({ kind: "duplicate-call", calls: chosen.calls.length }))
    .with({ kind: "observation-refused" }, (chosen) =>
      rejected({ kind: "observation-refused", detail: `${chosen.refusal.code}: ${chosen.refusal.message}` }))
    .exhaustive();
}

type PayloadRefused = Extract<RejectionCause, { kind: "payload-refused" }>;

/**
 * A frozen-parser refusal of the selected bytes, naming where they came from.
 * The registry parser is the emission tool's, so its own message speaks of
 * "emission arguments" (for a verdict kind: `invalid-json: emission arguments
 * are not valid JSON`) whatever it read; an extraction-source decision handed
 * it the FINAL MESSAGE, and the detail says so. Free text: no reader parses it.
 */
function payloadRefused(cell: CellKey, source: AcceptedSource["source"], refusal: Readonly<{ code: string; message: string }>): PayloadRefused {
  const detail = source === "extraction"
    ? `${refusal.code}: the final message was refused by the frozen ${cell} emission-tool parser: ${refusal.message}`
    : `${refusal.code}: ${refusal.message}`;
  return { kind: "payload-refused", detail };
}

/**
 * Accepted ingestion: the selected bytes must pass the frozen registry's
 * parser for the issued kind/version (the same parse the engine applies).
 * The parser's contract value IS the canonical payload — one parse, and the
 * same normalization (schema key order, schema transforms) for both arms, so
 * the payload digest and the blinded packet never reveal the arm through the
 * shape of the model's own JSON text.
 */
function ingest<S extends AcceptedSource>(
  cell: CellKey,
  decision: Accepted<S>,
): Result<Readonly<{ outcome: Readonly<{ kind: "accepted" } & S & { payloadDigest: string }>; payload: unknown }>, PayloadRefused> {
  const parsed = PILOT_CELLS[cell].parsePayload(decision.bytes);
  if (!parsed.ok) return err(payloadRefused(cell, decision.selection.source, parsed.error));
  const outcome = Object.freeze<{ kind: "accepted" } & S & { payloadDigest: string }>({
    kind: "accepted", ...decision.selection, payloadDigest: contentDigest(JSON.stringify(parsed.value)),
  });
  return ok(Object.freeze({ outcome, payload: parsed.value }));
}

type InfrastructureFailure = Extract<LaunchEnd, { kind: "infrastructure-failure" }>;

/**
 * A provider error ending the LAST model turn (`stopReason: "error"`: the
 * route refused the connection, answered 5xx, or dropped the stream), as the
 * infrastructure failure it is; null when the last turn ended any other way.
 */
function providerFailure(records: readonly PiMessage[]): InfrastructureFailure | null {
  const last = records.filter((message) => message["role"] === "assistant").at(-1);
  if (last?.["stopReason"] !== "error") return null;
  const message = last["errorMessage"];
  const detail = typeof message === "string" && message.trim() !== "" ? message.trim() : "no error message";
  return { kind: "infrastructure-failure", reason: `the provider ended the model turn with an error: ${detail}` };
}

/** A settled attempt's outcome: the frozen parser's accepted payload, the
 *  selection's or the parser's rejection, or — for an attempt with no
 *  accepted payload whose last turn failed at the provider — that failure. */
type SettledOutcome<S extends AcceptedSource, C extends RejectionCause> =
  | Readonly<{ kind: "accepted" } & S & { payloadDigest: string }>
  | Readonly<{ kind: "rejected"; cause: C | PayloadRefused }>
  | InfrastructureFailure;

/**
 * The settled branch both arms share. The attempt is classified FIRST: an
 * accepted decision must pass ingestion, and an accepted payload stands
 * whatever happened after it — the production engine ingests an emission at
 * the tool call, so a turn that errors after it costs nothing. Only an attempt
 * left WITHOUT an accepted payload is then read for a provider error ending
 * its last turn (`providerFailure`): that attempt never reached the model's
 * answer, so it is an infrastructure failure, not a semantic rejection —
 * counting it as one would charge a route outage to the arm under test and
 * spend the attempt-2 retry on a route that is down.
 */
function settle<S extends AcceptedSource, C extends RejectionCause>(
  cell: CellKey,
  decision: Accepted<S> | Rejected<C>,
  records: readonly PiMessage[],
): Readonly<{ outcome: SettledOutcome<S, C>; payload: unknown }> {
  const settled = decision.kind === "accepted" ? ingest(cell, decision) : err(decision.cause);
  if (settled.ok) return settled.value;
  return { outcome: providerFailure(records) ?? { kind: "rejected", cause: settled.error }, payload: null };
}

type TranscriptCommon = Readonly<{
  cell: CellKey;
  cellBinding: CellBinding;
  messages: readonly unknown[];
  attempt: number;
  elapsedMs: number;
}>;

/** One settled attempt's transcript, per arm: only the emission arm has a
 *  readiness barrier (and so a readiness time and a startup refusal). */
export type TranscriptInput =
  | (TranscriptCommon & Readonly<{ arm: "emission-enabled"; readinessMs: number | null; launch: LaunchEnd }>)
  | (TranscriptCommon & Readonly<{ arm: "extraction-only"; launch: ExtractionLaunchEnd }>);

/** The counters of the emission tool's calls and results in one transcript. */
function emissionCounters(toolName: string, records: readonly PiMessage[], assistantIndices: readonly number[]) {
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
    .map(({ message }) => classifyEmissionToolError(piContentText(message["content"])));
  const firstAck = emissionResults.find(({ message }) => message["isError"] === false);
  return {
    emissionCalls: callIds.size,
    toolErrors: Object.freeze(toolErrors),
    toolAcknowledged: firstAck !== undefined,
    followUpTurnsAfterAck: firstAck === undefined ? 0 : assistantIndices.filter((index) => index > firstAck.index).length,
  };
}

export function classifyAttemptTranscript(input: TranscriptInput): AttemptClassification {
  const records = input.messages.filter(isRecord);
  const assistantIndices = records.flatMap((message, index) => (message["role"] === "assistant" ? [index] : []));
  const base = { attempt: input.attempt, elapsedMs: input.elapsedMs, modelRequests: assistantIndices.length };
  if (input.arm === "extraction-only") {
    const end = (outcome: ExtractionArmAttempt["outcome"], acceptedPayload: unknown = null): AttemptClassification => Object.freeze({
      observation: Object.freeze({
        ...base, readinessMs: null, emissionCalls: 0 as const, toolErrors: Object.freeze([] as const),
        toolAcknowledged: false as const, followUpTurnsAfterAck: 0 as const, outcome: Object.freeze(outcome),
      }),
      acceptedPayload,
    });
    return match(input.launch)
      .with({ kind: "infrastructure-failure" }, (launch) => end({ kind: "infrastructure-failure", reason: launch.reason }))
      .with({ kind: "timeout" }, (launch) => end({ kind: "timeout", afterMs: launch.afterMs }))
      .with({ kind: "settled" }, () => {
        const settled = settle(input.cell, selectExtractionPayload(input.messages), records);
        return end(settled.outcome, settled.payload);
      })
      .exhaustive();
  }
  const counters = {
    ...base,
    readinessMs: input.readinessMs,
    ...emissionCounters(input.cellBinding.binding.toolName, records, assistantIndices),
  };
  const end = (outcome: EmissionArmAttempt["outcome"], acceptedPayload: unknown = null): AttemptClassification =>
    Object.freeze({ observation: Object.freeze({ ...counters, outcome: Object.freeze(outcome) }), acceptedPayload });
  return match(input.launch)
    .with({ kind: "startup-refused" }, (launch) => end({ kind: "startup-refused", reason: launch.reason }))
    .with({ kind: "infrastructure-failure" }, (launch) => end({ kind: "infrastructure-failure", reason: launch.reason }))
    .with({ kind: "timeout" }, (launch) => end({ kind: "timeout", afterMs: launch.afterMs }))
    .with({ kind: "settled" }, () => {
      const settled = settle(input.cell, selectEmissionPayload(input.cellBinding, input.messages), records);
      return end(settled.outcome, settled.payload);
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
  /** Loads the installed production launcher's `runRpcAgent` (`importRpcLauncher`). */
  loadLauncher: () => Promise<RpcLauncher>;
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

/** The launcher barrier's view of the child before the task prompt is sent. */
export type ReadinessClient = Readonly<{
  getCommands: () => Promise<readonly Readonly<{ name: string; source?: string }>[]>;
  invokeReadiness: () => Promise<readonly unknown[]>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  getState: () => Promise<Readonly<{ model: null | Readonly<{ provider?: string; id?: string }> }>>;
}>;

/** The installed launcher's `runRpcAgent`, as far as the pilot uses it. */
export type RunRpcAgent = (input: Readonly<{
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

export type RpcLauncher =
  | Readonly<{ kind: "loaded"; runRpcAgent: RunRpcAgent }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** The production launcher port adapter: import the installed module and
 *  take its `runRpcAgent`. A module that cannot be imported throws. */
export const importRpcLauncher = (launcherModule: string) => async (): Promise<RpcLauncher> => {
  const imported: unknown = await import(launcherModule);
  return isRecord(imported) && typeof imported["runRpcAgent"] === "function"
    ? { kind: "loaded", runRpcAgent: imported["runRpcAgent"] as RunRpcAgent }
    : { kind: "unavailable", reason: `${launcherModule} exports no runRpcAgent` };
};

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

/**
 * How an emission launch ended, from the launcher's outcome (PURE). A launch
 * the launcher reports as successful counts as settled only if the adapter's
 * own readiness verification returned ok (`readinessMs` is set): a launcher
 * that skipped the AD-4 barrier would otherwise yield an unverified sample.
 */
function emissionLaunchEnd(
  outcome: RpcLaunchOutcome, aborted: boolean, readinessMs: number | null, timeoutMs: number,
): LaunchEnd {
  if (outcome.ok) {
    return readinessMs === null
      ? { kind: "infrastructure-failure", reason: "the launcher reported success, but the readiness barrier never verified the child" }
      : { kind: "settled" };
  }
  if (aborted) return { kind: "timeout", afterMs: timeoutMs };
  return outcome.phase === "before-task-prompt"
    ? { kind: "startup-refused", reason: outcome.reason }
    : { kind: "infrastructure-failure", reason: outcome.reason };
}

/** A launcher that cannot be loaded or that rejects mid-run is an
 *  infrastructure failure of this one attempt, never an exception that aborts
 *  the window (the extraction arm maps its spawn errors the same way). */
async function dispatchEmission(config: PiDispatchConfig, request: ArmRequest): Promise<AttemptClassification> {
  const launcher = await config.loadLauncher().catch((error: unknown): RpcLauncher =>
    ({ kind: "unavailable", reason: `the installed launcher could not be loaded: ${errorMessage(error)}` }));
  const started = performance.now();
  const messages: unknown[] = [];
  const readiness: { ms: number | null } = { ms: null };
  const classify = (launch: LaunchEnd): AttemptClassification => classifyAttemptTranscript({
    arm: "emission-enabled", cell: request.cell, cellBinding: request.cellBinding, messages, attempt: request.attempt,
    elapsedMs: performance.now() - started, readinessMs: readiness.ms, launch,
  });
  if (launcher.kind === "unavailable") return classify({ kind: "infrastructure-failure", reason: launcher.reason });
  const { runRpcAgent } = launcher;
  const { binding } = request.cellBinding;
  const bindingEnv = emissionBindingEnv(request.cellBinding);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  try {
    const launch = await runRpcAgent({
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
        verifyReadiness: readinessVerifier(config, request.cellBinding, () => { readiness.ms = performance.now() - started; }),
      },
      signal: abort.signal,
      readinessTimeoutMs: config.readinessTimeoutMs,
      onMessage: (message) => { messages.push(message); },
    }).then(
      (outcome) => emissionLaunchEnd(outcome, abort.signal.aborted, readiness.ms, config.timeoutMs),
      (error: unknown): LaunchEnd => abort.signal.aborted
        ? { kind: "timeout", afterMs: config.timeoutMs }
        : { kind: "infrastructure-failure", reason: `the installed launcher's runRpcAgent rejected: ${errorMessage(error)}` },
    );
    return classify(launch);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill the child's whole process group. The child leads its own group
 * (`detached: true`), so its tool subprocesses die with it: a descendant that
 * survived would keep the inherited stdout/stderr pipes open, `close` would
 * not fire, and the attempt would outlive `timeoutMs`. If the group cannot be
 * signalled, the direct child is still killed.
 */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** The extraction arm reads the launcher's print-mode JSON stream line by line
 *  as it arrives (`pi-json-stream.ts`), keeping only what each line yields; a
 *  stream with any malformed line is an infrastructure failure of the attempt. */
async function dispatchExtraction(config: PiDispatchConfig, request: ArmRequest): Promise<AttemptClassification> {
  const started = performance.now();
  const decoded: PiJsonLine[] = [];
  const launch = await new Promise<ExtractionLaunchEnd>((resolve) => {
    const child = spawn(config.piCommand, [
      "--mode", "json", "-p", "--no-session", "-ne", "-e", stagedExtension(config),
      "--provider", config.provider, "--model", config.model, "--thinking", config.thinking,
      "--tools", config.tools.join(","),
      `Task: ${request.prompt}`,
    ], { cwd: config.repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let buffer = "";
    let stderr = "";
    let lineNumber = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child); }, config.timeoutMs);
    const consume = (line: string): void => {
      lineNumber += 1;
      const read = readPiJsonLine(line, lineNumber);
      if (read.kind !== "ignored") decoded.push(read);
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
      const stream = settlePiJsonStream(decoded);
      if (timedOut) resolve({ kind: "timeout", afterMs: config.timeoutMs });
      else if (code !== 0) resolve({ kind: "infrastructure-failure", reason: stderr.trim() || `pi exited ${code}` });
      else if (!stream.ok) resolve({ kind: "infrastructure-failure", reason: stream.error });
      else resolve({ kind: "settled" });
    });
  });
  return classifyAttemptTranscript({
    arm: "extraction-only", cell: request.cell, cellBinding: request.cellBinding,
    messages: decoded.flatMap((line) => (line.kind === "message" ? [line.message] : [])),
    attempt: request.attempt, elapsedMs: performance.now() - started, launch,
  });
}

/** The production Pi adapter of the dispatch port. */
export function piArmDispatch(config: PiDispatchConfig): ArmDispatch {
  return (request) => request.arm === "emission-enabled" ? dispatchEmission(config, request) : dispatchExtraction(config, request);
}
