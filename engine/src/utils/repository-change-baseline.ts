/**
 * The repository change baseline: the `repository-change` digest scheme
 * (`file\0<mode>\0<bytes>` or `symlink\0<target>`) over every Git-dirty path,
 * captured before an implementation attempt and compared after it.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import {
  capturedArtifactBaseline,
  changedDeclaredArtifacts,
  parseArtifactBaseline,
  restrictedArtifactBaseline,
  type ArtifactBaseline,
  type ArtifactSnapshot,
  type DeclaredArtifactBaseline,
} from "../core/artifact-baseline";
import { sha256Bytes } from "../core/digest";
import { nulSeparatedGitPaths } from "./git-leaves";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "./repository-path";

type RepositoryChangeBaseline = ArtifactBaseline<"repository-change">;

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
  const digest = (bytes: Buffer): ArtifactSnapshot => Object.freeze({ kind: "sha256", digest: sha256Bytes(bytes) });
  const stat = lstatSync(inspected.absolute);
  if (stat.isSymbolicLink()) return digest(Buffer.from(`symlink\0${readlinkSync(inspected.absolute)}`, "utf-8"));
  if (stat.isFile()) {
    return digest(Buffer.concat([Buffer.from(`file\0${stat.mode & 0o777}\0`, "utf-8"), readFileSync(inspected.absolute)]));
  }
  throw new Error(`repository change must be a file or leaf symlink: ${artifact}`);
}

function captureRepositoryArtifacts(root: string, artifacts: readonly string[]): RepositoryChangeBaseline {
  const captured = capturedArtifactBaseline<"repository-change">(artifacts,
    (artifact) => snapshotRepositoryArtifact(root, artifact), "repository change baseline");
  if (!captured.ok) throw new Error(captured.errors.join("; "));
  return captured.value;
}

/** Compact repository boundary captured before an implementation attempt.
 * Clean tracked paths need no stored hash: if they become dirty, their entry in
 * repositoryChangedPaths is itself proof that this attempt changed them. */
export function captureRepositoryChangeBaseline(root: string): RepositoryChangeBaseline {
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
  const parsed = parseArtifactBaseline<"repository-change">(baseline, "repository baseline");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const currentPaths = repositoryChangedPaths(root);
  const baselinePaths = new Set<string>(parsed.value.map(({ artifact }) => artifact));
  const currentSet = new Set(currentPaths);
  const sharedBaseline = restrictedArtifactBaseline(parsed.value, (artifact) => currentSet.has(artifact));
  const sharedCurrent = captureRepositoryArtifacts(root, sharedBaseline.map(({ artifact }) => artifact));
  const compared = changedDeclaredArtifacts(sharedBaseline, sharedCurrent);
  if (!compared.ok) throw new Error(compared.errors.join("; "));
  const changed = new Set<string>(compared.value);
  for (const path of baselinePaths) {
    if (!currentSet.has(path)) changed.add(path);
  }
  for (const path of currentPaths) {
    if (!baselinePaths.has(path)) changed.add(path);
  }
  return Object.freeze([...changed].sort());
}
