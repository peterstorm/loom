/**
 * The phase state machine's policy constants: the clarify threshold, the
 * phase panel agents run in, the harness utility agents phase validation lets
 * through, and the valid transitions. Pure data — they lived in config.ts,
 * whose load reads the environment and probes Git, so every pure gate that
 * consulted them (validate-phase-order) inherited that I/O on import.
 */

import { frozenSet } from "./frozen";
import type { Phase } from "./phases";

/** Markers above this trigger mandatory clarify phase */
export const CLARIFY_THRESHOLD = 3;

/**
 * The phase every panel agent is classified as for phase-order validation.
 *
 * ONE constant rather than a per-agent field, because the panel is a stage
 * WITHIN a phase: an interviewer, N designers and K judges all run inside
 * `architecture` and none of them may advance out of it. `AgentKind`'s panel
 * branch therefore carries no `phase` to disagree with this, which is what
 * retired `derivePanelPhase` — a function that collected the distinct declared
 * phases and threw unless there was exactly one, policing at load time a state
 * the type now cannot express.
 *
 * detectPhase (validate-phase-order.ts) routes panel agents here via this
 * constant instead of a bare `"architecture"` literal. Must stay a phase panel
 * agents are allowed to run in, and one whose SubagentStop does NOT advance
 * (panel agents are absent from PHASE_AGENT_MAP).
 */
export const ARCH_PANEL_PHASE: Phase = "architecture";

/** Utility agents allowed through phase validation — HARNESS-level names
 *  (Claude Code built-ins), not catalog identities, so they stay here rather
 *  than in the catalog-derived agent-catalog-projections leaf. */
export const UTILITY_AGENTS: ReadonlySet<string> = frozenSet(["Explore", "Plan", "haiku"]);

/** Valid phase transitions: from → allowed targets. Both the record and
 * each member are frozen: a readonly annotation alone would not protect the
 * runtime state-machine policy from ordinary consumer mutation. */
const frozenPhases = (...phases: Phase[]): readonly Phase[] => Object.freeze(phases);

export const VALID_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = Object.freeze({
  "init":            frozenPhases("brainstorm", "specify", "architecture"),
  "brainstorm":      frozenPhases("brainstorm", "specify"),
  "specify":         frozenPhases("specify", "clarify", "architecture"),
  "clarify":         frozenPhases("clarify", "architecture"),
  "architecture":    frozenPhases("architecture", "plan-alignment", "decompose"),
  "plan-alignment":  frozenPhases("plan-alignment", "architecture", "decompose"),
  "decompose":       frozenPhases("decompose", "execute"),
  "execute":         frozenPhases("execute"),
});
