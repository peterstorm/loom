/**
 * Programmatic rule registry — provides built-in programmatic rules. Every
 * rule runs in the "full" tier; the import-boundary rules AND `switch-totality`
 * also run in the "immediate" tier, so a forbidden import or an unproven switch
 * is refused when it is written rather than when the Wave Gate starts.
 *
 * Rules are configured via project-local config (`config.json` inside the
 * project rules directory: `.claude/linter/rules/` or `.pi/linter/rules/`).
 * If no project config exists, rules use their built-in defaults.
 */

import type { ProgrammaticRule } from "../types";
import { handler as crossBoundaryHandler, DEFAULT_BOUNDARIES } from "./no-cross-boundary-imports";
import { handler as ioInPureHandler, DEFAULT_PURE_MODULES } from "./no-io-in-pure-modules";
import { handler as maxFunctionLinesHandler, DEFAULT_MAX_LINES, DEFAULT_EXCLUDE_PATTERNS } from "./max-function-lines";
import { handler as fugueGeneratedIntegrityHandler } from "./fugue-generated-integrity";
import {
  handler as exhaustiveDiscriminantHandler,
  detectedChainKeys,
  DEFAULT_MAX_DISCRIMINANT_BRANCHES,
  DEFAULT_DISCRIMINANT_TAGS,
  RULE_NAME as EXHAUSTIVE_BRANCHING_RULE,
  type DiscriminantBranchingOptions,
} from "./exhaustive-discriminant-branching";
import { handler as nestedTernaryHandler } from "./no-nested-ternary";
import { handler as preferArrayMethodsHandler } from "./prefer-array-methods";
import {
  handler as switchTotalityHandler,
  detectedSwitchKeys,
  DEFAULT_MIN_SWITCH_ARMS,
  EVERYWHERE,
  RULE_NAME as SWITCH_TOTALITY_RULE,
  type SwitchTotalityOptions,
} from "./switch-totality";
import type { BaselineOwner } from "./baseline";
import { type ProgrammaticConfig, EMPTY_CONFIG } from "./config";

/** The files both totality rules read, owned once for the rules and their
 *  baseline owners. */
const TOTALITY_EXTENSIONS: readonly string[] = Object.freeze([".ts", ".tsx"]);

/** switch-totality's options for one project — the ONE mapping from config,
 *  shared by the live rule and its staleness detector so the two can never
 *  measure different things. */
export function switchTotalityOptions(config: ProgrammaticConfig, projectRoot: string | null): SwitchTotalityOptions {
  return Object.freeze({
    scope: config.switchTotalityModules === undefined
      ? EVERYWHERE
      : Object.freeze({ kind: "modules", prefixes: config.switchTotalityModules }),
    baseline: config.switchTotalityBaseline ?? [],
    minArms: DEFAULT_MIN_SWITCH_ARMS,
    projectRoot,
  });
}

/** exhaustive-discriminant-branching's options for one project — shared by
 *  the live rule and its staleness detector, like the switch half above. */
export function discriminantBranchingOptions(
  config: ProgrammaticConfig,
  projectRoot: string | null,
): DiscriminantBranchingOptions {
  return Object.freeze({
    maxBranches: config.maxDiscriminantBranches ?? DEFAULT_MAX_DISCRIMINANT_BRANCHES,
    tags: config.discriminantTags ?? DEFAULT_DISCRIMINANT_TAGS,
    baseline: config.discriminantBranchingBaseline ?? [],
    projectRoot,
  });
}

/**
 * Every rule that keeps a grandfathered list, for one project's config.
 * `scripts/lint-project.ts` reports the stale entries of each and writes them
 * with `--write-baseline`, and Loom's baseline test asserts each against the
 * live tree — all iterate THIS list, so a baselined rule cannot be left out of
 * the drift report. Each owner detects with exactly the options its live rule
 * runs with.
 */
export function baselineOwners(config: ProgrammaticConfig, projectRoot: string | null): readonly BaselineOwner[] {
  const switchOptions = switchTotalityOptions(config, projectRoot);
  const chainOptions = discriminantBranchingOptions(config, projectRoot);
  return Object.freeze([
    {
      rule: SWITCH_TOTALITY_RULE,
      configKey: "switchTotalityBaseline",
      extensions: TOTALITY_EXTENSIONS,
      baseline: switchOptions.baseline,
      site: "unproven switch",
      detect: (content: string, filePath: string) => detectedSwitchKeys(content, filePath, switchOptions),
    },
    {
      rule: EXHAUSTIVE_BRANCHING_RULE,
      configKey: "discriminantBranchingBaseline",
      extensions: TOTALITY_EXTENSIONS,
      baseline: chainOptions.baseline,
      site: "unproven if-chain",
      detect: (content: string, filePath: string) => detectedChainKeys(content, filePath, chainOptions),
    },
  ]);
}

