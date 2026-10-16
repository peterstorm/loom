/**
 * Harness tool-call adapters: the two pure parsers that normalize one
 * finished tool call into the harness-neutral `HarnessToolCall` the shared
 * minting rule reads (AD-8, INV-4).
 *
 * - `claudeToolCall(payload)` reads Claude Code's PostToolUse hook payload.
 * - `piToolCall(event, cwd)` reads a Pi child's `tool_result` event.
 *
 * Each reads its harness's own result shape and nothing else, so the facts
 * the shared shell (`machine/tool-evidence-recorder.ts`) mints from one call
 * are the same on both harnesses. Both are total: an unknown shape degrades
 * to the outcome that trusts least, never to a throw.
 *
 * Pi 0.83 `tool_result` shape, probed in
 * `@earendil-works/pi-coding-agent@0.83.0` (dist/core/extensions/types.d.ts,
 * dist/core/tools/bash.js, dist/core/extensions/runner.js), and unchanged in
 * 0.84.2:
 *
 *   { type: "tool_result"; toolName: "bash" | "read" | "edit" | "write" | …;
 *     toolCallId: string; input: Record<string, unknown>;
 *     content: (TextContent | ImageContent)[]; isError: boolean; details }
 *
 * - The bash tool exposes NO exit code: `details` is
 *   `{ truncation?, fullOutputPath? } | undefined`. A nonzero exit throws,
 *   which Pi reports as `isError: true` with the text content ending in
 *   `Command exited with code N`. An abort ends in `Command aborted`; a
 *   timeout in `Command timed out after N seconds`. Both are kills: the
 *   command never finished.
 * - File tools report failure only through `isError`. Pi's tools take the
 *   file path as `input.path` (Claude Code: `input.file_path`).
 * - `tool_result` handlers chain: a later handler sees an earlier handler's
 *   `content`/`isError` rewrite. The Pi recorder therefore registers before
 *   every other `tool_result` handler, so it reads the tool's own result.
 */

import { isRecord } from "./plain-record";
import type {
  BashToolOutcome,
  FileToolOutcome,
  HarnessToolCall,
  ToolCallId,
} from "../machine/harness-tool-call-types";

/** The parsed harness call id: a non-empty string, or no id at all. */
function parseToolCallId(raw: unknown): ToolCallId | null {
  return typeof raw === "string" && raw !== "" ? (raw as ToolCallId) : null;
}

const recordOrEmpty = (raw: unknown): Readonly<Record<string, unknown>> => (isRecord(raw) ? raw : {});

const isIntegerExit = (raw: unknown): raw is number => typeof raw === "number" && Number.isInteger(raw);

/** Build the call for its tool, so each tool carries only its own outcome kind. */
function normalized(
  tool: HarnessToolCall["tool"],
  common: Pick<HarnessToolCall, "input" | "callId" | "cwd">,
  fileOutcome: () => FileToolOutcome,
  bashOutcome: () => BashToolOutcome,
): HarnessToolCall {
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { ...common, tool, outcome: fileOutcome() };
    case "Bash":
      return { ...common, tool, outcome: bashOutcome() };
    case "Other":
      return { ...common, tool };
  }
}

// ─── Claude Code ──────────────────────────────────────────────────────────

/** Claude Code's tool names already are the harness vocabulary. */
const CLAUDE_TOOLS: Readonly<Record<string, HarnessToolCall["tool"]>> = Object.freeze({
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "MultiEdit",
  Bash: "Bash",
});

/** The PostToolUse hook payload fields the adapter reads. `cwd` is required:
 *  the hook shell supplies its own fallback when the harness sent none. */
export type ClaudeToolPayload = Readonly<{
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
  cwd: string;
}>;

/**
 * Did Claude Code report this file-tool call as FAILED? Field names vary
 * across harness versions (`is_error`, `isError`, `success: false`, an
 * `error` payload); unknown shapes count as success so the recorder does not
 * silently starve the ledger on a harness format change.
 */
export function isClaudeToolFailure(toolResponse: unknown): boolean {
  if (!isRecord(toolResponse)) return false;
  if (toolResponse.is_error === true || toolResponse.isError === true) return true;
  if (toolResponse.success === false) return true;
  if (typeof toolResponse.error === "string" && toolResponse.error.trim() !== "") return true;
  return typeof toolResponse.error === "object" && toolResponse.error !== null;
}

