/**
 * Map a completed tool call (PostToolUse) to evidence events.
 *
 * Pure given its inputs — the tool_response shape parsing and report lookup
 * are supplied/consumed here so this module stays testable without IO.
 *
 * Command classification parses, it does not substring-match: the command
 * is split into simple-command segments (QUOTE-AWARE — a separator inside
 * `"…"`, `'…'`, or backticks does not split, so a runner name embedded in a
 * quoted argument can never become a segment head), comments stripped, env
 * prefixes removed, and a runner pattern must match at the HEAD of a
 * segment followed by a token boundary. That kills the prose spoofs
 * (`echo '...' # npm test --json`, `git grep "npm test"`) AND the quoted
 * forgeries (`true "; npx vitest --reporter=json "; echo '{...}'`) that
 * naive splitting allowed to mint trusted verdicts.
 */

import { FILE_MODIFYING_TOOLS, TEST_COMMAND_PATTERNS } from "../core/tool-vocabulary";
import type { Evidence, TestReportSummary } from "./types";

const QUOTE_CHARS = ['"', "'", "`"] as const;
type QuoteChar = (typeof QUOTE_CHARS)[number];

function isQuoteChar(c: string): c is QuoteChar {
  return (QUOTE_CHARS as readonly string[]).includes(c);
}

/**
 * Split a command line on shell separators (&&, ||, ;, |, newline) —
 * quote-aware: separators inside double quotes, single quotes, or backticks
 * do not split, and a backslash escapes the next character outside single
 * quotes (mirroring sh semantics closely enough that quoted runner text
 * stays inside the segment of the command that owns it).
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: QuoteChar | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      // Inside single quotes nothing is special but the closing quote.
      if (quote !== "'" && c === "\\") {
        current += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (isQuoteChar(c)) {
      quote = c;
      current += c;
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (c === "|") {
      segments.push(current);
      current = "";
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (c === ";" || c === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments;
}

/**
 * A segment with an unbalanced quote can only come from a command whose
 * quoting our splitter (or the shell) could not resolve — classifying it
 * would trust a fragment of someone's string literal. Fail closed: refuse.
 */
export function hasUnbalancedQuotes(segment: string): boolean {
  return QUOTE_CHARS.some((q) => (segment.split(q).length - 1) % 2 === 1);
}

/** The runner pattern must end at a token boundary: `npm testify` is not `npm test`. */
function headMatchesRunner(lowerSegment: string): boolean {
  return TEST_COMMAND_PATTERNS.some(
    (p) =>
      lowerSegment.startsWith(p) &&
      (lowerSegment.length === p.length || /\s/.test(lowerSegment.charAt(p.length))),
  );
}

/**
 * Maven's runner patterns include the goal-less `mvn -pl <module> …` form —
 * only an actual test-executing goal makes the segment a test run
 * (`mvn -pl core install` compiles and installs; it proves nothing about
 * tests).
 */
const MVN_TEST_GOALS = new Set(["test", "verify", "integration-test"]);

function hasMavenTestGoal(lowerSegment: string): boolean {
  return lowerSegment
    .split(/\s+/)
    .some(
      (tok) =>
        MVN_TEST_GOALS.has(tok) ||
        tok.endsWith(":test") ||
        tok.endsWith(":verify") ||
        tok.endsWith(":integration-test"),
    );
}

function isMavenHead(lowerSegment: string): boolean {
  const head = lowerSegment.split(/\s+/, 1)[0] ?? "";
  return head === "mvn" || head === "mvnw" || head === "./mvnw";
}

/**
 * The simple-command segment that a test-runner pattern matches at head
 * position, or null when the command is not a test invocation.
 */
export function classifyTestCommand(command: string): string | null {
  const segments = splitCommandSegments(command)
    .map((s) => s.replace(/(^|\s)#.*$/, "").trim())
    // Strip leading VAR=value assignments so `CI=1 npm test` matches.
    .map((s) => s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter((s) => s !== "");

  for (const segment of segments) {
    if (hasUnbalancedQuotes(segment)) continue; // fail closed: never classify
    const lower = segment.toLowerCase();
    if (!headMatchesRunner(lower)) continue;
    if (isMavenHead(lower) && !hasMavenTestGoal(lower)) continue;
    return segment;
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
 * Did the harness report this tool call as FAILED? Field names vary across
 * harness versions (`is_error`, `success: false`, an `error` payload) —
 * recognize the known error shapes; unknown shapes count as success so the
 * recorder does not silently starve the ledger on a harness format change.
 */
export function isToolFailure(toolResponse: unknown): boolean {
  if (typeof toolResponse !== "object" || toolResponse === null) return false;
  const o = toolResponse as Record<string, unknown>;
  if (o.is_error === true || o.isError === true) return true;
  if (o.success === false) return true;
  if (typeof o.error === "string" && o.error.trim() !== "") return true;
  if (typeof o.error === "object" && o.error !== null) return true;
  return false;
}

/**
 * Evidence for one tool call — facts only; judgments happen at fold time.
 * Returns [] for tool calls that carry no ground-truth signal (the
 * vocabulary is closed on purpose).
 *
 * FileRead/FileWrite facts mean "the tool SUCCEEDED" — a failed Read/Edit
 * (error-shaped tool_response) mints nothing, so a machine guard can never
 * be satisfied by an attempt. Bash still mints TestRun on error responses:
 * the captured exit status IS the ground truth there (a failing test run is
 * a trusted failure, not a non-event), and a response with no usable exit
 * yields exit: null, which downstream never trusts as success.
 */
export function extractEvidence(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  findReportForSegment: (segment: string, stdout: string) => TestReportSummary | null,
): Evidence[] {
  if (toolName === "Read") {
    if (isToolFailure(toolResponse)) return [];
    const path = filePathOf(toolInput);
    return path ? [{ kind: "FileRead", path }] : [];
  }

  if (FILE_MODIFYING_TOOLS.has(toolName)) {
    if (isToolFailure(toolResponse)) return [];
    const path = filePathOf(toolInput);
    return path ? [{ kind: "FileWrite", path }] : [];
  }

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const segment = classifyTestCommand(command);
    if (segment === null) return [];
    const outcome = extractBashOutcome(toolResponse);
    const report = findReportForSegment(segment, outcome.stdout);
    return [{ kind: "TestRun", command, exit: outcome.exit, report }];
  }

  return [];
}
