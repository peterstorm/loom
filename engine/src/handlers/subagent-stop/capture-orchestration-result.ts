/**
 * Claude Code request-bound capture.
 *
 * Runs BEFORE legacy SubagentStop routing. That ordering matters twice over:
 * the legacy path resolves a task graph and returns early when there is none,
 * which would silently skip capture for every standalone run; and legacy
 * handlers mutate task state, so capturing afterwards would record evidence
 * for a decision already taken.
 *
 * Capture is bound to REQUEST authority, not to the agent that happens to have
 * stopped. Claude's `session_id` + `agent_id` + `agent_type` locate the
 * pre-spawn reservation; the reservation names the request, and the request
 * names the run, slot, attempt, model, and context digest. A stop that matches
 * no reservation is audited and ignored — it is someone else's agent, not
 * evidence for this run.
 *
 * This handler NEVER resolves an unrelated State File. It reads only the run
 * directory it was pointed at, so a standalone review running beside an active
 * wave cannot capture into the wave's graph or vice versa.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler, HookResult, SubagentStopInput } from "../../types";
import {
  bindCapture,
  parseFinalPayload,
  type CaptureReceipt,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../../core/harness-capture";
import {
  parseAgentRequestAuthority,
  type AgentRequestAuthority,
} from "../../core/orchestration-contract";
import { openRunDirectory, type RunDirHandle } from "../../orchestration/run-directory-handle";

/**
 * Where a Claude run directory is announced. Set by the spawn side; absent for
 * every agent that is not part of an orchestration run, which is the common
 * case and NOT an error.
 */
const RUNS_ROOT_ENV = "LOOM_ORCHESTRATION_RUNS_ROOT";
const RUN_DIR_ENV = "LOOM_ORCHESTRATION_RUN_DIR";

export type CaptureOutcome =
  | Readonly<{ kind: "not-an-orchestration-run" }>
  | Readonly<{ kind: "no-reservation"; agentId: string }>
  | Readonly<{ kind: "captured"; receipt: CaptureReceipt }>
  | Readonly<{ kind: "rejected"; reason: string; message: string }>;

/**
 * Read the last assistant message from a Claude agent transcript as the sole
 * final-payload candidate.
 *
 * Claude's transcript is JSONL with one message per line, so "the final
 * assistant text" is unambiguous by construction — unlike Pi, where a result
 * carries a list of blocks. Any parse failure yields NO candidate rather than
 * a guess, so the ambiguity rules reject instead of accepting salvage.
 */
export function claudeFinalPayloadCandidates(transcriptPath: string): readonly FinalPayloadCandidate[] {
  if (!existsSync(transcriptPath)) return Object.freeze([]);
  const lines = ((): readonly string[] => {
    try {
      return readFileSync(transcriptPath, "utf-8").split("\n").filter((line) => line.trim().length > 0);
    } catch {
      return Object.freeze([]);
    }
  })();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = assistantTextOf(lines[index]);
    if (text !== null) return Object.freeze([{ origin: `transcript.line[${index}]`, text }]);
  }
  return Object.freeze([]);
}

