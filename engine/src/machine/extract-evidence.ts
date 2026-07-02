/**
 * Map a completed tool call (PostToolUse) to evidence events.
 *
 * Pure given its inputs — the Bash outcome (exit/stdout) and report lookup
 * are supplied by the caller so this module stays testable without IO.
 *
 * Command classification parses, it does not substring-match: the command
 * is split into simple-command segments, comments stripped, env prefixes
 * removed, and a runner pattern must match at the HEAD of a segment. That
 * kills the prose spoofs (`echo '...' # npm test --json`, `git grep "npm
 * test"` minting trusted failures) that whole-string `.includes` allowed.
 */

import { FILE_MODIFYING_TOOLS, TEST_COMMAND_PATTERNS } from "../core/tool-vocabulary";
import type { Evidence, TestReportSummary } from "./types";

/**
 * The simple-command segment that a test-runner pattern matches at head
 * position, or null when the command is not a test invocation.
 */
export function classifyTestCommand(command: string): string | null {
  const segments = command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.replace(/(^|\s)#.*$/, "").trim())
    // Strip leading VAR=value assignments so `CI=1 npm test` matches.
    .map((s) => s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter((s) => s !== "");

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (TEST_COMMAND_PATTERNS.some((p) => lower.startsWith(p))) return segment;
  }
  return null;
}

/** Backwards-compatible boolean view of classifyTestCommand. */
export function isTestCommand(command: string): boolean {
  return classifyTestCommand(command) !== null;
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
 * Evidence for one tool call — facts only; judgments happen at fold time.
 * Returns [] for tool calls that carry no ground-truth signal (the
 * vocabulary is closed on purpose).
 */
export function extractEvidence(
  toolName: string,
  toolInput: Record<string, unknown>,
  outcome: BashOutcome,
  findReportForSegment: (segment: string, stdout: string) => TestReportSummary | null,
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
    const segment = classifyTestCommand(command);
    if (segment === null) return [];
    const report = findReportForSegment(segment, outcome.stdout);
    return [{ kind: "TestRun", command, exit: outcome.exit, report }];
  }

  return [];
}
