/**
 * Standalone Review scope and reviewer roster policy: the exact repository-relative
 * scope, the changed-path and review-metadata boundary parsers, the scope-safety
 * proof, and the deterministic reviewer selection that fixes canonical spawn order.
 * Pure parsing; standalone-review-preparation freezes these facts into authority.
 */
import type { Finding } from "./findings";
import type { LoomAgentName } from "./model-profiles";
import type { NonEmpty } from "./orchestration-contract";
import { compareStrings } from "./ordering";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { parseReviewPath, type ReviewPath } from "./review-packet";

export const STANDALONE_REVIEWER_ROLES = Object.freeze([
  "code-reviewer",
  "silent-failure-hunter",
  "pr-test-analyzer",
  "type-design-analyzer",
  "comment-analyzer",
  "architecture-tech-lead",
  "code-simplifier",
] as const satisfies readonly LoomAgentName[]);
export type StandaloneReviewerRole = (typeof STANDALONE_REVIEWER_ROLES)[number];

const STANDALONE_REVIEW_KINDS = Object.freeze([
  "code", "errors", "tests", "types", "comments", "architecture", "simplify", "all",
] as const);
export type StandaloneReviewKind = (typeof STANDALONE_REVIEW_KINDS)[number];

export type StandaloneReviewMetadata = (
  | Readonly<{ docsOnly: true; sourceOrTestChanged: false; commentsChanged: true }>
  | Readonly<{ docsOnly: false; sourceOrTestChanged: boolean; commentsChanged: boolean }>
) & Readonly<{
  requestedKinds: NonEmpty<StandaloneReviewKind>;
  typesChanged: boolean;
  readonly additions: number;
  readonly fileCount: number;
  readonly newStructure: boolean;
  readonly languages: readonly string[];
}>;

export interface StandaloneChangedPaths {
  /**
   * Tracked files whose worktree content differs from the INDEX, plus untracked
   * non-ignored files. The producer runs `git diff --name-only` without
   * `--cached`, so a path already staged with no further edits appears in
   * `staged` alone, not here.
   */
  readonly unstaged: readonly string[];
  readonly staged: readonly string[];
  readonly committed: readonly string[];
  readonly baseRevision: string | null;
  readonly headRevision: string;
}

export type StandaloneScopeSource = "explicit" | "changed-path-union";
export type StandaloneScopeSafety = Readonly<{
  path: ReviewPath;
  status: "safe" | "absent";
}>;

export function exactKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): string[] {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key)).sort();
  const missing = allowed.filter((key) => !Object.hasOwn(raw, key));
  return [
    ...unknown.map((key) => `${label} contains unknown field '${key}'`),
    ...missing.map((key) => `${label}.${key} is required`),
  ];
}

export function uniqueNonEmpty(values: readonly string[], label: string): readonly string[] {
  const errors: string[] = [];
  if (values.length === 0) errors.push(`${label} must be non-empty`);
  if (values.some((value) => value.trim() === "")) errors.push(`${label} must not contain empty values`);
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  return errors;
}

/** Parse and freeze the exact repository-relative scope before it becomes authority. */
export function parseStandaloneReviewScope(raw: unknown, label = "review scope"): ParseResult<NonEmpty<ReviewPath>> {
  if (!Array.isArray(raw)) return fail([`${label} must be a non-empty string array`]);
  const errors: string[] = [];
  const scope = raw.flatMap((entry, index): ReviewPath[] => {
    const parsed = parseReviewPath(entry, `${label}[${index}]`);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      return [];
    }
    return [parsed.value];
  });
  errors.push(...uniqueNonEmpty(scope, label));
  const [head, ...tail] = scope;
  return errors.length > 0 || head === undefined ? fail(errors) : ok(Object.freeze([head, ...tail]));
}

