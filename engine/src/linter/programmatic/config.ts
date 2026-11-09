/**
 * Project-local configuration for programmatic lint rules.
 *
 * Loaded from `config.json` INSIDE the project rules directory —
 * `.claude/linter/rules/config.json` (Claude Code) or
 * `.pi/linter/rules/config.json` (Pi), beside the project's rule files. Allows
 * projects to define their own architectural boundaries, pure modules and
 * grandfathered baselines without modifying the loom source.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TEST_FILE_SUFFIXES, isTestFileBySuffixes } from "../../core/test-file-classification";
import type { BoundaryRule } from "./no-cross-boundary-imports";

// --- Config types ---

export interface ProgrammaticConfig {
  /** Import boundary rules (for no-cross-boundary-imports) */
  readonly boundaries?: readonly BoundaryRule[];
  /** Glob patterns for pure modules (for no-io-in-pure-modules) */
  readonly pureModules?: readonly string[];
  /** Max function body lines (for max-function-lines) */
  readonly maxFunctionLines?: number;
  /** File patterns to exclude from max-function-lines */
  readonly excludeFromMaxLines?: readonly string[];
  /** Branches on one discriminant that read as a switch (for exhaustive-discriminant-branching) */
  readonly maxDiscriminantBranches?: number;
  /** Field names that tag a discriminated union (for exhaustive-discriminant-branching) */
  readonly discriminantTags?: readonly string[];
  /** Narrows switch-totality to files whose project-relative path CONTAINS one
   *  of these fragments (containment, not an anchored prefix). Absent means
   *  every non-test TypeScript file; never empty — disable the rule by name
   *  instead of giving it a scope that matches nothing. */
  readonly switchTotalityModules?: readonly [string, ...string[]];
  /** Grandfathered `path::scrutinee` keys the switch-totality rule excuses,
   *  each entry consuming one violation. Empty means "no debt". */
  readonly switchTotalityBaseline?: readonly string[];
  /** Grandfathered `path::discriminant` keys the
   *  exhaustive-discriminant-branching rule excuses, one violation each. */
  readonly discriminantBranchingBaseline?: readonly string[];
}

/** Default config when no project config exists */
export const EMPTY_CONFIG: ProgrammaticConfig = {};

/**
 * The project rules directory layouts, relative to the project root: Claude
 * Code reads `.claude/linter/rules`, Pi reads `.pi/linter/rules`. Owned here;
 * `PROJECT_RULES_DIR` in `engine/src/config.ts` picks one per harness.
 */
export const CLAUDE_PROJECT_RULES_DIR = ".claude/linter/rules";
export const PI_PROJECT_RULES_DIR = ".pi/linter/rules";
export const PROJECT_RULES_LAYOUTS: readonly string[] = Object.freeze([CLAUDE_PROJECT_RULES_DIR, PI_PROJECT_RULES_DIR]);

/**
 * The root of the project a rules directory belongs to — the frame its
 * `config.json` writes baseline keys and module scopes in. Null for a directory
 * in neither layout: with no known root a key cannot be made relative, so it
 * stays absolute and matches nothing, which reports a site rather than excusing
 * one.
 */
export function projectRootOf(rulesDir: string | null): string | null {
  if (rulesDir === null) return null;
  const absolute = resolve(rulesDir).replace(/\\/g, "/");
  const layout = PROJECT_RULES_LAYOUTS.find((suffix) => absolute.endsWith(`/${suffix}`));
  return layout === undefined ? null : absolute.slice(0, absolute.length - layout.length - 1);
}

/**
 * Is this a test file, and therefore out of scope for the style rules?
 *
 * One definition for the whole programmatic tier. Three rules had each declared
 * their own copy of the suffix list and the same `endsWith` guard over it, so
 * "what counts as a test file" was answered three times — and a fourth rule
 * adding a fifth suffix would have had to find and update all of them. The
 * engine-wide classifier owns the default list and the match (INV-2).
 */
export const isTestFile = (filePath: string): boolean =>
  isTestFileBySuffixes(filePath, DEFAULT_TEST_FILE_SUFFIXES);

/**
 * Loads project-local programmatic config from the linter config directory.
 * Returns EMPTY_CONFIG if file doesn't exist (graceful default).
 * Throws on malformed JSON (fail-closed).
 */
export function loadProjectConfig(configDir: string | null): ProgrammaticConfig {
  if (!configDir) return EMPTY_CONFIG;

  const configPath = join(configDir, "config.json");
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_CONFIG;
    throw new Error(
      `Cannot read linter config at ${configPath}: ${e instanceof Error ? e.message : String(e)}. Check file permissions.`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (e) {
    throw new Error(
      `Malformed linter config at ${configPath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`Linter config at ${configPath}: expected a JSON object`);
  }

  const obj = json as Record<string, unknown>;
  return parseConfig(obj, configPath);
}

/**
 * Every optional list on ProgrammaticConfig asks the same question — an array
 * whose entries are non-empty strings — and every optional bound asks "a
 * positive integer". These two replace five near-identical blocks.
 *
 * The non-empty check is now uniform. `discriminantTags` already had it;
 * `pureModules` and `excludeFromMaxLines` did not, and an empty entry in either
 * is a prefix that matches EVERY path — it would silently mark the whole tree
 * pure, or exempt it from the line bound. Fail-closed parsing is this loader's
 * contract, so the looser two are brought up to the stricter one.
 */
function parseOptionalStringArray(
  raw: unknown,
  filePath: string,
  key: string,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${filePath}: '${key}' must be an array`);
  }
  if (!raw.every((entry: unknown) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`${filePath}: '${key}' entries must be non-empty strings`);
  }
  return raw as string[];
}

/** An optional list that, when present, must also be non-empty: a scope whose
 *  empty form would silently match nothing. */
function parseOptionalNonEmptyStringArray(
  raw: unknown,
  filePath: string,
  key: string,
): [string, ...string[]] | undefined {
  const list = parseOptionalStringArray(raw, filePath, key);
  if (list === undefined) return undefined;
  const [first, ...rest] = list;
  if (first === undefined) {
    throw new Error(`${filePath}: '${key}' must not be empty — omit it for the default scope, or disable the rule by name`);
  }
  return [first, ...rest];
}

function parseOptionalPositiveInt(
  raw: unknown,
  filePath: string,
  key: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`${filePath}: '${key}' must be a positive integer`);
  }
  return raw;
}

