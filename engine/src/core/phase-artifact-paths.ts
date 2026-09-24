/**
 * Which phase artifact a written path IS, and whether it is allowed to be one.
 *
 * Two harnesses record `spec_file`/`plan_file` from an agent's own write calls —
 * `handlers/subagent-stop/advance-phase` on Claude Code, `pi/extension`'s
 * `tool_result` handler on Pi. A recorded spec becomes the run authority;
 * architecture-plan transitions normally use the recorded plan but retain a
 * documented slug/date filesystem fallback when that field is absent or names
 * a missing file. Other access failures fail closed. Both harnesses used to
 * spell the classification rule inline, and
 * both spelled it as `String.includes(".claude/specs/")`:
 * a path like `.claude/specs/../../../../tmp/evil/spec.md` CONTAINS the
 * directory name while resolving well outside the tree, so the substring form
 * admits exactly the traversal it looks like it rejects.
 *
 * The rule lives here once, as resolved containment, so neither harness can
 * drift from it and neither needs a filesystem to be tested against it.
 *
 * Pure module: no I/O, no clock, no randomness. Path math only — nothing here
 * asks whether a path EXISTS, which is the shell's job and deliberately not a
 * precondition of classification.
 */

import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

/** Where a `spec.md` may live when the run declares no narrower `spec_dir`. */
export const SPEC_ARTIFACT_DIR = ".claude/specs";
/** Where a plan may live. Runs never narrow this one. */
export const PLAN_ARTIFACT_DIR = ".claude/plans";

/**
 * The project boundary that owns a state file: the directory containing
 * `.claude/`.
 *
 * Phase artifacts are stored as project-relative paths, so every filesystem
 * probe of one must resolve against THIS root — not `process.cwd()`. The
 * runtime's cwd names where the orchestrator happens to run (a parent session
 * rooted in the main checkout), while the graph names where the artifacts
 * live (a linked worktree); anchoring probes to cwd made phase advancement
 * look for the run's spec/plan in the wrong repository and refuse to advance.
 *
 * The canonical locations are `<root>/.claude/state/active_task_graph.json`
 * and `<root>/.pi/state/active_task_graph.json`; the legacy walk-up shape
 * places the file directly in the root. Only those shapes name a root: the
 * name-based fallback below refuses any other accepted pointer instead of
 * guessing a directory one level too high. Path math only — the same purity
 * contract as the rest of this module.
 */
export function projectRootForStateFile(statePath: string, repositoryRoot?: string): string {
  const absoluteStatePath = resolve(statePath);
  if (repositoryRoot !== undefined) {
    const root = resolve(repositoryRoot);
    if (!resolvesWithin(absoluteStatePath, root, root)) {
      throw new Error(`State File ${absoluteStatePath} is outside observed project root ${root}`);
    }
    return root;
  }
  const parent = dirname(absoluteStatePath);
  if (basename(parent) !== "state") return parent;
  const oneUp = dirname(parent);
  if (basename(oneUp) === ".claude" || basename(oneUp) === ".pi") return dirname(oneUp);
  throw new Error(
    `State File ${absoluteStatePath} is not at a documented canonical location ` +
    '(<root>/.claude/state/, <root>/.pi/state/, or directly in the root); refusing to derive a project boundary heuristically',
  );
}

declare const SPEC_ARTIFACT_DIRECTORY: unique symbol;
/** Parser-minted phase-artifact search authority beneath `.claude/specs`. */
export type SpecArtifactDirectory = string & { readonly [SPEC_ARTIFACT_DIRECTORY]: true };

export type SpecArtifactDirectoryParse =
  | Readonly<{ ok: true; value: SpecArtifactDirectory }>
  | Readonly<{ ok: false; message: string }>;

/** Parse untrusted persisted `spec_dir` before it can address the filesystem.
 *
 * Persisted phase directories are project-relative authority. An absolute
 * value is not repaired against whichever checkout the runtime happens to use:
 * it is refused before any shell can probe it.
 */
