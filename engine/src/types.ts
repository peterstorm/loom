/**
 * Core types for loom hook handlers
 */

// --- Hook Result (discriminated union) ---

export type HookResult =
  | { kind: "allow" }
  | { kind: "block"; message: string }
  | { kind: "error"; message: string }
  | { kind: "passthrough" };

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

export type Phase = "init" | "brainstorm" | "specify" | "clarify" | "architecture" | "decompose" | "execute";

export type TaskStatus = "pending" | "implemented" | "completed" | "failed";

export type ReviewStatus = "pending" | "passed" | "blocked" | "evidence_capture_failed";

export interface Task {
  id: string;
  description: string;
  agent: string;
  wave: number;
  status: TaskStatus;
  depends_on: string[];
  spec_anchors?: string[];
  new_tests_required?: boolean;
  tests_passed?: boolean;
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

export interface SpecCheck {
  wave: number;
  run_at: string;
  critical_count?: number;
  high_count?: number;
  critical_findings?: string[];
  high_findings?: string[];
  medium_findings?: string[];
  verdict: string;
  error?: string;
}

export interface TaskGraph {
  current_phase: Phase;
  phase_artifacts: Record<string, string>;
  skipped_phases: string[];
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
