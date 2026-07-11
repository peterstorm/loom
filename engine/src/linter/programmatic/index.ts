/**
 * Programmatic rule registry — provides built-in programmatic rules
 * for the "full" tier execution.
 *
 * Rules are configured via project-local config (loaded from
 * .claude/linter/config.json or .pi/linter/config.json).
 * If no project config exists, rules use their built-in defaults.
 */

import type { ProgrammaticRule } from "../types";
import { handler as crossBoundaryHandler, DEFAULT_BOUNDARIES } from "./no-cross-boundary-imports";
import { handler as ioInPureHandler, DEFAULT_PURE_MODULES } from "./no-io-in-pure-modules";
import { handler as maxFunctionLinesHandler, DEFAULT_MAX_LINES, DEFAULT_EXCLUDE_PATTERNS } from "./max-function-lines";
import { handler as fugueGeneratedIntegrityHandler } from "./fugue-generated-integrity";
import { type ProgrammaticConfig, EMPTY_CONFIG } from "./config";

/**
 * Creates the programmatic rule set, optionally configured by project-local config.
 * Config allows projects to define their own boundaries, pure modules, and limits.
 */
export function createProgrammaticRules(config: ProgrammaticConfig = EMPTY_CONFIG): readonly ProgrammaticRule[] {
  const boundaries = config.boundaries ?? DEFAULT_BOUNDARIES;
  const pureModules = config.pureModules ?? DEFAULT_PURE_MODULES;
  const maxLines = config.maxFunctionLines ?? DEFAULT_MAX_LINES;
  const excludePatterns = config.excludeFromMaxLines ?? DEFAULT_EXCLUDE_PATTERNS;

  return [
    {
      kind: "programmatic",
      name: "no-cross-boundary-imports",
      description: "Enforce bounded context import boundaries — dependency arrows must point inward",
      extensions: [".ts", ".tsx", ".java"],
      handler: (content, filePath) => crossBoundaryHandler(content, filePath, boundaries),
      fixHint: "Move this import to the correct layer or inject via a port",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "no-io-in-pure-modules",
      description: "Disallow I/O operations in functional core modules",
      extensions: [".ts", ".tsx", ".java"],
      handler: (content, filePath) => ioInPureHandler(content, filePath, pureModules),
      fixHint: "Extract I/O to the imperative shell or inject via a dependency parameter",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "max-function-lines",
      description: `Enforce maximum function body length (configured: ${maxLines} lines)`,
      extensions: [".ts", ".tsx", ".java"],
      handler: (content, filePath) => maxFunctionLinesHandler(content, filePath, maxLines, excludePatterns),
      fixHint: "Decompose into smaller functions with single responsibilities",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "fugue-generated-integrity",
      description: "Verify `fugue new --from` generated files against their @fugue-integrity hash — hand-edits are tamper-evident",
      extensions: [".ts"],
      handler: (content, filePath) => fugueGeneratedIntegrityHandler(content, filePath),
      fixHint: "Do not hand-edit generated code — change the AuthoredDag sidecar and run `fugue new --from` to regenerate",
      enabled: true,
      source: "default",
    },
  ];
}

/**
 * Default programmatic rules (no project config).
 * Used when loadRules is called without project config context.
 */
export const PROGRAMMATIC_RULES: readonly ProgrammaticRule[] = createProgrammaticRules();
