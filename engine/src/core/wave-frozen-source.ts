/**
 * The Wave frozen-source codec: the versioned, self-proving encoding of one
 * reviewed-workspace snapshot that a Wave reviewer's Context Packet carries.
 */
import { sha256Bytes } from "./digest";
import type { DomainResult } from "./orchestration-contract";
import { hasExactPlainKeys, isRecord } from "./plain-record";
import {
  parseReviewedArtifacts,
  reviewedWorkspaceHeadSha,
  type ObservedArtifact,
  type ReviewedWorkspaceObservation,
} from "./reviewed-workspace";

export const WAVE_FROZEN_SOURCE_SECTION = "wave-frozen-source";
export const WAVE_FROZEN_SOURCE_SCHEMA_VERSION = 1;

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

export function waveFrozenSource(snapshot: ReviewedWorkspaceObservation): WaveFrozenSource {
  const files = snapshot.artifacts.map(({ path, contentBase64 }): WaveFrozenSourceFile => {
    if (contentBase64 === null) return Object.freeze({ path, kind: "absent", digest: null, byteLength: 0 });
    const materialized = Buffer.from(contentBase64, "base64");
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
        contentBase64,
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

/** Decode and re-prove every byte/digest/head join before reader projection.
 *  Every record admits its exact key set through the strict `hasExactPlainKeys`
 *  (plain prototype, no symbol keys); the diagnostics are the codec's own. */
export function parseWaveFrozenSource(raw: unknown): DomainResult<WaveFrozenSource, string> {
  if (!hasExactPlainKeys(raw, ["schemaVersion", "taskId", "workspaceHeadSha", "files"]) ||
      raw.schemaVersion !== WAVE_FROZEN_SOURCE_SCHEMA_VERSION || typeof raw.taskId !== "string" || raw.taskId.trim() === "" ||
      typeof raw.workspaceHeadSha !== "string" || !/^[0-9a-f]{64}$/.test(raw.workspaceHeadSha) || !Array.isArray(raw.files)) {
    return failed("wave frozen source has an invalid schema");
  }
  const files: WaveFrozenSourceFile[] = [];
  const artifacts: ObservedArtifact[] = [];
  const paths = new Set<string>();
  for (const [index, entry] of raw.files.entries()) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.trim() === "" || paths.has(entry.path)) {
      return failed(`wave frozen source file ${index} has an invalid or duplicate path`);
    }
    paths.add(entry.path);
    if (entry.kind === "absent") {
      if (!hasExactPlainKeys(entry, ["path", "kind", "digest", "byteLength"]) || entry.digest !== null || entry.byteLength !== 0) {
        return failed(`wave frozen source absent file ${index} is malformed`);
      }
      files.push(Object.freeze({ path: entry.path, kind: "absent", digest: null, byteLength: 0 }));
      artifacts.push(Object.freeze({ path: entry.path, bytes: null }));
      continue;
    }
    const contentKey = entry.kind === "text" ? "content" : entry.kind === "binary" ? "contentBase64" : null;
    if (contentKey === null || !hasExactPlainKeys(entry, ["path", "kind", "digest", "byteLength", contentKey]) ||
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
  const parsedArtifacts = parseReviewedArtifacts(scope, artifacts);
  if (!parsedArtifacts.ok || reviewedWorkspaceHeadSha(parsedArtifacts.value.artifacts) !== raw.workspaceHeadSha) {
    return failed("wave frozen source bytes disagree with workspaceHeadSha");
  }
  return { ok: true, value: Object.freeze({
    schemaVersion: WAVE_FROZEN_SOURCE_SCHEMA_VERSION,
    taskId: raw.taskId,
    workspaceHeadSha: raw.workspaceHeadSha,
    files: Object.freeze(files),
  }) };
}
