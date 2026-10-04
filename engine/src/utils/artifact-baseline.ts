import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  changedDeclaredArtifacts,
  parseDeclaredArtifactBaseline,
  treeSnapshotDigest,
  type ArtifactSnapshot,
  type DeclaredArtifactBaseline,
  type TreeEntry,
} from "../core/artifact-baseline";
import { compareStrings } from "../core/ordering";
import { sha256Bytes } from "../core/review-packet";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "./repository-path";
import { runtimeDomainPaths } from "../runtime-compatibility";

const GIT_OUTPUT_LIMIT = 100 * 1024 * 1024;

function gitOutput(root: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
}

/** Repository-relative paths Git ignores. Tracked paths are never reported,
 *  exactly as Git itself never ignores them. */
function gitIgnoredPaths(root: string, paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return new Set();
  const checked = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: root,
    input: paths.map((path) => `${path}\0`).join(""),
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
  if (checked.error !== undefined) throw checked.error;
  // Exit 1 means no path is ignored; any other non-zero status is a failure.
  if (checked.status !== 0 && checked.status !== 1) {
    throw new Error(`git check-ignore failed (status ${checked.status}): ${checked.stderr.toString("utf-8").trim()}`);
  }
  return new Set(checked.stdout.toString("utf-8").split("\0").filter((path) => path !== ""));
}

type WorktreeLeaf = Readonly<{ path: string; absolute: string; node: Dirent }>;

/** Every non-directory node below a worktree directory, by lstat semantics. */
function worktreeLeaves(absolute: string, prefix = ""): readonly WorktreeLeaf[] {
  return readdirSync(absolute, { withFileTypes: true }).flatMap((node): readonly WorktreeLeaf[] => {
    const path = prefix === "" ? node.name : `${prefix}/${node.name}`;
    const child = join(absolute, node.name);
    return node.isDirectory() ? worktreeLeaves(child, path) : [{ path, absolute: child, node }];
  });
}

/** The Git-visible leaves of a worktree directory, matching what `git ls-tree`
 *  can list at a revision: ignored leaves are dropped, symlinks are hashed by
 *  target text and never followed, and empty subdirectories contribute nothing.
 *  A Git-visible node that is not a file or symlink throws. */
function worktreeEntries(root: string, artifact: string, absolute: string): readonly TreeEntry[] {
  const leaves = worktreeLeaves(absolute);
  const ignored = gitIgnoredPaths(root, leaves.map(({ path }) => `${artifact}/${path}`));
  return leaves.filter(({ path }) => !ignored.has(`${artifact}/${path}`)).map(({ path, absolute: leaf, node }): TreeEntry => {
    if (node.isFile()) return { path, kind: "file", contentSha256: sha256Bytes(readFileSync(leaf)) };
    if (node.isSymbolicLink()) {
      return { path, kind: "symlink", contentSha256: sha256Bytes(readlinkSync(leaf, { encoding: "buffer" })) };
    }
    throw new Error(`declared artifact ${artifact} contains a node that is not a file, directory or symlink: ${artifact}/${path}`);
  });
}

