/**
 * The owner-verification execution shell (AD-8; FR-008, FR-015, FR-016,
 * AS-007, AS-008, AS-016, AS-017). Every effect of owner verification lives
 * here or in `owner-mutation-workspace.ts`; every decision lives in the pure
 * core (`core/owner-verification/`):
 *
 * 1. The real workspace's digest is observed before anything runs.
 * 2. Per owed obligation, in stamp order:
 *    - coverage: the matrix test's import frontier is read from the real
 *      workspace (`coverageFrontier` names each next read), its tsconfig
 *      `paths` are read through `jsonc-parser`, and `coverageOverFiles`
 *      decides;
 *    - mutation, unless the obligation is exempt: the owner's Wave base is
 *      the `start_sha` of the Wave Tasks listing it (their octopus merge-base
 *      when several), `changedHeadLines` and `mutationPlan` fix the mutants,
 *      and one isolated worktree runs the baseline first and, only when it is
 *      green, every mutant, each through the frozen `affectedRunner` with the
 *      matrix test as its only file;
 *    - `invariantVerdict` assembles the verdict.
 * 3. The real workspace's digest is observed again: any difference is the
 *    blocking `real-workspace-changed` failure (SC-004).
 *
 * No command text ever comes from the plan: the command is the frozen
 * runner's, formed by `affectedRunnerCheck`, and its time limit is clamped by
 * `mutantTimeoutMs`.
 *
 * `runOwnerVerification` never throws to its caller, by construction: every
 * repository read is total (`readRepositoryText` returns a file the
 * filesystem refuses as `repository-file-unreadable`, never as absence), the
 * workspace observer and the obligation runs are guarded, and anything a
 * step still throws is the named `unexpected-error` failure.
 */

import { posix } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { failure, success, type DomainResult, type NonEmpty } from "../core/orchestration-contract/identity";
import type { ArtifactDigest } from "../core/orchestration-contract";
import { coverageFrontier, coverageOverFiles, initialCoverageState } from "../core/owner-verification/coverage";
import { mutationPlan, applyMutant, mutantTimeoutMs, MUTANT_CAP_PER_INVARIANT } from "../core/owner-verification/mutation-plan";
import { ownerCheckAuthority } from "../core/owner-verification/obligations";
import { classifyBaseline, classifyMutantRun } from "../core/owner-verification/outcome";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MatrixTestRun,
  MutationPlan,
  OwnerInfrastructureFailure,
  OwnerInfrastructureFailureKind,
  OwnerObligation,
  OwnerVerificationObservation,
  PathAlias,
  PathAliases,
} from "../core/owner-verification/types";
import { invariantVerdict, mutationBoundMs, type MutantResult, type MutationEvidence } from "../core/owner-verification/verdict";
import { parseAuthorizedWaveCompletionCheck, type AuthorizedWaveCompletionCheck } from "../core/completion-suite";
import { pathsMatch } from "../core/plan-path-match";
import { changedHeadLines } from "../core/unified-diff";
import { affectedRunnerCheck, type AffectedRunner, type FrozenVerificationManifest } from "../core/verification-manifest";
import type { Task, TaskGraph } from "../types";
import { runGit } from "../utils/git-execution-policy";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { runProjectCommandAt, type CommandExecutionResult } from "./completion-check-runner";
import { withMutationWorkspace, type MutationWorkspace } from "./owner-mutation-workspace";

export type OwnerVerificationInput = Readonly<{
  /** The real, reviewed workspace. */
  root: CanonicalRepositoryRoot;
  graph: TaskGraph;
  wave: number;
  /** The obligations the Wave owes (`ownerVerificationOwed`), in stamp order. */
  owed: NonEmpty<OwnerObligation>;
  manifest: FrozenVerificationManifest;
  /** The real workspace's Git-visible digest (`observeCurrentWaveWorkspace`). */
  observeWorkspace: () => DomainResult<ArtifactDigest, string>;
}>;

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const infrastructure = (kind: OwnerInfrastructureFailureKind, detail: string): OwnerInfrastructureFailure => ({ kind, detail });

const unavailableBecause = (failure: OwnerInfrastructureFailure): OwnerVerificationObservation => ({ kind: "unavailable", failure });

