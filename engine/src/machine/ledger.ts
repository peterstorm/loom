/**
 * Evidence ledger + machine binding — the imperative shell around the
 * pure reducer. Line parsing and epoch attribution are pure and live in
 * evidence.ts; this module owns the files and the locks.
 *
 * Per session under SUBAGENT_DIR (the full suffix vocabulary is
 * SESSION_SUFFIXES in evidence.ts):
 *   <session>.evidence.jsonl  — append-only { epoch, event } records
 *   <session>.machine         — one "<agent_id>\t<agent_type>\t<bound_at_ms>"
 *                               line per active machine-gated subagent
 *   <session>.active          — active-subagent roster (attribution)
 *   <session>.cleanup         — cleanup lock marker
 *   <session>.task_graph      — per-session task-graph binding (sessionScopedPath)
 *   <session>.callstart.json  — recency-ordered call-start stamps
 *                               (recordCallStart / callStartFor)
 *
 * Epochs make attribution structural: every evidence line is stamped with
 * the binding's epoch (`<agent_id>:<agent_type>`), and readers fold only
 * their own epoch — a stale line from a crashed run or a parallel agent is
 * inert instead of cross-credited. Because the harness gives PostToolUse no
 * agent identity, evidence is recorded ONLY while exactly one subagent is
 * active and exactly one machine is bound (soleActiveBinding); in contended
 * sessions both the recorder and the gate stand down.
 *
 * Binding liveness (SESSION-activity TTL, not per-agent liveness): a
 * binding is normally released by SubagentStop, but a gated subagent that
 * dies without the hook firing must not gate the session forever. Each
 * binding line carries its bind stamp; the binding file's mtime is the
 * activity anchor, refreshed (refreshBindingActivity) on EVERY tool call
 * the gate or recorder sees for the session — tool calls carry no agent
 * identity, so any session activity (including the parent's) keeps every
 * binding fresh. A dead subagent's binding therefore expires only once the
 * whole session has been idle past STALE_SUBAGENT_TTL_MS — the same TTL
 * the SessionStart sweep uses — after which readBindings treats it as
 * absent and it is reaped under the binding lock.
 *
 * Bind/unbind are read-modify-write on the binding file and take the same
 * per-session lock the .active cleanup uses — callers must NOT hold that
 * lock when calling them.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { STALE_SUBAGENT_TTL_MS, subagentDir } from "../config";
import { withLock } from "../utils/lock";
import { parseMachineJson } from "./parse-machine";
import {
  type AgentId,
  type AgentType,
  type MachineBinding,
  type PersistedBinding,
  type SessionFileSuffix,
  type SessionId,
  type CallStartEntry,
  CALL_START_CAP,
  CALL_START_SUFFIX,
  callStartOf,
  epochOf,
  parseCallStartEntries,
  pruneCallStarts,
  formatBindingLine,
  isBindingFresh,
  parseAgentId,
  parseAgentType,
  parseBindingLine,
  parseReportedAgentId,
  parseEvidenceLine,
  resolveSoleActiveBinding,
} from "./evidence";
import type { Epoch, Evidence, EvidenceRecord, MachineDef } from "./types";

/**
 * The single path-construction boundary for session files. It takes the
 * BRANDED SessionId, whose sole producer (parseSessionId) already refused
 * separators, `..` traversal, and whitespace — so an id that reaches here
 * cannot address files outside SUBAGENT_DIR. The old runtime throw for an
 * unvalidated id is now unreachable-by-type: every caller parses hook input
 * at its own boundary (fail-closed there) and threads SessionId inward.
 */
function sessionFilePath(sessionId: SessionId, suffix: string): string {
  return `${subagentDir()}/${sessionId}${suffix}`;
}

export const ledgerPath = (sessionId: SessionId): string =>
  sessionFilePath(sessionId, ".evidence.jsonl");

export const machineBindingPath = (sessionId: SessionId): string =>
  sessionFilePath(sessionId, ".machine");

const activeFlagPath = (sessionId: SessionId): string => sessionFilePath(sessionId, ".active");

const bindingLock = (sessionId: SessionId): string => sessionFilePath(sessionId, ".cleanup");

