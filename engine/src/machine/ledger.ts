/**
 * Evidence ledger + machine binding — the imperative shell around the
 * pure reducer.
 *
 * Per session under SUBAGENT_DIR:
 *   <session>.evidence.jsonl — append-only { epoch, event } records
 *   <session>.machine        — one "<agent_id>\t<agent_type>" line per
 *                              active machine-gated subagent
 *
 * Epochs make attribution structural: every evidence line is stamped with
 * the binding's epoch (`<agent_id>:<agent_type>`), and readers fold only
 * their own epoch — a stale line from a crashed run or a parallel agent is
 * inert instead of cross-credited. Because the harness gives PostToolUse no
 * agent identity, evidence is recorded ONLY while exactly one subagent is
 * active and exactly one machine is bound (soleActiveBinding); in contended
 * sessions both the recorder and the gate stand down.
 *
 * Bind/unbind are read-modify-write on the binding file and take the same
 * per-session lock the .active cleanup uses — callers must NOT hold that
 * lock when calling them.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { SUBAGENT_DIR } from "../config";
import { withLock } from "../utils/lock";
import { parseMachineJson } from "./parse-machine";
import type { Evidence, EvidenceRecord, MachineDef, TestReportSummary } from "./types";

export const ledgerPath = (sessionId: string): string =>
  `${SUBAGENT_DIR}/${sessionId}.evidence.jsonl`;

export const machineBindingPath = (sessionId: string): string =>
  `${SUBAGENT_DIR}/${sessionId}.machine`;

const activeFlagPath = (sessionId: string): string => `${SUBAGENT_DIR}/${sessionId}.active`;

const bindingLock = (sessionId: string): string => `${SUBAGENT_DIR}/${sessionId}.cleanup`;

// --- Bindings ---

export interface MachineBinding {
  readonly agentId: string;
  readonly agentType: string;
  /** Attribution key stamped on every evidence record of this run. */
  readonly epoch: string;
}

export const epochOf = (agentId: string, agentType: string): string => `${agentId}:${agentType}`;

/** Parse the binding file. Malformed lines are skipped (and count as noise, not bindings). */
export function readBindings(sessionId: string): MachineBinding[] {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [agentId, agentType] = l.split("\t");
      return agentId && agentType
        ? { agentId, agentType, epoch: epochOf(agentId, agentType) }
        : null;
    })
    .filter((b): b is MachineBinding => b !== null);
}

function countActiveAgents(sessionId: string): number {
  const path = activeFlagPath(sessionId);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "").length;
}

/**
 * The binding evidence may be attributed to, or null when attribution is
 * impossible: no binding, more than one binding, or any additional subagent
 * active in the session (the harness gives tool calls no agent identity).
 */
export function soleActiveBinding(sessionId: string): MachineBinding | null {
  const bindings = readBindings(sessionId);
  if (bindings.length !== 1) return null;
  if (countActiveAgents(sessionId) > 1) return null;
  return bindings[0];
}

/**
 * Bind a machine-gated agent to the session (locked read-modify-write).
 * When no binding is currently active, the previous ledger is best-effort
 * truncated — epoch filtering already makes stale lines inert, so a failed
 * truncate is logged, never fatal.
 */
export async function bindMachineAgent(
  sessionId: string,
  agentType: string,
  agentId: string,
): Promise<void> {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  await withLock(bindingLock(sessionId), () => {
    if (readBindings(sessionId).length === 0) {
      try {
        unlinkSync(ledgerPath(sessionId));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          process.stderr.write(`bindMachineAgent: ledger truncate failed for ${sessionId}: ${e}\n`);
        }
      }
    }
    appendFileSync(machineBindingPath(sessionId), `${agentId}\t${agentType}\n`);
  });
}

/** Remove one binding (locked). Failures are logged — a leaked binding disables gating silently otherwise. */
export async function unbindMachineAgent(
  sessionId: string,
  agentType: string,
  agentId: string,
): Promise<void> {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return;
  await withLock(bindingLock(sessionId), () => {
    try {
      const remaining = readBindings(sessionId).filter(
        (b) => !(b.agentId === agentId && b.agentType === agentType),
      );
      if (remaining.length === 0) {
        unlinkSync(path);
      } else {
        writeFileSync(path, remaining.map((b) => `${b.agentId}\t${b.agentType}`).join("\n") + "\n");
      }
    } catch (e) {
      process.stderr.write(`unbindMachineAgent: failed for ${agentId}/${sessionId}: ${e}\n`);
    }
  });
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
  if (typeof o.epoch !== "string" || o.epoch === "") return null;
  const event = parseEvent(o.event);
  return event ? { epoch: o.epoch, event } : null;
}

// --- Ledger IO ---

export function appendEvidence(sessionId: string, epoch: string, events: readonly Evidence[]): void {
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

/** Events attributable to one run. */
export function eventsForEpoch(records: readonly EvidenceRecord[], epoch: string): Evidence[] {
  return records.filter((r) => r.epoch === epoch).map((r) => r.event);
}

// --- Machine registry (definitions shipped with the plugin) ---

export function machineDefPath(machinesDir: string, agentType: string): string {
  return `${machinesDir}/${agentType}.machine.json`;
}

export type LoadedMachine =
  | { readonly kind: "none" }
  | { readonly kind: "machine"; readonly machine: MachineDef }
  | { readonly kind: "invalid"; readonly error: string };

/**
 * Load the machine for an agent type. Returns "none" when the agent has no
 * machine (gating is opt-in per agent). A machine file that exists but
 * fails to parse is an error the caller must surface — never ignore.
 */
export function loadMachine(machinesDir: string, agentType: string): LoadedMachine {
  const path = machineDefPath(machinesDir, agentType);
  if (!existsSync(path)) return { kind: "none" };
  const parsed = parseMachineJson(readFileSync(path, "utf-8"));
  if (!parsed.ok) return { kind: "invalid", error: `${path}: ${parsed.error}` };
  if (parsed.value.agent !== agentType) {
    return { kind: "invalid", error: `${path}: machine.agent "${parsed.value.agent}" does not match file name agent "${agentType}"` };
  }
  return { kind: "machine", machine: parsed.value };
}
