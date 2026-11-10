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
import { isTestFile, type ReasonedPath } from "./config";

// --- Configuration ---

/**
 * Which files the rule holds to purity: every NON-TEST file under a
 * `pureModules` entry (a directory root with a trailing `/`, or one file),
 * minus the `impureModules` shells — each named with the I/O it does.
 *
 * Pure by default inside the roots, so a new file in the functional core is
 * checked the moment it exists; a shell inside a root has to be declared, with
 * its reason, rather than being exempt by omission from an allowlist.
 */
export type PurityScope = Readonly<{
  pureModules: readonly string[];
  impureModules: readonly ReasonedPath[];
}>;

/**
 * The shipped default checks nothing: which directories form a project's
 * functional core is the project's decision, so its roots and shells live in
 * its own `config.json` (Loom's are in `.claude/linter/rules/config.json`).
 */
export const DEFAULT_PURITY_SCOPE: PurityScope = Object.freeze({ pureModules: Object.freeze([]), impureModules: Object.freeze([]) });

/** Where one file stands under a purity scope. */
export type PurityClassification =
  | Readonly<{ kind: "pure" }>
  | Readonly<{ kind: "shell"; path: string; reason: string }>
  | Readonly<{ kind: "test" }>
  | Readonly<{ kind: "unscoped" }>;

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
  "node:util",
  "crypto",
  "process",
  "util",
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
 *  files the scope classifies pure) — shell modules keep using process.stderr etc. */
