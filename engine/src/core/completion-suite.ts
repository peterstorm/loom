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
  type JsonValue,
  type ReviewPath,
} from "./review-packet";
import { sha256Hex } from "./digest";
import {
  acceptanceObservation,
  emptyAcceptanceExpectation,
  parseAcceptanceExpectation,
  parseAcceptanceReportFacts,
  recordedAcceptanceVerdict,
  type AcceptanceExpectation,
  type AcceptanceFailure,
  type AcceptanceObservation,
  type AcceptanceReportFacts,
} from "./acceptance-contract";
import { canonicalStructuralEquals } from "./orchestration-contract";
import {
  collectDenseArray,
  exactRecordErrors,
  isPlainRecord,
  parseExactRecord,
  toElementResult,
  type UnknownRecord,
} from "./plain-record";
import { verifiedMutationOf } from "./owner-verification/outcome";
import { ownerVerificationFailures } from "./owner-verification/verdict";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationOperator,
  MutationVerdict,
  OwnerInfrastructureFailure,
  OwnerInfrastructureFailureKind,
  OwnerVerificationFailure,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
} from "./owner-verification/types";

const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const RESERVED_CHECK_PREFIX = "loom:";
export const FULL_TIER_LINT_CHECK_ID_TEXT = "loom:full-tier-lint" as const;
/** The engine-reserved owner-verification check (G5b AD-1). */
export const OWNER_VERIFICATION_CHECK_ID_TEXT = "loom:owner-verification" as const;
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

/** The longest failure message a completion result may store; the at-rest parser refuses longer ones. */
export const MAX_FAILURE_MESSAGE_LENGTH = 4_096;
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
/** A storable failure message: not blank, and at most `MAX_FAILURE_MESSAGE_LENGTH`
 *  characters. Minted only by `parseFailureMessage` and `boundedFailureMessage`. */
export type FailureMessage = string & { readonly __failureMessage: true };

/** The one brand: every caller below has already proved the text non-blank and bounded. */
const asFailureMessage = (text: string): FailureMessage => text as FailureMessage;

const isStorableFailureMessage = (raw: unknown): raw is string =>
  typeof raw === "string" && raw.trim().length > 0 && raw.length <= MAX_FAILURE_MESSAGE_LENGTH;

/** A failure message as stored, or null when it is blank, too long, or not a string. */
export function parseFailureMessage(raw: unknown): FailureMessage | null {
  return isStorableFailureMessage(raw) ? asFailureMessage(raw) : null;
}

const UNSPECIFIED_FAILURE_MESSAGE = asFailureMessage("completion check failed without a message");

/**
 * Fit any text into a storable failure message: its first
 * `MAX_FAILURE_MESSAGE_LENGTH` characters, or `fallback` when that is blank.
 * Total: a blank fallback yields a fixed message, never an unstorable one.
 */
export function boundedFailureMessage(text: string, fallback: string): FailureMessage {
  return parseFailureMessage(text.slice(0, MAX_FAILURE_MESSAGE_LENGTH)) ??
    parseFailureMessage(fallback.slice(0, MAX_FAILURE_MESSAGE_LENGTH)) ??
    UNSPECIFIED_FAILURE_MESSAGE;
}

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
  | Readonly<{ kind: "unreadable"; path: ReviewPath; message: FailureMessage }>;
export type CompletionScope = "task" | "wave";

/**
 * The reserved checks are engine authority; project checks come from frozen
 * manifest authority. The owner-verification check exists only when suite
 * authorization was handed an owner check authority (a graph carrying the
 * `owner_obligations` stamp): it binds the stamp's digest and the ids of the
 * owned Invariants the Wave owes coverage and mutation for, in plan order,
 * possibly none.
 */
export type AuthorizedWaveCompletionCheck =
  | Readonly<{
      kind: "engine-full-tier-lint";
      checkId: CompletionCheckId;
      scope: "wave";
      reportPolicy: Readonly<{ kind: "not-required" }>;
    }>
  | Readonly<{
      kind: "engine-owner-verification";
      checkId: CompletionCheckId;
      scope: "wave";
      reportPolicy: Readonly<{ kind: "not-required" }>;
      obligationsDigest: ArtifactDigest;
      owed: readonly string[];
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
  | Readonly<{ kind: "spawn-failed"; message: FailureMessage }>
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
  acceptance?: AcceptanceObservation;
  /** Present exactly when the suite authorizes the owner-verification check. */
  ownerVerification?: OwnerVerificationObservation;
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
    }>
  /** The result was judged under a different acceptance expectation than the
   *  protected graph now derives for this gate. */
  | Readonly<{ kind: "acceptance-expectation-mismatch" }>
  /** Acceptance facts name a check whose produced report has another digest. */
  | Readonly<{ kind: "unbound-acceptance-facts"; checkIds: NonEmpty<string> }>
  /** The owner-verification observation is not the one the authorized owner
   *  check binds: absent, unauthorized, verified against other obligations or
   *  other Invariants, or contradicted by the check's own exit. */
  | Readonly<{ kind: "owner-verification-mismatch"; checkId: CompletionCheckId; reason: string }>;

