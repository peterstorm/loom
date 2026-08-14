/**
 * Grandfathered spawn-model authorization.
 *
 * `validate-agent-model` enforces that a Claude Code spawn carries the model
 * the agent's CURRENT profile resolves to. That is right for every fresh
 * spawn, but it strands one population: a wave-reviewer retry (attempt-2) is
 * derived — by construction and by an anti-tamper invariant — from a STORED
 * attempt-1 authority issued under a PAST policy. When the agent's profile was
 * later promoted (e.g. comment-analyzer mechanical→focused-review, haiku→
 * sonnet), the engine still, deliberately, issues attempt-2 with the stored
 * (haiku) binding. The current-policy gate then vetoes that engine-authorized
 * spawn, and — because a vetoed spawn leaves no durable rejection — the run
 * stalls with no restart path.
 *
 * The gate's true contract is "the orchestrator must spawn EXACTLY what the
 * engine authorized," not "the orchestrator must spawn what today's policy
 * table would pick." For a grandfathered retry those differ. This module lets
 * the gate consult the engine's own issued authority — written under guarded,
 * tamper-evident run-directory state — and accept a model the engine provably
 * issued for THIS exact request. It can only ever turn a would-be BLOCK into an
 * ALLOW, and only when a real issued authority for the request carries the
 * requested model; it can neither weaken a passing spawn nor authorize a model
 * the engine never issued (the orchestrator cannot forge an authority into
 * guarded state, and the match is keyed on the request id the spawn carries).
 *
 * The functional core here is pure: it takes already-read authority records and
 * decides. The fs read that finds them lives in the shell (the hook).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "./orchestration-contract/roster";

/** Extract a `LOOM_<NAME>: <value>` marker line's value from a spawn prompt, or
 *  null when the marker is absent. Markers are engine-authored, one per line. */
export function loomMarkerValue(prompt: string, name: string): string | null {
  const match = prompt.match(new RegExp(`^LOOM_${name}:[ \\t]*(\\S+)[ \\t]*$`, "m"));
  return match ? match[1]! : null;
}

/** The run directory a spawn belongs to, derived from its LOOM_CONTEXT_PATH
 *  marker (`<runDir>/contexts/<digest>.json`). Returns null when the marker is
 *  absent or does not have the fixed `contexts/<file>` tail — the caller then
 *  keeps the original block (no rescue is attempted from an unrecognized path).
 *  Pure string math; the caller decides whether the path is safe to read. */
export function runDirectoryFromContextPath(contextPath: string): string | null {
  const normalized = contextPath.replace(/\/+$/, "");
  const match = normalized.match(/^(.*)\/contexts\/[^/]+$/);
  const runDir = match?.[1];
  return runDir !== undefined && runDir !== "" ? runDir : null;
}

/** The Claude Code model the engine issued for `requestId`, from the run's
 *  already-parsed issued authorities, or null when no authority matches. Pure:
 *  exactly one authority per request id, so the first match is canonical. */
export function engineIssuedClaudeModel(
  issued: readonly AgentRequestAuthority[],
  requestId: string,
): string | null {
  const authority = issued.find((candidate) => candidate.requestId === requestId);
  return authority?.harnessBinding.claude.model ?? null;
}

/**
 * The Claude Code model the engine issued for `requestId` in a run directory,
 * read directly from `<runDir>/requests/*.json`. Returns null on ANY failure —
 * unreadable directory, a corrupt/unreadable authority file, or no matching
 * request — so a caller can only ever use a positive, proven answer. Does not
 * open a run-directory handle (that mutates the run); it only reads the
 * engine-written, guarded authority artifacts.
 */
export function engineIssuedClaudeModelFromRunDir(
  runDirectory: string,
  requestId: string,
): string | null {
  let names: readonly string[];
  try {
    names = readdirSync(join(runDirectory, "requests"));
  } catch {
    return null;
  }
  const issued: AgentRequestAuthority[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(runDirectory, "requests", name), "utf-8")) as unknown;
    } catch {
      return null; // a corrupt authority file → prove nothing (fail closed)
    }
    const parsed = parseStoredAgentRequestAuthority(raw);
    if (parsed.ok) issued.push(parsed.value);
  }
  return engineIssuedClaudeModel(issued, requestId);
}
