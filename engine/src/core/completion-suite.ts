/**
 * Pure completion-suite domain kernel.
 *
 * The shell observes processes and supplies data to this module. This module
 * performs no process, filesystem, clock, or network I/O.
 */

import { match } from "ts-pattern";
import { compareStrings } from "./ordering";
import {
  parseArtifactDigest,
  parseOrchestrationRunId,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
  type OrchestrationRunId,
} from "./orchestration-contract";
import {
  canonicalJson,
  parseReviewPath,
  sha256Hex,
  type JsonValue,
  type ReviewPath,
} from "./review-packet";

const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const RESERVED_CHECK_PREFIX = "loom:";
export const FULL_TIER_LINT_CHECK_ID_TEXT = "loom:full-tier-lint" as const;
export const COMPLETION_REPORT_ROOT = ".loom/completion-reports" as const;
const OPERATOR_VERIFICATION_MANIFEST_PATH = ".loom/verification-manifest.json" as const;

/** Task ownership must never include operator command authority or engine report artifacts. */
export function isProtectedVerificationPath(path: string): boolean {
  return path === OPERATOR_VERIFICATION_MANIFEST_PATH ||
    path.startsWith(`${COMPLETION_REPORT_ROOT}/`);
}

const COMPLETION_SIGNALS = Object.freeze([
  "SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE",
  "SIGHUP", "SIGILL", "SIGINFO", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL",
  "SIGLOST", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV",
  "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN",
  "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU",
  "SIGXFSZ",
] as const);
const COMPLETION_SIGNAL_SET: ReadonlySet<string> = new Set(COMPLETION_SIGNALS);

const MAX_SPAWN_FAILURE_MESSAGE_LENGTH = 4_096;
export const MIN_COMPLETION_CHECK_TIMEOUT_MS = 1 as const;
export const MAX_COMPLETION_CHECK_TIMEOUT_MS = 86_400_000 as const;

declare const COMPLETION_CHECK_ID: unique symbol;
declare const WAVE_NUMBER: unique symbol;
declare const REGISTRATION_REVISION: unique symbol;
declare const COMPLETION_TIMEOUT_MS: unique symbol;

export type CompletionCheckId = string & { readonly [COMPLETION_CHECK_ID]: true };
export type WaveNumber = number & { readonly [WAVE_NUMBER]: true };
export type RegistrationRevision = number & { readonly [REGISTRATION_REVISION]: true };
export type CompletionTimeoutMs = number & { readonly [COMPLETION_TIMEOUT_MS]: true };
export type CompletionSignal = (typeof COMPLETION_SIGNALS)[number];
export type RepositoryRelativePath = ReviewPath | ".";
export type NonEmptyString = string & { readonly __nonEmptyString: true };

export type ReportPolicy =
  | Readonly<{ kind: "not-required" }>
  | Readonly<{ kind: "required-file"; path: ReviewPath }>;
export type CompletionReportOutcome =
  | Readonly<{ kind: "not-required" }>
  | Readonly<{
      kind: "produced";
      path: ReviewPath;
      digest: ArtifactDigest;
      byteLength: number;
    }>
  | Readonly<{ kind: "missing"; path: ReviewPath }>
  | Readonly<{ kind: "unreadable"; path: ReviewPath; message: NonEmptyString }>;
export type CompletionScope = "task" | "wave";

/** The reserved check is engine authority; project checks come from frozen manifest authority. */
export type AuthorizedWaveCompletionCheck =
  | Readonly<{
      kind: "engine-full-tier-lint";
      checkId: CompletionCheckId;
      scope: "wave";
      reportPolicy: Readonly<{ kind: "not-required" }>;
    }>
  | Readonly<{
      kind: "project-command";
      checkId: CompletionCheckId;
      scope: "wave";
      executable: string;
      args: readonly string[];
      cwd: RepositoryRelativePath;
      timeoutMs: CompletionTimeoutMs;
      reportPolicy: ReportPolicy;
    }>;

/** Spawn failure cannot be confused with facts observed from a spawned process. */
export type CompletionProcessOutcome =
  | Readonly<{ kind: "spawn-failed"; message: NonEmptyString }>
  | Readonly<{
      kind: "observed";
      exitCode: number | null;
      timedOut: boolean;
      signal: CompletionSignal | null;
      report: CompletionReportOutcome;
    }>;

export type CompletionCheckResult = Readonly<{
  checkId: CompletionCheckId;
  scope: CompletionScope;
  outcome: CompletionProcessOutcome;
}>;

export type AuthorizedWaveCompletionSuite = Readonly<{
  kind: "authorized-wave-completion-suite";
  runId: OrchestrationRunId;
  wave: WaveNumber;
  revision: RegistrationRevision;
  authorityDigest: ArtifactDigest;
  manifestDigest: ArtifactDigest;
  suiteDigest: ArtifactDigest;
  workspaceDigest: ArtifactDigest;
  checks: NonEmpty<AuthorizedWaveCompletionCheck>;
}>;

export type WaveCompletionSuiteResult = Readonly<{
  kind: "wave-completion-suite-result";
  runId: OrchestrationRunId;
  wave: WaveNumber;
  revision: RegistrationRevision;
  authorityDigest: ArtifactDigest;
  manifestDigest: ArtifactDigest;
  suiteDigest: ArtifactDigest;
  workspaceDigest: ArtifactDigest;
  checks: readonly CompletionCheckResult[];
}>;

export type CompletionSuiteParseError = Readonly<{
  kind: "invalid-completion-suite";
  errors: NonEmpty<string>;
}>;

