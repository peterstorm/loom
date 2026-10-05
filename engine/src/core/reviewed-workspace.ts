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

/** One proven reviewed file: a canonical repository path and its owned bytes,
 * or `null` when absent. A scoped file is its own artifact; a scoped directory
 * contributes one artifact per Git-visible leaf below it, or a single absent
 * artifact when it has none. */
export type ReviewedArtifact = Readonly<{ path: ReviewPath; bytes: readonly number[] | null }>;

export type ReviewedWorkspaceAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  headSha: string;
  scope: readonly string[];
  runId?: string;
  authorityDigest?: string;
}>;

/** One observation owns both the exact bytes and their derived identity.
 * Only `reviewedWorkspaceObservation` and `parseReviewedWorkspaceSnapshot`
 * construct one the core trusts. */
export type ReviewedWorkspaceObservation = Readonly<{
  taskId: string;
  headSha: string;
  scope: readonly ReviewPath[];
  artifacts: readonly ReviewedArtifact[];
}>;

export type ReviewedWorkspaceSnapshot = ReviewedWorkspaceObservation;

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
      byPath.set(path.value, Object.freeze({ path: path.value, bytes: null }));
      continue;
    }
    let materialized: readonly unknown[];
    try {
      materialized = Array.from(artifact.bytes);
    } catch {
      return failed(`reviewed workspace artifact ${path.value} does not contain iterable bytes`);
    }
    if (!materialized.every(isByte)) {
      return failed(`reviewed workspace artifact ${path.value} contains an invalid byte`);
    }
    byPath.set(path.value, Object.freeze({ path: path.value, bytes: Object.freeze(materialized) }));
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
  return sha256Hex(JSON.stringify(artifacts.map(({ path, bytes }) =>
    [path, bytes === null ? null : Buffer.from(Uint8Array.from(bytes)).toString("base64")])));
}

/** Smart constructor: prove the observed scope and bytes, copying mutable
 * shell buffers, then derive the digest. */
export function reviewedWorkspaceObservation(
  taskId: string,
  scope: readonly string[],
  artifacts: readonly ObservedArtifact[],
): DomainResult<ReviewedWorkspaceObservation, string> {
  const parsed = parseReviewedArtifacts(scope, artifacts);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: Object.freeze({
      taskId,
      scope: parsed.value.scope,
      artifacts: parsed.value.artifacts,
      headSha: reviewedWorkspaceHeadSha(parsed.value.artifacts),
    }),
  };
}

/** Parse an untrusted observation against one Task's exact review scope. */
export function parseReviewedWorkspaceSnapshot(
  taskId: string,
  expectedScope: readonly string[],
  observation: ReviewedWorkspaceObservation,
): DomainResult<ReviewedWorkspaceSnapshot, string> {
  const canonicalScope = [...expectedScope].sort();
  if (new Set(canonicalScope).size !== canonicalScope.length) {
    return failed(`Task ${taskId} expected review scope contains duplicate paths`);
  }
  if (observation.taskId !== taskId) return failed(`Task ${taskId} workspace observation has mismatched Task identity`);
  if (observation.scope.length !== canonicalScope.length ||
      observation.scope.some((path, index) => path !== canonicalScope[index])) {
    return failed(`Task ${taskId} workspace observation differs from its exact review scope`);
  }
  const parsed = parseReviewedArtifacts(canonicalScope, observation.artifacts);
  if (!parsed.ok) return failed(`Task ${taskId}: ${parsed.error}`);
  const computed = reviewedWorkspaceHeadSha(parsed.value.artifacts);
  if (observation.headSha !== computed) {
    return failed(`Task ${taskId} workspace bytes disagree with observed workspaceHeadSha`);
  }
  return {
    ok: true,
    value: Object.freeze({ taskId, scope: parsed.value.scope, artifacts: parsed.value.artifacts, headSha: computed }),
  };
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
