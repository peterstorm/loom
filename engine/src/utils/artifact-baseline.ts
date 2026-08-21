import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import {
  changedDeclaredArtifacts,
  parseDeclaredArtifactBaseline,
  type ArtifactSnapshot,
  type DeclaredArtifactBaseline,
} from "../core/artifact-baseline";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "./repository-path";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotArtifact(root: string, artifact: string): ArtifactSnapshot {
  const inspected = inspectRepositoryPath(root, artifact, "declared artifact");
  if (!inspected.exists) return Object.freeze({ kind: "missing" });
  const bytes = readFileSync(inspected.absolute);
  return Object.freeze({ kind: "sha256", digest: digest(bytes) });
}

/** Imperative shell: capture every declared artifact's exact start state. */
export function captureDeclaredArtifactBaseline(
  root: string,
  artifacts: readonly string[],
): readonly DeclaredArtifactBaseline[] {
  return Object.freeze([...new Set(artifacts)].map((artifact) => Object.freeze({
    artifact,
    snapshot: snapshotArtifact(root, artifact),
  })));
}

function artifactExistsAtRevision(
  root: string,
  revision: string,
  artifact: string,
): boolean {
  const entries = execFileSync(
    "git",
    ["ls-tree", "-z", "--name-only", revision, "--", artifact],
    { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] },
  );
  return entries.length > 0;
}

