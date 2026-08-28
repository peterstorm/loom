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
import { parseReportSummary } from "./test-report";
export { judgeTestRun, type TrustedTestVerdict } from "./test-report";

// --- Branded agent identity ---

/**
 * Branded agent identity. The brand proves binding-encoding AND path
 * safety. The binding file is `\t`-separated lines and the epoch key is
 * `<agent_id>:<agent_type>` — an id containing whitespace or `:` would
 * desync the recorder's epoch from the reader's (epochOf), silently
 * degrading evidence. An agent TYPE also names the machine-definition file
 * (`<machinesDir>/<agent_type>.machine.json`), so `/`, `\`, and `..`
 * traversal would let hook input load a machine from OUTSIDE machinesDir —
 * a traversal-substituted permissive machine would defeat the gate. The
 * smart constructors below are the only producers, so every
 * AgentId/AgentType in the system is safe for both encodings by
 * construction.
 */
declare const AGENT_ID: unique symbol;
declare const AGENT_TYPE: unique symbol;
declare const GRANTED_AGENT_ID: unique symbol;
export type AgentId = string & { readonly [AGENT_ID]: true };
export type AgentType = string & { readonly [AGENT_TYPE]: true };

/**
 * The reserved namespace for write-grant capability identities.
 *
 * `AgentId` proves binding-encoding and path safety — NOT authorization. The
 * write gate nonetheless has to recognise the one identity that carries a
 * capability, because the grant record is burnt at consume time
 * (`consumePiWriteGrant` renames and deletes it) and cannot be re-checked
 * afterwards. Recognition is therefore only as trustworthy as the namespace is
 * exclusive: it is enforced at BOTH ends — `parseGrantedAgentId` is the sole
 * producer the gate accepts, and `parseReportedAgentId` is the sole
 * constructor for harness-reported ids, which refuses the namespace outright.
 */
export const WRITE_GRANT_AGENT_NAMESPACE = "pi-grant-";

/**
 * An agent identity inside the write-grant namespace. Distinct from `AgentId`
 * so "self-reported identity" and "identity that carries a write capability"
 * are different types at every call site that decides between them.
 */
export type GrantedAgentId = AgentId & { readonly [GRANTED_AGENT_ID]: true };

/**
 * Characters reserved by the binding-file and epoch encodings (whitespace,
 * `:`) plus the path separators that would escape machineDefPath (`/`, `\`).
 * `..` sequences are rejected separately below.
 */
const BINDING_UNSAFE = /[\s:/\\]/;

/**
 * The one binding-safety predicate behind both smart constructors below. An id
 * and a type are interpolated into the same file paths and the same
 * tab-separated ledger lines, so they answer to identical rules; two copies of
 * the predicate could drift and open one of the two.
 */
const bindingSafe = (raw: string): boolean =>
  raw !== "" && !BINDING_UNSAFE.test(raw) && !raw.includes("..");

/** Smart constructor: null when the raw id cannot be safely bound/attributed. */
export function parseAgentId(raw: string): AgentId | null {
  return bindingSafe(raw) ? (raw as AgentId) : null;
}

/**
 * Smart constructor for a HARNESS-REPORTED agent id — one that arrives as hook
 * input and was never proved to carry anything.
 *
 * Null for the reserved write-grant namespace, on top of the binding/path
 * rules. Both harnesses report an opaque `agent_id`, and the write gate reads
 * that id back off the `.active` roster; without this refusal a reported id
 * merely SHAPED like a grant identity would be indistinguishable from one the
 * grant flow minted, and would be granted Edit/Write with no grant ever having
 * been verified. Harness-boundary callers map the null to a non-authorizing
 * placeholder through `reportedRosterAgentId` in ledger.ts; `rosterAgentId`
 * deliberately preserves legitimate engine-minted grant identities.
 */
export function parseReportedAgentId(raw: string): AgentId | null {
  return raw.startsWith(WRITE_GRANT_AGENT_NAMESPACE) ? null : parseAgentId(raw);
}

