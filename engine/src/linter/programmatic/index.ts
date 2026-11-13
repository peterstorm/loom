/**
 * Programmatic rule registry — provides built-in programmatic rules. Every
 * rule runs in the "full" tier; the import-boundary rules, `switch-totality`,
 * `no-duplicate-block` AND `no-wire-cast` also run in the "immediate" tier, so
 * a forbidden import, an unproven switch, a copied block or a wire value typed
 * without being parsed is refused when it is written rather than when the Wave
 * Gate starts.
 *
 * Rules are configured via project-local config (`config.json` inside the
 * project rules directory: `.claude/linter/rules/` or `.pi/linter/rules/`).
 * If no project config exists, rules use their built-in defaults.
 */

import type { ProgrammaticRule } from "../types";
import { handler as crossBoundaryHandler, DEFAULT_BOUNDARIES, type BoundaryOptions } from "./no-cross-boundary-imports";
import { handler as ioInPureHandler, DEFAULT_PURITY_SCOPE, type PurityScope } from "./no-io-in-pure-modules";
import { handler as maxFunctionLinesHandler, DEFAULT_MAX_LINES, DEFAULT_EXCLUDE_PATTERNS } from "./max-function-lines";
import { handler as fugueGeneratedIntegrityHandler } from "./fugue-generated-integrity";
import {
  handler as exhaustiveDiscriminantHandler,
  detectedChainKeys,
  DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS,
  RULE_NAME as EXHAUSTIVE_BRANCHING_RULE,
  type DiscriminantBranchingOptions,
} from "./exhaustive-discriminant-branching";
import { handler as nestedTernaryHandler } from "./no-nested-ternary";
import { handler as preferArrayMethodsHandler } from "./prefer-array-methods";
import {
  handler as switchTotalityHandler,
  detectedSwitchKeys,
  DEFAULT_SWITCH_TOTALITY_OPTIONS,
  RULE_NAME as SWITCH_TOTALITY_RULE,
  type SwitchTotalityOptions,
} from "./switch-totality";
import {
  handler as duplicateBlockHandler,
  detectedCloneKeys,
  FIX_HINT as DUPLICATE_BLOCK_FIX_HINT,
  RULE_NAME as DUPLICATE_BLOCK_RULE,
  type DuplicateBlockOptions,
} from "./no-duplicate-block";
import {
  handler as wireCastHandler,
  detectedWireCastKeys,
  FIX_HINT as WIRE_CAST_FIX_HINT,
  RULE_NAME as WIRE_CAST_RULE,
  type WireCastOptions,
} from "./no-wire-cast";
import {
  CLONE_EXTENSIONS,
  DEFAULT_CLONE_OPTIONS,
  type AuthoritativeCorpus,
  type CloneCorpus,
  type CloneOptions,
} from "../clones/clone-detection";
import type { BaselineOwner } from "./baseline";
import type { ProgrammaticConfig } from "./config";

/** Every TypeScript module spelling: the totality rules need a type system
 *  (a `never` binding proves nothing in JavaScript). */
const TYPESCRIPT_EXTENSIONS: readonly string[] = Object.freeze([".ts", ".tsx", ".mts", ".cts"]);

/** TypeScript and JavaScript in every module spelling: the rules that read
 *  syntax both languages share — imports, I/O globals, function bodies,
 *  ternaries, loops. */
const SCRIPT_EXTENSIONS: readonly string[] = Object.freeze([...TYPESCRIPT_EXTENSIONS, ".js", ".jsx", ".mjs", ".cjs"]);

/** The files both totality rules read, owned once for the rules and their
 *  baseline owners. */
const TOTALITY_EXTENSIONS: readonly string[] = TYPESCRIPT_EXTENSIONS;

/** The files no-wire-cast reads: an assertion and an annotation exist only in
 *  TypeScript. Owned once for the rule and its baseline owner. */
const WIRE_CAST_EXTENSIONS: readonly string[] = TYPESCRIPT_EXTENSIONS;

/** The boundary rule's options for one project. */
export function boundaryOptions(config: ProgrammaticConfig, projectRoot: string | null): BoundaryOptions {
  return Object.freeze({ requireGovernance: config.requireGovernance ?? [], projectRoot });
}

/** The purity rule's scope for one project: its roots and declared shells. */
export function purityScope(config: ProgrammaticConfig): PurityScope {
  return Object.freeze({
    pureModules: config.pureModules ?? DEFAULT_PURITY_SCOPE.pureModules,
    impureModules: config.impureModules ?? DEFAULT_PURITY_SCOPE.impureModules,
  });
}

/** switch-totality's options for one project — the ONE mapping from config,
 *  shared by the live rule and its staleness detector so the two can never
 *  measure different things. */
export function switchTotalityOptions(config: ProgrammaticConfig, projectRoot: string | null): SwitchTotalityOptions {
  return Object.freeze({
    ...DEFAULT_SWITCH_TOTALITY_OPTIONS,
    ...(config.switchTotalityModules === undefined
      ? {}
      : { scope: Object.freeze({ kind: "modules", prefixes: config.switchTotalityModules }) }),
    ...(config.switchTotalityBaseline === undefined ? {} : { baseline: config.switchTotalityBaseline }),
    projectRoot,
  });
}

