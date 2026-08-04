import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";

export type ArtifactSnapshot =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "sha256"; digest: string }>;

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
    if (!isRecord(entry) || typeof entry.artifact !== "string" || entry.artifact.trim() === "") {
      errors.push(`${entryPath}.artifact must be a non-empty string`);
      return;
    }
    if (seen.has(entry.artifact)) errors.push(`${entryPath}.artifact duplicates ${JSON.stringify(entry.artifact)}`);
    seen.add(entry.artifact);
    const snapshot = parseArtifactSnapshot(entry.snapshot, `${entryPath}.snapshot`);
    if (!snapshot.ok) errors.push(...snapshot.errors);
    else entries.push(Object.freeze({ artifact: entry.artifact, snapshot: snapshot.value }));
  });
  return errors.length > 0 ? fail(errors) : ok(Object.freeze(entries));
}

const snapshotEquals = (left: ArtifactSnapshot, right: ArtifactSnapshot): boolean =>
  left.kind === right.kind && (left.kind === "missing" || (right.kind === "sha256" && left.digest === right.digest));

/**
 * A declared artifact is attributable to one task only when both independent
 * observations agree: repository bytes changed after its baseline, and that
 * task's structured transcript records a write to the same canonical path.
 */
export function attributedChangedArtifacts(
  byteChanges: readonly string[],
  taskWrites: readonly string[],
): readonly string[] {
  const written = new Set(taskWrites);
  return Object.freeze([...new Set(byteChanges)].filter((artifact) => written.has(artifact)));
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