export type CompletionAuthorityFailure =
  | Readonly<{ kind: "invalid-result"; errors: NonEmpty<string> }>
  | Readonly<{ kind: "stale-result"; mismatchedFields: NonEmpty<CompletionAuthorityField> }>
  | Readonly<{ kind: "missing-check-results"; checkIds: NonEmpty<CompletionCheckId> }>
  | Readonly<{ kind: "surplus-check-results"; checkIds: NonEmpty<CompletionCheckId> }>
  | Readonly<{ kind: "duplicate-check-results"; checkIds: NonEmpty<CompletionCheckId> }>
  | Readonly<{ kind: "wrong-check-scope"; checkId: CompletionCheckId; actualScope: CompletionScope }>
  | Readonly<{
      kind: "report-policy-mismatch";
      checkId: CompletionCheckId;
      expected: ReportPolicy;
      actual: CompletionReportOutcome;
    }>;

export type CompletionAuthorityField =
  | "runId"
  | "wave"
  | "revision"
  | "authorityDigest"
  | "manifestDigest"
  | "suiteDigest"
  | "workspaceDigest";

export type CompletionInfrastructureFailure =
  | Readonly<{ kind: "spawn-failed"; checkId: CompletionCheckId; message: NonEmptyString }>
  | Readonly<{ kind: "incomplete-process-observation"; checkId: CompletionCheckId }>
  | Readonly<{
      kind: "report-unreadable";
      checkId: CompletionCheckId;
      path: ReviewPath;
      message: NonEmptyString;
    }>;

export type CompletionSemanticFailure =
  | Readonly<{ kind: "timed-out"; checkId: CompletionCheckId }>
  | Readonly<{ kind: "signal-termination"; checkId: CompletionCheckId; signal: CompletionSignal }>
  | Readonly<{ kind: "non-zero-exit"; checkId: CompletionCheckId; exitCode: number }>
  | Readonly<{ kind: "missing-report"; checkId: CompletionCheckId; path: ReviewPath }>;

export type AcceptedWaveCompletionReceipt = Readonly<{
  kind: "accepted-wave-completion-suite";
  runId: OrchestrationRunId;
  wave: WaveNumber;
  revision: RegistrationRevision;
  authorityDigest: ArtifactDigest;
  manifestDigest: ArtifactDigest;
  suiteDigest: ArtifactDigest;
  workspaceDigest: ArtifactDigest;
  checks: NonEmpty<CompletionCheckResult>;
  resultDigest: ArtifactDigest;
}>;

export type CompletionSuiteEvaluation =
  | Readonly<{ kind: "accepted"; receipt: AcceptedWaveCompletionReceipt }>
  | Readonly<{
      kind: "rejected";
      authorityFailures: readonly CompletionAuthorityFailure[];
      infrastructureFailures: readonly CompletionInfrastructureFailure[];
      semanticFailures: readonly CompletionSemanticFailure[];
    }>;

type Parsed<T> = DomainResult<T, CompletionSuiteParseError>;
type UnknownRecord = Record<string, unknown>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);
const success = <T>(value: T): Parsed<T> => freeze({ ok: true, value });
const failure = <T>(errors: readonly string[]): Parsed<T> => freeze({
  ok: false,
  error: freeze({
    kind: "invalid-completion-suite",
    errors: freezeArray(errors.length === 0 ? ["completion suite is invalid"] : errors) as NonEmpty<string>,
  }),
});

function total<T>(parse: () => Parsed<T>): Parsed<T> {
  try {
    return parse();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown parser failure";
    return failure([`completion suite input could not be inspected: ${message.slice(0, 256)}`]);
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

function collect<T>(results: readonly Parsed<T>[]): Parsed<readonly T[]> {
  const errors = results.flatMap((result) => result.ok ? [] : result.error.errors);
  return errors.length === 0
    ? success(freezeArray(results.map((result) => (result as { ok: true; value: T }).value)))
    : failure(errors);
}

function parseDigest(raw: unknown, path: string): Parsed<ArtifactDigest> {
  const parsed = parseArtifactDigest(raw);
  return parsed.ok ? success(parsed.value) : failure([`${path}: ${parsed.error.message}`]);
}

function parseRunId(raw: unknown, path: string): Parsed<OrchestrationRunId> {
  const parsed = parseOrchestrationRunId(raw);
  return parsed.ok ? success(parsed.value) : failure([`${path}: ${parsed.error.message}`]);
}

function parseWave(raw: unknown, path: string): Parsed<WaveNumber> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1
    ? success(raw as WaveNumber)
    : failure([`${path} must be a positive safe integer`]);
}

function parseRevision(raw: unknown, path: string): Parsed<RegistrationRevision> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? success(raw as RegistrationRevision)
    : failure([`${path} must be a non-negative safe integer`]);
}

function digest(value: JsonValue): ArtifactDigest {
  return sha256Hex(canonicalJson(value)) as ArtifactDigest;
}

export function parseCompletionCheckId(raw: unknown, path = "checkId"): Parsed<CompletionCheckId> {
  return total(() => typeof raw === "string" && CHECK_ID_PATTERN.test(raw)
    ? success(raw as CompletionCheckId)
    : failure([`${path} must be a non-empty canonical check id`]));
}

/** Parse one signal from the completion domain's closed portable allowlist. */
export function parseCompletionSignal(raw: unknown, path = "signal"): Parsed<CompletionSignal> {
  return total(() => typeof raw === "string" && COMPLETION_SIGNAL_SET.has(raw)
    ? success(raw as CompletionSignal)
    : failure([`${path} must be a recognized completion signal`]));
}

export function parseWaveNumber(raw: unknown, path = "wave"): Parsed<WaveNumber> {
  return total(() => parseWave(raw, path));
}

export function parseRegistrationRevision(
  raw: unknown,
  path = "revision",
): Parsed<RegistrationRevision> {
  return total(() => parseRevision(raw, path));
}

function parseWorkingDirectory(raw: unknown, path: string): Parsed<RepositoryRelativePath> {
  if (raw === ".") return success(".");
  const parsed = parseReviewPath(raw, path);
  return parsed.ok ? success(parsed.value) : failure(parsed.errors);
}

