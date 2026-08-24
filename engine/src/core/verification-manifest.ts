/** Pure parsing and authority construction for the operator verification manifest. */

import { compareStrings } from "./ordering";
import {
  COMPLETION_REPORT_ROOT,
  FULL_TIER_LINT_CHECK_ID_TEXT,
  createAuthorizedWaveCompletionSuite,
  parseAuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionSuite,
  type CompletionCheckId,
  type CompletionTimeoutMs,
  type ReportPolicy,
  type RepositoryRelativePath,
} from "./completion-suite";
import {
  parseArtifactDigest,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import { canonicalJson, sha256Bytes, sha256Hex, type JsonValue } from "./review-packet";

export const VERIFICATION_MANIFEST_SOURCE_PATH = ".loom/verification-manifest.json" as const;
export const VERIFICATION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_MANIFEST_KIND = "loom-verification-manifest" as const;

type ProjectWaveCompletionCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;
type UnknownRecord = Record<string, unknown>;

export type VerificationManifestSource =
  | Readonly<{ kind: "engine-default" }>
  | Readonly<{
      kind: "operator-file";
      path: typeof VERIFICATION_MANIFEST_SOURCE_PATH;
      digest: ArtifactDigest;
    }>;

export type VerificationManifestCheck = Readonly<{
  id: CompletionCheckId;
  scope: "wave";
  executable: string;
  args: readonly string[];
  cwd: RepositoryRelativePath;
  timeoutMs: CompletionTimeoutMs;
  report: ReportPolicy;
}>;

export type VerificationManifest = Readonly<{
  schemaVersion: typeof VERIFICATION_MANIFEST_SCHEMA_VERSION;
  kind: typeof VERIFICATION_MANIFEST_KIND;
  checks: readonly VerificationManifestCheck[];
}>;

export type FrozenVerificationManifest = Readonly<{
  schemaVersion: typeof VERIFICATION_MANIFEST_SCHEMA_VERSION;
  kind: "frozen-verification-manifest";
  source: VerificationManifestSource;
  manifestDigest: ArtifactDigest;
  projectChecks: readonly ProjectWaveCompletionCheck[];
}>;

export type VerificationManifestError = Readonly<{
  kind: "invalid-verification-manifest";
  errors: NonEmpty<string>;
}>;

export type ActiveWaveCompletionAuthority = Readonly<{
  runId: unknown;
  wave: unknown;
  revision: unknown;
  authorityDigest: unknown;
}>;

export type VerificationManifestResult<T> = DomainResult<T, VerificationManifestError>;

type Parsed<T> = VerificationManifestResult<T>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);
const success = <T>(value: T): Parsed<T> => freeze({ ok: true, value });
const failure = <T>(errors: readonly string[]): Parsed<T> => freeze({
  ok: false,
  error: freeze({
    kind: "invalid-verification-manifest",
    errors: freezeArray(errors.length === 0 ? ["verification manifest is invalid"] : errors) as NonEmpty<string>,
  }),
});

function total<T>(parse: () => Parsed<T>): Parsed<T> {
  try {
    return parse();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown parser failure";
    return failure([`verification manifest input could not be inspected: ${message.slice(0, 256)}`]);
  }
}

function isRecord(raw: unknown): raw is UnknownRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const prototype: unknown = Object.getPrototypeOf(raw);
  return prototype === null || prototype === Object.prototype;
}

function exactRecord(raw: unknown, fields: readonly string[], path: string): Parsed<UnknownRecord> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  const expected = new Set(fields);
  const missing = fields
    .filter((field) => !Object.prototype.hasOwnProperty.call(raw, field))
    .map((field) => `${path}.${field} is required`);
  const surplus = Reflect.ownKeys(raw).flatMap((key) =>
    typeof key === "string" && expected.has(key) ? [] : [`${path}.${String(key)} is not allowed`]);
  const errors = [...missing, ...surplus];
  return errors.length === 0 ? success(raw) : failure(errors);
}

function projectCheck(check: VerificationManifestCheck): ProjectWaveCompletionCheck {
  return freeze({
    kind: "project-command",
    checkId: check.id,
    scope: "wave",
    executable: check.executable,
    args: check.args,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    reportPolicy: check.report,
  });
}