/** An owner-verification finding that could not decide: never a kill, never a pass. */
export type OwnerInfrastructureFinding = Extract<OwnerVerificationFailure, { readonly kind: "infrastructure" }>;
/** An owner-verification finding the matrix test decided: missing siblings, a red baseline, a survivor. */
export type OwnerSemanticFinding = Exclude<OwnerVerificationFailure, { readonly kind: "infrastructure" }>;

export type CompletionAuthorityField =
  | "runId"
  | "wave"
  | "revision"
  | "authorityDigest"
  | "manifestDigest"
  | "suiteDigest"
  | "workspaceDigest";

export type CompletionInfrastructureFailure =
  | Readonly<{ kind: "spawn-failed"; checkId: CompletionCheckId; message: FailureMessage }>
  | Readonly<{ kind: "incomplete-process-observation"; checkId: CompletionCheckId }>
  | Readonly<{
      kind: "report-unreadable";
      checkId: CompletionCheckId;
      path: ReviewPath;
      message: FailureMessage;
    }>
  | Readonly<{ kind: "owner-verification-infrastructure"; checkId: CompletionCheckId; failures: NonEmpty<OwnerInfrastructureFinding> }>;

export type CompletionSemanticFailure =
  | Readonly<{ kind: "timed-out"; checkId: CompletionCheckId }>
  | Readonly<{ kind: "signal-termination"; checkId: CompletionCheckId; signal: CompletionSignal }>
  | Readonly<{ kind: "non-zero-exit"; checkId: CompletionCheckId; exitCode: number }>
  | Readonly<{ kind: "missing-report"; checkId: CompletionCheckId; path: ReviewPath }>
  | Readonly<{ kind: "acceptance-rejected"; checkId: CompletionCheckId; failures: NonEmpty<AcceptanceFailure> }>
  | Readonly<{ kind: "owner-verification-rejected"; checkId: CompletionCheckId; failures: NonEmpty<OwnerSemanticFinding> }>;

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
  acceptance?: AcceptanceObservation;
  /** The passing owner-verification observation, when the suite authorizes the check. */
  ownerVerification?: OwnerVerificationObservation;
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

function exactRecord(raw: unknown, fields: readonly string[], path: string): Parsed<UnknownRecord> {
  const record = parseExactRecord(raw, fields, path);
  return record.ok ? success(record.value) : failure(exactRecordErrors(record, path, "an object"));
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
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
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

/** Owed Invariant ids: non-blank, each once, in the authorized (plan) order. */
function parseOwedIds(raw: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(raw)) return failure([`${path} must be an array`]);
  const ids = collect(raw.map((id, index) => parseText(id, `${path}[${index}]`)));
  if (!ids.ok) return ids;
  return new Set(ids.value).size === ids.value.length ? ids : failure([`${path} names an Invariant more than once`]);
}

function parseOwnerAuthorizedCheck(raw: UnknownRecord, path: string): Parsed<AuthorizedWaveCompletionCheck> {
  const record = exactRecord(raw, ["kind", "checkId", "scope", "reportPolicy", "obligationsDigest", "owed"], path);
  if (!record.ok) return record;
  const id = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const reportPolicy = parseReportPolicy(record.value.reportPolicy, `${path}.reportPolicy`);
  const obligations = parseDigest(record.value.obligationsDigest, `${path}.obligationsDigest`);
  const owed = parseOwedIds(record.value.owed, `${path}.owed`);
  const errors = [id, reportPolicy, obligations, owed].flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.scope !== "wave") errors.push(`${path}.scope must equal wave`);
  if (record.value.checkId !== OWNER_VERIFICATION_CHECK_ID_TEXT) {
    errors.push(`${path}.checkId must equal ${OWNER_VERIFICATION_CHECK_ID_TEXT} for the owner check`);
  }
  if (reportPolicy.ok && reportPolicy.value.kind !== "not-required") {
    errors.push(`${path}.reportPolicy.kind must equal not-required for the owner check`);
  }
  return errors.length === 0 && id.ok && obligations.ok && owed.ok
    ? success(freeze({
        kind: "engine-owner-verification",
        checkId: id.value,
        scope: "wave",
        reportPolicy: freeze({ kind: "not-required" }),
        obligationsDigest: obligations.value,
        owed: owed.value,
      }))
    : failure(errors);
}