function snapshotArtifact(root: string, artifact: string): ArtifactSnapshot {
  const inspected = inspectRepositoryPath(root, artifact, "declared artifact");
  if (!inspected.exists) return Object.freeze({ kind: "missing" });
  const digested = lstatSync(inspected.absolute).isDirectory()
    ? treeSnapshotDigest(worktreeEntries(root, artifact, inspected.absolute))
    : sha256Bytes(readFileSync(inspected.absolute));
  return Object.freeze({ kind: "sha256", digest: digested });
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

type GitTreeLeaf = Readonly<{ mode: string; sha: string; path: string }>;

/** `git ls-tree -r -z` records are `<mode> SP <type> SP <sha> TAB <path>`. A
 *  lone file lists as itself; a directory lists every leaf below it. */
function gitTreeLeaves(root: string, revision: string, artifact: string): readonly GitTreeLeaf[] {
  return gitOutput(root, ["ls-tree", "-r", "-z", revision, "--", artifact]).toString("utf-8").split("\0").filter((record) => record !== "").map((record) => {
    const match = /^(\d{6}) [a-z]+ ([0-9a-f]+)\t(.+)$/s.exec(record);
    if (match === null) {
      throw new Error(`Unparseable git ls-tree record for ${artifact} at ${revision}: ${JSON.stringify(record)}`);
    }
    return Object.freeze({ mode: match[1]!, sha: match[2]!, path: match[3]! });
  });
}

/** Git has no empty trees, so a path exists at a revision exactly when it has a leaf. */
function artifactExistsAtRevision(root: string, revision: string, artifact: string): boolean {
  return gitTreeLeaves(root, revision, artifact).length > 0;
}

function readArtifactObject(
  root: string,
  revision: string,
  artifact: string,
  args: readonly string[],
): Buffer {
  try {
    return gitOutput(root, args);
  } catch (error) {
    throw new Error(
      `Cannot read declared artifact ${artifact} at ${revision}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const TREE_ENTRY_KIND_BY_MODE: Readonly<Record<string, TreeEntry["kind"]>> = Object.freeze({
  "100644": "file",
  "100755": "file",
  "120000": "symlink",
});

// An empty directory has no Git representation, so it snapshots as `missing`
// here while the worktree snapshots it as the empty-tree digest. Reporting that
// pair as changed is deliberate and conservative: it can only over-report.
function snapshotArtifactAtRevision(
  root: string,
  revision: string,
  artifact: string,
): ArtifactSnapshot {
  const leaves = gitTreeLeaves(root, revision, artifact);
  if (leaves.length === 0) return Object.freeze({ kind: "missing" });
  if (leaves.length === 1 && leaves[0]!.path === artifact) {
    const bytes = readArtifactObject(root, revision, artifact, ["show", `${revision}:${artifact}`]);
    return Object.freeze({ kind: "sha256", digest: sha256Bytes(bytes) });
  }
  const entries = leaves.map(({ mode, sha, path }): TreeEntry => {
    const kind = TREE_ENTRY_KIND_BY_MODE[mode];
    if (kind === undefined) {
      throw new Error(
        `Cannot read declared artifact ${artifact} at ${revision}: unsupported tree entry mode ${mode} at ${path}`,
      );
    }
    return {
      path: path.slice(artifact.length + 1),
      kind,
      contentSha256: sha256Bytes(readArtifactObject(root, revision, artifact, ["cat-file", "blob", sha])),
    };
  });
  return Object.freeze({ kind: "sha256", digest: treeSnapshotDigest(entries) });
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
  return gitOutput(root, args).toString("utf-8").split("\0").filter((path) => path !== "");
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
  return Object.freeze({ kind: "sha256", digest: sha256Bytes(bytes) });
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
 * The runtime-baseline restoration map for implementation settlement.
 *
 * Covers the WHOLE runtime revision domain, not only an attempt's declared
 * artifacts. Two campaign-proven reasons:
 *
 * 1. An implementation attempt's necessary writes are not bounded by its
 *    declared artifact list — the render/wording changes ripple into the
 *    dispatch call sites that consume them, and the compiler drives the child
 *    to those files. Scoping the exemption to the declared list made every
 *    such attempt unsettlable: the settlement read the attempt's own
 *    authorized writes as runtime drift.
 * 2. A child's scratch file inside `engine/src`/`pi` (untracked, absent at
 *    HEAD) also moved the revision and broke the handshake mid-attempt. It is
 *    product under this boundary, mapped to `null` (excluded) exactly like an
 *    attempt-created declared artifact.
 *
 * For each domain path that is Git-dirty NOW, the settlement may hash it at
 * its attempt-start bytes instead of its live bytes when:
 *
 * - clean now → unmapped (live bytes ARE the baseline bytes);
 * - provably clean at spawn in EVERY in-flight attempt's repository baseline
 *   → mapped to the CURRENT HEAD: a path clean at spawn carried HEAD's bytes,
 *   and no one commits between spawn and settlement, so HEAD's bytes ARE the
 *   attempt-start bytes. A HEAD that moved can only fail closed — the
 *   restored bytes then mismatch the loaded identity and the write refuses;
 * - created by the attempt (absent at HEAD) → mapped to `null` (excluded from
 *   the revision entirely);
 * - dirty at spawn in ANY in-flight attempt's baseline → unmapped: the write
 *   boundary stays strict for that path. Fail closed — restoration is an
 *   exemption, and an exemption that cannot prove its precondition must not
 *   exist.
 *
 * An unparseable baseline fails closed for the WHOLE map (empty map, strict
 * comparison everywhere), not just for its own task.
 */
export function runtimeBaselineRestoreForTasks(
  root: string,
  tasks: readonly AttemptBaselineTask[],
): ReadonlyMap<string, string | null> {
  const dirty = new Set(repositoryChangedPaths(root));
  if (dirty.size === 0) return new Map();
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const restore = new Map<string, string | null>();
  // Dirty-at-spawn knowledge is unioned across every in-flight attempt: a path
  // ANY attempt observed dirty at its spawn stays strict for all of them.
  const dirtyAtSpawn = new Set<string>();
  let baselineSeen = false;
  for (const task of tasks) {
    if (task.attempt_repository_baseline === undefined) continue;
    const parsed = parseDeclaredArtifactBaseline(task.attempt_repository_baseline, "attempt repository baseline");
    if (!parsed.ok) return new Map(); // unparseable baseline: the whole exemption fails closed
    baselineSeen = true;
    for (const entry of parsed.value) dirtyAtSpawn.add(entry.artifact);
  }
  for (const path of runtimeDomainPaths(root)) {
    if (!dirty.has(path)) continue; // clean now: nothing to restore
    if (baselineSeen && dirtyAtSpawn.has(path)) continue; // dirty at spawn: baseline bytes untrusted
    restore.set(path, artifactExistsAtRevision(root, revision, path) ? revision : null);
  }
  return Object.freeze(new Map([...restore].sort(([left], [right]) => compareStrings(left, right))));
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
