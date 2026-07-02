/**
 * Pure half of the evidence ledger: identity brands, binding-line and
 * ledger-line parsing, epoch attribution, and the SessionRegistry port.
 *
 * No I/O lives here — every function is `(data) => data`. The imperative
 * shell (ledger.ts) owns the files and locks and re-uses these parsers, so
 * the pure reducer (advance.ts and friends) can be imported without ever
 * transitively touching node:fs.
 */

import type { Epoch, Evidence, EvidenceRecord, TestReportSummary } from "./types";

// --- Branded agent identity ---

/**
 * Branded agent identity. The binding file is `\t`-separated lines and the
 * epoch key is `<agent_id>:<agent_type>` — an id containing `\t`, `\n`,
 * `\r`, or `:` would desync the recorder's epoch from the reader's
 * (epochOf), silently degrading evidence. The smart constructors below are
 * the only producers, so every AgentId/AgentType in the system is
 * serialization-safe by construction.
 */
declare const AGENT_ID: unique symbol;
declare const AGENT_TYPE: unique symbol;
export type AgentId = string & { readonly [AGENT_ID]: true };
export type AgentType = string & { readonly [AGENT_TYPE]: true };

/** Characters reserved by the binding-file and epoch encodings. */
const BINDING_UNSAFE = /[\t\n\r:]/;

/** Smart constructor: null when the raw id cannot be safely bound/attributed. */
export function parseAgentId(raw: string): AgentId | null {
  return raw !== "" && !BINDING_UNSAFE.test(raw) ? (raw as AgentId) : null;
}

/** Smart constructor: null when the raw type cannot be safely bound/attributed. */
export function parseAgentType(raw: string): AgentType | null {
  return raw !== "" && !BINDING_UNSAFE.test(raw) ? (raw as AgentType) : null;
}

// --- Branded session identity ---

/**
 * Branded session identity. Session ids are interpolated into SUBAGENT_DIR
 * file paths (`<session>.evidence.jsonl`, `<session>.machine`, …) — a raw
 * id containing a path separator, a `..` traversal, or whitespace would let
 * hook input address files outside the subagent dir. The smart constructor
 * is the only producer, mirroring parseAgentId.
 */
declare const SESSION_ID: unique symbol;
export type SessionId = string & { readonly [SESSION_ID]: true };

/** Characters/sequences that would escape the SUBAGENT_DIR path encoding. */
const SESSION_UNSAFE = /[/\\\s]|\.\./;

/** Smart constructor: null when the raw id cannot safely name session files. */
export function parseSessionId(raw: string): SessionId | null {
  return raw !== "" && !SESSION_UNSAFE.test(raw) ? (raw as SessionId) : null;
}

// --- Bindings (wire format: "<agent_id>\t<agent_type>\t<bound_at_ms>") ---

export interface MachineBinding {
  readonly agentId: AgentId;
  readonly agentType: AgentType;
  /** Attribution key stamped on every evidence record of this run. */
  readonly epoch: Epoch;
}

/** A binding as persisted on disk: the binding plus its bind-time stamp. */
export interface PersistedBinding {
  readonly binding: MachineBinding;
  /** Epoch-ms timestamp minted when the binding was written. */
  readonly boundAtMs: number;
}

export const epochOf = (agentId: AgentId, agentType: AgentType): Epoch =>
  `${agentId}:${agentType}` as Epoch;

/**
 * Deserialization boundary for epochs read back from ledger lines. Accepts
 * exactly what epochOf produces: `<agent_id>:<agent_type>` where both
 * halves satisfy their smart constructors (AgentId cannot contain `:`, so
 * a valid epoch has exactly one). Anything else is corrupt and yields null.
 */
export function parseEpoch(raw: string): Epoch | null {
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  const agentId = parseAgentId(raw.slice(0, idx));
  const agentType = parseAgentType(raw.slice(idx + 1));
  return agentId !== null && agentType !== null ? (raw as Epoch) : null;
}

/**
 * Parse one binding-file line. Null for malformed lines: wrong field count,
 * fields the smart constructors reject, or a bind stamp that is not a
 * non-negative integer. Callers count nulls loudly — a binding file that
 * silently parses to zero bindings would open the gate.
 */
