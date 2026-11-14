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
import { describeExcludePatternListError, parseExcludePatternList, type ExcludePattern } from "../exclude-pattern";
import { isPositiveInt, type PositiveInt } from "../positive-int";
import { parseBaselineKey, type Baseline } from "./baseline";
import { underPrefix, type BoundaryRule, type CapabilityGrant } from "./no-cross-boundary-imports";
import type { DocReferenceScope } from "../doc-references/types";
import type { ReasonedPath } from "../types";

// --- Config types ---

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
  /** Files max-function-lines does not read: file suffixes and directories,
   *  parsed like a regex rule's `excludePatterns`. */
  readonly excludeFromMaxLines?: readonly ExcludePattern[];
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
  readonly switchTotalityBaseline?: Baseline;
  /** Grandfathered `path::discriminant` keys the
   *  exhaustive-discriminant-branching rule excuses, one violation each. */
  readonly discriminantBranchingBaseline?: Baseline;
  /** Identical tokens in a row that make a copy (for no-duplicate-block). A
   *  positive integer by type: the detector receives it as parsed. */
  readonly duplicateBlockMinTokens?: PositiveInt;
  /** Lines a copy must span on both sides (for no-duplicate-block). */
  readonly duplicateBlockMinLines?: PositiveInt;
  /** Grandfathered `path::otherPath@digest` keys the no-duplicate-block rule
   *  excuses, one copy each. */
  readonly duplicateBlockBaseline?: Baseline;
  /** Grandfathered `path::as T` / `path::name: T` keys the no-wire-cast rule
   *  excuses, one site each. */
  readonly wireCastBaseline?: Baseline;
  /** The documents, plans and source comments whose references must resolve
   *  (for no-dangling-doc-reference). Absent means the rule governs nothing. */
  readonly docReferences?: DocReferenceScope;
  /** Grandfathered `path::reference` keys the no-dangling-doc-reference rule
   *  excuses, one occurrence each. */
  readonly docReferenceBaseline?: Baseline;
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
  "duplicateBlockMinTokens",
  "duplicateBlockMinLines",
  "duplicateBlockBaseline",
  "wireCastBaseline",
  "docReferences",
  "docReferenceBaseline",
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

/** A parsed optional list that, when present, must also be non-empty: a scope
 *  whose empty form would silently match nothing. The one "must not be empty"
 *  refusal every non-empty list shares. */
function nonEmptyWhenPresent(list: string[] | undefined, filePath: string, key: string): [string, ...string[]] | undefined {
  if (list === undefined) return undefined;
  const [first, ...rest] = list;
  if (first === undefined) {
    return refuse(`${filePath}: '${key}' must not be empty — omit it for the default scope, or disable the rule by name`);
  }
  return [first, ...rest];
}

function parseOptionalNonEmptyStringArray(raw: unknown, filePath: string, key: string): [string, ...string[]] | undefined {
  return nonEmptyWhenPresent(parseOptionalStringArray(raw, filePath, key), filePath, key);
}

/** `path::key` grandfathered entries: an entry with no path or no key could
 *  never match a site, and would be read back as a wrong path — refused by name. */
function parseOptionalBaseline(raw: unknown, filePath: string, key: string): Baseline | undefined {
  return parseOptionalStringArray(raw, filePath, key)?.map((entry, index) =>
    parseBaselineKey(entry) ?? refuse(`${filePath}: ${key}[${index}] '${entry}' must be 'path::key' — a project-relative path, '::', then what the rule flagged there`));
}

/** A rule's exclusion list: an entry that would not mean what its author wrote is refused by name. */
function parseOptionalExcludePatterns(raw: unknown, filePath: string, key: string): readonly ExcludePattern[] | undefined {
  const entries = parseOptionalStringArray(raw, filePath, key);
  if (entries === undefined) return undefined;
  const parsed = parseExcludePatternList(entries);
  return parsed.ok ? parsed.value : refuse(`${filePath}: ${describeExcludePatternListError(key, parsed.error)}`);
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
  return nonEmptyWhenPresent(parseOptionalModulePaths(raw, filePath, key), filePath, key);
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

function parseOptionalPositiveInt(raw: unknown, filePath: string, key: string): PositiveInt | undefined {
  if (raw === undefined) return undefined;
  return isPositiveInt(raw) ? raw : refuse(`${filePath}: '${key}' must be a positive integer`);
}

function parseOptionalBoundaries(raw: unknown, filePath: string): BoundaryRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return refuse(`${filePath}: 'boundaries' must be an array`);
  return raw.map((b, i) => parseBoundary(b, filePath, i));
}

/**
 * The parsed config holds exactly the keys the document carries: an absent key
 * is absent from the value, never present with `undefined`, so a key iteration
 * or `Object.hasOwn` reads the document's shape and not the parser's.
 */
