import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { COMPLETION_REPORT_ROOT } from "../core/completion-suite";
import { compareStrings } from "../core/ordering";
import { parseArtifactDigest, type ArtifactDigest } from "../core/orchestration-contract";
import { parseReviewPath, type ReviewPath } from "../core/review-packet";
import { inspectRepositoryPath } from "./repository-path";

declare const CANONICAL_REPOSITORY_ROOT: unique symbol;
export type CanonicalRepositoryRoot = string & {
  readonly [CANONICAL_REPOSITORY_ROOT]: true;
};

export type WorkspaceEntryType = "regular-file" | "symbolic-link" | "directory" | "missing";

/** Pure digest input. Bytes are exact file bytes or exact symlink-target bytes. */
export type ObservedWorkspaceEntry = Readonly<{
  path: ReviewPath;
  mode: bigint;
  type: WorkspaceEntryType;
  bytes: Uint8Array;
}>;

export type WorkspaceDigestFailure =
  | Readonly<{ kind: "invalid-repository-root"; message: string }>
  | Readonly<{ kind: "git-command-failed"; operation: "resolve-root" | "list-paths"; message: string }>
  | Readonly<{ kind: "invalid-git-output"; operation: "resolve-root" | "list-paths"; message: string }>
  | Readonly<{ kind: "invalid-exclusion-path"; message: string }>
  | Readonly<{ kind: "workspace-read-failed"; path: string; message: string }>
  | Readonly<{ kind: "workspace-list-drift"; before: readonly string[]; after: readonly string[] }>
  | Readonly<{ kind: "workspace-file-drift"; path: string }>;

export type WorkspaceDigestResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: WorkspaceDigestFailure }>;

export type WorkspaceDigestObservation = Readonly<{
  repositoryRoot: CanonicalRepositoryRoot;
  digest: ArtifactDigest;
  pathCount: number;
}>;

export type WorkspaceDigestOptions = Readonly<{
  /** Report artifacts are command outputs, not implementation authority. */
  completionReportPaths?: readonly string[];
}>;

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const TASK_GRAPH_PATHS = Object.freeze([
  ".claude/state/active_task_graph.json",
  ".pi/state/active_task_graph.json",
]);
const RUN_DIRECTORY_ROOTS = Object.freeze([".claude/reviews", ".pi/reviews"]);
const GIT_INTERNAL_ROOTS = Object.freeze([".git"]);

const success = <T>(value: T): WorkspaceDigestResult<T> => Object.freeze({ ok: true, value });
const failure = <T>(error: WorkspaceDigestFailure): WorkspaceDigestResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

function causeMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_096);
}

/** Parse, don't validate: only an absolute, real, symlink-free directory is minted. */
export function parseCanonicalRepositoryRoot(raw: unknown): WorkspaceDigestResult<CanonicalRepositoryRoot> {
  if (typeof raw !== "string" || !isAbsolute(raw) || resolve(raw) !== raw) {
    return failure({ kind: "invalid-repository-root", message: "repository root must be a canonical absolute path" });
  }
  try {
    const stat = lstatSync(raw);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(raw) !== raw) {
      return failure({
        kind: "invalid-repository-root",
        message: "repository root must be a canonical real directory without a symlink leaf",
      });
    }
    return success(raw as CanonicalRepositoryRoot);
  } catch (cause) {
    return failure({ kind: "invalid-repository-root", message: causeMessage(cause) });
  }
}

type GitOutput = WorkspaceDigestResult<Buffer>;

