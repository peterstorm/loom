/**
 * Programmatic rule: no-io-in-pure-modules
 *
 * Detects I/O operations and non-determinism in modules declared as
 * "functional core" (pure). Enforces the FC/IS boundary at the file level.
 *
 * Detection strategy: check imports for I/O modules + scan for banned globals.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";

// --- Configuration ---

/** Modules classified as pure (functional core). Glob-like matching. */
export const DEFAULT_PURE_MODULES: readonly string[] = [
  "engine/src/linter/types.ts",
  "engine/src/linter/formatter.ts",
  "engine/src/core/",
  "engine/src/parsers/",
];

/** Import specifiers that indicate I/O capability */
export const IO_IMPORTS: readonly string[] = [
  // Node.js / TypeScript
  "node:fs",
  "node:net",
  "node:http",
  "node:https",
  "node:child_process",
  "node:dgram",
  "node:dns",
  "node:tls",
  "fs",
  "net",
  "http",
  "https",
  "child_process",
  // Java
  "java.io",
  "java.nio.file",
  "java.net",
  "java.sql",
  "javax.sql",
  "jakarta.servlet",
  "javax.servlet",
  "java.lang.ProcessBuilder",
];

/** Global expressions that indicate side effects or non-determinism */
export const BANNED_GLOBALS: readonly { pattern: RegExp; description: string }[] = [
  { pattern: /\bprocess\.exit\b/, description: "process.exit (control flow side effect)" },
  { pattern: /\bprocess\.env\b/, description: "process.env (environment I/O)" },
  { pattern: /\bfetch\s*\(/, description: "fetch() (network I/O)" },
  { pattern: /\bconsole\.(log|error|warn|info|debug)\b/, description: "console output (I/O)" },
  { pattern: /\bMath\.random\s*\(/, description: "Math.random() (non-determinism)" },
  { pattern: /\bnew\s+Date\s*\((?!\s*["'\d])/, description: "new Date() without argument (non-determinism)" },
  { pattern: /\bperformance\.now\s*\(/, description: "performance.now() (non-determinism)" },
];

/** Import specifiers allowed even in pure modules (side-effect free) */
export const PURE_ALLOW_LIST: readonly string[] = [
  "node:path",
  "node:url",
  "path",
  "url",
  "ts-pattern",
];

// --- Matching ---

/**
 * Checks if a file path matches any of the pure module patterns.
 * Supports exact match and prefix match (trailing /).
 */
export function isPureModule(
  filePath: string,
  pureModules: readonly string[] = DEFAULT_PURE_MODULES
): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return pureModules.some((pattern) => {
    if (pattern.endsWith("/")) {
      return normalized.includes(pattern);
    }
    return normalized.endsWith(pattern) || normalized.includes(pattern);
  });
}

// --- Rule handler ---

/**
 * Programmatic rule handler for no-io-in-pure-modules.
 * Only fires for files matching the pure module list.
 */
export function handler(
  content: string,
  filePath: string,
  pureModules: readonly string[] = DEFAULT_PURE_MODULES
): Violation[] {
  if (!isPureModule(filePath, pureModules)) {
    return []; // Not a pure module — no restrictions
  }

  const violations: Violation[] = [];
  const lines = content.split("\n");
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track block comments
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;

    // Check for I/O imports
    const importMatch = line.match(/(?:from|import|require)\s*\(?["']([^"']+)["']\)?/);
    if (importMatch) {
      const specifier = importMatch[1];
      const isIOImport = IO_IMPORTS.some((io) => specifier === io || specifier.startsWith(io + "/"));
      const isAllowed = PURE_ALLOW_LIST.some((a) => specifier === a || specifier.startsWith(a + "/"));

      if (isIOImport && !isAllowed) {
        violations.push(
          makeViolation(
            "no-io-in-pure-modules",
            filePath,
            i + 1,
            line,
            `Pure module must not import I/O module "${specifier}". Move this logic to the imperative shell or inject via a port.`
          )
        );
      }
    }

    // Check for banned globals
    for (const { pattern, description } of BANNED_GLOBALS) {
      if (pattern.test(line)) {
        violations.push(
          makeViolation(
            "no-io-in-pure-modules",
            filePath,
            i + 1,
            line,
            `Pure module must not use ${description}. Extract to imperative shell or inject as a dependency.`
          )
        );
        break; // One violation per line is enough
      }
    }
  }

  return violations;
}
