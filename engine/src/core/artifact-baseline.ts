import { compareStrings } from "./ordering";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { parseReviewPath, sha256Hex } from "./review-packet";
import { artifactCovers } from "./path-coverage";

export { artifactCovers, scopeCovers } from "./path-coverage";

/** A directory artifact snapshots as `sha256` over its tree digest, so the
 *  persisted shape is the same for file and directory artifacts. */
export type ArtifactSnapshot =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "sha256"; digest: string }>;

/** One leaf of a directory artifact. `path` is relative to the declared
 *  directory; `contentSha256` hashes a file's bytes or a symlink's target text —
 *  exactly the bytes Git stores in the blob, so worktree and revision agree. */
export type TreeEntry = Readonly<{
  path: string;
  kind: "file" | "symlink";
  contentSha256: string;
}>;

/** Deterministic digest of a directory artifact, independent of enumeration order. */
export function treeSnapshotDigest(entries: readonly TreeEntry[]): string {
  const lines = [...entries]
    .sort((left, right) => compareStrings(left.path, right.path))
    .map(({ kind, path, contentSha256 }) => `${kind}\0${path}\0${contentSha256}\n`);
  return sha256Hex(`tree\0${lines.join("")}`);
}

export type DeclaredArtifactBaseline = Readonly<{
  artifact: string;
  snapshot: ArtifactSnapshot;
}>;

const SHA256 = /^[a-f0-9]{64}$/;

function parseArtifactSnapshot(raw: unknown, path: string): ParseResult<ArtifactSnapshot> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "missing") return ok(Object.freeze({ kind: "missing" as const }));
  if (raw.kind === "sha256" && typeof raw.digest === "string" && SHA256.test(raw.digest)) {
    return ok(Object.freeze({ kind: "sha256" as const, digest: raw.digest }));
  }
  return fail([`${path} must be {kind:"missing"} or {kind:"sha256", digest:<64 lowercase hex chars>}`]);
}

/** Parse the persisted start-of-task artifact snapshot at the state boundary. */
export function parseDeclaredArtifactBaseline(
  raw: unknown,
  path = "artifact_baseline",
): ParseResult<readonly DeclaredArtifactBaseline[]> {
  if (!Array.isArray(raw)) return fail([`${path} must be an array`]);
  const entries: DeclaredArtifactBaseline[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath} must be an object`);
      return;
    }
    const artifact = parseReviewPath(entry.artifact, `${entryPath}.artifact`);
    if (!artifact.ok) {
      errors.push(...artifact.errors);
      return;
    }
    if (seen.has(artifact.value)) errors.push(`${entryPath}.artifact duplicates ${JSON.stringify(artifact.value)}`);
    seen.add(artifact.value);
    const snapshot = parseArtifactSnapshot(entry.snapshot, `${entryPath}.snapshot`);
    if (!snapshot.ok) errors.push(...snapshot.errors);
    else entries.push(Object.freeze({ artifact: artifact.value, snapshot: snapshot.value }));
  });
  return errors.length > 0 ? fail(errors) : ok(Object.freeze(entries));
}

const snapshotEquals = (left: ArtifactSnapshot, right: ArtifactSnapshot): boolean =>
  left.kind === right.kind && (left.kind === "missing" || (right.kind === "sha256" && left.digest === right.digest));

/**
 * A declared artifact is attributable to one task only when both independent
 * observations agree: repository bytes changed after its baseline, and that
 * task's structured transcript records a write the artifact covers.
 */
export function attributedChangedArtifacts<Artifact extends string>(
  byteChanges: readonly Artifact[],
  taskWrites: readonly string[],
): readonly Artifact[] {
  return Object.freeze([...new Set(byteChanges)].filter((artifact) =>
    taskWrites.some((path) => artifactCovers(artifact, path))));
}

/**
 * Pure comparison of two exact artifact sets. A missing or foreign current
 * entry is contract corruption, never evidence that an artifact changed.
 */
export function changedDeclaredArtifacts(
  baseline: readonly DeclaredArtifactBaseline[],
  current: readonly DeclaredArtifactBaseline[],
): ParseResult<readonly string[]> {
  const parsedBaseline = parseDeclaredArtifactBaseline(baseline, "baseline");
  const parsedCurrent = parseDeclaredArtifactBaseline(current, "current");
  if (!parsedBaseline.ok || !parsedCurrent.ok) {
    return fail([
      ...(parsedBaseline.ok ? [] : parsedBaseline.errors),
      ...(parsedCurrent.ok ? [] : parsedCurrent.errors),
    ]);
  }
  const currentByArtifact = new Map(parsedCurrent.value.map((entry) => [entry.artifact, entry]));
  const expected = new Set(parsedBaseline.value.map((entry) => entry.artifact));
  const errors = [
    ...parsedBaseline.value.flatMap((entry) => currentByArtifact.has(entry.artifact)
      ? []
      : [`current snapshot is missing declared artifact ${JSON.stringify(entry.artifact)}`]),
    ...parsedCurrent.value.flatMap((entry) => expected.has(entry.artifact)
      ? []
      : [`current snapshot contains foreign artifact ${JSON.stringify(entry.artifact)}`]),
  ];
  if (errors.length > 0) return fail(errors);
  return ok(Object.freeze(parsedBaseline.value.flatMap((entry) => {
    const now = currentByArtifact.get(entry.artifact)!;
    return snapshotEquals(entry.snapshot, now.snapshot) ? [] : [entry.artifact];
  })));
}
