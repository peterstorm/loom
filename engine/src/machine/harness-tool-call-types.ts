/**
 * CT-3 frozen surface: Pi ledger capture through the shared minting rule.
 *
 * Declarations only. These bytes freeze at the CT-3 Wave Gate; only an
 * operator Contract Revision may change them.
 *
 * One minting rule serves both harnesses (AD-8, INV-4). Each harness adapter
 * normalizes its own tool event into a `HarnessToolCall`:
 * - Claude Code: `claudeToolCall(payload)` over the PostToolUse hook payload;
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

/**
 * What the harness reported about one finished tool call, read only from that
 * call's own result.
 */
export type ToolOutcome = Readonly<{
  /**
   * The harness reported the call as failed: an error-shaped Claude
   * `tool_response`, or Pi's `isError`. A failed Read, Write, Edit or
   * MultiEdit mints no FileRead or FileWrite.
   */
  failed: boolean;
  /**
   * The Bash exit status (FR-033). Claude Code: the exit code its
   * `tool_response` carries. Pi: `details.exitCode` when it is a number,
   * otherwise `isError ? 1 : 0`. `null` only when the harness exposes neither.
   */
  exit: number | null;
  /** The call's captured standard output, read for a JSON reporter on stdout. */
  stdout: string;
  /** The harness killed the call (timeout or abort); the command never finished. */
  interrupted: boolean;
}>;

/** One finished tool call, normalized from either harness. */
export type HarnessToolCall = Readonly<{
  tool: HarnessTool;
  /**
   * The tool input exactly as the harness delivered it. The rule reads only
   * the file path (`file_path` on Claude Code, `path` on Pi) and `command`.
   */
  input: Readonly<Record<string, unknown>>;
  outcome: ToolOutcome;
  /**
   * The harness tool-call id: the ledger idempotency key and the key of the
   * call-start stamp. `null` when the harness supplied none, in which case
   * artifact-backed reports cannot vouch (fail closed).
   */
  callId: string | null;
  /** The directory the call ran in. Relative FileWrite paths resolve against it at mint time. */
  cwd: string;
}>;

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
