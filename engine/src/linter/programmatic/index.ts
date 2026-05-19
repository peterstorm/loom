/**
 * Programmatic rule registry — provides built-in programmatic rules
 * for the "full" tier execution.
 *
 * These rules are loaded by the rule loader alongside JSON regex rules
 * but only run in the "full" tier (wave-gate boundaries).
 */

import type { ProgrammaticRule } from "../types";
import { handler as crossBoundaryHandler } from "./no-cross-boundary-imports";
import { handler as ioInPureHandler } from "./no-io-in-pure-modules";
import { handler as maxFunctionLinesHandler } from "./max-function-lines";

/**
 * All built-in programmatic rules.
 * These are always included in the "full" tier.
 */
export const PROGRAMMATIC_RULES: readonly ProgrammaticRule[] = [
  {
    kind: "programmatic",
    name: "no-cross-boundary-imports",
    description: "Enforce bounded context import boundaries — dependency arrows must point inward",
    extensions: [".ts", ".tsx"],
    handler: crossBoundaryHandler,
    fixHint: "Move this import to the correct layer or inject via a port",
    enabled: true,
    source: "default",
  },
  {
    kind: "programmatic",
    name: "no-io-in-pure-modules",
    description: "Disallow I/O operations in functional core modules",
    extensions: [".ts", ".tsx"],
    handler: ioInPureHandler,
    fixHint: "Extract I/O to the imperative shell or inject via a dependency parameter",
    enabled: true,
    source: "default",
  },
  {
    kind: "programmatic",
    name: "max-function-lines",
    description: "Enforce maximum function body length (default: 50 lines)",
    extensions: [".ts", ".tsx"],
    handler: maxFunctionLinesHandler,
    fixHint: "Decompose into smaller functions with single responsibilities",
    enabled: true,
    source: "default",
  },
];
