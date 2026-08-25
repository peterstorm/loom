/** Shared no-follow/atomic session TaskGraph pointer lifecycle. */

import { realpathSync } from "node:fs";
import { subagentDir } from "../config";
import {
  readDirectoryFileNoFollow,
  removeDirectoryFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileAtomicNoFollow,
  type AnchoredDirectory,
} from "../orchestration/no-follow-fs";
import type { SessionId } from "./evidence";

export type SessionTaskGraphPointerBinding =
  | Readonly<{
      kind: "shared";
      directory: string;
      pointerName: string;
      target: string;
    }>
  | Readonly<{
      kind: "owned";
      directory: string;
      pointerName: string;
      target: string;
      previous: string | null;
    }>;

export type SessionTaskGraphPointerRollback = "rolled-back" | "not-owned" | "ownership-lost";

function optionalPointer(
  directory: AnchoredDirectory,
  pointerName: string,
): string | null {
  try {
    return readDirectoryFileNoFollow(directory, pointerName).toString("utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Bind one session to the canonical active graph. Mismatch refresh is atomic;
 * every pointer read/write refuses symlinks. The returned owned arm is the
 * exact capability required to roll this mutation back.
 */
export async function bindSessionTaskGraphPointer(
  sessionId: SessionId,
  activeTaskGraphPath: string,
  directory = subagentDir(),
): Promise<SessionTaskGraphPointerBinding> {
  const target = realpathSync.native(activeTaskGraphPath);
  const pointerName = `${sessionId}.task_graph`;
  const lockName = `${sessionId}.task-graph-pointer.lock`;
  return withAnchoredDirectoryLock(directory, lockName, (anchored) => {
    const previous = optionalPointer(anchored, pointerName);
    if (previous === target) {
      return Object.freeze({ kind: "shared" as const, directory, pointerName, target });
    }
    writeDirectoryFileAtomicNoFollow(anchored, pointerName, target);
    return Object.freeze({ kind: "owned" as const, directory, pointerName, target, previous });
  });
}

/** Roll back only while the pointer still contains this binding's exact target. */
export async function rollbackSessionTaskGraphPointer(
  binding: SessionTaskGraphPointerBinding,
): Promise<SessionTaskGraphPointerRollback> {
  if (binding.kind === "shared") return "not-owned";
  const lockName = `${binding.pointerName.slice(0, -".task_graph".length)}.task-graph-pointer.lock`;
  return withAnchoredDirectoryLock(binding.directory, lockName, (anchored) => {
    if (optionalPointer(anchored, binding.pointerName) !== binding.target) return "ownership-lost" as const;
    if (binding.previous === null) removeDirectoryFileNoFollow(anchored, binding.pointerName);
    else writeDirectoryFileAtomicNoFollow(anchored, binding.pointerName, binding.previous);
    return "rolled-back" as const;
  });
}
