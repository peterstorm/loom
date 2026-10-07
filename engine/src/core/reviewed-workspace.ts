/**
 * Reviewed-workspace identity: the exact bytes a Wave review saw for one
 * Task's declared scope, their content digest (`headSha`), and the drift of an
 * accepted review against current bytes. The persisted frozen-source codec
 * over these observations lives in `wave-frozen-source.ts`.
 */
import type { Task } from "../types";
import { sha256Hex } from "./digest";
import type { DomainResult } from "./orchestration-contract";
import { artifactCovers } from "./path-coverage";
import { compareStrings } from "./ordering";
import { parseReviewPath, type ReviewPath } from "./review-packet";

/** Bytes the shell observed for one file, before the core proves them.
 * `null` means the path was absent. */
export type ObservedArtifact = Readonly<{ path: string; bytes: Iterable<number> | null }>;

/** One proven reviewed file: a canonical repository path and its bytes, or
 * `null` when absent. A scoped file is its own artifact; a scoped directory
 * contributes one artifact per Git-visible leaf below it, or a single absent
 * artifact when it has none.
 *
 * The bytes are held as their canonical base64 text, the exact encoding
 * `headSha` commits to. A string is immutable by construction (a non-empty
 * typed array cannot be frozen) and costs about 1.33 bytes per source byte,
 * where the boxed `number[]` it replaced cost eight. */
export type ReviewedArtifact = Readonly<{ path: ReviewPath; contentBase64: string | null }>;

export type ReviewedWorkspaceAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  headSha: string;
  scope: readonly string[];
  runId?: string;
  authorityDigest?: string;
}>;

declare const REVIEWED_WORKSPACE: unique symbol;

/** One observation owns both the exact bytes and their derived identity.
 * Only `reviewedWorkspaceObservation` mints one. The brand makes the
 * headSha/artifact agreement a compile-time fact, and the module-private proof
 * set makes it a runtime one: a value spread or rebuilt around the smart
 * constructor (as a fake port could) keeps the brand's type but not the
 * proof, so `admitReviewedWorkspace` refuses it without re-hashing anything. */
export type ReviewedWorkspaceObservation = Readonly<{
  readonly [REVIEWED_WORKSPACE]: true;
  taskId: string;
  headSha: string;
  scope: readonly ReviewPath[];
  artifacts: readonly ReviewedArtifact[];
}>;

/** Every observation `reviewedWorkspaceObservation` minted. Each one is frozen
 * all the way down, so membership stays a true proof for its whole life. */
const mintedObservations = new WeakSet<object>();

/** A proven scope beside its proven artifacts. */
export type ReviewedArtifacts = Readonly<{ scope: readonly ReviewPath[]; artifacts: readonly ReviewedArtifact[] }>;

const failed = <T>(error: string): DomainResult<T, string> => ({ ok: false, error });
const isByte = (byte: unknown): byte is number =>
  typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255;

/** A scope of unique canonical repository paths, sorted. A non-canonical path
 * (a trailing slash, `./`, `..`) is refused here, so `artifactCovers` is total
 * over what follows. */
function parseScope(scope: readonly unknown[]): DomainResult<readonly ReviewPath[], string> {
  const paths: ReviewPath[] = [];
  for (const raw of scope) {
    const path = parseReviewPath(raw, "reviewed workspace scope path");
    if (!path.ok) return failed(path.errors.join("; "));
    paths.push(path.value);
  }
  if (new Set(paths).size !== paths.length) return failed("reviewed workspace scope must contain unique paths");
  return { ok: true, value: Object.freeze(paths.sort(compareStrings)) };
}

/** The canonical base64 of observed bytes. Encoding copies them out of any
 * mutable shell buffer. A typed array holds only bytes by construction and
 * encodes in place; any other iterable is materialized and checked first. */