function parseReportPath(raw: unknown, path: string): Parsed<ReviewPath> {
  const parsed = parseReviewPath(raw, path);
  return parsed.ok ? success(parsed.value) : failure(parsed.errors);
}

const EXECUTABLE_TOKEN_PATTERN = /^[A-Za-z0-9@%_+=:,.-]+(?:\/[A-Za-z0-9@%_+=:,.-]+)*$/;
const PACKAGE_SCRIPT_SUBCOMMANDS = new Set(["build", "check", "run", "run-script", "test"]);
const DIRECT_TOOL_EXECUTABLES = new Set([
  "biome", "cargo", "cmake", "deno", "dotnet", "eslint", "gcc", "g++", "go", "gradle", "gradlew",
  "java", "javac", "jest", "make", "mvn", "mvnw", "ninja", "node", "npm", "perl", "pnpm", "pytest",
  "ruby", "rustc", "tsc", "vitest", "yarn",
]);
const PYTHON_EXECUTABLES = new Set([
  "python", "python3", "python3.10", "python3.11", "python3.12", "python3.13", "python3.14",
  "pypy3",
]);
const ALLOWED_EXECUTABLE_BASENAMES = new Set([
  ...DIRECT_TOOL_EXECUTABLES,
  ...PYTHON_EXECUTABLES,
  "bun",
]);
const PROJECT_SCRIPT_PATTERN = /^(?!-)(?:[A-Za-z0-9@%_+=:,.-]+\/)*[A-Za-z0-9@%_+=:,-]+\.(?:cjs|js|mjs|pl|py|rb|ts|tsx)$/;
const NODE_SCRIPT_EXTENSIONS = new Set(["cjs", "js", "mjs"]);
const BUN_SCRIPT_EXTENSIONS = new Set(["cjs", "js", "mjs", "ts", "tsx"]);
const PYTHON_SCRIPT_EXTENSIONS = new Set(["py"]);
const PERL_SCRIPT_EXTENSIONS = new Set(["pl"]);
const RUBY_SCRIPT_EXTENSIONS = new Set(["rb"]);
const PYTHON_MODULES = new Set(["compileall", "pytest", "unittest"]);

function executableBasename(executable: string): string {
  return executable.slice(executable.lastIndexOf("/") + 1).toLowerCase();
}

function isProjectScript(arg: string, extensions: ReadonlySet<string>): boolean {
  if (!PROJECT_SCRIPT_PATTERN.test(arg) || !parseReviewPath(arg, "runtime script").ok) return false;
  const extension = arg.slice(arg.lastIndexOf(".") + 1);
  return extensions.has(extension);
}

function packageScriptAllowed(args: readonly string[]): boolean {
  const subcommand = args[0];
  return subcommand !== undefined && PACKAGE_SCRIPT_SUBCOMMANDS.has(subcommand);
}

function runtimeInvocationAllowed(executable: string, args: readonly string[]): boolean {
  const first = args[0];
  if (first === undefined) return false;
  if (executable === "node") {
    const inlineOption = (arg: string): boolean =>
      arg === "-e" || arg === "-p" || /^-[^-]*[ep]/.test(arg) ||
      arg === "--eval" || arg.startsWith("--eval=") || arg === "--print" || arg.startsWith("--print=");
    return (first === "--test" && !args.slice(1).some(inlineOption)) ||
      (first === "--check" && args[1] !== undefined && isProjectScript(args[1], NODE_SCRIPT_EXTENSIONS)) ||
      isProjectScript(first, NODE_SCRIPT_EXTENSIONS);
  }
  if (executable === "bun") {
    return first === "build" || first === "run" || first === "test" ||
      isProjectScript(first, BUN_SCRIPT_EXTENSIONS);
  }
  if (executable === "deno") {
    return first === "check" || first === "run" || first === "task" || first === "test";
  }
  if (PYTHON_EXECUTABLES.has(executable)) {
    return isProjectScript(first, PYTHON_SCRIPT_EXTENSIONS) ||
      (first === "-m" && args[1] !== undefined && PYTHON_MODULES.has(args[1]));
  }
  if (executable === "perl") return isProjectScript(first, PERL_SCRIPT_EXTENSIONS);
  if (executable === "ruby") return isProjectScript(first, RUBY_SCRIPT_EXTENSIONS);
  return true;
}

function executablePolicyError(executable: string, args: readonly string[]): string | null {
  const basename = executableBasename(executable);
  if (!ALLOWED_EXECUTABLE_BASENAMES.has(basename)) {
    return `executable basename ${basename} is not in the verification tool allowlist`;
  }
  if (basename === "npm" || basename === "pnpm" || basename === "yarn") {
    return packageScriptAllowed(args)
      ? null
      : `${basename} must use an explicit run, test, check, or build script form`;
  }
  return runtimeInvocationAllowed(basename, args)
    ? null
    : `${basename} arguments do not select an allowed project script, test, check, build, or runtime mode`;
}

function parseExecutable(raw: unknown, path: string): Parsed<string> {
  if (typeof raw !== "string" || raw.length === 0 || raw === "." || raw === ".." ||
      !EXECUTABLE_TOKEN_PATTERN.test(raw)) {
    return failure([`${path} must be one canonical executable token without shell syntax`]);
  }
  if (raw.includes("/")) {
    const parsed = parseReviewPath(raw, path);
    if (!parsed.ok) return failure(parsed.errors);
  }
  return success(raw);
}

function parseArgs(raw: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(raw)) return failure([`${path} must be an array`]);
  const args: string[] = [];
  const errors: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (typeof arg === "string" && !arg.includes("\0")) args.push(arg);
    else errors.push(`${path}[${index}] must be a string without NUL`);
  }
  return errors.length === 0 ? success(freezeArray(args)) : failure(errors);
}

