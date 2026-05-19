/**
 * Rule loader — reads JSON rule files from default and project directories,
 * handles merge semantics (project overrides default), tier filtering, and
 * fail-closed safety validation.
 *
 * Zero external dependencies.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type RegexRule, type Rule, type Tier, type RuleSource, isRegexRule } from "./types";
import { analyzeRegex } from "./safety";
import { PROGRAMMATIC_RULES, createProgrammaticRules } from "./programmatic/index";
import { loadProjectConfig } from "./programmatic/config";

// --- Public API ---

export interface LoadOptions {
  readonly includeProgrammatic?: boolean;
}

/**
 * Loads and merges rules from default and project directories.
 *
 * - defaultDir MUST exist (throws if missing — installation error)
 * - projectDir may be null or non-existent (gracefully skipped)
 * - Project rules override defaults by name
 * - Project rules with enabled: false disable that rule entirely
 * - tier "immediate" returns only RegexRule[]
 * - tier "full" returns all Rule[]
 * - Throws on malformed JSON (fail-closed)
 * - Throws on unsafe regex patterns (fail-closed via safety.ts)
 */
export function loadRules(
  defaultDir: string,
  projectDir: string | null,
  tier: "immediate",
  options?: LoadOptions
): readonly RegexRule[];
export function loadRules(
  defaultDir: string,
  projectDir: string | null,
  tier: "full",
  options?: LoadOptions
): readonly Rule[];
export function loadRules(
  defaultDir: string,
  projectDir: string | null,
  tier: Tier,
  options?: LoadOptions
): readonly Rule[];
export function loadRules(
  defaultDir: string,
  projectDir: string | null,
  tier: Tier,
  options?: LoadOptions
): readonly Rule[] {
  // Validate defaultDir exists (installation error if missing)
  if (!existsSync(defaultDir)) {
    throw new Error(
      `Default rules directory not found: ${defaultDir} — this is an installation error`
    );
  }

  // Load default rules
  const defaultRules = loadRulesFromDir(defaultDir, "default");

  // Load project rules (if projectDir provided and exists)
  const projectRules =
    projectDir !== null && existsSync(projectDir)
      ? loadRulesFromDir(projectDir, "project")
      : [];

  // Merge: project rules override defaults by name
  const merged = mergeRules(defaultRules, projectRules);

  // Filter out disabled rules
  const enabled = merged.filter((rule) => rule.enabled);

  // Apply tier filtering
  if (tier === "immediate") {
    return enabled.filter(isRegexRule);
  }

  // Full tier: include programmatic rules (also subject to project overrides)
  if (options?.includeProgrammatic !== false) {
    // Load project-local config for programmatic rules
    const projectConfig = loadProjectConfig(projectDir);
    // Always create with config — createProgrammaticRules handles defaults via ??
    const programmaticRules = createProgrammaticRules(projectConfig);

    const programmaticEnabled = programmaticRules.filter((rule) => {
      // Check if a project rule disabled this programmatic rule by name
      const override = projectRules.find((p) => p.name === rule.name);
      if (override && !override.enabled) return false;
      return rule.enabled;
    });

    return [...enabled, ...programmaticEnabled];
  }

  return enabled;
}

// --- Internal Functions ---

/**
 * Reads all *.json files from a directory and parses them into Rule objects.
 * Throws on malformed JSON or invalid rule structure (fail-closed).
 */
