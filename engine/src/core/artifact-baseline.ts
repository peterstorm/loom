import { compareStrings } from "./ordering";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { parseReviewPath, type ReviewPath } from "./review-packet";
import { sha256Hex } from "./digest";
import { artifactCovers } from "./path-coverage";

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

/** The persisted wire record of one baseline entry, as Task state stores it.
 *  Both digest schemes below share this shape on disk. */
export type DeclaredArtifactBaseline = Readonly<{
  artifact: string;
  snapshot: ArtifactSnapshot;
}>;

/**
 * The two digest preimages an `ArtifactSnapshot` can carry. They persist in
 * the same `{kind:"sha256", digest}` shape but hash different bytes, so equal
 * files digest differently under each and the two must never be compared:
 *
 * - `declared-artifact`: a file's raw bytes, or a directory's tree digest
 *   (`treeSnapshotDigest`). Mode is not part of the preimage.
 * - `repository-change`: `file\0<mode>\0<bytes>` or `symlink\0<target>`, so a
 *   mode-only change of a path already dirty at spawn registers.
 */
export type SnapshotScheme = "declared-artifact" | "repository-change";

/** One parsed baseline entry: a canonical repository path and its snapshot. */
export type ArtifactBaselineEntry = Readonly<{ artifact: ReviewPath; snapshot: ArtifactSnapshot }>;

declare const PARSED_BASELINE: unique symbol;

/**
 * A baseline proven by `artifactBaseline`: canonical, unique artifact paths and
 * well-formed snapshots, tagged with the digest scheme its snapshots were
 * hashed under. `SnapshotScheme` itself (the union) is a baseline whose scheme
 * its parse site cannot know — the scheme-agnostic State File wire parse.
 */
export type ArtifactBaseline<Scheme extends SnapshotScheme = SnapshotScheme> =
  readonly ArtifactBaselineEntry[] & { readonly [PARSED_BASELINE]: Scheme };

const SHA256 = /^[a-f0-9]{64}$/;

function parseArtifactSnapshot(raw: unknown, path: string): ParseResult<ArtifactSnapshot> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "missing") return ok(Object.freeze({ kind: "missing" as const }));
  if (raw.kind === "sha256" && typeof raw.digest === "string" && SHA256.test(raw.digest)) {
    return ok(Object.freeze({ kind: "sha256" as const, digest: raw.digest }));
  }
  return fail([`${path} must be {kind:"missing"} or {kind:"sha256", digest:<64 lowercase hex chars>}`]);
}

/** Smart constructor over already-typed entries: the set invariant (one entry
 *  per artifact) is the only thing left to prove. Entry order is preserved. */
export function artifactBaseline<Scheme extends SnapshotScheme>(
  entries: readonly ArtifactBaselineEntry[],
  path = "artifact_baseline",
): ParseResult<ArtifactBaseline<Scheme>> {
  const seen = new Set<string>();
  const errors: string[] = [];
  entries.forEach((entry, index) => {
    if (seen.has(entry.artifact)) errors.push(`${path}[${index}].artifact duplicates ${JSON.stringify(entry.artifact)}`);
    seen.add(entry.artifact);
  });
  // The one brand proof site: every entry is typed and the set is unique.
  return errors.length > 0
    ? fail(errors)
    : ok(Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))) as unknown as ArtifactBaseline<Scheme>);
}

/** The entries whose artifact `keep` accepts. A subset of a proven set is
 *  still one, under the same digest scheme. */
export function restrictedArtifactBaseline<Scheme extends SnapshotScheme>(
  baseline: ArtifactBaseline<Scheme>,
  keep: (artifact: ReviewPath) => boolean,
): ArtifactBaseline<Scheme> {
  return Object.freeze(baseline.filter((entry) => keep(entry.artifact))) as unknown as ArtifactBaseline<Scheme>;
}

/**
 * The one capture shape for every snapshot source: each distinct artifact, in
 * first-seen order, beside its snapshot under ONE digest scheme. `snapshot`
 * runs first, so its own path refusal is the one a caller sees.
 */
export function capturedArtifactBaseline<Scheme extends SnapshotScheme>(
  artifacts: readonly string[],
  snapshot: (artifact: string) => ArtifactSnapshot,
  path: string,
): ParseResult<ArtifactBaseline<Scheme>> {
  const entries: ArtifactBaselineEntry[] = [];
  for (const raw of new Set(artifacts)) {
    const captured = snapshot(raw);
    const artifact = parseReviewPath(raw, `${path} artifact`);
    if (!artifact.ok) return artifact;
    entries.push({ artifact: artifact.value, snapshot: captured });
  }
  return artifactBaseline<Scheme>(entries, path);
}

/** Parse a persisted baseline whose digest scheme the caller knows from the
 *  Task field it came from. */
export function parseArtifactBaseline<Scheme extends SnapshotScheme>(
  raw: unknown,
  path = "artifact_baseline",
): ParseResult<ArtifactBaseline<Scheme>> {
  if (!Array.isArray(raw)) return fail([`${path} must be an array`]);
  const entries: ArtifactBaselineEntry[] = [];
  const errors: string[] = [];
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
    const snapshot = parseArtifactSnapshot(entry.snapshot, `${entryPath}.snapshot`);
    if (!snapshot.ok) errors.push(...snapshot.errors);
    else entries.push({ artifact: artifact.value, snapshot: snapshot.value });
  });
  const unique = artifactBaseline<Scheme>(entries, path);
  const allErrors = [...errors, ...(unique.ok ? [] : unique.errors)];
  return allErrors.length > 0 ? fail(allErrors) : unique;
}

/** Validate a persisted baseline at the State File boundary, where one wire
 *  shape carries either digest scheme and Task fields store the wire record.
 *  A comparison parses its field again under the field's own scheme. */
export function parseDeclaredArtifactBaseline(
  raw: unknown,
  path = "artifact_baseline",
): ParseResult<readonly DeclaredArtifactBaseline[]> {
  return parseArtifactBaseline<SnapshotScheme>(raw, path);
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
 * Pure comparison of two exact artifact sets hashed under ONE digest scheme.
 * Both sides are already parsed; a missing or foreign current entry is
 * contract corruption, never evidence that an artifact changed.
 */
export function changedDeclaredArtifacts<Scheme extends SnapshotScheme>(
  baseline: ArtifactBaseline<Scheme>,
  current: ArtifactBaseline<NoInfer<Scheme>>,
): ParseResult<readonly ReviewPath[]> {
  const currentByArtifact = new Map(current.map((entry) => [entry.artifact, entry]));
  const expected = new Set<string>(baseline.map((entry) => entry.artifact));
  const errors = [
    ...baseline.flatMap((entry) => currentByArtifact.has(entry.artifact)
      ? []
      : [`current snapshot is missing declared artifact ${JSON.stringify(entry.artifact)}`]),
    ...current.flatMap((entry) => expected.has(entry.artifact)
      ? []
      : [`current snapshot contains foreign artifact ${JSON.stringify(entry.artifact)}`]),
  ];
  if (errors.length > 0) return fail(errors);
  return ok(Object.freeze(baseline.flatMap((entry) => {
    const now = currentByArtifact.get(entry.artifact)!;
    return snapshotEquals(entry.snapshot, now.snapshot) ? [] : [entry.artifact];
  })));
}