function parseTimeoutMs(raw: unknown, path: string): Parsed<CompletionTimeoutMs> {
  return typeof raw === "number" && Number.isSafeInteger(raw) &&
    raw >= MIN_COMPLETION_CHECK_TIMEOUT_MS && raw <= MAX_COMPLETION_CHECK_TIMEOUT_MS
    ? success(raw as CompletionTimeoutMs)
    : failure([
        `${path} must be an integer from ${MIN_COMPLETION_CHECK_TIMEOUT_MS} through ${MAX_COMPLETION_CHECK_TIMEOUT_MS}`,
      ]);
}

function parseReportPolicy(raw: unknown, path: string): Parsed<ReportPolicy> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "not-required") {
    const record = exactRecord(raw, ["kind"], path);
    return record.ok ? success(freeze({ kind: "not-required" })) : record;
  }
  if (raw.kind !== "required-file") {
    return failure([`${path}.kind must be not-required or required-file`]);
  }
  const record = exactRecord(raw, ["kind", "path"], path);
  if (!record.ok) return record;
  const reportPath = parseReportPath(record.value.path, `${path}.path`);
  return reportPath.ok
    ? success(freeze({ kind: "required-file", path: reportPath.value }))
    : reportPath;
}

function parseEngineAuthorizedCheck(raw: UnknownRecord, path: string): Parsed<AuthorizedWaveCompletionCheck> {
  const record = exactRecord(raw, ["kind", "checkId", "scope", "reportPolicy"], path);
  if (!record.ok) return record;
  const id = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const reportPolicy = parseReportPolicy(record.value.reportPolicy, `${path}.reportPolicy`);
  const errors = [id, reportPolicy].flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.scope !== "wave") errors.push(`${path}.scope must equal wave`);
  if (record.value.checkId !== FULL_TIER_LINT_CHECK_ID_TEXT) {
    errors.push(`${path}.checkId must equal ${FULL_TIER_LINT_CHECK_ID_TEXT} for the engine check`);
  }
  if (reportPolicy.ok && reportPolicy.value.kind !== "not-required") {
    errors.push(`${path}.reportPolicy.kind must equal not-required for the engine check`);
  }
  return errors.length === 0 && id.ok
    ? success(freeze({
        kind: "engine-full-tier-lint",
        checkId: id.value,
        scope: "wave",
        reportPolicy: freeze({ kind: "not-required" }),
      }))
    : failure(errors);
}

function parseProjectAuthorizedCheck(raw: UnknownRecord, path: string): Parsed<AuthorizedWaveCompletionCheck> {
  const record = exactRecord(raw, [
    "kind", "checkId", "scope", "executable", "args", "cwd", "timeoutMs", "reportPolicy",
  ], path);
  if (!record.ok) return record;
  const id = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const executable = parseExecutable(record.value.executable, `${path}.executable`);
  const args = parseArgs(record.value.args, `${path}.args`);
  const cwd = parseWorkingDirectory(record.value.cwd, `${path}.cwd`);
  const timeoutMs = parseTimeoutMs(record.value.timeoutMs, `${path}.timeoutMs`);
  const reportPolicy = parseReportPolicy(record.value.reportPolicy, `${path}.reportPolicy`);
  const parsed = [id, executable, args, cwd, timeoutMs, reportPolicy];
  const errors = parsed.flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.scope !== "wave") errors.push(`${path}.scope must equal wave`);
  if (typeof record.value.checkId === "string" && record.value.checkId.startsWith(RESERVED_CHECK_PREFIX)) {
    errors.push(`${path}.checkId uses the reserved ${RESERVED_CHECK_PREFIX} namespace`);
  }
  if (executable.ok && args.ok) {
    const policyError = executablePolicyError(executable.value, args.value);
    if (policyError !== null) errors.push(`${path}: ${policyError}`);
  }
  return errors.length === 0 && id.ok && executable.ok && args.ok && cwd.ok && timeoutMs.ok && reportPolicy.ok
    ? success(freeze({
        kind: "project-command",
        checkId: id.value,
        scope: "wave",
        executable: executable.value,
        args: args.value,
        cwd: cwd.value,
        timeoutMs: timeoutMs.value,
        reportPolicy: reportPolicy.value,
      }))
    : failure(errors);
}

function parseAuthorizedCheck(raw: unknown, path: string): Parsed<AuthorizedWaveCompletionCheck> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "engine-full-tier-lint") return parseEngineAuthorizedCheck(raw, path);
  return raw.kind === "project-command"
    ? parseProjectAuthorizedCheck(raw, path)
    : failure([`${path}.kind must be engine-full-tier-lint or project-command`]);
}

export function parseAuthorizedWaveCompletionCheck(
  raw: unknown,
  path = "check",
): Parsed<AuthorizedWaveCompletionCheck> {
  return total(() => parseAuthorizedCheck(raw, path));
}