/**
 * Smart constructor for a write-grant capability identity: null unless the id
 * is binding-safe AND inside the reserved namespace. The only legitimate
 * producer is the Pi write-grant consume path; the write gate accepts a write
 * capability on no other evidence.
 */
export function parseGrantedAgentId(raw: string): GrantedAgentId | null {
  if (!raw.startsWith(WRITE_GRANT_AGENT_NAMESPACE)) return null;
  const parsed = parseAgentId(raw);
  return parsed === null ? null : (parsed as GrantedAgentId);
}

/** Smart constructor: null when the raw type cannot be safely bound/attributed
 *  or safely name a machine-definition file. */
export function parseAgentType(raw: string): AgentType | null {
  return bindingSafe(raw) ? (raw as AgentType) : null;
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

/** The per-session binding file suffix — the presence of a `<session>.machine`
 * file is what marks a session as gated. Named so the gate's binding scan
 * (enforce-phase-tools) cannot drift from the suffix vocabulary below. */
export const MACHINE_SUFFIX = ".machine" as const;

/** The per-session call-start stamp file suffix — a small recency-ordered
 * JSON array of `{ id, startMs }` entries (harness tool_use_id →
 * call-start-ms), written at PreToolUse and consumed by
 * the report-freshness ordering check (a disk artifact may vouch only when
 * its mtime is at/after the START of the tool call being judged). */
export const CALL_START_SUFFIX = ".callstart.json" as const;

/** Engine-issued Pi run bindings available to the parent session's spawn hook. */
export const ORCHESTRATION_RUNS_SUFFIX = ".orchestration-runs.json" as const;

/** Claude implementation authority sidecars encode the reported Agent id
 * before this suffix; the stale-session sweep decodes the session prefix. */
export const IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX = ".implementation-attempt.json" as const;
export const TASK_GRAPH_POINTER_BINDING_SUFFIX = ".task-graph-pointer-binding.json" as const;
export const TASK_GRAPH_POINTER_LEASES_SUFFIX = ".task-graph-pointer-leases.json" as const;

/**
 * Every per-session file suffix written under SUBAGENT_DIR — the single
 * source of truth for the ledger's path helpers (ledger.ts) and the
 * SessionStart sweep's group detection (cleanup-stale-subagents). No suffix
 * here is itself a suffix of another, so suffix-matching a file name is
 * unambiguous regardless of iteration order.
 */
export const SESSION_SUFFIXES = [
  ".evidence.jsonl",
  MACHINE_SUFFIX,
  ".active",
  ".cleanup",
  ".task_graph",
  TASK_GRAPH_POINTER_LEASES_SUFFIX,
  CALL_START_SUFFIX,
  ORCHESTRATION_RUNS_SUFFIX,
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
] as const;

export type SessionFileSuffix = (typeof SESSION_SUFFIXES)[number];

// --- Call-start stamps (wire format: JSON array [{ id, startMs }, …], oldest first) ---

/**
 * Bound on retained call-start entries per session. Stamps are consumed by
 * the SAME call's PostToolUse, so only a handful need to survive — but
 * interleaved calls in a busy session must not evict each other instantly,
 * hence a bound comfortably above realistic concurrency instead of 1.
 */
export const CALL_START_CAP = 32;

/** One call-start stamp: the harness tool_use_id and the epoch-ms start. */
export interface CallStartEntry {
  readonly id: string;
  readonly startMs: number;
}

/**
 * Deserialization boundary for the call-start stamp file. Accepts exactly
 * what recordCallStart writes: a JSON ARRAY of `{ id, startMs }` entries in
 * recency order (oldest first) — an explicit ordering on the wire, not a
 * reliance on JS object key-ordering semantics. `id` is UNTRUSTED harness
 * text — it lives only inside the JSON payload, never in a filesystem path,
 * so any non-empty string is acceptable. Entries with a malformed id/stamp
 * are dropped (fail closed: a missing stamp only ever REJECTS artifacts); a
 * file that is not a JSON array at all — including the pre-array Record
 * shape — yields null so callers can log the corruption instead of silently
 * reading "no stamps".
 */
export function parseCallStartEntries(raw: string): readonly CallStartEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((entry): CallStartEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const o = entry as Record<string, unknown>;
    return typeof o.id === "string" &&
      o.id !== "" &&
      typeof o.startMs === "number" &&
      Number.isSafeInteger(o.startMs) &&
      o.startMs >= 0
      ? [{ id: o.id, startMs: o.startMs }]
      : [];
  });
}

