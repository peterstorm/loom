/** Pure parsing and authority construction for the operator verification manifest. */

import { match } from "ts-pattern";
import { compareStrings } from "./ordering";
import {
  COMPLETION_REPORT_ROOT,
  FULL_TIER_LINT_CHECK_ID_TEXT,
  createAuthorizedWaveCompletionSuite,
  parseAuthorizedWaveCompletionCheck,
  type AcceptedWaveCompletionReceipt,
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
import { canonicalJson, type JsonValue } from "./review-packet";
import { sha256Bytes, sha256Hex } from "./digest";
import {
  collectDenseArray,
  exactRecordErrors,
  isPlainRecord,
  parseExactRecord,
  toElementResult,
  type ElementResult,
  type UnknownRecord,
} from "./plain-record";

export const VERIFICATION_MANIFEST_SOURCE_PATH = ".loom/verification-manifest.json" as const;
export const VERIFICATION_MANIFEST_SCHEMA_VERSION = 1 as const;
/** Source schema 2 adds the optional `acceptanceRunner`; schema 1 stays valid and means none. */
export const VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION = 2 as const;
export const VERIFICATION_MANIFEST_KIND = "loom-verification-manifest" as const;

type ProjectWaveCompletionCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

type EngineDefaultSource = Readonly<{ kind: "engine-default" }>;
type OperatorFileSource = Readonly<{
  kind: "operator-file";
  path: typeof VERIFICATION_MANIFEST_SOURCE_PATH;
  digest: ArtifactDigest;
}>;

export type VerificationManifestSource = EngineDefaultSource | OperatorFileSource;

export type VerificationManifestCheck = Readonly<{
  id: CompletionCheckId;
  scope: "wave";
  executable: string;
  args: readonly string[];
  cwd: RepositoryRelativePath;
  timeoutMs: CompletionTimeoutMs;
  report: ReportPolicy;
}>;

/** The one whole argument the acceptance runner's file list replaces. */
export const ACCEPTANCE_RUNNER_FILES_PLACEHOLDER = "{files}" as const;
/** The check id the runner's expanded command carries through the completion runner. */
export const ACCEPTANCE_RUNNER_CHECK_ID = "project:acceptance-runner" as const;
/** The Acceptance Stop Check runs inside a SubagentStop hook whose own timeout
 *  is 300 s (hooks.json); a run must finish well inside it. */
export const MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS = 240_000;

/**
 * The operator-declared command that runs only some acceptance files: exactly
 * one whole `{files}` argument the engine replaces with the file paths, one
 * argument each, and a JUnit report beneath the protected report root. It is
 * the only way the Acceptance Stop Check runs anything; absent means the check
 * is off.
 */
export type AcceptanceRunner = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: RepositoryRelativePath;
  timeoutMs: CompletionTimeoutMs;
  report: Extract<ReportPolicy, { kind: "required-file" }>;
}>;

type VerificationManifestBase = Readonly<{
  kind: typeof VERIFICATION_MANIFEST_KIND;
  checks: readonly VerificationManifestCheck[];
}>;

/** Schema 1 cannot declare a runner; schema 2 may, and declares one only when the operator does. */
export type VerificationManifest =
  | VerificationManifestBase & Readonly<{ schemaVersion: typeof VERIFICATION_MANIFEST_SCHEMA_VERSION; acceptanceRunner?: never }>
  | VerificationManifestBase & Readonly<{ schemaVersion: typeof VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION; acceptanceRunner?: AcceptanceRunner }>;

type FrozenVerificationManifestBase = Readonly<{
  schemaVersion: typeof VERIFICATION_MANIFEST_SCHEMA_VERSION;
  kind: "frozen-verification-manifest";
  manifestDigest: ArtifactDigest;
}>;

/**
 * The engine-default form authorizes nothing: no project check and no runner.
 * An operator-file form's runner is absent on graphs frozen before the runner
 * existed, and whenever the operator declared none: either way the stop check
 * is off.
 */
export type FrozenVerificationManifest =
  | FrozenVerificationManifestBase & Readonly<{
      source: EngineDefaultSource;
      projectChecks: readonly [];
      acceptanceRunner?: never;
    }>
  | FrozenVerificationManifestBase & Readonly<{
      source: OperatorFileSource;
      projectChecks: readonly ProjectWaveCompletionCheck[];
      acceptanceRunner?: AcceptanceRunner;
    }>;

