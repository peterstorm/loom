import type { Task } from "../types";
import { sha256Hex } from "./review-packet";

/** A byte-exact, declared-artifact snapshot. `null` means the declared path
 * was absent when the Review Packet was issued. */
export type ReviewedArtifact = Readonly<{ path: string; bytes: Uint8Array | null }>;

export type ReviewedWorkspaceAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  headSha: string;
  scope: readonly string[];
  runId?: string;
  authorityDigest?: string;
}>;

export type ReviewedWorkspaceObservation = Readonly<{
  taskId: string;
  headSha: string;
  scope: readonly string[];
}>;

/** Canonical content identity for declared artifacts. This deliberately hashes
 * the path set and raw bytes, not Git state: staged, dirty, and untracked files
 * are all observable review inputs. */
export function reviewedWorkspaceHeadSha(
  scope: readonly string[],
  artifacts: readonly ReviewedArtifact[],
): string {
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.bytes]));
  const canonical = [...scope].sort().map((path) => {
    const bytes = byPath.get(path);
    if (bytes === undefined) throw new Error(`reviewed workspace snapshot omitted declared artifact ${path}`);
    return [path, bytes === null ? null : Buffer.from(bytes).toString("base64")];
  });
  return sha256Hex(JSON.stringify(canonical));
}

export function reviewedWorkspaceObservation(
  taskId: string,
  scope: readonly string[],
  artifacts: readonly ReviewedArtifact[],
): ReviewedWorkspaceObservation {
  const canonicalScope = Object.freeze([...scope].sort());
  return Object.freeze({ taskId, scope: canonicalScope, headSha: reviewedWorkspaceHeadSha(canonicalScope, artifacts) });
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