function loadRulesFromDir(dir: string, source: RuleSource): Rule[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const rules: Rule[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, "utf-8");

    // Parse JSON — throws on malformed (fail-closed)
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (e) {
      throw new Error(
        `Malformed JSON in rule file ${filePath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // Validate structure
    const rule = parseRuleJson(json, filePath, source);
    rules.push(rule);
  }

  return rules;
}

/**
 * Parses and validates a JSON object into a Rule.
 * Applies regex safety analysis for regex rules.
 * Throws on invalid structure or unsafe patterns (fail-closed).
 */
function parseRuleJson(json: unknown, filePath: string, source: RuleSource): Rule {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`Rule file ${filePath}: expected a JSON object`);
  }

  const obj = json as Record<string, unknown>;

  // Validate required fields
  validateRequiredString(obj, "kind", filePath);
  validateRequiredString(obj, "name", filePath);
  validateRequiredString(obj, "description", filePath);
  validateRequiredString(obj, "fixHint", filePath);
  validateRequiredArray(obj, "extensions", filePath);

  if (typeof obj.enabled !== "boolean") {
    throw new Error(`Rule file ${filePath}: 'enabled' must be a boolean`);
  }

  const kind = obj.kind as string;
  const name = obj.name as string;
  const description = obj.description as string;
  const extensions = obj.extensions as string[];
  const fixHint = obj.fixHint as string;
  const enabled = obj.enabled as boolean;

  // Validate extensions are all strings
  for (const ext of extensions) {
    if (typeof ext !== "string") {
      throw new Error(`Rule file ${filePath}: all extensions must be strings`);
    }
  }

  if (kind === "regex") {
    return parseRegexRule(obj, filePath, source, {
      name,
      description,
      extensions,
      fixHint,
      enabled,
    });
  }

  if (kind === "programmatic") {
    // Programmatic rules loaded from JSON won't have handlers —
    // they need to be loaded differently. For now, throw as unsupported from JSON.
    throw new Error(
      `Rule file ${filePath}: programmatic rules cannot be defined in JSON`
    );
  }

  throw new Error(`Rule file ${filePath}: unknown rule kind '${kind}'`);
}

/**
 * Parses and validates a regex rule, including ReDoS safety analysis.
 */
function parseRegexRule(
  obj: Record<string, unknown>,
  filePath: string,
  source: RuleSource,
  base: {
    name: string;
    description: string;
    extensions: readonly string[];
    fixHint: string;
    enabled: boolean;
  }
): RegexRule {
  if (typeof obj.pattern !== "string") {
    throw new Error(`Rule file ${filePath}: regex rule must have a 'pattern' string`);
  }

  const pattern = obj.pattern as string;

  // Fail-closed: flags must be a string when present
  if (obj.flags !== undefined && typeof obj.flags !== "string") {
    throw new Error(
      `Rule '${base.name}' in ${filePath}: 'flags' must be a string (e.g. "gi") when provided`
    );
  }
  const flags = typeof obj.flags === "string" ? obj.flags : "";

  // Optional excludePatterns (file path suffixes to skip)
  let excludePatterns: readonly string[] | undefined;
  if (obj.excludePatterns !== undefined) {
    if (!Array.isArray(obj.excludePatterns) || !obj.excludePatterns.every((p: unknown) => typeof p === "string")) {
      throw new Error(`Rule '${base.name}' in ${filePath}: 'excludePatterns' must be an array of strings`);
    }
    excludePatterns = obj.excludePatterns as string[];
  }

  // Safety check — fail-closed on unsafe patterns
  const safety = analyzeRegex(pattern, flags);
  if (!safety.safe) {
    throw new Error(
      `Rule file ${filePath}: unsafe regex pattern for rule '${base.name}': ${safety.reason}`
    );
  }

  return {
    kind: "regex",
    name: base.name,
    description: base.description,
    extensions: base.extensions,
    pattern,
    flags,
    fixHint: base.fixHint,
    enabled: base.enabled,
    source,
    ...(excludePatterns ? { excludePatterns } : {}),
  };
}

/**
 * Merges default and project rules. Project rules with the same name
 * as a default rule replace the default entirely.
 */
function mergeRules(defaults: Rule[], projectRules: Rule[]): Rule[] {
  // Build a map of project rules by name for O(1) lookup
  const projectByName = new Map<string, Rule>();
  for (const rule of projectRules) {
    projectByName.set(rule.name, rule);
  }

  // Replace defaults that have project overrides
  const merged: Rule[] = defaults.map((defaultRule) => {
    const override = projectByName.get(defaultRule.name);
    return override ?? defaultRule;
  });

  // Add project rules that are NEW (not overriding a default)
  for (const rule of projectRules) {
    const isOverride = defaults.some((d) => d.name === rule.name);
    if (!isOverride) {
      merged.push(rule);
    }
  }

  return merged;
}

// --- Validation Helpers ---

function validateRequiredString(
  obj: Record<string, unknown>,
  field: string,
  filePath: string
): void {
  if (typeof obj[field] !== "string" || (obj[field] as string).trim().length === 0) {
    throw new Error(`Rule file ${filePath}: '${field}' must be a non-empty string`);
  }
}

function validateRequiredArray(
  obj: Record<string, unknown>,
  field: string,
  filePath: string
): void {
  if (!Array.isArray(obj[field])) {
    throw new Error(`Rule file ${filePath}: '${field}' must be an array`);
  }
}
