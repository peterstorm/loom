/**
 * Evidence ledger + machine binding — the imperative shell around the
 * pure reducer. Line parsing and epoch attribution are pure and live in
 * evidence.ts; this module owns the files and the locks.
 *
 * Per session under SUBAGENT_DIR:
 *   <session>.evidence.jsonl — append-only { epoch, event } records
 *   <session>.machine        — one "<agent_id>\t<agent_type>\t<bound_at_ms>"
 *                              line per active machine-gated subagent
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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../config";
import { withLock } from "../utils/lock";
import { parseMachineJson } from "./parse-machine";
import {
  type AgentId,
  type AgentType,
  type MachineBinding,
  type PersistedBinding,
  type SessionFileSuffix,
  type SessionId,
  epochOf,
  formatBindingLine,
  isBindingFresh,
  parseAgentId,
  parseBindingLine,
  parseEvidenceLine,
  parseSessionId,
  resolveSoleActiveBinding,
} from "./evidence";
import type { Epoch, Evidence, EvidenceRecord, MachineDef } from "./types";

/**
 * The single path-construction boundary for session files. Session ids come
 * from hook input — parseSessionId refuses separators, `..` traversal, and
 * whitespace, so an unvalidated id can never address files outside
 * SUBAGENT_DIR. Throwing is the fail-closed convention here: every caller
 * either catches-and-stands-down (recorder, dispatcher snapshot, safeRun)
 * or fails closed at the CLI boundary (the gate).
 */
function sessionFilePath(sessionId: string, suffix: string): string {
  const parsed = parseSessionId(sessionId);
  if (parsed === null) {
    throw new Error(
      `invalid session id ${JSON.stringify(sessionId)} — refusing to construct a ${suffix} path`,
    );
  }
  return `${SUBAGENT_DIR}/${parsed}${suffix}`;
}

export const ledgerPath = (sessionId: string): string =>
  sessionFilePath(sessionId, ".evidence.jsonl");

export const machineBindingPath = (sessionId: string): string =>
  sessionFilePath(sessionId, ".machine");

const activeFlagPath = (sessionId: string): string => sessionFilePath(sessionId, ".active");

const bindingLock = (sessionId: string): string => sessionFilePath(sessionId, ".cleanup");

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
function classifyBindingLines(sessionId: string, nowMs: number): ClassifiedLine[] {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return [];
  const anchorMs = statSync(path).mtimeMs;
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((raw): ClassifiedLine => {
      const persisted = parseBindingLine(raw);
      if (persisted === null) return { kind: "malformed", raw };
      return isBindingFresh(persisted.boundAtMs, anchorMs, nowMs, STALE_SUBAGENT_TTL_MS)
        ? { kind: "fresh", raw, persisted }
        : { kind: "stale", raw, persisted };
    });
}

/**
 * Parse the binding file. Malformed lines — wrong field count, fields the
 * smart constructors reject, or a bad bind stamp — are skipped (and count as
 * noise, not bindings) loudly, mirroring readEvidence: a binding file that
 * silently parses to zero bindings would open the gate. Bindings whose last
 * activity exceeds the TTL are treated as ABSENT (their subagent plausibly
 * died without SubagentStop) — refreshBindingActivity reaps them.
 */
