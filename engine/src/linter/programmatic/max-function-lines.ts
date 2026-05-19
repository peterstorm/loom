/**
 * Programmatic rule: max-function-lines
 *
 * Enforces a maximum function body length. AI agents frequently generate
 * 200+ line functions that should be decomposed.
 *
 * Uses bracket-depth tracking with string/template literal awareness.
 * Handles:
 * - function declarations
 * - arrow functions with block bodies
 * - method definitions
 * - class methods
 *
 * Excludes test files by default (describe blocks are naturally long).
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";

// --- Configuration ---

/** Maximum allowed lines in a function body */
export const DEFAULT_MAX_LINES = 50;

/** File patterns to exclude (test files have long describe blocks) */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  ".test.ts",
  ".spec.ts",
  ".test.tsx",
  ".spec.tsx",
  ".property.test.ts",
];

// --- Function detection ---

interface FunctionSpan {
  readonly name: string;
  readonly startLine: number;  // 1-indexed, line of function declaration
  readonly endLine: number;    // 1-indexed, line of closing brace
  readonly bodyLines: number;  // endLine - startLine - 1 (excluding braces)
}

/** Control-flow keywords that look like method calls but aren't functions */
const CONTROL_FLOW_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);

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
 * Detects function declarations and their line spans using bracket-depth tracking.
 * Returns all functions with their body line counts.
 */
export function detectFunctions(content: string): readonly FunctionSpan[] {
  const lines = content.split("\n");
  const functions: FunctionSpan[] = [];

  let currentFunction: { name: string; startLine: number; braceDepth: number } | null = null;
  let inBlockComment = false;

  // Patterns that indicate a function start
  const functionDeclRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const arrowFnRe = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*(?::\s*[^=]+)?\s*=>\s*\{/;
  const methodRe = /^\s*(?:async\s+)?(?:private\s+|protected\s+|public\s+|static\s+|readonly\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track block comments
    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("/*")) {
      inBlockComment = true;
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }

    // Skip single-line comments
    if (trimmed.startsWith("//")) continue;

    // Count braces (string-aware)
    const { open: lineOpenBraces, close: lineCloseBraces } = countBraces(line);

    // If we're tracking a function, update its brace depth
    if (currentFunction) {
      currentFunction.braceDepth += lineOpenBraces - lineCloseBraces;

      if (currentFunction.braceDepth <= 0) {
        // Function closed
        const endLine = i + 1;
        const bodyLines = endLine - currentFunction.startLine - 1;
        functions.push({
          name: currentFunction.name,
          startLine: currentFunction.startLine,
          endLine,
          bodyLines,
        });
        currentFunction = null;
      }
      continue;
    }

    // Try to detect a new function start
    let funcName: string | null = null;

    const declMatch = functionDeclRe.exec(line);
    if (declMatch) {
      funcName = declMatch[1];
    } else {
      const arrowMatch = arrowFnRe.exec(line);
      if (arrowMatch) {
        funcName = arrowMatch[1];
      } else {
        const methodMatch = methodRe.exec(line);
        if (methodMatch) {
          const name = methodMatch[1];
          // Exclude control-flow keywords that look like method calls
          if (!CONTROL_FLOW_KEYWORDS.has(name)) {
            funcName = name;
          }
        }
      }
    }

    if (funcName && lineOpenBraces > 0) {
      const braceDepth = lineOpenBraces - lineCloseBraces;
      if (braceDepth > 0) {
        currentFunction = {
          name: funcName,
          startLine: i + 1,
          braceDepth,
        };
      }
      // If braces open and close on same line, it's a one-liner — skip
    }
  }

  return functions;
}

// --- Rule handler ---

/**
 * Programmatic rule handler for max-function-lines.
 * Reports violations for functions exceeding the line limit.
 */
export function handler(
  content: string,
  filePath: string,
  maxLines: number = DEFAULT_MAX_LINES,
  excludePatterns: readonly string[] = DEFAULT_EXCLUDE_PATTERNS
): Violation[] {
  // Skip excluded files (tests)
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (excludePatterns.some((pattern) => normalizedPath.endsWith(pattern))) {
    return [];
  }

  const functions = detectFunctions(content);
  const violations: Violation[] = [];

  for (const fn of functions) {
    if (fn.bodyLines > maxLines) {
      const lines = content.split("\n");
      const text = lines[fn.startLine - 1] || "";
      violations.push(
        makeViolation(
          "max-function-lines",
          filePath,
          fn.startLine,
          text,
          `Function "${fn.name}" is ${fn.bodyLines} lines (max: ${maxLines}). Decompose into smaller functions with single responsibilities.`
        )
      );
    }
  }

  return violations;
}