/**
 * Session-scoped path for callers OUTSIDE this module (task-graph pointer,
 * active-flag reads). Takes the BRANDED SessionId so raw hook input must go
 * through parseSessionId first — callers fail closed (loudly) on a parse
 * failure instead of interpolating an unvalidated id into SUBAGENT_DIR.
 * Reuses sessionFilePath so the throwing parse boundary stays singular
 * (it cannot throw for a branded id).
 */
export function sessionScopedPath(sessionId: SessionId, suffix: SessionFileSuffix): string {
  return sessionFilePath(sessionId, suffix);
}

/**
 * Full-file rewrite via temp-file + rename in the SAME directory: readers
 * take no lock, so an in-place writeFileSync could expose a torn (partial)
 * file mid-write. rename(2) is atomic on the same filesystem — a reader
 * sees the old content or the new, never a prefix. Appends stay plain
 * appendFileSync (single O_APPEND writes; the parsers skip a torn tail
 * line loudly).
 */
function rewriteFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// --- Bindings ---

/** One raw binding-file line classified for liveness decisions. */
type ClassifiedLine =
  | { readonly kind: "fresh"; readonly raw: string; readonly persisted: PersistedBinding }
  | { readonly kind: "stale"; readonly raw: string; readonly persisted: PersistedBinding }
  | { readonly kind: "malformed"; readonly raw: string };

/**
 * Read + classify every line of the binding file against the liveness TTL.
 * The activity anchor is the file's mtime (touched by refreshBindingActivity
 * on gate/recorder activity); the bind stamp is the lower bound.
 */