export type ProjectVerificationCoverage =
  | Readonly<{
      kind: "not-configured";
      reason: "engine-default" | "empty-operator-manifest" | "historical-unknown";
    }>
  | Readonly<{ kind: "configured"; checkIds: NonEmpty<CompletionCheckId> }>;

/** Coverage is configuration, not acceptance. History retains the roster but not source provenance. */
export function deriveProjectVerificationCoverage(
  authority: FrozenVerificationManifest | AcceptedWaveCompletionReceipt,
): ProjectVerificationCoverage {
  const { checkIds, emptyReason } = match(authority)
    .with({ kind: "frozen-verification-manifest" }, (manifest) => ({
      checkIds: manifest.projectChecks.map((check) => check.checkId),
      emptyReason: match(manifest.source)
        .with({ kind: "engine-default" }, () => "engine-default" as const)
        .with({ kind: "operator-file" }, () => "empty-operator-manifest" as const)
        .exhaustive(),
    }))
    .with({ kind: "accepted-wave-completion-suite" }, (receipt) => ({
      checkIds: receipt.checks
        .filter((check) => check.checkId !== FULL_TIER_LINT_CHECK_ID_TEXT)
        .map((check) => check.checkId),
      emptyReason: "historical-unknown" as const,
    }))
    .exhaustive();
  const [head, ...tail] = checkIds.toSorted(compareStrings);
  return head === undefined
    ? freeze({ kind: "not-configured", reason: emptyReason })
    : freeze({ kind: "configured", checkIds: Object.freeze([head, ...tail] as const) });
}

export function renderProjectVerificationCoverage(coverage: ProjectVerificationCoverage): string {
  return match(coverage)
    .with({ kind: "configured" }, ({ checkIds }) =>
      `Project verification checks configured: ${checkIds.join(", ")} (configuration is not a pass).`)
    .with({ kind: "not-configured" }, ({ reason }) => match(reason)
      .with("engine-default", () => "Project verification NOT CONFIGURED (engine-default: source absent at population; reserved checks only).")
      .with("empty-operator-manifest", () => "Project verification NOT CONFIGURED (empty-operator-manifest: operator configured zero project checks; reserved checks only).")
      .with("historical-unknown", () => "Project verification NOT CONFIGURED (historical-unknown: archived reserved checks only; source provenance unavailable).")
      .exhaustive())
    .exhaustive();
}

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

