/**
 * Populate task graph with decompose output.
 * Merges existing phase tracking with new tasks.
 *
 * Usage: bun cli.ts helper populate-task-graph [--issue N] [--repo OWNER/REPO] [--fix] [--force]
 * Reads decompose JSON from stdin. `--force` permits replacing Tasks that have
 * already left pending; without it both the pre-lock and locked guards refuse.
 */

import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HookHandler, HookResult, TaskGraph } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { validateFull, fixFull } from "./validate-task-graph";
import {
  checkPlanModelBindings,
  productionModelBindingDeps,
  type ParsedPlan,
  type PlanBindingDeps,
} from "./validate-model-bindings";
import { populationPlanDesignRequirement } from "../../core/plan-design-review";
import { argumentValue, hasFlag } from "./cli-args";
import {
  VERIFICATION_MANIFEST_SOURCE_PATH,
  defaultVerificationManifest,
  freezeVerificationManifest,
  deriveProjectVerificationCoverage,
  renderProjectVerificationCoverage,
  type FrozenVerificationManifest,
} from "../../core/verification-manifest";
import { readRunBytesNoFollow } from "../../utils/no-follow-fs";
import { observeSpecIndex } from "../../orchestration/spec-index-observation";
import { specIndexUnavailableMessage } from "../../core/requirement-coverage";
import { captureDeclaredArtifactBaselineAtRevision } from "../../utils/declared-artifact-snapshot";
import { observeExactHead } from "../../utils/git";
import { runGit } from "../../utils/git-execution-policy";
import { renderProofBoundaryNotice } from "../../core/proof-boundary-observation";
import { acceptanceObservationProblem } from "../../core/acceptance-contract";
import { distillPlanNote, isDistillTask } from "../../core/distill-task";
import { parseDecomposeEnvelope, parseDecomposeInput, type DecomposeEnvelope, type DecomposeInput } from "../../core/decompose-payload";
import { isRecord } from "../../core/plain-record";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  resolvedSpecFile,
  type AuthoredTask,
  type PopulationProofBoundary,
  type TaskGraphPopulationCommand,
  type TaskGraphPopulationResult,
} from "../../core/task-graph-population";

export { resolvedSpecFile };

type PreparedManifest =
  | Readonly<{ ok: true; value: FrozenVerificationManifest }>
  | Readonly<{ ok: false; error: string }>;

type ResolvedProjectRoot =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; error: string }>;

type ManifestFile =
  | Readonly<{ kind: "bytes"; value: Uint8Array }>
  | Readonly<{ kind: "default"; value: FrozenVerificationManifest }>
  | Readonly<{ kind: "error"; error: string }>;