function canonicalAuthorizedChecks(
  raw: unknown,
  path: string,
): Parsed<NonEmpty<AuthorizedWaveCompletionCheck>> {
  if (!Array.isArray(raw)) return failure([`${path} must be a non-empty array`]);
  if (raw.length === 0) return failure([`${path} must be non-empty`]);
  const parsed = collect(raw.map((check, index) => parseAuthorizedCheck(check, `${path}[${index}]`)));
  if (!parsed.ok) return parsed;
  const counts = new Map<string, number>();
  for (const check of parsed.value) counts.set(check.checkId, (counts.get(check.checkId) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(compareStrings);
  if (duplicates.length > 0) return failure([`${path} repeats check ids: ${duplicates.join(", ")}`]);
  if (!counts.has(FULL_TIER_LINT_CHECK_ID_TEXT)) {
    return failure([`${path} must contain the reserved ${FULL_TIER_LINT_CHECK_ID_TEXT} check`]);
  }
  return success(freezeArray([...parsed.value].sort((left, right) => compareStrings(left.checkId, right.checkId))) as NonEmpty<AuthorizedWaveCompletionCheck>);
}

function suiteDigestOf(checks: NonEmpty<AuthorizedWaveCompletionCheck>): ArtifactDigest {
  return digest({
    kind: "wave-completion-suite-roster",
    checks,
  });
}

/** Stable digest over the canonical authorized roster. */
export function completionSuiteDigest(
  rawChecks: unknown,
): Parsed<ArtifactDigest> {
  return total(() => {
    const checks = canonicalAuthorizedChecks(rawChecks, "checks");
    return checks.ok ? success(suiteDigestOf(checks.value)) : checks;
  });
}

type AuthorityParts = Omit<AuthorizedWaveCompletionSuite, "kind" | "suiteDigest">;

function parseAuthorityParts(raw: UnknownRecord, path: string): Parsed<AuthorityParts> {
  const runId = parseRunId(raw.runId, `${path}.runId`);
  const wave = parseWave(raw.wave, `${path}.wave`);
  const revision = parseRevision(raw.revision, `${path}.revision`);
  const authorityDigest = parseDigest(raw.authorityDigest, `${path}.authorityDigest`);
  const manifestDigest = parseDigest(raw.manifestDigest, `${path}.manifestDigest`);
  const workspaceDigest = parseDigest(raw.workspaceDigest, `${path}.workspaceDigest`);
  const checks = canonicalAuthorizedChecks(raw.checks, `${path}.checks`);
  const parsed = [runId, wave, revision, authorityDigest, manifestDigest, workspaceDigest, checks];
  const errors = parsed.flatMap((result) => result.ok ? [] : result.error.errors);
  if (errors.length > 0 || !runId.ok || !wave.ok || !revision.ok || !authorityDigest.ok ||
      !manifestDigest.ok || !workspaceDigest.ok || !checks.ok) return failure(errors);
  return success(freeze({
    runId: runId.value,
    wave: wave.value,
    revision: revision.value,
    authorityDigest: authorityDigest.value,
    manifestDigest: manifestDigest.value,
    workspaceDigest: workspaceDigest.value,
    checks: checks.value,
  }));
}

/** Mint non-empty canonical suite authority from exact unknown input. */
export function createAuthorizedWaveCompletionSuite(raw: unknown): Parsed<AuthorizedWaveCompletionSuite> {
  return total(() => {
    const record = exactRecord(raw, [
      "runId", "wave", "revision", "authorityDigest", "manifestDigest", "workspaceDigest", "checks",
    ], "authorizedSuiteInput");
    if (!record.ok) return record;
    const parts = parseAuthorityParts(record.value, "authorizedSuiteInput");
    return parts.ok
      ? success(freeze({
          kind: "authorized-wave-completion-suite",
          ...parts.value,
          suiteDigest: suiteDigestOf(parts.value.checks),
        }))
      : parts;
  });
}

/** Rehydrate persisted authority and verify its declared suite digest. */
export function parseAuthorizedWaveCompletionSuite(raw: unknown): Parsed<AuthorizedWaveCompletionSuite> {
  return total(() => {
    const record = exactRecord(raw, [
      "kind", "runId", "wave", "revision", "authorityDigest", "manifestDigest", "suiteDigest",
      "workspaceDigest", "checks",
    ], "authorizedSuite");
    if (!record.ok) return record;
    if (record.value.kind !== "authorized-wave-completion-suite") {
      return failure(["authorizedSuite.kind must equal authorized-wave-completion-suite"]);
    }
    const parts = parseAuthorityParts(record.value, "authorizedSuite");
    const declaredDigest = parseDigest(record.value.suiteDigest, "authorizedSuite.suiteDigest");
    const errors = [parts, declaredDigest].flatMap((result) => result.ok ? [] : result.error.errors);
    if (errors.length > 0 || !parts.ok || !declaredDigest.ok) return failure(errors);
    const expectedDigest = suiteDigestOf(parts.value.checks);
    if (declaredDigest.value !== expectedDigest) {
      return failure(["authorizedSuite.suiteDigest does not match its canonical checks"]);
    }
    return success(freeze({
      kind: "authorized-wave-completion-suite",
      ...parts.value,
      suiteDigest: expectedDigest,
    }));
  });
}

function parseReportOutcome(raw: unknown, path: string): Parsed<CompletionReportOutcome> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "not-required") {
    const record = exactRecord(raw, ["kind"], path);
    return record.ok ? success(freeze({ kind: "not-required" })) : record;
  }
  if (raw.kind === "missing") {
    const record = exactRecord(raw, ["kind", "path"], path);
    if (!record.ok) return record;
    const reportPath = parseReportPath(record.value.path, `${path}.path`);
    return reportPath.ok
      ? success(freeze({ kind: "missing", path: reportPath.value }))
      : reportPath;
  }
  if (raw.kind === "unreadable") {
    const record = exactRecord(raw, ["kind", "path", "message"], path);
    if (!record.ok) return record;
    const reportPath = parseReportPath(record.value.path, `${path}.path`);
    const errors = reportPath.ok ? [] : [...reportPath.error.errors];
    if (!(typeof record.value.message === "string" && record.value.message.trim().length > 0 &&
        record.value.message.length <= MAX_SPAWN_FAILURE_MESSAGE_LENGTH)) {
      errors.push(`${path}.message must be non-empty and at most ${MAX_SPAWN_FAILURE_MESSAGE_LENGTH} characters`);
    }
    return errors.length === 0 && reportPath.ok
      ? success(freeze({
          kind: "unreadable",
          path: reportPath.value,
          message: record.value.message as NonEmptyString,
        }))
      : failure(errors);
  }
  if (raw.kind !== "produced") {
    return failure([`${path}.kind must be not-required, produced, missing, or unreadable`]);
  }
  const record = exactRecord(raw, ["kind", "path", "digest", "byteLength"], path);
  if (!record.ok) return record;
  const reportPath = parseReportPath(record.value.path, `${path}.path`);
  const reportDigest = parseDigest(record.value.digest, `${path}.digest`);
  const errors = [reportPath, reportDigest].flatMap((result) => result.ok ? [] : result.error.errors);
  if (!(typeof record.value.byteLength === "number" && Number.isSafeInteger(record.value.byteLength) &&
      record.value.byteLength >= 0)) {
    errors.push(`${path}.byteLength must be a non-negative safe integer`);
  }
  return errors.length === 0 && reportPath.ok && reportDigest.ok
    ? success(freeze({
        kind: "produced",
        path: reportPath.value,
        digest: reportDigest.value,
        byteLength: record.value.byteLength as number,
      }))
    : failure(errors);
}