function snapshotArtifactAtRevision(
  root: string,
  revision: string,
  artifact: string,
): ArtifactSnapshot {
  if (!artifactExistsAtRevision(root, revision, artifact)) {
    return Object.freeze({ kind: "missing" });
  }
  try {
    const bytes = execFileSync("git", ["show", `${revision}:${artifact}`], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024,
    });
    return Object.freeze({ kind: "sha256", digest: digest(bytes) });
  } catch (error) {
    throw new Error(
      `Cannot read declared artifact ${artifact} at ${revision}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Capture exact artifact bytes from a validated historical Git commit. The
 * current-worktree snapshot is intentionally taken first only to apply the
 * repository path boundary before any path enters a Git revision expression. */
export function captureDeclaredArtifactBaselineAtRevision(
  root: string,
  revision: string,
  artifacts: readonly string[],
): readonly DeclaredArtifactBaseline[] {
  captureDeclaredArtifactBaseline(root, artifacts);
  execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return Object.freeze([...new Set(artifacts)].map((artifact) => Object.freeze({
    artifact,
    snapshot: snapshotArtifactAtRevision(root, revision, artifact),
  })));
}

function nulSeparatedGitPaths(root: string, args: readonly string[]): readonly string[] {
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  });
  return output.toString("utf-8").split("\0").filter((path) => path !== "");
}

/** Git-visible tracked and untracked paths whose worktree/index state differs
 * from HEAD. Ignored files are deliberately outside Loom's review/lint scope. */
export function repositoryChangedPaths(root: string): readonly string[] {
  return Object.freeze([...canonicalRepositoryPaths(root, [
    ...nulSeparatedGitPaths(root, ["diff", "--name-only", "-z", "--"]),
    ...nulSeparatedGitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"]),
    ...nulSeparatedGitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ], "repository change baseline")].sort());
}

function snapshotRepositoryArtifact(root: string, artifact: string): ArtifactSnapshot {
  const inspected = inspectRepositoryPath(root, artifact, "repository change", {
    allowLeafSymlink: true,
  });
  if (!inspected.exists) return Object.freeze({ kind: "missing" });
  const stat = lstatSync(inspected.absolute);
  let bytes: Buffer | null = null;
  if (stat.isSymbolicLink()) {
    bytes = Buffer.from(`symlink\0${readlinkSync(inspected.absolute)}`, "utf-8");
  } else if (stat.isFile()) {
    bytes = Buffer.concat([
      Buffer.from(`file\0${stat.mode & 0o777}\0`, "utf-8"),
      readFileSync(inspected.absolute),
    ]);
  }
  if (bytes === null) throw new Error(`repository change must be a file or leaf symlink: ${artifact}`);
  return Object.freeze({ kind: "sha256", digest: digest(bytes) });
}

function captureRepositoryArtifacts(
  root: string,
  artifacts: readonly string[],
): readonly DeclaredArtifactBaseline[] {
  return Object.freeze([...new Set(artifacts)].map((artifact) => Object.freeze({
    artifact,
    snapshot: snapshotRepositoryArtifact(root, artifact),
  })));
}

/** Compact repository boundary captured before an implementation attempt.
 * Clean tracked paths need no stored hash: if they become dirty, their entry in
 * repositoryChangedPaths is itself proof that this attempt changed them. */
export function captureRepositoryChangeBaseline(
  root: string,
): readonly DeclaredArtifactBaseline[] {
  return captureRepositoryArtifacts(root, repositoryChangedPaths(root));
}

/** Detect every Git-visible path whose state changed after a compact repository
 * boundary. Symmetric-difference paths became dirty or clean; paths dirty at
 * both observations are compared by exact bytes. */
export function changedRepositoryArtifactsSince(
  root: string,
  baseline: readonly DeclaredArtifactBaseline[] | undefined,
): readonly string[] {
  if (baseline === undefined) {
    throw new Error("No implementation-attempt repository baseline is available");
  }
  const parsed = parseDeclaredArtifactBaseline(baseline, "repository baseline");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const currentPaths = repositoryChangedPaths(root);
  const baselineByPath = new Map(parsed.value.map((entry) => [entry.artifact, entry]));
  const currentSet = new Set(currentPaths);
  const sharedBaseline = parsed.value.filter((entry) => currentSet.has(entry.artifact));
  const sharedCurrent = captureRepositoryArtifacts(
    root,
    sharedBaseline.map(({ artifact }) => artifact),
  );
  const compared = changedDeclaredArtifacts(sharedBaseline, sharedCurrent);
  if (!compared.ok) throw new Error(compared.errors.join("; "));
  const changed = new Set(compared.value);
  for (const path of baselineByPath.keys()) {
    if (!currentSet.has(path)) changed.add(path);
  }
  for (const path of currentPaths) {
    if (!baselineByPath.has(path)) changed.add(path);
  }
  return Object.freeze([...changed].sort());
}

/** Compare current bytes to a trusted git commit retained as task start_sha.
 * This is the recovery source when a legacy retry overwrote artifact_baseline
 * after implementation bytes had already landed. */
export function changedDeclaredArtifactsSinceRevision(
  root: string,
  revision: string,
  artifacts: readonly string[],
): readonly string[] {
  const baseline = captureDeclaredArtifactBaselineAtRevision(root, revision, artifacts);
  const current = captureDeclaredArtifactBaseline(root, artifacts);
  const compared = changedDeclaredArtifacts(baseline, current);
  if (!compared.ok) throw new Error(compared.errors.join("; "));
  return compared.value;
}

/** Imperative shell over the pure exact-set comparison. */
export function changedDeclaredArtifactsSince(
  root: string,
  baseline: readonly DeclaredArtifactBaseline[] | undefined,
): readonly string[] {
  // No start snapshot proves no change. This fail-closed value leaves every
  // declared-artifact obligation unsatisfied rather than trusting tool attempts.
  if (baseline === undefined) return Object.freeze([]);
  const current = captureDeclaredArtifactBaseline(root, baseline.map(({ artifact }) => artifact));
  const compared = changedDeclaredArtifacts(baseline, current);
  if (!compared.ok) throw new Error(compared.errors.join("; "));
  return compared.value;
}

// ---------------------------------------------------------------------------
// Attempt-baseline comparison — ONE implementation, ONE fail-closed contract
// ---------------------------------------------------------------------------

/**
 * Which stored baseline proves "bytes changed since this attempt started".
 *
 * `repository` is the strict form: only the compact repository boundary counts,
 * and its absence is a comparison FAILURE (there is nothing to compare against).
 * `repository-or-declared` is the compatibility form used where older graphs may
 * carry only a declared-artifact attempt baseline; `extraModifiedPaths` lets a
 * caller add transcript-reported writes that no declared baseline anticipated.
 */
export type AttemptBaselineMode =
  | Readonly<{ kind: "repository" }>
  | Readonly<{ kind: "repository-or-declared"; extraModifiedPaths?: readonly string[] }>;

export interface AttemptBaselineTask {
  readonly artifact_baseline?: readonly DeclaredArtifactBaseline[];
  readonly attempt_artifact_baseline?: readonly DeclaredArtifactBaseline[];
  readonly attempt_repository_baseline?: readonly DeclaredArtifactBaseline[];
  readonly file_list?: readonly string[];
}

export interface AttemptBaselineComparison {
  readonly changedDeclaredArtifacts: readonly string[];
  readonly changedRepositoryArtifacts: readonly string[];
  /** `true` whenever the attempt's bytes moved — OR whenever that cannot be
   *  proven, which is what makes this fail closed. */
  readonly bytesChangedSinceAttempt: boolean;
  /** The comparison's failure cause, or null on a clean comparison. */
  readonly failure: string | null;
}

/**
 * Compare a task's stored baselines against the working tree.
 *
 * This existed THREE times inside `pi/extension.ts` — in
 * `finalizeReservedImplementations`' reducer, in the malformed-transcript
 * reducer, and in the successful-transcript path — with three different
 * `catch` behaviors for the identical failure. Two invalidated the stale
 * evidence and recorded an untrusted resolution; the third only dropped the
 * task from `executing_tasks` and moved on, leaving it pending with NO
 * resolution recorded. So the same thrown comparison — an unreadable artifact,
 * a malformed stored baseline, a git failure — either failed closed with a
 * verdict or silently stranded the task, depending purely on which of the
 * three copies happened to be running.
 *
 * One implementation, one contract: a comparison that cannot complete reports
 * `bytesChangedSinceAttempt: true` (the attempt's evidence is NOT proven
 * current, so it must be re-judged), falls back to the task's declared
 * `file_list` for changed artifacts, and returns the cause in `failure` so the
 * caller records a resolution instead of dropping the task.
 */
export function compareAttemptBaseline(
  root: string,
  task: AttemptBaselineTask,
  mode: AttemptBaselineMode,
): AttemptBaselineComparison {
  try {
    const changedDeclared = changedDeclaredArtifactsSince(root, task.artifact_baseline);
    if (mode.kind === "repository" || task.attempt_repository_baseline !== undefined) {
      const changedRepository = changedRepositoryArtifactsSince(root, task.attempt_repository_baseline);
      return Object.freeze({
        changedDeclaredArtifacts: changedDeclared,
        changedRepositoryArtifacts: changedRepository,
        bytesChangedSinceAttempt: changedRepository.length > 0,
        failure: null,
      });
    }
    const extra = mode.extraModifiedPaths ?? [];
    const bytesChanged = task.attempt_artifact_baseline === undefined ||
      changedDeclaredArtifactsSince(root, task.attempt_artifact_baseline).length > 0 ||
      extra.some((path) => !task.attempt_artifact_baseline?.some(({ artifact }) => artifact === path));
    return Object.freeze({
      changedDeclaredArtifacts: changedDeclared,
      changedRepositoryArtifacts: Object.freeze([]),
      bytesChangedSinceAttempt: bytesChanged,
      failure: null,
    });
  } catch (error) {
    return Object.freeze({
      changedDeclaredArtifacts: Object.freeze([...(task.file_list ?? [])]),
      changedRepositoryArtifacts: Object.freeze([]),
      bytesChangedSinceAttempt: true,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}
