/**
 * Declared-artifact snapshots: the `declared-artifact` digest scheme (a file's
 * raw bytes, or a directory's tree digest), captured from the worktree or from
 * a Git revision, and the byte-change comparisons over them.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import {
  capturedArtifactBaseline,
  changedDeclaredArtifacts,
  parseArtifactBaseline,
  treeSnapshotDigest,
  type ArtifactBaseline,
  type ArtifactSnapshot,
  type DeclaredArtifactBaseline,
  type TreeEntry,
} from "../core/artifact-baseline";
import { sha256Bytes } from "../core/digest";
import type { ReviewPath } from "../core/review-packet";
import { gitOutput, revisionTreeLeaves, worktreeLeafBytes, worktreeVisibleLeaves } from "./git-leaves";
import { inspectRepositoryPath } from "./repository-path";

type DeclaredBaseline = ArtifactBaseline<"declared-artifact">;

/** The Git-visible leaves of a worktree directory, matching what `git ls-tree`
 *  can list at a revision: ignored leaves are dropped, symlinks are hashed by
 *  target text and never followed, and empty subdirectories contribute nothing.
 *  A Git-visible node that is not a file or symlink throws. */
function worktreeEntries(root: string, artifact: string): readonly TreeEntry[] {
  return worktreeVisibleLeaves(root, artifact).flatMap((leaf): readonly TreeEntry[] => {
    switch (leaf.kind) {
      case "file":
      case "symlink":
        return [{ path: leaf.path.slice(artifact.length + 1), kind: leaf.kind, contentSha256: sha256Bytes(worktreeLeafBytes(leaf)) }];
      // An index entry the worktree no longer holds has no bytes to hash.
      case "absent":
      case "shadowed":
        return [];
      case "unsupported":
        throw new Error(`declared artifact ${artifact} contains a node that is not a file, directory or symlink: ${leaf.path}`);
    }
  });
}

function snapshotArtifact(root: string, artifact: string): ArtifactSnapshot {
  const inspected = inspectRepositoryPath(root, artifact, "declared artifact");
  if (!inspected.exists) return Object.freeze({ kind: "missing" });
  const digested = lstatSync(inspected.absolute).isDirectory()
    ? treeSnapshotDigest(worktreeEntries(root, artifact))
    : sha256Bytes(readFileSync(inspected.absolute));
  return Object.freeze({ kind: "sha256", digest: digested });
}

function capture(artifacts: readonly string[], snapshot: (artifact: string) => ArtifactSnapshot): DeclaredBaseline {
  const captured = capturedArtifactBaseline<"declared-artifact">(artifacts, snapshot, "declared artifact baseline");
  if (!captured.ok) throw new Error(captured.errors.join("; "));
  return captured.value;
}

/** Imperative shell: capture every declared artifact's exact start state. */
export function captureDeclaredArtifactBaseline(
  root: string,
  artifacts: readonly string[],
): DeclaredBaseline {
  return capture(artifacts, (artifact) => snapshotArtifact(root, artifact));
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
  const leaves = revisionTreeLeaves(root, revision, artifact);
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
): DeclaredBaseline {
  captureDeclaredArtifactBaseline(root, artifacts);
  execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return capture(artifacts, (artifact) => snapshotArtifactAtRevision(root, revision, artifact));
}

function changedSince(baseline: DeclaredBaseline, current: DeclaredBaseline): readonly ReviewPath[] {
  const compared = changedDeclaredArtifacts(baseline, current);
  if (!compared.ok) throw new Error(compared.errors.join("; "));
  return compared.value;
}

/** Compare current bytes to a trusted git commit retained as task start_sha.
 * This is the recovery source when a legacy retry overwrote artifact_baseline
 * after implementation bytes had already landed. */
export function changedDeclaredArtifactsSinceRevision(
  root: string,
  revision: string,
  artifacts: readonly string[],
): readonly string[] {
  return changedSince(
    captureDeclaredArtifactBaselineAtRevision(root, revision, artifacts),
    captureDeclaredArtifactBaseline(root, artifacts),
  );
}

/** Imperative shell over the pure exact-set comparison. */
export function changedDeclaredArtifactsSince(
  root: string,
  baseline: readonly DeclaredArtifactBaseline[] | undefined,
): readonly string[] {
  // No start snapshot proves no change. This fail-closed value leaves every
  // declared-artifact obligation unsatisfied rather than trusting tool attempts.
  if (baseline === undefined) return Object.freeze([]);
  const parsed = parseArtifactBaseline<"declared-artifact">(baseline, "baseline");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return changedSince(parsed.value, captureDeclaredArtifactBaseline(root, parsed.value.map(({ artifact }) => artifact)));
}
