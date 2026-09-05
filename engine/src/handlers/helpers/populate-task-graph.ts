/**
 * Populate task graph with decompose output.
 * Merges existing phase tracking with new tasks.
 *
 * Usage: bun cli.ts helper populate-task-graph [--issue N] [--repo OWNER/REPO] [--fix] [--force]
 * Reads decompose JSON from stdin. `--force` permits replacing Tasks that have
 * already left pending; without it both the pre-lock and locked guards refuse.
 */

import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HookHandler, TaskGraph, Task, WaveGate } from "../../types";
import { newWaveGate } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { validateFull, fixFull } from "./validate-task-graph";
import { checkPlanModelBindings, productionModelBindingDeps } from "./validate-model-bindings";
import { derivePendingTaskProof } from "../../core/proof-obligations";
import { argumentValue, hasFlag } from "./cli-args";
import {
  serializeVerificationPolicy,
  taskVerificationPolicy,
} from "../../core/verification-policy";
import {
  VERIFICATION_MANIFEST_SOURCE_PATH,
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../core/verification-manifest";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { observeSpecIndex } from "../../orchestration/spec-index-observation";
import {
  recordedAnchorHashes,
  specIndexUnavailableMessage,
  type SpecIndexAvailability,
} from "../../core/requirement-coverage";

type AuthoredTask = Readonly<
  Pick<
    Task,
    | "id"
    | "description"
    | "agent"
    | "wave"
    | "depends_on"
    | "spec_anchors"
    | "spec_contributions"
    | "plan_context"
  > & {
    verification_policy: NonNullable<Task["verification_policy"]>;
    file_list: readonly string[];
  }
>;

interface DecomposeInput {
  spec_trace_version: 2;
  plan_title: string;
  plan_file?: string;
  spec_file?: string;
  tasks: readonly AuthoredTask[];
}

/**
 * The one spec_file precedence, used by the pre-lock Spec Index observation, by
 * the in-lock guard that compares against it, and by the value actually
 * persisted.
 *
 * Three hand-written copies of a `??` chain is how the prepared Spec Index and
 * the graph it is stamped onto drift apart: the guard can only be honest if it
 * compares the same derivation the other two used.
 */
export function resolvedSpecFile(
  existing: string | null | undefined,
  authored: string | undefined,
): string | null {
  return existing ?? authored ?? null;
}

const DECOMPOSE_FIELDS = new Set(["spec_trace_version", "plan_title", "plan_file", "spec_file", "tasks"]);

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

function defaultManifestIfMissing(path: string, error: unknown): ManifestFile | null {
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
    const missing = defaultManifestIfMissing(manifestPath, error);
    if (missing !== null) return missing;
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
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
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

function resolveManifestProjectRoot(statePath: string): ResolvedProjectRoot {
  const repositoryRoot = canonicalGitRoot();
  if (repositoryRoot.kind === "not-a-repository") return projectRootFromCanonicalStatePath(statePath);
  return repositoryRoot.kind === "repository"
    ? { ok: true, value: repositoryRoot.root }
    : {
        ok: false,
        error: `cannot resolve Git repository root for verification manifest authority: ${repositoryRoot.cause}`,
      };
}

function prepareVerificationManifest(statePath: string): PreparedManifest {
  const projectRoot = resolveManifestProjectRoot(statePath);
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

/**
 * Through `cli-args`, not by hand: the hand-rolled loop this replaced accepted
 * the NEXT FLAG as a value, so `--issue --fix` read as `issue = NaN` with
 * `--fix` silently consumed — the exact divergence `argumentValue` exists to
 * end.
 */
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
function sanitizeDecomposedTask(t: AuthoredTask, specIndex: SpecIndexAvailability): Task {
  const verificationPolicy = taskVerificationPolicy(t);
  const completionAnchors = Object.freeze([...(t.spec_anchors ?? [])]);
  // Engine-derived, exactly like the verification manifest above it: decompose
  // says WHICH Requirements a Task completes, the specification's own bytes say
  // what those Requirements SAID. `AuthoredTask` cannot carry hashes, so a
  // decompose payload that pre-stamps them is dropped with every other field
  // this function does not pick.
  const anchorHashes = specIndex.kind === "indexed"
    ? recordedAnchorHashes(specIndex.index, completionAnchors)
    : {};
  return {
    id: t.id,
    description: t.description,
    agent: t.agent,
    wave: t.wave,
    status: "pending",
    depends_on: t.depends_on ?? [],
    spec_anchors: completionAnchors,
    spec_contributions: Object.freeze([...(t.spec_contributions ?? [])]),
    ...(Object.keys(anchorHashes).length === 0 ? {} : { spec_anchor_hashes: anchorHashes }),
    verification_policy: serializeVerificationPolicy(verificationPolicy),
    ...(t.plan_context !== undefined ? { plan_context: t.plan_context } : {}),
    ...(t.file_list !== undefined ? { file_list: t.file_list } : {}),
    proof: derivePendingTaskProof({
      verificationPolicy,
      declaredArtifacts: t.file_list ?? [],
    }),
    review_status: "pending",
    review_generation: 0,
    findings: [],
    critical_findings: [],
    advisory_findings: [],
    refuted_findings: [],
    resolved_findings: [],
  };
}

function taskWaves(tasks: readonly AuthoredTask[]): readonly number[] {
  return [...new Set(tasks.map((task) => task.wave))].sort((left, right) => left - right);
}

/** Build wave gates for all waves */
function buildWaveGates(waves: readonly number[]): Record<string, WaveGate> {
  const gates: Record<string, WaveGate> = {};
  for (const w of waves) {
    gates[String(w)] = newWaveGate();
  }
  return gates;
}

const handler: HookHandler = async (stdin, args) => {
  // Resolved at call time (not import time) so env re-pointing is honored.
  const statePath = taskGraphPath();
  const mgr = StateManager.fromPath(statePath);
  if (!mgr) return { kind: "error", message: `No task graph at ${statePath}` };

  const parsedArgs = parseArgs(args);
  if (!parsedArgs.ok) return { kind: "error", message: `populate-task-graph: ${parsedArgs.error}` };
  const { issue, repo, fix, force } = parsedArgs.value;

  let decompose: DecomposeInput;
  try {
    decompose = JSON.parse(stdin) as DecomposeInput;
  } catch (e) {
    // Preserve the parse error: "Invalid JSON on stdin" alone left the operator
    // with no position or malformed token to look for.
    return {
      kind: "error",
      message: `Invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (typeof decompose !== "object" || decompose === null || Array.isArray(decompose)) {
    return { kind: "error", message: "Decompose JSON must be an object" };
  }
  const surplusFields = Object.keys(decompose).filter((field) => !DECOMPOSE_FIELDS.has(field)).sort();
  if (surplusFields.length > 0) {
    return {
      kind: "error",
      message: `Decompose JSON contains unsupported field(s): ${surplusFields.join(", ")}`,
    };
  }
  if (!Array.isArray(decompose.tasks) || decompose.tasks.length === 0) {
    return { kind: "error", message: "No tasks in decompose JSON" };
  }

  // Validate decompose output before merging. Scoped to the PAYLOAD: the
  // findings aggregate is agent-forgeable here and `sanitizeDecomposedTask`
  // strips it below, so holding this to the load-boundary findings rules would
  // reject exactly the input that sanitization exists to clean.
  const validation = validateFull(decompose as unknown as Record<string, unknown>, "decompose-payload");
  if (!validation.ok) {
    if (fix) {
      const repair = fixFull(decompose as unknown as Record<string, unknown>);
      for (const note of repair.notes) process.stderr.write(`  ${note}\n`);
      decompose = JSON.parse(repair.json) as DecomposeInput;
      // fixFull normalizes repairable graph/task fields and findings/review
      // state; structural errors (unknown agent, wave gaps, self-dependency)
      // remain unfixable. Re-validate
      // so they fail loudly instead of reaching the persisted graph under a
      // misleading "Auto-fixed" banner.
      const revalidation = validateFull(decompose as unknown as Record<string, unknown>, "decompose-payload");
      if (!revalidation.ok) {
        return {
          kind: "error",
          message: `--fix could not repair all issues:\n${revalidation.errors.map(e => `  - ${e}`).join("\n")}`,
        };
      }
      process.stderr.write(`Auto-fixed ${validation.errors.length} issues\n`);
    } else {
      return { kind: "error", message: `Decompose validation failed:\n${validation.errors.map(e => `  - ${e}`).join("\n")}` };
    }
  }

  // Executable-models policy: bindings are enforced here fail-closed —
  // validate-task-graph's 4a run is advisory to the orchestrator, this is the
  // gate for the populate path. `repair-task-graph` is the ONE other
  // whitelisted helper that writes tasks into active_task_graph.json (it
  // installs through StateManager.replace, bypassing load() by design), and it
  // runs the same `checkPlanModelBindings` for the same reason; neither path
  // may install a graph whose bindings were never checked. The plan path
  // prefers evidence-derived
  // state (plan_file set by advance-phase from transcript-parsed Write tool
  // calls (existence-checked), else the
  // architecture phase artifact recorded from disk) over the decompose
  // payload, so a decompose agent cannot re-point plan_file at a model-free
  // file to disarm the check. The SAME resolved path is persisted below —
  // persisting the payload's path would disarm the wave-gate lifecycle check.
  let existingState: TaskGraph;
  try {
    existingState = mgr.load();
  } catch (error) {
    return {
      kind: "error",
      message: `Cannot read task graph at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const planFile =
    existingState.plan_file ??
    existingState.phase_artifacts?.architecture ??
    decompose.plan_file;
  const bindings = checkPlanModelBindings(
    planFile,
    decompose.tasks as unknown as Record<string, unknown>[],
    productionModelBindingDeps,
  );
  if (!bindings.ok) {
    return {
      kind: "error",
      message: [
        `Executable-model binding validation FAILED (${bindings.errors.length} errors) — task graph not populated:`,
        ...bindings.errors.map((e) => `  - ${e}`),
      ].join("\n"),
    };
  }
  // checkPlanModelBindings only passes when planFile is a readable string
  const validatedPlanFile = planFile as string;
  const waves = taskWaves(decompose.tasks);

  // Guard against overwriting non-pending tasks
  if (!force && existingState.tasks.some((t) => t.status !== "pending")) {
    return {
      kind: "error",
      message: "Cannot overwrite task graph with non-pending tasks. Use --force to override.",
    };
  }

  // Operator command authority is observed once in the repository shell before
  // lock acquisition. The locked transform below carries this prepared value;
  // it never re-reads mutable source bytes and never consults decompose input.
  const preparedManifest = prepareVerificationManifest(statePath);
  if (!preparedManifest.ok) {
    return { kind: "error", message: `Verification manifest authority unavailable: ${preparedManifest.error}` };
  }

  // The Spec Index is observed here, beside the manifest, for the same reason:
  // the locked transform stamps a prepared value and never reads mutable source
  // bytes itself. Unlike the manifest this one degrades — a project with no
  // canonical specification still decomposes, and every Requirement it claims
  // simply reports drift as unverifiable at the gate rather than as stable.
  const observedSpecFile = resolvedSpecFile(existingState.spec_file, decompose.spec_file);
  const specIndex = observeSpecIndex(observedSpecFile);
  if (specIndex.kind === "unavailable") {
    process.stderr.write(
      `Requirement content hashes NOT recorded: ${specIndexUnavailableMessage(specIndex.reason)}\n` +
      "Wave Gate spec-check will report Requirement drift as unverifiable for these Tasks.\n",
    );
  }

  const populate = async (): Promise<void> => mgr.update((existing) => {
    // Re-check the guard INSIDE the locked transform. The check above ran on a
    // snapshot loaded before the lock, and this callback receives a freshly
    // reloaded graph — so a task that left "pending" in between (an agent
    // starting, a wave completing) had its real status silently overwritten by
    // the unconditional `tasks:` assignment below. The pre-lock check stays: it
    // gives the operator the clean CLI error in the common case; this one makes
    // the overwrite impossible in the racing case.
    if (!force && existing.tasks.some((t) => t.status !== "pending")) {
      throw new Error(
        "Cannot overwrite task graph with non-pending tasks: a task left \"pending\" while this " +
        "population was being prepared. Use --force to override.",
      );
    }
    // The prepared Spec Index was read from the spec file this same precedence
    // named before the lock. If the locked graph now names a different one, the
    // prepared hashes describe another document — refuse rather than stamp
    // Requirement text that was never at these identifiers.
    const lockedSpecFile = resolvedSpecFile(existing.spec_file, decompose.spec_file);
    if (lockedSpecFile !== observedSpecFile) {
      throw new Error(
        `spec_file changed from ${observedSpecFile ?? "none"} to ${lockedSpecFile ?? "none"} while this ` +
        "population was being prepared; re-run populate-task-graph.",
      );
    }
    const { active_wave_completion_suite: staleCompletionSuite, ...existingWithoutCompletionSuite } = existing;
    void staleCompletionSuite;
    const merged: TaskGraph = {
      ...existingWithoutCompletionSuite,
      spec_trace_version: 2,
      plan_title: decompose.plan_title,
      plan_file: validatedPlanFile,
      spec_file: lockedSpecFile,
      tasks: decompose.tasks.map((task) => sanitizeDecomposedTask(task, specIndex)),
      current_wave: 1,
      executing_tasks: [],
      wave_gates: buildWaveGates(waves),
      verification_manifest: preparedManifest.value,
      ...(issue === undefined ? {} : { github_issue: issue }),
      ...(repo === undefined ? {} : { github_repo: repo }),
    };

    return merged;
  });

  try {
    await populate();
  } catch (error) {
    // The locked re-check refuses by throwing (the only way out of a transform);
    // surface it as the same clean CLI error the pre-lock check produces rather
    // than as an unhandled rejection.
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const taskCount = decompose.tasks.length;
  process.stderr.write(`Task graph populated: ${taskCount} tasks, waves: ${waves.join(", ")}\n`);

  return { kind: "passthrough" };
};

export default handler;