function classifyBindingLines(sessionId: SessionId, nowMs: number): ClassifiedLine[] {
  const path = machineBindingPath(sessionId);
  try {
    const anchorMs = statSync(path).mtimeMs;
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((raw): ClassifiedLine => {
        const persisted = parseBindingLine(raw);
        if (persisted === null) return { kind: "malformed", raw };
        return isBindingFresh({ boundAtMs: persisted.boundAtMs, anchorMs, nowMs, ttlMs: STALE_SUBAGENT_TTL_MS })
          ? { kind: "fresh", raw, persisted }
          : { kind: "stale", raw, persisted };
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `cannot read machine binding file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse the binding file. Malformed lines — wrong field count, fields the
 * smart constructors reject, or a bad bind stamp — are skipped (and count as
 * noise, not bindings) loudly, mirroring readEvidence: a binding file that
 * silently parses to zero bindings would open the gate. Bindings whose last
 * activity exceeds the TTL are treated as ABSENT (their subagent plausibly
 * died without SubagentStop) — refreshBindingActivity reaps them.
 */
export function readBindings(sessionId: SessionId, nowMs: number = Date.now()): readonly MachineBinding[] {
  const lines = classifyBindingLines(sessionId, nowMs);
  const malformed = lines.filter((l) => l.kind === "malformed").length;
  if (malformed > 0) {
    process.stderr.write(`readBindings: skipped ${malformed} malformed binding line(s) for ${sessionId}\n`);
  }
  const stale = lines.filter((l) => l.kind === "stale").length;
  if (stale > 0) {
    process.stderr.write(`readBindings: ignored ${stale} stale binding(s) for ${sessionId} (no activity within TTL)\n`);
  }
  return lines.flatMap((l) => (l.kind === "fresh" ? [l.persisted.binding] : []));
}

/**
 * One roster entry. A line is `<agentId>` or `<agentId>\t<agentType>`; the
 * type column is optional because not every producer knows the type (Pi's
 * write-grant children mark the roster with a `pi-grant-` id and no type) and
 * because rosters written before the column existed must keep parsing.
 */
export type ActiveAgent = Readonly<{ agentId: AgentId; agentType: AgentType | null }>;

/** Column 0 of a roster line — the identity every existing reader means. */
const rosterLineAgentId = (line: string): AgentId => rosterAgentId(line.split("\t")[0]!.trim());

function readActiveAgentEntries(sessionId: SessionId): ActiveAgent[] {
  const path = activeFlagPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const [, rawType] = line.split("\t");
      const trimmedType = rawType?.trim() ?? "";
      return Object.freeze({
        // Re-parse through the SAME producer that wrote the roster
        // (rosterAgentId), so the read-back carries the AgentId brand instead
        // of a raw string and the sole-active comparison in
        // resolveSoleActiveBinding stays brand-to-brand. Mapping (not
        // dropping) preserves the count: rosterAgentId is total and idempotent
        // on already-written lines, so a corrupt line can never silently
        // shrink the roster into a false 2→1 attribution.
        agentId: rosterLineAgentId(line),
        // An absent or unparseable type is null, never a guess: callers that
        // authorize on type must fall back rather than trust a repaired value.
        agentType: trimmedType === "" ? null : parseAgentType(trimmedType),
      });
    });
}

/**
 * Active agents with the role each is serving.
 *
 * The roster's original job was to COUNT agents, so it stored identity alone.
 * Authorization needs the ROLE: on Claude Code `agent_id` is an opaque handle
 * (`a339f6fd51d78b179`), which no set of agent-type names can ever match.
 */
export function readActiveAgentRoles(sessionId: SessionId): readonly ActiveAgent[] {
  return Object.freeze(readActiveAgentEntries(sessionId));
}

function readActiveAgents(sessionId: SessionId): AgentId[] {
  return readActiveAgentEntries(sessionId).map(({ agentId }) => agentId);
}

/** Number of agents currently on the session's `.active` roster. */
export function countActiveAgents(sessionId: SessionId): number {
  return readActiveAgents(sessionId).length;
}

/**
 * Is any subagent active FOR THIS TASK GRAPH?
 *
 * SUBAGENT_DIR is global and shared by every project on the machine, while a
 * reservation belongs to one task graph. A project-blind answer therefore lets
 * a live agent in project A veto reservation recovery in project B — and lets
 * any stray `.active` file veto it everywhere, forever. Scope the question with
 * the `<session>.task_graph` pointer mark-subagent-active already writes.
 *
 * Per roster, by the pointer beside it:
 *   - resolves to THIS graph  → active (proven to be serving this project)
 *   - resolves elsewhere      → not ours
 *   - absent (ENOENT)         → not ours; "bound to no graph" is a real answer,
 *                               which is what stops stray rosters vetoing
 *   - unreadable (any other)  → active (fail closed: cannot disprove it's ours)
 *
 * The ENOENT-vs-error split is load-bearing: absence is evidence, failure is
 * not. A directory that cannot be read at all is likewise fail-closed.
 */
export function anyActiveSubagent(taskGraphPath: string): boolean {
  const wanted = resolve(taskGraphPath);
  let entries: readonly string[];
  try {
    entries = readdirSync(subagentDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    process.stderr.write(
      `anyActiveSubagent: cannot read ${subagentDir()} (${e instanceof Error ? e.message : String(e)}) — assuming a subagent is active (fail closed)\n`,
    );
    return true;
  }
  return entries.filter((name) => name.endsWith(".active")).some((name) => {
    const session = name.slice(0, -".active".length);
    try {
      if (statSync(`${subagentDir()}/${name}`).size === 0) return false;
    } catch (e) {
      // A roster we cannot stat may be a live agent.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true;
      return false;
    }
    try {
      return resolve(readFileSync(`${subagentDir()}/${session}.task_graph`, "utf-8").trim()) === wanted;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      process.stderr.write(
        `anyActiveSubagent: cannot read the task-graph pointer for ${session} (${e instanceof Error ? e.message : String(e)}) — assuming it serves this graph (fail closed)\n`,
      );
      return true;
    }
  });
}

/**
 * The binding evidence may be attributed to, or null when attribution is
 * impossible. The decision itself is the pure resolveSoleActiveBinding
 * (evidence.ts) — exactly one fresh binding AND a roster of exactly the
 * bound agent; anything else (contention, a leaked binding over an empty
 * or foreign roster) stands down. This adapter only supplies the files.
 */
export function soleActiveBinding(sessionId: SessionId, nowMs: number = Date.now()): MachineBinding | null {
  return resolveSoleActiveBinding(readBindings(sessionId, nowMs), readActiveAgents(sessionId));
}

/**
 * Settle binding liveness for a session (locked): reap stale binding lines
 * — deleting the file when nothing else remains — and, when fresh bindings
 * survive, touch the file's mtime so their activity anchor advances. The
 * gate and the recorder call this on every tool call they see for the
 * session; tool calls carry no agent identity, so this is SESSION-activity
 * liveness: any activity (the parent's included) keeps every binding
 * fresh, and a dead subagent's binding expires only after the whole
 * session idles past STALE_SUBAGENT_TTL_MS. Malformed lines are preserved:
 * they are the fail-closed evidence of a corrupt binding file, never
 * silently laundered away by a reap.
 */
export async function refreshBindingActivity(sessionId: SessionId, nowMs: number = Date.now()): Promise<void> {
  const path = machineBindingPath(sessionId);
  try {
    statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `cannot inspect machine binding file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await withLock(bindingLock(sessionId), () => {
    const lines = classifyBindingLines(sessionId, nowMs);
    const stale = lines.filter((l) => l.kind === "stale");
    const kept = lines.filter((l) => l.kind !== "stale");
    if (stale.length > 0) {
      process.stderr.write(
        `refreshBindingActivity: reaped ${stale.length} stale binding(s) for ${sessionId}\n`,
      );
      if (kept.length === 0) {
        unlinkSync(path);
        return;
      }
      rewriteFileAtomic(path, kept.map((l) => l.raw).join("\n") + "\n");
    }
    if (kept.some((l) => l.kind === "fresh")) {
      const anchor = new Date(nowMs);
      utimesSync(path, anchor, anchor);
    }
  });
}

/**
 * Roster identity for a raw agent_id, INCLUDING ids the bind boundary
 * rejects. The machine binding must refuse an id with reserved characters —
 * but the `.active` roster exists to COUNT agents (soleActiveBinding), and
 * an agent missing from it runs invisibly: alongside one validly-bound
 * agent the roster still counts 1, so the rogue agent's tool calls
 * (including trusted TestRun evidence) get cross-credited into the bound
 * epoch. Valid ids pass through unchanged; a rejected id maps to a
 * deterministic `unparseable-<hex digest>` placeholder that itself
 * satisfies the roster line format, keeping markAgentActive /
 * removeActiveAgent symmetric for the agent's start and stop hooks.
 *
 * This is the roster LINE codec — total, idempotent on already-written lines,
 * and deliberately namespace-preserving, because it also reads back the
 * `pi-grant-` identities the write-grant flow legitimately wrote. Untrusted,
 * harness-reported ids must go through `reportedRosterAgentId` instead.
 */
export function rosterAgentId(raw: string): AgentId {
  return placeholderOnNull(raw, parseAgentId(raw));
}

/**
 * Roster identity for a HARNESS-REPORTED `agent_id` — one that arrives as hook
 * input from SubagentStart/SubagentStop and was never proved to carry anything.
 *
 * Identical to `rosterAgentId` except that the reserved write-grant namespace
 * is refused along with binding-unsafe ids. The write gate authorizes on the
 * roster's identity column, so a reported id merely SHAPED like a grant
 * identity landing there verbatim would hand out Edit/Write with no grant ever
 * consumed. The placeholder absorbs it: the agent is still COUNTED — all the
 * roster owes attribution — under an id that authorizes nothing. Start and stop
 * derive the same placeholder from the same raw id, so removal stays symmetric.
 */
export function reportedRosterAgentId(raw: string): AgentId {
  return placeholderOnNull(raw, parseReportedAgentId(raw));
}

/** Deterministic, binding-safe stand-in for an id its constructor refused. */
function placeholderOnNull(raw: string, parsed: AgentId | null): AgentId {
  if (parsed !== null) return parsed;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const placeholder = parseReportedAgentId(`unparseable-${digest}`);
  if (placeholder === null) {
    throw new Error("unreachable: hex placeholder is binding-safe by construction");
  }
  return placeholder;
}

/**
 * Append an agent to the session's `.active` roster under the SAME lock
 * cleanup takes to rewrite it — an unlocked append racing a cleanup rewrite
 * could be lost, leaving attribution counting a ghost (or missing) agent.
 * SET semantics keyed by agentId (idempotent): a duplicated SubagentStart
 * delivery must not put the same agent on the roster twice — a double entry
 * makes soleActiveBinding stand down for the rest of the run (roster count
 * 2 ≠ 1), silently disarming the recorder and the gate's evidence fold.
 */
export async function markAgentActive(
  sessionId: SessionId,
  agentId: AgentId,
  agentType: AgentType | null = null,
): Promise<void> {
  mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
  await withLock(bindingLock(sessionId), () => {
    const path = activeFlagPath(sessionId);
    if (existsSync(path)) {
      // Identity is column 0: a re-marked agent must be recognised as a
      // duplicate whether or not the earlier line recorded a type.
      const already = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .some((l) => rosterLineAgentId(l) === agentId);
      if (already) {
        process.stderr.write(
          `markAgentActive: ${agentId} already on the roster for ${sessionId} — duplicate SubagentStart ignored\n`,
        );
        return;
      }
    }
    // The type column is what lets PreToolUse authorize by ROLE. Omitting it
    // (unknown type) is safe but downgrades the agent to identity-only
    // authorization, which only the `pi-grant-` prefix satisfies.
    appendFileSync(path, agentType === null ? `${agentId}\n` : `${agentId}\t${agentType}\n`);
  });
}

function removeActiveRosterEntry(path: string, agentId: AgentId): void {
  // Match on column 0 so an entry that recorded a type is still removed by
  // its id alone — markAgentActive/removeActiveAgent must stay symmetric
  // across the agent's start and stop hooks.
  const remaining = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "" && rosterLineAgentId(line) !== agentId)
    .join("\n");
  if (remaining.trim() === "") unlinkSync(path);
  else rewriteFileAtomic(path, remaining + "\n");
}

/**
 * Remove one agent from the session's `.active` roster and propagate failure.
 * Spawn admission uses this strict form when a denied Agent's role-bearing row
 * must be proven absent before the Hook returns.
 */
export async function removeActiveAgentStrict(sessionId: SessionId, agentId: AgentId): Promise<void> {
  const path = activeFlagPath(sessionId);
  if (!existsSync(path)) return;
  await withLock(bindingLock(sessionId), () => removeActiveRosterEntry(path, agentId));
}

/**
 * Completion cleanup preserves its historical failure split: a rewrite error
 * is logged, while lock acquisition failure escapes to dispatch isolation.
 */
export async function removeActiveAgent(sessionId: SessionId, agentId: AgentId): Promise<void> {
  const path = activeFlagPath(sessionId);
  if (!existsSync(path)) return;
  await withLock(bindingLock(sessionId), () => {
    try {
      removeActiveRosterEntry(path, agentId);
    } catch (error) {
      process.stderr.write(`removeActiveAgent: .active update failed for ${sessionId}: ${error}\n`);
    }
  });
}

/**
 * Bind a machine-gated agent to the session (locked read-modify-write).
 * Takes BRANDED identity — callers must go through parseAgentId /
 * parseAgentType at the boundary, so a reserved character can never be
 * appended into the `\t`-separated binding line. Stale lines are reaped in
 * the same write.
 *
 * This bind deliberately does NOT truncate the evidence ledger. It used to,
 * whenever no fresh binding was active — but `appendEvidence` writes WITHOUT
 * the binding lock this function holds, so that delete raced every concurrent
 * writer: a parallel batch of subagents could have a sibling's already-written
 * TestRun records unlinked out from under it, and the sibling's SubagentStop
 * then judged its own epoch as having no trusted evidence. The observable
 * symptom was a task whose tests demonstrably passed being recorded
 * `untrusted-regression-pass` and blocked at the Wave Gate, while re-running
 * the SAME agent alone succeeded.
 *
 * Truncation was only ever a growth optimization, never a correctness
 * requirement: `eventsForEpoch` already makes another epoch's lines inert, and
 * the SessionStart stale sweep deletes `.evidence.jsonl` with the rest of its
 * session group (it is a `SESSION_SUFFIXES` member), so the file stays bounded
 * without a mid-session delete. Growth is therefore bounded by session
 * lifetime rather than by racing live writers.
 */
export async function bindMachineAgent(
  sessionId: SessionId,
  agentType: AgentType,
  agentId: AgentId,
  nowMs: number = Date.now(),
): Promise<void> {
  mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
  await withLock(bindingLock(sessionId), () => {
    const lines = classifyBindingLines(sessionId, nowMs);
    const kept = lines.filter((l) => l.kind !== "stale");
    // Idempotent on (agentId, agentType): a duplicated SubagentStart must
    // not write a second binding line — two bindings make soleActiveBinding
    // stand down (contended shape), disarming the gate fail-open. The stale
    // reap and activity anchor were already settled by the classify above;
    // re-appending would ALSO re-truncate nothing (a fresh twin exists), so
    // skipping is the entire fix.
    const duplicate = kept.some(
      (l) =>
        l.kind === "fresh" &&
        l.persisted.binding.agentId === agentId &&
        l.persisted.binding.agentType === agentType,
    );
    if (duplicate) {
      process.stderr.write(
        `bindMachineAgent: ${agentId}/${agentType} already bound for ${sessionId} — duplicate SubagentStart ignored\n`,
      );
      return;
    }
    const binding: MachineBinding = { agentId, agentType, epoch: epochOf(agentId, agentType) };
    const content =
      [...kept.map((l) => l.raw), formatBindingLine(binding, nowMs)].join("\n") + "\n";
    rewriteFileAtomic(machineBindingPath(sessionId), content);
  });
}

/** Remove one binding (locked). Takes BRANDED identity to match
 *  bindMachineAgent — the two adjacent id params were a compiler-invisible
 *  argument-swap hazard as raw strings. unbind only COMPARES against
 *  already-parsed bindings and rewrites from them; an unparseable id could
 *  never have been bound, so the caller (cleanup-subagent-flag) simply skips
 *  the call when parseAgentId/parseAgentType return null — preserving the
 *  original harmless no-op. Stale lines are reaped in the same rewrite;
 *  MALFORMED lines are preserved (mirroring refreshBindingActivity and
 *  bindMachineAgent) — they are the fail-closed evidence of a corrupt binding
 *  file, and while any remain the file must survive so the gate's
 *  file-present-but-zero-bindings check still fires. Failures are logged — a
 *  leaked binding disables gating silently otherwise. */
export async function unbindMachineAgent(
  sessionId: SessionId,
  agentType: AgentType,
  agentId: AgentId,
  nowMs: number = Date.now(),
): Promise<void> {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return;
  await withLock(bindingLock(sessionId), () => {
    try {
      const remaining = classifyBindingLines(sessionId, nowMs).filter(
        (l) =>
          l.kind === "malformed" ||
          (l.kind === "fresh" &&
            !(l.persisted.binding.agentId === agentId && l.persisted.binding.agentType === agentType)),
      );
      if (remaining.length === 0) {
        unlinkSync(path);
      } else {
        rewriteFileAtomic(path, remaining.map((l) => l.raw).join("\n") + "\n");
      }
    } catch (e) {
      process.stderr.write(`unbindMachineAgent: failed for ${agentId}/${sessionId}: ${e}\n`);
    }
  });
}

// --- Ledger IO ---

export function appendEvidence(
  sessionId: SessionId,
  epoch: Epoch,
  events: readonly Evidence[],
  callId?: string,
): void {
  if (events.length === 0) return;
  mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
  const lines =
    events
      .map((event) =>
        JSON.stringify(callId !== undefined ? { epoch, event, callId } : { epoch, event }),
      )
      .join("\n") + "\n";
  appendFileSync(ledgerPath(sessionId), lines);
}

// --- Call-start stamps ---

const callStartPath = (sessionId: SessionId): string =>
  sessionFilePath(sessionId, CALL_START_SUFFIX);

/**
 * Stamp the START of one tool call (PreToolUse), locked read-modify-write
 * under the session's binding lock (concurrent PreToolUse deliveries would
 * otherwise lose stamps to a torn rewrite). The wire format is an explicit
 * recency-ordered ARRAY (oldest first): any prior entry for the id is
 * removed and the new stamp appended, and pruneCallStarts keeps only the
 * CALL_START_CAP most-recent entries by slicing. A corrupt stamp file —
 * including the pre-array Record shape — is replaced (loudly); its stale
 * contents could only ever REJECT artifacts, so starting fresh is the
 * honest recovery.
 */
export async function recordCallStart(
  sessionId: SessionId,
  toolUseId: string,
  startMs: number,
): Promise<void> {
  mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
  await withLock(bindingLock(sessionId), () => {
    const path = callStartPath(sessionId);
    let current: readonly CallStartEntry[] = [];
    if (existsSync(path)) {
      const parsed = parseCallStartEntries(readFileSync(path, "utf-8"));
      if (parsed === null) {
        process.stderr.write(
          `recordCallStart: corrupt call-start file for ${sessionId} — starting a fresh stamp list\n`,
        );
      } else {
        current = parsed;
      }
    }
    const reinserted: CallStartEntry[] = [
      ...current.filter((e) => e.id !== toolUseId),
      { id: toolUseId, startMs },
    ];
    rewriteFileAtomic(path, JSON.stringify(pruneCallStarts(reinserted, CALL_START_CAP)));
  });
}

/**
 * The call-start stamp for one tool call, or null when none exists (no
 * stamp file, unknown/pruned toolUseId, or a corrupt file — logged). The
 * consumer (report freshness) fails CLOSED on null: disk artifacts cannot
 * vouch without proof they postdate the call.
 */
export function callStartFor(sessionId: SessionId, toolUseId: string): number | null {
  const path = callStartPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const entries = parseCallStartEntries(readFileSync(path, "utf-8"));
    if (entries === null) {
      process.stderr.write(
        `callStartFor: corrupt call-start file for ${sessionId} — treating as unstamped (fail closed)\n`,
      );
      return null;
    }
    return callStartOf(entries, toolUseId);
  } catch (e) {
    process.stderr.write(
      `callStartFor: cannot read call-start file for ${sessionId}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

export function readEvidence(sessionId: SessionId): readonly EvidenceRecord[] {
  const path = ledgerPath(sessionId);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const records = lines.map(parseEvidenceLine).filter((r): r is EvidenceRecord => r !== null);
  const dropped = lines.length - records.length;
  if (dropped > 0) {
    process.stderr.write(`readEvidence: skipped ${dropped} corrupt ledger line(s) for ${sessionId}\n`);
  }
  return records;
}

// --- Machine registry (definitions shipped with the plugin) ---

/**
 * Path of an agent type's machine definition. Takes the BRANDED AgentType:
 * parseAgentType refuses `/`, `\`, whitespace, and `..`, so an unvalidated
 * agent_type from hook input can never address a machine file outside
 * machinesDir (a traversal-substituted permissive machine would defeat the
 * gate).
 */
export function machineDefPath(machinesDir: string, agentType: AgentType): string {
  return `${machinesDir}/${agentType}.machine.json`;
}

export type LoadedMachine =
  | { readonly kind: "none" }
  | { readonly kind: "machine"; readonly machine: MachineDef }
  | { readonly kind: "invalid"; readonly error: string };

/**
 * Load the machine for an agent type (branded — parse at the boundary, see
 * machineDefPath). Returns "none" when the agent has no machine (gating is
 * opt-in per agent). A machine file that exists but fails to parse is an
 * error the caller must surface — never ignore.
 */
export function loadMachine(machinesDir: string, agentType: AgentType): LoadedMachine {
  const path = machineDefPath(machinesDir, agentType);
  if (!existsSync(path)) return { kind: "none" };
  const parsed = parseMachineJson(readFileSync(path, "utf-8"));
  if (!parsed.ok) return { kind: "invalid", error: `${path}: ${parsed.error}` };
  if (parsed.value.agent !== agentType) {
    return { kind: "invalid", error: `${path}: machine.agent "${parsed.value.agent}" does not match file name agent "${agentType}"` };
  }
  return { kind: "machine", machine: parsed.value };
}
