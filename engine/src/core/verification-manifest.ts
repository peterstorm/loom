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
import { DEFAULT_TEST_FILE_SUFFIXES, ENGINE_DEFAULT_TEST_FILES, type FrozenTestFiles } from "./test-file-classification";

export const VERIFICATION_MANIFEST_SOURCE_PATH = ".loom/verification-manifest.json" as const;
export const VERIFICATION_MANIFEST_SCHEMA_VERSION = 1 as const;
/** Source schema 2 adds the optional `acceptanceRunner`, `affectedRunner` and
 *  `testFileSuffixes`; schema 1 stays valid and means none of them. */
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
/** The check id the affected runner's expanded command carries through the completion runner. */
export const AFFECTED_RUNNER_CHECK_ID = "project:affected-runner" as const;
/**
 * The affected runner's timeout cap. This equals CT-2's
 * `MAX_AFFECTED_RUNNER_TIMEOUT_MS`. It is restated here because that types file
 * imports `../types`, which imports this module, so importing it would close a
 * cycle between top-level domains. `verification-manifest-affected.test.ts`
 * asserts the two are equal.
 */
export const MAX_AFFECTED_RUNNER_TIMEOUT_MS = 120_000;

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

/** The operator-declared affected-test runner (I7): the acceptance runner's
 *  shape and form checks, capped at `MAX_AFFECTED_RUNNER_TIMEOUT_MS`. This is
 *  the same type as CT-2's `AffectedRunner`. */
export type AffectedRunner = AcceptanceRunner;

type VerificationManifestBase = Readonly<{
  kind: typeof VERIFICATION_MANIFEST_KIND;
  checks: readonly VerificationManifestCheck[];
}>;

/** Schema 1 cannot declare a runner or test-file suffixes; schema 2 may, and
 *  carries each key only when the operator declares it. */
export type VerificationManifest =
  | VerificationManifestBase & Readonly<{
      schemaVersion: typeof VERIFICATION_MANIFEST_SCHEMA_VERSION;
      acceptanceRunner?: never;
      affectedRunner?: never;
      testFileSuffixes?: never;
    }>
  | VerificationManifestBase & Readonly<{
      schemaVersion: typeof VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION;
      acceptanceRunner?: AcceptanceRunner;
      affectedRunner?: AffectedRunner;
      testFileSuffixes?: NonEmpty<string>;
    }>;

/** The engine default's classification: the only one an engine-default source may carry. */
type EngineDefaultTestFiles = FrozenTestFiles & Readonly<{ source: "engine-default" }>;

type FrozenVerificationManifestBase = Readonly<{
  schemaVersion: typeof VERIFICATION_MANIFEST_SCHEMA_VERSION;
  kind: "frozen-verification-manifest";
  manifestDigest: ArtifactDigest;
}>;

/**
 * The engine-default form authorizes nothing: no project check and no runner.
 * An operator-file form's runners are absent on graphs frozen before they
 * existed, and whenever the operator declared none: either way that stop
 * check is off.
 *
 * `testFiles` is the frozen test-file classification (FR-014). Every freeze
 * made since it existed carries it, the engine default included; only a
 * TaskGraph frozen before it lacks it, and that absence is exactly the
 * pre-I6 era.
 */
export type FrozenVerificationManifest =
  | FrozenVerificationManifestBase & Readonly<{
      source: EngineDefaultSource;
      projectChecks: readonly [];
      acceptanceRunner?: never;
      affectedRunner?: never;
      testFiles?: EngineDefaultTestFiles;
    }>
  | FrozenVerificationManifestBase & Readonly<{
      source: OperatorFileSource;
      projectChecks: readonly ProjectWaveCompletionCheck[];
      acceptanceRunner?: AcceptanceRunner;
      affectedRunner?: AffectedRunner;
      testFiles?: FrozenTestFiles;
    }>;