export function parseSpecArtifactDirectory(raw: string | null | undefined): SpecArtifactDirectoryParse {
  const candidate = raw ?? SPEC_ARTIFACT_DIR;
  if (isAbsolute(candidate) ||
      // Both sides are project-relative, so the containment comparison is
      // invariant in the base; the parse target itself is the explicit anchor
      // (never an ambient cwd default).
      (candidate !== SPEC_ARTIFACT_DIR && !resolvesWithin(candidate, SPEC_ARTIFACT_DIR, SPEC_ARTIFACT_DIR))) {
    return Object.freeze({
      ok: false,
      message: `spec_dir ${candidate} is outside ${SPEC_ARTIFACT_DIR} or is not project-relative`,
    });
  }
  return Object.freeze({ ok: true, value: candidate as SpecArtifactDirectory });
}

/**
 * Does `candidate` RESOLVE inside `directory` under one explicit project root?
 *
 * Lexical containment after `resolve`, so `..` segments are collapsed before
 * the comparison rather than being carried along inside a string that still
 * "contains" the directory name. Equality with the directory itself is not
 * containment — an artifact must be a file under it, not the directory.
 * `baseDir` is required: the TaskGraph Project Boundary every relative
 * candidate is resolved against. There is no cwd default — an omitted base
 * would silently reintroduce the cross-checkout drift this seam was built to
 * close.
 */
export function resolvesWithin(
  candidate: string,
  directory: string,
  baseDir: string,
): boolean {
  const within = (path: string): string => isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
  const fromDirectory = relative(within(directory), within(candidate));
  return fromDirectory !== "" &&
    fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`) &&
    !fromDirectory.startsWith("/");
}

/** The two artifacts a phase agent's writes can produce. */
export type PhaseArtifactKind = "spec" | "plan";

/**
 * Which artifact `filePath` is, or `null` when it is neither.
 *
 * `specDir` is the run's own spec directory when it has one — a run scoped to
 * `.claude/specs/2026-08-16-thing` must not adopt a `spec.md` from a sibling
 * run — and falls back to the shared root otherwise. Plans have no per-run
 * directory, so they are always judged against `PLAN_ARTIFACT_DIR`.
 *
 * The filename tests are `basename`/`extname`, not `endsWith`: `endsWith(".md")`
 * also accepts a path whose final segment is literally `.md`, and neither
 * `endsWith` spelling of the spec test is right — `endsWith("spec.md")` accepts
 * `notspec.md`, while `endsWith("/spec.md")` rejects a bare relative `spec.md`
 * that has no directory component at all.
 */
export function classifyPhaseArtifact(
  filePath: string,
  specDir: string,
  baseDir: string,
): PhaseArtifactKind | null {
  if (filePath.length === 0) return null;
  if (basename(filePath) === "spec.md" && resolvesWithin(filePath, specDir, baseDir)) return "spec";
  if (extname(filePath) === ".md" && resolvesWithin(filePath, PLAN_ARTIFACT_DIR, baseDir)) return "plan";
  return null;
}

/** The `spec_file`/`plan_file` fields a batch of written paths justifies. */
export type PhaseArtifactUpdates = Readonly<{
  spec_file?: string;
  plan_file?: string;
}>;

/**
 * Fold written paths into the artifact fields they justify, last write winning
 * per kind — the harness applies them in transcript order, so the final write
 * is the one the agent left behind.
 *
 * Returns a fresh frozen record with only the fields that were actually
 * classified, so a caller can spread it over state and leave everything else
 * untouched. An empty result means "no write in this transcript was an
 * artifact", which is a normal outcome: the documented filesystem fallback
 * covers agents that write through a tool this classifier does not see.
 */
export function phaseArtifactUpdates(
  writtenPaths: readonly string[],
  specDir: string,
  baseDir: string,
): PhaseArtifactUpdates {
  const updates: { spec_file?: string; plan_file?: string } = {};
  for (const path of writtenPaths) {
    const kind = classifyPhaseArtifact(path, specDir, baseDir);
    if (kind === "spec") updates.spec_file = path;
    if (kind === "plan") updates.plan_file = path;
  }
  return Object.freeze(updates);
}
