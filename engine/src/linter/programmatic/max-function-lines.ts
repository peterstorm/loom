/**
 * Programmatic rule: max-function-lines
 *
 * Enforces a maximum function body length. AI agents frequently generate
 * 200+ line functions that should be decomposed.
 *
 * TypeScript and JavaScript are measured from the compiler's parse
 * (`script-function-spans.ts`): every function declaration and expression,
 * block-bodied arrow, method, constructor and accessor, wherever it stands —
 * nested in another function, in an object literal, as an argument, behind a
 * signature that spans several lines. A nested function is reported in its
 * own right and also counts toward its parent. Java keeps the bracket-depth
 * line scan.
 *
 * A body's length is the lines strictly between its opening and closing
 * brace lines. Pre-existing functions are grandfathered per project in
 * `maxFunctionLinesBaseline`, keyed `path::name` with multiplicity (an
 * unnamed function is `path::<anonymous>`), like the other baselined rules.
 *
 * Excludes test files by default (describe blocks are naturally long).
 */

import { match } from "ts-pattern";
import type { Violation } from "../types";
import { makeViolation } from "../types";
import { matchesAnyExcludePattern, parseExcludePatternListOrThrow, type ExcludePattern } from "../exclude-pattern";
import { baselineCounter, baselineKey, projectRelative, type Baseline, type BaselineKey } from "./baseline";
import { scriptFunctionSpans, type FunctionName, type FunctionSpan } from "./script-function-spans";

export const RULE_NAME = "max-function-lines";

// --- Configuration ---

/** Maximum allowed lines in a function body */
const DEFAULT_MAX_LINES = 50;

/** File patterns to exclude (test files have long describe blocks), through
 *  the same parse a project's entries go through. A refusal here is a defect
 *  in this constant, so it stops the module from loading. */
const DEFAULT_EXCLUDE_PATTERNS: readonly ExcludePattern[] = Object.freeze(
  parseExcludePatternListOrThrow(
    [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".property.test.ts"],
    "excludePatterns",
    "max-function-lines defaults",
  ),
);

/**
 * What one project's max-function-lines rule runs with. `projectRoot` is the
 * frame `excludePatterns` are matched in and `baseline` keys are written in,
 * and null says no project owns the config: a directory pattern then excludes
 * no absolute path (a relative path is still read as project-relative). It has
 * no default, so a caller cannot leave the frame out by forgetting it.
 */
export type MaxFunctionLinesOptions = Readonly<{
  maxLines: number;
  excludePatterns: readonly ExcludePattern[];
  baseline: Baseline;
  projectRoot: string | null;
}>;

/** The rule with no project: the built-in limit and test-file exclusions. */
export const DEFAULT_MAX_FUNCTION_LINES_OPTIONS: MaxFunctionLinesOptions = Object.freeze({
  maxLines: DEFAULT_MAX_LINES,
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  baseline: Object.freeze([]),
  projectRoot: null,
});

// --- Function detection ---

/** Every function in a file with its body length: from the compiler's parse
 *  for TypeScript and JavaScript, by bracket depth for Java. */
export function detectFunctions(content: string, filePath: string): readonly FunctionSpan[] {
  return filePath.endsWith(".java") ? bracketDepthSpans(content) : scriptFunctionSpans(filePath, content);
}

/** Control-flow keywords that look like method calls but aren't functions */
const CONTROL_FLOW_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);