function presentFields<T extends object>(fields: Partial<T>): Partial<T> {
  // Sound for Partial<T>: dropping a key whose value is undefined leaves a value every optional key admits.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function parseConfigObject(json: unknown, filePath: string): ProgrammaticConfig {
  const obj = plainObject(json, `Linter config at ${filePath}`);
  refuseUnknownKeys(obj, PROGRAMMATIC_CONFIG_KEYS, `Linter config at ${filePath}`);
  const parsed: ProgrammaticConfig = {
    exclude: parseOptionalReasonedPaths(obj.exclude, filePath, "exclude"),
    boundaries: parseOptionalBoundaries(obj.boundaries, filePath),
    requireGovernance: parseOptionalNonEmptyModulePaths(obj.requireGovernance, filePath, "requireGovernance"),
    pureModules: parseOptionalModulePaths(obj.pureModules, filePath, "pureModules"),
    impureModules: parseOptionalReasonedPaths(obj.impureModules, filePath, "impureModules"),
    maxFunctionLines: parseOptionalPositiveInt(obj.maxFunctionLines, filePath, "maxFunctionLines"),
    excludeFromMaxLines: parseOptionalExcludePatterns(obj.excludeFromMaxLines, filePath, "excludeFromMaxLines"),
    ...parseTotalityConfig(obj, filePath),
    ...parseDuplicateBlockConfig(obj, filePath),
    wireCastBaseline: parseOptionalBaseline(obj.wireCastBaseline, filePath, "wireCastBaseline"),
    docReferences: parseOptionalDocReferences(obj.docReferences, filePath),
    docReferenceBaseline: parseOptionalBaseline(obj.docReferenceBaseline, filePath, "docReferenceBaseline"),
  };
  return Object.freeze(presentFields(parsed));
}

const DOC_REFERENCE_KEYS: readonly (keyof DocReferenceScope)[] = Object.freeze(["govern", "plans", "exclude", "sourceRoots"]);

/**
 * no-dangling-doc-reference's scope. `govern` is required and non-empty: a
 * scope that governs nothing is written by omitting `docReferences`, never by
 * an empty list that reads as configured. A source root is a directory, so a
 * trailing `/` is optional and dropped.
 */
function parseOptionalDocReferences(raw: unknown, filePath: string): DocReferenceScope | undefined {
  if (raw === undefined) return undefined;
  const where = `${filePath}: docReferences`;
  const obj = plainObject(raw, where);
  refuseUnknownKeys(obj, DOC_REFERENCE_KEYS, where);
  const [first, ...rest] = parseOptionalReasonedPaths(obj.govern, filePath, "docReferences.govern") ?? [];
  if (first === undefined) {
    return refuse(`${where}.govern must be a non-empty array of { path, reason } — omit docReferences to govern nothing`);
  }
  const sourceRoots = parseOptionalModulePaths(obj.sourceRoots, filePath, "docReferences.sourceRoots") ?? [];
  return Object.freeze({
    govern: [first, ...rest],
    plans: Object.freeze(parseOptionalReasonedPaths(obj.plans, filePath, "docReferences.plans") ?? []),
    exclude: Object.freeze(parseOptionalReasonedPaths(obj.exclude, filePath, "docReferences.exclude") ?? []),
    sourceRoots: Object.freeze(sourceRoots.map((root) => root.replace(/\/+$/, ""))),
  });
}

type DuplicateBlockConfigKey = "duplicateBlockMinTokens" | "duplicateBlockMinLines" | "duplicateBlockBaseline";

/** no-duplicate-block's knobs: how long a copy is, and the copies already there. */
function parseDuplicateBlockConfig(
  obj: Readonly<Record<string, unknown>>,
  filePath: string,
): Pick<ProgrammaticConfig, DuplicateBlockConfigKey> {
  return {
    duplicateBlockMinTokens: parseOptionalPositiveInt(obj.duplicateBlockMinTokens, filePath, "duplicateBlockMinTokens"),
    duplicateBlockMinLines: parseOptionalPositiveInt(obj.duplicateBlockMinLines, filePath, "duplicateBlockMinLines"),
    duplicateBlockBaseline: parseOptionalBaseline(obj.duplicateBlockBaseline, filePath, "duplicateBlockBaseline"),
  };
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
    switchTotalityBaseline: parseOptionalBaseline(obj.switchTotalityBaseline, filePath, "switchTotalityBaseline"),
    discriminantBranchingBaseline: parseOptionalBaseline(obj.discriminantBranchingBaseline, filePath, "discriminantBranchingBaseline"),
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
    allow: parseStringList(b.allow, `${where}.allow`),
    deny: parseStringList(b.deny, `${where}.deny`),
    ...presentFields<BoundaryRule>({
      description: typeof b.description === "string" ? b.description : undefined,
      perFileAllow: parseOptionalGrants(b.perFileAllow, `${where}.perFileAllow`, module),
      perFileExactAllow: parseOptionalGrants(b.perFileExactAllow, `${where}.perFileExactAllow`, module),
    }),
  });
}