/**
 * A Claude Code Bash `tool_response`, read defensively. `interrupted: true`
 * is a kill. An integer `exit_code` (or the `exitCode`, `returnCode`, `code`
 * spellings of other harness versions) is the exit; anything else is an
 * unknown exit, which never counts as success on its own. A bare string
 * response is the stdout of a run with no reported exit.
 */
export function claudeBashOutcome(toolResponse: unknown): BashToolOutcome {
  if (typeof toolResponse === "string") return { kind: "exit-unknown", stdout: toolResponse };
  if (!isRecord(toolResponse)) return { kind: "exit-unknown", stdout: "" };
  if (toolResponse.interrupted === true) return { kind: "interrupted" };
  const stdoutRaw = toolResponse.stdout ?? toolResponse.output;
  const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";
  const exit = toolResponse.exit_code ?? toolResponse.exitCode ?? toolResponse.returnCode ?? toolResponse.code;
  return isIntegerExit(exit) ? { kind: "exited", exit, stdout } : { kind: "exit-unknown", stdout };
}

/** Normalize Claude Code's PostToolUse payload. */
export function claudeToolCall(payload: ClaudeToolPayload): HarnessToolCall {
  return normalized(
    CLAUDE_TOOLS[payload.tool_name] ?? "Other",
    { input: recordOrEmpty(payload.tool_input), callId: parseToolCallId(payload.tool_use_id), cwd: payload.cwd },
    () => (isClaudeToolFailure(payload.tool_response) ? { kind: "failed" } : { kind: "succeeded" }),
    () => claudeBashOutcome(payload.tool_response),
  );
}

// ─── Pi ───────────────────────────────────────────────────────────────────

/** Pi's lowercase tool names, mapped onto the harness vocabulary. Every
 *  other Pi tool (`grep`, `find`, `ls`, `subagent`, custom tools) is `Other`. */
const PI_TOOLS: Readonly<Record<string, HarnessToolCall["tool"]>> = Object.freeze({
  read: "Read",
  write: "Write",
  edit: "Edit",
  multi_edit: "MultiEdit",
  bash: "Bash",
});

/** The `tool_result` event fields the adapter reads, all untrusted. */
export type PiToolResultEvent = Readonly<{
  /** Pi's event discriminant (`"tool_result"`); not read. */
  type?: string;
  toolName: string;
  toolCallId?: unknown;
  input?: unknown;
  content?: unknown;
  isError?: unknown;
  details?: unknown;
}>;

/** The status line Pi's bash tool appends when it killed the command. */
const PI_KILLED_STATUS = /(?:^|\n)Command (?:aborted|timed out after \d+ seconds)$/;

/** The text blocks of a Pi result, joined: the captured output. */
function piText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

/**
 * A Pi bash result's outcome, read only from that call's own result (FR-033):
 * `details.exitCode` when it is an integer, otherwise `isError` read as 1 or
 * 0. An error result ending in Pi's abort or timeout status line is a kill:
 * the command never finished, so it is `interrupted`. `details.exitCode` is
 * absent in Pi 0.83 and 0.84 (see the shape above); that branch exists only
 * for a future Pi version that adds it.
 */
function piBashOutcome(event: PiToolResultEvent): BashToolOutcome {
  const stdout = piText(event.content);
  const exitCode = isRecord(event.details) ? event.details.exitCode : undefined;
  if (isIntegerExit(exitCode)) return { kind: "exited", exit: exitCode, stdout };
  const failed = event.isError === true;
  if (failed && PI_KILLED_STATUS.test(stdout.trimEnd())) return { kind: "interrupted" };
  return { kind: "exited", exit: failed ? 1 : 0, stdout };
}

/** Normalize a Pi child's `tool_result` event. Pi events carry no cwd: the
 *  shell passes the session's. */
export function piToolCall(event: PiToolResultEvent, cwd: string): HarnessToolCall {
  return normalized(
    PI_TOOLS[event.toolName] ?? "Other",
    { input: recordOrEmpty(event.input), callId: parseToolCallId(event.toolCallId), cwd },
    () => (event.isError === true ? { kind: "failed" } : { kind: "succeeded" }),
    () => piBashOutcome(event),
  );
}