function canonicalBase64(path: ReviewPath, bytes: Iterable<number>): DomainResult<string, string> {
  if (bytes instanceof Uint8Array) {
    return { ok: true, value: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") };
  }
  let materialized: readonly unknown[];
  try {
    materialized = Array.from(bytes);
  } catch {
    return failed(`reviewed workspace artifact ${path} does not contain iterable bytes`);
  }
  if (!materialized.every(isByte)) {
    return failed(`reviewed workspace artifact ${path} contains an invalid byte`);
  }
  return { ok: true, value: Buffer.from(materialized).toString("base64") };
}

/** Artifacts sorted by path, each at or below a scoped path, every scoped
 * path covering at least one. A file-only scope is exactly one artifact per
 * scoped path, so its encoding is unchanged. */
export function parseReviewedArtifacts(
  rawScope: readonly unknown[],
  artifacts: readonly ObservedArtifact[],
): DomainResult<ReviewedArtifacts, string> {
  const scope = parseScope(rawScope);
  if (!scope.ok) return scope;
  const byPath = new Map<ReviewPath, ReviewedArtifact>();
  for (const artifact of artifacts) {
    if (typeof artifact !== "object" || artifact === null || typeof artifact.path !== "string") {
      return failed("reviewed workspace contains a malformed artifact observation");
    }
    const path = parseReviewPath(artifact.path, "reviewed workspace artifact path");
    if (!path.ok) return failed(path.errors.join("; "));
    if (!scope.value.some((scoped) => artifactCovers(scoped, path.value))) {
      return failed(`reviewed workspace contains out-of-scope artifact ${path.value}`);
    }
    if (byPath.has(path.value)) {
      return failed(`reviewed workspace contains duplicate artifact ${path.value}`);
    }
    if (artifact.bytes === null) {
      byPath.set(path.value, Object.freeze({ path: path.value, contentBase64: null }));
      continue;
    }
    const content = canonicalBase64(path.value, artifact.bytes);
    if (!content.ok) return content;
    byPath.set(path.value, Object.freeze({ path: path.value, contentBase64: content.value }));
  }
  const paths = [...byPath.keys()];
  const missing = scope.value.find((scoped) => !paths.some((path) => artifactCovers(scoped, path)));
  if (missing !== undefined) return failed(`reviewed workspace snapshot omitted declared artifact ${missing}`);
  return {
    ok: true,
    value: Object.freeze({ scope: scope.value, artifacts: Object.freeze(paths.sort(compareStrings).map((path) => byPath.get(path)!)) }),
  };
}

/** Canonical content identity for proven bytes, independent of Git state. */
export function reviewedWorkspaceHeadSha(artifacts: readonly ReviewedArtifact[]): string {
  return sha256Hex(JSON.stringify(artifacts.map(({ path, contentBase64 }) => [path, contentBase64])));
}

/** Smart constructor, and the only mint: prove the observed scope and bytes,
 * copying mutable shell buffers, then derive the digest. */
export function reviewedWorkspaceObservation(
  taskId: string,
  scope: readonly string[],
  artifacts: readonly ObservedArtifact[],
): DomainResult<ReviewedWorkspaceObservation, string> {
  const parsed = parseReviewedArtifacts(scope, artifacts);
  if (!parsed.ok) return parsed;
  const observation = Object.freeze({
    taskId,
    scope: parsed.value.scope,
    artifacts: parsed.value.artifacts,
    headSha: reviewedWorkspaceHeadSha(parsed.value.artifacts),
  }) as ReviewedWorkspaceObservation;
  mintedObservations.add(observation);
  return { ok: true, value: observation };
}

/** Admit a minted observation as one Task's review snapshot: it must be that
 * Task's own and cover exactly that Task's review scope. Bytes and digest are
 * not derived again, because minting already proved them. */
export function admitReviewedWorkspace(
  taskId: string,
  expectedScope: readonly string[],
  observation: ReviewedWorkspaceObservation,
): DomainResult<ReviewedWorkspaceObservation, string> {
  if (!mintedObservations.has(observation)) {
    return failed(`Task ${taskId} workspace observation was not minted by the reviewed-workspace core`);
  }
  const canonicalScope = [...expectedScope].sort();
  if (new Set(canonicalScope).size !== canonicalScope.length) {
    return failed(`Task ${taskId} expected review scope contains duplicate paths`);
  }
  if (observation.taskId !== taskId) return failed(`Task ${taskId} workspace observation has mismatched Task identity`);
  if (observation.scope.length !== canonicalScope.length ||
      observation.scope.some((path, index) => path !== canonicalScope[index])) {
    return failed(`Task ${taskId} workspace observation differs from its exact review scope`);
  }
  return { ok: true, value: observation };
}

export function reviewedWorkspaceDrift(
  tasks: readonly Task[],
  observations: readonly ReviewedWorkspaceObservation[],
): readonly string[] {
  const byTask = new Map(observations.map((observation) => [observation.taskId, observation]));
  return tasks.flatMap((task) => {
    const authority = task.accepted_review_authority;
    if (authority === undefined) return [];
    const observation = byTask.get(task.id);
    if (observation === undefined) return [`${task.id}: current declared-artifact snapshot could not be observed`];
    const sameScope = authority.scope.length === observation.scope.length &&
      authority.scope.every((path, index) => path === observation.scope[index]);
    return sameScope && authority.head_sha === observation.headSha
      ? []
      : [`${task.id}: accepted Review Packet ${authority.packet_id} generation ${authority.generation} no longer matches declared workspace bytes; refresh review evidence`];
  });
}
