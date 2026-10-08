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
 * A baseline proven by one scheme's entry points (`DECLARED_ARTIFACT_BASELINE`,
 * `REPOSITORY_CHANGE_BASELINE`): canonical, unique artifact paths and
 * well-formed snapshots, tagged with the digest scheme its snapshots were
 * hashed under. `SnapshotScheme` itself (the union) is a baseline whose scheme
 * its parse site cannot know (`UNKNOWN_SCHEME_BASELINE`), which no comparison
 * accepts.
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
 *  per artifact) is the only thing left to prove. Entry order is preserved.
 *  Module-private: `Scheme` is the caller's claim, so only the issued
 *  `ArtifactBaselineScheme` instances below may make it. */
function provenArtifactBaseline<Scheme extends SnapshotScheme>(
  entries: readonly ArtifactBaselineEntry[],
  path: string,
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
 * The runtime tag of an issued scheme: its concrete digest scheme, or
 * `"unknown"` for the wide scheme a digest-only read cannot name. Derived from
 * the type argument, so an instance's tag can never disagree with its type.
 */
type IssuedSchemeTag<Scheme extends SnapshotScheme> =
  [SnapshotScheme] extends [Scheme] ? "unknown" : Scheme;

/**
 * The construction entry points of ONE digest scheme. The scheme is fixed by
 * which issued instance a caller names, never by a type argument it supplies,
 * so the choice is visible (and reviewable) at every capture and parse site.
 *
 * Exported as a type only (`ArtifactBaselineScheme`): the three constants
 * below are the only instances, so every `ArtifactBaseline<Scheme>` traces
 * back to one of them. Each is frozen at construction and carries its own tag.
 */
class ArtifactBaselineEntryPoints<Scheme extends SnapshotScheme> {
  /**
   * The runtime discriminant and the nominal brand in one field. A
   * class-private name cannot be written by an object literal, copied by a
   * spread, or declared by a class outside this module, so nothing inhabits
   * an issued scheme's type without this module's constructor.
   */
  readonly #scheme: IssuedSchemeTag<Scheme>;

  constructor(scheme: IssuedSchemeTag<Scheme>) {
    this.#scheme = scheme;
    Object.freeze(this);
  }

  /** Which digest scheme this instance issues: the tag a runtime guard checks. */
  get scheme(): IssuedSchemeTag<Scheme> {
    return this.#scheme;
  }

  /** Prove already-typed entries (one entry per artifact). */
  fromEntries(entries: readonly ArtifactBaselineEntry[], path = "artifact_baseline"): ParseResult<ArtifactBaseline<Scheme>> {
    return provenArtifactBaseline<Scheme>(entries, path);
  }

  /** Snapshot each distinct artifact, in first-seen order; `snapshot` runs
   *  first, so its own path refusal is the one a caller sees. */
  capture(
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
    return provenArtifactBaseline<Scheme>(entries, path);
  }

  /** Read a persisted baseline from a Task field this scheme owns. Errors are
   *  reported in raw index order, a duplicate artifact inline at its own index
   *  (even when that entry's snapshot also fails to parse). */
  parse(raw: unknown, path = "artifact_baseline"): ParseResult<ArtifactBaseline<Scheme>> {
    if (!Array.isArray(raw)) return fail([`${path} must be an array`]);
    const entries: ArtifactBaselineEntry[] = [];
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
      else entries.push({ artifact: artifact.value, snapshot: snapshot.value });
    });
    // Every entry parsed and every artifact is unique, so the brand proof holds.
    return errors.length > 0 ? fail(errors) : provenArtifactBaseline<Scheme>(entries, path);
  }
}

/** One issued scheme's entry points. Type-only: callers name the issued
 *  instances; none can construct, extend or forge one. */
export type ArtifactBaselineScheme<Scheme extends SnapshotScheme> = ArtifactBaselineEntryPoints<Scheme>;

/** `artifact_baseline` / `attempt_artifact_baseline`: raw file bytes or a directory tree digest. */
export const DECLARED_ARTIFACT_BASELINE: ArtifactBaselineScheme<"declared-artifact"> =
  new ArtifactBaselineEntryPoints<"declared-artifact">("declared-artifact");
/** `repository_baseline` / `attempt_repository_baseline`: `file\0<mode>\0<bytes>` or `symlink\0<target>`. */
export const REPOSITORY_CHANGE_BASELINE: ArtifactBaselineScheme<"repository-change"> =
  new ArtifactBaselineEntryPoints<"repository-change">("repository-change");
/** A digest-only read whose scheme its site cannot know; the result can never reach a comparison. */
export const UNKNOWN_SCHEME_BASELINE: ArtifactBaselineScheme<SnapshotScheme> =
  new ArtifactBaselineEntryPoints<SnapshotScheme>("unknown");

/** The Task State File fields that persist a baseline, and the digest scheme
 *  each one is captured under. */
type TaskBaselineFieldSchemes = Readonly<{
  artifact_baseline: "declared-artifact";
  attempt_artifact_baseline: "declared-artifact";
  repository_baseline: "repository-change";
  attempt_repository_baseline: "repository-change";
}>;

export type TaskBaselineField = keyof TaskBaselineFieldSchemes;

const TASK_BASELINE_FIELD_SCHEMES: {
  readonly [Field in TaskBaselineField]: ArtifactBaselineScheme<TaskBaselineFieldSchemes[Field]>;
} = Object.freeze({
  artifact_baseline: DECLARED_ARTIFACT_BASELINE,
  attempt_artifact_baseline: DECLARED_ARTIFACT_BASELINE,
  repository_baseline: REPOSITORY_CHANGE_BASELINE,
  attempt_repository_baseline: REPOSITORY_CHANGE_BASELINE,
});

/**
 * Re-prove one persisted Task baseline field under the digest scheme that
 * field owns. The field name selects both the value read and its scheme, so a
 * call site cannot read one field under another field's scheme. An absent
 * field is `undefined`, never an empty baseline.
 */
export function parseTaskBaselineField<Field extends TaskBaselineField>(
  task: Readonly<Partial<Record<Field, unknown>>>,
  field: Field,
  path: string,
): ParseResult<ArtifactBaseline<TaskBaselineFieldSchemes[Field]>> | undefined {
  const raw = task[field];
  return raw === undefined ? undefined : TASK_BASELINE_FIELD_SCHEMES[field].parse(raw, path);
}

/** The scheme-agnostic State File wire parse and nothing more: one wire shape
 *  carries either digest scheme and Task fields store the wire record, so the
 *  result is widened to that record and cannot reach a comparison. A
 *  comparison parses its field again under the field's own scheme. */
export function parseDeclaredArtifactBaseline(
  raw: unknown,
  path = "artifact_baseline",
): ParseResult<readonly DeclaredArtifactBaseline[]> {
  return UNKNOWN_SCHEME_BASELINE.parse(raw, path);
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
 *
 * `Scheme` must be one concrete scheme: a baseline typed with the wide
 * `SnapshotScheme` union (a parse site that cannot know its scheme) would
 * otherwise accept either concrete current baseline through the brand's
 * covariance, so the trailing rest parameter demands an impossible `never`
 * argument for the union and the call fails to compile.
 */
export function changedDeclaredArtifacts<Scheme extends SnapshotScheme>(
  baseline: ArtifactBaseline<Scheme>,
  current: ArtifactBaseline<NoInfer<Scheme>>,
  ..._concreteScheme: SnapshotScheme extends Scheme ? [wideSchemeIsNotComparable: never] : []
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
