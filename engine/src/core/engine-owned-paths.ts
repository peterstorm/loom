/**
 * Every repository path class the engine writes or protects, in one place
 * (loom#198, Cause 2). Two bugs (#192, #196) were one bug in two observers
 * that each kept their own list; a third list had already drifted (remediation
 * excluded the Claude Code state directory but not Pi's). Every workspace observer
 * (Task scope, the workspace digest, defect accounting, remediation staging)
 * now asks `engineOwnedPathClass` and excludes the classes it means, and the
 * lint rule `.claude/linter/rules/inv-10-one-engine-owned-path-module.json`
 * refuses a module that restates one of these literals.
 *
 * The State File's own write companions (its lock and staging leaves) are
 * anchored to one selected State File, not to a directory, so they stay in
 * `engine-runtime-paths.ts`, which takes its file names from here.
 *
 * Pure and total over repository-relative POSIX paths.
 */

/** The harnesses whose project directory holds Loom state and run evidence. */
export const HARNESS_DIRECTORY_NAMES = Object.freeze([".claude", ".pi"] as const);
export type HarnessDirectoryName = (typeof HARNESS_DIRECTORY_NAMES)[number];

/** The directory inside a harness directory that holds the State File. */
export const STATE_DIRECTORY_NAME = "state" as const;
/** The directory inside a harness directory that holds Review Packets and Run Directories. */
export const REVIEWS_DIRECTORY_NAME = "reviews" as const;
/** The State File's name inside a state directory. */
export const TASK_GRAPH_FILE_NAME = "active_task_graph.json" as const;

/**
 * The directory names that hold Run Directories wherever they appear under a
 * harness directory (`<harness>/specs/<spec>/panel-runs` included). One
 * definition: remediation keeps run evidence out of a staged set with it, and
 * `grandfathered-spawn-model` anchors a spawn-declared run directory with it.
 */
export const RUN_LAYOUTS = Object.freeze([
  "panel-runs",
  "review-runs",
  "review-and-fix-runs",
  "wave-gate-runs",
  "orchestration-runs",
] as const);
export type RunLayout = (typeof RUN_LAYOUTS)[number];
export const RUN_LAYOUT_COMPONENTS: ReadonlySet<string> = Object.freeze(new Set<string>(RUN_LAYOUTS));
/** The Wave Gate runs root's directory name inside a reviews directory. */
export const WAVE_GATE_RUNS: RunLayout = "wave-gate-runs";
/** The review-and-fix runs root's directory name inside a reviews directory. */
export const REVIEW_AND_FIX_RUNS: RunLayout = "review-and-fix-runs";

const harnessPath = (harness: HarnessDirectoryName, ...parts: readonly string[]): string => [harness, ...parts].join("/");

/** `<harness>/state`, for each harness. */
export const HARNESS_STATE_DIRECTORIES: readonly string[] = Object.freeze(
  HARNESS_DIRECTORY_NAMES.map((harness) => harnessPath(harness, STATE_DIRECTORY_NAME)),
);
/** `<harness>/reviews`, for each harness. */
export const RUN_DIRECTORY_ROOTS: readonly string[] = Object.freeze(
  HARNESS_DIRECTORY_NAMES.map((harness) => harnessPath(harness, REVIEWS_DIRECTORY_NAME)),
);

/** The canonical State File path of one harness. */
export const canonicalTaskGraphPath = (harness: HarnessDirectoryName): string =>
  harnessPath(harness, STATE_DIRECTORY_NAME, TASK_GRAPH_FILE_NAME);
/** Every canonical State File path, Claude Code's first. */
export const CANONICAL_TASK_GRAPH_PATHS: readonly string[] = Object.freeze(HARNESS_DIRECTORY_NAMES.map(canonicalTaskGraphPath));

/** A canonical runs root of one harness (`<harness>/reviews/<layout>`), as an operator passes it to `--runs-root`. */
export const canonicalRunsRoot = (harness: HarnessDirectoryName, layout: RunLayout): string =>
  harnessPath(harness, REVIEWS_DIRECTORY_NAME, layout);

/** Git's own metadata directory. */
export const GIT_METADATA_ROOT = ".git" as const;

/** Where the completion suite and the engine runners write their reports. */
export const COMPLETION_REPORT_ROOT = ".loom/completion-reports" as const;

/** What the engine owns a path as, so each observer excludes the classes it means. */
export type EngineOwnedPathClass = "git-metadata" | "harness-state" | "run-directory" | "completion-report";

const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

const isUnderRunLayout = (path: string): boolean => {
  const [first, ...rest] = path.split("/");
  return (HARNESS_DIRECTORY_NAMES as readonly string[]).includes(first ?? "") && rest.some((part) => RUN_LAYOUT_COMPONENTS.has(part));
};

/** The class the engine owns `path` as, or null when it is project content. */
export function engineOwnedPathClass(path: string): EngineOwnedPathClass | null {
  if (isWithin(path, GIT_METADATA_ROOT)) return "git-metadata";
  if (HARNESS_STATE_DIRECTORIES.some((root) => isWithin(path, root))) return "harness-state";
  if (RUN_DIRECTORY_ROOTS.some((root) => isWithin(path, root)) || isUnderRunLayout(path)) return "run-directory";
  if (isWithin(path, COMPLETION_REPORT_ROOT)) return "completion-report";
  return null;
}

/** Whether `path` is Loom evidence no Task, remediation or sibling may claim: Git metadata, harness state or a run directory. */
export const isEngineEvidencePath = (path: string): boolean => {
  const owned = engineOwnedPathClass(path);
  return owned === "git-metadata" || owned === "harness-state" || owned === "run-directory";
};
