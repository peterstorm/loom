/**
 * Remediation Git boundary.
 *
 * The narrow adapter that turns the pure remediation contracts in
 * `core/remediation-machine.ts` into real Git operations. The core decides
 * WHAT may be staged; this decides nothing — it observes, stages into a
 * throwaway index, reports back, and installs only what the core verified.
 *
 * Command construction is fixed by design:
 *
 * - one executable (`git`) with argument ARRAYS, never a shell string, so
 *   nothing in a path can become a command;
 * - `--literal-pathspecs` plus `--pathspec-from-file=- --pathspec-file-nul`,
 *   so a path containing a glob character, a leading `:`, a newline, or a
 *   quote is data on stdin rather than a selector Git interprets;
 * - a canonical cwd (the repository root) resolved once, so a relative path
 *   cannot mean different files at different moments;
 * - an allowlisted environment, so ambient `GIT_*` settings from the caller's
 *   shell cannot redirect the index, the work tree, or the object store;
 * - bounded output and time, so a hung or runaway Git cannot wedge a run.
 *
 * Agent prose never enters command text. The only caller-derived values that
 * reach Git are repository-relative paths, and they reach it through a NUL
 * manifest on stdin.
 *
 * Installation is a compare-and-swap: the real index is replaced only if the
 * repository witness still matches the one the verification was computed
 * against. Any failure removes the temporary index and leaves the real index
 * and the work tree byte-for-byte unchanged.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalRecord,
  type ArtifactDigest,
  type DomainResult,
} from "../core/orchestration-contract";
import {
  isExcludedRemediationPath,
  parseRemediationPath,
  type FixedGitPathspecContract,
} from "../core/remediation-machine";

/** Fixed argument templates. Nothing here is ever built from caller input. */
const GIT_EXECUTABLE = "git";
const LITERAL_PATHSPECS = "--literal-pathspecs";

/** Bounds. A remediation staging is small; these are generous, not tight. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * The only environment Git receives. `PATH` locates the executable and `HOME`
 * lets Git read the user's config; everything else — and in particular every
 * ambient `GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG` — is
 * dropped, so the caller's shell cannot silently redirect an operation. The
 * temporary index is passed explicitly per-invocation instead.
 */
function allowlistedEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "",
    // Deterministic, locale-independent output.
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    ...overrides,
  };
}

export type GitBoundaryError = Readonly<{
  kind: "git-boundary-failed";
  operation: string;
  message: string;
}>;

const failure = <T>(operation: string, message: string): DomainResult<T, GitBoundaryError> =>
  ({ ok: false, error: canonicalRecord({ kind: "git-boundary-failed" as const, operation, message }) });

const success = <T>(value: T): DomainResult<T, GitBoundaryError> => ({ ok: true, value });

type GitInvocation = Readonly<{
  operation: string;
  /** The subcommand and its own arguments. Global options are added here. */
  args: readonly string[];
  stdin?: Buffer;
  indexFile?: string;
}>;

/**
 * The minimal spawn result the Git boundary reads. Kept structural so tests can
 * stub each failure arm ({error}, {signal}, {status}) without fabricating the
 * full SpawnSyncReturns shape.
 */
export type GitSpawnResult = Readonly<{
  error?: Error | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}>;

export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => GitSpawnResult;

/**
 * Run one Git command. Every invocation goes through here so the fixed
 * executable, argument array, cwd, environment, and bounds cannot be bypassed
 * by an individual operation.
 *
 * `--literal-pathspecs` is a GLOBAL option: Git only accepts it before the
 * subcommand, and a subcommand that receives it as its own flag exits 129.
 * Prepending it here rather than at each call site means no operation can
 * accidentally place it where Git would reject it — or, worse, omit it and
 * silently start interpreting paths as patterns.
 *
 * EXPORTED for tests: the `spawn` seam pins the process-level failure arms
 * (git binary missing, killed by a signal) without forking a real process.
 */
