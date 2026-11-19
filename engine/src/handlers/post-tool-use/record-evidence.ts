/**
 * PostToolUse and PostToolUseFailure handler: record-evidence
 *
 * Claude Code fires PostToolUse only for a tool call that succeeded. A Bash
 * command that exits non-zero is a failed call and arrives as
 * PostToolUseFailure instead, so a failing test run, the red that I6 must
 * see, reaches the ledger only through that event.
 *
 * Appends ground-truth evidence records (facts only, epoch-stamped) to the
 * session's ledger — the deterministic core observes what happened at
 * execution time, never the agent's narrative about it.
 *
 * Records ONLY when attribution is sound (attributeEvidence, evidence.ts):
 * a call carrying `agent_id` — Claude Code stamps it on every hook fired
 * inside a subagent — is credited to THAT agent's own binding line, so
 * parallel bound subagents in one session each record into their own epoch.
 * A call without `agent_id` (main agent, older harness) falls back to the
 * sole-active rule: exactly one machine binding and the roster is exactly the
 * bound agent. Everything else records nothing, with a stderr note —
 * commingled evidence is worse than no evidence, because the SubagentStop
 * resolver treats ledger data as high-trust.
 *
 * Never blocks: the PreToolUse gate fails closed on missing evidence, and
 * the SubagentStop resolver labels a bound-but-empty ledger as degraded —
 * so a broken recorder surfaces downstream instead of silently passing.
 */

import { readFileSync, statSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler } from "../../types";
import { passthroughResult } from "../../types";
import {
  claudeToolCall,
  persistedBashOutput,
  withPersistedBashOutput,
  type ClaudeToolPayload,
  type PersistedBashOutput,
} from "../../core/harness-tool-call";
import { isRecord } from "../../core/plain-record";
import {
  attributeEvidence,
  type EvidenceAttribution,
  fsSessionRegistry,
  parseCallerIdentity,
  parseSessionId,
  recordToolEvidence,
  type SessionId,
  type SessionRegistry,
} from "../../machine";
import { isEngineCliScript } from "../../utils/engine-cli-path";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";

/** Why a call recorded nothing, as the audit line the operator sees; null
 *  for an ungated session (nothing was ever bound, nothing was lost). */
function standDownNotice(
  sessionId: SessionId,
  attribution: Exclude<EvidenceAttribution, { kind: "caller" | "sole" }>,
): string | null {
  const reason = match(attribution)
    .with({ kind: "ungated" }, () => null)
    .with({ kind: "corrupt" }, () => "machine binding authority has malformed rows")
    .with({ kind: "caller-unparseable" }, ({ raw }) =>
      `caller agent_id ${JSON.stringify(raw)} is reserved or path-unsafe — it cannot own a binding`)
    .with({ kind: "caller-unbound" }, ({ agentId }) =>
      `caller ${agentId} has no machine binding line — evidence is never credited to another agent`)
    .with({ kind: "caller-ambiguous" }, ({ agentId, bindings }) =>
      `caller ${agentId} owns ${bindings} binding lines — its epoch is ambiguous`)
    .with({ kind: "contended" }, () =>
      "call carries no agent_id and attribution is unsound (contended or leaked binding)")
    .exhaustive();
  return reason === null ? null : `record-evidence: standing down for ${sessionId} — ${reason}; nothing recorded\n`;
}

/** The hook payload: the identity fields this handler reads, plus the call
 *  fields `claudeToolCall` parses, declared once in `ClaudeToolPayload`. */
type RecordEvidenceInput = Readonly<{
  session_id?: string;
  /** Caller identity — set by Claude Code only inside a subagent. Untrusted:
   *  parsed by parseCallerIdentity, never used raw. */
  agent_id?: unknown;
  tool_name?: string;
  cwd?: string;
}> & Omit<ClaudeToolPayload, "tool_name" | "cwd">;

const stringOrAbsent = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Read the hook payload from parsed JSON, or `null` when it is not a JSON
 * object. An identity field that is not a string reads as absent; the call
 * fields stay untyped for `claudeToolCall`, which parses each one.
 */
export function parseRecordEvidenceInput(raw: unknown): RecordEvidenceInput | null {
  if (!isRecord(raw)) return null;
  return {
    ...raw,
    session_id: stringOrAbsent(raw.session_id),
    tool_name: stringOrAbsent(raw.tool_name),
    cwd: stringOrAbsent(raw.cwd),
  };
}

/** The largest spilled Bash output the recorder reads back. A test run's
 *  output is far below it; a larger file is left unread. */
const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1024 * 1024;

/** What reading a spilled Bash output's file found: its text when the file
 *  holds exactly the bytes the harness reported, else why not. */
export type PersistedOutputRead =
  | Readonly<{ kind: "read"; text: string }>
  | Readonly<{ kind: "over-cap" }>
  | Readonly<{ kind: "size-mismatch"; actualBytes: number }>
  | Readonly<{ kind: "unreadable"; error: string }>;

export type ReadPersistedOutput = (spill: PersistedBashOutput) => PersistedOutputRead;