export function parseCompletionReportOutcome(
  raw: unknown,
  path = "report",
): Parsed<CompletionReportOutcome> {
  return total(() => parseReportOutcome(raw, path));
}

function parseOutcome(raw: unknown, path: string): Parsed<CompletionProcessOutcome> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "spawn-failed") {
    const record = exactRecord(raw, ["kind", "message"], path);
    if (!record.ok) return record;
    return typeof record.value.message === "string" && record.value.message.trim().length > 0 &&
      record.value.message.length <= MAX_SPAWN_FAILURE_MESSAGE_LENGTH
      ? success(freeze({ kind: "spawn-failed", message: record.value.message as NonEmptyString }))
      : failure([`${path}.message must be non-empty and at most ${MAX_SPAWN_FAILURE_MESSAGE_LENGTH} characters`]);
  }
  if (raw.kind !== "observed") return failure([`${path}.kind must be spawn-failed or observed`]);
  const record = exactRecord(raw, ["kind", "exitCode", "timedOut", "signal", "report"], path);
  if (!record.ok) return record;
  const report = parseReportOutcome(record.value.report, `${path}.report`);
  const signal: Parsed<CompletionSignal | null> = record.value.signal === null
    ? success(null)
    : parseCompletionSignal(record.value.signal, `${path}.signal`);
  const errors = [report, signal].flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.exitCode !== null &&
      !(typeof record.value.exitCode === "number" && Number.isSafeInteger(record.value.exitCode) && record.value.exitCode >= 0)) {
    errors.push(`${path}.exitCode must be null or a non-negative safe integer`);
  }
  if (typeof record.value.timedOut !== "boolean") errors.push(`${path}.timedOut must be a boolean`);
  return errors.length === 0 && report.ok && signal.ok
    ? success(freeze({
        kind: "observed",
        exitCode: record.value.exitCode as number | null,
        timedOut: record.value.timedOut as boolean,
        signal: signal.value,
        report: report.value,
      }))
    : failure(errors);
}

export function parseCompletionProcessOutcome(
  raw: unknown,
  path = "outcome",
): Parsed<CompletionProcessOutcome> {
  return total(() => parseOutcome(raw, path));
}

function parseCheckResult(raw: unknown, path: string): Parsed<CompletionCheckResult> {
  const record = exactRecord(raw, ["checkId", "scope", "outcome"], path);
  if (!record.ok) return record;
  const checkId = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const outcome = parseOutcome(record.value.outcome, `${path}.outcome`);
  const errors = [checkId, outcome].flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.scope !== "task" && record.value.scope !== "wave") {
    errors.push(`${path}.scope must be task or wave`);
  }
  return errors.length === 0 && checkId.ok && outcome.ok
    ? success(freeze({
        checkId: checkId.value,
        scope: record.value.scope as CompletionScope,
        outcome: outcome.value,
      }))
    : failure(errors);
}

export function parseCompletionCheckResult(raw: unknown, path = "result"): Parsed<CompletionCheckResult> {
  return total(() => parseCheckResult(raw, path));
}

function parseCheckResults(raw: unknown, path: string): Parsed<readonly CompletionCheckResult[]> {
  if (!Array.isArray(raw)) return failure([`${path} must be an array`]);
  const errors: string[] = [];
  const results: CompletionCheckResult[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      errors.push(`${path}[${index}] must be present`);
      continue;
    }
    const parsed = parseCheckResult(raw[index], `${path}[${index}]`);
    if (parsed.ok) results.push(parsed.value);
    else errors.push(...parsed.error.errors);
  }
  return errors.length === 0
    ? success(freezeArray(results.sort((left, right) => compareStrings(left.checkId, right.checkId))))
    : failure(errors);
}

function parseAcceptedChecks(raw: unknown, path: string): Parsed<NonEmpty<CompletionCheckResult>> {
  const parsed = parseCheckResults(raw, path);
  if (!parsed.ok) return parsed;
  const errors: string[] = [];
  if (parsed.value.length === 0) errors.push(`${path} must be non-empty`);
  const counts = new Map<string, number>();
  for (const check of parsed.value) {
    counts.set(check.checkId, (counts.get(check.checkId) ?? 0) + 1);
    if (check.scope !== "wave") errors.push(`${path} check ${check.checkId} must have wave scope`);
    if (check.outcome.kind !== "observed") {
      errors.push(`${path} check ${check.checkId} must have an observed successful outcome`);
      continue;
    }
    if (check.outcome.exitCode !== 0 || check.outcome.timedOut || check.outcome.signal !== null ||
        check.outcome.report.kind === "missing" || check.outcome.report.kind === "unreadable") {
      errors.push(`${path} check ${check.checkId} is not a successful completion result`);
    }
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([checkId]) => checkId)
    .sort(compareStrings);
  if (duplicates.length > 0) errors.push(`${path} repeats check ids: ${duplicates.join(", ")}`);
  if (!counts.has(FULL_TIER_LINT_CHECK_ID_TEXT)) {
    errors.push(`${path} must contain the reserved ${FULL_TIER_LINT_CHECK_ID_TEXT} check`);
  }
  return errors.length === 0
    ? success(parsed.value as NonEmpty<CompletionCheckResult>)
    : failure(errors);
}

