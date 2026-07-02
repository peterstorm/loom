/**
 * Evidence ledger + machine binding — the imperative shell around the
 * pure reducer.
 *
 * Per session under SUBAGENT_DIR:
 *   <session>.evidence.jsonl — append-only evidence events (source of truth)
 *   <session>.machine        — one agent_type per line for each active
 *                              machine-gated subagent (mirrors .active)
 *
 * There is no separate phase-state file: readers fold the ledger, which is
 * small (one line per relevant tool call) and makes state crash-proof.
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
import { parseMachineJson } from "./parse-machine";
import type { Evidence, MachineDef, TestReportSummary } from "./types";

export const ledgerPath = (sessionId: string): string =>
  `${SUBAGENT_DIR}/${sessionId}.evidence.jsonl`;

export const machineBindingPath = (sessionId: string): string =>
  `${SUBAGENT_DIR}/${sessionId}.machine`;

// --- Evidence line parsing (parse, don't validate) ---

function isReportSummary(v: unknown): v is TestReportSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.total === "number" &&
    typeof o.failed === "number" &&
    (o.source === "vitest-json" || o.source === "junit-xml")
  );
}

/** Parse one ledger line. Unknown/corrupt lines yield null and are skipped. */
export function parseEvidenceLine(line: string): Evidence | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  switch (o.kind) {
    case "FileRead":
    case "FileWrite":
      return typeof o.path === "string" && o.path !== ""
        ? { kind: o.kind, path: o.path }
        : null;
    case "TestRun": {
      if (typeof o.command !== "string") return null;
      const exit = typeof o.exit === "number" ? o.exit : null;
      const report = isReportSummary(o.report) ? o.report : null;
      if (typeof o.passed !== "boolean" || typeof o.trusted !== "boolean") return null;
      return { kind: "TestRun", command: o.command, exit, report, passed: o.passed, trusted: o.trusted };
    }
    default:
      return null;
  }
}

// --- Ledger IO ---

export function appendEvidence(sessionId: string, events: readonly Evidence[]): void {
  if (events.length === 0) return;
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  appendFileSync(ledgerPath(sessionId), lines);
}

export function readEvidence(sessionId: string): Evidence[] {
  const path = ledgerPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(parseEvidenceLine)
    .filter((e): e is Evidence => e !== null);
}

// --- Machine binding lifecycle ---

/** Agent types with an active machine binding for this session. */
export function activeMachineAgents(sessionId: string): string[] {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

/**
 * Bind a machine-gated agent to the session. When no binding is currently
 * active, this starts a fresh epoch: the previous ledger is deleted so a
 * sequential subagent never inherits evidence from an earlier run.
 */
export function bindMachineAgent(sessionId: string, agentType: string): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  if (activeMachineAgents(sessionId).length === 0) {
    try {
      unlinkSync(ledgerPath(sessionId));
    } catch {}
  }
  appendFileSync(machineBindingPath(sessionId), `${agentType}\n`);
}

/** Remove one binding for agentType; delete the file when none remain. */
export function unbindMachineAgent(sessionId: string, agentType: string): void {
  const path = machineBindingPath(sessionId);
  if (!existsSync(path)) return;
  const lines = activeMachineAgents(sessionId);
  const index = lines.indexOf(agentType);
  if (index >= 0) lines.splice(index, 1);
  if (lines.length === 0) {
    try {
      unlinkSync(path);
    } catch {}
  } else {
    writeFileSync(path, lines.join("\n") + "\n");
  }
}

// --- Machine registry (definitions shipped with the plugin) ---

export function machineDefPath(machinesDir: string, agentType: string): string {
  return `${machinesDir}/${agentType}.machine.json`;
}

/**
 * Load the machine for an agent type. Returns null when the agent has no
 * machine (gating is opt-in per agent). A machine file that exists but
 * fails to parse is an error the caller must surface — never ignore.
 */
export function loadMachine(
  machinesDir: string,
  agentType: string,
): { kind: "none" } | { kind: "machine"; machine: MachineDef } | { kind: "invalid"; error: string } {
  const path = machineDefPath(machinesDir, agentType);
  if (!existsSync(path)) return { kind: "none" };
  const parsed = parseMachineJson(readFileSync(path, "utf-8"));
  if (!parsed.ok) return { kind: "invalid", error: `${path}: ${parsed.error}` };
  if (parsed.value.agent !== agentType) {
    return { kind: "invalid", error: `${path}: machine.agent "${parsed.value.agent}" does not match file name agent "${agentType}"` };
  }
  return { kind: "machine", machine: parsed.value };
}