/**
 * Keep only the LAST `cap` entries. The array is recency-ordered (oldest
 * first — recordCallStart removes any prior entry for the id and appends),
 * so slicing from the end drops the oldest stamps first.
 */
export function pruneCallStarts(
  entries: readonly CallStartEntry[],
  cap: number,
): readonly CallStartEntry[] {
  return entries.slice(Math.max(0, entries.length - cap));
}

/** The stamp for one tool call, or null when absent. Scanned from the END so
 *  a duplicate id (which recordCallStart never writes, but a hand-edited or
 *  merged file could) resolves to the most recent stamp. */
export function callStartOf(entries: readonly CallStartEntry[], toolUseId: string): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].id === toolUseId) return entries[i].startMs;
  }
  return null;
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
export function isBindingFresh(args: {
  readonly boundAtMs: number;
  readonly anchorMs: number;
  readonly nowMs: number;
  readonly ttlMs: number;
}): boolean {
  return args.nowMs - Math.max(args.boundAtMs, args.anchorMs) <= args.ttlMs;
}

// --- Evidence record parsing (parse, don't validate) ---

// Parse (not merely validate) a ledger `report` field: returns the RE-MINTED
// summary from the smart constructor, never the raw object. Embedding the raw
// `o.report` would let unknown extra fields ride inside a branded
// TestReportSummary and back out on re-serialization; the brand must mean
// "exactly what parseReportSummary built". Impossible counts (fractional/
// negative total, failed > total) yield null and never vouch.
function parseReportField(v: unknown): TestReportSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.source !== "vitest-json" && o.source !== "junit-xml") return null;
  return parseReportSummary(o.total, o.failed, o.source);
}

function parseEvent(raw: unknown): Evidence | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case "FileRead":
      return typeof o.path === "string" && o.path !== "" ? { kind: o.kind, path: o.path } : null;
    case "FileWrite": {
      if (typeof o.path !== "string" || o.path === "") return null;
      // Absent via = "tool" (old records — only tool writes were minted
      // historically); the parse boundary makes the default explicit so the
      // domain type carries `via` unconditionally. An UNRECOGNIZED via fails
      // closed to "shell": the write still vetoes/demotes but never advances
      // a guard — the fail-closed direction for both consumers.
      if (o.via === undefined) return { kind: o.kind, path: o.path, via: "tool" };
      const via = o.via === "tool" ? "tool" : "shell";
      return { kind: o.kind, path: o.path, via };
    }
    case "TestRun": {
      if (typeof o.command !== "string") return null;
      const exit = typeof o.exit === "number" ? o.exit : null;
      const report = parseReportField(o.report);
      return { kind: "TestRun", command: o.command, exit, report };
    }
    default:
      return null;
  }
}

export type EvidenceLineParse =
  | Readonly<{ ok: true; value: EvidenceRecord }>
  | Readonly<{ ok: false; error: string }>;