function exactRecord(raw: unknown, fields: readonly string[], path: string): Parsed<UnknownRecord> {
  const record = parseExactRecord(raw, fields, path);
  return record.ok ? success(record.value) : failure(exactRecordErrors(record, path, "an object"));
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

/** A stand-in file used only to validate the runner's command shape. */
const RUNNER_SHAPE_FILE = "acceptance-runner-shape.test.ts";

/** The runner's command with `files` in place of the placeholder, as authorized project-command authority. */
function runnerCheck(
  runner: Readonly<{ executable: unknown; args: readonly string[]; cwd: unknown; timeoutMs: unknown; report: unknown }>,
  files: readonly string[],
  path: string,
): Parsed<ProjectWaveCompletionCheck> {
  const authorized = parseAuthorizedWaveCompletionCheck({
    kind: "project-command",
    checkId: ACCEPTANCE_RUNNER_CHECK_ID,
    scope: "wave",
    executable: runner.executable,
    args: runner.args.flatMap((arg) => arg === ACCEPTANCE_RUNNER_FILES_PLACEHOLDER ? files : [arg]),
    cwd: runner.cwd,
    timeoutMs: runner.timeoutMs,
    reportPolicy: runner.report,
  }, path);
  if (!authorized.ok) return failure(authorized.error.errors);
  return authorized.value.kind === "project-command" ? success(authorized.value) : failure([`${path} must be a project command`]);
}

function parseAcceptanceRunner(raw: unknown, path: string): Parsed<AcceptanceRunner> {
  const record = exactRecord(raw, ["executable", "args", "cwd", "timeoutMs", "report"], path);
  if (!record.ok) return record;
  const rawArgs = record.value.args;
  if (!Array.isArray(rawArgs) || !rawArgs.every((arg): arg is string => typeof arg === "string")) {
    return failure([`${path}.args must be an array of strings`]);
  }
  const errors: string[] = [];
  const placeholders = rawArgs.filter((arg) => arg === ACCEPTANCE_RUNNER_FILES_PLACEHOLDER).length;
  if (placeholders !== 1) {
    errors.push(`${path}.args must contain exactly one whole "${ACCEPTANCE_RUNNER_FILES_PLACEHOLDER}" argument, found ${placeholders}`);
  }
  if (rawArgs.some((arg) => arg !== ACCEPTANCE_RUNNER_FILES_PLACEHOLDER && arg.includes(ACCEPTANCE_RUNNER_FILES_PLACEHOLDER))) {
    errors.push(`${path}.args may use "${ACCEPTANCE_RUNNER_FILES_PLACEHOLDER}" only as a whole argument`);
  }
  const { executable, cwd, timeoutMs, report } = record.value;
  const shape = runnerCheck({ executable, args: rawArgs, cwd, timeoutMs, report }, [RUNNER_SHAPE_FILE], path);
  if (!shape.ok) errors.push(...shape.error.errors);
  if (shape.ok) {
    const { reportPolicy } = shape.value;
    if (reportPolicy.kind !== "required-file" || !reportPolicy.path.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
      errors.push(`${path}.report must be a required-file beneath protected ${COMPLETION_REPORT_ROOT}/`);
    }
    if (shape.value.timeoutMs > MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS) {
      errors.push(`${path}.timeoutMs must be at most ${MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS}, inside the stop hook's own timeout`);
    }
  }
  if (errors.length > 0 || !shape.ok || shape.value.reportPolicy.kind !== "required-file") return failure(errors);
  return success(freeze({
    executable: shape.value.executable,
    args: freezeArray(rawArgs),
    cwd: shape.value.cwd,
    timeoutMs: shape.value.timeoutMs,
    report: shape.value.reportPolicy,
  }));
}

/**
 * The runner's exact command over these acceptance files, as authority the
 * completion check runner executes. Each file becomes one argument, written
 * relative to the runner's `cwd` because that is where it launches; nothing
 * else is interpolated.
 */
export function acceptanceRunnerCheck(
  runner: AcceptanceRunner,
  files: NonEmpty<string>,
): Parsed<ProjectWaveCompletionCheck> {
  return total(() => {
    const relative = filesFromRunnerCwd(runner.cwd, files);
    return relative.ok ? runnerCheck(runner, relative.value, "acceptanceRunner") : relative;
  });
}

/**
 * Repository-relative files as the runner sees them from its `cwd`. A file
 * outside that directory cannot be named to a runner that only collects
 * beneath it, so it is refused rather than passed through unmatched.
 */
function filesFromRunnerCwd(cwd: RepositoryRelativePath, files: readonly string[]): Parsed<readonly string[]> {
  if (cwd === ".") return success(files);
  const prefix = `${cwd}/`;
  const outside = files.filter((file) => !file.startsWith(prefix));
  return outside.length > 0
    ? failure([`acceptanceRunner.cwd ${cwd} does not contain ${outside.join(", ")}`])
    : success(freezeArray(files.map((file) => file.slice(prefix.length))));
}

/**
 * A runner must not share a report path with a Wave check, or one run would
 * overwrite the other's evidence. Both the source and the frozen parse apply
 * it, so a frozen manifest carries the invariant in its own parse.
 */
function runnerReportConflicts(runner: AcceptanceRunner, checkReports: readonly ReportPolicy[], path: string): readonly string[] {
  return checkReports.some((report) => report.kind === "required-file" && report.path === runner.report.path)
    ? [`${path}.report.path ${runner.report.path} is also a Wave check's report path`]
    : [];
}

function parseChecks(raw: unknown, path: string): Parsed<readonly VerificationManifestCheck[]> {
  const collected = collectDenseArray(raw, path, (value, elementPath) => toElementResult(parseCheck(value, elementPath)));
  if (collected.kind === "not-array") return failure([`${path} must be an array`]);
  const checks = collected.values;
  const errors = [...collected.errors];
  const counts = new Map<string, number>();
  for (const check of checks) counts.set(check.id, (counts.get(check.id) ?? 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort(compareStrings);
  if (duplicates.length > 0) errors.push(`${path} repeats check ids: ${duplicates.join(", ")}`);
  return errors.length === 0 ? success(freezeArray(checks)) : failure(errors);
}

/** Whether a raw document names an `acceptanceRunner` key, so the exact record admits it. */
const declaresRunner = (raw: unknown): boolean => isPlainRecord(raw) && Object.hasOwn(raw, "acceptanceRunner");

function parseDocument(raw: unknown): Parsed<VerificationManifest> {
  // A non-record falls through to exactRecord, which names the shape error.
  const schemaVersion = isPlainRecord(raw) ? raw.schemaVersion : VERIFICATION_MANIFEST_SCHEMA_VERSION;
  const runnerSchema = schemaVersion === VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION;
  if (schemaVersion !== VERIFICATION_MANIFEST_SCHEMA_VERSION && !runnerSchema) {
    return failure([
      `verificationManifest.schemaVersion must equal ${VERIFICATION_MANIFEST_SCHEMA_VERSION} or ${VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION}`,
    ]);
  }
  // Schema 1 never admits the key, so a schema-1 runner is refused as an unknown field.
  const hasRunner = runnerSchema && declaresRunner(raw);
  const record = exactRecord(
    raw,
    ["schemaVersion", "kind", "checks", ...(hasRunner ? ["acceptanceRunner"] : [])],
    "verificationManifest",
  );
  if (!record.ok) return record;
  const errors: string[] = [];
  if (record.value.kind !== VERIFICATION_MANIFEST_KIND) {
    errors.push(`verificationManifest.kind must equal ${VERIFICATION_MANIFEST_KIND}`);
  }
  const checks = parseChecks(record.value.checks, "verificationManifest.checks");
  if (!checks.ok) errors.push(...checks.error.errors);
  const runner = hasRunner ? parseAcceptanceRunner(record.value.acceptanceRunner, "verificationManifest.acceptanceRunner") : null;
  if (runner !== null && !runner.ok) errors.push(...runner.error.errors);
  if (runner?.ok && checks.ok) errors.push(...runnerReportConflicts(runner.value, checks.value.map(({ report }) => report), "verificationManifest.acceptanceRunner"));
  if (errors.length > 0 || !checks.ok || (runner !== null && !runner.ok)) return failure(errors);
  const manifest: VerificationManifest = runnerSchema
    ? freeze({
        schemaVersion: VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION,
        kind: VERIFICATION_MANIFEST_KIND,
        checks: checks.value,
        ...(runner === null ? {} : { acceptanceRunner: runner.value }),
      })
    : freeze({ schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION, kind: VERIFICATION_MANIFEST_KIND, checks: checks.value });
  return success(manifest);
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

/** A frozen runner's canonical digest form. Absent runners add no key, so
 *  manifests frozen before the runner existed keep their digests. */
function runnerAuthorityJson(runner: AcceptanceRunner): JsonValue {
  return {
    executable: runner.executable,
    args: runner.args,
    cwd: runner.cwd,
    timeoutMs: runner.timeoutMs,
    report: { kind: runner.report.kind, path: runner.report.path },
  };
}

function manifestAuthorityJson(
  source: VerificationManifestSource,
  checks: readonly ProjectWaveCompletionCheck[],
  runner: AcceptanceRunner | null,
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
    ...(runner === null ? {} : { acceptanceRunner: runnerAuthorityJson(runner) }),
  };
}

const ENGINE_DEFAULT_SOURCE: EngineDefaultSource = freeze({ kind: "engine-default" as const });

/** What a frozen manifest is sealed from: the engine default carries nothing to authorize. */
type FrozenAuthority =
  | Readonly<{ kind: "engine-default" }>
  | Readonly<{
      kind: "operator-file";
      source: OperatorFileSource;
      checks: readonly ProjectWaveCompletionCheck[];
      runner: AcceptanceRunner | null;
    }>;

function frozenManifest(authority: FrozenAuthority): FrozenVerificationManifest {
  if (authority.kind === "engine-default") {
    return freeze({
      schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
      kind: "frozen-verification-manifest",
      source: ENGINE_DEFAULT_SOURCE,
      manifestDigest: digestJson(manifestAuthorityJson(ENGINE_DEFAULT_SOURCE, [], null)),
      projectChecks: Object.freeze([] as const),
    });
  }
  const { source, runner } = authority;
  const projectChecks = freezeArray([...authority.checks].sort((left, right) => compareStrings(left.checkId, right.checkId)));
  return freeze({
    schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
    kind: "frozen-verification-manifest",
    source,
    manifestDigest: digestJson(manifestAuthorityJson(source, projectChecks, runner)),
    projectChecks,
    ...(runner === null ? {} : { acceptanceRunner: runner }),
  });
}

const ENGINE_DEFAULT_MANIFEST = frozenManifest({ kind: "engine-default" });

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
    return success(frozenManifest({
      kind: "operator-file",
      source,
      checks: parsed.value.checks.map(projectCheck),
      runner: parsed.value.acceptanceRunner ?? null,
    }));
  });
}