export const readPersistedOutputFile: ReadPersistedOutput = (spill) => {
  if (spill.bytes > MAX_PERSISTED_OUTPUT_BYTES) return { kind: "over-cap" };
  try {
    const actualBytes = statSync(spill.path).size;
    if (actualBytes !== spill.bytes) return { kind: "size-mismatch", actualBytes };
    return { kind: "read", text: readFileSync(spill.path, "utf8") };
  } catch (e) {
    return { kind: "unreadable", error: e instanceof Error ? e.message : String(e) };
  }
};

/** Why a spill was not restored, as the stderr note names it. */
const unrestoredCause = (read: PersistedOutputRead): string =>
  match(read)
    .with({ kind: "read" }, () => "the file does not begin with the output the harness kept")
    .with({ kind: "over-cap" }, () => `it is over the ${MAX_PERSISTED_OUTPUT_BYTES}-byte read-back cap`)
    .with({ kind: "size-mismatch" }, ({ actualBytes }) => `the file now holds ${actualBytes} bytes`)
    .with({ kind: "unreadable" }, ({ error }) => `the file is unreadable: ${error}`)
    .exhaustive();

/**
 * The payload whose Bash output Claude Code spilled to a file, with the whole
 * output restored from it, so a receipt on the output's last line reaches the
 * minting rule (loom#241). A spill that cannot be restored keeps the head and
 * says why on stderr: the call then mints no engine-run TestRun, and the
 * agent's next run of the same files is the remedy.
 */
function restoreSpilledOutput(payload: ClaudeToolPayload, read: ReadPersistedOutput): ClaudeToolPayload {
  const spill = persistedBashOutput(payload);
  if (spill === null) return payload;
  const found = read(spill);
  const restored = found.kind === "read" ? withPersistedBashOutput(payload, found.text) : null;
  if (restored !== null) return restored;
  process.stderr.write(
    `record-evidence: Claude Code spilled this Bash output (${spill.bytes} bytes) to ${spill.path}, but it could not be read back whole (${unrestoredCause(found)}); only its first ${spill.head.length} characters were recorded\n`,
  );
  return payload;
}

export const runRecordEvidence = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
  readPersistedOutput: ReadPersistedOutput = readPersistedOutputFile,
) => {
  try {
    if (!stdin || stdin.trim() === "") return passthroughResult();
    const raw: unknown = JSON.parse(stdin);
    const input = parseRecordEvidenceInput(raw);
    if (input === null) return passthroughDiagnostic("record-evidence: hook input is not a JSON object — nothing recorded\n");

    const toolName = input.tool_name;
    if (!input.session_id || !toolName) return passthroughResult();
    // Parse the session id once at this boundary. A present-but-unparseable id
    // can address no ledger file — say so (it may signal an attack or a bug)
    // and stand down, exactly as the old in-ledger throw+catch did.
    const sessionId = parseSessionId(input.session_id);
    if (sessionId === null) {
      return passthroughDiagnostic(`record-evidence: invalid session id ${JSON.stringify(input.session_id)} — nothing recorded\n`);
    }

    // Recorder activity keeps a live binding fresh (and reaps expired ones)
    // — no-op for ungated sessions (no binding file, no lock taken).
    await registry.refreshBindingActivity(sessionId);

    const attribution = attributeEvidence(
      parseCallerIdentity(input.agent_id),
      registry.readBindingAuthority(sessionId),
      registry.readActiveRoster(sessionId),
    );
    if (attribution.kind !== "caller" && attribution.kind !== "sole") {
      // Bound-but-unattributable: say so, like the gate does — a silently
      // standing-down recorder is indistinguishable from a broken one.
      // Ungated sessions (no live binding) stay quiet.
      const notice = standDownNotice(sessionId, attribution);
      if (notice !== null) process.stderr.write(notice);
      return passthroughResult();
    }
    const { binding } = attribution;

    // Normalize the hook payload and hand it to the ONE minting shell shared
    // with the Pi recorder (INV-4): report discovery with the
    // agent-authored-artifact veto and the call-start stamp, mint-time path
    // resolution and the append all live there. On Claude Code the stamp was
    // written under the hook session itself (PreToolUse guard-state-file).
    // Known residual: writes with no static target in the command text — a
    // file authored by an interpreter (`python -c 'open(...)'`), `dd of=` —
    // mint nothing and can still stage an artifact.
    const payload = restoreSpilledOutput({ ...input, tool_name: toolName, cwd: input.cwd ?? process.cwd() }, readPersistedOutput);
    recordToolEvidence(
      { kind: "record", ledger: sessionId, epoch: binding.epoch, stamps: sessionId },
      claudeToolCall(payload),
      { registry, nowMs: Date.now, isEngineCli: isEngineCliScript },
    );

    return passthroughResult();
  } catch (e) {
    // Fail-open (never block) — but this catch wraps JSON.parse,
    // refreshBindingActivity, extractEvidence, readEvidence and appendEvidence,
    // so anything landing here is an UNEXPECTED handler exception (a
    // programming error or an fs-write failure), NOT one of the expected
    // no-evidence stand-downs above. Flag it as such so a genuine bug is
    // distinguishable from benign "nothing recorded" in the logs.
    return passthroughDiagnostic(`record-evidence: UNEXPECTED handler exception — evidence for this call may be lost (failing open): ${e instanceof Error ? e.message : String(e)}\n`);
  }
};

const handler: HookHandler = (stdin) => runRecordEvidence(stdin);

export default handler;
