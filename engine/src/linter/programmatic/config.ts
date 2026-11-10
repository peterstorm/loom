/**
 * Project-local configuration for the linter: its scope and its programmatic
 * rules.
 *
 * Read from `config.json` INSIDE the project rules directory —
 * `.claude/linter/rules/config.json`, or `.pi/linter/rules/config.json` in a
 * project without it (`projectRulesLayout`), beside the project's rule files — by
 * the loader shell (`loadProjectConfig` in `../loader.ts`). This module is the
 * pure half: the schema, and the one parse from JSON to a config value.
 *
 * The parse is FAIL-CLOSED and STRICT. Every key is known, every value is
 * checked, and an unknown key is refused by name: a typo such as `exlude` or
 * `pureModule` must not silently fall back to the built-in default, because
 * the default for a scoping key is "check nothing" or "check everything".
 */

import { resolve } from "node:path";
import { DEFAULT_TEST_FILE_SUFFIXES, isTestFileBySuffixes } from "../../core/test-file-classification";
import { underPrefix, type BoundaryRule, type CapabilityGrant } from "./no-cross-boundary-imports";

// --- Config types ---

/**
 * A project path carved out of a rule's scope, with the reason it is carved
 * out. The reason is part of the value, not a comment beside it: config.json
 * cannot hold comments, and an exemption nobody can justify is an exemption
 * nobody can retire.
 *
 * `path` is project-relative. A trailing `/` names a directory (every file
 * beneath it, at any depth); otherwise it names exactly one file. Globs are
 * not supported and are refused at parse time — a glob that matched nothing
 * used to be a silent no-op.
 */
export type ReasonedPath = Readonly<{ path: string; reason: string }>;

export interface ProgrammaticConfig {
  /** Paths the project linter never reads (vendored, generated), each with its reason. */
  readonly exclude?: readonly ReasonedPath[];
  /** Import boundary rules (for no-cross-boundary-imports) */
  readonly boundaries?: readonly BoundaryRule[];
  /** Path prefixes inside which EVERY file must be governed by a boundary
   *  rule; an ungoverned file there is a violation, not an allow. Absent
   *  means a file no boundary names may import anything. Never empty. */
  readonly requireGovernance?: readonly [string, ...string[]];
  /** The functional core (for no-io-in-pure-modules): directory roots and
   *  single files. Every non-test file beneath a root is pure unless
   *  `impureModules` names it. Absent means the rule checks nothing. */
  readonly pureModules?: readonly string[];
  /** The imperative shells inside the pure roots, each with the I/O it does. */
  readonly impureModules?: readonly ReasonedPath[];
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

/** Every key `config.json` may carry — the one list the strict parse checks against. */
export const PROGRAMMATIC_CONFIG_KEYS: readonly (keyof ProgrammaticConfig)[] = Object.freeze([
  "exclude",
  "boundaries",
  "requireGovernance",
  "pureModules",
  "impureModules",
  "maxFunctionLines",
  "excludeFromMaxLines",
  "maxDiscriminantBranches",
  "discriminantTags",
  "switchTotalityModules",
  "switchTotalityBaseline",
  "discriminantBranchingBaseline",
]);

/** Default config when no project config exists */
export const EMPTY_CONFIG: ProgrammaticConfig = {};

/** The outcome of parsing one config document. */
export type ConfigParse =
  | Readonly<{ ok: true; value: ProgrammaticConfig }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The project rules directory layouts, relative to the project root, in the
 * order a project's ONE rules directory is looked up. The lookup is the same
 * under every harness: Claude Code and Pi both read `.claude/linter/rules`
 * when a project has it, so a project used from both keeps a single copy.
 * `.pi/linter/rules` is read only in a project without the Claude Code layout.
 * A project carrying both is ambiguous: `scripts/lint-project.ts` refuses it
 * rather than silently ignoring the second.
 */
export const CLAUDE_PROJECT_RULES_DIR = ".claude/linter/rules";
export const PI_PROJECT_RULES_DIR = ".pi/linter/rules";
export const PROJECT_RULES_LAYOUTS: readonly string[] = Object.freeze([CLAUDE_PROJECT_RULES_DIR, PI_PROJECT_RULES_DIR]);

/** The layout a project's rules are read from: the first one present, or null
 *  when the project has none. Pure — the caller owns the presence probe. */
export const projectRulesLayout = (isPresent: (layout: string) => boolean): string | null =>
  PROJECT_RULES_LAYOUTS.find(isPresent) ?? null;

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

// --- Parse ---

/** A malformed config: thrown by the field parsers below, caught once by
 *  `parseProjectConfig`, which is the only exit and returns it as a value. */
class ConfigError extends Error {}

function refuse(message: string): never {
  throw new ConfigError(message);
}

/**
 * Parse one `config.json` document. Pure: the caller (the loader shell) reads
 * the bytes and decides what a refusal means — for the hook and lint-project it
 * fails the run closed.
 */
export function parseProjectConfig(json: unknown, configPath: string): ConfigParse {
  try {
    return { ok: true, value: parseConfigObject(json, configPath) };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, error: error.message };
    throw error;
  }
}

