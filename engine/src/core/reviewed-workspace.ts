import type { Task } from "../types";
import { sha256Bytes, sha256Hex } from "./review-packet";
import type { DomainResult } from "./orchestration-contract";

export const WAVE_FROZEN_SOURCE_SECTION = "wave-frozen-source";
export const WAVE_FROZEN_SOURCE_SCHEMA_VERSION = 1;

/** Bytes observed for one path. `null` means the declared path was absent. */
export type ReviewedArtifact = Readonly<{ path: string; bytes: Iterable<number> | null }>;

export type ReviewedWorkspaceAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  headSha: string;
  scope: readonly string[];
  runId?: string;
  authorityDigest?: string;
}>;

/** One observation owns both the exact bytes and their derived identity. */
export type ReviewedWorkspaceObservation = Readonly<{
  taskId: string;
  headSha: string;
  scope: readonly string[];
  artifacts: readonly ReviewedArtifact[];
}>;

export type ReviewedWorkspaceSnapshot = ReviewedWorkspaceObservation;

export type WaveFrozenSourceFile =
  | Readonly<{ path: string; kind: "absent"; digest: null; byteLength: 0 }>
  | Readonly<{ path: string; kind: "text"; digest: string; byteLength: number; content: string }>
  | Readonly<{ path: string; kind: "binary"; digest: string; byteLength: number; contentBase64: string }>;

export type WaveFrozenSource = Readonly<{
  schemaVersion: typeof WAVE_FROZEN_SOURCE_SCHEMA_VERSION;
  taskId: string;
  workspaceHeadSha: string;
  files: readonly WaveFrozenSourceFile[];
}>;

const failed = <T>(error: string): DomainResult<T, string> => ({ ok: false, error });
const isByte = (byte: unknown): byte is number =>
  typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255;

function canonicalArtifacts(
  scope: readonly string[],
  artifacts: readonly ReviewedArtifact[],
): DomainResult<readonly ReviewedArtifact[], string> {
  if (scope.some((path) => typeof path !== "string" || path.trim() === "") || new Set(scope).size !== scope.length) {
    return failed("reviewed workspace scope must contain unique nonblank paths");
  }
  const scopeSet = new Set(scope);
  const byPath = new Map<string, ReviewedArtifact>();
  for (const artifact of artifacts) {
    if (typeof artifact !== "object" || artifact === null || typeof artifact.path !== "string") {
      return failed("reviewed workspace contains a malformed artifact observation");
    }
    if (!scopeSet.has(artifact.path)) {
      return failed(`reviewed workspace contains out-of-scope artifact ${artifact.path}`);
    }
    if (byPath.has(artifact.path)) {
      return failed(`reviewed workspace contains duplicate artifact ${artifact.path}`);
    }
    if (artifact.bytes === null) {
      byPath.set(artifact.path, Object.freeze({ path: artifact.path, bytes: null }));
      continue;
    }
    let materialized: readonly unknown[];
    try {
      materialized = Array.from(artifact.bytes);
    } catch {
      return failed(`reviewed workspace artifact ${artifact.path} does not contain iterable bytes`);
    }
    if (!materialized.every(isByte)) {
      return failed(`reviewed workspace artifact ${artifact.path} contains an invalid byte`);
    }
    byPath.set(artifact.path, Object.freeze({
      path: artifact.path,
      bytes: Object.freeze(materialized),
    }));
  }
  const missing = scope.find((path) => !byPath.has(path));
  if (missing !== undefined) return failed(`reviewed workspace snapshot omitted declared artifact ${missing}`);
  return { ok: true, value: Object.freeze(scope.map((path) => byPath.get(path)!)) };
}

function headSha(scope: readonly string[], artifacts: readonly ReviewedArtifact[]): string {
  return sha256Hex(JSON.stringify(scope.map((path, index) => {
    const bytes = artifacts[index]!.bytes;
    return [path, bytes === null ? null : Buffer.from(Uint8Array.from(bytes)).toString("base64")];
  })));
}

/** Canonical content identity for exact observed bytes, independent of Git state. */
export function reviewedWorkspaceHeadSha(
  scope: readonly string[],
  artifacts: readonly ReviewedArtifact[],
): string {
  const canonicalScope = [...scope].sort();
  const parsed = canonicalArtifacts(canonicalScope, artifacts);
  if (!parsed.ok) throw new Error(parsed.error);
  return headSha(canonicalScope, parsed.value);
}

/** Smart constructor: copy mutable shell buffers before deriving the digest. */
export function reviewedWorkspaceObservation(
  taskId: string,
  scope: readonly string[],
  artifacts: readonly ReviewedArtifact[],
): ReviewedWorkspaceObservation {
  const canonicalScope = Object.freeze([...scope].sort());
  const parsed = canonicalArtifacts(canonicalScope, artifacts);
  if (!parsed.ok) throw new Error(parsed.error);
  return Object.freeze({
    taskId,
    scope: canonicalScope,
    artifacts: parsed.value,
    headSha: headSha(canonicalScope, parsed.value),
  });
}