function parseOptionalBoundaries(raw: unknown, filePath: string): BoundaryRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${filePath}: 'boundaries' must be an array`);
  }
  return raw.map((b, i) => parseBoundary(b, filePath, i));
}

function parseConfig(obj: Record<string, unknown>, filePath: string): ProgrammaticConfig {
  // Mutable while assembling; returned as the readonly ProgrammaticConfig
  const config: { -readonly [K in keyof ProgrammaticConfig]?: ProgrammaticConfig[K] } = {};

  const boundaries = parseOptionalBoundaries(obj.boundaries, filePath);
  if (boundaries !== undefined) config.boundaries = boundaries;

  const pureModules = parseOptionalStringArray(obj.pureModules, filePath, "pureModules");
  if (pureModules !== undefined) config.pureModules = pureModules;

  const maxFunctionLines = parseOptionalPositiveInt(obj.maxFunctionLines, filePath, "maxFunctionLines");
  if (maxFunctionLines !== undefined) config.maxFunctionLines = maxFunctionLines;

  const excludeFromMaxLines = parseOptionalStringArray(obj.excludeFromMaxLines, filePath, "excludeFromMaxLines");
  if (excludeFromMaxLines !== undefined) config.excludeFromMaxLines = excludeFromMaxLines;

  return { ...config, ...parseTotalityConfig(obj, filePath) } as ProgrammaticConfig;
}

type TotalityConfigKey =
  | "maxDiscriminantBranches"
  | "discriminantTags"
  | "switchTotalityModules"
  | "switchTotalityBaseline"
  | "discriminantBranchingBaseline";

/** The two totality rules' knobs: the if-chain threshold and tags,
 *  switch-totality's scope, and the grandfathered keys each rule excuses. */
function parseTotalityConfig(
  obj: Record<string, unknown>,
  filePath: string,
): Pick<ProgrammaticConfig, TotalityConfigKey> {
  const config: { -readonly [K in TotalityConfigKey]?: ProgrammaticConfig[K] } = {};

  // These two were DECLARED on ProgrammaticConfig and READ by
  // `createProgrammaticRules`, but never parsed here — so a project that set
  // either one got the built-in default with no throw and no log, the one
  // failure mode this loader's "fail-closed" contract is supposed to exclude.
  // Every field rejects a bad value loudly; these now do too.
  const maxDiscriminantBranches = parseOptionalPositiveInt(
    obj.maxDiscriminantBranches,
    filePath,
    "maxDiscriminantBranches",
  );
  if (maxDiscriminantBranches !== undefined) config.maxDiscriminantBranches = maxDiscriminantBranches;

  const discriminantTags = parseOptionalStringArray(obj.discriminantTags, filePath, "discriminantTags");
  if (discriminantTags !== undefined) config.discriminantTags = discriminantTags;

  // switch-totality's scope and the grandfathered keys each rule excuses parse
  // here for the same reason — a declared-but-unread field is a silent default.
  const switchTotalityModules = parseOptionalNonEmptyStringArray(
    obj.switchTotalityModules,
    filePath,
    "switchTotalityModules",
  );
  if (switchTotalityModules !== undefined) config.switchTotalityModules = switchTotalityModules;

  const switchTotalityBaseline = parseOptionalStringArray(
    obj.switchTotalityBaseline,
    filePath,
    "switchTotalityBaseline",
  );
  if (switchTotalityBaseline !== undefined) config.switchTotalityBaseline = switchTotalityBaseline;

  const discriminantBranchingBaseline = parseOptionalStringArray(
    obj.discriminantBranchingBaseline,
    filePath,
    "discriminantBranchingBaseline",
  );
  if (discriminantBranchingBaseline !== undefined) config.discriminantBranchingBaseline = discriminantBranchingBaseline;

  return config;
}

function parseBoundary(raw: unknown, filePath: string, index: number): BoundaryRule {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filePath}: boundaries[${index}] must be an object`);
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.module !== "string" || b.module === "") {
    throw new Error(`${filePath}: boundaries[${index}].module must be a non-empty string`);
  }
  if (!Array.isArray(b.allow)) {
    throw new Error(`${filePath}: boundaries[${index}].allow must be an array`);
  }
  if (!b.allow.every((a: unknown) => typeof a === "string")) {
    throw new Error(`${filePath}: boundaries[${index}].allow entries must be strings`);
  }
  if (!Array.isArray(b.deny)) {
    throw new Error(`${filePath}: boundaries[${index}].deny must be an array`);
  }
  if (!b.deny.every((d: unknown) => typeof d === "string")) {
    throw new Error(`${filePath}: boundaries[${index}].deny entries must be strings`);
  }

  return {
    module: b.module,
    allow: b.allow as string[],
    deny: b.deny as string[],
  };
}