/**
 * The two import-boundary rules. Both run in the "immediate" tier: a forbidden
 * import is refused when it is written.
 */
function importBoundaryRules(
  boundaries: NonNullable<ProgrammaticConfig["boundaries"]>,
  pureModules: NonNullable<ProgrammaticConfig["pureModules"]>,
): readonly ProgrammaticRule[] {
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
  ];
}

function maxFunctionLinesRule(maxLines: number, excludePatterns: readonly string[]): ProgrammaticRule {
  return {
    kind: "programmatic",
    name: "max-function-lines",
    description: `Enforce maximum function body length (configured: ${maxLines} lines)`,
    extensions: [".ts", ".tsx", ".java"],
    handler: (content, filePath) => maxFunctionLinesHandler(content, filePath, maxLines, excludePatterns),
    tier: "full",
    fixHint: "Decompose into smaller functions with single responsibilities",
    enabled: true,
    source: "default",
  };
}

function fugueGeneratedIntegrityRule(): ProgrammaticRule {
  return {
    kind: "programmatic",
    name: "fugue-generated-integrity",
    description: "Verify `fugue new --from` generated files against their @fugue-integrity hash — hand-edits are tamper-evident",
    extensions: [".ts"],
    handler: (content, filePath) => fugueGeneratedIntegrityHandler(content, filePath),
    tier: "full",
    fixHint: "Do not hand-edit generated code — change the AuthoredDag sidecar and run `fugue new --from` to regenerate",
    enabled: true,
    source: "default",
  };
}

/** The two rules that demand a branch over a discriminated union prove it is total. */
function totalityRules(config: ProgrammaticConfig, projectRoot: string | null): readonly ProgrammaticRule[] {
  const switchOptions = switchTotalityOptions(config, projectRoot);
  const chainOptions = discriminantBranchingOptions(config, projectRoot);
  return [
    {
      kind: "programmatic",
      name: SWITCH_TOTALITY_RULE,
      description: "A switch over a discriminated union must prove totality — match(...).exhaustive(), or a default arm binding the scrutinee to `never`",
      extensions: TOTALITY_EXTENSIONS,
      handler: (content, filePath) => switchTotalityHandler(content, filePath, switchOptions),
      // IMMEDIATE: a switch is written once and read for years. Waiting for the
      // wave gate means the unproven arm ships first; the project's baseline
      // keeps every pre-existing site from blocking an unrelated edit to its file.
      tier: "immediate",
      fixHint: "Use match(value).with(...).exhaustive() from ts-pattern — or .otherwise(...) when the domain is open, like a plain string — or give the switch a `default` arm that binds the scrutinee to `never`. `default: throw new Error(\"unreachable\")` is not a proof — it compiles after a new variant is added. Pre-existing sites: `lint-project --write-baseline`.",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: EXHAUSTIVE_BRANCHING_RULE,
      description: `Branching ${chainOptions.maxBranches}+ times on one discriminant is a switch the compiler cannot check`,
      extensions: TOTALITY_EXTENSIONS,
      handler: (content, filePath) => exhaustiveDiscriminantHandler(content, filePath, chainOptions),
      tier: "full",
      fixHint: "Use match(value).with(...).exhaustive() from ts-pattern, or a switch whose default binds the scrutinee to `never` — either makes a new union variant a compile error",
      enabled: true,
      source: "default",
    },
  ];
}

/** The two expression-shape rules: no nested ternaries, no push-only accumulators. */
function expressionShapeRules(): readonly ProgrammaticRule[] {
  return [
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

/**
 * Creates the programmatic rule set, optionally configured by project-local config.
 * Config allows projects to define their own boundaries, pure modules, limits
 * and baselines; `projectRoot` is the root of the project that config belongs
 * to — the frame its paths and baseline keys are written in.
 */
export function createProgrammaticRules(
  config: ProgrammaticConfig = EMPTY_CONFIG,
  projectRoot: string | null = null,
): readonly ProgrammaticRule[] {
  return [
    ...importBoundaryRules(config.boundaries ?? DEFAULT_BOUNDARIES, config.pureModules ?? DEFAULT_PURE_MODULES),
    maxFunctionLinesRule(
      config.maxFunctionLines ?? DEFAULT_MAX_LINES,
      config.excludeFromMaxLines ?? DEFAULT_EXCLUDE_PATTERNS,
    ),
    fugueGeneratedIntegrityRule(),
    ...totalityRules(config, projectRoot),
    ...expressionShapeRules(),
  ];
}