/** Parse an untrusted observation against one Task's exact review scope. */
export function parseReviewedWorkspaceSnapshot(
  taskId: string,
  expectedScope: readonly string[],
  observation: ReviewedWorkspaceObservation,
): DomainResult<ReviewedWorkspaceSnapshot, string> {
  const canonicalScope = Object.freeze([...expectedScope].sort());
  if (new Set(canonicalScope).size !== canonicalScope.length) {
    return failed(`Task ${taskId} expected review scope contains duplicate paths`);
  }
  if (observation.taskId !== taskId) return failed(`Task ${taskId} workspace observation has mismatched Task identity`);
  if (observation.scope.length !== canonicalScope.length ||
      observation.scope.some((path, index) => path !== canonicalScope[index])) {
    return failed(`Task ${taskId} workspace observation differs from its exact review scope`);
  }
  const artifacts = canonicalArtifacts(canonicalScope, observation.artifacts);
  if (!artifacts.ok) return failed(`Task ${taskId}: ${artifacts.error}`);
  const computed = headSha(canonicalScope, artifacts.value);
  if (observation.headSha !== computed) {
    return failed(`Task ${taskId} workspace bytes disagree with observed workspaceHeadSha`);
  }
  return {
    ok: true,
    value: Object.freeze({ taskId, scope: canonicalScope, artifacts: artifacts.value, headSha: computed }),
  };
}

export function waveFrozenSource(snapshot: ReviewedWorkspaceSnapshot): WaveFrozenSource {
  const files = snapshot.artifacts.map(({ path, bytes }): WaveFrozenSourceFile => {
    if (bytes === null) return Object.freeze({ path, kind: "absent", digest: null, byteLength: 0 });
    const materialized = Uint8Array.from(bytes);
    const digest = sha256Bytes(materialized);
    try {
      return Object.freeze({
        path,
        kind: "text",
        digest,
        byteLength: materialized.byteLength,
        content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(materialized),
      });
    } catch {
      return Object.freeze({
        path,
        kind: "binary",
        digest,
        byteLength: materialized.byteLength,
        contentBase64: Buffer.from(materialized).toString("base64"),
      });
    }
  });
  return Object.freeze({
    schemaVersion: WAVE_FROZEN_SOURCE_SCHEMA_VERSION,
    taskId: snapshot.taskId,
    workspaceHeadSha: snapshot.headSha,
    files: Object.freeze(files),
  });
}

const exactObject = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
  Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

/** Decode and re-prove every byte/digest/head join before reader projection. */
export function parseWaveFrozenSource(raw: unknown): DomainResult<WaveFrozenSource, string> {
  if (!exactObject(raw, ["schemaVersion", "taskId", "workspaceHeadSha", "files"]) ||
      raw.schemaVersion !== WAVE_FROZEN_SOURCE_SCHEMA_VERSION || typeof raw.taskId !== "string" || raw.taskId.trim() === "" ||
      typeof raw.workspaceHeadSha !== "string" || !/^[0-9a-f]{64}$/.test(raw.workspaceHeadSha) || !Array.isArray(raw.files)) {
    return failed("wave frozen source has an invalid schema");
  }
  const files: WaveFrozenSourceFile[] = [];
  const artifacts: ReviewedArtifact[] = [];
  const paths = new Set<string>();
  for (const [index, entry] of raw.files.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
        typeof entry.path !== "string" || entry.path.trim() === "" || paths.has(entry.path)) {
      return failed(`wave frozen source file ${index} has an invalid or duplicate path`);
    }
    paths.add(entry.path);
    if (entry.kind === "absent") {
      if (!exactObject(entry, ["path", "kind", "digest", "byteLength"]) || entry.digest !== null || entry.byteLength !== 0) {
        return failed(`wave frozen source absent file ${index} is malformed`);
      }
      files.push(Object.freeze({ path: entry.path, kind: "absent", digest: null, byteLength: 0 }));
      artifacts.push(Object.freeze({ path: entry.path, bytes: null }));
      continue;
    }
    const contentKey = entry.kind === "text" ? "content" : entry.kind === "binary" ? "contentBase64" : null;
    if (contentKey === null || !exactObject(entry, ["path", "kind", "digest", "byteLength", contentKey]) ||
        typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.digest) ||
        !Number.isSafeInteger(entry.byteLength) || (entry.byteLength as number) < 0 || typeof entry[contentKey] !== "string") {
      return failed(`wave frozen source file ${index} is malformed`);
    }
    const content = entry[contentKey] as string;
    const bytes = entry.kind === "text" ? Buffer.from(content, "utf8") : Buffer.from(content, "base64");
    if ((entry.kind === "binary" && bytes.toString("base64") !== content) || bytes.byteLength !== entry.byteLength ||
        sha256Bytes(bytes) !== entry.digest) {
      return failed(`wave frozen source file ${index} content differs from its digest or length`);
    }
    if (entry.kind === "text") {
      files.push(Object.freeze({ path: entry.path, kind: "text", digest: entry.digest,
        byteLength: entry.byteLength as number, content }));
    } else {
      files.push(Object.freeze({ path: entry.path, kind: "binary", digest: entry.digest,
        byteLength: entry.byteLength as number, contentBase64: content }));
    }
    artifacts.push(Object.freeze({ path: entry.path, bytes }));
  }
  const scope = files.map(({ path }) => path);
  const canonical = [...scope].sort();
  if (scope.some((path, index) => path !== canonical[index])) return failed("wave frozen source files must be sorted by path");
  const parsedArtifacts = canonicalArtifacts(scope, artifacts);
  if (!parsedArtifacts.ok || headSha(scope, parsedArtifacts.value) !== raw.workspaceHeadSha) {
    return failed("wave frozen source bytes disagree with workspaceHeadSha");
  }
  return { ok: true, value: Object.freeze({
    schemaVersion: WAVE_FROZEN_SOURCE_SCHEMA_VERSION,
    taskId: raw.taskId,
    workspaceHeadSha: raw.workspaceHeadSha,
    files: Object.freeze(files),
  }) };
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
