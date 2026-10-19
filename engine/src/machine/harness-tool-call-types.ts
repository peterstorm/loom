/**
 * CT-3 frozen surface: Pi ledger capture through the shared minting rule.
 *
 * Declarations only. These bytes freeze at the CT-3 Wave Gate; only an
 * operator Contract Revision may change them.
 *
 * One minting rule serves both harnesses (AD-8, INV-4). Each harness adapter
 * normalizes its own tool event into a `HarnessToolCall`:
 * - Claude Code: `claudeToolCall(payload)` over the PostToolUse or
 *   PostToolUseFailure hook payload;
 * - Pi: `piToolCall(event)` over the child's `tool_result` event, mapping
 *   Pi's lowercase tool names onto `HarnessTool`.
 *
 * Both then call the one shared shell, `recordToolEvidence(target, call,
 * ports)` (a `RecordToolEvidenceFn`), the only caller of `extractEvidence`
 * and of `.appendEvidence`. The same tool call therefore yields the same
 * ledger facts on both harnesses (FR-031, AS-036, SC-007).
 *
 * Where the facts go is an `EvidenceTarget`. On Claude Code it is the hook
 * session's ledger under the caller's binding epoch. On Pi it is the PARENT
 * session's ledger, named by the write grant's `PiEvidenceLedgerAddress`,
 * under `epochOf(grant.agentId, agentType)` (FR-032). A Pi child that holds
 * no usable grant decides `PiEvidenceNoRecord` instead and records nothing
 * (AS-039).
 */

import type { AgentType, SessionId, SessionRegistry } from "./evidence";
import type { Epoch, Evidence } from "./types";

/**
 * The closed, harness-neutral tool vocabulary the minting rule reads.
 *
 * Claude Code's tool names are already these. Pi's lowercase names (`read`,
 * `write`, `edit`, `multi_edit`, `bash`) map onto them; every other tool is
 * `Other` and mints nothing.
 */
export type HarnessTool = "Read" | "Write" | "Edit" | "MultiEdit" | "Bash" | "Other";

/** The file tools: each one either succeeded or failed, and has no exit status. */
export type FileTool = Exclude<HarnessTool, "Bash" | "Other">;

/**
 * What the harness reported about one finished Read, Write, Edit or MultiEdit
 * call, read only from that call's own result.
 * - `succeeded`: the call mints its FileRead or `via: "tool"` FileWrite.
 * - `failed`: an error-shaped Claude `tool_response` (`is_error`, `isError`,
 *   `success: false`, or an `error` payload), or Pi's `isError`. Mints
 *   nothing, so an attempt never satisfies a machine guard.
 */
export type FileToolOutcome =
  | Readonly<{ kind: "succeeded" }>
  | Readonly<{ kind: "failed" }>;

/**
 * What the harness reported about one Bash call, read only from that call's
 * own result. Bash has no `failed` arm: its exit status is the ground truth,
 * and a failing test run is a trusted failure, not a non-event. Shell write
 * targets mint in every arm, because the shell opens a redirect target before
 * the command runs.
 * - `exited`: the command finished with this integer exit status (FR-033).
 *   Claude Code: 0 for a PostToolUse success, and the `Exit code N` a
 *   PostToolUseFailure `error` names. Pi:
 *   `details.exitCode` when it is a number, otherwise `isError ? 1 : 0`, so
 *   Pi always lands here or in `interrupted`. A TestRun gets this `exit`
 *   (through exit attribution) and may pair with a discovered report.
 * - `exit-unknown`: the command finished, but the harness exposed no exit
 *   status (an unrecognized Claude `tool_response` shape, or a success the
 *   harness reinterpreted from a non-zero exit). A TestRun gets
 *   `exit: null`, which never counts as success on its own. A report may
 *   still pair with it, because the run finished.
 * - `interrupted`: the harness killed the call (timeout or abort), or ran it
 *   in the background, so the command never finished within the call. A TestRun gets `exit: null` and `report: null`:
 *   a killed runner leaves a partial report that can read green, so only a
 *   finished run may vouch. No stdout is carried, because none is trusted.
 *
 * `stdout` is the call's captured standard output, which report discovery
 * reads for a JSON reporter on stdout.
 */
export type BashToolOutcome =
  | Readonly<{ kind: "exited"; exit: number; stdout: string }>
  | Readonly<{ kind: "exit-unknown"; stdout: string }>
  | Readonly<{ kind: "interrupted" }>;