const FUNCTION_DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const ARROW_CONST = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*(?::\s*[^=]+)?\s*=>\s*\{/;
const METHOD = /^\s*(?:async\s+)?(?:private\s+|protected\s+|public\s+|static\s+|readonly\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;

/** The function a line starts, or null: a declaration, an arrow const, then a method that is not a control-flow keyword. */
function startedFunction(line: string): string | null {
  const declared = FUNCTION_DECLARATION.exec(line)?.[1] ?? ARROW_CONST.exec(line)?.[1];
  if (declared !== undefined) return declared;
  const method = METHOD.exec(line)?.[1];
  return method === undefined || CONTROL_FLOW_KEYWORDS.has(method) ? null : method;
}

/**
 * Counts braces on a line, properly skipping string literals, template literals,
 * and inline comments.
 */
function countBraces(line: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;

  for (let j = 0; j < line.length; j++) {
    const ch = line[j];

    // Skip escape sequences inside strings
    if ((inSingleQuote || inDoubleQuote || inTemplate) && ch === "\\") {
      j++; // skip next char
      continue;
    }

    // String tracking
    if (ch === "'" && !inDoubleQuote && !inTemplate) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote && !inTemplate) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (ch === "`" && !inSingleQuote && !inDoubleQuote) {
      inTemplate = !inTemplate;
      continue;
    }

    // Skip content inside strings
    if (inSingleQuote || inDoubleQuote || inTemplate) continue;

    // Rest-of-line comment
    if (ch === "/" && j + 1 < line.length && line[j + 1] === "/") break;

    // Count structural braces
    if (ch === "{") open++;
    if (ch === "}") close++;
  }

  return { open, close };
}

/**
 * The Java measurement: a line that starts a function opens a span, tracked by
 * brace depth until it closes. A function nested in a tracked one is not seen.
 */
function bracketDepthSpans(content: string): readonly FunctionSpan[] {
  const spans: FunctionSpan[] = [];
  let current: { name: string; startLine: number; braceDepth: number } | null = null;
  let inBlockComment = false;

  for (const [index, line] of content.split("\n").entries()) {
    const trimmed = line.trim();
    if (inBlockComment) {
      inBlockComment = !trimmed.includes("*/");
      continue;
    }
    if (trimmed.startsWith("/*")) {
      inBlockComment = !trimmed.includes("*/");
      continue;
    }
    if (trimmed.startsWith("//")) continue;

    const { open, close } = countBraces(line);
    if (current !== null) {
      current.braceDepth += open - close;
      if (current.braceDepth <= 0) {
        const endLine = index + 1;
        spans.push({ name: { kind: "named", name: current.name }, startLine: current.startLine, bodyLines: endLine - current.startLine - 1 });
        current = null;
      }
      continue;
    }

    const name = startedFunction(line);
    // Braces that open and close on the same line are a one-liner: skipped.
    if (name !== null && open > 0 && open - close > 0) current = { name, startLine: index + 1, braceDepth: open - close };
  }

  return spans;
}

// --- Rule handler ---

/** The functions of a file past the limit, or none when the file is excluded. */
function longFunctions(content: string, filePath: string, options: MaxFunctionLinesOptions): readonly FunctionSpan[] {
  // Test-suffix patterns, and directories named with a trailing slash — the
  // same matcher every regex rule's exclusions use.
  if (matchesAnyExcludePattern(filePath, options.excludePatterns, options.projectRoot)) return [];
  return detectFunctions(content, filePath).filter((span) => span.bodyLines > options.maxLines);
}

/** What a baseline entry names: the function, never its line or length, so a grandfathered function may move. */
const keyOf = (name: FunctionName): string =>
  match(name)
    .with({ kind: "named" }, (fn) => fn.name)
    .with({ kind: "anonymous" }, () => "<anonymous>")
    .exhaustive();

const describe = ({ name, startLine }: FunctionSpan): string =>
  match(name)
    .with({ kind: "named" }, (fn) => `Function "${fn.name}"`)
    .with({ kind: "anonymous" }, () => `Anonymous function at line ${startLine}`)
    .exhaustive();

/**
 * Programmatic rule handler for max-function-lines.
 * Reports violations for functions exceeding the line limit that the
 * project's baseline does not excuse.
 */
export function handler(content: string, filePath: string, options: MaxFunctionLinesOptions): Violation[] {
  const relative = projectRelative(filePath, options.projectRoot);
  const baseline = baselineCounter(options.baseline);
  const lines = content.split("\n");
  return longFunctions(content, filePath, options)
    .filter((span) => !baseline.consume(baselineKey(relative, keyOf(span.name))))
    .map((span) =>
      makeViolation(
        RULE_NAME,
        filePath,
        span.startLine,
        lines[span.startLine - 1] ?? "",
        `${describe(span)} is ${span.bodyLines} lines (max: ${options.maxLines}). Decompose into smaller functions with single responsibilities.`,
      ),
    );
}

/** The baseline keys of every function the rule would flag absent its
 *  baseline — the input of the staleness pass and of `lint-project --write-baseline`. */
export function detectedLongFunctionKeys(
  content: string,
  filePath: string,
  options: MaxFunctionLinesOptions,
): readonly BaselineKey[] {
  const relative = projectRelative(filePath, options.projectRoot);
  return longFunctions(content, filePath, options).map((span) => baselineKey(relative, keyOf(span.name)));
}
