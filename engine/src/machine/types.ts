/**
 * Guarded Skill Machine — core types.
 *
 * Evidence is a CLOSED discriminated union. There is deliberately no
 * expression language: adding an evidence kind is a reviewed code change,
 * not a config entry. Evidence events are captured at execution time
 * (PostToolUse) — transcript text is never evidence.
 */

import type { AgentType } from "./evidence";

// --- Evidence (ground truth events) ---

/** Summary parsed from a machine-readable test report artifact. */
export interface TestReportSummary {
  readonly total: number;
  readonly failed: number;
  readonly source: "vitest-json" | "junit-xml";
}

/**
 * Evidence stores FACTS ONLY — never derived judgments. `passed`/`trusted`
 * are computed from `exit` + `report` via `judgeTestRun` at read time, so a
 * ledger line can never carry an inconsistent (or forged-inconsistent)
 * judgment. Note the residual limit: a consistent forgery of the facts
 * themselves is only mitigated by the guard-state-file Bash hook protecting
 * the ledger path — full integrity (HMAC / out-of-reach storage) is a
 * documented follow-up.
 */
export type Evidence =
  | { readonly kind: "FileRead"; readonly path: string }
  | { readonly kind: "FileWrite"; readonly path: string }
  | {
      readonly kind: "TestRun";
      readonly command: string;
      /** Real exit status captured at execution time; null when the harness didn't expose one. */
      readonly exit: number | null;
      readonly report: TestReportSummary | null;
    };

/**
 * Branded attribution key (`<agent_id>:<agent_type>`, minted at
 * SubagentStart). Only `epochOf` (composition from branded identity) and
 * `parseEpoch` (the deserialization boundary) in evidence.ts produce one —
 * a raw string can never silently flow into epoch stamps or comparisons,
 * so the recorder's stamp and the reader's key cannot desync by
 * construction. Serialized as a plain JSON string; wire format unchanged.
 */
declare const EPOCH: unique symbol;
export type Epoch = string & { readonly [EPOCH]: true };

/**
 * A ledger line: an evidence event stamped with the epoch it belongs to.
 * Readers fold only their own epoch, so a stale or foreign ledger line is
 * inert rather than cross-credited.
 */
export interface EvidenceRecord {
  readonly epoch: Epoch;
  readonly event: Evidence;
}

/** Countable event tokens the machine's guards reference. */
export const EVENT_TOKENS = ["FileRead", "FileWrite", "TestRun", "TestRunPassed"] as const;
export type EventToken = (typeof EVENT_TOKENS)[number];

export type EventCounts = Readonly<Record<EventToken, number>>;

export const ZERO_COUNTS: EventCounts = {
  FileRead: 0,
  FileWrite: 0,
  TestRun: 0,
  TestRunPassed: 0,
};

// --- Machine definition ---

/**
 * Tools the PreToolUse gate is actually wired to intercept — pinned against
 * the `enforce-phase-tools.sh` matchers in `hooks/hooks.json` by
 * tests/machine/hooks-sync.test.ts (Edit / Write / MultiEdit). A machine
 * enforcing a tool outside this set would declare a guarantee the hook
 * never delivers, so parseMachine rejects it. FILE_MODIFYING_TOOLS
 * (core/tool-vocabulary.ts) is DERIVED from this tuple — one source of
 * truth for "tools that write files".
 */
export const GATE_WIRED_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

/**
 * A tool the PreToolUse gate is wired for. `enforcedTools`/`allowedTools`
 * carry this type (not `string`) because parseMachine PROVES membership in
 * GATE_WIRED_TOOLS before constructing a MachineDef — the type records the
 * proof instead of discarding it.
 */
export type GateWiredTool = (typeof GATE_WIRED_TOOLS)[number];

/** A guard: "at least `min` events of `event` observed". No expressions. */
export interface Requirement {
  readonly event: EventToken;
  readonly min: number;
}

/**
 * A phase is EITHER working (has an advance guard, no completion
 * requirements) OR terminal (has completion requirements, nothing to
 * advance to). The discriminant makes the illegal combinations —
 * terminal-with-advance, working-without-advance, working-with-requires —
 * unrepresentable, so consumers never null-check `advance` or guess
 * whether `requires` is meaningful.
 */
export type PhaseDef =
  | {
      readonly terminal: false;
      readonly id: string;
      /**
       * Tools from the machine's `enforcedTools` jurisdiction that this phase
       * permits. Deny-by-default within the jurisdiction: an enforced tool not
       * listed here is blocked while this phase is current.
       */
      readonly allowedTools: readonly GateWiredTool[];
      /** Guard to advance past this phase. */
      readonly advance: Requirement;
    }
  | {
      readonly terminal: true;
      readonly id: string;
      readonly allowedTools: readonly GateWiredTool[];
      /** Evidence that must exist for clean completion. */
      readonly requires: readonly Requirement[];
    };

/**
 * Brand: only `parseMachine` produces a MachineDef. The symbol is declared
 * (never exported, never given a runtime value), so no other module can
 * structurally construct one — "a MachineDef that exists is structurally
 * valid by construction" is now enforced by the type system, not by a
 * header comment.
 */
declare const MACHINE_PARSED: unique symbol;

export type MachineDef = {
  /** Agent type this machine binds to (e.g. "code-implementer-agent").
   *  BRANDED: parseMachine proves it through parseAgentType, so a machine's
   *  agent can always safely name its definition file and key epochs. */
  readonly agent: AgentType;
  /**
   * The closed set of tools this machine claims authority over.
   * Tools outside this set always pass the gate — the machine is honest
   * about its jurisdiction instead of pretending to enforce everything.
   */
  readonly enforcedTools: readonly GateWiredTool[];
  readonly phases: readonly PhaseDef[];
} & { readonly [MACHINE_PARSED]: true };

// --- Runtime state (a pure fold over the evidence ledger) ---

export interface PhaseState {
  readonly phaseIndex: number;
  readonly counts: EventCounts;
}

export const initialState: PhaseState = { phaseIndex: 0, counts: ZERO_COUNTS };

// --- Parse results (parse, don't validate) ---

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const parseOk = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const parseErr = <T>(error: string): ParseResult<T> => ({ ok: false, error });
