/**
 * Core types for loom hook handlers
 */

import { match } from "ts-pattern";

// --- Hook Result (discriminated union) ---

export type HookResult =
  | { kind: "allow" }
  | { kind: "block"; message: string }
  | { kind: "error"; message: string }
  | { kind: "passthrough" };

/** Defense-in-depth: collapse empty diagnostic messages to a sentinel so
 *  a silent error/block can never reach the user. Used at the cli exit boundary. */
export function nonEmptyMessage(s: string | undefined | null): string {
  return s && s.trim() !== "" ? s : "<no message provided>";
}

/** Smart constructors — preferred over object literals so callers funnel through nonEmptyMessage. */
export const allowResult = (): HookResult => ({ kind: "allow" });
export const passthroughResult = (): HookResult => ({ kind: "passthrough" });
export const errorResult = (message: string): HookResult => ({ kind: "error", message: nonEmptyMessage(message) });
export const blockResult = (message: string): HookResult => ({ kind: "block", message: nonEmptyMessage(message) });

// --- Handler signature ---

export type HookHandler = (stdin: string, args: string[]) => Promise<HookResult>;

// --- Hook input types (from Claude Code stdin JSON) ---

export interface PreToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
}

export interface SubagentStopInput {
  session_id: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

export interface SubagentStartInput {
  session_id: string;
  agent_id?: string;
  agent_type?: string;
}

// --- Task Graph state ---

/** Phase ordering — the const tuple is the single source of truth so both
 *  the `Phase` type and config's PHASE_ORDER derive from it (dropping a phase
 *  can't leave the type wider than what parseTaskGraph proves against). */
export const PHASES = [
  "init", "brainstorm", "specify", "clarify", "architecture", "plan-alignment", "decompose", "execute",
] as const;
export type Phase = (typeof PHASES)[number];

/** Task status values — the const tuple is the source of truth so parsers
 *  (parseTaskGraph) can prove disk values against it. */
export const TASK_STATUSES = ["pending", "implemented", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REVIEW_STATUSES = ["pending", "passed", "blocked", "evidence_capture_failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Per-task test outcome with its trust provenance IN the data. Trusted
 * verdicts come from the evidence ledger (real exit status cross-checked
 * against a parsed report artifact) and need no qualifier; an untrusted
 * verdict carries what the low-trust source claimed (`passed`) and a label
 * naming exactly how weak that source is. An independent boolean pair
 * would permit the impossible {passed: true, trusted: false → "trusted"?}
 * drift — this shape does not.
 */
export type TaskTestResult =
  | { readonly verdict: "trusted-pass" }
  | { readonly verdict: "trusted-fail" }
  | { readonly verdict: "untrusted"; readonly passed: boolean; readonly label: string };

/** Did the task's test evidence show a pass at ANY trust level? (Gate checks
 *  that need trust must match on `verdict` instead.) */
export function testResultPassed(result: TaskTestResult | undefined): boolean {
  if (result === undefined) return false;
  return match(result)
    .with({ verdict: "trusted-pass" }, () => true)
    .with({ verdict: "trusted-fail" }, () => false)
    .with({ verdict: "untrusted" }, ({ passed }) => passed)
    .exhaustive();
}

/**
 * Pre-refactor task graphs stored `tests_passed: boolean` on the task; the
 * field was replaced by `test_result` with NO compat read (the branch never
 * shipped). Such a task now reads as missing evidence — correct, but
 * mystifying without a note. Pure: returns the operator-facing explanation
 * when the raw task object carries the legacy field without its
 * replacement, null otherwise.
 */
export function legacyTestsPassedNote(task: unknown): string | null {
  if (typeof task !== "object" || task === null) return null;
  const raw = task as Record<string, unknown>;
  if (!("tests_passed" in raw) || "test_result" in raw) return null;
  const id = typeof raw.id === "string" ? raw.id : "<unknown>";
  return `legacy tests_passed found on task ${id}; re-run task or regenerate graph — field replaced by test_result`;
}

export interface Task {
  id: string;
  description: string;
  agent: string;
  wave: number;
  status: TaskStatus;
  depends_on: string[];
  spec_anchors?: string[];
  new_tests_required?: boolean;
  /** Files this task creates/modifies (decompose contract); older graphs may lack it */
  file_list?: string[];
  /** Test outcome + trust provenance; absent until an impl agent completes. */
  test_result?: TaskTestResult;
  test_evidence?: string;
  new_tests_written?: boolean;
  new_test_evidence?: string;
  files_modified?: string[];
  review_status?: ReviewStatus;
  review_error?: string;
  critical_findings?: string[];
  advisory_findings?: string[];
  start_sha?: string;
  failure_reason?: string;
  retry_count?: number;
}

export interface WaveGate {
  impl_complete: boolean;
  tests_passed: boolean | null;
  reviews_complete: boolean;
  blocked: boolean;
}

/**
 * Closed verdict union for spec-check runs, parsed at the store boundaries
 * (store-spec-check helper, store-spec-check-findings hook) — free-text
 * verdicts never reach the gate's typed logic.
 */
export const SPEC_CHECK_VERDICTS = ["PASSED", "BLOCKED", "EVIDENCE_CAPTURE_FAILED", "UNKNOWN"] as const;
export type SpecCheckVerdict = (typeof SPEC_CHECK_VERDICTS)[number];

/** Smart constructor: null when the raw text is not a known verdict. */
export function parseSpecCheckVerdict(raw: string): SpecCheckVerdict | null {
  return (SPEC_CHECK_VERDICTS as readonly string[]).includes(raw) ? (raw as SpecCheckVerdict) : null;
}

export interface SpecCheck {
  wave: number;
  run_at: string;
  critical_count?: number;
  high_count?: number;
  critical_findings?: string[];
  high_findings?: string[];
  medium_findings?: string[];
  verdict: SpecCheckVerdict;
  error?: string;
}

export interface TaskGraph {
  current_phase: Phase;
  phase_artifacts: Partial<Record<Phase, string>>;
  skipped_phases: Phase[];
  spec_dir?: string | null;
  spec_file: string | null;
  plan_file: string | null;
  plan_title?: string;
  tasks: Task[];
  current_wave?: number;
  executing_tasks?: string[];
  wave_gates: Record<string, WaveGate>;
  github_issue?: number;
  github_repo?: string;
  spec_check?: SpecCheck;
  updated_at?: string;
}