function defaultManifestIfMissing(path: string, error: unknown): ManifestFile {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return { kind: "default", value: defaultVerificationManifest() };
  }
  return {
    kind: "error",
    error: `cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function inspectManifestDirectory(manifestDirectory: string): ManifestFile | null {
  try {
    const directoryStat = lstatSync(manifestDirectory);
    return directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
      ? null
      : { kind: "error", error: `${manifestDirectory} must be a regular non-symlink directory` };
  } catch (error) {
    return defaultManifestIfMissing(manifestDirectory, error);
  }
}

function readManifestFile(manifestPath: string): ManifestFile {
  try {
    const fileStat = lstatSync(manifestPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      return { kind: "error", error: `${manifestPath} must be a regular non-symlink file` };
    }
  } catch (error) {
    return defaultManifestIfMissing(manifestPath, error);
  }
  try {
    return { kind: "bytes", value: Uint8Array.from(readRunBytesNoFollow(manifestPath)) };
  } catch (error) {
    return {
      kind: "error",
      error: `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const CANONICAL_STATE_PATHS = Object.freeze([
  join(".claude", "state", "active_task_graph.json"),
  join(".pi", "state", "active_task_graph.json"),
]);

function projectRootFromCanonicalStatePath(statePath: string): ResolvedProjectRoot {
  const absoluteStatePath = resolve(statePath);
  const projectRoot = dirname(dirname(dirname(absoluteStatePath)));
  const isCanonicalLayout = CANONICAL_STATE_PATHS.some(
    (relativeStatePath) => join(projectRoot, relativeStatePath) === absoluteStatePath,
  );
  return isCanonicalLayout
    ? { ok: true, value: projectRoot }
    : {
        ok: false,
        error:
          `cannot derive verification manifest authority from non-canonical State File path ${statePath}; ` +
          "expected <root>/.claude/state/active_task_graph.json or <root>/.pi/state/active_task_graph.json",
      };
}

type CanonicalGitRootObservation =
  | Readonly<{ kind: "repository"; root: string }>
  | Readonly<{ kind: "not-a-repository"; cause: string }>
  | Readonly<{ kind: "unavailable"; cause: string }>;

function gitFailureCause(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const detail = error as {
    code?: unknown;
    status?: unknown;
    signal?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const facts = [
    typeof detail.code === "string" ? detail.code : null,
    typeof detail.status === "number" ? `exit ${detail.status}` : null,
    typeof detail.signal === "string" ? `signal ${detail.signal}` : null,
    detail.stderr === undefined ? null : String(detail.stderr).trim(),
    typeof detail.message === "string" ? detail.message : null,
  ].filter((fact): fact is string => fact !== null && fact !== "");
  return facts.join(": ") || "unknown git failure";
}

function canonicalGitRoot(): CanonicalGitRootObservation {
  const candidate = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  try {
    const output = runGit(["rev-parse", "--show-toplevel"], { output: "text", cwd: candidate }).trim();
    return output !== "" && isAbsolute(output) && resolve(output) === output
      ? { kind: "repository", root: output }
      : {
          kind: "unavailable",
          cause: `git returned an invalid repository root from ${candidate}: ${JSON.stringify(output)}`,
        };
  } catch (error) {
    const cause = gitFailureCause(error);
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
    return /fatal: not a git repository(?: \([^\n]*\))?/i.test(stderr)
      ? { kind: "not-a-repository", cause }
      : { kind: "unavailable", cause };
  }
}

function resolveManifestProjectRoot(
  statePath: string,
  repositoryRoot: CanonicalGitRootObservation,
): ResolvedProjectRoot {
  if (repositoryRoot.kind === "not-a-repository") return projectRootFromCanonicalStatePath(statePath);
  return repositoryRoot.kind === "repository"
    ? { ok: true, value: repositoryRoot.root }
    : {
        ok: false,
        error: `cannot resolve Git repository root for verification manifest authority: ${repositoryRoot.cause}`,
      };
}

function prepareVerificationManifest(
  statePath: string,
  repositoryRoot: CanonicalGitRootObservation,
): PreparedManifest {
  const projectRoot = resolveManifestProjectRoot(statePath, repositoryRoot);
  if (!projectRoot.ok) return projectRoot;
  const manifestDirectory = join(projectRoot.value, dirname(VERIFICATION_MANIFEST_SOURCE_PATH));
  const manifestPath = join(projectRoot.value, VERIFICATION_MANIFEST_SOURCE_PATH);
  const directoryProblem = inspectManifestDirectory(manifestDirectory);
  if (directoryProblem?.kind === "default") return { ok: true, value: directoryProblem.value };
  if (directoryProblem?.kind === "error") return { ok: false, error: directoryProblem.error };
  const file = readManifestFile(manifestPath);
  if (file.kind === "default") return { ok: true, value: file.value };
  if (file.kind === "error") return { ok: false, error: file.error };
  const parsed = freezeVerificationManifest(file.value);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: `${manifestPath} is invalid: ${parsed.error.errors.join("; ")}` };
}

/** Absent is a distinct fact from captured: the degraded case leaves the first
 *  dispatch stamping its own boundary instead of inventing one here, and the
 *  graph persists its cause as `proof_boundary_observation`, which the
 *  population result renders so the weaker boundary stays visible. */
const proofBoundaryAbsent = (cause: string): PopulationProofBoundary => Object.freeze({ kind: "absent", cause });

/** An unreadable Git object or declared artifact, which baseline capture
 *  reports as a plain `Error` (including a failed `git` child) — as opposed to
 *  a programming defect inside capture (a non-`Error` throw, or a `TypeError`,
 *  `ReferenceError`, `RangeError` or `SyntaxError`). A defect must not pass as
 *  a benign absence, so only this class degrades the boundary. */
const isUnreadableCaptureSource = (error: unknown): error is Error =>
  error instanceof Error && !(error instanceof TypeError || error instanceof ReferenceError ||
    error instanceof RangeError || error instanceof SyntaxError);

/** Capture each Task's declared-artifact proof boundary from GIT at the exact
 *  repository HEAD, BEFORE any work exists, so the boundary always predates the
 *  Task's production (INV-DF1). Degraded to absent when Git, the exact HEAD, or
 *  a declared artifact is unreadable — the first dispatch then stamps its own
 *  boundary rather than a partially captured one. A defect inside capture
 *  propagates and fails population instead. */
function captureProofBoundary(
  repositoryRoot: CanonicalGitRootObservation,
  tasks: readonly [AuthoredTask, ...AuthoredTask[]],
): PopulationProofBoundary {
  if (repositoryRoot.kind !== "repository") {
    return proofBoundaryAbsent(`no Git repository root: ${repositoryRoot.cause}`);
  }
  const head = observeExactHead(repositoryRoot.root);
  if (!head.ok) return proofBoundaryAbsent(head.error);
  try {
    return Object.freeze({
      kind: "captured",
      baselines: new Map(tasks.map((task) => [
        task.id,
        captureDeclaredArtifactBaselineAtRevision(repositoryRoot.root, head.headSha, task.file_list),
      ])),
      revision: head.headSha,
    });
  } catch (error) {
    if (!isUnreadableCaptureSource(error)) throw error;
    return proofBoundaryAbsent(error.message);
  }
}

/** Validated CLI authority supplied to the population shell. */
type PopulateArgs = Readonly<{
  issue?: number;
  repo?: string;
  fix: boolean;
  force: boolean;
}>;

type ParsedPopulateArgs =
  | Readonly<{ ok: true; value: PopulateArgs }>
  | Readonly<{ ok: false; error: string }>;

function parseArgs(args: string[]): ParsedPopulateArgs {
  const issueFlagPresent = hasFlag(args, "--issue");
  const rawIssue = argumentValue(args, "--issue");
  if (issueFlagPresent && rawIssue === null) {
    return { ok: false, error: "--issue requires a positive integer value" };
  }
  if (rawIssue !== null && !/^[1-9]\d*$/.test(rawIssue)) {
    return { ok: false, error: `--issue must be a positive integer, got '${rawIssue}'` };
  }
  const issue = rawIssue === null ? undefined : Number(rawIssue);
  if (issue !== undefined && !Number.isSafeInteger(issue)) {
    return { ok: false, error: `--issue must be a safe positive integer, got '${rawIssue}'` };
  }
  const repo = argumentValue(args, "--repo");
  return {
    ok: true,
    value: {
      ...(issue === undefined ? {} : { issue }),
      ...(repo === null ? {} : { repo }),
      fix: hasFlag(args, "--fix"),
      force: hasFlag(args, "--force"),
    },
  };
}

/** A population the plan design gate and `populateTaskGraph` both allowed, or the first refusal. */
type LockedPopulation =
  | Extract<TaskGraphPopulationResult, { ok: true }>
  | Readonly<{ ok: false; message: string }>;

/** Port: the one read population makes of the plan, the binding check's own. */
type ReadPlan = PlanBindingDeps["readPlan"];

const bindingFailure = (errors: readonly string[]): HookResult => ({
  kind: "error",
  message: [
    `Executable-model binding validation FAILED (${errors.length} errors) — task graph not populated:`,
    ...errors.map((e) => `  - ${e}`),
  ].join("\n"),
});

/** What population wrote: the roster size, the engine-added distill passes among it, and the Waves. */
function populationSummary({ state, waves }: Extract<TaskGraphPopulationResult, { ok: true }>["value"]): string {
  const distill = state.tasks.filter(isDistillTask).map(({ id }) => id);
  const added = distill.length === 0 ? "" : ` (${distill.length} engine-added distill pass: ${distill.join(", ")})`;
  return `Task graph populated: ${state.tasks.length} tasks${added}, waves: ${waves.join(", ")}`;
}

/**
 * Decompose stdin is agent-controlled text: it may DESCRIBE work (id,
 * description, agent, wave, deps, Requirement Completion Claims,
 * Contributions, test requirements, file list) but must never carry execution state. The decompose-contract fields
 * are picked explicitly (never spread) so a payload that pre-stamps
 * `test_result: {verdict: "trusted-pass"}`, `status: "completed"`, or
 * `review_status: "passed"` cannot reach the persisted graph — trusted
 * verdicts exist only via the evidence ledger, mirroring the refusal in
 * store-test-evidence.
 */
async function populateFromDecompose(readPlan: ReadPlan, stdin: string, args: string[]): Promise<HookResult> {
  // Resolved at call time (not import time) so env re-pointing is honored.
  const statePath = taskGraphPath();
  const mgr = StateManager.fromPath(statePath);
  if (!mgr) return { kind: "error", message: `No task graph at ${statePath}` };

  const parsedArgs = parseArgs(args);
  if (!parsedArgs.ok) return { kind: "error", message: `populate-task-graph: ${parsedArgs.error}` };

  const admitted = admitDecompose(stdin, parsedArgs.value.fix);
  if (!admitted.ok) return admitted.result;
  const { payload, decompose } = admitted.value;
  const existing = loadExistingState(mgr, statePath);
  if (!existing.ok) return existing.result;
  const plan = readCheckedPlan(readPlan, existing.value, decompose, payload);
  if (!plan.ok) return plan.result;
  const prepared = preparePopulation(statePath, existing.value, decompose, plan.value, parsedArgs.value);
  if (!prepared.ok) return prepared.result;
  const applied = await applyPopulation(mgr, existing.value, prepared.value.command, plan.value);
  return applied.ok ? populatedResult(applied.value, prepared.value.manifest) : applied.result;
}

/** One step of population: its value, or the result that ends the run. */
type PopulationStep<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; result: HookResult }>;