export const BANNED_GLOBALS: readonly { pattern: RegExp; description: string }[] = [
  { pattern: /\bprocess\.exit\b/, description: "process.exit (control flow side effect)" },
  { pattern: /\bprocess\.env\b/, description: "process.env (environment I/O)" },
  { pattern: /\bprocess\.(stdout|stderr)\.write\b/, description: "process.stdout/stderr.write (I/O — pure modules return data; shells own the streams)" },
  { pattern: /\bfetch\s*\(/, description: "fetch() (network I/O)" },
  { pattern: /\bconsole\.(log|error|warn|info|debug)\b/, description: "console output (I/O)" },
  { pattern: /\bMath\.random\s*\(/, description: "Math.random() (non-determinism)" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, description: "new Date() without argument (non-determinism)" },
  { pattern: /\bDate\.now\s*\(/, description: "Date.now() (non-determinism — inject the clock)" },
  { pattern: /\bperformance\.now\s*\(/, description: "performance.now() (non-determinism)" },
  { pattern: /\bset(Timeout|Interval)\s*\(/, description: "setTimeout/setInterval (scheduling side effect)" },
  { pattern: /\bcrypto\s*\.\s*(randomUUID|randomBytes|randomFill|randomFillSync|getRandomValues)\b/, description: "crypto entropy (non-determinism — inject the random source)" },
  { pattern: /\bprocess\s*\.\s*(cwd|chdir|hrtime|uptime|platform|arch|argv|pid|kill|nextTick)\b/, description: "process ambient state or effects (inject shell-observed data)" },
];

/** Import specifiers allowed even in pure modules (side-effect free) */
export const PURE_ALLOW_LIST: readonly string[] = [
  "node:path",
  "node:url",
  "path",
  "url",
  "ts-pattern",
  // The security-audit contract parses its run metadata with a schema, and zod
  // is this repo's derive-types-from-source-of-truth tool: a pure parse.
  "zod/v4",
];

/** Capability-level exceptions, never whole crypto/util modules. Hash instances
 * stay local to deterministic byte transforms; randomness and debug I/O do not.
 * Namespace/default/require/dynamic imports cannot prove a narrow capability. */
const PURE_CAPABILITY_IMPORTS: readonly RegExp[] = [
  /\bimport\s+\{\s*createHash(?:\s+as\s+[\w$]+)?\s*,?\s*\}\s+from\s*["'](?:node:)?crypto["']/g,
  /\bimport\s+\{\s*isDeepStrictEqual(?:\s+as\s+[\w$]+)?\s*,?\s*\}\s+from\s*["'](?:node:)?util["']/g,
];

// --- Matching ---

/**
 * Does a file path fall under one scope entry? Matching is prefix/exact —
 * never a bare substring: a directory entry (trailing /) matches paths that
 * START with it or contain it at a path boundary (`/<entry>`); a file entry
 * matches exactly or at a path boundary. The boundary form is what lets an
 * absolute path (the hook and `lintFile` resolve every path) match a
 * project-relative entry, and a Java entry like `domain/model/` cover every
 * package's model. Substring matching would let e.g. "my-engine/src/core/x.ts"
 * or "core/parse-machine.ts.bak" match unintended entries.
 */
export function matchesModulePath(filePath: string, entry: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (entry.endsWith("/")) {
    return normalized.startsWith(entry) || normalized.includes("/" + entry);
  }
  return normalized === entry || normalized.endsWith("/" + entry);
}

/**
 * Classify one file: a test (never held to purity — tests own their I/O), a
 * declared shell (with its reason), pure (under a root), or outside every root.
 * A shell entry wins over a root, so a shell inside the core is named once.
 */
export function classifyPurity(filePath: string, scope: PurityScope): PurityClassification {
  if (isTestFile(filePath)) return { kind: "test" };
  const shell = scope.impureModules.find(({ path }) => matchesModulePath(filePath, path));
  if (shell !== undefined) return { kind: "shell", path: shell.path, reason: shell.reason };
  return scope.pureModules.some((entry) => matchesModulePath(filePath, entry)) ? { kind: "pure" } : { kind: "unscoped" };
}

/** Is this file held to purity under the scope? */
export function isPureModule(filePath: string, scope: PurityScope): boolean {
  return classifyPurity(filePath, scope).kind === "pure";
}

/**
 * The code of one line with its quoted string literals emptied and its
 * trailing `//` comment removed, so a banned global NAMED in a message, a
 * description or a comment is not read as a call. Template literals are kept
 * whole — `${…}` holds code — and a quote with no closing partner on the
 * line is left as code: when in doubt the line is checked, never skipped.
 */
export function codeOfLine(line: string): string {
  let code = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "/" && line[index + 1] === "/") break;
    if (char === "\"" || char === "'") {
      const close = closingQuote(line, index);
      if (close !== -1) {
        code += char + char;
        index = close + 1;
        continue;
      }
    }
    code += char;
    index += 1;
  }
  return code;
}

/** The index of the quote closing the string opened at `open`, or -1. */
function closingQuote(line: string, open: number): number {
  const quote = line[open];
  for (let index = open + 1; index < line.length; index += 1) {
    if (line[index] === "\\") index += 1;
    else if (line[index] === quote) return index;
  }
  return -1;
}

// --- Rule handler ---

/**
 * Programmatic rule handler for no-io-in-pure-modules.
 * Fires only for files the scope classifies pure.
 */
export function handler(
  content: string,
  filePath: string,
  scope: PurityScope = DEFAULT_PURITY_SCOPE
): Violation[] {
  if (!isPureModule(filePath, scope)) {
    return []; // A shell, a test, or outside every pure root — no restrictions
  }

  const violations: Violation[] = [];
  const lines = content.split("\n");
  const imports = [...content.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']\)?/g)];
  const capabilityImports = PURE_CAPABILITY_IMPORTS.flatMap((pattern) =>
    [...content.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length })));
  let inBlockComment = false;
  let nextLineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = nextLineStart;
    nextLineStart += line.length + 1;
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
    for (const importMatch of imports.filter((match) => match.index >= lineStart && match.index < nextLineStart)) {
      const specifier = importMatch[1];
      const isIOImport = IO_IMPORTS.some((io) => specifier === io || specifier.startsWith(io + "/"));
      const offset = importMatch.index;
      const isAllowed = PURE_ALLOW_LIST.some((a) => specifier === a || specifier.startsWith(a + "/")) ||
        capabilityImports.some(({ start, end }) => offset >= start && offset + importMatch[0].length <= end);

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

    // Check for banned globals — in code, not in the strings and comments that name them
    const code = codeOfLine(line);
    for (const { pattern, description } of BANNED_GLOBALS) {
      if (pattern.test(code)) {
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