/** Every outcome a harness can report for a call that mints facts. */
export type ToolOutcome = FileToolOutcome | BashToolOutcome;

declare const TOOL_CALL_ID: unique symbol;

/**
 * A non-empty tool-call id supplied by the harness (Claude's `tool_use_id`,
 * Pi's `toolCallId`). The harness adapters are its only producers, and they
 * read an empty or non-string id as no id at all, so `""` never stands for
 * "absent". It is assignable to `string`, so it passes straight to the
 * registry's `appendEvidence` and `callStartFor`.
 */
export type ToolCallId = string & { readonly [TOOL_CALL_ID]: true };

/** The fields every normalized tool call carries, whatever its tool. */
type HarnessToolCallCommon = Readonly<{
  /**
   * The tool input exactly as the harness delivered it. The rule reads only
   * the file path (`file_path` on Claude Code, `path` on Pi) and `command`.
   */
  input: Readonly<Record<string, unknown>>;
  /**
   * The harness tool-call id: the ledger idempotency key and the key of the
   * call-start stamp. `null` when the harness supplied none. Then the facts
   * append without an idempotency key, and artifact-backed reports cannot
   * vouch (fail closed).
   */
  callId: ToolCallId | null;
  /** The directory the call ran in. Relative FileWrite paths resolve against it at mint time. */
  cwd: string;
}>;

/**
 * One finished tool call, normalized from either harness. `tool` is the
 * discriminant, and it fixes which outcome the call can carry: a file tool
 * never has an exit status, Bash never has a bare `failed`, and `Other`
 * carries no outcome because it mints nothing.
 */
export type HarnessToolCall =
  | (HarnessToolCallCommon & Readonly<{ tool: FileTool; outcome: FileToolOutcome }>)
  | (HarnessToolCallCommon & Readonly<{ tool: "Bash"; outcome: BashToolOutcome }>)
  | (HarnessToolCallCommon & Readonly<{ tool: "Other" }>);

/** Where one tool call's facts are appended. */
export type EvidenceTarget = Readonly<{
  kind: "record";
  /** The session whose ledger receives the facts. On Pi, the parent session. */
  ledger: SessionId;
  /** The epoch the facts are stamped with. On Pi, `epochOf(grant.agentId, agentType)`. */
  epoch: Epoch;
  /**
   * The session the call-start stamp for this call was written under. On
   * Claude Code it is the ledger session. On Pi it is the child's own session,
   * because the child's `tool_call` handler stamps there.
   */
  stamps: SessionId;
}>;

/**
 * The parent session's ledger address a Pi write grant carries
 * (`IssuedWriteGrant.evidenceLedger`). The parent mints it at spawn from its
 * own session and the spawn item's agent type.
 */
export type PiEvidenceLedgerAddress = Readonly<{
  sessionId: SessionId;
  agentType: AgentType;
}>;

/**
 * Why a Pi child records nothing. The child's stderr note names the reason
 * with exactly this literal (AS-039).
 * - `no-grant`: the child session activated no write grant.
 * - `grant-rejected`: the child's grant was rejected at activation.
 * - `cleanup-pending`: the child's binding survives only as cleanup debt.
 */
export type PiEvidenceNoRecordReason = "no-grant" | "grant-rejected" | "cleanup-pending";

export type PiEvidenceNoRecord = Readonly<{
  kind: "no-record";
  reason: PiEvidenceNoRecordReason;
}>;

/** The Pi recorder's one total decision over the child's grant state (`piEvidenceTarget`). */
export type PiEvidenceTargetDecision = EvidenceTarget | PiEvidenceNoRecord;

/** The ledger and clock the shared shell reads and writes. */
export type ToolEvidencePorts = Readonly<{
  registry: Pick<SessionRegistry, "readEvidence" | "appendEvidence" | "callStartFor">;
  nowMs: () => number;
}>;

/**
 * The shared minting shell. It mints the call's facts with `extractEvidence`,
 * wires report discovery with the agent-authored-artifact veto (the target
 * epoch's FileWrites plus this call's own write targets) and the call-start
 * stamp read from `target.stamps`, resolves FileWrite paths against
 * `call.cwd`, appends the facts to `target.ledger` under `target.epoch`, and
 * returns exactly the facts it appended.
 */
export type RecordToolEvidenceFn = (
  target: EvidenceTarget,
  call: HarnessToolCall,
  ports: ToolEvidencePorts,
) => readonly Evidence[];
