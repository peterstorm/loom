/**
 * Every repository path class the engine writes or protects, in one place
 * (loom#198, Cause 2). Two bugs (#192, #196) were one bug in two observers
 * that each kept their own list; a third list had drifted (remediation
 * excluded the Claude Code state directory but not Pi's). The workspace
 * digest, defect accounting and remediation staging ask `engineOwnedPathClass`
 * and exclude the classes they mean; config, the populate and manifest
 * helpers, the Wave Gate runs roots and Pi's review witness take their paths
 * from here. The lint rule
 * `.claude/linter/rules/inv-10-one-engine-owned-path-module.json` refuses a
 * module that restates one of these paths in code.
 *
 * Task scope judges a different thing: the State File's own write companions
 * (its lock and staging leaves), anchored to one selected State File, which
 * `engine-runtime-paths.ts` defines.
 *
 * Pure: path arithmetic only, no filesystem access.
 */

import { dirname, join } from "node:path";
import { frozenSet } from "./frozen";

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
export const RUN_LAYOUT_COMPONENTS: ReadonlySet<string> = frozenSet<string>(RUN_LAYOUTS);
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
/** The canonical State File locations as an operator reads them in a refusal. */
export const CANONICAL_TASK_GRAPH_LOCATIONS_TEXT = CANONICAL_TASK_GRAPH_PATHS.map((path) => `<root>/${path}`).join(" or ");

/**
 * The project root of an absolute State File path at one of the canonical
 * locations, or null when it is at none: the root is three directories up,
 * and the path must be exactly `<root>/<harness>/state/<file>`.
 */
export function projectRootOfCanonicalStatePath(absoluteStatePath: string): string | null {
  const projectRoot = dirname(dirname(dirname(absoluteStatePath)));
  return CANONICAL_TASK_GRAPH_PATHS.some((path) => join(projectRoot, ...path.split("/")) === absoluteStatePath) ? projectRoot : null;
}

/** A canonical runs root of one harness (`<harness>/reviews/<layout>`), as an operator passes it to `--runs-root`. */
export const canonicalRunsRoot = (harness: HarnessDirectoryName, layout: RunLayout): string =>
  harnessPath(harness, REVIEWS_DIRECTORY_NAME, layout);

/** The runs root of `layout` beside an absolute State File: `<harness>/reviews/<layout>` of the State File's harness directory. */
export const runsRootBesideStateFile = (absoluteStatePath: string, layout: RunLayout): string =>
  join(dirname(dirname(absoluteStatePath)), REVIEWS_DIRECTORY_NAME, layout);

/** Git's own metadata directory. */
export const GIT_METADATA_ROOT = ".git" as const;

/** Where the completion suite and the engine runners write their reports. */
export const COMPLETION_REPORT_ROOT = ".loom/completion-reports" as const;

/**
 * What counts as Loom evidence, as data: the roots whose every path is
 * evidence, and the Run Directory layouts that are evidence anywhere under a
 * harness directory. `isEngineEvidencePath` interprets exactly this table, and
 * remediation records the digest of exactly this table, so a change to what is
 * evidence is a change of the recorded policy.
 */
export const ENGINE_EVIDENCE_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  gitMetadataRoot: GIT_METADATA_ROOT,
  stateRoots: HARNESS_STATE_DIRECTORIES,
  runDirectoryRoots: RUN_DIRECTORY_ROOTS,
  runLayoutsUnder: Object.freeze({ harnesses: HARNESS_DIRECTORY_NAMES, layouts: RUN_LAYOUTS }),
});

/** What the engine owns a path as, so each observer excludes the classes it means. */
export type EngineOwnedPathClass = "git-metadata" | "harness-state" | "run-directory" | "completion-report";

const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

const isUnderRunLayout = (path: string): boolean => {
  const [first, ...rest] = path.split("/");
  const { harnesses, layouts } = ENGINE_EVIDENCE_POLICY.runLayoutsUnder;
  return (harnesses as readonly string[]).includes(first ?? "") && rest.some((part) => (layouts as readonly string[]).includes(part));
};

/** The class the engine owns a repository-relative POSIX `path` as, or null when it is project content. */
export function engineOwnedPathClass(path: string): EngineOwnedPathClass | null {
  if (isWithin(path, ENGINE_EVIDENCE_POLICY.gitMetadataRoot)) return "git-metadata";
  if (ENGINE_EVIDENCE_POLICY.stateRoots.some((root) => isWithin(path, root))) return "harness-state";
  if (ENGINE_EVIDENCE_POLICY.runDirectoryRoots.some((root) => isWithin(path, root)) || isUnderRunLayout(path)) return "run-directory";
  if (isWithin(path, COMPLETION_REPORT_ROOT)) return "completion-report";
  return null;
}

/** Whether `path` is Loom evidence no Task, remediation or sibling may claim: Git metadata, harness state or a run directory. */
export const isEngineEvidencePath = (path: string): boolean => {
  const owned = engineOwnedPathClass(path);
  return owned === "git-metadata" || owned === "harness-state" || owned === "run-directory";
};
