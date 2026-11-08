/**
 * Programmatic rule registry — provides built-in programmatic rules. Every
 * rule runs in the "full" tier; the import-boundary rules AND `switch-totality`
 * also run in the "immediate" tier, so a forbidden import or an unproven switch
 * is refused when it is written rather than when the Wave Gate starts.
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
import {
  handler as exhaustiveDiscriminantHandler,
  DEFAULT_MAX_DISCRIMINANT_BRANCHES,
  DEFAULT_DISCRIMINANT_TAGS,
} from "./exhaustive-discriminant-branching";
import { handler as nestedTernaryHandler } from "./no-nested-ternary";
import { handler as preferArrayMethodsHandler } from "./prefer-array-methods";
import {
  handler as switchTotalityHandler,
  DEFAULT_SWITCH_TOTALITY_MODULES,
  RULE_NAME as SWITCH_TOTALITY_RULE,
} from "./switch-totality";
import { SWITCH_TOTALITY_BASELINE } from "./switch-totality-baseline";
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
  const switchModules = config.switchTotalityModules ?? DEFAULT_SWITCH_TOTALITY_MODULES;
  const switchBaseline = config.switchTotalityBaseline ?? SWITCH_TOTALITY_BASELINE;

  return [
    {
      kind: "programmatic",
      name: "no-cross-boundary-imports",
      description: "Enforce bounded context import boundaries — dependency arrows must point inward",
      extensions: [".ts", ".tsx", ".java"],
      handler: (content, filePath) => crossBoundaryHandler(content, filePath, boundaries),
      tier: "immediate",
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
      tier: "immediate",
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
      tier: "full",
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
      tier: "full",
      fixHint: "Do not hand-edit generated code — change the AuthoredDag sidecar and run `fugue new --from` to regenerate",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: SWITCH_TOTALITY_RULE,
      description: "A switch over a discriminated union must prove totality — match(...).exhaustive(), or a default arm binding the scrutinee to `never`",
      extensions: [".ts", ".tsx"],
      handler: (content, filePath) => switchTotalityHandler(content, filePath, switchModules, switchBaseline),
      // IMMEDIATE: a switch is written once and read for years. Waiting for the
      // wave gate means the unproven arm ships first; the baseline keeps every
      // pre-existing site from blocking an unrelated edit to its file.
      tier: "immediate",
      fixHint: "Use match(value).with(...).exhaustive() from ts-pattern, or give the switch a `default` arm that binds the scrutinee to `never`. `default: throw new Error(\"unreachable\")` is not a proof — it compiles after a new variant is added.",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "exhaustive-discriminant-branching",
      description: `Branching ${DEFAULT_MAX_DISCRIMINANT_BRANCHES}+ times on one discriminant is a switch the compiler cannot check`,
      extensions: [".ts", ".tsx"],
      handler: (content, filePath) => exhaustiveDiscriminantHandler(
        content,
        filePath,
        config.maxDiscriminantBranches ?? DEFAULT_MAX_DISCRIMINANT_BRANCHES,
        config.discriminantTags ?? DEFAULT_DISCRIMINANT_TAGS,
      ),
      tier: "full",
      fixHint: "Use match(value).with(...).exhaustive() from ts-pattern, or a switch whose default binds the scrutinee to `never` — either makes a new union variant a compile error",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "no-nested-ternary",
      description: "A ternary whose else-branch opens another ternary — one level is the ceiling",
      extensions: [".ts", ".tsx"],
      handler: (content, filePath) => nestedTernaryHandler(content, filePath),
      tier: "full",
      fixHint: "Use if with early returns, or match(...).exhaustive() when the branches are a discriminated union. Type-level conditionals are exempt.",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "prefer-array-methods",
      description: "A mutable accumulator whose loop only pushes into it is a map/filter written with extra state",
      extensions: [".ts", ".tsx"],
      handler: (content, filePath) => preferArrayMethodsHandler(content, filePath),
      tier: "full",
      fixHint: "Use map/filter/flatMap and delete the mutable binding. Loops with break, continue, return, or await are exempt — the rewrite is not mechanical there.",
      enabled: true,
      source: "default",
    },
  ];
}
