/**
 * Map a completed tool call (PostToolUse) to evidence events.
 *
 * Pure given its inputs — the Bash outcome (exit/stdout) and report lookup
 * are supplied by the caller so this module stays testable without IO.
 */

import { FILE_MODIFYING_TOOLS, TEST_COMMAND_PATTERNS } from "../config";
import { judgeTestRun } from "./test-report";
import type { Evidence, TestReportSummary } from "./types";

export function isTestCommand(command: string): boolean {
  const lower = command.toLowerCase().trim();
  return TEST_COMMAND_PATTERNS.some((p) => lower.includes(p));
}

/** Outcome of a Bash call as reported by the harness at execution time. */
export interface BashOutcome {
  readonly exit: number | null;
  readonly stdout: string;
}

/**
 * Defensively extract exit status + stdout from the harness's tool_response.
 * Field names vary across harness versions; unknown shapes yield exit: null,
 * which downstream treats as untrusted (never as success).
 */
export function extractBashOutcome(toolResponse: unknown): BashOutcome {
  if (typeof toolResponse === "string") return { exit: null, stdout: toolResponse };
  if (typeof toolResponse !== "object" || toolResponse === null) return { exit: null, stdout: "" };

  const o = toolResponse as Record<string, unknown>;
  if (o.interrupted === true) return { exit: null, stdout: "" };

  const exitRaw = o.exit_code ?? o.exitCode ?? o.returnCode ?? o.code;
  const exit = typeof exitRaw === "number" && Number.isInteger(exitRaw) ? exitRaw : null;

  const stdoutRaw = o.stdout ?? o.output;
  const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";

  return { exit, stdout };
}

function filePathOf(toolInput: Record<string, unknown>): string | null {
  const p = toolInput.file_path ?? toolInput.path;
  return typeof p === "string" && p.trim() !== "" ? p : null;
}

/**
 * Evidence for one tool call. Returns [] for tool calls that carry no
 * ground-truth signal (the vocabulary is closed on purpose).
 */
export function extractEvidence(
  toolName: string,
  toolInput: Record<string, unknown>,
  outcome: BashOutcome,
  findReportForCommand: (command: string, stdout: string) => TestReportSummary | null,
): Evidence[] {
  if (toolName === "Read") {
    const path = filePathOf(toolInput);
    return path ? [{ kind: "FileRead", path }] : [];
  }

  if (FILE_MODIFYING_TOOLS.has(toolName)) {
    const path = filePathOf(toolInput);
    return path ? [{ kind: "FileWrite", path }] : [];
  }

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!isTestCommand(command)) return [];
    const report = findReportForCommand(command, outcome.stdout);
    const { passed, trusted } = judgeTestRun(outcome.exit, report);
    return [{ kind: "TestRun", command, exit: outcome.exit, report, passed, trusted }];
  }

  return [];
}
