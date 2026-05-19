/**
 * Rule executor — filters rules by extension, executes regex/programmatic rules
 * line-by-line with safety timeout wrapping.
 *
 * Functional core: pure aggregation logic.
 * Imperative shell: deadline checking (side-effectful time reads).
 *
 * Zero external dependencies beyond Node path.extname.
 */

import { extname } from "path";
import {
  type Rule,
  type RegexRule,
  type ProgrammaticRule,
  type Violation,
  isRegexRule,
  isProgrammaticRule,
  makeViolation,
} from "./types";
import { analyzeRegex, createDeadlineChecker } from "./safety";

/** How often (in lines) to check the deadline — amortizes overhead */
const DEADLINE_CHECK_INTERVAL = 100;

/** Default timeout budget for a single file (ms) */
const DEFAULT_TIMEOUT_MS = 50;

/**
 * Executes all matching rules against a file's content.
 *
 * 1. Filters rules by file extension match
 * 2. For RegexRules: compile via analyzeRegex, test each line, collect violations
 * 3. For ProgrammaticRules: invoke handler(content, filePath), collect violations
 * 4. All execution wrapped in a shared deadline timeout (fail-closed on exceed)
 *
 * @param rules - Pre-loaded rules (may include disabled or non-matching rules)
 * @param filePath - Absolute file path (used for extension matching + violation context)
 * @param content - Full file content as a string
 * @param timeoutMs - Execution budget in milliseconds (default: 50ms)
 * @returns Aggregated Violation[] (may be empty)
 * @throws Error on timeout or handler exception (fail-closed)
 */
export function executeRules(
  rules: readonly Rule[],
  filePath: string,
  content: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Violation[] {
  const ext = extname(filePath); // e.g. ".ts"
  const checkDeadline = createDeadlineChecker(timeoutMs);

  // Filter: only enabled rules whose extensions include this file's extension
  const matchingRules = rules.filter(
    (rule) => rule.enabled && rule.extensions.includes(ext)
  );

  if (matchingRules.length === 0) {
    return [];
  }

  const violations: Violation[] = [];

  for (const rule of matchingRules) {
    if (isRegexRule(rule)) {
      const ruleViolations = executeRegexRule(rule, filePath, content, checkDeadline);
      violations.push(...ruleViolations);
    } else if (isProgrammaticRule(rule)) {
      const ruleViolations = executeProgrammaticRule(rule, filePath, content, checkDeadline);
      violations.push(...ruleViolations);
    }
  }

  return violations;
}

/**
 * Executes a single regex rule against file content line-by-line.
 * Checks deadline every DEADLINE_CHECK_INTERVAL lines.
 */
function executeRegexRule(
  rule: RegexRule,
  filePath: string,
  content: string,
  checkDeadline: () => void
): Violation[] {
  const safetyResult = analyzeRegex(rule.pattern, rule.flags);

  if (!safetyResult.safe) {
    // Fail-closed: unsafe regex is treated as an error
    throw new Error(
      `Rule "${rule.name}" has unsafe regex: ${safetyResult.reason}`
    );
  }

  const regex = safetyResult.regex;
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Amortized deadline check
    if (i > 0 && i % DEADLINE_CHECK_INTERVAL === 0) {
      checkDeadline();
    }

    const line = lines[i];
    // Reset regex state for global/sticky flags
    regex.lastIndex = 0;

    if (regex.test(line)) {
      violations.push(
        makeViolation(rule.name, filePath, i + 1, line, rule.fixHint)
      );
    }
  }

  return violations;
}

/**
 * Executes a single programmatic rule by invoking its handler.
 * Checks deadline before invocation (fail-closed if already exceeded).
 */
function executeProgrammaticRule(
  rule: ProgrammaticRule,
  filePath: string,
  content: string,
  checkDeadline: () => void
): Violation[] {
  // Check deadline before invoking handler (fail-closed)
  checkDeadline();

  // Handler is responsible for returning well-formed violations
  // If it throws, we let it propagate (fail-closed per spec)
  return rule.handler(content, filePath);
}