export function readBindings(sessionId: string, nowMs: number = Date.now()): MachineBinding[] {
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

function readActiveAgents(sessionId: string): string[] {
  const path = activeFlagPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Number of agents currently on the session's `.active` roster. */
export function countActiveAgents(sessionId: string): number {
  return readActiveAgents(sessionId).length;
}

/**
 * The binding evidence may be attributed to, or null when attribution is
 * impossible. The decision itself is the pure resolveSoleActiveBinding
 * (evidence.ts) — exactly one fresh binding AND a roster of exactly the
 * bound agent; anything else (contention, a leaked binding over an empty
 * or foreign roster) stands down. This adapter only supplies the files.
 */
export function soleActiveBinding(sessionId: string, nowMs: number = Date.now()): MachineBinding | null {
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
export async function refreshBindingActivity(sessionId: string, nowMs: number = Date.now()): Promise<void> {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return;
  await withLock(bindingLock(sessionId), () => {
    if (!existsSync(path)) return;
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
 */
export function rosterAgentId(raw: string): AgentId {
  const parsed = parseAgentId(raw);
  if (parsed !== null) return parsed;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const placeholder = parseAgentId(`unparseable-${digest}`);
  if (placeholder === null) {
    throw new Error("unreachable: hex placeholder is binding-safe by construction");
  }
  return placeholder;
}

/**
 * Append an agent to the session's `.active` roster under the SAME lock
 * cleanup takes to rewrite it — an unlocked append racing a cleanup rewrite
 * could be lost, leaving attribution counting a ghost (or missing) agent.
 */
export async function markAgentActive(sessionId: string, agentId: AgentId): Promise<void> {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  await withLock(bindingLock(sessionId), () => {
    appendFileSync(activeFlagPath(sessionId), `${agentId}\n`);
  });
}

/**
 * Remove one agent from the session's `.active` roster (locked, mirrors
 * markAgentActive). Failures are logged — a ghost roster entry silently
 * voids attribution for the rest of the session otherwise.
 */
export async function removeActiveAgent(sessionId: string, agentId: string): Promise<void> {
  const path = activeFlagPath(sessionId);
  if (!existsSync(path)) return;
  await withLock(bindingLock(sessionId), () => {
    try {
      const remaining = readFileSync(path, "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "" && line.trim() !== agentId)
        .join("\n");
      if (remaining.trim() === "") {
        unlinkSync(path);
      } else {
        rewriteFileAtomic(path, remaining + "\n");
      }
    } catch (e) {
      process.stderr.write(`removeActiveAgent: .active update failed for ${sessionId}: ${e}\n`);
    }
  });
}

/**
 * Bind a machine-gated agent to the session (locked read-modify-write).
 * Takes BRANDED identity — callers must go through parseAgentId /
 * parseAgentType at the boundary, so a reserved character can never be
 * appended into the `\t`-separated binding line. Stale lines are reaped in
 * the same write. When no fresh binding is currently active, the previous
 * ledger is best-effort truncated — epoch filtering already makes stale
 * lines inert, so a failed truncate is logged, never fatal.
 */
export async function bindMachineAgent(
  sessionId: string,
  agentType: AgentType,
  agentId: AgentId,
  nowMs: number = Date.now(),
): Promise<void> {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  await withLock(bindingLock(sessionId), () => {
    const lines = classifyBindingLines(sessionId, nowMs);
    const kept = lines.filter((l) => l.kind !== "stale");
    if (!kept.some((l) => l.kind === "fresh")) {
      try {
        unlinkSync(ledgerPath(sessionId));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          process.stderr.write(`bindMachineAgent: ledger truncate failed for ${sessionId}: ${e}\n`);
        }
      }
    }
    const binding: MachineBinding = { agentId, agentType, epoch: epochOf(agentId, agentType) };
    const content =
      [...kept.map((l) => l.raw), formatBindingLine(binding, nowMs)].join("\n") + "\n";
    rewriteFileAtomic(machineBindingPath(sessionId), content);
  });
}

/** Remove one binding (locked). Takes raw strings deliberately: unbind only
 *  COMPARES against already-parsed bindings and rewrites from them, so an
 *  unparseable id is merely a no-op (it could never have been bound). Stale
 *  lines are reaped in the same rewrite; MALFORMED lines are preserved
 *  (mirroring refreshBindingActivity and bindMachineAgent) — they are the
 *  fail-closed evidence of a corrupt binding file, and while any remain the
 *  file must survive so the gate's file-present-but-zero-bindings check
 *  still fires. Failures are logged — a leaked binding disables gating
 *  silently otherwise. */
export async function unbindMachineAgent(
  sessionId: string,
  agentType: string,
  agentId: string,
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

export function appendEvidence(sessionId: string, epoch: Epoch, events: readonly Evidence[]): void {
  if (events.length === 0) return;
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const lines = events.map((event) => JSON.stringify({ epoch, event })).join("\n") + "\n";
  appendFileSync(ledgerPath(sessionId), lines);
}

export function readEvidence(sessionId: string): EvidenceRecord[] {
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