/** A plain JSON object, or a refusal naming what was found instead. */
function plainObject(raw: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(`${where}: expected a JSON object`);
  return raw as Record<string, unknown>;
}

/** Refuse every key outside `known`, naming each — a typo must not read as "use the default". */
function refuseUnknownKeys(obj: Readonly<Record<string, unknown>>, known: readonly string[], where: string): void {
  const unknown = Object.keys(obj).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    refuse(`${where}: unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `'${key}'`).join(", ")} — known keys are ${known.join(", ")}`);
  }
}

/**
 * Every optional list on ProgrammaticConfig asks the same question — an array
 * whose entries are non-empty strings — and every optional bound asks "a
 * positive integer". An empty entry in a path list is a prefix that matches
 * EVERY path — it would silently mark the whole tree pure, or exempt it from
 * the line bound — so the non-empty check is uniform.
 */
function parseOptionalStringArray(raw: unknown, filePath: string, key: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return refuse(`${filePath}: '${key}' must be an array`);
  return raw.map((entry: unknown) =>
    typeof entry === "string" && entry.length > 0 ? entry : refuse(`${filePath}: '${key}' entries must be non-empty strings`));
}

/** An optional list that, when present, must also be non-empty: a scope whose
 *  empty form would silently match nothing. */
function parseOptionalNonEmptyStringArray(raw: unknown, filePath: string, key: string): [string, ...string[]] | undefined {
  const list = parseOptionalStringArray(raw, filePath, key);
  if (list === undefined) return undefined;
  const [first, ...rest] = list;
  if (first === undefined) {
    return refuse(`${filePath}: '${key}' must not be empty — omit it for the default scope, or disable the rule by name`);
  }
  return [first, ...rest];
}

/**
 * A project-relative module path: what every scoping list holds. Refused when
 * it could silently match the wrong set — a glob (no glob support exists, so
 * it matched nothing), an absolute path or a `./` / `../` spelling (paths are
 * compared as written, relative to the project root).
 */
function parseModulePath(raw: unknown, where: string): string {
  if (typeof raw !== "string" || raw.length === 0) return refuse(`${where} must be a non-empty string`);
  if (raw.includes("*")) return refuse(`${where} '${raw}' is a glob — name a directory with a trailing '/' (every file beneath it) or one file`);
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.includes("\\")) {
    return refuse(`${where} '${raw}' must be project-relative, forward-slashed, without a leading '/', './' or '../'`);
  }
  return raw;
}

function parseOptionalModulePaths(raw: unknown, filePath: string, key: string): string[] | undefined {
  const list = parseOptionalStringArray(raw, filePath, key);
  return list?.map((entry, index) => parseModulePath(entry, `${filePath}: ${key}[${index}]`));
}

/** A path list that, when present, must be non-empty (`requireGovernance`). */
function parseOptionalNonEmptyModulePaths(raw: unknown, filePath: string, key: string): [string, ...string[]] | undefined {
  const list = parseOptionalNonEmptyStringArray(raw, filePath, key);
  if (list === undefined) return undefined;
  const [first, ...rest] = list;
  return [
    parseModulePath(first, `${filePath}: ${key}[0]`),
    ...rest.map((entry, index) => parseModulePath(entry, `${filePath}: ${key}[${index + 1}]`)),
  ];
}

/** `[{ path, reason }]` — an exemption list where every entry carries its justification. */
function parseOptionalReasonedPaths(raw: unknown, filePath: string, key: string): ReasonedPath[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return refuse(`${filePath}: '${key}' must be an array of { path, reason }`);
  const parsed = raw.map((entry: unknown, index): ReasonedPath => {
    const where = `${filePath}: ${key}[${index}]`;
    const obj = plainObject(entry, where);
    refuseUnknownKeys(obj, ["path", "reason"], where);
    const path = parseModulePath(obj.path, `${where}.path`);
    if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
      return refuse(`${where}.reason must be a non-empty string — every exemption states why`);
    }
    return Object.freeze({ path, reason: obj.reason });
  });
  const seen = new Set<string>();
  for (const { path } of parsed) {
    if (seen.has(path)) refuse(`${filePath}: '${key}' lists '${path}' twice`);
    seen.add(path);
  }
  return parsed;
}

function parseOptionalPositiveInt(raw: unknown, filePath: string, key: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return refuse(`${filePath}: '${key}' must be a positive integer`);
  }
  return raw;
}

function parseOptionalBoundaries(raw: unknown, filePath: string): BoundaryRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return refuse(`${filePath}: 'boundaries' must be an array`);
  return raw.map((b, i) => parseBoundary(b, filePath, i));
}

