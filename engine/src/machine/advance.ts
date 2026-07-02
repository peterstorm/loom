/**
 * Pure phase-machine reducer.
 *
 * State is always a fold of the evidence ledger — the persisted state file
 * is a cache, rebuildable from the ledger after any crash. No IO here.
 */

import type { Evidence, EventCounts, EventToken, MachineDef, PhaseState, Requirement } from "./types";
import { initialState } from "./types";

/** Which countable tokens an evidence event increments. */
export function tokensFor(e: Evidence): EventToken[] {
  switch (e.kind) {
    case "FileRead":
      return ["FileRead"];
    case "FileWrite":
      return ["FileWrite"];
    case "TestRun":
      // A passing run counts as TestRunPassed only when ground truth
      // confirms it (trusted) — an untrusted "pass" never advances a guard.
      return e.passed && e.trusted ? ["TestRun", "TestRunPassed"] : ["TestRun"];
  }
}

function increment(counts: EventCounts, tokens: EventToken[]): EventCounts {
  if (tokens.length === 0) return counts;
  const next = { ...counts };
  for (const t of tokens) next[t] = next[t] + 1;
  return next;
}

export function satisfied(req: Requirement, counts: EventCounts): boolean {
  return counts[req.event] >= req.min;
}

/** Cascade past every phase whose advance guard the counts already satisfy. */
function settle(machine: MachineDef, state: PhaseState): PhaseState {
  let index = state.phaseIndex;
  while (index < machine.phases.length - 1) {
    const guard = machine.phases[index].advance;
    if (guard === null || !satisfied(guard, state.counts)) break;
    index++;
  }
  return index === state.phaseIndex ? state : { ...state, phaseIndex: index };
}

/** Apply one evidence event: count it, then advance as far as guards allow. */
export function advance(machine: MachineDef, state: PhaseState, event: Evidence): PhaseState {
  const counts = increment(state.counts, tokensFor(event));
  return settle(machine, { ...state, counts });
}

/** Rebuild state from the full ledger. */
export function foldEvidence(machine: MachineDef, events: readonly Evidence[]): PhaseState {
  return events.reduce((s, e) => advance(machine, s, e), settle(machine, initialState));
}

export function currentPhase(machine: MachineDef, state: PhaseState) {
  return machine.phases[Math.min(state.phaseIndex, machine.phases.length - 1)];
}

/**
 * Gate decision for a tool call. Deny-by-default within the machine's
 * jurisdiction: enforced tools are allowed only if the current phase lists
 * them; tools outside enforcedTools always pass.
 */
export function isToolAllowed(machine: MachineDef, state: PhaseState, toolName: string): boolean {
  if (!machine.enforcedTools.includes(toolName)) return true;
  return currentPhase(machine, state).allowedTools.includes(toolName);
}

export function isTerminal(machine: MachineDef, state: PhaseState): boolean {
  return currentPhase(machine, state).terminal;
}

/** Terminal requirements not yet met — empty means clean completion. */
export function missingRequirements(machine: MachineDef, state: PhaseState): Requirement[] {
  const terminal = machine.phases[machine.phases.length - 1];
  return terminal.requires.filter((r) => !satisfied(r, state.counts));
}

/** Human-readable explanation for a blocked tool call. */
export function blockExplanation(machine: MachineDef, state: PhaseState, toolName: string): string {
  const phase = currentPhase(machine, state);
  const guard = phase.advance;
  const progress = guard
    ? `advance guard: ${guard.event} ≥ ${guard.min} (currently ${state.counts[guard.event]})`
    : "terminal phase";
  return [
    `[loom machine: ${machine.agent}] ${toolName} is not available in phase "${phase.id}".`,
    `Allowed here: ${phase.allowedTools.length > 0 ? phase.allowedTools.join(", ") : "none of the enforced tools"}.`,
    `To advance — ${progress}.`,
  ].join(" ");
}