function parseAuthorizedCheck(raw: unknown, path: string): Parsed<AuthorizedWaveCompletionCheck> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "engine-full-tier-lint") return parseEngineAuthorizedCheck(raw, path);
  if (raw.kind === "engine-owner-verification") return parseOwnerAuthorizedCheck(raw, path);
  return raw.kind === "project-command"
    ? parseProjectAuthorizedCheck(raw, path)
    : failure([`${path}.kind must be engine-full-tier-lint, engine-owner-verification or project-command`]);
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
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
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
    const message = parseFailureMessage(record.value.message);
    const errors = reportPath.ok ? [] : [...reportPath.error.errors];
    if (message === null) {
      errors.push(`${path}.message must be non-empty and at most ${MAX_FAILURE_MESSAGE_LENGTH} characters`);
    }
    return errors.length === 0 && reportPath.ok && message !== null
      ? success(freeze({ kind: "unreadable", path: reportPath.value, message }))
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
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "spawn-failed") {
    const record = exactRecord(raw, ["kind", "message"], path);
    if (!record.ok) return record;
    const message = parseFailureMessage(record.value.message);
    return message !== null
      ? success(freeze({ kind: "spawn-failed", message }))
      : failure([`${path}.message must be non-empty and at most ${MAX_FAILURE_MESSAGE_LENGTH} characters`]);
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
  const results = collectDenseArray(raw, path, (value, elementPath) =>
    toElementResult(parseCheckResult(value, elementPath)));
  if (results.kind === "not-array") return failure([`${path} must be an array`]);
  return results.errors.length === 0
    ? success(freezeArray([...results.values].sort((left, right) => compareStrings(left.checkId, right.checkId))))
    : failure(results.errors);
}

// ---------------------------------------------------------------------------
// The owner-verification observation (G5b AD-1), as results and receipts
// carry it. Each parser rebuilds the value in its canonical shape; a verified
// mutation run is minted only through `verifiedMutationOf`, so its counts
// agree wherever it is read back.
// ---------------------------------------------------------------------------

/** Every infrastructure kind the owner check names; the record keeps the set exhaustive. */
const OWNER_INFRASTRUCTURE_KINDS = {
  "plan-unreadable": true, "plan-malformed": true, "plan-drift": true, "runner-missing": true,
  "worktree-failed": true, "spawn-failed": true, "report-missing": true, "report-unreadable": true,
  "matrix-test-not-collected": true, "exit-unexplained-by-report": true, "baseline-timed-out": true,
  "missing-wave-base": true, "coverage-bound-exceeded": true, "real-workspace-changed": true,
  "repository-file-unreadable": true, "unexpected-error": true,
} as const satisfies Record<OwnerInfrastructureFailureKind, true>;

/** The fixed mutation operators; the record keeps the set exhaustive. */
const MUTATION_OPERATORS = {
  "condition-negation": true, "comparison-flip": true, "logical-swap": true,
  "boolean-literal-flip": true, "return-value-replacement": true, "statement-removal": true,
} as const satisfies Record<MutationOperator, true>;

const isKey = <K extends string>(keys: Readonly<Record<K, true>>, raw: unknown): raw is K =>
  typeof raw === "string" && Object.hasOwn(keys, raw);

function parseText(raw: unknown, path: string): Parsed<string> {
  return typeof raw === "string" && raw.trim().length > 0 ? success(raw) : failure([`${path} must be a non-blank string`]);
}

function parseTexts(raw: unknown, path: string): Parsed<NonEmpty<string>> {
  if (!Array.isArray(raw) || raw.length === 0) return failure([`${path} must be a non-empty array`]);
  const texts = collect(raw.map((entry, index) => parseText(entry, `${path}[${index}]`)));
  return texts.ok ? success(texts.value as NonEmpty<string>) : texts;
}

function parseCount(raw: unknown, path: string): Parsed<number> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? success(raw)
    : failure([`${path} must be a non-negative safe integer`]);
}

function parseOwnerInfrastructureFailure(raw: unknown, path: string): Parsed<OwnerInfrastructureFailure> {
  const record = exactRecord(raw, ["kind", "detail"], path);
  if (!record.ok) return record;
  const detail = parseText(record.value.detail, `${path}.detail`);
  if (!isKey(OWNER_INFRASTRUCTURE_KINDS, record.value.kind)) {
    return failure([`${path}.kind must be an owner-verification infrastructure kind`, ...(detail.ok ? [] : detail.error.errors)]);
  }
  return detail.ok ? success(freeze({ kind: record.value.kind, detail: detail.value })) : detail;
}

/** A `{ kind, <field> }` variant whose one field the given parser reads. */
function parseTagged<T, V extends object>(
  raw: UnknownRecord,
  path: string,
  field: string,
  parse: (raw: unknown, path: string) => Parsed<T>,
  build: (value: T) => V,
): Parsed<V> {
  const record = exactRecord(raw, ["kind", field], path);
  if (!record.ok) return record;
  const parsed = parse(record.value[field], `${path}.${field}`);
  return parsed.ok ? success(freeze(build(parsed.value))) : parsed;
}

function parseCoverageVerdict(raw: unknown, path: string): Parsed<CoverageVerdict> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "covered") {
    const record = exactRecord(raw, ["kind"], path);
    return record.ok ? success(freeze({ kind: "covered" })) : record;
  }
  if (raw.kind === "missing") return parseTagged(raw, path, "paths", parseTexts, (paths): CoverageVerdict => ({ kind: "missing", paths }));
  return raw.kind === "infrastructure"
    ? parseTagged(raw, path, "failure", parseOwnerInfrastructureFailure, (failure): CoverageVerdict => ({ kind: "infrastructure", failure }))
    : failure([`${path}.kind must be covered, missing or infrastructure`]);
}