type WaveCompletionEnvelope<Checks extends readonly CompletionCheckResult[], Extra extends object> =
  Readonly<{
    runId: OrchestrationRunId;
    wave: WaveNumber;
    revision: RegistrationRevision;
    authorityDigest: ArtifactDigest;
    manifestDigest: ArtifactDigest;
    suiteDigest: ArtifactDigest;
    workspaceDigest: ArtifactDigest;
    checks: Checks;
  }> & Readonly<Extra>;

type WaveCompletionEnvelopeContract<Checks extends readonly CompletionCheckResult[], Extra extends object> =
  Readonly<{
    path: string;
    expectedKind: "accepted-wave-completion-suite" | "wave-completion-suite-result";
    extraFields: readonly string[];
    parseChecks: (raw: unknown, path: string) => Parsed<Checks>;
    parseExtra: (record: UnknownRecord, path: string) => Parsed<Extra>;
  }>;

/** Parse the exact authority envelope shared by accepted receipts and observed results. */
function parseExactWaveCompletionEnvelope<
  Checks extends readonly CompletionCheckResult[],
  Extra extends object,
>(
  raw: unknown,
  contract: WaveCompletionEnvelopeContract<Checks, Extra>,
): Parsed<WaveCompletionEnvelope<Checks, Extra>> {
  const { path } = contract;
  const record = exactRecord(raw, [
    "kind", "runId", "wave", "revision", "authorityDigest", "manifestDigest", "suiteDigest",
    "workspaceDigest", "checks", ...contract.extraFields,
  ], path);
  if (!record.ok) return record;
  const runId = parseRunId(record.value.runId, `${path}.runId`);
  const wave = parseWave(record.value.wave, `${path}.wave`);
  const revision = parseRevision(record.value.revision, `${path}.revision`);
  const authorityDigest = parseDigest(record.value.authorityDigest, `${path}.authorityDigest`);
  const manifestDigest = parseDigest(record.value.manifestDigest, `${path}.manifestDigest`);
  const suiteDigest = parseDigest(record.value.suiteDigest, `${path}.suiteDigest`);
  const workspaceDigest = parseDigest(record.value.workspaceDigest, `${path}.workspaceDigest`);
  const checks = contract.parseChecks(record.value.checks, `${path}.checks`);
  const extra = contract.parseExtra(record.value, path);
  const parsed = [runId, wave, revision, authorityDigest, manifestDigest, suiteDigest, workspaceDigest, checks, extra];
  const errors = parsed.flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.kind !== contract.expectedKind) {
    errors.push(`${path}.kind must equal ${contract.expectedKind}`);
  }
  if (errors.length > 0 || !runId.ok || !wave.ok || !revision.ok || !authorityDigest.ok ||
      !manifestDigest.ok || !suiteDigest.ok || !workspaceDigest.ok || !checks.ok || !extra.ok) {
    return failure(errors);
  }
  return success(freeze({
    runId: runId.value,
    wave: wave.value,
    revision: revision.value,
    authorityDigest: authorityDigest.value,
    manifestDigest: manifestDigest.value,
    suiteDigest: suiteDigest.value,
    workspaceDigest: workspaceDigest.value,
    checks: checks.value,
    ...extra.value,
  }));
}

/** Rehydrate only a successful, non-empty, exact accepted roster with intact digest authority. */
export function parseAcceptedWaveCompletionReceipt(raw: unknown): Parsed<AcceptedWaveCompletionReceipt> {
  return total(() => {
    const envelope = parseExactWaveCompletionEnvelope(raw, {
      path: "acceptedReceipt",
      expectedKind: "accepted-wave-completion-suite",
      extraFields: ["resultDigest"],
      parseChecks: parseAcceptedChecks,
      parseExtra: (record, path) => {
        const resultDigest = parseDigest(record.resultDigest, `${path}.resultDigest`);
        return resultDigest.ok ? success(freeze({ resultDigest: resultDigest.value })) : resultDigest;
      },
    });
    if (!envelope.ok) return envelope;
    const { resultDigest, ...authority } = envelope.value;
    const body = freeze({ kind: "accepted-wave-completion-suite" as const, ...authority });
    const expectedDigest = digest(body);
    return resultDigest === expectedDigest
      ? success(freeze({ ...body, resultDigest: expectedDigest }))
      : failure(["acceptedReceipt.resultDigest does not match its canonical receipt"]);
  });
}

/** Parse unknown observed suite data. Roster exactness is evaluated against authority, not guessed here. */
export function parseWaveCompletionSuiteResult(raw: unknown): Parsed<WaveCompletionSuiteResult> {
  return total(() => {
    const envelope = parseExactWaveCompletionEnvelope(raw, {
      path: "suiteResult",
      expectedKind: "wave-completion-suite-result",
      extraFields: [],
      parseChecks: parseCheckResults,
      parseExtra: () => success(freeze({})),
    });
    return envelope.ok
      ? success(freeze({ kind: "wave-completion-suite-result", ...envelope.value }))
      : envelope;
  });
}

function rejected(
  authorityFailures: readonly CompletionAuthorityFailure[],
  infrastructureFailures: readonly CompletionInfrastructureFailure[] = [],
  semanticFailures: readonly CompletionSemanticFailure[] = [],
): CompletionSuiteEvaluation {
  return freeze({
    kind: "rejected",
    authorityFailures: freezeArray(authorityFailures),
    infrastructureFailures: freezeArray(infrastructureFailures),
    semanticFailures: freezeArray(semanticFailures),
  });
}

function asNonEmpty<T>(values: readonly T[]): NonEmpty<T> {
  return values as NonEmpty<T>;
}

