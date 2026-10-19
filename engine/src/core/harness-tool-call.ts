/**
 * Harness tool-call adapters: the two pure parsers that normalize one
 * finished tool call into the harness-neutral `HarnessToolCall` the shared
 * minting rule reads (AD-8, INV-4).
 *
 * - `claudeToolCall(payload)` reads Claude Code's PostToolUse or
 *   PostToolUseFailure hook payload.
 * - `piToolCall(event, cwd)` reads a Pi child's `tool_result` event.
 *
 * Each reads its harness's own result shape and nothing else, so the facts
 * the shared shell (`machine/tool-evidence-recorder.ts`) mints from one call
 * are the same on both harnesses. Both are total and never throw. Neither
 * harness hands over an exit code directly. Claude Code reports a finished
 * Bash call through one of two hook events: a success means exit 0, and a
 * failure's `error` names the code (`claudeBashOutcome`). An unknown Claude
 * Code Bash shape degrades to `exit-unknown`, the outcome that trusts least.
 * Pi reads a bash result from `isError` as exit 1 or 0, and an unrecognised
 * one as exit 0 (`piBashOutcome`).
 * An unknown file-tool shape counts as success on both, so a harness format
 * change cannot starve the ledger of writes (`isClaudeToolFailure`).
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

/** A harness tool name's vocabulary entry, read from the table's own keys
 *  only: an untrusted name such as `constructor` is `Other`, never a
 *  prototype member. */
const toolOf = (table: Readonly<Record<string, HarnessToolCall["tool"]>>, name: string): HarnessToolCall["tool"] =>
  Object.hasOwn(table, name) ? table[name] ?? "Other" : "Other";

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

/** The hook payload fields the adapter reads. PostToolUse carries
 *  `tool_response`; PostToolUseFailure carries `error` and `is_interrupt`.
 *  `cwd` is required: the hook shell supplies its own fallback when the
 *  harness sent none. */
export type ClaudeToolPayload = Readonly<{
  hook_event_name?: unknown;
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
  is_interrupt?: unknown;
  tool_use_id?: unknown;
  cwd: string;
}>;

/**
 * How Claude Code delivered one finished call. It fires PostToolUse only when
 * the tool succeeded and PostToolUseFailure when it failed, and a Bash command
 * that exits non-zero is a failed call. Probed in Claude Code 2.1.286: the
 * failure input is `{ tool_name, tool_input, tool_use_id, error, is_interrupt,
 * duration_ms }` beside the session fields, and a Bash `error` starts
 * `Exit code N`.
 */
export type ClaudeToolResult =
  | Readonly<{ kind: "succeeded"; toolResponse: unknown }>
  | Readonly<{ kind: "failed"; error: string; interrupted: boolean }>;

/** The result a Claude Code hook payload reports. Only an explicit
 *  PostToolUseFailure event is a failure; any other payload carries the
 *  PostToolUse `tool_response`. */
export function claudeToolResult(payload: ClaudeToolPayload): ClaudeToolResult {
  return payload.hook_event_name === "PostToolUseFailure"
    ? {
        kind: "failed",
        error: typeof payload.error === "string" ? payload.error : "",
        interrupted: payload.is_interrupt === true,
      }
    : { kind: "succeeded", toolResponse: payload.tool_response };
}

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

/** The line a failed Claude Code Bash call's `error` starts with. */
const CLAUDE_EXIT_LINE = /^(?:Error: )?Exit code (\d+)(?:\n|$)/;

/** The status line Claude Code adds when its Bash timeout killed the command. */
const CLAUDE_TIMED_OUT = /(?:^|\n)Command timed out after /;

/**
 * A failed Claude Code Bash call. An interrupt or a timeout is a kill: the
 * command never finished, even though a timeout's `error` also starts
 * `Exit code 143`. Otherwise `Exit code N` is the exit, and the rest of the
 * error is the captured output. A failure without that line (the command
 * never spawned) has no known exit.
 */
function failedBashOutcome(error: string, interrupted: boolean): BashToolOutcome {
  if (interrupted || CLAUDE_TIMED_OUT.test(error)) return { kind: "interrupted" };
  const exitLine = CLAUDE_EXIT_LINE.exec(error);
  if (exitLine === null) return { kind: "exit-unknown", stdout: error };
  return { kind: "exited", exit: Number(exitLine[1]), stdout: error.slice(exitLine[0].length) };
}

/**
 * A successful Claude Code Bash call, read defensively from its
 * `tool_response`.
 * - `interrupted: true` is a kill. A backgrounded call (`run_in_background`,
 *   or a `backgroundTaskId` in the response) returned before its command
 *   finished, so it reads as unfinished too.
 * - An integer `exit_code` (or the `exitCode`, `returnCode`, `code`
 *   spellings of other harness versions) is the exit.
 * - Claude Code's Bash success shape (`stdout` and a boolean `interrupted`)
 *   means exit 0, unless it carries a `returnCodeInterpretation`: that marks
 *   a non-zero exit the harness chose not to call a failure (`grep` finding
 *   nothing), whose code is unknown.
 * - Anything else, including a bare string, is an unknown exit, which never
 *   counts as success on its own.
 */
function succeededBashOutcome(toolResponse: unknown, input: Readonly<Record<string, unknown>>): BashToolOutcome {
  if (typeof toolResponse === "string") return { kind: "exit-unknown", stdout: toolResponse };
  if (!isRecord(toolResponse)) return { kind: "exit-unknown", stdout: "" };
  if (toolResponse.interrupted === true) return { kind: "interrupted" };
  if (input.run_in_background === true || typeof toolResponse.backgroundTaskId === "string") return { kind: "interrupted" };
  const stdoutRaw = toolResponse.stdout ?? toolResponse.output;
  const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";
  const exit = toolResponse.exit_code ?? toolResponse.exitCode ?? toolResponse.returnCode ?? toolResponse.code;
  if (isIntegerExit(exit)) return { kind: "exited", exit, stdout };
  const successShape = typeof toolResponse.stdout === "string" && typeof toolResponse.interrupted === "boolean";
  const reinterpreted = typeof toolResponse.returnCodeInterpretation === "string";
  return successShape && !reinterpreted ? { kind: "exited", exit: 0, stdout } : { kind: "exit-unknown", stdout };
}

/** A Claude Code Bash call's outcome, from the hook event that delivered it. */
export function claudeBashOutcome(result: ClaudeToolResult, input: Readonly<Record<string, unknown>> = {}): BashToolOutcome {
  return result.kind === "failed"
    ? failedBashOutcome(result.error, result.interrupted)
    : succeededBashOutcome(result.toolResponse, input);
}

/** Normalize Claude Code's PostToolUse or PostToolUseFailure payload. */
export function claudeToolCall(payload: ClaudeToolPayload): HarnessToolCall {
  const result = claudeToolResult(payload);
  const input = recordOrEmpty(payload.tool_input);
  return normalized(
    toolOf(CLAUDE_TOOLS, payload.tool_name),
    { input, callId: parseToolCallId(payload.tool_use_id), cwd: payload.cwd },
    () => (result.kind === "failed" || isClaudeToolFailure(result.toolResponse) ? { kind: "failed" } : { kind: "succeeded" }),
    () => claudeBashOutcome(result, input),
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
    toolOf(PI_TOOLS, event.toolName),
    { input: recordOrEmpty(event.input), callId: parseToolCallId(event.toolCallId), cwd },
    () => (event.isError === true ? { kind: "failed" } : { kind: "succeeded" }),
    () => piBashOutcome(event),
  );
}