function parseSurvivor(raw: unknown, path: string): Parsed<SurvivorDiagnostic> {
  const record = exactRecord(raw, ["mutantId", "operator", "line", "column", "original", "replacement"], path);
  if (!record.ok) return record;
  const { mutantId, operator, line, column, original, replacement } = record.value;
  const id = parseText(mutantId, `${path}.mutantId`);
  const errors = id.ok ? [] : [...id.error.errors];
  if (!isKey(MUTATION_OPERATORS, operator)) errors.push(`${path}.operator must be one of the fixed mutation operators`);
  for (const [name, position] of [["line", line], ["column", column]] as const) {
    if (!(typeof position === "number" && Number.isSafeInteger(position) && position >= 1)) errors.push(`${path}.${name} must be a positive integer`);
  }
  if (typeof original !== "string" || typeof replacement !== "string") errors.push(`${path}.original and .replacement must be strings`);
  return errors.length === 0 && id.ok && isKey(MUTATION_OPERATORS, operator)
    ? success(freeze({
        mutantId: id.value, operator, line: line as number, column: column as number,
        original: original as string, replacement: replacement as string,
      }))
    : failure(errors);
}

const VERIFIED_MUTATION_FIELDS = ["kind", "generated", "killed", "timedOut", "invalid", "survivors", "unmutated", "ownerChangedInWave"] as const;

/** A verified run, re-minted through its one constructor: `generated` must be the count its tallies derive. */
function parseVerifiedMutation(raw: unknown, path: string): Parsed<MutationVerdict> {
  const record = exactRecord(raw, VERIFIED_MUTATION_FIELDS, path);
  if (!record.ok) return record;
  const counts = collect((["generated", "killed", "timedOut", "invalid", "unmutated"] as const)
    .map((field) => parseCount(record.value[field], `${path}.${field}`)));
  const survivors = collectDenseArray(record.value.survivors, `${path}.survivors`, (entry, entryPath) =>
    toElementResult(parseSurvivor(entry, entryPath)));
  const errors = counts.ok ? [] : [...counts.error.errors];
  if (survivors.kind === "not-array") errors.push(`${path}.survivors must be an array`);
  else errors.push(...survivors.errors);
  if (typeof record.value.ownerChangedInWave !== "boolean") errors.push(`${path}.ownerChangedInWave must be a boolean`);
  if (errors.length > 0 || !counts.ok || survivors.kind === "not-array") return failure(errors);
  const [generated, killed, timedOut, invalid, unmutated] = counts.value as readonly number[];
  const built = verifiedMutationOf({
    killed: killed!, timedOut: timedOut!, invalid: invalid!, survivors: freezeArray(survivors.values),
    unmutated: unmutated!, ownerChangedInWave: record.value.ownerChangedInWave as boolean,
  });
  if (!built.ok) return failure([`${path} is not a verified mutation run: ${built.error.kind}`]);
  return built.value.generated === generated ? success(built.value) : failure([`${path}.generated must equal the mutants its tallies count`]);
}

function parseMutationVerdict(raw: unknown, path: string): Parsed<MutationVerdict> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  return match(raw.kind)
    .with("exempt", () => parseTagged(raw, path, "reason", parseText, (reason): MutationVerdict => ({ kind: "exempt", reason })))
    .with("red-baseline", () => parseTagged(raw, path, "failures", parseTexts, (failures): MutationVerdict => ({ kind: "red-baseline", failures })))
    .with("infrastructure", () => parseTagged(raw, path, "failure", parseOwnerInfrastructureFailure, (failure): MutationVerdict => ({ kind: "infrastructure", failure })))
    .with("verified", () => parseVerifiedMutation(raw, path))
    .otherwise(() => failure([`${path}.kind must be exempt, red-baseline, verified or infrastructure`]));
}

function parseInvariantVerdict(raw: unknown, path: string): Parsed<InvariantVerdict> {
  const record = exactRecord(raw, ["invariant", "title", "owner", "matrixTest", "coverage", "mutation"], path);
  if (!record.ok) return record;
  const [invariant, title, owner, matrixTest] = (["invariant", "title", "owner", "matrixTest"] as const)
    .map((field) => parseText(record.value[field], `${path}.${field}`));
  const coverage = parseCoverageVerdict(record.value.coverage, `${path}.coverage`);
  const mutation = parseMutationVerdict(record.value.mutation, `${path}.mutation`);
  const parsed = [invariant!, title!, owner!, matrixTest!, coverage, mutation];
  const errors = parsed.flatMap((result) => result.ok ? [] : result.error.errors);
  return errors.length === 0 && invariant!.ok && title!.ok && owner!.ok && matrixTest!.ok && coverage.ok && mutation.ok
    ? success(freeze({
        invariant: invariant!.value, title: title!.value, owner: owner!.value, matrixTest: matrixTest!.value,
        coverage: coverage.value, mutation: mutation.value,
      }))
    : failure(errors);
}