/** exhaustive-discriminant-branching's options for one project — shared by
 *  the live rule and its staleness detector, like the switch half above. */
export function discriminantBranchingOptions(
  config: ProgrammaticConfig,
  projectRoot: string | null,
): DiscriminantBranchingOptions {
  const defaults = DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS;
  return Object.freeze({
    maxBranches: config.maxDiscriminantBranches ?? defaults.maxBranches,
    tags: config.discriminantTags ?? defaults.tags,
    baseline: config.discriminantBranchingBaseline ?? defaults.baseline,
    projectRoot,
  });
}

/** no-wire-cast's options for one project — shared by the live rule and its
 *  staleness detector, like the totality rules' above. */
function wireCastOptions(config: ProgrammaticConfig, projectRoot: string | null): WireCastOptions {
  return Object.freeze({ baseline: config.wireCastBaseline ?? [], projectRoot });
}

/** no-duplicate-block's options for one project. */
function duplicateBlockOptions(config: ProgrammaticConfig, projectRoot: string | null): DuplicateBlockOptions {
  return Object.freeze({
    clone: Object.freeze({
      minTokens: config.duplicateBlockMinTokens ?? DEFAULT_CLONE_OPTIONS.minTokens,
      minLines: config.duplicateBlockMinLines ?? DEFAULT_CLONE_OPTIONS.minLines,
    }),
    baseline: config.duplicateBlockBaseline ?? [],
    projectRoot,
  });
}

/**
 * Everything the rules of one project are built from: its config, its root
 * (the frame the config's paths and baseline keys are written in, or null with
 * no project), no-duplicate-block's options and the clone corpus that rule
 * reads. `createProgrammaticRules` and `baselineOwners` both take this one
 * value, so the live rule and its staleness detector share a corpus and options.
 *
 * `Corpus` records whether the corpus may have read the fingerprint cache;
 * `baselineOwners` accepts only one that did not.
 */
export type ProjectLintContext<Corpus extends CloneCorpus = CloneCorpus> = Readonly<{
  config: ProgrammaticConfig;
  projectRoot: string | null;
  duplicateBlock: DuplicateBlockOptions;
  corpus: Corpus;
}>;

/**
 * The lint context of one project. `corpusFor` is handed the clone thresholds
 * the rule compares with, so a corpus cannot be fingerprinted under other ones.
 * Nothing is read here: a project corpus builds itself on the rule's first call.
 */
export function projectLintContext<Corpus extends CloneCorpus>(
  config: ProgrammaticConfig,
  projectRoot: string | null,
  corpusFor: (clone: CloneOptions) => Corpus,
): ProjectLintContext<Corpus> {
  const duplicateBlock = duplicateBlockOptions(config, projectRoot);
  return Object.freeze({ config, projectRoot, duplicateBlock, corpus: corpusFor(duplicateBlock.clone) });
}

/**
 * Every rule that keeps a grandfathered list, for one project.
 * `scripts/lint-project.ts` reports the stale entries of each and writes them
 * with `--write-baseline`, and Loom's baseline test asserts each against the
 * live tree — all iterate THIS list, so a baselined rule cannot be left out of
 * the drift report. Each owner detects with exactly the options its live rule
 * runs with.
 *
 * The context's corpus must be authoritative: a baseline records and reports
 * what is in the tree, and a cache-assisted corpus can hide a copy.
 */
export function baselineOwners({
  config,
  projectRoot,
  duplicateBlock: cloneOptions,
  corpus,
}: ProjectLintContext<AuthoritativeCorpus>): readonly BaselineOwner[] {
  const switchOptions = switchTotalityOptions(config, projectRoot);
  const chainOptions = discriminantBranchingOptions(config, projectRoot);
  const castOptions = wireCastOptions(config, projectRoot);
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
    {
      rule: DUPLICATE_BLOCK_RULE,
      configKey: "duplicateBlockBaseline",
      extensions: CLONE_EXTENSIONS,
      baseline: cloneOptions.baseline,
      site: "copied block",
      detect: (content: string, filePath: string) => detectedCloneKeys(content, filePath, corpus, cloneOptions),
    },
    {
      rule: WIRE_CAST_RULE,
      configKey: "wireCastBaseline",
      extensions: WIRE_CAST_EXTENSIONS,
      baseline: castOptions.baseline,
      site: "unparsed wire value",
      detect: (content: string, filePath: string) => detectedWireCastKeys(content, filePath, castOptions),
    },
  ]);
}

/**
 * The two import-boundary rules. Both run in the "immediate" tier: a forbidden
 * import is refused when it is written.
 */