const unavailable = (kind: OwnerInfrastructureFailureKind, detail: string): OwnerVerificationObservation =>
  unavailableBecause(infrastructure(kind, detail));

// ---------------------------------------------------------------------------
// Real-workspace reads
// ---------------------------------------------------------------------------

/**
 * One repository file as the check reads it. `absent` is only "not there":
 * no such path, not a regular file, or a path resolving outside the
 * repository. A file the filesystem refuses (any other errno) is
 * `unreadable`, never absent, so it can never pass for a missing sibling.
 */
type RepositoryRead =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable"; failure: OwnerInfrastructureFailure }>;

const ABSENT: RepositoryRead = Object.freeze({ kind: "absent" });
const ABSENCE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** A repository-relative path's text, its absence, or why the filesystem refused it. Never throws. */
function readRepositoryText(root: CanonicalRepositoryRoot, path: string): RepositoryRead {
  const absolute = posix.join(root, path);
  try {
    if (!statSync(absolute).isFile()) return ABSENT;
    const real = realpathSync.native(absolute);
    if (!real.startsWith(`${root}/`)) return ABSENT;
    return { kind: "text", text: readFileSync(real, "utf-8") };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (typeof code === "string" && ABSENCE_CODES.has(code)) return ABSENT;
    return { kind: "unreadable", failure: infrastructure("repository-file-unreadable", `${path} cannot be read: ${describe(cause)}`) };
  }
}

// ---------------------------------------------------------------------------
// tsconfig `paths`
// ---------------------------------------------------------------------------

type CompilerPaths = Readonly<{
  /** The repository-relative directory `baseUrl` names, when a config in the chain declares one. */
  baseUrl: string | null;
  /** The declared `paths` and the directory of the config that declared them. */
  paths: Readonly<{ entries: readonly (readonly [string, readonly string[]])[]; declaredIn: string }> | null;
}>;

const directoryOf = (path: string): string => {
  const directory = posix.dirname(path);
  return directory === "." ? "" : directory;
};

/** A repository-relative join that collapses `.` and `..`; null when it escapes the repository. */
function within(directory: string, relative: string): string | null {
  const joined = posix.normalize(posix.join(directory === "" ? "." : directory, relative));
  if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return null;
  return joined === "." ? "" : joined;
}

/** The nearest `tsconfig.json` from the matrix test's directory up to the repository root. */
function nearestTsconfig(matrixTest: string, read: (path: string) => string | null): string | null {
  for (let directory = directoryOf(matrixTest); ; directory = directoryOf(directory)) {
    const candidate = directory === "" ? "tsconfig.json" : `${directory}/tsconfig.json`;
    if (read(candidate) !== null) return candidate;
    if (directory === "") return null;
  }
}