function parseVerifiedObservation(raw: UnknownRecord, path: string): Parsed<OwnerVerificationObservation> {
  const record = exactRecord(raw, ["kind", "obligationsDigest", "boundMs", "verdicts"], path);
  if (!record.ok) return record;
  const obligations = parseDigest(record.value.obligationsDigest, `${path}.obligationsDigest`);
  const boundMs = parseCount(record.value.boundMs, `${path}.boundMs`);
  const verdicts = collectDenseArray(record.value.verdicts, `${path}.verdicts`, (entry, entryPath) =>
    toElementResult(parseInvariantVerdict(entry, entryPath)));
  const errors = [obligations, boundMs].flatMap((result) => result.ok ? [] : result.error.errors);
  if (verdicts.kind === "not-array") errors.push(`${path}.verdicts must be an array`);
  else errors.push(...verdicts.errors);
  if (errors.length > 0 || !obligations.ok || !boundMs.ok || verdicts.kind === "not-array") return failure(errors);
  const ids = verdicts.values.map(({ invariant }) => invariant);
  if (new Set(ids).size !== ids.length) return failure([`${path}.verdicts names an Invariant more than once`]);
  return success(freeze({
    kind: "verified", obligationsDigest: obligations.value, boundMs: boundMs.value, verdicts: freezeArray(verdicts.values),
  }));
}

function parseOwnerVerificationObservation(raw: unknown, path: string): Parsed<OwnerVerificationObservation> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "verified") return parseVerifiedObservation(raw, path);
  return raw.kind === "unavailable"
    ? parseTagged(raw, path, "failure", parseOwnerInfrastructureFailure, (failure): OwnerVerificationObservation => ({ kind: "unavailable", failure }))
    : failure([`${path}.kind must be verified or unavailable`]);
}

/** The optional `ownerVerification` field of a result or receipt envelope. */
function parseOptionalOwnerVerification(raw: unknown, path: string): Parsed<OwnerVerificationObservation | undefined> {
  return isPlainRecord(raw) && Object.hasOwn(raw, "ownerVerification")
    ? parseOwnerVerificationObservation(raw.ownerVerification, `${path}.ownerVerification`)
    : success(undefined);
}

/** Parse the persisted acceptance observation: an exact expectation and one
 *  facts record per check, at most. */
function parseAcceptanceObservation(raw: unknown, path: string): Parsed<AcceptanceObservation> {
  const record = exactRecord(raw, ["expectation", "facts"], path);
  if (!record.ok) return record;
  const expectation = parseAcceptanceExpectation(record.value.expectation, `${path}.expectation`);
  if (!expectation.ok) return failure([expectation.error]);
  if (!Array.isArray(record.value.facts)) return failure([`${path}.facts must be an array`]);
  const facts: AcceptanceReportFacts[] = [];
  for (const [index, entry] of record.value.facts.entries()) {
    const parsed = parseAcceptanceReportFacts(entry, `${path}.facts[${index}]`);
    if (!parsed.ok) return failure([parsed.error]);
    facts.push(parsed.value);
  }
  const checkIds = facts.map(({ checkId }) => checkId);
  if (new Set(checkIds).size !== checkIds.length) return failure([`${path}.facts names a check more than once`]);
  const observation = acceptanceObservation(expectation.value, facts);
  return observation === undefined
    ? failure([`${path} must be absent when the gate owes no contract anything`])
    : success(observation);
}

/** The optional `acceptance` field of a result or receipt envelope. */
function parseOptionalAcceptance(raw: unknown, path: string): Parsed<AcceptanceObservation | undefined> {
  return isPlainRecord(raw) && Object.hasOwn(raw, "acceptance")
    ? parseAcceptanceObservation(raw.acceptance, `${path}.acceptance`)
    : success(undefined);
}

/** Facts whose check produced no report with the digest the facts were read from. */
function unboundFactChecks(
  checks: readonly CompletionCheckResult[],
  facts: readonly AcceptanceReportFacts[],
): readonly string[] {
  return facts.flatMap(({ checkId, reportDigest }) => {
    const check = checks.find((candidate) => candidate.checkId === checkId);
    const report = check?.outcome.kind === "observed" ? check.outcome.report : null;
    return report?.kind === "produced" && report.digest === reportDigest ? [] : [checkId];
  });
}