/**
 * A manifest frozen since the test-file classification existed: its
 * `testFiles` is required (ADR-0025). Every post-feature freezer
 * (`defaultVerificationManifest`, `freezeVerificationManifest`) returns one,
 * so a freeze path that dropped the classification, and with it quietly
 * turned I6 off for every graph it froze, no longer typechecks. The wider
 * `FrozenVerificationManifest` is what a TaskGraph frozen before the
 * classification existed reads back as, and what
 * `legacyDefaultVerificationManifest` deliberately returns.
 */
export type I6EraVerificationManifest = FrozenVerificationManifest & Readonly<{ testFiles: FrozenTestFiles }>;

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

/**
 * The two operator-declared runners share one shape and every form check
 * (FR-015); they differ only in their manifest key, the check id their
 * command carries, and the timeout cap their stop-hook slot allows.
 */
type RunnerRole = Readonly<{
  key: "acceptanceRunner" | "affectedRunner";
  checkId: typeof ACCEPTANCE_RUNNER_CHECK_ID | typeof AFFECTED_RUNNER_CHECK_ID;
  maxTimeoutMs: number;
}>;

const ACCEPTANCE_RUNNER_ROLE: RunnerRole = freeze({
  key: "acceptanceRunner",
  checkId: ACCEPTANCE_RUNNER_CHECK_ID,
  maxTimeoutMs: MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS,
});

const AFFECTED_RUNNER_ROLE: RunnerRole = freeze({
  key: "affectedRunner",
  checkId: AFFECTED_RUNNER_CHECK_ID,
  maxTimeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
});

