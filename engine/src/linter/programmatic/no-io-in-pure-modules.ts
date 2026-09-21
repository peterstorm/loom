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
 * `engine/src/core/` and `engine/src/parsers/` are NOT listed wholesale: those
 * directories are mixed and include a small number of filesystem/stderr users,
 * so directory-wide classification would incorrectly self-flag them. Pure files
 * are enumerated explicitly. The machine and Defect-Family Accounting closures
 * below are verified by machine-purity.test.ts.
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
  "engine/src/core/structured-test-report.ts",
  "engine/src/core/orchestration-contract/identity.ts",
  "engine/src/core/shell-command.ts",
  "engine/src/core/frozen.ts",
  "engine/src/core/tool-vocabulary.ts",
  "engine/src/core/shell-ansi-c.ts",
  "engine/src/core/shell-normalize.ts",
  "engine/src/core/shell-quoting.ts",
  // Defect-Family Accounting, including source authority, barrel re-exports,
  // and type dependencies. No directory-wide core/ or infrastructure waiver.
  "engine/src/core/defect-family-accounting.ts",
  "engine/src/core/ordering.ts",
  "engine/src/core/completion-suite.ts",
  "engine/src/core/verification-manifest.ts",
  "engine/src/core/standalone-review.ts",
  "engine/src/core/standalone-review-machine.ts",
  "engine/src/core/findings.ts",
  "engine/src/core/findings-shape.ts",
  "engine/src/core/review-packet.ts",
  "engine/src/core/git-sha.ts",
  "engine/src/core/panel-kernel.ts",
  "engine/src/core/panel-program.ts",
  "engine/src/core/panel-contract.ts",
  "engine/src/core/review-panel.ts",
  "engine/src/core/review-output.ts",
  "engine/src/core/reviewer-contract.ts",
  "engine/src/core/reviewer-protocol.ts",
  "engine/src/core/standalone-lineage-contract.ts",
  "engine/src/core/standalone-lineage.ts",
  "engine/src/core/standalone-disposition-machine.ts",
  "engine/src/core/standalone-successor-reviewer.ts",
  "engine/src/core/context-packets.ts",
  "engine/src/core/context-packet-projection.ts",
  "engine/src/core/safe-io-cause.ts",
  "engine/src/core/wave-review-authority.ts",
  "engine/src/core/reviewed-workspace.ts",
  "engine/src/core/model-profiles.ts",
  "engine/src/core/phases.ts",
  "engine/src/core/repository-path.ts",
  "engine/src/core/orchestration-contract/index.ts",
  "engine/src/core/orchestration-contract/errors.ts",
  "engine/src/core/orchestration-contract/bytes.ts",
  "engine/src/core/orchestration-contract/artifacts.ts",
  "engine/src/core/orchestration-contract/roster.ts",
  "engine/src/core/orchestration-contract/publication.ts",
  "engine/src/core/orchestration-contract/completion.ts",
  "engine/src/core/orchestration-contract/diagnostics.ts",
  "engine/src/core/orchestration-contract/actions.ts",
  "engine/src/core/orchestration-contract/effects.ts",
  "engine/src/types.ts",
  "engine/src/utils/no-finding-sentinel.ts",
  "engine/src/core/wave-gate-model.ts",
  "engine/src/core/proof-obligations.ts",
  "engine/src/core/verification-policy.ts",
  "engine/src/core/requirement-coverage.ts",
  "engine/src/core/parse-spec.ts",
  "engine/src/core/artifact-baseline.ts",
  "engine/src/core/implementation-retry.ts",
  "engine/src/core/implementation-completion.ts",
  "engine/src/core/task-id.ts",
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
 *  pureModules matches) — shell modules keep using process.stderr etc. */
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