/** The config file an `extends` entry names: relative to the extending config, or a package beneath a `node_modules`. */
function extendedConfig(from: string, specifier: string, read: (path: string) => string | null): string | null {
  const withJson = (path: string): readonly string[] => path.endsWith(".json") ? [path] : [path, `${path}.json`, `${path}/tsconfig.json`];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = within(directoryOf(from), specifier);
    return base === null ? null : withJson(base).find((candidate) => read(candidate) !== null) ?? null;
  }
  for (let directory = directoryOf(from); ; directory = directoryOf(directory)) {
    const base = within(directory, `node_modules/${specifier}`);
    const found = base === null ? undefined : withJson(base).find((candidate) => read(candidate) !== null);
    if (found !== undefined) return found;
    if (directory === "") return null;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One config's `baseUrl` and `paths` over the configs it extends, the later overriding the earlier. */
function compilerPaths(config: string, read: (path: string) => string | null, seen: ReadonlySet<string>): DomainResult<CompilerPaths, string> {
  if (seen.has(config)) return failure(`tsconfig ${config} extends itself`);
  const text = read(config);
  if (text === null) return failure(`tsconfig ${config} cannot be read`);
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) return failure(`tsconfig ${config} does not parse: ${errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(", ")}`);
  if (!isRecord(parsed)) return failure(`tsconfig ${config} is not an object`);

  const extendsField = parsed.extends;
  const parents = extendsField === undefined ? [] : typeof extendsField === "string" ? [extendsField] : extendsField;
  if (!Array.isArray(parents) || !parents.every((parent): parent is string => typeof parent === "string")) {
    return failure(`tsconfig ${config} has an extends that is not a string or a string array`);
  }
  let inherited: CompilerPaths = { baseUrl: null, paths: null };
  for (const parent of parents) {
    const file = extendedConfig(config, parent, read);
    if (file === null) return failure(`tsconfig ${config} extends ${parent}, which cannot be found`);
    const parentPaths = compilerPaths(file, read, new Set([...seen, config]));
    if (!parentPaths.ok) return parentPaths;
    inherited = {
      baseUrl: parentPaths.value.baseUrl ?? inherited.baseUrl,
      paths: parentPaths.value.paths ?? inherited.paths,
    };
  }

  const options = parsed.compilerOptions;
  if (options === undefined) return success(inherited);
  if (!isRecord(options)) return failure(`tsconfig ${config} compilerOptions is not an object`);
  let baseUrl = inherited.baseUrl;
  if (options.baseUrl !== undefined) {
    if (typeof options.baseUrl !== "string") return failure(`tsconfig ${config} baseUrl is not a string`);
    const resolved = within(directoryOf(config), options.baseUrl);
    if (resolved === null) return failure(`tsconfig ${config} baseUrl ${options.baseUrl} escapes the repository`);
    baseUrl = resolved;
  }
  let paths = inherited.paths;
  if (options.paths !== undefined) {
    if (!isRecord(options.paths)) return failure(`tsconfig ${config} paths is not an object`);
    const entries: (readonly [string, readonly string[]])[] = [];
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets) || !targets.every((target): target is string => typeof target === "string")) {
        return failure(`tsconfig ${config} paths.${pattern} is not a string array`);
      }
      entries.push([pattern, targets]);
    }
    paths = { entries, declaredIn: directoryOf(config) };
  }
  return success({ baseUrl, paths });
}

/**
 * The matrix test's tsconfig `paths`, made repository-relative: targets resolve
 * against `baseUrl` when the chain declares one, otherwise against the
 * directory of the config that declared `paths`, as TypeScript resolves them.
 * Empty when no tsconfig governs the matrix test; refused when one does not
 * parse, since its aliases would then be unknown.
 */
