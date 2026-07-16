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

/**
 * Modules classified as pure (functional core). Glob-like matching.
 *
 * These are the shipped DEFAULTS: running loom's own linter with them must
 * not flag loom's own code, so only genuinely-pure modules belong here.
 * `engine/src/core/` and `engine/src/parsers/` are NOT listed — despite the
 * "core"/"parser" naming, most of those files are harness-agnostic decision
 * functions that legitimately peek at the filesystem (existsSync) or write
 * to stderr, so they are not pure and would self-flag. The machine pure core
 * below is the only group verified by machine-purity.test.ts.
 */
export const DEFAULT_PURE_MODULES: readonly string[] = [
  "engine/src/linter/types.ts",
  "engine/src/linter/formatter.ts",
  // Guarded-skill-machine pure core: the reducer and everything it may
  // transitively import. The fs shell is ledger.ts / report-discovery.ts /
  // session-registry.ts — deliberately NOT listed here.
  "engine/src/machine/types.ts",
  "engine/src/machine/advance.ts",
  "engine/src/machine/parse-machine.ts",
  "engine/src/machine/extract-evidence.ts",
  "engine/src/machine/mermaid.ts",
  "engine/src/machine/test-report.ts",
  "engine/src/machine/evidence.ts",
];

/** Import specifiers that indicate I/O capability or ambient non-determinism */
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
  "node:crypto",
  "node:os",
  "node:process",
  "node:worker_threads",
  "node:readline",
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

/** Global expressions that indicate side effects or non-determinism.
 *  NOTE: these are banned in PURE modules only (the rule fires solely for
 *  pureModules matches) — shell modules keep using process.stderr etc. */
export const BANNED_GLOBALS: readonly { pattern: RegExp; description: string }[] = [
  { pattern: /\bprocess\.exit\b/, description: "process.exit (control flow side effect)" },
  { pattern: /\bprocess\.env\b/, description: "process.env (environment I/O)" },
  { pattern: /\bprocess\.(stdout|stderr)\.write\b/, description: "process.stdout/stderr.write (I/O — pure modules return data; shells own the streams)" },
  { pattern: /\bfetch\s*\(/, description: "fetch() (network I/O)" },
  { pattern: /\bconsole\.(log|error|warn|info|debug)\b/, description: "console output (I/O)" },
  { pattern: /\bMath\.random\s*\(/, description: "Math.random() (non-determinism)" },
  { pattern: /\bnew\s+Date\s*\((?!\s*["'\d])/, description: "new Date() without argument (non-determinism)" },
  { pattern: /\bDate\.now\s*\(/, description: "Date.now() (non-determinism — inject the clock)" },
  { pattern: /\bperformance\.now\s*\(/, description: "performance.now() (non-determinism)" },
  { pattern: /\bset(Timeout|Interval)\s*\(/, description: "setTimeout/setInterval (scheduling side effect)" },
  { pattern: /\bcrypto\.randomUUID\s*\(/, description: "crypto.randomUUID() (non-determinism — inject the id generator)" },
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
 * Matching is prefix/exact — never a bare substring: a directory pattern
 * (trailing /) matches paths that START with it or contain it at a path
 * boundary (`/<pattern>`); a file pattern matches exactly or at a path
 * boundary. Substring matching would let e.g. "my-engine/src/core/x.ts"
 * or "core/parse-machine.ts.bak" match unintended patterns.
 */
export function isPureModule(
  filePath: string,
  pureModules: readonly string[] = DEFAULT_PURE_MODULES
): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return pureModules.some((pattern) => {
    if (pattern.endsWith("/")) {
      return normalized.startsWith(pattern) || normalized.includes("/" + pattern);
    }
    return normalized === pattern || normalized.endsWith("/" + pattern);
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