export function parseBindingLine(line: string): PersistedBinding | null {
  const fields = line.split("\t");
  if (fields.length !== 3) return null;
  const agentId = parseAgentId(fields[0]);
  const agentType = parseAgentType(fields[1]);
  if (!agentId || !agentType) return null;
  if (!/^\d+$/.test(fields[2])) return null;
  const boundAtMs = Number(fields[2]);
  if (!Number.isSafeInteger(boundAtMs)) return null;
  return { binding: { agentId, agentType, epoch: epochOf(agentId, agentType) }, boundAtMs };
}

/** Serialize a binding for the binding file (inverse of parseBindingLine). */
export function formatBindingLine(binding: MachineBinding, boundAtMs: number): string {
  return `${binding.agentId}\t${binding.agentType}\t${boundAtMs}`;
}

/**
 * Binding liveness: a binding is fresh while its last observed activity —
 * the bind stamp or the binding file's activity anchor (mtime, touched by
 * the gate and the recorder on every SESSION tool call — tool calls carry
 * no agent identity), whichever is later — is within the TTL. This is
 * session-activity liveness, not per-agent liveness: a subagent that dies
 * without its SubagentStop hook keeps a fresh binding while the parent
 * session stays active, and expires only after the whole session idles
 * past the TTL — bounded recovery instead of gating the session forever.
 */
export function isBindingFresh(
  boundAtMs: number,
  anchorMs: number,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - Math.max(boundAtMs, anchorMs) <= ttlMs;
}

// --- Evidence record parsing (parse, don't validate) ---

function isReportSummary(v: unknown): v is TestReportSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.total === "number" &&
    typeof o.failed === "number" &&
    (o.source === "vitest-json" || o.source === "junit-xml")
  );
}

function parseEvent(raw: unknown): Evidence | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case "FileRead":
    case "FileWrite":
      return typeof o.path === "string" && o.path !== "" ? { kind: o.kind, path: o.path } : null;
    case "TestRun": {
      if (typeof o.command !== "string") return null;
      const exit = typeof o.exit === "number" ? o.exit : null;
      const report = isReportSummary(o.report) ? o.report : null;
      return { kind: "TestRun", command: o.command, exit, report };
    }
    default:
      return null;
  }
}

/** Parse one ledger line. Unknown/corrupt lines yield null and are skipped. */
export function parseEvidenceLine(line: string): EvidenceRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.epoch !== "string") return null;
  const epoch = parseEpoch(o.epoch);
  if (epoch === null) return null;
  const event = parseEvent(o.event);
  return event ? { epoch, event } : null;
}

/** Events attributable to one run. */
export function eventsForEpoch(records: readonly EvidenceRecord[], epoch: Epoch): Evidence[] {
  return records.filter((r) => r.epoch === epoch).map((r) => r.event);
}

/**
 * The sole-active attribution rule, as one pure decision shared by the fs
 * adapter (ledger.ts) and the in-memory test fake: evidence may be
 * attributed ONLY when exactly one machine binding exists AND the active
 * roster contains exactly the bound agent. An EMPTY roster is a leaked
 * binding shape (the bound agent's roster entry is gone but its binding
 * survived) — attributing session activity to it would credit whoever is
 * actually running, so it stands down like any other contention.
 */
export function resolveSoleActiveBinding(
  bindings: readonly MachineBinding[],
  activeRoster: readonly string[],
): MachineBinding | null {
  if (bindings.length !== 1) return null;
  if (activeRoster.length !== 1) return null;
  return activeRoster[0] === bindings[0].agentId ? bindings[0] : null;
}

// --- SessionRegistry port ---

/**
 * The binding/active-roster/ledger lifecycle as a port, owned by the core.
 * The production adapter (session-registry.ts) is the ledger's fs code; an
 * in-memory fake ships with the tests so the sole-active and
 * snapshot-before-unbind invariants are checkable as properties over
 * interleavings instead of only through tmpdirs.
 */
export interface SessionRegistry {
  readonly bind: (sessionId: string, agentType: AgentType, agentId: AgentId) => Promise<void>;
  readonly unbind: (sessionId: string, agentType: string, agentId: string) => Promise<void>;
  readonly markActive: (sessionId: string, agentId: AgentId) => Promise<void>;
  readonly removeActive: (sessionId: string, agentId: string) => Promise<void>;
  readonly countActiveAgents: (sessionId: string) => number;
  readonly soleActiveBinding: (sessionId: string) => MachineBinding | null;
  readonly appendEvidence: (sessionId: string, epoch: Epoch, events: readonly Evidence[]) => void;
  readonly readEvidence: (sessionId: string) => EvidenceRecord[];
}