function parsePathList(raw: unknown, label: string, errors: string[]): readonly ReviewPath[] {
  if (!Array.isArray(raw)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const paths: ReviewPath[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseReviewPath(entry, `${label}[${index}]`);
    if (parsed.ok) paths.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  if (new Set(paths).size !== paths.length) errors.push(`${label} must not contain duplicate paths`);
  return Object.freeze([...paths].sort(compareStrings));
}

/**
 * A git revision at this boundary, exactly as the sibling boundaries SHA it:
 * `parseGitSha` (review-packet.ts) and `reviewedSourceSchema.headRevision`
 * (the standalone pi-goal repository, src/integration/loom-review.ts).
 * Producers emit the full hex from `git rev-parse`/`git merge-base`; accepting
 * any other string let a tampered frozen authority name a branch where only a
 * SHA was meant.
 */
const GIT_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function parseChangedPaths(raw: unknown): ParseResult<StandaloneChangedPaths> {
  if (!isRecord(raw)) return fail(["changed_paths must be an object"]);
  const errors = exactKeys(raw, ["unstaged", "staged", "committed", "base_revision", "head_revision"], "changed_paths");
  const unstaged = parsePathList(raw.unstaged, "changed_paths.unstaged", errors);
  const staged = parsePathList(raw.staged, "changed_paths.staged", errors);
  const committed = parsePathList(raw.committed, "changed_paths.committed", errors);
  const baseRevision = raw.base_revision === null ||
      (typeof raw.base_revision === "string" && raw.base_revision.trim() === raw.base_revision && GIT_REVISION.test(raw.base_revision))
    ? raw.base_revision as string | null
    : null;
  if (raw.base_revision !== null && baseRevision === null) {
    errors.push("changed_paths.base_revision must be null or a 40/64-hex git SHA without surrounding whitespace");
  }
  const headRevision = typeof raw.head_revision === "string" && raw.head_revision.trim() === raw.head_revision && GIT_REVISION.test(raw.head_revision)
    ? raw.head_revision
    : "";
  if (headRevision === "") errors.push("changed_paths.head_revision must be a 40/64-hex git SHA without surrounding whitespace");
  return errors.length > 0
    ? fail(errors)
    : ok(Object.freeze({ unstaged, staged, committed, baseRevision, headRevision }));
}

function parseStringSet(raw: unknown, label: string, errors: string[]): readonly string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${label} must be an array of non-empty strings`);
    return [];
  }
  const values = raw.map((entry) => (entry as string).trim());
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  return Object.freeze(values);
}

function boolField(raw: Readonly<Record<string, unknown>>, key: string, errors: string[]): boolean {
  if (typeof raw[key] !== "boolean") errors.push(`review_metadata.${key} must be boolean`);
  return raw[key] === true;
}

function integerField(raw: Readonly<Record<string, unknown>>, key: "additions" | "file_count", errors: string[]): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`review_metadata.${key} must be a non-negative safe integer`);
    return 0;
  }
  return value;
}

function checkDocsOnlyInvariants(docsOnly: boolean, sourceOrTestChanged: boolean, commentsChanged: boolean, errors: string[]): void {
  // A docs-only scope always changes comments — comment-analyzer is the role
  // selected specifically for docs, so the producer's invariant (`metadata` in
  // handlers/helpers/programs/standalone.ts: commentsChanged = docsOnly || scope
  // has .md/.mdx) must hold at the boundary too. The check's remaining value is
  // rejecting the contradictory record outright: without it, the caller's ok
  // branch silently NORMALIZES docs_only=true to commentsChanged=true, so the
  // contradiction hides behind accepted output instead of failing at the
  // untrusted-JSON boundary (parse-don't-validate honesty).
  if (docsOnly && !commentsChanged) {
    errors.push("review_metadata.comments_changed must be true when docs_only is true (a docs-only scope always changes comments)");
  }
  // The producer's OTHER docs-only invariant, and the more dangerous one to
  // leave unproven. `docs_only` is by definition "no source or test file
  // changed" — `classifyScope` derives it as the docs pattern AND
  // `!sourceOrTestChanged`, precisely so the pair cannot both be true — yet
  // only the comments half was checked here, leaving
  // `docs_only && source_or_test_changed` representable at the boundary.
  // The check's remaining value is rejecting that record outright: without it,
  // the caller's ok branch normalizes it to {docsOnly: true,
  // sourceOrTestChanged: false, commentsChanged: true}, so the contradictory
  // pair never reaches `selectStandaloneReviewers` — the metadata passed to
  // selection claims docs-only (not real source changed), pr-test-analyzer is
  // never admitted, and the silent-failure-hunter drop is the same accepted
  // docs-only behavior `classifyScope` produces for a genuinely docs-only
  // scope. Rejecting the record keeps the contradiction audible instead of
  // silently normalized.
  if (docsOnly && sourceOrTestChanged) {
    errors.push("review_metadata.source_or_test_changed must be false when docs_only is true (a docs-only scope changes no source or test file)");
  }
}

export function parseReviewMetadata(raw: unknown): ParseResult<StandaloneReviewMetadata> {
  if (!isRecord(raw)) return fail(["review_metadata must be an object"]);
  const keys = [
    "requested_kinds", "docs_only", "source_or_test_changed", "types_changed", "comments_changed",
    "additions", "file_count", "new_structure", "languages",
  ] as const;
  const errors = exactKeys(raw, keys, "review_metadata");
  const requested = parseStringSet(raw.requested_kinds, "review_metadata.requested_kinds", errors);
  const requestedKinds = requested.filter((kind): kind is StandaloneReviewKind =>
    (STANDALONE_REVIEW_KINDS as readonly string[]).includes(kind));
  if (requestedKinds.length !== requested.length) errors.push("review_metadata.requested_kinds contains an unknown review kind");
  const languages = parseStringSet(raw.languages, "review_metadata.languages", errors);
  const docsOnly = boolField(raw, "docs_only", errors);
  const sourceOrTestChanged = boolField(raw, "source_or_test_changed", errors);
  const typesChanged = boolField(raw, "types_changed", errors);
  const commentsChanged = boolField(raw, "comments_changed", errors);
  checkDocsOnlyInvariants(docsOnly, sourceOrTestChanged, commentsChanged, errors);
  const additions = integerField(raw, "additions", errors);
  const fileCount = integerField(raw, "file_count", errors);
  const newStructure = boolField(raw, "new_structure", errors);
  const [firstKind, ...otherKinds] = requestedKinds;
  if (firstKind === undefined) errors.push("review_metadata.requested_kinds must be non-empty");
  const nonEmptyKinds = firstKind === undefined
    ? null
    : Object.freeze([firstKind, ...otherKinds]) as NonEmpty<StandaloneReviewKind>;
  return errors.length > 0 || nonEmptyKinds === null
    ? fail(errors)
    : ok(Object.freeze({
        requestedKinds: nonEmptyKinds,
        ...(docsOnly
          ? { docsOnly: true as const, sourceOrTestChanged: false as const, commentsChanged: true as const }
          : { docsOnly: false as const, sourceOrTestChanged, commentsChanged }),
        typesChanged,
        additions,
        fileCount,
        newStructure,
        languages,
      }));
}

/** Deterministic reviewer selection. The result order is canonical spawn order. */
export function selectStandaloneReviewers(metadata: StandaloneReviewMetadata): NonEmpty<StandaloneReviewerRole> {
  const kinds = new Set(metadata.requestedKinds);
  const all = kinds.has("all");
  const selected: StandaloneReviewerRole[] = ["code-reviewer"];
  if (!metadata.docsOnly && (all || kinds.has("code") || kinds.has("errors"))) selected.push("silent-failure-hunter");
  if (metadata.sourceOrTestChanged && (all || kinds.has("code") || kinds.has("tests") || kinds.has("errors"))) {
    selected.push("pr-test-analyzer");
  }
  if (metadata.typesChanged && (all || kinds.has("code") || kinds.has("types"))) selected.push("type-design-analyzer");
  if (metadata.commentsChanged && (all || kinds.has("comments") || metadata.docsOnly)) selected.push("comment-analyzer");
  if (kinds.has("architecture") || all || metadata.additions > 500 || metadata.fileCount > 10 || metadata.newStructure) {
    selected.push("architecture-tech-lead");
  }
  // Explicit `simplify` always selects the simplifier; under `all` it joins the
  // roster only when source or tests actually changed — a docs-only or
  // metadata-only scope has nothing for the distill catalog to act on.
  if (kinds.has("simplify") || (all && metadata.sourceOrTestChanged)) selected.push("code-simplifier");
  return Object.freeze(selected) as NonEmpty<StandaloneReviewerRole>;
}

export function parseScopeSafety(raw: unknown, scope: readonly string[]): ParseResult<NonEmpty<StandaloneScopeSafety>> {
  if (!Array.isArray(raw)) return fail(["scope_safety must be an array"]);
  const errors: string[] = [];
  const entries: StandaloneScopeSafety[] = [];
  raw.forEach((entry, index) => {
    const label = `scope_safety[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    errors.push(...exactKeys(entry, ["path", "status"], label));
    const path = parseReviewPath(entry.path, `${label}.path`);
    if (!path.ok) errors.push(...path.errors);
    if (entry.status !== "safe" && entry.status !== "absent") {
      errors.push(`${label}.status must be 'safe' or 'absent'; symlink or redirected scope is unsafe`);
    }
    if (path.ok && (entry.status === "safe" || entry.status === "absent")) {
      entries.push(Object.freeze({ path: path.value, status: entry.status }));
    }
  });
  const observed = entries.map(({ path }) => path);
  if (new Set(observed).size !== observed.length) errors.push("scope_safety paths must be distinct");
  if (observed.length !== scope.length || observed.some((path, index) => path !== scope[index])) {
    errors.push("scope_safety must cover the exact frozen scope in order");
  }
  const [head, ...tail] = entries;
  return errors.length > 0 || head === undefined ? fail(errors) : ok(Object.freeze([head, ...tail]));
}

export function findingScopeErrors(scope: readonly string[], findings: readonly Pick<Finding, "file">[], label: string): readonly string[] {
  const allowed = new Set(scope);
  return findings.flatMap((finding, index) => {
    if (finding.file === null) return [];
    const parsed = parseReviewPath(finding.file, `${label}[${index}].file`);
    return parsed.ok && allowed.has(parsed.value)
      ? []
      : [`${label}[${index}].file is outside the frozen review scope: ${finding.file}`];
  });
}