function sourceCheck(check: ProjectWaveCompletionCheck): VerificationManifestCheck {
  return freeze({
    id: check.checkId,
    scope: "wave",
    executable: check.executable,
    args: check.args,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    report: check.reportPolicy,
  });
}

function parseCheck(raw: unknown, path: string): Parsed<VerificationManifestCheck> {
  const record = exactRecord(raw, ["id", "scope", "executable", "args", "cwd", "timeoutMs", "report"], path);
  if (!record.ok) return record;
  const authorized = parseAuthorizedWaveCompletionCheck({
    kind: "project-command",
    checkId: record.value.id,
    scope: record.value.scope,
    executable: record.value.executable,
    args: record.value.args,
    cwd: record.value.cwd,
    timeoutMs: record.value.timeoutMs,
    reportPolicy: record.value.report,
  }, path);
  if (!authorized.ok) return failure(authorized.error.errors);
  if (authorized.value.kind !== "project-command") {
    return failure([`${path} must be a project command`]);
  }
  if (authorized.value.reportPolicy.kind === "required-file" &&
      !authorized.value.reportPolicy.path.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
    return failure([
      `${path}.report.path must be a file beneath protected ${COMPLETION_REPORT_ROOT}/`,
    ]);
  }
  return success(sourceCheck(authorized.value));
}