function parseConfigObject(json: unknown, filePath: string): ProgrammaticConfig {
  const obj = plainObject(json, `Linter config at ${filePath}`);
  refuseUnknownKeys(obj, PROGRAMMATIC_CONFIG_KEYS, `Linter config at ${filePath}`);
  return Object.freeze({
    exclude: parseOptionalReasonedPaths(obj.exclude, filePath, "exclude"),
    boundaries: parseOptionalBoundaries(obj.boundaries, filePath),
    requireGovernance: parseOptionalNonEmptyModulePaths(obj.requireGovernance, filePath, "requireGovernance"),
    pureModules: parseOptionalModulePaths(obj.pureModules, filePath, "pureModules"),
    impureModules: parseOptionalReasonedPaths(obj.impureModules, filePath, "impureModules"),
    maxFunctionLines: parseOptionalPositiveInt(obj.maxFunctionLines, filePath, "maxFunctionLines"),
    excludeFromMaxLines: parseOptionalStringArray(obj.excludeFromMaxLines, filePath, "excludeFromMaxLines"),
    ...parseTotalityConfig(obj, filePath),
  });
}

type TotalityConfigKey =
  | "maxDiscriminantBranches"
  | "discriminantTags"
  | "switchTotalityModules"
  | "switchTotalityBaseline"
  | "discriminantBranchingBaseline";

/** The two totality rules' knobs: the if-chain threshold and tags,
 *  switch-totality's scope, and the grandfathered keys each rule excuses.
 *  Every field rejects a bad value loudly — a declared-but-unread field is a
 *  silent default, the one failure this loader exists to exclude. */
function parseTotalityConfig(
  obj: Readonly<Record<string, unknown>>,
  filePath: string,
): Pick<ProgrammaticConfig, TotalityConfigKey> {
  return {
    maxDiscriminantBranches: parseOptionalPositiveInt(obj.maxDiscriminantBranches, filePath, "maxDiscriminantBranches"),
    discriminantTags: parseOptionalStringArray(obj.discriminantTags, filePath, "discriminantTags"),
    switchTotalityModules: parseOptionalNonEmptyStringArray(obj.switchTotalityModules, filePath, "switchTotalityModules"),
    switchTotalityBaseline: parseOptionalStringArray(obj.switchTotalityBaseline, filePath, "switchTotalityBaseline"),
    discriminantBranchingBaseline: parseOptionalStringArray(obj.discriminantBranchingBaseline, filePath, "discriminantBranchingBaseline"),
  };
}

const BOUNDARY_KEYS: readonly string[] = Object.freeze(["module", "description", "allow", "deny", "perFileAllow", "perFileExactAllow"]);

function parseStringList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) return refuse(`${where} must be an array`);
  return raw.map((entry: unknown) => typeof entry === "string" ? entry : refuse(`${where} entries must be strings`));
}

/**
 * `{ "<file>": { "allow": [...], "reason": "..." } }` — a per-file capability
 * grant. Each is an exception to its boundary's allowlist, so each carries the
 * reason it was granted, and names exactly one file.
 */
function parseOptionalGrants(raw: unknown, where: string, module: string): Readonly<Record<string, CapabilityGrant>> | undefined {
  if (raw === undefined) return undefined;
  const obj = plainObject(raw, where);
  return Object.freeze(Object.fromEntries(Object.entries(obj).map(([file, grant]) => {
    const at = `${where}["${file}"]`;
    const path = parseModulePath(file, `${where} key`);
    if (path.endsWith("/")) refuse(`${at} must name one file — a grant is per file, never per directory`);
    if (!underPrefix(path, module)) refuse(`${at} names a file outside '${module}' — the grant could never apply`);
    const fields = plainObject(grant, at);
    refuseUnknownKeys(fields, ["allow", "reason"], at);
    const allow = parseStringList(fields.allow, `${at}.allow`);
    if (allow.length === 0) refuse(`${at}.allow must not be empty — delete the grant instead`);
    const reason = fields.reason;
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return refuse(`${at}.reason must be a non-empty string — every capability grant states why`);
    }
    return [path, Object.freeze({ allow: Object.freeze(allow), reason })];
  })));
}

function parseBoundary(raw: unknown, filePath: string, index: number): BoundaryRule {
  const where = `${filePath}: boundaries[${index}]`;
  const b = plainObject(raw, where);
  refuseUnknownKeys(b, BOUNDARY_KEYS, where);
  const module = parseModulePath(b.module, `${where}.module`);
  if (b.description !== undefined && (typeof b.description !== "string" || b.description.length === 0)) {
    refuse(`${where}.description must be a non-empty string when present`);
  }
  return Object.freeze({
    module,
    description: typeof b.description === "string" ? b.description : undefined,
    allow: parseStringList(b.allow, `${where}.allow`),
    deny: parseStringList(b.deny, `${where}.deny`),
    perFileAllow: parseOptionalGrants(b.perFileAllow, `${where}.perFileAllow`, module),
    perFileExactAllow: parseOptionalGrants(b.perFileExactAllow, `${where}.perFileExactAllow`, module),
  });
}
