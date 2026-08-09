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
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(`symlink\0${readlinkSync(inspected.absolute)}`, "utf-8")
    : stat.isFile()
      ? Buffer.concat([
          Buffer.from(`file\0${stat.mode & 0o777}\0`, "utf-8"),
          readFileSync(inspected.absolute),
        ])
      : null;
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