const refusal = (message: string): PopulationStep<never> => ({ ok: false, result: { kind: "error", message } });

const bulleted = (errors: readonly string[]): string => errors.map((e) => `  - ${e}`).join("\n");

type AdmittedDecompose = Readonly<{ payload: DecomposeEnvelope; decompose: DecomposeInput }>;

/** The decompose payload stdin carried, validated (repaired first under `--fix`), and the typed input read from it. */
function admitDecompose(stdin: string, fix: boolean): PopulationStep<AdmittedDecompose> {
  let stdinJson: unknown;
  try {
    stdinJson = JSON.parse(stdin);
  } catch (e) {
    // Preserve the parse error: "Invalid JSON on stdin" alone left the operator
    // with no position or malformed token to look for.
    return refusal(`Invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`);
  }
  const authored = parseDecomposeEnvelope(stdinJson);
  if (!authored.ok) return refusal(authored.error);

  // Validate decompose output before merging. Scoped to the PAYLOAD: the
  // findings aggregate is agent-forgeable here and core `populatedTask`
  // strips it during population, so holding this to the load-boundary findings
  // rules would reject exactly the input that sanitization exists to clean.
  let payload: DecomposeEnvelope = authored.value;
  const validation = validateFull(payload, "decompose-payload");
  if (!validation.ok) {
    if (!fix) return refusal(`Decompose validation failed:\n${bulleted(validation.errors)}`);
    const repaired = repairDecompose(payload, validation.errors.length);
    if (!repaired.ok) return repaired;
    payload = repaired.value;
  }
  // The typed input is read from the validated payload, never asserted of it.
  const decoded = parseDecomposeInput(payload);
  return decoded.ok
    ? { ok: true, value: { payload, decompose: decoded.value } }
    : refusal(`Decompose validation failed:\n  - ${decoded.error}`);
}