export function pathAliasesOf(matrixTest: string, read: (path: string) => string | null): DomainResult<PathAliases, string> {
  const config = nearestTsconfig(matrixTest, read);
  if (config === null) return success([]);
  const resolved = compilerPaths(config, read, new Set());
  if (!resolved.ok) return resolved;
  const { baseUrl, paths } = resolved.value;
  if (paths === null) return success([]);
  const base = baseUrl ?? paths.declaredIn;
  return success(paths.entries.map(([pattern, targets]): PathAlias => ({
    pattern,
    targets: targets.flatMap((target) => {
      const joined = within(base, target);
      return joined === null ? [] : [joined];
    }),
  })));
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const coverageInfrastructure = (failure: OwnerInfrastructureFailure): CoverageVerdict => ({ kind: "infrastructure", failure });

/** The matrix test's tsconfig aliases. A refused config is an infrastructure failure, never a config that is not there. */
function coverageAliases(root: CanonicalRepositoryRoot, matrixTest: string): DomainResult<PathAliases, OwnerInfrastructureFailure> {
  const refused: OwnerInfrastructureFailure[] = [];
  const aliases = pathAliasesOf(matrixTest, (path) => {
    const file = readRepositoryText(root, path);
    if (file.kind === "unreadable") refused.push(file.failure);
    return file.kind === "text" ? file.text : null;
  });
  const [first] = refused;
  if (first !== undefined) return failure(first);
  return aliases.ok
    ? aliases
    : failure(infrastructure("plan-unreadable", `the import graph of ${matrixTest} cannot be resolved: ${aliases.error}`));
}

function coverage(root: CanonicalRepositoryRoot, obligation: OwnerObligation): CoverageVerdict {
  const aliases = coverageAliases(root, obligation.matrixTest);
  if (!aliases.ok) return coverageInfrastructure(aliases.error);
  let step = coverageFrontier(initialCoverageState(obligation.matrixTest, aliases.value), new Map());
  while (step.kind === "read") {
    const gathered = new Map<string, string>();
    for (const path of step.next) {
      const file = readRepositoryText(root, path);
      if (file.kind === "unreadable") return coverageInfrastructure(file.failure);
      if (file.kind === "text") gathered.set(path, file.text);
    }
    step = coverageFrontier(step.state, gathered);
  }
  if (step.kind === "bound-exceeded") return coverageInfrastructure(step.failure);
  return coverageOverFiles({ matrixTest: obligation.matrixTest, obligation, files: step.state.files, aliases: aliases.value });
}

// ---------------------------------------------------------------------------
// The Wave base
// ---------------------------------------------------------------------------

function gitText(root: CanonicalRepositoryRoot, args: readonly string[]): DomainResult<string, string> {
  try {
    return success(runGit(["-C", root, ...args], { output: "text" }));
  } catch (cause) {
    return failure(`git ${args[0] ?? ""} failed: ${describe(cause)}`);
  }
}

/** The commit the Wave's owner Tasks started from: their one `start_sha`, or the octopus merge-base of several. */
function waveBase(root: CanonicalRepositoryRoot, owner: string, tasks: NonEmpty<Task>): DomainResult<string, OwnerInfrastructureFailure> {
  const missing = tasks.filter((task) => task.start_sha === undefined || task.start_sha === "").map((task) => task.id);
  if (missing.length > 0) {
    return failure(infrastructure("missing-wave-base", `Task ${missing.join(", ")} changed ${owner} but records no start_sha, so the owner's Wave base is unknown`));
  }
  const shas = [...new Set(tasks.map((task) => task.start_sha!))];
  const base = shas.length === 1
    ? gitText(root, ["rev-parse", "--verify", "--quiet", `${shas[0]!}^{commit}`])
    : gitText(root, ["merge-base", "--octopus", ...shas]);
  return base.ok && base.value.trim() !== ""
    ? success(base.value.trim())
    : failure(infrastructure("missing-wave-base", `the Wave base of ${owner} (${shas.join(", ")}) cannot be resolved${base.ok ? "" : `: ${base.error}`}`));
}

/** The owner's text at the Wave base, or null when the owner did not exist there (a new file: every line changed). */
function ownerAtBase(root: CanonicalRepositoryRoot, base: string, owner: string): DomainResult<string | null, OwnerInfrastructureFailure> {
  const listed = gitText(root, ["ls-tree", "-z", base, "--", owner]);
  if (!listed.ok) return failure(infrastructure("missing-wave-base", `${owner} at the Wave base ${base} cannot be listed: ${listed.error}`));
  const entry = /^\d+ blob ([0-9a-f]+)\t/.exec(listed.value);
  if (listed.value === "") return success(null);
  if (entry === null) return failure(infrastructure("missing-wave-base", `${owner} at the Wave base ${base} is not a file`));
  const blob = gitText(root, ["cat-file", "blob", entry[1]!]);
  return blob.ok ? success(blob.value) : failure(infrastructure("missing-wave-base", `${owner} at the Wave base ${base} cannot be read: ${blob.error}`));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * One runner execution as the run the classifiers read. A runner that could
 * not run the command to an observed end (refused authority, unconfirmed
 * containment, a surviving process tree) never produced a report this check
 * may read, so it is the run that could not start, never a report.
 */
export function matrixTestRunOf(execution: CommandExecutionResult, elapsedMs: number): MatrixTestRun {
  if (!execution.ok) return { kind: "spawn-failed", message: `${execution.error.kind}: ${execution.error.message}` };
  const value = execution.value;
  if (value.kind === "spawn-failed") return { kind: "spawn-failed", message: value.process.message };
  if (value.process.timedOut) return { kind: "timed-out", elapsedMs };
  const report = value.report;
  return {
    kind: "exited",
    exitCode: value.process.exitCode,
    signal: value.process.signal,
    report: "outcome" in report ? { kind: "produced", bytes: report.bytes }
      : report.kind === "unreadable" ? { kind: "unreadable", reason: report.message }
      : { kind: "missing" },
  };
}

type MatrixTestCommand = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

/**
 * The frozen runner's command over the matrix test alone, formed by
 * `affectedRunnerCheck` and re-authorized with its time limit clamped by
 * `mutantTimeoutMs`: no command text ever comes from the plan.
 */
function matrixTestCommand(runner: AffectedRunner, matrixTest: string): DomainResult<MatrixTestCommand, string> {
  const formed = affectedRunnerCheck(runner, [matrixTest]);
  if (!formed.ok) return failure(formed.error.errors.join("; "));
  const clamped = parseAuthorizedWaveCompletionCheck({ ...formed.value, timeoutMs: mutantTimeoutMs(formed.value.timeoutMs) });
  if (!clamped.ok) return failure(clamped.error.errors.join("; "));
  return clamped.value.kind === "project-command" ? success(clamped.value) : failure("the clamped runner command is not a project command");
}

async function runOnce(workspace: MutationWorkspace, command: MatrixTestCommand, ownerText: string | null): Promise<MatrixTestRun> {
  return workspace.runWithOwner(ownerText, async (at) => {
    const started = Date.now();
    const execution = await runProjectCommandAt(command, at);
    return matrixTestRunOf(execution, Date.now() - started);
  });
}

/** The baseline, then (only when green) each mutant in plan order; the first infrastructure failure ends the run. */
async function runPlan(
  workspace: MutationWorkspace,
  command: MatrixTestCommand,
  obligation: OwnerObligation,
  ownerText: string,
  plan: MutationPlan | null,
): Promise<MutationEvidence> {
  const baseline = classifyBaseline(await runOnce(workspace, command, null), obligation.matrixTest);
  if (plan === null) return { kind: "owner-unchanged", baseline };
  if (baseline.kind !== "green") return { kind: "owner-changed", baseline, plan, results: [] };
  const results: MutantResult[] = [];
  for (const mutant of plan.mutants) {
    const outcome = classifyMutantRun(await runOnce(workspace, command, applyMutant(ownerText, mutant)), obligation.matrixTest);
    if (outcome.kind === "infrastructure") return { kind: "infrastructure", failure: outcome.failure };
    results.push({ mutant, outcome });
  }
  return { kind: "owner-changed", baseline, plan, results };
}

type Planned = Readonly<{ ownerText: string; plan: MutationPlan | null }>;

/** The owner's Wave bytes and its mutation plan: null when no Wave Task changed the owner. */
function planMutation(input: OwnerVerificationInput, obligation: OwnerObligation): DomainResult<Planned, OwnerInfrastructureFailure> {
  const owner = readRepositoryText(input.root, obligation.owner);
  if (owner.kind === "unreadable") return failure(owner.failure);
  if (owner.kind === "absent") {
    return failure(infrastructure("plan-drift", `${obligation.invariant} names the owner ${obligation.owner}, which is not a file in the workspace`));
  }
  const ownerText = owner.text;
  const ownerTasks = input.graph.tasks.filter((task) =>
    task.wave === input.wave && (task.file_list ?? []).some((file) => pathsMatch(file, obligation.owner)));
  const [first, ...rest] = ownerTasks;
  if (first === undefined) return success({ ownerText, plan: null });
  const base = waveBase(input.root, obligation.owner, [first, ...rest]);
  if (!base.ok) return base;
  const before = ownerAtBase(input.root, base.value, obligation.owner);
  if (!before.ok) return before;
  return success({
    ownerText,
    plan: mutationPlan({
      ownerPath: obligation.owner,
      ownerText,
      changedLines: changedHeadLines(before.value, ownerText),
      cap: MUTANT_CAP_PER_INVARIANT,
    }),
  });
}

async function mutationEvidence(input: OwnerVerificationInput, obligation: OwnerObligation, runner: AffectedRunner): Promise<MutationEvidence> {
  const command = matrixTestCommand(runner, obligation.matrixTest);
  if (!command.ok) {
    return { kind: "infrastructure", failure: infrastructure("runner-missing", `the affectedRunner cannot run ${obligation.matrixTest}: ${command.error}`) };
  }
  const planned = planMutation(input, obligation);
  if (!planned.ok) return { kind: "infrastructure", failure: planned.error };
  try {
    const ran = await withMutationWorkspace(
      { repositoryRoot: input.root, ownerPath: obligation.owner, reportPath: runner.report.path, runnerCwd: runner.cwd },
      (workspace) => runPlan(workspace, command.value, obligation, planned.value.ownerText, planned.value.plan),
    );
    return ran.ok ? ran.value : { kind: "infrastructure", failure: ran.error };
  } catch (cause) {
    return { kind: "infrastructure", failure: infrastructure("worktree-failed", `the isolated copy failed during a run: ${describe(cause)}`) };
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** A step's value, or the `unexpected-error` failure naming the step when it threw although it is built to return failures as data. */
async function guarded<T>(step: string, run: () => T | Promise<T>): Promise<DomainResult<T, OwnerInfrastructureFailure>> {
  try {
    return success(await run());
  } catch (cause) {
    return failure(infrastructure("unexpected-error", `${step} threw: ${describe(cause)}`));
  }
}

/** The real workspace's digest; an observer that fails or throws leaves the workspace unobserved, which is never a pass. */
async function workspaceDigest(input: OwnerVerificationInput, when: "before" | "after"): Promise<DomainResult<ArtifactDigest, OwnerInfrastructureFailure>> {
  const unobserved = (reason: string) =>
    failure(infrastructure("real-workspace-changed", `the real workspace could not be observed ${when} verification: ${reason}`));
  const observed = await guarded("observing the real workspace", input.observeWorkspace);
  if (!observed.ok) return unobserved(observed.error.detail);
  return observed.value.ok ? success(observed.value.value) : unobserved(observed.value.error);
}

type ObligationRuns = Readonly<{ verdicts: readonly InvariantVerdict[]; plans: ReadonlyMap<string, MutationPlan> }>;

/** Coverage then mutation per owed obligation, in stamp order. */
async function verifyObligations(input: OwnerVerificationInput, runner: AffectedRunner | undefined): Promise<ObligationRuns> {
  const verdicts: InvariantVerdict[] = [];
  const plans = new Map<string, MutationPlan>();
  for (const obligation of input.owed) {
    const covered = coverage(input.root, obligation);
    const evidence: MutationEvidence = obligation.mutation.kind === "exempt" || runner === undefined
      ? { kind: "exempt" }
      : await mutationEvidence(input, obligation, runner);
    if (evidence.kind === "owner-changed") plans.set(obligation.invariant, evidence.plan);
    verdicts.push(invariantVerdict(obligation, covered, evidence));
  }
  return { verdicts, plans };
}

/**
 * The check between its two digest observations. A throw from the
 * obligation runs is caught here, before the after-run observation, so the
 * SC-004 comparison runs on every path that ran anything; a changed
 * workspace outranks the thrown failure.
 */
async function verifyWave(input: OwnerVerificationInput): Promise<OwnerVerificationObservation> {
  const authority = ownerCheckAuthority(input.graph, input.wave);
  if (authority === null) return unavailable("plan-drift", "the TaskGraph carries no owner_obligations stamp, so it owes no owner verification");
  const runner = input.manifest.affectedRunner;
  const verifying = input.owed.filter((obligation) => obligation.mutation.kind === "verify");
  if (verifying.length > 0 && runner === undefined) {
    return unavailable("runner-missing", `${verifying.map((obligation) => obligation.invariant).join(", ")} owe mutation verification, but the frozen verification manifest declares no affectedRunner`);
  }

  const before = await workspaceDigest(input, "before");
  if (!before.ok) return unavailableBecause(before.error);
  const runs = await guarded("verifying the owed obligations", () => verifyObligations(input, runner));
  const after = await workspaceDigest(input, "after");
  if (!after.ok) return unavailableBecause(after.error);
  if (after.value !== before.value) {
    return unavailable("real-workspace-changed", `the real workspace digest changed from ${before.value} to ${after.value} while owner verification ran`);
  }
  if (!runs.ok) return unavailableBecause(runs.error);
  return {
    kind: "verified",
    obligationsDigest: authority.obligationsDigest,
    boundMs: mutationBoundMs(input.owed, runs.value.plans, runner === undefined ? 0 : mutantTimeoutMs(runner.timeoutMs)),
    verdicts: runs.value.verdicts,
  };
}

/**
 * Run owner verification for the Wave's owed obligations. Never throws, by
 * construction: every failure is `unavailable` or a per-Invariant
 * infrastructure verdict, and this outermost guard turns any throw that
 * escapes `verifyWave` into `unexpected-error`. Such a throw can only come
 * from pure code before the first digest observation or after the second was
 * compared, so no run went unchecked against SC-004.
 */
export async function runOwnerVerification(input: OwnerVerificationInput): Promise<OwnerVerificationObservation> {
  const observed = await guarded("owner verification", () => verifyWave(input));
  return observed.ok ? observed.value : unavailableBecause(observed.error);
}
