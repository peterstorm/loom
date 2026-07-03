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

function parseConfig(obj: Record<string, unknown>, filePath: string): ProgrammaticConfig {
  // Mutable while assembling; returned as the readonly ProgrammaticConfig
  const config: { -readonly [K in keyof ProgrammaticConfig]?: ProgrammaticConfig[K] } = {};

  if (obj.boundaries !== undefined) {
    if (!Array.isArray(obj.boundaries)) {
      throw new Error(`${filePath}: 'boundaries' must be an array`);
    }
    config.boundaries = obj.boundaries.map((b, i) => parseBoundary(b, filePath, i));
  }

  if (obj.pureModules !== undefined) {
    if (!Array.isArray(obj.pureModules)) {
      throw new Error(`${filePath}: 'pureModules' must be an array`);
    }
    if (!obj.pureModules.every((m: unknown) => typeof m === "string")) {
      throw new Error(`${filePath}: 'pureModules' entries must be strings`);
    }
    config.pureModules = obj.pureModules as string[];
  }

  if (obj.maxFunctionLines !== undefined) {
    if (
      typeof obj.maxFunctionLines !== "number" ||
      !Number.isInteger(obj.maxFunctionLines) ||
      obj.maxFunctionLines < 1
    ) {
      throw new Error(`${filePath}: 'maxFunctionLines' must be a positive integer`);
    }
    config.maxFunctionLines = obj.maxFunctionLines;
  }

  if (obj.excludeFromMaxLines !== undefined) {
    if (!Array.isArray(obj.excludeFromMaxLines)) {
      throw new Error(`${filePath}: 'excludeFromMaxLines' must be an array`);
    }
    if (!obj.excludeFromMaxLines.every((e: unknown) => typeof e === "string")) {
      throw new Error(`${filePath}: 'excludeFromMaxLines' entries must be strings`);
    }
    config.excludeFromMaxLines = obj.excludeFromMaxLines as string[];
  }

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
