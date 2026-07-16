/**
 * Pure phase-machine reducer.
 *
 * State is always a fold of the evidence ledger — there is no persisted
 * phase state to drift or corrupt; any reader rebuilds it from the ledger.
 * Judgments (did a test run pass, is it trustworthy) are derived here from
 * stored facts via judgeTestRun — never read back from the ledger. No IO.
 */

import { match } from "ts-pattern";
import type { Evidence, EventCounts, EventToken, MachineDef, PhaseState, Requirement } from "./types";
import { initialState } from "./types";
import { judgeTestRun } from "./test-report";

/** Which countable tokens an evidence event increments. */
export function tokensFor(e: Evidence): EventToken[] {
  return match(e)
    .with({ kind: "FileRead" }, (): EventToken[] => ["FileRead"])
    // Only TOOL-authored writes advance guards: the PreToolUse gate enforces
    // Edit/Write/MultiEdit, never Bash — a shell redirect (`echo > f.ts`)
    // counting as FileWrite would advance a phase the gate cannot police.
    // `via` is required on the domain type; the parse boundary (parseEvent)
    // maps absent wire values (old records) to "tool". Shell writes stay in
    // the ledger for the artifact veto and the modified-after-pass demotion
    // — they just count nothing here.
    .with({ kind: "FileWrite" }, (w): EventToken[] => (w.via === "shell" ? [] : ["FileWrite"]))
    .with({ kind: "TestRun" }, (run): EventToken[] =>
      // Judgment is derived from facts at fold time: a run counts as
      // TestRunPassed only when ground truth confirms it (trusted pass).
      match(judgeTestRun(run.exit, run.report))
        .with({ verdict: "trusted-pass" }, (): EventToken[] => ["TestRun", "TestRunPassed"])
        .with({ verdict: "trusted-fail" }, (): EventToken[] => ["TestRun"])
        .with({ verdict: "untrusted" }, (): EventToken[] => ["TestRun"])
        .exhaustive(),
    )
    .exhaustive();
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
    const phase = machine.phases[index];
    // A terminal phase before the last index is unrepresentable in parsed
    // machines (parseMachine enforces terminal-is-last); the check exists
    // purely to narrow the union.
    if (phase.terminal || !satisfied(phase.advance, state.counts)) break;
    index++;
  }
  return index === state.phaseIndex ? state : { ...state, phaseIndex: index };
}

/** Apply one evidence event: count it, then advance as far as guards allow. */
export function advance(machine: MachineDef, state: PhaseState, event: Evidence): PhaseState {
  const counts = increment(state.counts, tokensFor(event));
  return settle(machine, { ...state, counts });
}

/** Rebuild state from the (epoch-filtered) ledger. */
export function foldEvidence(machine: MachineDef, events: readonly Evidence[]): PhaseState {
  return events.reduce((s, e) => advance(machine, s, e), settle(machine, initialState));
}

export function currentPhase(machine: MachineDef, state: PhaseState) {
  return machine.phases[Math.min(Math.max(state.phaseIndex, 0), machine.phases.length - 1)];
}

/**
 * Gate decision for a tool call. Deny-by-default within the machine's
 * jurisdiction: enforced tools are allowed only if the current phase lists
 * them; tools outside enforcedTools always pass.
 */
export function isToolAllowed(machine: MachineDef, state: PhaseState, toolName: string): boolean {
  // Widen for the membership test: toolName is any tool the harness reports,
  // the machine's arrays are proven GateWiredTool[] — membership is the question.
  if (!(machine.enforcedTools as readonly string[]).includes(toolName)) return true;
  return (currentPhase(machine, state).allowedTools as readonly string[]).includes(toolName);
}

export function isTerminal(machine: MachineDef, state: PhaseState): boolean {
  return currentPhase(machine, state).terminal;
}

/**
 * Sentinel returned when the terminal-is-last invariant is somehow broken
 * (a MachineDef that did not come from parseMachine). `min: Infinity` is
 * unsatisfiable by construction — the impossible state reads as a FAILURE
 * (requirements forever missing), never as clean completion.
 */
export const MACHINE_INVARIANT_VIOLATED: Requirement = {
  event: "TestRunPassed",
  min: Number.POSITIVE_INFINITY,
};

/** Terminal requirements not yet met — empty means clean completion. */
export function missingRequirements(machine: MachineDef, state: PhaseState): Requirement[] {
  const last = machine.phases[machine.phases.length - 1];
  // parseMachine guarantees the last phase is terminal, so this branch is
  // unreachable for parsed machines — but if it ever fires, the impossible
  // state must read as failure (fail closed), not as "nothing missing".
  if (!last.terminal) return [MACHINE_INVARIANT_VIOLATED];
  return last.requires.filter((r) => !satisfied(r, state.counts));
}

/** Human-readable explanation for a blocked tool call. */
export function blockExplanation(machine: MachineDef, state: PhaseState, toolName: string): string {
  const phase = currentPhase(machine, state);
  const progress = phase.terminal
    ? "terminal phase"
    : `advance guard: ${phase.advance.event} ≥ ${phase.advance.min} (currently ${state.counts[phase.advance.event]})`;
  return [
    `[loom machine: ${machine.agent}] ${toolName} is not available in phase "${phase.id}".`,
    `Allowed here: ${phase.allowedTools.length > 0 ? phase.allowedTools.join(", ") : "none of the enforced tools"}.`,
    `To advance — ${progress}.`,
  ].join(" ");
}