function parseSource(raw: unknown): Parsed<VerificationManifestSource> {
  if (!isPlainRecord(raw)) return failure(["frozenVerificationManifest.source must be an object"]);
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

function parseProjectCheck(raw: unknown, path: string): ElementResult<ProjectWaveCompletionCheck> {
  const parsed = parseAuthorizedWaveCompletionCheck(raw, path);
  if (!parsed.ok) return freeze({ ok: false, errors: parsed.error.errors });
  if (parsed.value.kind !== "project-command") return freeze({ ok: false, errors: [`${path} must be a project command`] });
  if (parsed.value.reportPolicy.kind === "required-file" &&
      !parsed.value.reportPolicy.path.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
    return freeze({
      ok: false,
      errors: [`${path}.reportPolicy.path must be a file beneath protected ${COMPLETION_REPORT_ROOT}/`],
    });
  }
  return freeze({ ok: true, value: parsed.value });
}

function parseProjectChecks(raw: unknown): Parsed<readonly ProjectWaveCompletionCheck[]> {
  const collected = collectDenseArray(raw, "frozenVerificationManifest.projectChecks", parseProjectCheck);
  if (collected.kind === "not-array") return failure(["frozenVerificationManifest.projectChecks must be an array"]);
  const checks = collected.values;
  const errors = [...collected.errors];
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
    const hasRunner = declaresRunner(raw);
    const record = exactRecord(
      raw,
      ["schemaVersion", "kind", "source", "manifestDigest", "projectChecks", ...(hasRunner ? ["acceptanceRunner"] : [])],
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
    const runner = hasRunner ? parseAcceptanceRunner(record.value.acceptanceRunner, "frozenVerificationManifest.acceptanceRunner") : null;
    const errors = [...tagErrors, ...[source, checks].flatMap((result) => result.ok ? [] : result.error.errors)];
    if (runner !== null && !runner.ok) errors.push(...runner.error.errors);
    if (runner?.ok && checks.ok) {
      errors.push(...runnerReportConflicts(runner.value, checks.value.map(({ reportPolicy }) => reportPolicy), "frozenVerificationManifest.acceptanceRunner"));
    }
    if (source.ok && source.value.kind === "engine-default" && runner !== null) {
      errors.push("frozenVerificationManifest engine-default source cannot authorize an acceptance runner");
    }
    if (!declaredDigest.ok) errors.push(`frozenVerificationManifest.manifestDigest: ${declaredDigest.error.message}`);
    if (source.ok && source.value.kind === "engine-default" && checks.ok && checks.value.length > 0) {
      errors.push("frozenVerificationManifest engine-default source cannot authorize project checks");
    }
    if (errors.length > 0 || !source.ok || !checks.ok || !declaredDigest.ok || (runner !== null && !runner.ok)) return failure(errors);
    const canonical = source.value.kind === "engine-default"
      ? frozenManifest({ kind: "engine-default" })
      : frozenManifest({ kind: "operator-file", source: source.value, checks: checks.value, runner: runner === null ? null : runner.value });
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