function assistantTextOf(line: string | undefined): string | null {
  if (line === undefined) return null;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  })();
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = (parsed as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record["role"] !== "assistant" || !Array.isArray(record["content"])) return null;

  // Concatenating text blocks here would be the same normalisation the payload
  // rules forbid, so a multi-block assistant message yields its blocks joined
  // by nothing only when there is exactly one.
  const texts = (record["content"] as readonly unknown[])
    .filter((block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string");
  return texts.length === 1 ? texts[0] ?? null : null;
}

/** Every request this run reserved, parsed from its immutable reservations. */
export function readIssuedRequests(handle: RunDirHandle): readonly AgentRequestAuthority[] {
  const directory = join(handle.runDirectory, "requests");
  if (!existsSync(directory)) return Object.freeze([]);
  const issued: AgentRequestAuthority[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = ((): unknown => {
      try {
        return JSON.parse(readFileSync(join(directory, name), "utf-8")) as unknown;
      } catch {
        return null;
      }
    })();
    const authority = parseAgentRequestAuthority(parsed);
    if (authority.ok) issued.push(authority.value);
  }
  return Object.freeze(issued);
}

/** Slots whose transcript already landed — the duplicate/late guard's input. */
export function alreadyCapturedSlots(handle: RunDirHandle): ReadonlySet<string> {
  const directory = join(handle.runDirectory, "transcripts");
  if (!existsSync(directory)) return new Set();
  const captured = new Set<string>();
  for (const slot of readdirSync(directory)) {
    const slotDir = join(directory, slot);
    try {
      if (readdirSync(slotDir).some((file) => file.endsWith(".raw"))) captured.add(slot);
    } catch {
      // An unreadable slot directory proves nothing was captured there.
    }
  }
  return captured;
}

/**
 * Resolve the reservation this stop answers.
 *
 * Claude does not hand the request id back, so it is recovered by matching the
 * spawn-time correlator recorded alongside the reservation. A stop with no
 * matching correlator belongs to some other agent.
 */
export function resolveIdentity(
  handle: RunDirHandle,
  input: SubagentStopInput,
): HarnessResultIdentity | null {
  const agentId = input.agent_id;
  if (typeof agentId !== "string" || agentId.length === 0) return null;

  const correlators = join(handle.runDirectory, "requests", "correlators.json");
  const mapping = ((): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(correlators, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const entry = mapping[agentId];
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const requestId = record["requestId"];
  const attempt = record["attempt"];
  if (typeof requestId !== "string" || typeof attempt !== "number") return null;

  return Object.freeze({
    harness: "claude" as const,
    requestId,
    attempt,
    nativeId: agentId,
  });
}

/**
 * Capture one finished Claude agent. Pure with respect to decisions: every
 * refusal is returned as a typed outcome the caller audits, and only an
 * accepted capture writes anything.
 */
export async function captureClaudeResult(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
): Promise<CaptureOutcome> {
  if (runsRoot === undefined || runDirectory === undefined) return { kind: "not-an-orchestration-run" };

  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) return { kind: "rejected", reason: "run-directory", message: opened.error.message };
  const handle = opened.value;

  const identity = resolveIdentity(handle, input);
  if (identity === null) return { kind: "no-reservation", agentId: input.agent_id ?? "(missing)" };

  const payload = parseFinalPayload(
    claudeFinalPayloadCandidates(input.agent_transcript_path ?? ""),
  );
  if (!payload.ok) {
    return { kind: "rejected", reason: payload.error.reason, message: payload.error.message };
  }

  const bound = bindCapture({
    issued: readIssuedRequests(handle),
    identity,
    payload: payload.value,
    alreadyCaptured: alreadyCapturedSlots(handle),
  });
  if (!bound.ok) return { kind: "rejected", reason: bound.error.reason, message: bound.error.message };

  const request = readIssuedRequests(handle).find(({ requestId }) => requestId === bound.value.requestId);
  if (request === undefined) {
    return { kind: "rejected", reason: "unknown-request", message: "issued request vanished between binding and capture" };
  }
  const written = await handle.captureTranscript(request, payload.value.bytes);
  if (!written.ok) return { kind: "rejected", reason: "transcript", message: written.error.message };

  return { kind: "captured", receipt: bound.value };
}

const handler: HookHandler = async (stdin): Promise<HookResult> => {
  const input = ((): SubagentStopInput | null => {
    try {
      return JSON.parse(stdin) as SubagentStopInput;
    } catch {
      return null;
    }
  })();
  if (input === null) return { kind: "passthrough" };

  const outcome = await captureClaudeResult(
    input,
    process.env[RUNS_ROOT_ENV],
    process.env[RUN_DIR_ENV],
  );

  // Every non-capture is audited. A rejection must be visible: silence here
  // would look exactly like a run that had nothing to capture.
  if (outcome.kind === "rejected") {
    process.stderr.write(`capture-orchestration-result: rejected (${outcome.reason}): ${outcome.message}\n`);
  } else if (outcome.kind === "captured") {
    process.stderr.write(
      `capture-orchestration-result: captured ${outcome.receipt.requestId} (${outcome.receipt.byteLength} bytes)\n`,
    );
  }
  return { kind: "passthrough" };
};

export default handler;