function parseChecks(raw: unknown, path: string): Parsed<readonly VerificationManifestCheck[]> {
  if (!Array.isArray(raw)) return failure([`${path} must be an array`]);
  const checks: VerificationManifestCheck[] = [];
  const errors: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      errors.push(`${path}[${index}] must be present`);
      continue;
    }
    const parsed = parseCheck(raw[index], `${path}[${index}]`);
    if (parsed.ok) checks.push(parsed.value);
    else errors.push(...parsed.error.errors);
  }
  const counts = new Map<string, number>();
  for (const check of checks) counts.set(check.id, (counts.get(check.id) ?? 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort(compareStrings);
  if (duplicates.length > 0) errors.push(`${path} repeats check ids: ${duplicates.join(", ")}`);
  return errors.length === 0 ? success(freezeArray(checks)) : failure(errors);
}

function parseDocument(raw: unknown): Parsed<VerificationManifest> {
  const record = exactRecord(raw, ["schemaVersion", "kind", "checks"], "verificationManifest");
  if (!record.ok) return record;
  const errors: string[] = [];
  if (record.value.schemaVersion !== VERIFICATION_MANIFEST_SCHEMA_VERSION) {
    errors.push(`verificationManifest.schemaVersion must equal ${VERIFICATION_MANIFEST_SCHEMA_VERSION}`);
  }
  if (record.value.kind !== VERIFICATION_MANIFEST_KIND) {
    errors.push(`verificationManifest.kind must equal ${VERIFICATION_MANIFEST_KIND}`);
  }
  const checks = parseChecks(record.value.checks, "verificationManifest.checks");
  if (!checks.ok) errors.push(...checks.error.errors);
  return errors.length === 0 && checks.ok
    ? success(freeze({
        schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
        kind: VERIFICATION_MANIFEST_KIND,
        checks: checks.value,
      }))
    : failure(errors);
}

/** Parse the exact source JSON value without retaining caller-owned references. */
export function parseVerificationManifest(raw: unknown): Parsed<VerificationManifest> {
  return total(() => parseDocument(raw));
}

function digestJson(value: JsonValue): ArtifactDigest {
  const parsed = parseArtifactDigest(sha256Hex(canonicalJson(value)));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function manifestAuthorityJson(
  source: VerificationManifestSource,
  checks: readonly ProjectWaveCompletionCheck[],
): JsonValue {
  const projectChecks: readonly JsonValue[] = checks.map((check): JsonValue => ({
    kind: check.kind,
    checkId: check.checkId,
    scope: check.scope,
    executable: check.executable,
    args: check.args,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    reportPolicy: check.reportPolicy.kind === "not-required"
      ? { kind: check.reportPolicy.kind }
      : { kind: check.reportPolicy.kind, path: check.reportPolicy.path },
  }));
  return {
    source: source.kind === "engine-default"
      ? { kind: source.kind }
      : { kind: source.kind, path: source.path, digest: source.digest },
    projectChecks,
  };
}

function frozenManifest(
  source: VerificationManifestSource,
  rawChecks: readonly ProjectWaveCompletionCheck[],
): FrozenVerificationManifest {
  const projectChecks = freezeArray([...rawChecks].sort((left, right) => compareStrings(left.checkId, right.checkId)));
  return freeze({
    schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
    kind: "frozen-verification-manifest",
    source,
    manifestDigest: digestJson(manifestAuthorityJson(source, projectChecks)),
    projectChecks,
  });
}

const ENGINE_DEFAULT_SOURCE = freeze({ kind: "engine-default" as const });
const ENGINE_DEFAULT_MANIFEST = frozenManifest(ENGINE_DEFAULT_SOURCE, []);

/** Freeze the absent-source compatibility authority. It can never accept project commands. */
export function defaultVerificationManifest(): FrozenVerificationManifest {
  return ENGINE_DEFAULT_MANIFEST;
}

function rawByteDigest(bytes: Uint8Array): ArtifactDigest {
  const parsed = parseArtifactDigest(sha256Bytes(bytes));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/** Decode, parse, and freeze exact operator-file bytes into protected authority. */
export function freezeVerificationManifest(rawBytes: unknown): Parsed<FrozenVerificationManifest> {
  return total(() => {
    if (!(rawBytes instanceof Uint8Array)) {
      return failure(["verification manifest source must be a Uint8Array"]);
    }
    const bytes = Uint8Array.from(rawBytes);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "invalid UTF-8 or JSON";
      return failure([`verification manifest source must be UTF-8 JSON: ${message.slice(0, 256)}`]);
    }
    const parsed = parseDocument(raw);
    if (!parsed.ok) return parsed;
    const source = freeze({
      kind: "operator-file" as const,
      path: VERIFICATION_MANIFEST_SOURCE_PATH,
      digest: rawByteDigest(bytes),
    });
    return success(frozenManifest(source, parsed.value.checks.map(projectCheck)));
  });
}

function parseSource(raw: unknown): Parsed<VerificationManifestSource> {
  if (!isRecord(raw)) return failure(["frozenVerificationManifest.source must be an object"]);
  if (raw.kind === "engine-default") {
    const record = exactRecord(raw, ["kind"], "frozenVerificationManifest.source");
    return record.ok ? success(ENGINE_DEFAULT_SOURCE) : record;
  }
  if (raw.kind !== "operator-file") {
    return failure(["frozenVerificationManifest.source.kind must be engine-default or operator-file"]);
  }
  const record = exactRecord(raw, ["kind", "path", "digest"], "frozenVerificationManifest.source");
  if (!record.ok) return record;
  const errors: string[] = [];
  if (record.value.path !== VERIFICATION_MANIFEST_SOURCE_PATH) {
    errors.push(`frozenVerificationManifest.source.path must equal ${VERIFICATION_MANIFEST_SOURCE_PATH}`);
  }
  const digest = parseArtifactDigest(record.value.digest);
  if (!digest.ok) errors.push(`frozenVerificationManifest.source.digest: ${digest.error.message}`);
  return errors.length === 0 && digest.ok
    ? success(freeze({ kind: "operator-file", path: VERIFICATION_MANIFEST_SOURCE_PATH, digest: digest.value }))
    : failure(errors);
}

function parseProjectChecks(raw: unknown): Parsed<readonly ProjectWaveCompletionCheck[]> {
  if (!Array.isArray(raw)) return failure(["frozenVerificationManifest.projectChecks must be an array"]);
  const checks: ProjectWaveCompletionCheck[] = [];
  const errors: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      errors.push(`frozenVerificationManifest.projectChecks[${index}] must be present`);
      continue;
    }
    const parsed = parseAuthorizedWaveCompletionCheck(raw[index], `frozenVerificationManifest.projectChecks[${index}]`);
    if (!parsed.ok) errors.push(...parsed.error.errors);
    else if (parsed.value.kind !== "project-command") {
      errors.push(`frozenVerificationManifest.projectChecks[${index}] must be a project command`);
    } else if (parsed.value.reportPolicy.kind === "required-file" &&
        !parsed.value.reportPolicy.path.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
      errors.push(
        `frozenVerificationManifest.projectChecks[${index}].reportPolicy.path must be a file beneath protected ${COMPLETION_REPORT_ROOT}/`,
      );
    } else checks.push(parsed.value);
  }
  const counts = new Map<string, number>();
  for (const check of checks) counts.set(check.checkId, (counts.get(check.checkId) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(compareStrings);
  if (duplicates.length > 0) {
    errors.push(`frozenVerificationManifest.projectChecks repeats check ids: ${duplicates.join(", ")}`);
  }
  return errors.length === 0
    ? success(freezeArray([...checks].sort((left, right) => compareStrings(left.checkId, right.checkId))))
    : failure(errors);
}

/** Rehydrate only exact frozen authority whose canonical digest still matches. */
export function parseFrozenVerificationManifest(raw: unknown): Parsed<FrozenVerificationManifest> {
  return total(() => {
    const record = exactRecord(
      raw,
      ["schemaVersion", "kind", "source", "manifestDigest", "projectChecks"],
      "frozenVerificationManifest",
    );
    if (!record.ok) return record;
    const tagErrors: string[] = [];
    if (record.value.schemaVersion !== VERIFICATION_MANIFEST_SCHEMA_VERSION) {
      tagErrors.push(`frozenVerificationManifest.schemaVersion must equal ${VERIFICATION_MANIFEST_SCHEMA_VERSION}`);
    }
    if (record.value.kind !== "frozen-verification-manifest") {
      tagErrors.push("frozenVerificationManifest.kind must equal frozen-verification-manifest");
    }
    const source = parseSource(record.value.source);
    const checks = parseProjectChecks(record.value.projectChecks);
    const declaredDigest = parseArtifactDigest(record.value.manifestDigest);
    const errors = [...tagErrors, ...[source, checks].flatMap((result) => result.ok ? [] : result.error.errors)];
    if (!declaredDigest.ok) errors.push(`frozenVerificationManifest.manifestDigest: ${declaredDigest.error.message}`);
    if (source.ok && source.value.kind === "engine-default" && checks.ok && checks.value.length > 0) {
      errors.push("frozenVerificationManifest engine-default source cannot authorize project checks");
    }
    if (errors.length > 0 || !source.ok || !checks.ok || !declaredDigest.ok) return failure(errors);
    const canonical = frozenManifest(source.value, checks.value);
    return canonical.manifestDigest === declaredDigest.value
      ? success(canonical)
      : failure(["frozenVerificationManifest.manifestDigest does not match its canonical authority"]);
  });
}

const ENGINE_LINT_CHECK = freeze({
  kind: "engine-full-tier-lint" as const,
  checkId: FULL_TIER_LINT_CHECK_ID_TEXT,
  scope: "wave" as const,
  reportPolicy: freeze({ kind: "not-required" as const }),
});

/** Inject engine-reserved lint and mint exact Wave suite authority. */
export function authorizeWaveCompletionSuite(
  frozenManifestAuthority: FrozenVerificationManifest,
  active: ActiveWaveCompletionAuthority,
  workspaceDigest: unknown,
): Parsed<AuthorizedWaveCompletionSuite> {
  return total(() => {
    const manifest = parseFrozenVerificationManifest(frozenManifestAuthority);
    if (!manifest.ok) return manifest;
    const suite = createAuthorizedWaveCompletionSuite({
      runId: active.runId,
      wave: active.wave,
      revision: active.revision,
      authorityDigest: active.authorityDigest,
      manifestDigest: manifest.value.manifestDigest,
      workspaceDigest,
      checks: [ENGINE_LINT_CHECK, ...manifest.value.projectChecks],
    });
    return suite.ok ? success(suite.value) : failure(suite.error.errors);
  });
}