/** Parse one ledger line exactly. Corruption is data the reader must fail on, never absence. */
export function parseEvidenceLine(line: string): EvidenceLineParse {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: `evidence line is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Object.freeze({ ok: false, error: "evidence line must be an object" });
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.epoch !== "string") return Object.freeze({ ok: false, error: "evidence line epoch is missing" });
  const epoch = parseEpoch(o.epoch);
  if (epoch === null) return Object.freeze({ ok: false, error: "evidence line epoch is invalid" });
  const event = parseEvent(o.event);
  if (event === null) return Object.freeze({ ok: false, error: "evidence line event is invalid" });
  // callId is the optional idempotency stamp (harness tool_use_id) —
  // additive wire change: absent or non-string reads as "no stamp".
  const value = typeof o.callId === "string" && o.callId !== ""
    ? { epoch, event, callId: o.callId }
    : { epoch, event };
  return Object.freeze({ ok: true, value });
}

/**
 * Events attributable to one run — the fold boundary every reader (gate,
 * recorder veto, SubagentStop resolver) goes through. Duplicate DELIVERIES
 * are dropped here: a re-sent PostToolUse appends identical records, so a
 * record whose (callId, event) pair was already seen within the epoch is a
 * duplicate of the same tool call, never a second call (one call mints each
 * of its events at most once — shell targets are Set-deduped, one TestRun).
 * Records with NO callId (old ledgers, harnesses without tool_use_id) are
 * never deduplicated — absent evidence of duplication, keep everything.
 */
export function eventsForEpoch(records: readonly EvidenceRecord[], epoch: Epoch): Evidence[] {
  const seen = new Set<string>();
  const events: Evidence[] = [];
  for (const r of records) {
    if (r.epoch !== epoch) continue;
    if (r.callId !== undefined) {
      const key = JSON.stringify([r.callId, r.event]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    events.push(r.event);
  }
  return events;
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
  activeRoster: readonly AgentId[],
): MachineBinding | null {
  if (bindings.length !== 1) return null;
  if (activeRoster.length !== 1) return null;
  return activeRoster[0] === bindings[0].agentId ? bindings[0] : null;
}

// --- SessionRegistry port ---

/** Exact outcome of an attempted machine-binding capability release. */
export type MachineBindingRelease = "released" | "not-owned";

/**
 * The binding/active-roster/ledger lifecycle as a port, owned by the core.
 * The fs adapter (session-registry.ts) wraps the ledger's fs code; an
 * in-memory fake ships with the tests so the sole-active and
 * snapshot-before-unbind invariants are checkable as properties over
 * interleavings instead of only through tmpdirs. Production handlers depend
 * on this port (fsSessionRegistry is their default dependency), so a handler
 * core can run against the fake without tmpdirs.
 *
 * Every sessionId is the BRANDED SessionId: handlers parse hook input once at
 * their boundary (fail-closed) and thread the brand inward, so no adapter
 * re-validates and the fs path boundary cannot be reached with a raw id.
 */
export interface SessionRegistry {
  readonly bind: (sessionId: SessionId, agentType: AgentType, agentId: AgentId) => Promise<void>;
  readonly unbind: (
    sessionId: SessionId,
    agentType: AgentType,
    agentId: AgentId,
  ) => Promise<MachineBindingRelease>;
  readonly markActive: (sessionId: SessionId, agentId: AgentId) => Promise<void>;
  readonly removeActive: (sessionId: SessionId, agentId: AgentId) => Promise<void>;
  readonly countActiveAgents: (sessionId: SessionId) => number;
  readonly soleActiveBinding: (sessionId: SessionId) => MachineBinding | null;
  readonly refreshBindingActivity: (sessionId: SessionId) => Promise<void>;
  readonly readBindings: (sessionId: SessionId) => readonly MachineBinding[];
  readonly appendEvidence: (
    sessionId: SessionId,
    epoch: Epoch,
    events: readonly Evidence[],
    /** Idempotency stamp (harness tool_use_id) — see EvidenceRecord.callId. */
    callId?: string,
  ) => void;
  readonly readEvidence: (sessionId: SessionId) => readonly EvidenceRecord[];
  /**
   * Persist the call-start stamp for one tool call (PreToolUse). toolUseId
   * is untrusted harness text — implementations store it only inside the JSON
   * payload (a recency-ordered `{ id, startMs }` entry), never in a filesystem
   * path. Retention is bounded (CALL_START_CAP most-recent entries), so a stamp
   * is a short-lived fact, not a ledger.
   */
  readonly recordCallStart: (
    sessionId: SessionId,
    toolUseId: string,
    startMs: number,
  ) => Promise<void>;
  /** The call-start stamp for one tool call, or null when none was recorded
   *  (missing tool_use_id, no PreToolUse stamp hook, pruned, or corrupt file)
   *  — the consumer fails closed on null: disk artifacts cannot vouch. */
  readonly callStartFor: (sessionId: SessionId, toolUseId: string) => number | null;
}
