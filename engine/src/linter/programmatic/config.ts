/**
 * Project-local configuration for programmatic lint rules.
 *
 * Loaded from `.claude/linter/config.json` or `.pi/linter/config.json`.
 * Allows projects to define their own architectural boundaries and pure modules
 * without modifying the loom source.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
}

/** Default config when no project config exists */
export const EMPTY_CONFIG: ProgrammaticConfig = {};

/**
 * Loads project-local programmatic config from the linter config directory.
 * Returns EMPTY_CONFIG if file doesn't exist (graceful default).
 * Throws on malformed JSON (fail-closed).
 */
export function loadProjectConfig(configDir: string | null): ProgrammaticConfig {
  if (!configDir) return EMPTY_CONFIG;

  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) return EMPTY_CONFIG;

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (e) {
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

function parseConfig(obj: Record<string, unknown>, filePath: string): ProgrammaticConfig {
  // Mutable while assembling; returned as the readonly ProgrammaticConfig
  const config: { -readonly [K in keyof ProgrammaticConfig]?: ProgrammaticConfig[K] } = {};

  if (obj.boundaries !== undefined) {
    if (!Array.isArray(obj.boundaries)) {
      throw new Error(`${filePath}: 'boundaries' must be an array`);
    }
    config.boundaries = obj.boundaries.map((b, i) => parseBoundary(b, filePath, i));
  }

  const pureModules = parseOptionalStringArray(obj.pureModules, filePath, "pureModules");
  if (pureModules !== undefined) config.pureModules = pureModules;

  const maxFunctionLines = parseOptionalPositiveInt(obj.maxFunctionLines, filePath, "maxFunctionLines");
  if (maxFunctionLines !== undefined) config.maxFunctionLines = maxFunctionLines;

  const excludeFromMaxLines = parseOptionalStringArray(obj.excludeFromMaxLines, filePath, "excludeFromMaxLines");
  if (excludeFromMaxLines !== undefined) config.excludeFromMaxLines = excludeFromMaxLines;

  // These two were DECLARED on ProgrammaticConfig and READ by
  // `createProgrammaticRules`, but never parsed here — so a project that set
  // either one got the built-in default with no throw and no log, the one
  // failure mode this loader's "fail-closed" contract is supposed to exclude.
  // Every field above rejects a bad value loudly; these now do too.
  const maxDiscriminantBranches = parseOptionalPositiveInt(
    obj.maxDiscriminantBranches,
    filePath,
    "maxDiscriminantBranches",
  );
  if (maxDiscriminantBranches !== undefined) config.maxDiscriminantBranches = maxDiscriminantBranches;

  const discriminantTags = parseOptionalStringArray(obj.discriminantTags, filePath, "discriminantTags");
  if (discriminantTags !== undefined) config.discriminantTags = discriminantTags;

  return config as ProgrammaticConfig;
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