function importBoundaryRules(config: ProgrammaticConfig, projectRoot: string | null): readonly ProgrammaticRule[] {
  const boundaries = config.boundaries ?? DEFAULT_BOUNDARIES;
  const options = boundaryOptions(config, projectRoot);
  const scope = purityScope(config);
  return [
    {
      kind: "programmatic",
      name: "no-cross-boundary-imports",
      description: "Enforce bounded context import boundaries — dependency arrows must point inward",
      extensions: [...SCRIPT_EXTENSIONS, ".java"],
      handler: (content, filePath) => crossBoundaryHandler(content, filePath, boundaries, options),
      tier: "immediate",
      fixHint: "Move this import to the correct layer or inject via a port",
      enabled: true,
      source: "default",
    },
    {
      kind: "programmatic",
      name: "no-io-in-pure-modules",
      description: "Disallow I/O operations in functional core modules",
      extensions: [...SCRIPT_EXTENSIONS, ".java"],
      handler: (content, filePath) => ioInPureHandler(content, filePath, scope),
      tier: "immediate",
      fixHint: "Extract I/O to the imperative shell or inject via a dependency parameter",
      enabled: true,
      source: "default",
    },
  ];
}

function maxFunctionLinesRule(config: ProgrammaticConfig, projectRoot: string | null): ProgrammaticRule {
  const maxLines = config.maxFunctionLines ?? DEFAULT_MAX_LINES;
  const excludePatterns = config.excludeFromMaxLines ?? DEFAULT_EXCLUDE_PATTERNS;
  return {
    kind: "programmatic",
    name: "max-function-lines",
    description: `Enforce maximum function body length (configured: ${maxLines} lines)`,
    extensions: [...SCRIPT_EXTENSIONS, ".java"],
    handler: (content, filePath) => maxFunctionLinesHandler(content, filePath, maxLines, excludePatterns, projectRoot),
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
      extensions: SCRIPT_EXTENSIONS,
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
      extensions: SCRIPT_EXTENSIONS,
      handler: (content, filePath) => preferArrayMethodsHandler(content, filePath),
      tier: "full",
      fixHint: "Use map/filter/flatMap and delete the mutable binding. Loops with break, continue, return, or await are exempt — the rewrite is not mechanical there.",
      enabled: true,
      source: "default",
    },
  ];
}

/**
 * The copied-block rule. IMMEDIATE: the author of a copy knows what it is a
 * copy of only while writing it, and the project's baseline keeps every
 * pre-existing copy from blocking an unrelated edit to its file.
 *
 * Its first call in a process builds the corpus, which can outlast the
 * per-file deadline. It declares that (`firstCallSetup`) and the executor,
 * which owns the deadline, runs it after every other rule.
 */
function duplicateBlockRule({ duplicateBlock: options, corpus }: ProjectLintContext): ProgrammaticRule {
  return {
    kind: "programmatic",
    name: DUPLICATE_BLOCK_RULE,
    description: `A block of ${options.clone.minTokens}+ identical tokens over ${options.clone.minLines}+ lines that another project file, or this one, already holds`,
    extensions: CLONE_EXTENSIONS,
    handler: (content, filePath) => duplicateBlockHandler(content, filePath, corpus, options),
    tier: "immediate",
    firstCallSetup: true,
    fixHint: DUPLICATE_BLOCK_FIX_HINT,
    enabled: true,
    source: "default",
  };
}

/**
 * The wire-value rule. IMMEDIATE: a type named for unparsed `JSON.parse` /
 * `.json()` output is believed by every read written after it, so it is
 * refused before those reads exist; the project's baseline keeps every
 * pre-existing site from blocking an unrelated edit to its file.
 */
function wireCastRule(config: ProgrammaticConfig, projectRoot: string | null): ProgrammaticRule {
  const options = wireCastOptions(config, projectRoot);
  return {
    kind: "programmatic",
    name: WIRE_CAST_RULE,
    description: "JSON.parse / .json() output typed by an assertion or an annotation instead of being parsed",
    extensions: WIRE_CAST_EXTENSIONS,
    handler: (content, filePath) => wireCastHandler(content, filePath, options),
    tier: "immediate",
    fixHint: WIRE_CAST_FIX_HINT,
    enabled: true,
    source: "default",
  };
}

/**
 * Creates the programmatic rule set for one project (`EMPTY_CONFIG` in the
 * context for the built-in defaults). Config allows projects to define their
 * own boundaries, pure modules, limits and baselines. With no project the
 * context's root is null and its corpus `EMPTY_CORPUS`, so no-duplicate-block
 * finds only the repeats inside each file.
 *
 * The order of this list is free: the executor decides what runs last.
 */
export function createProgrammaticRules(context: ProjectLintContext): readonly ProgrammaticRule[] {
  const { config, projectRoot } = context;
  return [
    ...importBoundaryRules(config, projectRoot),
    maxFunctionLinesRule(config, projectRoot),
    fugueGeneratedIntegrityRule(),
    ...totalityRules(config, projectRoot),
    ...expressionShapeRules(),
    wireCastRule(config, projectRoot),
    duplicateBlockRule(context),
  ];
}
