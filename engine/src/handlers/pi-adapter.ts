/**
 * Pi extension adapter — pure functions for post-edit lint and advisory type
 * diagnostics via tool_result events (I/O arrives as injected ports).
 *
 * Satisfies:
 * - FR-018: Pi extension adapter integrating via Pi's event API
 * - US6: Developer using Pi with wave-based agents gets immediate lint feedback after edits
 *
 * This is a PURE FUNCTION (functional core) — fully testable without the Pi runtime.
 * The imperative shell (pi/extension.ts) calls this with the lint result.
 */

import { match } from "ts-pattern";
import type { LintResult } from "../linter/index";
import { formatOutput, formatBlockMessage } from "../linter/index";
import { adviceForEdit, type AdviseOnEdit } from "../core/type-diagnostics";

// --- Response type (mirrors Pi's ToolResultEventResult) ---

export interface PiToolResultResponse {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError: boolean;
}

// --- Tool names that trigger lint ---

// Pi tool names are lowercase (vs PascalCase in Claude Code's PostToolUse)
const LINT_TRIGGER_TOOLS = new Set(["edit", "write", "multi_edit"]);

/**
 * Determines whether a tool_result event should trigger linting.
 * Only edit and write tools modify files and need lint checks.
 */
export function shouldTriggerLint(toolName: string): boolean {
  return LINT_TRIGGER_TOOLS.has(toolName);
}

/**
 * Extracts the file path from a tool_result event's input.
 * Both edit and write tools use `input.path` for the file path.
 *
 * Returns null if path is missing or not a string (graceful handling).
 */
export function extractFilePath(input: Record<string, unknown>): string | null {
  const path = input?.path;
  if (typeof path === "string" && path.trim().length > 0) {
    return path;
  }
  return null;
}

/**
 * Pure adapter: maps a LintResult to a Pi tool_result response.
 *
 * - pass → undefined (no injection, agent continues normally)
 * - violations → { content: [formatted message], isError: true } (agent sees and fixes)
 * - error → { content: [error message], isError: true } (fail-closed — agent sees error)
 */
export function handleLintResult(
  filePath: string,
  lintResult: LintResult
): PiToolResultResponse | undefined {
  return match(lintResult)
    .with({ kind: "pass" }, () => undefined)
    .with({ kind: "violations" }, (r) => {
      const output = formatOutput(r, filePath);
      const message = formatBlockMessage(output);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      } satisfies PiToolResultResponse;
    })
    .with({ kind: "error" }, (r) => {
      const output = formatOutput(r, filePath);
      const message = formatBlockMessage(output);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      } satisfies PiToolResultResponse;
    })
    .exhaustive();
}

/**
 * Compose the post-edit tool_result: the fail-closed lint verdict (if any)
 * and the advisory type diagnostics (if any). Pi chains tool_result handlers
 * on one shared event, so both live in ONE handler: a later handler could
 * not tell a lint flag from a tool error, and a lint replacement would drop
 * an advisory appended before it.
 *
 * - lint replaces the content and decides `isError`, as it always has
 * - the advisory is appended after whatever content stands, and never sets `isError`
 * - nothing to say → undefined (the tool result is untouched)
 */
export function composePostEditResult<C>(
  original: Readonly<{ content: readonly C[]; isError: boolean }>,
  lint: PiToolResultResponse | undefined,
  typeAdvisory: string | null,
): Readonly<{ content: readonly (C | { readonly type: "text"; readonly text: string })[]; isError: boolean }> | undefined {
  if (lint === undefined && typeAdvisory === null) return undefined;
  const base = lint === undefined ? original : lint;
  return {
    content: typeAdvisory === null ? [...base.content] : [...base.content, { type: "text" as const, text: typeAdvisory }],
    isError: base.isError,
  };
}

/** What the post-edit flow needs from the Pi runtime and the engine. */
export type PiPostEditPorts = Readonly<{
  /** Relative edited paths resolve against this for the type check. */
  projectRoot: string;
  lint: (filePath: string) => LintResult;
  advise: AdviseOnEdit;
  notifyOperator: (note: string) => void;
}>;

/**
 * The whole post-edit tool_result for one Pi event: immediate-tier lint (fail
 * closed), then the advisory type check (fail open), composed by
 * `composePostEditResult`, with any operator note sent to the operator only.
 * The type check runs after lint returns, so on a cold build Pi's lint
 * feedback waits up to the type-diagnostics deadline (see docs/operations.md).
 */
export async function piPostEdit<C>(
  event: Readonly<{ toolName: string; input: Record<string, unknown>; content: readonly C[]; isError: boolean }>,
  ports: PiPostEditPorts,
): Promise<ReturnType<typeof composePostEditResult<C>>> {
  if (!shouldTriggerLint(event.toolName) || event.isError) return undefined;
  const lint = processToolResult(event.toolName, event.input, ports.lint);
  const path = extractFilePath(event.input);
  const advisory = path === null ? null : await adviceForEdit(path, ports.projectRoot, ports.advise);
  if (advisory?.forOperator) ports.notifyOperator(advisory.forOperator);
  return composePostEditResult(event, lint, advisory?.forModel ?? null);
}

/** The slice of Pi's extension context an operator note needs. */
export type PiOperatorChannel = Readonly<{
  hasUI: boolean;
  ui: Readonly<{ notify: (message: string, level: "warning") => void }>;
}>;

/** Where a Pi operator note goes: the UI when there is one, else stderr — never nowhere. */
export const piOperatorNoteSink = (ctx: PiOperatorChannel, stderr: (line: string) => void) => (note: string): void => {
  if (ctx.hasUI) ctx.ui.notify(note, "warning");
  else stderr(`[loom] ${note}`);
};

/**
 * Top-level adapter orchestrator (still pure — takes lintFile as a dependency).
 *
 * Composes: shouldTriggerLint → extractFilePath → lintFn → handleLintResult
 *
 * @param toolName - The tool that completed (e.g. "edit", "write", "read")
 * @param input - The tool's input record (contains `path`)
 * @param lintFn - Injected lint function (for testability without file system)
 * @returns PiToolResultResponse | undefined
 */
export function processToolResult(
  toolName: string,
  input: Record<string, unknown>,
  lintFn: (filePath: string) => LintResult
): PiToolResultResponse | undefined {
  if (!shouldTriggerLint(toolName)) {
    return undefined;
  }

  const filePath = extractFilePath(input);
  if (filePath === null) {
    // No file path — fail-closed with error message
    return {
      content: [{ type: "text", text: "❌ LINT ENGINE ERROR: Could not extract file path from tool input" }],
      isError: true,
    };
  }

  let lintResult: LintResult;
  try {
    lintResult = lintFn(filePath);
  } catch (error: unknown) {
    // Fail-closed: lintFn throwing is treated as a lint engine error
    const message = error instanceof Error ? error.message : String(error);
    lintResult = { kind: "error", message: `lintFn threw: ${message}` };
  }
  return handleLintResult(filePath, lintResult);
}