/** `--fix`: the repaired payload, re-validated, after announcing each repair. */
function repairDecompose(payload: DecomposeEnvelope, issues: number): PopulationStep<DecomposeEnvelope> {
  const repair = fixFull(payload);
  for (const note of repair.notes) process.stderr.write(`  ${note}\n`);
  const repairedJson: unknown = JSON.parse(repair.json);
  const repaired = parseDecomposeEnvelope(repairedJson);
  if (!repaired.ok) return refusal(`--fix could not repair all issues:\n  - ${repaired.error}`);
  // fixFull normalizes repairable graph/task fields and findings/review
  // state; structural errors (unknown agent, wave gaps, self-dependency)
  // remain unfixable. Re-validate
  // so they fail loudly instead of reaching the persisted graph under a
  // misleading "Auto-fixed" banner.
  const revalidation = validateFull(repaired.value, "decompose-payload");
  if (!revalidation.ok) return refusal(`--fix could not repair all issues:\n${bulleted(revalidation.errors)}`);
  process.stderr.write(`Auto-fixed ${issues} issues\n`);
  return { ok: true, value: repaired.value };
}

function loadExistingState(mgr: StateManager, statePath: string): PopulationStep<TaskGraph> {
  try {
    return { ok: true, value: mgr.load() };
  } catch (error) {
    return refusal(`Cannot read task graph at ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Executable-models policy: bindings are enforced here fail-closed —
 * validate-task-graph's 4a run is advisory to the orchestrator, this is the
 * gate for the populate path. `repair-task-graph` is the ONE other
 * whitelisted helper that writes tasks into active_task_graph.json (it
 * installs through StateManager.replace, bypassing load() by design), and it
 * runs the same `checkPlanModelBindings` for the same reason; neither path
 * may install a graph whose bindings were never checked. The plan path
 * prefers evidence-derived state (plan_file set by advance-phase from
 * transcript-parsed Write tool calls (existence-checked), else the
 * architecture phase artifact recorded from disk) over the decompose
 * payload, so a decompose agent cannot re-point plan_file at a model-free
 * file to disarm the check. The SAME resolved path is persisted —
 * persisting the payload's path would disarm the wave-gate lifecycle check.
 *
 * The plan is read ONCE, through `readPlan`, by the binding check itself: it
 * validates these bytes, and the `ParsedPlan` it returns carries the export
 * bindings population stamps and the digest the plan design gate compares, all
 * from the same bytes, so a plan edited between them can never stamp bindings
 * that were not checked nor pass a review of other bytes.
 */
function readCheckedPlan(
  readPlan: ReadPlan,
  existingState: TaskGraph,
  decompose: DecomposeInput,
  payload: DecomposeEnvelope,
): PopulationStep<ParsedPlan> {
  const bindings = checkPlanModelBindings(
    existingState.plan_file ?? existingState.phase_artifacts?.architecture ?? decompose.plan_file,
    payload.tasks.filter(isRecord),
    { ...productionModelBindingDeps, readPlan },
  );
  return bindings.ok ? { ok: true, value: bindings.plan } : { ok: false, result: bindingFailure(bindings.errors) };
}

type PreparedPopulation = Readonly<{ command: TaskGraphPopulationCommand; manifest: FrozenVerificationManifest }>;

/**
 * Everything the locked transform stamps, observed once in the repository
 * shell before lock acquisition: operator command authority (the verification
 * manifest), the Spec Index and each Task's proof boundary. The locked
 * transform carries these prepared values; it never re-reads mutable source
 * bytes and never consults decompose input.
 */
function preparePopulation(
  statePath: string,
  existingState: TaskGraph,
  decompose: DecomposeInput,
  plan: ParsedPlan,
  args: PopulateArgs,
): PopulationStep<PreparedPopulation> {
  const repositoryRoot = canonicalGitRoot();
  const preparedManifest = prepareVerificationManifest(statePath, repositoryRoot);
  if (!preparedManifest.ok) return refusal(`Verification manifest authority unavailable: ${preparedManifest.error}`);
  const observationProblem = acceptanceObservationProblem(plan.models.contracts, preparedManifest.value.projectChecks);
  if (observationProblem !== null) return refusal(observationProblem);

  const observedSpecFile = resolvedSpecFile(existingState.spec_file, decompose.spec_file);
  const specIndex = observeAnnouncedSpecIndex(observedSpecFile);

  const taskRoster = parseAuthoredTaskRoster(decompose.tasks);
  if (!taskRoster.ok) return refusal(taskRoster.error);

  // The graph is created at planning BEFORE any work exists, so the proof
  // boundary always predates production.
  const proofBoundary = captureProofBoundary(repositoryRoot, taskRoster.value);
  return { ok: true, value: {
    manifest: preparedManifest.value,
    command: populationCommand(decompose, plan, args, {
      tasks: taskRoster.value, verificationManifest: preparedManifest.value, specIndex, observedSpecFile, proofBoundary,
    }),
  } };
}

/**
 * The Spec Index for `observedSpecFile`. The transform refuses a declared spec
 * it cannot index and any Requirement id the index does not define; only a
 * plan with no spec_file and no Requirement trace reaches the warning here.
 */
function observeAnnouncedSpecIndex(observedSpecFile: string | null): ReturnType<typeof observeSpecIndex> {
  const specIndex = observeSpecIndex(observedSpecFile);
  if (specIndex.kind === "unavailable") {
    process.stderr.write(
      `Requirement content hashes NOT recorded: ${specIndexUnavailableMessage(specIndex.reason)}\n` +
      "If a later Wave Gate projects the Spec, drift will be unverifiable; continued projection unavailability blocks settlement.\n",
    );
  }
  return specIndex;
}

/** The values observed in the shell for one population command. */
type ObservedPopulation = Pick<
  TaskGraphPopulationCommand,
  "tasks" | "verificationManifest" | "specIndex" | "observedSpecFile" | "proofBoundary"
>;

function populationCommand(
  decompose: DecomposeInput,
  plan: ParsedPlan,
  { issue, repo, force }: PopulateArgs,
  observed: ObservedPopulation,
): TaskGraphPopulationCommand {
  return Object.freeze({
    ...observed,
    planTitle: decompose.plan_title,
    validatedPlanFile: plan.path,
    ...(decompose.spec_file === undefined ? {} : { authoredSpecFile: decompose.spec_file }),
    force,
    ...(issue === undefined ? {} : { issue }),
    ...(repo === undefined ? {} : { repo }),
    contracts: plan.models.contracts,
    // Validated by checkPlanModelBindings (exemptions included), so the
    // locked transform stamps Owner Obligations from proven plan data.
    invariants: plan.models.invariants,
    // Validated by checkPlanModelBindings from the same plan bytes;
    // population re-validates them against the roster before stamping.
    exportBindings: plan.exportBindings,
  });
}

type PopulatedGraph = Extract<TaskGraphPopulationResult, { ok: true }>["value"];

/**
 * The plan design gate (ADR-0070) is asked here too, not only on the
 * decompose spawn: first population is the transition that cuts Tasks from
 * the plan, whoever wrote the payload. It is asked of the graph as it is
 * before the lock and again of the graph read under it.
 */
async function applyPopulation(
  mgr: StateManager,
  existingState: TaskGraph,
  command: TaskGraphPopulationCommand,
  plan: ParsedPlan,
): Promise<PopulationStep<PopulatedGraph>> {
  const populate = (existing: TaskGraph): LockedPopulation => {
    const designRequirement = populationPlanDesignRequirement(existing, plan.sha256, plan.path);
    if (designRequirement !== null) {
      return { ok: false, message: `populate-task-graph: TaskGraph population requires ${designRequirement}` };
    }
    const transition = populateTaskGraph(existing, command);
    return transition.ok ? transition : { ok: false, message: transition.error.message };
  };
  const preflight = populate(existingState);
  if (!preflight.ok) return refusal(preflight.message);

  let applied: LockedPopulation;
  try {
    applied = await mgr.updateAndReturn<LockedPopulation>((existing) => {
      const transition = populate(existing);
      return transition.ok
        ? { state: transition.value.state, value: transition }
        : { state: existing, value: transition };
    });
  } catch (error) {
    return refusal(error instanceof Error ? error.message : String(error));
  }
  return applied.ok ? { ok: true, value: applied.value } : refusal(applied.message);
}

/** What population reports: the summary and notices on stderr, the frozen verification coverage to the session. */
function populatedResult(populated: PopulatedGraph, manifest: FrozenVerificationManifest): HookResult {
  process.stderr.write(`${populationSummary(populated)}\n`);
  // Rendered from the persisted observation, the one record later readers see.
  const observation = populated.state.proof_boundary_observation;
  const boundaryNotice = observation === undefined ? null : renderProofBoundaryNotice(observation);
  if (boundaryNotice !== null) process.stderr.write(`${boundaryNotice}\n`);
  // A roster the planner gave no distill pass for a reason the operator did
  // not choose says so, beside the summary that shows none was added.
  const distillNote = distillPlanNote(populated.distillPlan);
  if (distillNote !== null) process.stderr.write(`${distillNote}\n`);

  return {
    kind: "passthrough",
    systemMessage: renderProjectVerificationCoverage(deriveProjectVerificationCoverage(manifest)) +
      ` Install ${VERIFICATION_MANIFEST_SOURCE_PATH} before population to configure project checks; ` +
      "later source edits do not change this TaskGraph's frozen authority." +
      (boundaryNotice === null ? "" : ` ${boundaryNotice}`) +
      (distillNote === null ? "" : ` ${distillNote}`),
  };
}

/** The populate helper over `readPlan`, the one read it makes of the plan; production reads the file. */
export const createPopulateTaskGraphHandler = (readPlan: ReadPlan = productionModelBindingDeps.readPlan): HookHandler =>
  (stdin, args) => populateFromDecompose(readPlan, stdin, args);

export default createPopulateTaskGraphHandler();