function staleFields(
  authority: AuthorizedWaveCompletionSuite,
  result: WaveCompletionSuiteResult,
): readonly CompletionAuthorityField[] {
  const fields: readonly CompletionAuthorityField[] = [
    "runId", "wave", "revision", "authorityDigest", "manifestDigest", "suiteDigest", "workspaceDigest",
  ];
  return fields.filter((field) => authority[field] !== result[field]);
}

function acceptedReceipt(
  authority: AuthorizedWaveCompletionSuite,
  checks: NonEmpty<CompletionCheckResult>,
): AcceptedWaveCompletionReceipt {
  const body = freeze({
    kind: "accepted-wave-completion-suite" as const,
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks,
  });
  return freeze({ ...body, resultDigest: digest(body) });
}

/**
 * Evaluate one untrusted observed result against exact frozen Wave authority.
 * Authority failures never get reinterpreted as check failures. Once authority
 * matches, every independent process fact contributes its own typed failure.
 */
export function evaluateWaveCompletionSuite(
  rawAuthority: AuthorizedWaveCompletionSuite,
  rawResult: unknown,
): CompletionSuiteEvaluation {
  const authority = parseAuthorizedWaveCompletionSuite(rawAuthority);
  if (!authority.ok) {
    return rejected([freeze({ kind: "invalid-result", errors: authority.error.errors })]);
  }
  const result = parseWaveCompletionSuiteResult(rawResult);
  if (!result.ok) {
    return rejected([freeze({ kind: "invalid-result", errors: result.error.errors })]);
  }

  const stale = staleFields(authority.value, result.value);
  if (stale.length > 0) {
    return rejected([freeze({ kind: "stale-result", mismatchedFields: asNonEmpty(freezeArray(stale)) })]);
  }

  const expectedById = new Map(authority.value.checks.map((check) => [check.checkId, check]));
  const resultCounts = new Map<CompletionCheckId, number>();
  for (const check of result.value.checks) {
    resultCounts.set(check.checkId, (resultCounts.get(check.checkId) ?? 0) + 1);
  }
  const missing = authority.value.checks
    .filter((check) => !resultCounts.has(check.checkId))
    .map((check) => check.checkId);
  const surplus = [...resultCounts.keys()]
    .filter((checkId) => !expectedById.has(checkId))
    .sort(compareStrings);
  const duplicates = [...resultCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([checkId]) => checkId)
    .sort(compareStrings);
  const authorityFailures: CompletionAuthorityFailure[] = [];
  if (missing.length > 0) authorityFailures.push(freeze({ kind: "missing-check-results", checkIds: asNonEmpty(freezeArray(missing)) }));
  if (surplus.length > 0) authorityFailures.push(freeze({ kind: "surplus-check-results", checkIds: asNonEmpty(freezeArray(surplus)) }));
  if (duplicates.length > 0) authorityFailures.push(freeze({ kind: "duplicate-check-results", checkIds: asNonEmpty(freezeArray(duplicates)) }));
  for (const check of result.value.checks) {
    const expected = expectedById.get(check.checkId);
    if (expected !== undefined && check.scope !== "wave") {
      authorityFailures.push(freeze({ kind: "wrong-check-scope", checkId: check.checkId, actualScope: check.scope }));
    }
    if (expected !== undefined && check.outcome.kind === "observed") {
      const expectedReport = expected.reportPolicy;
      const actualReport = check.outcome.report;
      const matchesPolicy = expectedReport.kind === "not-required"
        ? actualReport.kind === "not-required"
        : actualReport.kind !== "not-required" && actualReport.path === expectedReport.path;
      if (!matchesPolicy) {
        authorityFailures.push(freeze({
          kind: "report-policy-mismatch",
          checkId: check.checkId,
          expected: expectedReport,
          actual: actualReport,
        }));
      }
    }
  }

  const infrastructureFailures: CompletionInfrastructureFailure[] = [];
  const semanticFailures: CompletionSemanticFailure[] = [];
  if (authorityFailures.length === 0) {
    for (const resultCheck of result.value.checks) {
      const expected = expectedById.get(resultCheck.checkId)!;
      match(resultCheck.outcome)
        .with({ kind: "spawn-failed" }, ({ message }) => {
          infrastructureFailures.push(freeze({ kind: "spawn-failed", checkId: resultCheck.checkId, message }));
        })
        .with({ kind: "observed" }, (outcome) => {
          if (outcome.timedOut) semanticFailures.push(freeze({ kind: "timed-out", checkId: resultCheck.checkId }));
          if (outcome.signal !== null) {
            semanticFailures.push(freeze({ kind: "signal-termination", checkId: resultCheck.checkId, signal: outcome.signal }));
          }
          if (outcome.exitCode !== null && outcome.exitCode !== 0) {
            semanticFailures.push(freeze({ kind: "non-zero-exit", checkId: resultCheck.checkId, exitCode: outcome.exitCode }));
          }
          if (outcome.exitCode === null && !outcome.timedOut && outcome.signal === null) {
            infrastructureFailures.push(freeze({ kind: "incomplete-process-observation", checkId: resultCheck.checkId }));
          }
          if (expected.reportPolicy.kind === "required-file" && outcome.report.kind === "missing") {
            semanticFailures.push(freeze({
              kind: "missing-report",
              checkId: resultCheck.checkId,
              path: expected.reportPolicy.path,
            }));
          }
          if (expected.reportPolicy.kind === "required-file" && outcome.report.kind === "unreadable") {
            infrastructureFailures.push(freeze({
              kind: "report-unreadable",
              checkId: resultCheck.checkId,
              path: expected.reportPolicy.path,
              message: outcome.report.message,
            }));
          }
        })
        .exhaustive();
    }
  }

  if (authorityFailures.length > 0 || infrastructureFailures.length > 0 || semanticFailures.length > 0) {
    return rejected(authorityFailures, infrastructureFailures, semanticFailures);
  }
  return freeze({
    kind: "accepted",
    receipt: acceptedReceipt(authority.value, asNonEmpty(result.value.checks)),
  });
}
