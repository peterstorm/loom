import { spawnSync } from "node:child_process";
import { lstatSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { COMPLETION_REPORT_ROOT } from "../core/completion-suite";
import {
  compareCandidateRepositoryWitnesses,
  createCandidateRepositoryWitness,
  type CandidateGitWitness,
  type CandidateRepositoryWitness,
  type DefectFamilyVerificationPlan,
} from "../core/defect-family-accounting";
import { compareStrings } from "../core/ordering";
import { type ArtifactDigest, type DomainResult } from "../core/orchestration-contract";
import { parseReviewPath, type ReviewPath } from "../core/review-packet";
import { VERIFICATION_MANIFEST_SOURCE_PATH } from "../core/verification-manifest";
import { inspectRepositoryPath } from "../utils/repository-path";
import {
  observeWorkspaceDigest,
  resolveCanonicalGitRepositoryRoot,
  type CanonicalRepositoryRoot,
  type WorkspaceDigestFailure,
} from "../utils/workspace-digest";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const EXACT_PATH_WILDCARD = /[*?\[\]]/;

type CandidateVerificationPlan = Exclude<
  DefectFamilyVerificationPlan,
  { readonly kind: "blocked-declaration" }
>;

export type RemediationCandidatePathSources = Readonly<{
  reviewedPaths: readonly string[];
  supportPaths: readonly string[];
  siblingPaths: readonly string[];
  /** Repository files supplying declarations, command scripts, or command configuration. */
  inputSourcePaths: readonly string[];
}>;

export type RemediationCandidateCaptureInput = Readonly<{
  repositoryStartPath: string;
  verification: CandidateVerificationPlan;
  pathSources: RemediationCandidatePathSources;
  /** Intended or existing protected Run Directory; it must be outside Git visibility. */
  runDirectory: string;
}>;

export type RemediationCandidateCapture = Readonly<{
  repositoryRoot: CanonicalRepositoryRoot;
  observedPaths: readonly ReviewPath[];
  workspaceDigest: ArtifactDigest;
  pathCount: number;
  generatedReportPaths: readonly ReviewPath[];
  candidateWitness: CandidateRepositoryWitness;
}>;

export type RemediationCandidateCaptureError = Readonly<{
  kind: "remediation-candidate-capture-failed";
  field: string;
  message: string;
  workspaceFailure?: WorkspaceDigestFailure;
}>;

const success = <T>(value: T): DomainResult<T, RemediationCandidateCaptureError> =>
  Object.freeze({ ok: true, value });

const failure = <T>(
  field: string,
  message: string,
  workspaceFailure?: WorkspaceDigestFailure,
): DomainResult<T, RemediationCandidateCaptureError> => Object.freeze({
  ok: false,
  error: Object.freeze({
    kind: "remediation-candidate-capture-failed" as const,
    field,
    message: message.slice(0, 4_096),
    ...(workspaceFailure === undefined ? {} : { workspaceFailure }),
  }),
});

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseExactPath(raw: unknown, field: string): DomainResult<ReviewPath, RemediationCandidateCaptureError> {
  const parsed = parseReviewPath(raw, field);
  if (!parsed.ok) return failure(field, parsed.errors.join("; "));
  return EXACT_PATH_WILDCARD.test(parsed.value)
    ? failure(field, `${field} must name one exact path, not a wildcard pattern`)
    : success(parsed.value);
}

function parsePathList(
  raw: readonly string[],
  field: string,
): DomainResult<readonly ReviewPath[], RemediationCandidateCaptureError> {
  const paths: ReviewPath[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseExactPath(entry, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    paths.push(parsed.value);
  }
  return success(Object.freeze(paths));
}

function selectedGeneratedReports(
  verification: CandidateVerificationPlan,
): DomainResult<readonly ReviewPath[], RemediationCandidateCaptureError> {
  if (verification.kind === "not-required") return success(Object.freeze([]));
  const paths: ReviewPath[] = [];
  for (const [index, command] of verification.commands.entries()) {
    if (command.reportPolicy.kind !== "required-file") {
      return failure(`verification.commands[${index}].reportPolicy`, "every selected remediation check must require one report file");
    }
    const parsed = parseExactPath(command.reportPolicy.path, `verification.commands[${index}].reportPolicy.path`);
    if (!parsed.ok) return parsed;
    if (!parsed.value.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
      return failure(
        `verification.commands[${index}].reportPolicy.path`,
        `selected generated reports must be beneath ${COMPLETION_REPORT_ROOT}/`,
      );
    }
    paths.push(parsed.value);
  }
  const sorted = paths.toSorted(compareStrings);
  const duplicate = sorted.find((path, index) => index > 0 && path === sorted[index - 1]);
  return duplicate === undefined
    ? success(Object.freeze(sorted))
    : failure("verification.commands", `selected generated report path is repeated: ${duplicate}`);
}

type ParsedPathPolicy = Readonly<{
  generatedReports: readonly ReviewPath[];
  candidateSources: readonly ReviewPath[];
  /** The source review's frozen scope, which may name paths the reviewed change deleted. */
  reviewedPaths: ReadonlySet<ReviewPath>;
}>;

function parsePathPolicy(
  input: RemediationCandidateCaptureInput,
): DomainResult<ParsedPathPolicy, RemediationCandidateCaptureError> {
  const reports = selectedGeneratedReports(input.verification);
  if (!reports.ok) return reports;
  const reviewed = parsePathList(input.pathSources.reviewedPaths, "pathSources.reviewedPaths");
  if (!reviewed.ok) return reviewed;
  const sourceLists: readonly (readonly [readonly string[], string])[] = [
    [input.pathSources.supportPaths, "pathSources.supportPaths"],
    [input.pathSources.siblingPaths, "pathSources.siblingPaths"],
    [input.pathSources.inputSourcePaths, "pathSources.inputSourcePaths"],
    ...(input.verification.kind === "selected-operator-checks"
      ? [[[VERIFICATION_MANIFEST_SOURCE_PATH], "verification.manifestPath"]] as const
      : []),
  ];
  const sources: ReviewPath[] = [...reviewed.value];
  for (const [raw, field] of sourceLists) {
    const parsed = parsePathList(raw, field);
    if (!parsed.ok) return parsed;
    sources.push(...parsed.value);
  }
  const sourceSet = new Set(sources);
  const overlap = reports.value.filter((path) => sourceSet.has(path));
  if (overlap.length > 0) {
    return failure("verification.commands", `generated reports overlap candidate input paths: ${overlap.join(", ")}`);
  }
  return success(Object.freeze({
    generatedReports: reports.value,
    candidateSources: Object.freeze([...sourceSet].sort(compareStrings)),
    reviewedPaths: new Set(reviewed.value),
  }));
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "",
    LANG: "C",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

type GitQuery = Readonly<{ status: 0 | 1; stdout: Buffer }>;

function gitQuery(
  root: CanonicalRepositoryRoot,
  operation: string,
  args: readonly string[],
  literalPathspec = true,
): DomainResult<GitQuery, RemediationCandidateCaptureError> {
  const globalArgs = literalPathspec ? ["--literal-pathspecs"] : [];
  const result = spawnSync("git", [...globalArgs, "-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env: gitEnvironment(),
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    const stderr = Buffer.from(result.stderr ?? []).toString("utf-8").trim();
    return failure(
      operation,
      `${operation} failed: ${result.error?.message ?? (stderr || `git exited ${String(result.status)}`)}`,
    );
  }
  return success(Object.freeze({ status: result.status, stdout: Buffer.from(result.stdout ?? []) }));
}

function trackedPath(
  root: CanonicalRepositoryRoot,
  path: ReviewPath,
): DomainResult<boolean, RemediationCandidateCaptureError> {
  const queried = gitQuery(root, `tracking status for ${path}`, ["ls-files", "--error-unmatch", "--", path]);
  return queried.ok ? success(queried.value.status === 0) : queried;
}

function ignoredPath(
  root: CanonicalRepositoryRoot,
  path: ReviewPath,
): DomainResult<boolean, RemediationCandidateCaptureError> {
  const queried = gitQuery(
    root,
    `ignore status for ${path}`,
    ["check-ignore", "--no-index", "--quiet", "--", path],
    false,
  );
  return queried.ok ? success(queried.value.status === 0) : queried;
}

function statIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function reportNodeIdentity(
  root: CanonicalRepositoryRoot,
  path: ReviewPath,
): DomainResult<string | null, RemediationCandidateCaptureError> {
  try {
    inspectRepositoryPath(root, path, `generated report ${path}`, { allowLeafSymlink: true });
    const stat = lstatSync(join(root, ...path.split("/")), { bigint: true });
    return stat.isFile()
      ? success(statIdentity(stat))
      : failure("verification.commands", `generated report path must be absent or a regular file: ${path}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return success(null);
    return failure("verification.commands", `cannot safely inspect generated report ${path}: ${causeMessage(cause)}`);
  }
}

type GeneratedReportAudit = Readonly<{ path: ReviewPath; nodeIdentity: string | null }>;

function auditGeneratedReport(
  root: CanonicalRepositoryRoot,
  path: ReviewPath,
): DomainResult<GeneratedReportAudit, RemediationCandidateCaptureError> {
  const tracked = trackedPath(root, path);
  if (!tracked.ok) return tracked;
  if (tracked.value) return failure("verification.commands", `selected generated report must be untracked: ${path}`);
  const ignored = ignoredPath(root, path);
  if (!ignored.ok) return ignored;
  if (!ignored.value) {
    return failure(
      "verification.commands",
      `selected generated report is not Git-ignored: ${path}; add an exact operator-owned ignore rule before starting remediation`,
    );
  }
  const identity = reportNodeIdentity(root, path);
  return identity.ok ? success(Object.freeze({ path, nodeIdentity: identity.value })) : identity;
}

function auditGeneratedReports(
  root: CanonicalRepositoryRoot,
  paths: readonly ReviewPath[],
): DomainResult<readonly GeneratedReportAudit[], RemediationCandidateCaptureError> {
  const audits: GeneratedReportAudit[] = [];
  for (const path of paths) {
    const audited = auditGeneratedReport(root, path);
    if (!audited.ok) return audited;
    audits.push(audited.value);
  }
  return success(Object.freeze(audits));
}

function runDirectoryRelativePath(
  root: CanonicalRepositoryRoot,
  raw: string,
): DomainResult<ReviewPath | null, RemediationCandidateCaptureError> {
  if (!isAbsolute(raw) || resolve(raw) !== raw || raw.includes("\0")) {
    return failure("runDirectory", "protected Run Directory must be a canonical absolute path");
  }
  const path = relative(root, raw);
  if (path === "" || path === ".") {
    return failure("runDirectory", "repository root cannot be used as a protected Run Directory");
  }
  if (path === ".." || path.startsWith("../")) return success(null);
  return parseExactPath(path, "runDirectory");
}

function auditRunDirectory(
  root: CanonicalRepositoryRoot,
  raw: string,
): DomainResult<null, RemediationCandidateCaptureError> {
  const relativePath = runDirectoryRelativePath(root, raw);
  if (!relativePath.ok) return relativePath;
  if (relativePath.value === null) return success(null);
  try {
    inspectRepositoryPath(root, relativePath.value, "protected Run Directory");
  } catch (cause) {
    return failure("runDirectory", `protected Run Directory path is unsafe: ${causeMessage(cause)}`);
  }
  const tracked = gitQuery(root, "Run Directory tracking audit", ["ls-files", "-z", "--", relativePath.value]);
  if (!tracked.ok) return tracked;
  if (tracked.value.status !== 0) {
    return failure("runDirectory", `cannot prove protected Run Directory is untracked: ${relativePath.value}`);
  }
  if (tracked.value.stdout.byteLength > 0) {
    return failure("runDirectory", `protected Run Directory contains tracked paths: ${relativePath.value}`);
  }
  const ignored = ignoredPath(root, relativePath.value);
  if (!ignored.ok) return ignored;
  return ignored.value
    ? success(null)
    : failure(
      "runDirectory",
      `protected Run Directory is Git-visible: ${relativePath.value}; choose an already-ignored location or a location outside the repository`,
    );
}

function sameReportAudits(
  before: readonly GeneratedReportAudit[],
  after: readonly GeneratedReportAudit[],
): boolean {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    return current !== undefined && entry.path === current.path && entry.nodeIdentity === current.nodeIdentity;
  });
}

function absentFromWorktree(root: CanonicalRepositoryRoot, path: ReviewPath): boolean {
  try {
    lstatSync(join(root, ...path.split("/")));
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Committed paths whose deletion is already STAGED: present in HEAD's tree,
 * absent from the index (so outside the observed roster) and absent from the
 * worktree. That is the same candidate change as an unstaged deletion — which
 * the observed roster already admits — so it must be authorizable too;
 * otherwise a remediation that installed (staged) a deletion leaves the next
 * remediation over the same tree unable to name the path it must authorize.
 */
function stagedCommittedDeletions(
  root: CanonicalRepositoryRoot,
  paths: readonly ReviewPath[],
): DomainResult<ReadonlySet<ReviewPath>, RemediationCandidateCaptureError> {
  if (paths.length === 0) return success(new Set());
  const head = gitQuery(root, "HEAD tree lookup", ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  if (!head.ok) return head;
  if (head.value.status !== 0) return success(new Set());
  const committed = gitQuery(root, "committed deletion lookup", ["ls-tree", "-z", "--name-only", "HEAD", "--", ...paths]);
  if (!committed.ok) return committed;
  if (committed.value.status !== 0) return failure("pathSources", "cannot list committed candidate input paths");
  const names = new Set(committed.value.stdout.toString("utf-8").split("\0").filter((name) => name.length > 0));
  return success(new Set(paths.filter((path) => names.has(path) && absentFromWorktree(root, path))));
}

/**
 * A reviewed path may be absent everywhere — not in HEAD, the index, or the
 * worktree — because the reviewed change itself deleted it (a branch diff
 * against its base names deletions). Such a path carries no candidate bytes to
 * authorize, and re-creating it would make it observed and so digest-visible.
 * Support, sibling and input-source paths get no such allowance: a name the
 * caller supplies that does not exist is refused, never silently accepted.
 */
function requireObservedCandidateSources(
  root: CanonicalRepositoryRoot,
  policy: ParsedPathPolicy,
  observed: readonly ReviewPath[],
): DomainResult<null, RemediationCandidateCaptureError> {
  const roster = new Set(observed);
  const unobserved = policy.candidateSources.filter((path) => !roster.has(path));
  const deletions = stagedCommittedDeletions(root, unobserved);
  if (!deletions.ok) return deletions;
  const missing = unobserved.filter((path) =>
    !deletions.value.has(path) && !(policy.reviewedPaths.has(path) && absentFromWorktree(root, path)));
  return missing.length === 0
    ? success(null)
    : failure(
      "pathSources",
      `candidate input paths are not Git-visible tracked or non-ignored untracked paths, committed paths with a staged deletion, nor reviewed paths absent from the worktree: ${missing.join(", ")}`,
    );
}

/**
 * Capture one bounded stable-read epoch and combine it with the caller's Git
 * witness through the core constructor. The operation runs read-only Git/fs
 * observations, so it is safe to invoke while the installer holds index.lock.
 *
 * The before/after audits detect ordinary concurrent drift; they are not a
 * claim of whole-execution isolation and cannot rule out adversarial ABA.
 */
export function captureRemediationCandidateWorkspace(
  input: RemediationCandidateCaptureInput,
  gitWitness: CandidateGitWitness,
): DomainResult<RemediationCandidateCapture, RemediationCandidateCaptureError> {
  const root = resolveCanonicalGitRepositoryRoot(input.repositoryStartPath);
  if (!root.ok) return failure("repositoryStartPath", "cannot resolve candidate repository", root.error);
  const policy = parsePathPolicy(input);
  if (!policy.ok) return policy;
  const runBefore = auditRunDirectory(root.value, input.runDirectory);
  if (!runBefore.ok) return runBefore;
  const reportsBefore = auditGeneratedReports(root.value, policy.value.generatedReports);
  if (!reportsBefore.ok) return reportsBefore;
  const workspace = observeWorkspaceDigest(root.value, {
    completionReportPaths: policy.value.generatedReports,
  });
  if (!workspace.ok) return failure("workspace", "cannot capture stable candidate workspace", workspace.error);
  const reportsAfter = auditGeneratedReports(root.value, policy.value.generatedReports);
  if (!reportsAfter.ok) return reportsAfter;
  if (!sameReportAudits(reportsBefore.value, reportsAfter.value)) {
    return failure("verification.commands", "generated report metadata drifted during candidate capture");
  }
  const runAfter = auditRunDirectory(root.value, input.runDirectory);
  if (!runAfter.ok) return runAfter;
  const observedSources = requireObservedCandidateSources(root.value, policy.value, workspace.value.observedPaths);
  if (!observedSources.ok) return observedSources;
  const candidate = createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: workspace.value.repositoryRoot,
    workspaceDigest: workspace.value.digest,
    pathCount: workspace.value.pathCount,
    observedPaths: workspace.value.observedPaths,
    gitWitness,
    generatedReportExclusions: policy.value.generatedReports,
  });
  if (!candidate.ok) {
    return failure(
      "gitWitness",
      candidate.error.failures.map(({ message }) => message).join("; "),
    );
  }
  return success(Object.freeze({
    repositoryRoot: workspace.value.repositoryRoot,
    observedPaths: workspace.value.observedPaths,
    workspaceDigest: workspace.value.digest,
    pathCount: workspace.value.pathCount,
    generatedReportPaths: policy.value.generatedReports,
    candidateWitness: candidate.value,
  }));
}

export type RemediationCandidateRecaptureInput = Readonly<{
  repositoryStartPath: string;
  candidateBaseline: CandidateRepositoryWitness;
  runDirectory?: string;
}>;

/**
 * Re-observe an existing registration's exact candidate policy. This is the
 * comparison seam used before/after checks and by the installer while holding
 * the real index lock; exclusions can only come from the parser-minted baseline.
 */
export function recaptureRemediationCandidateWorkspace(
  input: RemediationCandidateRecaptureInput,
  gitWitness: CandidateGitWitness,
): DomainResult<RemediationCandidateCapture, RemediationCandidateCaptureError> {
  const baseline = input.candidateBaseline;
  const membership = compareCandidateRepositoryWitnesses(baseline, baseline);
  if (!membership.ok) {
    return failure("candidateBaseline", membership.error.failures.map(({ message }) => message).join("; "));
  }
  const root = resolveCanonicalGitRepositoryRoot(input.repositoryStartPath);
  if (!root.ok) return failure("repositoryStartPath", "cannot resolve candidate repository", root.error);
  if (root.value !== baseline.repositoryRoot) {
    return failure("repositoryStartPath", "candidate repository root differs from the registered baseline");
  }
  const reports = parsePathList(
    baseline.generatedReportExclusions,
    "candidateBaseline.generatedReportExclusions",
  );
  if (!reports.ok) return reports;
  const runBefore = input.runDirectory === undefined ? success(null) : auditRunDirectory(root.value, input.runDirectory);
  if (!runBefore.ok) return runBefore;
  const reportsBefore = auditGeneratedReports(root.value, reports.value);
  if (!reportsBefore.ok) return reportsBefore;
  const workspace = observeWorkspaceDigest(root.value, { completionReportPaths: reports.value });
  if (!workspace.ok) return failure("workspace", "cannot recapture stable candidate workspace", workspace.error);
  const reportsAfter = auditGeneratedReports(root.value, reports.value);
  if (!reportsAfter.ok) return reportsAfter;
  if (!sameReportAudits(reportsBefore.value, reportsAfter.value)) {
    return failure("candidateBaseline.generatedReportExclusions", "generated report metadata drifted during candidate recapture");
  }
  const runAfter = input.runDirectory === undefined ? success(null) : auditRunDirectory(root.value, input.runDirectory);
  if (!runAfter.ok) return runAfter;
  const candidate = createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: workspace.value.repositoryRoot,
    workspaceDigest: workspace.value.digest,
    pathCount: workspace.value.pathCount,
    observedPaths: workspace.value.observedPaths,
    gitWitness,
    generatedReportExclusions: reports.value,
  });
  if (!candidate.ok) {
    return failure("gitWitness", candidate.error.failures.map(({ message }) => message).join("; "));
  }
  return success(Object.freeze({
    repositoryRoot: workspace.value.repositoryRoot,
    observedPaths: workspace.value.observedPaths,
    workspaceDigest: workspace.value.digest,
    pathCount: workspace.value.pathCount,
    generatedReportPaths: reports.value,
    candidateWitness: candidate.value,
  }));
}