function parseAcceptedChecks(
  raw: unknown,
  path: string,
  excused: ReadonlySet<string>,
): Parsed<NonEmpty<CompletionCheckResult>> {
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
    const exitAccepted = check.outcome.exitCode === 0 || (check.outcome.exitCode !== null && excused.has(check.checkId));
    if (!exitAccepted || check.outcome.timedOut || check.outcome.signal !== null ||
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

/** `acceptance` and `ownerVerification` join the exact field set only when
 *  present: results and receipts written before contracts or owner
 *  verification existed carry no such field. */
const optionalEnvelopeFields = (raw: unknown): readonly string[] =>
  isPlainRecord(raw) ? ["acceptance", "ownerVerification"].filter((field) => Object.hasOwn(raw, field)) : [];

/** The observed optional observations, spread only when present. */
const optionalObservations = (
  acceptance: AcceptanceObservation | undefined,
  ownerVerification: OwnerVerificationObservation | undefined,
) => ({
  ...(acceptance === undefined ? {} : { acceptance }),
  ...(ownerVerification === undefined ? {} : { ownerVerification }),
});

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
    "workspaceDigest", "checks", ...contract.extraFields, ...optionalEnvelopeFields(raw),
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

/**
 * Rehydrate only a successful, non-empty, exact accepted roster with intact
 * digest authority. A non-zero exit is successful only when the receipt's own
 * acceptance observation excuses it — the receipt proves itself, so no reader
 * has to trust the evaluator that minted it.
 */
export function parseAcceptedWaveCompletionReceipt(raw: unknown): Parsed<AcceptedWaveCompletionReceipt> {
  return total(() => {
    const acceptance = parseOptionalAcceptance(raw, "acceptedReceipt");
    if (!acceptance.ok) return acceptance;
    const ownerVerification = parseOptionalOwnerVerification(raw, "acceptedReceipt");
    if (!ownerVerification.ok) return ownerVerification;
    if (ownerVerification.value !== undefined && ownerVerificationFailures(ownerVerification.value).length > 0) {
      return failure(["acceptedReceipt.ownerVerification records findings an accepted receipt cannot carry"]);
    }
    // The receipt proves itself: its own recorded observation decides which
    // non-zero exits are excused and whether it carries failures it could
    // never have been accepted with.
    const verdict = recordedAcceptanceVerdict(acceptance.value);
    const envelope = parseExactWaveCompletionEnvelope(raw, {
      path: "acceptedReceipt",
      expectedKind: "accepted-wave-completion-suite",
      extraFields: ["resultDigest"],
      parseChecks: (checks, path) => parseAcceptedChecks(checks, path, verdict.excused),
      parseExtra: (record, path) => {
        const resultDigest = parseDigest(record.resultDigest, `${path}.resultDigest`);
        return resultDigest.ok
          ? success(freeze({
              resultDigest: resultDigest.value,
              ...optionalObservations(acceptance.value, ownerVerification.value),
            }))
          : resultDigest;
      },
    });
    if (!envelope.ok) return envelope;
    if (acceptance.value !== undefined) {
      const unbound = unboundFactChecks(envelope.value.checks, acceptance.value.facts);
      if (unbound.length > 0) return failure([`acceptedReceipt.acceptance facts are unbound for ${unbound.join(", ")}`]);
      if (verdict.failures.length > 0) {
        return failure(["acceptedReceipt.acceptance records failures an accepted receipt cannot carry"]);
      }
    }
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
      parseExtra: () => {
        const acceptance = parseOptionalAcceptance(raw, "suiteResult");
        if (!acceptance.ok) return acceptance;
        const ownerVerification = parseOptionalOwnerVerification(raw, "suiteResult");
        if (!ownerVerification.ok) return ownerVerification;
        return success(freeze(optionalObservations(acceptance.value, ownerVerification.value)));
      },
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
  result: WaveCompletionSuiteResult,
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
    checks: asNonEmpty(result.checks),
    ...optionalObservations(result.acceptance, result.ownerVerification),
  });
  return freeze({ ...body, resultDigest: digest(body) });
}

export type OwnerVerificationCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "engine-owner-verification" }>;

/** The suite's owner-verification check, when its authorization was handed an owner check authority. */
export const ownerCheckOf = (authority: AuthorizedWaveCompletionSuite): OwnerVerificationCheck | undefined =>
  authority.checks.find((check): check is OwnerVerificationCheck => check.kind === "engine-owner-verification");

/** The owner check exits 1 exactly when its observation carries a blocking finding, as the reserved lint check does. */
export const ownerVerificationExitCode = (observation: OwnerVerificationObservation): 0 | 1 =>
  ownerVerificationFailures(observation).length > 0 ? 1 : 0;

/** Why the observation is not the one the authorized owner check binds, or null when it is. */
function ownerVerificationMismatch(check: OwnerVerificationCheck | undefined, result: WaveCompletionSuiteResult): string | null {
  const observation = result.ownerVerification;
  if (check === undefined) {
    return observation === undefined ? null : "the result carries an owner-verification observation its suite does not authorize";
  }
  if (observation === undefined) return "the authorized owner check has no owner-verification observation";
  const outcome = result.checks.find(({ checkId }) => checkId === check.checkId)?.outcome;
  const exit = ownerVerificationExitCode(observation);
  if (outcome?.kind === "observed" && (outcome.exitCode !== exit || outcome.timedOut || outcome.signal !== null)) {
    return `the owner check's observed exit ${String(outcome.exitCode)} contradicts its findings, which require exit ${exit}`;
  }
  if (observation.kind === "unavailable") return null;
  if (observation.obligationsDigest !== check.obligationsDigest) {
    return `owner verification ran against obligations ${observation.obligationsDigest}, but the suite authorizes ${check.obligationsDigest}`;
  }
  const verdictIds = observation.verdicts.map(({ invariant }) => invariant);
  return canonicalStructuralEquals(verdictIds, check.owed)
    ? null
    : `owner verification judged [${verdictIds.join(", ")}], but the suite owes [${check.owed.join(", ")}]`;
}

type ProcessFailures = Readonly<{
  infrastructure: readonly CompletionInfrastructureFailure[];
  semantic: readonly CompletionSemanticFailure[];
}>;

/** The owner check's findings, split into what the matrix test decided and what could not decide. */
function ownerVerificationProcessFailures(
  check: OwnerVerificationCheck | undefined,
  observation: OwnerVerificationObservation | undefined,
): ProcessFailures {
  if (check === undefined || observation === undefined) return { infrastructure: [], semantic: [] };
  const findings = ownerVerificationFailures(observation);
  const undecided = findings.filter((finding): finding is OwnerInfrastructureFinding => finding.kind === "infrastructure");
  const decided = findings.filter((finding): finding is OwnerSemanticFinding => finding.kind !== "infrastructure");
  return {
    infrastructure: undecided.length === 0 ? [] : [freeze({
      kind: "owner-verification-infrastructure", checkId: check.checkId, failures: asNonEmpty(freezeArray(undecided)),
    })],
    semantic: decided.length === 0 ? [] : [freeze({
      kind: "owner-verification-rejected", checkId: check.checkId, failures: asNonEmpty(freezeArray(decided)),
    })],
  };
}

/** The check an acceptance rejection is reported against: the first whose
 *  report was observed, else the first that must write one. */
function acceptanceCheckId(
  authority: AuthorizedWaveCompletionSuite,
  facts: readonly AcceptanceReportFacts[],
): CompletionCheckId {
  const observed = authority.checks.find(({ checkId }) => facts.some((fact) => fact.checkId === checkId));
  const reporting = authority.checks.find(({ reportPolicy }) => reportPolicy.kind === "required-file");
  return (observed ?? reporting ?? authority.checks[0]).checkId;
}

/**
 * Evaluate one untrusted observed result against exact frozen Wave authority.
 * Authority failures never get reinterpreted as check failures. Once authority
 * matches, every independent process fact contributes its own typed failure.
 *
 * Acceptance: the result must have been judged under exactly the expectation
 * the protected graph derives for this gate, and its facts must be bound to
 * the very reports the checks produced. A check's non-zero exit is excused
 * only when its report's failures are all RED or pending acceptance testcases
 * (report-derived — see `judgeAcceptance`); any acceptance failure rejects.
 */
export function evaluateWaveCompletionSuite(
  rawAuthority: AuthorizedWaveCompletionSuite,
  rawResult: unknown,
  expectation: AcceptanceExpectation,
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

  const authorityFailures = [
    ...rosterAuthorityFailures(authority.value, result.value),
    ...observationAuthorityFailures(authority.value, result.value, expectation),
  ];
  if (authorityFailures.length > 0) return rejected(authorityFailures);

  const verdict = recordedAcceptanceVerdict(result.value.acceptance);
  const checks = checkProcessFailures(authority.value, result.value, verdict.excused);
  const owner = ownerVerificationProcessFailures(ownerCheckOf(authority.value), result.value.ownerVerification);
  const acceptance: readonly CompletionSemanticFailure[] = verdict.failures.length === 0 ? [] : [freeze({
    kind: "acceptance-rejected",
    checkId: acceptanceCheckId(authority.value, result.value.acceptance?.facts ?? []),
    failures: asNonEmpty(freezeArray(verdict.failures)),
  })];
  const infrastructureFailures = [...checks.infrastructure, ...owner.infrastructure];
  const semanticFailures = [...checks.semantic, ...acceptance, ...owner.semantic];
  if (infrastructureFailures.length > 0 || semanticFailures.length > 0) {
    return rejected([], infrastructureFailures, semanticFailures);
  }
  return freeze({ kind: "accepted", receipt: acceptedReceipt(authority.value, result.value) });
}

/** The result's roster against the authorized roster: missing, surplus, duplicate, wrong-scope or mispoliced checks. */
function rosterAuthorityFailures(
  authority: AuthorizedWaveCompletionSuite,
  result: WaveCompletionSuiteResult,
): readonly CompletionAuthorityFailure[] {
  const expectedById = new Map(authority.checks.map((check) => [check.checkId, check]));
  const resultCounts = new Map<CompletionCheckId, number>();
  for (const check of result.checks) resultCounts.set(check.checkId, (resultCounts.get(check.checkId) ?? 0) + 1);
  const missing = authority.checks.filter((check) => !resultCounts.has(check.checkId)).map((check) => check.checkId);
  const surplus = [...resultCounts.keys()].filter((checkId) => !expectedById.has(checkId)).sort(compareStrings);
  const duplicates = [...resultCounts.entries()].filter(([, count]) => count > 1).map(([checkId]) => checkId).sort(compareStrings);
  const failures: CompletionAuthorityFailure[] = [];
  if (missing.length > 0) failures.push(freeze({ kind: "missing-check-results", checkIds: asNonEmpty(freezeArray(missing)) }));
  if (surplus.length > 0) failures.push(freeze({ kind: "surplus-check-results", checkIds: asNonEmpty(freezeArray(surplus)) }));
  if (duplicates.length > 0) failures.push(freeze({ kind: "duplicate-check-results", checkIds: asNonEmpty(freezeArray(duplicates)) }));
  for (const check of result.checks) {
    const expected = expectedById.get(check.checkId);
    if (expected === undefined) continue;
    if (check.scope !== "wave") failures.push(freeze({ kind: "wrong-check-scope", checkId: check.checkId, actualScope: check.scope }));
    if (check.outcome.kind !== "observed") continue;
    const expectedReport = expected.reportPolicy;
    const actualReport = check.outcome.report;
    const matchesPolicy = expectedReport.kind === "not-required"
      ? actualReport.kind === "not-required"
      : actualReport.kind !== "not-required" && actualReport.path === expectedReport.path;
    if (!matchesPolicy) {
      failures.push(freeze({ kind: "report-policy-mismatch", checkId: check.checkId, expected: expectedReport, actual: actualReport }));
    }
  }
  return failures;
}

/** The recorded observations against the authority that judges them: the acceptance expectation and facts, and the owner check. */
function observationAuthorityFailures(
  authority: AuthorizedWaveCompletionSuite,
  result: WaveCompletionSuiteResult,
  expectation: AcceptanceExpectation,
): readonly CompletionAuthorityFailure[] {
  const recorded = result.acceptance;
  const failures: CompletionAuthorityFailure[] = [];
  if (!canonicalStructuralEquals(expectation, recorded?.expectation ?? emptyAcceptanceExpectation(result.wave))) {
    failures.push(freeze({ kind: "acceptance-expectation-mismatch" }));
  }
  const unbound = unboundFactChecks(result.checks, recorded?.facts ?? []);
  if (unbound.length > 0) failures.push(freeze({ kind: "unbound-acceptance-facts", checkIds: asNonEmpty(freezeArray(unbound)) }));
  const ownerCheck = ownerCheckOf(authority);
  const mismatch = ownerVerificationMismatch(ownerCheck, result);
  if (mismatch !== null) {
    failures.push(freeze({
      kind: "owner-verification-mismatch",
      checkId: ownerCheck?.checkId ?? (OWNER_VERIFICATION_CHECK_ID_TEXT as CompletionCheckId),
      reason: mismatch,
    }));
  }
  return failures;
}

/**
 * Every process fact of every check, each its own typed failure. A non-zero
 * exit the acceptance verdict excuses is no failure, and the owner check's
 * non-zero exit is explained by its own findings, which
 * `ownerVerificationProcessFailures` reports in its place.
 */
function checkProcessFailures(
  authority: AuthorizedWaveCompletionSuite,
  result: WaveCompletionSuiteResult,
  excused: ReadonlySet<string>,
): ProcessFailures {
  const expectedById = new Map(authority.checks.map((check) => [check.checkId, check]));
  const infrastructure: CompletionInfrastructureFailure[] = [];
  const semantic: CompletionSemanticFailure[] = [];
  for (const { checkId, outcome } of result.checks) {
    const expected = expectedById.get(checkId)!;
    if (outcome.kind === "spawn-failed") {
      infrastructure.push(freeze({ kind: "spawn-failed", checkId, message: outcome.message }));
      continue;
    }
    const exitExplained = excused.has(checkId) || expected.kind === "engine-owner-verification";
    if (outcome.timedOut) semantic.push(freeze({ kind: "timed-out", checkId }));
    if (outcome.signal !== null) semantic.push(freeze({ kind: "signal-termination", checkId, signal: outcome.signal }));
    if (outcome.exitCode !== null && outcome.exitCode !== 0 && !exitExplained) {
      semantic.push(freeze({ kind: "non-zero-exit", checkId, exitCode: outcome.exitCode }));
    }
    if (outcome.exitCode === null && !outcome.timedOut && outcome.signal === null) {
      infrastructure.push(freeze({ kind: "incomplete-process-observation", checkId }));
    }
    if (expected.reportPolicy.kind === "required-file" && outcome.report.kind === "missing") {
      semantic.push(freeze({ kind: "missing-report", checkId, path: expected.reportPolicy.path }));
    }
    if (expected.reportPolicy.kind === "required-file" && outcome.report.kind === "unreadable") {
      infrastructure.push(freeze({ kind: "report-unreadable", checkId, path: expected.reportPolicy.path, message: outcome.report.message }));
    }
  }
  return { infrastructure, semantic };
}