export function runGit(
  repositoryRoot: string,
  invocation: GitInvocation,
  spawn: GitSpawn = spawnSync,
): DomainResult<Buffer, GitBoundaryError> {
  const result = spawn(GIT_EXECUTABLE, [LITERAL_PATHSPECS, ...invocation.args], {
    cwd: repositoryRoot,
    env: allowlistedEnvironment(
      invocation.indexFile === undefined ? {} : { GIT_INDEX_FILE: invocation.indexFile },
    ),
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    ...(invocation.stdin === undefined ? {} : { input: invocation.stdin }),
    windowsHide: true,
  });

  if (result.error !== undefined && result.error !== null) {
    return failure(invocation.operation, `git could not be run: ${result.error.message}`);
  }
  if (result.signal !== null) {
    return failure(invocation.operation, `git terminated on signal ${result.signal}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf-8").trim();
    return failure(invocation.operation, `git exited ${result.status ?? "unknown"}${stderr === "" ? "" : `: ${stderr}`}`);
  }
  return success(result.stdout ?? Buffer.alloc(0));
}

const digestOf = (value: string): ArtifactDigest =>
  createHash("sha256").update(value).digest("hex") as ArtifactDigest;

/** Split NUL-delimited Git output; a trailing NUL does not produce an empty field. */
function splitNul(output: Buffer): readonly string[] {
  return output.toString("utf-8").split("\0").filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

export type GitRepository = Readonly<{ root: string; gitDir: string }>;

/**
 * Resolve the repository root ONCE and use it as every later invocation's cwd.
 * A relative path is only meaningful against a fixed root, so resolving per
 * call would let the same path mean different files at different moments.
 */
export function openGitRepository(startDirectory: string): DomainResult<GitRepository, GitBoundaryError> {
  const start = resolve(startDirectory);
  const root = runGit(start, { operation: "rev-parse", args: ["rev-parse", "--show-toplevel"] });
  if (!root.ok) return root;
  const gitDir = runGit(start, { operation: "rev-parse", args: ["rev-parse", "--absolute-git-dir"] });
  if (!gitDir.ok) return gitDir;
  return success(canonicalRecord({
    root: root.value.toString("utf-8").trim(),
    gitDir: gitDir.value.toString("utf-8").trim(),
  }));
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export type ObservedDirtyPath = Readonly<{
  path: string;
  change: "added" | "modified" | "renamed-from" | "renamed-to" | "deleted" | "absent";
  nodeKind: "file" | "missing";
}>;

/**
 * Map one `git status --porcelain=v1 -z` status pair onto the core's change
 * vocabulary. `?` is an untracked file, which for remediation is an addition.
 */
function changeOf(code: string, present: boolean): ObservedDirtyPath["change"] {
  if (code === "D") return "deleted";
  if (code === "A" || code === "?") return "added";
  if (code === "R") return present ? "renamed-to" : "renamed-from";
  return present ? "modified" : "absent";
}

/**
 * Observe every dirty path. Uses `-z` so a path containing a newline or a
 * quote survives intact — porcelain's default quoting would corrupt exactly
 * the paths most worth getting right.
 *
 * Rename entries carry two NUL-separated paths; both halves are reported, so
 * a rename is visible as the pair it is rather than as a single edit.
 */
export function observeStagedPaths(
  repository: GitRepository,
): DomainResult<readonly string[], GitBoundaryError> {
  const output = runGit(repository.root, {
    operation: "diff-index-staged",
    args: ["diff-index", "--cached", "--name-only", "-z", "HEAD"],
  });
  return output.ok ? success(Object.freeze([...splitNul(output.value)].sort())) : output;
}

export function observeDirtyPaths(
  repository: GitRepository,
): DomainResult<readonly ObservedDirtyPath[], GitBoundaryError> {
  const output = runGit(repository.root, {
    operation: "status",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  });
  if (!output.ok) return output;

  const fields = output.value.toString("utf-8").split("\0");
  const observed: ObservedDirtyPath[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === undefined || entry.length < 4) continue;
    const indexCode = entry[0] ?? " ";
    const worktreeCode = entry[1] ?? " ";
    const path = entry.slice(3);
    // A rename's source path is the NEXT NUL-separated field, not part of this one.
    const renamed = indexCode === "R" || worktreeCode === "R";
    const source = renamed ? fields[index + 1] : undefined;
    if (renamed && source !== undefined) index += 1;

    const primaryCode = indexCode === " " || indexCode === "?" ? worktreeCode : indexCode;
    observed.push(observationFor(repository.root, path, primaryCode));
    if (source !== undefined && source.length > 0) {
      observed.push(observationFor(repository.root, source, "R-from"));
    }
  }
  return success(Object.freeze(observed));
}

function observationFor(root: string, path: string, code: string): ObservedDirtyPath {
  const present = existsSync(join(root, path));
  const change = code === "R-from" ? "renamed-from" : changeOf(code, present);
  return canonicalRecord({
    path,
    change,
    nodeKind: present ? ("file" as const) : ("missing" as const),
  });
}

// ---------------------------------------------------------------------------
// Witnesses
// ---------------------------------------------------------------------------

export type RepositoryWitnessInput = Readonly<{
  baseTreeDigest: ArtifactDigest;
  indexDigest: ArtifactDigest;
  worktreeDigest: ArtifactDigest;
}>;

/**
 * Snapshot what the repository looks like right now.
 *
 * The index digest covers the full staged tree listing and the worktree
 * digest covers the full dirty-status listing, so ANY change to either — a
 * file staged elsewhere, an unrelated edit saved between verification and
 * installation — moves the witness and fails the compare-and-swap. That is
 * deliberately broad: a narrower witness would let concurrent work slip
 * through the window the swap exists to close.
 */
export function snapshotRepositoryWitness(
  repository: GitRepository,
): DomainResult<RepositoryWitnessInput, GitBoundaryError> {
  const head = runGit(repository.root, { operation: "rev-parse", args: ["rev-parse", "HEAD^{tree}"] });
  if (!head.ok) return head;
  const index = runGit(repository.root, {
    operation: "ls-files",
    args: ["ls-files", "--stage", "-z"],
  });
  if (!index.ok) return index;
  const worktree = runGit(repository.root, {
    operation: "status",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  });
  if (!worktree.ok) return worktree;

  return success(canonicalRecord({
    baseTreeDigest: digestOf(head.value.toString("utf-8").trim()),
    indexDigest: digestOf(index.value.toString("utf-8")),
    worktreeDigest: digestOf(worktree.value.toString("utf-8")),
  }));
}

// ---------------------------------------------------------------------------
// Temporary index
// ---------------------------------------------------------------------------

export type TemporaryIndex = Readonly<{
  path: string;
  directory: string;
}>;

/**
 * Create a throwaway index seeded from the current HEAD tree. Staging happens
 * here, never in the real index, so an abandoned remediation leaves nothing
 * behind to clean up in the repository itself.
 */
export function createTemporaryIndex(
  repository: GitRepository,
): DomainResult<TemporaryIndex, GitBoundaryError> {
  const directory = mkdtempSync(join(tmpdir(), "loom-remediation-index-"));
  const path = join(directory, "index");
  const seeded = runGit(repository.root, {
    operation: "read-tree",
    args: ["read-tree", "HEAD"],
    indexFile: path,
  });
  if (!seeded.ok) {
    rmSync(directory, { recursive: true, force: true });
    return seeded;
  }
  return success(canonicalRecord({ path, directory }));
}

/** Remove a temporary index. Safe to call twice; an already-gone index is fine. */
export function discardTemporaryIndex(temporary: TemporaryIndex): void {
  rmSync(temporary.directory, { recursive: true, force: true });
}

/**
 * Refuse to operate on a temporary index that is not on disk.
 *
 * Git treats a missing `GIT_INDEX_FILE` as an EMPTY index rather than an
 * error, so `diff-index --cached HEAD` against a discarded index reports every
 * tracked file as deleted. That phantom set is far worse than a failure: it is
 * a plausible-looking staged set describing a change nobody made. Every
 * operation that names a temporary index checks it exists first.
 */
function requireTemporaryIndex(
  temporary: TemporaryIndex,
  operation: string,
): DomainResult<TemporaryIndex, GitBoundaryError> {
  return existsSync(temporary.path)
    ? success(temporary)
    : failure(operation, `temporary index is missing: ${temporary.path}`);
}

/**
 * Stage exactly the contract's paths into the temporary index.
 *
 * The paths travel as a NUL manifest on stdin under `--pathspec-file-nul`, so
 * Git treats each one as a literal path rather than a pattern. `--all` makes a
 * deletion stage as a deletion: without it a path whose file is gone would be
 * silently skipped, and the staged set would not equal the audited set.
 */
export function stageAuditedPaths(
  repository: GitRepository,
  temporary: TemporaryIndex,
  contract: FixedGitPathspecContract,
): DomainResult<readonly string[], GitBoundaryError> {
  const present = requireTemporaryIndex(temporary, "add");
  if (!present.ok) return present;

  const paths = contract.manifest.paths.paths;
  if (paths.length === 0) return failure("add", "refusing to stage an empty path set");

  // Belt and braces: the audit already excludes Loom's own evidence, but this
  // is the last point before bytes reach Git, and staging a run directory
  // would fold the audit trail into the change it audits.
  const excluded = paths.filter(isExcludedRemediationPath);
  if (excluded.length > 0) {
    return failure("add", `refusing to stage excluded Loom evidence: ${excluded.join(", ")}`);
  }

  // The core verifies the contract's argument templates are exactly the
  // literal-pathspec form. Checking the global one against what `runGit`
  // prepends means the two cannot silently diverge — a contract asking for a
  // different global option must not be run under this one.
  if (contract.globalArgs.length !== 1 || contract.globalArgs[0] !== LITERAL_PATHSPECS) {
    return failure("add", `pathspec contract declares unexpected global arguments: ${contract.globalArgs.join(" ")}`);
  }

  const staged = runGit(repository.root, {
    operation: "add",
    // `--pathspec-from-file` is a subcommand option; the global one is
    // prepended by runGit. Both come from the contract the core validated.
    args: ["add", "--all", ...contract.pathspecArgs],
    // The core computed these bytes and digested them; recomputing the
    // manifest here would be a second implementation free to disagree.
    stdin: Buffer.from(Uint8Array.from(contract.manifest.bytes)),
    indexFile: temporary.path,
  });
  if (!staged.ok) return staged;

  return readStagedPaths(repository, temporary);
}

/**
 * Report exactly what the temporary index now stages relative to HEAD. The
 * core compares this against the audited set; a mismatch in either direction
 * blocks installation.
 */
export function readStagedPaths(
  repository: GitRepository,
  temporary: TemporaryIndex,
): DomainResult<readonly string[], GitBoundaryError> {
  const present = requireTemporaryIndex(temporary, "diff-index");
  if (!present.ok) return present;

  const output = runGit(repository.root, {
    operation: "diff-index",
    args: ["diff-index", "--cached", "--name-only", "-z", "HEAD"],
    indexFile: temporary.path,
  });
  if (!output.ok) return output;

  const paths = splitNul(output.value);
  const invalid = paths.filter((path) => !parseRemediationPath(path).ok);
  if (invalid.length > 0) {
    return failure("diff-index", `staged path is not repository-relative: ${invalid.join(", ")}`);
  }
  return success(Object.freeze([...paths].sort()));
}

/** Digest of the temporary index's staged tree, for the core's index witness. */
export function digestTemporaryIndex(
  repository: GitRepository,
  temporary: TemporaryIndex,
): DomainResult<ArtifactDigest, GitBoundaryError> {
  const present = requireTemporaryIndex(temporary, "ls-files");
  if (!present.ok) return present;

  const output = runGit(repository.root, {
    operation: "ls-files",
    args: ["ls-files", "--stage", "-z"],
    indexFile: temporary.path,
  });
  return output.ok ? success(digestOf(output.value.toString("utf-8"))) : output;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type InstallationOutcome = Readonly<{
  kind: "installed";
  installedPaths: readonly string[];
}>;

/**
 * Install the verified temporary index as the real one, but only if the
 * repository has not moved underneath the verification.
 *
 * The witness is re-snapshotted here rather than trusted from the caller: the
 * whole point of the swap is that time passed between verification and now.
 * On any mismatch — or any failure at all — the temporary index is discarded
 * and the real index and work tree are left exactly as they were.
 */
export function installVerifiedIndex(
  repository: GitRepository,
  temporary: TemporaryIndex,
  expectedWitness: RepositoryWitnessInput,
): DomainResult<InstallationOutcome, GitBoundaryError> {
  // A missing temporary index reads as an EMPTY index, which would write a
  // tree deleting every tracked file. Refuse before anything else.
  const present = requireTemporaryIndex(temporary, "install");
  if (!present.ok) return present;

  const indexLocation = runGit(repository.root, {
    operation: "rev-parse-index",
    args: ["rev-parse", "--git-path", "index"],
  });
  if (!indexLocation.ok) {
    discardTemporaryIndex(temporary);
    return indexLocation;
  }
  const rawIndexPath = indexLocation.value.toString("utf-8").trim();
  if (rawIndexPath.length === 0) {
    discardTemporaryIndex(temporary);
    return failure("install", "Git returned an empty real-index path");
  }
  const indexPath = resolve(repository.root, rawIndexPath);
  const lockPath = `${indexPath}.lock`;
  let lockFd: number | null = null;
  let lockOwned = false;
  let installed = false;
  try {
    lockFd = openSync(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    lockOwned = true;

    // The witness is re-read only after the real Git index lock is held. Any
    // concurrent `git add` either completed before this snapshot (and moves the
    // digest) or blocks/fails on index.lock; it can no longer land in the old
    // check→read-tree window and be overwritten.
    const current = snapshotRepositoryWitness(repository);
    if (!current.ok) return current;
    const drifted = driftedFields(expectedWitness, current.value);
    if (drifted.length > 0) {
      return failure("install", `repository changed since verification (${drifted.join(", ")}); nothing was installed`);
    }

    const staged = readStagedPaths(repository, temporary);
    if (!staged.ok) return staged;

    writeFileSync(lockFd, readFileSync(temporary.path));
    fsyncSync(lockFd);
    closeSync(lockFd);
    lockFd = null;
    renameSync(lockPath, indexPath);
    installed = true;
    return success(canonicalRecord({ kind: "installed" as const, installedPaths: staged.value }));
  } catch (error) {
    return failure("install", `cannot atomically install verified index: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (lockFd !== null) closeSync(lockFd);
    if (lockOwned && !installed) {
      try { unlinkSync(lockPath); } catch { /* already removed */ }
    }
    discardTemporaryIndex(temporary);
  }
}

function driftedFields(
  expected: RepositoryWitnessInput,
  current: RepositoryWitnessInput,
): readonly string[] {
  return (["baseTreeDigest", "indexDigest", "worktreeDigest"] as const)
    .filter((field) => expected[field] !== current[field]);
}

/** True when the path exists and is a regular file — never a symlink or directory. */
export function isRegularFile(root: string, path: string): boolean {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

/** Read a repository file's exact bytes, for byte-equality proofs in tests. */
export function readRepositoryBytes(root: string, path: string): Buffer | null {
  try {
    return readFileSync(join(root, path));
  } catch {
    return null;
  }
}