/** The runner's command with `files` in place of the placeholder, as authorized project-command authority. */
function runnerCheck(
  runner: Readonly<{ executable: unknown; args: readonly string[]; cwd: unknown; timeoutMs: unknown; report: unknown }>,
  files: readonly string[],
  path: string,
  role: RunnerRole,
): Parsed<ProjectWaveCompletionCheck> {
  const authorized = parseAuthorizedWaveCompletionCheck({
    kind: "project-command",
    checkId: role.checkId,
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

/** Parse one runner under its role's form checks; `path` names its key in the document. */
function parseRunner(raw: unknown, path: string, role: RunnerRole): Parsed<AcceptanceRunner> {
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
  const shape = runnerCheck({ executable, args: rawArgs, cwd, timeoutMs, report }, [RUNNER_SHAPE_FILE], path, role);
  if (!shape.ok) errors.push(...shape.error.errors);
  if (shape.ok) {
    const { reportPolicy } = shape.value;
    if (reportPolicy.kind !== "required-file" || !reportPolicy.path.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
      errors.push(`${path}.report must be a required-file beneath protected ${COMPLETION_REPORT_ROOT}/`);
    }
    if (shape.value.timeoutMs > role.maxTimeoutMs) {
      errors.push(`${path}.timeoutMs must be at most ${role.maxTimeoutMs}, inside the stop hook's own timeout`);
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
  return roleRunnerCheck(runner, files, ACCEPTANCE_RUNNER_ROLE);
}

/**
 * The affected runner's exact command over a Task's changed files, formed
 * exactly as `acceptanceRunnerCheck` forms the acceptance runner's, under the
 * affected runner's own check id.
 */
export function affectedRunnerCheck(
  runner: AffectedRunner,
  files: NonEmpty<string>,
): Parsed<ProjectWaveCompletionCheck> {
  return roleRunnerCheck(runner, files, AFFECTED_RUNNER_ROLE);
}

function roleRunnerCheck(runner: AcceptanceRunner, files: readonly string[], role: RunnerRole): Parsed<ProjectWaveCompletionCheck> {
  return total(() => {
    const relative = filesFromRunnerCwd(runner.cwd, files, role);
    return relative.ok ? runnerCheck(runner, relative.value, role.key, role) : relative;
  });
}

/**
 * Repository-relative files as the runner sees them from its `cwd`. A file
 * outside that directory cannot be named to a runner that only collects
 * beneath it, so it is refused rather than passed through unmatched.
 */
function filesFromRunnerCwd(cwd: RepositoryRelativePath, files: readonly string[], role: RunnerRole): Parsed<readonly string[]> {
  if (cwd === ".") return success(files);
  const prefix = `${cwd}/`;
  const outside = files.filter((file) => !file.startsWith(prefix));
  return outside.length > 0
    ? failure([`${role.key}.cwd ${cwd} does not contain ${outside.join(", ")}`])
    : success(freezeArray(files.map((file) => file.slice(prefix.length))));
}

/**
 * A runner must not share a report path with a Wave check, nor the affected
 * runner with the acceptance runner, or one run would overwrite the other's
 * evidence. Both the source and the frozen parse apply it, so a frozen
 * manifest carries the invariant in its own parse.
 */
function runnerReportConflicts(runner: AcceptanceRunner, checkReports: readonly ReportPolicy[], path: string): readonly string[] {
  return checkReports.some((report) => report.kind === "required-file" && report.path === runner.report.path)
    ? [`${path}.report.path ${runner.report.path} is also a Wave check's report path`]
    : [];
}

function affectedAcceptanceConflict(affected: AffectedRunner, acceptance: AcceptanceRunner | null, path: string): readonly string[] {
  return acceptance !== null && acceptance.report.path === affected.report.path
    ? [`${path}.report.path ${affected.report.path} is also the acceptanceRunner's report path`]
    : [];
}

/** Every report-path conflict among the runners and the Wave checks. */
function reportConflicts(
  acceptance: AcceptanceRunner | null,
  affected: AffectedRunner | null,
  checkReports: readonly ReportPolicy[],
  path: string,
): readonly string[] {
  return [
    ...(acceptance === null ? [] : runnerReportConflicts(acceptance, checkReports, `${path}.acceptanceRunner`)),
    ...(affected === null ? [] : [
      ...runnerReportConflicts(affected, checkReports, `${path}.affectedRunner`),
      ...affectedAcceptanceConflict(affected, acceptance, `${path}.affectedRunner`),
    ]),
  ];
}

/**
 * Operator test-file suffixes: a non-empty list of distinct, non-empty
 * suffixes, none naming a directory. Declared order is kept, since it is
 * what the operator froze and what the digest covers.
 */
function parseTestFileSuffixes(raw: unknown, path: string): Parsed<NonEmpty<string>> {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((suffix): suffix is string => typeof suffix === "string")) {
    return failure([`${path} must be a non-empty array of strings`]);
  }
  const errors = raw.flatMap((suffix, index) => suffix === "" || /[\\/]/.test(suffix)
    ? [`${path}[${index}] must be a non-empty suffix without a path separator`]
    : []);
  const repeated = [...new Set(raw.filter((suffix, index) => raw.indexOf(suffix) !== index))].sort(compareStrings);
  if (repeated.length > 0) errors.push(`${path} repeats suffixes: ${repeated.join(", ")}`);
  return errors.length === 0 ? success(freezeArray(raw) as NonEmpty<string>) : failure(errors);
}

const TEST_FILES_SOURCES: ReadonlySet<unknown> = new Set<FrozenTestFiles["source"]>(["operator-manifest", "engine-default"]);

function parseFrozenTestFiles(raw: unknown, path: string): Parsed<FrozenTestFiles> {
  const record = exactRecord(raw, ["source", "suffixes"], path);
  if (!record.ok) return record;
  const { source } = record.value;
  const suffixes = parseTestFileSuffixes(record.value.suffixes, `${path}.suffixes`);
  const errors = [
    ...(TEST_FILES_SOURCES.has(source) ? [] : [`${path}.source must be operator-manifest or engine-default`]),
    ...(suffixes.ok ? [] : suffixes.error.errors),
  ];
  return errors.length === 0 && suffixes.ok
    ? success(freeze({ source: source as FrozenTestFiles["source"], suffixes: suffixes.value }))
    : failure(errors);
}

const isEngineDefaultSuffixes = (suffixes: readonly string[]): boolean =>
  suffixes.length === DEFAULT_TEST_FILE_SUFFIXES.length &&
  suffixes.every((suffix, index) => suffix === DEFAULT_TEST_FILE_SUFFIXES[index]);

const NOT_ENGINE_DEFAULT_TEST_FILES =
  `frozenVerificationManifest.testFiles.suffixes must equal the engine default (${DEFAULT_TEST_FILE_SUFFIXES.join(", ")}) when source is engine-default`;

/** The refusal of an `engine-default` classification whose suffixes are not exactly the engine default, in order. */
const engineDefaultTestFilesErrors = (testFiles: FrozenTestFiles | null): readonly string[] =>
  testFiles?.source === "engine-default" && !isEngineDefaultSuffixes(testFiles.suffixes) ? [NOT_ENGINE_DEFAULT_TEST_FILES] : [];

/** The canonical classification: an `engine-default` label always means the
 *  shared engine default, never the suffixes a stored form carried. */
const canonicalTestFiles = (testFiles: FrozenTestFiles | null): FrozenTestFiles | null =>
  testFiles?.source === "engine-default" ? ENGINE_DEFAULT_TEST_FILES : testFiles;

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

/** Which of these optional keys a raw document names, so the exact record admits them. */
const declaredKeys = <const K extends string>(raw: unknown, keys: readonly K[]): readonly K[] =>
  isPlainRecord(raw) ? keys.filter((key) => Object.hasOwn(raw, key)) : [];

/** Parse an optional key: null when the document does not declare it. */
const optionalKey = <T>(declared: readonly string[], key: string, parse: () => Parsed<T>): Parsed<T> | null =>
  declared.includes(key) ? parse() : null;

const errorsOf = (...results: readonly (Parsed<unknown> | null)[]): readonly string[] =>
  results.flatMap((result) => result === null || result.ok ? [] : result.error.errors);

/** The value of an optional key that parsed, or null when it was not declared. */
const valueOrNull = <T>(result: Parsed<T> | null): T | null => result?.ok === true ? result.value : null;

const SOURCE_OPTIONAL_KEYS = ["acceptanceRunner", "affectedRunner", "testFileSuffixes"] as const;
const FROZEN_OPTIONAL_KEYS = ["acceptanceRunner", "affectedRunner", "testFiles"] as const;

function parseDocument(raw: unknown): Parsed<VerificationManifest> {
  // A non-record falls through to exactRecord, which names the shape error.
  const schemaVersion = isPlainRecord(raw) ? raw.schemaVersion : VERIFICATION_MANIFEST_SCHEMA_VERSION;
  const runnerSchema = schemaVersion === VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION;
  if (schemaVersion !== VERIFICATION_MANIFEST_SCHEMA_VERSION && !runnerSchema) {
    return failure([
      `verificationManifest.schemaVersion must equal ${VERIFICATION_MANIFEST_SCHEMA_VERSION} or ${VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION}`,
    ]);
  }
  // Schema 1 never admits the optional keys, so each is refused there as an unknown field.
  const declared = runnerSchema ? declaredKeys(raw, SOURCE_OPTIONAL_KEYS) : [];
  const record = exactRecord(raw, ["schemaVersion", "kind", "checks", ...declared], "verificationManifest");
  if (!record.ok) return record;
  const errors: string[] = [];
  if (record.value.kind !== VERIFICATION_MANIFEST_KIND) {
    errors.push(`verificationManifest.kind must equal ${VERIFICATION_MANIFEST_KIND}`);
  }
  const checks = parseChecks(record.value.checks, "verificationManifest.checks");
  const acceptance = optionalKey(declared, "acceptanceRunner", () =>
    parseRunner(record.value.acceptanceRunner, "verificationManifest.acceptanceRunner", ACCEPTANCE_RUNNER_ROLE));
  const affected = optionalKey(declared, "affectedRunner", () =>
    parseRunner(record.value.affectedRunner, "verificationManifest.affectedRunner", AFFECTED_RUNNER_ROLE));
  const suffixes = optionalKey(declared, "testFileSuffixes", () =>
    parseTestFileSuffixes(record.value.testFileSuffixes, "verificationManifest.testFileSuffixes"));
  errors.push(...errorsOf(checks, acceptance, affected, suffixes));
  if (!checks.ok || errors.length > 0) return failure(errors);
  const conflicts = reportConflicts(
    valueOrNull(acceptance), valueOrNull(affected), checks.value.map(({ report }) => report), "verificationManifest",
  );
  if (conflicts.length > 0) return failure(conflicts);
  const manifest: VerificationManifest = runnerSchema
    ? freeze({
        schemaVersion: VERIFICATION_MANIFEST_RUNNER_SCHEMA_VERSION,
        kind: VERIFICATION_MANIFEST_KIND,
        checks: checks.value,
        ...(acceptance?.ok === true ? { acceptanceRunner: acceptance.value } : {}),
        ...(affected?.ok === true ? { affectedRunner: affected.value } : {}),
        ...(suffixes?.ok === true ? { testFileSuffixes: suffixes.value } : {}),
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

/** The optional frozen fields; null is absent, so a pre-feature form keeps its digest. */
type FrozenOptionalFields = Readonly<{
  acceptanceRunner: AcceptanceRunner | null;
  affectedRunner: AffectedRunner | null;
  testFiles: FrozenTestFiles | null;
}>;

function manifestAuthorityJson(
  source: VerificationManifestSource,
  checks: readonly ProjectWaveCompletionCheck[],
  { acceptanceRunner, affectedRunner, testFiles }: FrozenOptionalFields,
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
    ...(acceptanceRunner === null ? {} : { acceptanceRunner: runnerAuthorityJson(acceptanceRunner) }),
    ...(affectedRunner === null ? {} : { affectedRunner: runnerAuthorityJson(affectedRunner) }),
    ...(testFiles === null ? {} : { testFiles: { source: testFiles.source, suffixes: testFiles.suffixes } }),
  };
}

const ENGINE_DEFAULT_SOURCE: EngineDefaultSource = freeze({ kind: "engine-default" as const });

/** What a frozen manifest is sealed from: the engine default authorizes nothing,
 *  and carries at most the engine-default classification. */
type FrozenAuthority =
  | Readonly<{ kind: "engine-default"; testFiles: EngineDefaultTestFiles | null }>
  | FrozenOptionalFields & Readonly<{
      kind: "operator-file";
      source: OperatorFileSource;
      checks: readonly ProjectWaveCompletionCheck[];
    }>;

type EngineDefaultFrozenManifest = Extract<FrozenVerificationManifest, Readonly<{ source: EngineDefaultSource }>>;
type OperatorFileFrozenManifest = Extract<FrozenVerificationManifest, Readonly<{ source: OperatorFileSource }>>;
type OperatorFileAuthority = Extract<FrozenAuthority, { kind: "operator-file" }>;

function engineDefaultManifest(testFiles: EngineDefaultTestFiles | null): EngineDefaultFrozenManifest {
  return freeze({
    schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
    kind: "frozen-verification-manifest",
    source: ENGINE_DEFAULT_SOURCE,
    manifestDigest: digestJson(manifestAuthorityJson(ENGINE_DEFAULT_SOURCE, [], {
      acceptanceRunner: null, affectedRunner: null, testFiles,
    })),
    projectChecks: Object.freeze([] as const),
    ...(testFiles === null ? {} : { testFiles }),
  });
}

function operatorFileManifest(authority: OperatorFileAuthority): OperatorFileFrozenManifest {
  const { source, acceptanceRunner, affectedRunner, testFiles } = authority;
  const projectChecks = freezeArray([...authority.checks].sort((left, right) => compareStrings(left.checkId, right.checkId)));
  return freeze({
    schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
    kind: "frozen-verification-manifest",
    source,
    manifestDigest: digestJson(manifestAuthorityJson(source, projectChecks, { acceptanceRunner, affectedRunner, testFiles })),
    projectChecks,
    ...(acceptanceRunner === null ? {} : { acceptanceRunner }),
    ...(affectedRunner === null ? {} : { affectedRunner }),
    ...(testFiles === null ? {} : { testFiles }),
  });
}

function frozenManifest(authority: FrozenAuthority): FrozenVerificationManifest {
  return authority.kind === "engine-default" ? engineDefaultManifest(authority.testFiles) : operatorFileManifest(authority);
}

/** The authority a freezer seals: the classification is always present. */
type I6EraAuthority =
  | Readonly<{ kind: "engine-default"; testFiles: EngineDefaultTestFiles }>
  | OperatorFileAuthority & Readonly<{ testFiles: FrozenTestFiles }>;

/** Seal an authority that carries its classification, keeping it on the result's type. */
function i6EraManifest(authority: I6EraAuthority): I6EraVerificationManifest {
  return authority.kind === "engine-default"
    ? freeze({ ...engineDefaultManifest(authority.testFiles), testFiles: authority.testFiles })
    : freeze({ ...operatorFileManifest(authority), testFiles: authority.testFiles });
}

const ENGINE_DEFAULT_MANIFEST = i6EraManifest({ kind: "engine-default", testFiles: ENGINE_DEFAULT_TEST_FILES });
const LEGACY_ENGINE_DEFAULT_MANIFEST = frozenManifest({ kind: "engine-default", testFiles: null });

/**
 * The authority population freezes when `.loom/verification-manifest.json` is
 * absent. It can never accept project commands, and it carries the engine
 * default test-file classification (FR-014).
 */
export function defaultVerificationManifest(): I6EraVerificationManifest {
  return ENGINE_DEFAULT_MANIFEST;
}

/**
 * The engine default exactly as frozen before the test-file classification
 * existed: same bytes, same digest. Only read-time fallbacks for a TaskGraph
 * that carries no `verification_manifest` use it, because that graph's
 * receipts were stamped with this digest.
 */
export function legacyDefaultVerificationManifest(): FrozenVerificationManifest {
  return LEGACY_ENGINE_DEFAULT_MANIFEST;
}

function rawByteDigest(bytes: Uint8Array): ArtifactDigest {
  const parsed = parseArtifactDigest(sha256Bytes(bytes));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/** Decode, parse, and freeze exact operator-file bytes into protected authority. */
export function freezeVerificationManifest(rawBytes: unknown): Parsed<I6EraVerificationManifest> {
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
    return success(i6EraManifest({
      kind: "operator-file",
      source,
      checks: parsed.value.checks.map(projectCheck),
      acceptanceRunner: parsed.value.acceptanceRunner ?? null,
      affectedRunner: parsed.value.affectedRunner ?? null,
      testFiles: parsed.value.testFileSuffixes === undefined
        ? ENGINE_DEFAULT_TEST_FILES
        : freeze({ source: "operator-manifest" as const, suffixes: parsed.value.testFileSuffixes }),
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

/** Each frozen field parsed independently; an optional key is null when it was not declared. */
type FrozenFields = Readonly<{
  source: Parsed<VerificationManifestSource>;
  checks: Parsed<readonly ProjectWaveCompletionCheck[]>;
  declaredDigest: ReturnType<typeof parseArtifactDigest>;
  acceptance: Parsed<AcceptanceRunner> | null;
  affected: Parsed<AcceptanceRunner> | null;
  testFiles: Parsed<FrozenTestFiles> | null;
}>;

function frozenTagErrors(record: UnknownRecord): string[] {
  const errors: string[] = [];
  if (record.schemaVersion !== VERIFICATION_MANIFEST_SCHEMA_VERSION) {
    errors.push(`frozenVerificationManifest.schemaVersion must equal ${VERIFICATION_MANIFEST_SCHEMA_VERSION}`);
  }
  if (record.kind !== "frozen-verification-manifest") {
    errors.push("frozenVerificationManifest.kind must equal frozen-verification-manifest");
  }
  return errors;
}

function parseFrozenFields(record: UnknownRecord, declared: readonly string[]): FrozenFields {
  return freeze({
    source: parseSource(record.source),
    checks: parseProjectChecks(record.projectChecks),
    declaredDigest: parseArtifactDigest(record.manifestDigest),
    acceptance: optionalKey(declared, "acceptanceRunner", () =>
      parseRunner(record.acceptanceRunner, "frozenVerificationManifest.acceptanceRunner", ACCEPTANCE_RUNNER_ROLE)),
    affected: optionalKey(declared, "affectedRunner", () =>
      parseRunner(record.affectedRunner, "frozenVerificationManifest.affectedRunner", AFFECTED_RUNNER_ROLE)),
    testFiles: optionalKey(declared, "testFiles", () =>
      parseFrozenTestFiles(record.testFiles, "frozenVerificationManifest.testFiles")),
  });
}

/** Cross-field refusals, in their reporting order: report conflicts, engine-default authority, digest shape. */
function frozenFieldErrors(fields: FrozenFields): string[] {
  const { source, checks, declaredDigest, acceptance, affected, testFiles } = fields;
  const errors = [...errorsOf(source, checks, acceptance, affected, testFiles)];
  if (checks.ok) {
    errors.push(...reportConflicts(
      valueOrNull(acceptance), valueOrNull(affected), checks.value.map(({ reportPolicy }) => reportPolicy), "frozenVerificationManifest",
    ));
  }
  const engineDefault = source.ok && source.value.kind === "engine-default";
  if (engineDefault && acceptance !== null) {
    errors.push("frozenVerificationManifest engine-default source cannot authorize an acceptance runner");
  }
  if (engineDefault && affected !== null) {
    errors.push("frozenVerificationManifest engine-default source cannot authorize an affected runner");
  }
  if (engineDefault && valueOrNull(testFiles)?.source === "operator-manifest") {
    errors.push("frozenVerificationManifest engine-default source cannot carry an operator-manifest testFiles");
  }
  if (!declaredDigest.ok) errors.push(`frozenVerificationManifest.manifestDigest: ${declaredDigest.error.message}`);
  if (engineDefault && checks.ok && checks.value.length > 0) {
    errors.push("frozenVerificationManifest engine-default source cannot authorize project checks");
  }
  return errors;
}

/** Rebuild the canonical authority from admitted fields, so its digest can be re-derived. */
function canonicalFrozenManifest(
  source: VerificationManifestSource,
  checks: readonly ProjectWaveCompletionCheck[],
  fields: FrozenFields,
): FrozenVerificationManifest {
  const frozenTestFiles = canonicalTestFiles(valueOrNull(fields.testFiles));
  return source.kind === "engine-default"
    ? frozenManifest({
        kind: "engine-default",
        // frozenFieldErrors refused an operator-manifest classification under this source.
        testFiles: frozenTestFiles === null ? null : ENGINE_DEFAULT_TEST_FILES,
      })
    : frozenManifest({
        kind: "operator-file",
        source,
        checks,
        acceptanceRunner: valueOrNull(fields.acceptance),
        affectedRunner: valueOrNull(fields.affected),
        testFiles: frozenTestFiles,
      });
}

/**
 * Rehydrate only exact frozen authority whose canonical digest still matches
 * and whose `engine-default` classification is exactly the engine default.
 * Both refusals are reported together, the named classification one first.
 */
export function parseFrozenVerificationManifest(raw: unknown): Parsed<FrozenVerificationManifest> {
  return total(() => {
    const declared = declaredKeys(raw, FROZEN_OPTIONAL_KEYS);
    const record = exactRecord(
      raw,
      ["schemaVersion", "kind", "source", "manifestDigest", "projectChecks", ...declared],
      "frozenVerificationManifest",
    );
    if (!record.ok) return record;
    const fields = parseFrozenFields(record.value, declared);
    const { source, checks, declaredDigest } = fields;
    const errors = [...frozenTagErrors(record.value), ...frozenFieldErrors(fields)];
    if (errors.length > 0 || !source.ok || !checks.ok || !declaredDigest.ok) return failure(errors);
    const canonical = canonicalFrozenManifest(source.value, checks.value, fields);
    const refusals = [
      ...engineDefaultTestFilesErrors(valueOrNull(fields.testFiles)),
      ...(canonical.manifestDigest === declaredDigest.value
        ? []
        : ["frozenVerificationManifest.manifestDigest does not match its canonical authority"]),
    ];
    return refusals.length === 0 ? success(canonical) : failure(refusals);
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
