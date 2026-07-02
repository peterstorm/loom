/**
 * Guarded Skill Machine — core types.
 *
 * Evidence is a CLOSED discriminated union. There is deliberately no
 * expression language: adding an evidence kind is a reviewed code change,
 * not a config entry. Evidence events are captured at execution time
 * (PostToolUse) — transcript text is never evidence.
 */

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
 * A ledger line: an evidence event stamped with the epoch it belongs to.
 * The epoch (`<agent_id>:<agent_type>`, minted at SubagentStart) is what
 * makes evidence attributable — readers fold only their own epoch, so a
 * stale or foreign ledger line is inert rather than cross-credited.
 */
export interface EvidenceRecord {
  readonly epoch: string;
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

/** A guard: "at least `min` events of `event` observed". No expressions. */
export interface Requirement {
  readonly event: EventToken;
  readonly min: number;
}

export interface PhaseDef {
  readonly id: string;
  /**
   * Tools from the machine's `enforcedTools` jurisdiction that this phase
   * permits. Deny-by-default within the jurisdiction: an enforced tool not
   * listed here is blocked while this phase is current.
   */
  readonly allowedTools: readonly string[];
  /** Guard to advance past this phase. Absent only on the terminal phase. */
  readonly advance: Requirement | null;
  readonly terminal: boolean;
  /** Terminal phase only: evidence that must exist for clean completion. */
  readonly requires: readonly Requirement[];
}

export interface MachineDef {
  /** Agent type this machine binds to (e.g. "code-implementer-agent"). */
  readonly agent: string;
  /**
   * The closed set of tools this machine claims authority over.
   * Tools outside this set always pass the gate — the machine is honest
   * about its jurisdiction instead of pretending to enforce everything.
   */
  readonly enforcedTools: readonly string[];
  readonly phases: readonly PhaseDef[];
}

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