function runGit(cwd: string, operation: "resolve-root" | "list-paths", args: readonly string[]): GitOutput {
  const executed = spawnSync("git", ["-C", cwd, "--literal-pathspecs", ...args], {
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (executed.error !== undefined || executed.status !== 0) {
    const stderr = Buffer.from(executed.stderr ?? []).toString("utf-8").trim();
    const detail = executed.error?.message ?? (stderr || `git exited with ${String(executed.status)}`);
    return failure({ kind: "git-command-failed", operation, message: detail.slice(0, 4_096) });
  }
  return success(Buffer.from(executed.stdout ?? []));
}

/** Resolve Git authority first, then mint its canonical real worktree root. */
export function resolveCanonicalGitRepositoryRoot(
  startPath: string,
): WorkspaceDigestResult<CanonicalRepositoryRoot> {
  const resolved = runGit(startPath, "resolve-root", ["rev-parse", "--show-toplevel"]);
  if (!resolved.ok) return resolved;
  let rawRoot: string;
  try {
    rawRoot = new TextDecoder("utf-8", { fatal: true }).decode(resolved.value).trimEnd();
  } catch (cause) {
    return failure({ kind: "invalid-git-output", operation: "resolve-root", message: causeMessage(cause) });
  }
  if (rawRoot.length === 0 || rawRoot.includes("\0") || rawRoot.includes("\n") || rawRoot.includes("\r")) {
    return failure({ kind: "invalid-git-output", operation: "resolve-root", message: "Git returned no single repository root" });
  }
  try {
    return parseCanonicalRepositoryRoot(realpathSync.native(resolve(rawRoot)));
  } catch (cause) {
    return failure({ kind: "invalid-repository-root", message: causeMessage(cause) });
  }
}

function pathIsWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function exclusionSet(raw: readonly string[]): WorkspaceDigestResult<ReadonlySet<string>> {
  const paths = new Set<string>();
  const errors: string[] = [];
  raw.forEach((path, index) => {
    const parsed = parseReviewPath(path, `completionReportPaths[${index}]`);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
    } else if (!parsed.value.startsWith(`${COMPLETION_REPORT_ROOT}/`)) {
      errors.push(`completionReportPaths[${index}] must be beneath protected ${COMPLETION_REPORT_ROOT}/`);
    } else {
      paths.add(parsed.value);
    }
  });
  return errors.length === 0
    ? success(paths)
    : failure({ kind: "invalid-exclusion-path", message: errors.join("; ") });
}

function excluded(path: string, completionReports: ReadonlySet<string>): boolean {
  return GIT_INTERNAL_ROOTS.some((root) => pathIsWithin(path, root)) ||
    RUN_DIRECTORY_ROOTS.some((root) => pathIsWithin(path, root)) ||
    TASK_GRAPH_PATHS.some((statePath) => path === statePath || path.startsWith(`${statePath}.`)) ||
    completionReports.has(path);
}

function parseListedPaths(
  bytes: Buffer,
  completionReports: ReadonlySet<string>,
): WorkspaceDigestResult<readonly ReviewPath[]> {
  const byPath = new Set<ReviewPath>();
  const errors: string[] = [];
  const chunks = bytes.length === 0 ? [] : bytes.subarray(0, bytes.at(-1) === 0 ? -1 : undefined).toString("binary").split("\0");
  for (const [index, binary] of chunks.entries()) {
    const raw = Buffer.from(binary, "binary");
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch (cause) {
      errors.push(`git path ${index} is not UTF-8: ${causeMessage(cause)}`);
      continue;
    }
    const parsed = parseReviewPath(decoded, `git path ${index}`);
    if (!parsed.ok) errors.push(...parsed.errors);
    else if (!excluded(parsed.value, completionReports)) byPath.add(parsed.value);
  }
  return errors.length === 0
    ? success(Object.freeze([...byPath].sort(compareStrings)))
    : failure({ kind: "invalid-git-output", operation: "list-paths", message: errors.join("; ") });
}

function listWorkspacePaths(
  root: CanonicalRepositoryRoot,
  completionReports: ReadonlySet<string>,
): WorkspaceDigestResult<readonly ReviewPath[]> {
  const listed = runGit(root, "list-paths", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return listed.ok ? parseListedPaths(listed.value, completionReports) : listed;
}

function statIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function lstatOrMissing(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function immutableEntry(
  path: ReviewPath,
  mode: bigint,
  type: WorkspaceEntryType,
  bytes: Uint8Array,
): ObservedWorkspaceEntry {
  return Object.freeze({ path, mode, type, bytes: Uint8Array.from(bytes) });
}

type StableObservedEntry = Readonly<{
  entry: ObservedWorkspaceEntry;
  statIdentity: string | null;
}>;

function observeEntry(
  root: CanonicalRepositoryRoot,
  path: ReviewPath,
): WorkspaceDigestResult<StableObservedEntry> {
  const absolute = join(root, ...path.split("/"));
  try {
    inspectRepositoryPath(root, path, `workspace path ${path}`, { allowLeafSymlink: true });
    const before = lstatOrMissing(absolute);
    if (before === null) {
      if (lstatOrMissing(absolute) !== null) return failure({ kind: "workspace-file-drift", path });
      return success(Object.freeze({
        entry: immutableEntry(path, 0n, "missing", new Uint8Array()),
        statIdentity: null,
      }));
    }

    let type: WorkspaceEntryType;
    let bytes: Uint8Array;
    if (before.isFile()) {
      type = "regular-file";
      bytes = readFileSync(absolute);
    } else if (before.isSymbolicLink()) {
      type = "symbolic-link";
      bytes = readlinkSync(absolute, { encoding: "buffer" });
    } else if (before.isDirectory()) {
      type = "directory";
      bytes = new Uint8Array();
    } else {
      return failure({
        kind: "workspace-read-failed",
        path,
        message: "Git-visible workspace entry has an unsupported filesystem type",
      });
    }

    const identity = statIdentity(before);
    const after = lstatOrMissing(absolute);
    if (after === null || identity !== statIdentity(after)) {
      return failure({ kind: "workspace-file-drift", path });
    }
    return success(Object.freeze({ entry: immutableEntry(path, before.mode, type, bytes), statIdentity: identity }));
  } catch (cause) {
    return failure({ kind: "workspace-read-failed", path, message: causeMessage(cause) });
  }
}

function verifyEntryStillStable(
  root: CanonicalRepositoryRoot,
  observed: StableObservedEntry,
): WorkspaceDigestResult<null> {
  const path = observed.entry.path;
  try {
    inspectRepositoryPath(root, path, `workspace path ${path}`, { allowLeafSymlink: true });
    const current = lstatOrMissing(join(root, ...path.split("/")));
    const currentIdentity = current === null ? null : statIdentity(current);
    return currentIdentity === observed.statIdentity
      ? success(null)
      : failure({ kind: "workspace-file-drift", path });
  } catch (cause) {
    return failure({ kind: "workspace-read-failed", path, message: causeMessage(cause) });
  }
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function hashField(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  hash.update(lengthPrefix(bytes.byteLength));
  hash.update(bytes);
}

/** Pure canonical digest over already-observed, caller-supplied entries. */
export function digestObservedWorkspaceEntries(entries: readonly ObservedWorkspaceEntry[]): ArtifactDigest {
  const canonical = [...entries].sort((left, right) => compareStrings(left.path, right.path));
  const hash = createHash("sha256");
  hash.update("loom-workspace-digest-v1\0", "utf-8");
  hash.update(lengthPrefix(canonical.length));
  for (const entry of canonical) {
    hashField(hash, Buffer.from(entry.path, "utf-8"));
    hashField(hash, Buffer.from(entry.type, "utf-8"));
    hashField(hash, Buffer.from(entry.mode.toString(10), "ascii"));
    hashField(hash, entry.bytes);
  }
  const parsed = parseArtifactDigest(hash.digest("hex"));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * Observe one fail-closed digest epoch: list, read every entry with lstat drift
 * checks, then re-list. Git/read failures are typed and can never mint an empty
 * workspace digest.
 */
export function observeWorkspaceDigest(
  startPath: string,
  options: WorkspaceDigestOptions = {},
): WorkspaceDigestResult<WorkspaceDigestObservation> {
  const root = resolveCanonicalGitRepositoryRoot(startPath);
  if (!root.ok) return root;
  const exclusions = exclusionSet(options.completionReportPaths ?? []);
  if (!exclusions.ok) return exclusions;
  const before = listWorkspacePaths(root.value, exclusions.value);
  if (!before.ok) return before;

  const entries: StableObservedEntry[] = [];
  for (const path of before.value) {
    const observed = observeEntry(root.value, path);
    if (!observed.ok) return observed;
    entries.push(observed.value);
  }

  const after = listWorkspacePaths(root.value, exclusions.value);
  if (!after.ok) return after;
  if (before.value.length !== after.value.length || before.value.some((path, index) => path !== after.value[index])) {
    return failure({
      kind: "workspace-list-drift",
      before: before.value,
      after: after.value,
    });
  }
  for (const entry of entries) {
    const stable = verifyEntryStillStable(root.value, entry);
    if (!stable.ok) return stable;
  }
  return success(Object.freeze({
    repositoryRoot: root.value,
    digest: digestObservedWorkspaceEntries(entries.map(({ entry }) => entry)),
    pathCount: entries.length,
  }));
}
