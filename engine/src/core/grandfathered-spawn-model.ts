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
 * The functional core here is pure: it takes already-read authority records
 * and decides. The fs read that finds them lives in the shell —
 * `handlers/pre-tool-use/validate-agent-model.ts` (which is where the
 * per-file capability linter lets it be).
 */

import type { AgentRequestAuthority } from "./orchestration-contract/roster";
import { parseOrchestrationRunId } from "./orchestration-contract/identity";
import { RUN_LAYOUT_COMPONENTS } from "./remediation-machine";
import { parseRepositoryPath } from "./repository-path";

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

/**
 * The run directory a spawn belongs to, ANCHORED — the only form a caller may
 * read authority from.
 *
 * `runDirectoryFromContextPath` is pure string math over a marker the SPAWNING
 * AGENT writes, so on its own it names any path the caller likes. Reading
 * `<thatPath>/requests/*.json` and trusting the result made the model-policy
 * gate forgeable: `parseStoredAgentRequestAuthority` proves only that a record
 * is internally self-consistent (its `harnessBinding` is what
 * `lowerModelProfile(modelProfile)` would produce — a pure, publicly derivable
 * function), never that the engine wrote it. A hand-written authority under any
 * writable directory therefore "proved" an arbitrary model.
 *
 * Anchoring restores the module header's claim that the authority lives in
 * "guarded, tamper-evident run-directory state". A path qualifies only when all
 * four hold:
 *
 *   1. it is lexically inside the repository (no `/tmp`, no `..` escape);
 *   2. it sits under `.claude/`;
 *   3. its PARENT is a canonical run-layout root (`RUN_LAYOUT_COMPONENTS`) —
 *      the same set that marks a path as run evidence for remediation; and
 *   4. its own name parses as an Orchestration Run Id.
 *
 * Those are exactly the directories the engine itself creates and guards.
 * Returns the canonical absolute path, or null — and null always means the
 * caller keeps its original block.
 */
export function anchoredRunDirectoryFromContextPath(
  repositoryRoot: string,
  contextPath: string,
): string | null {
  const candidate = runDirectoryFromContextPath(contextPath);
  if (candidate === null) return null;
  const contained = parseRepositoryPath(repositoryRoot, candidate, "spawn run directory");
  if (!contained.ok) return null;
  const components = contained.value.relative.split("/");
  if (components.length < 3 || components[0] !== ".claude") return null;
  if (!RUN_LAYOUT_COMPONENTS.has(components[components.length - 2]!)) return null;
  if (!parseOrchestrationRunId(components[components.length - 1]!).ok) return null;
  return contained.value.absolute;
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
