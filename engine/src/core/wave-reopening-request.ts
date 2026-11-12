/**
 * The completed-Wave reopening payload: what `helper reopen-completed-wave`
 * reads from stdin, and what `docs/operations.md` teaches as the
 * `completed-wave-reopening` wire example (ADR-0073).
 *
 * Pure: a refusal is returned as data, and the handler renders it.
 */

import {
  nonEmpty,
  parseArtifactDigest,
  parseOrchestrationRunId,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
  type OrchestrationRunId,
} from "./orchestration-contract/identity";
import { hasExactKeys, isRecord } from "./plain-record";
import { parseTaskId, type TaskId } from "./task-id";

/** The reopening payload as its parse proved it: each field the identity it was checked to be. */
export type ReopenRequest = Readonly<{
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  taskIds: NonEmpty<TaskId>;
}>;

const REOPEN_REQUEST_KEYS: readonly string[] = ["runId", "wave", "authorityDigest", "taskIds"];

const refused = (message: string): DomainResult<ReopenRequest, string> => ({ ok: false, error: message });

/** Each entry as a Task id, or null when any entry is not one or the list is empty or repeats one. */
function parseTaskIds(raw: unknown): NonEmpty<TaskId> | null {
  if (!Array.isArray(raw)) return null;
  const entries: readonly unknown[] = raw;
  const ids: TaskId[] = [];
  for (const entry of entries) {
    const id = parseTaskId(entry, "reopening.taskId");
    if (!id.ok) return null;
    ids.push(id.value);
  }
  return new Set(ids).size === ids.length ? nonEmpty(ids) : null;
}

/** The exact reopening payload: `runId`, `wave`, `authorityDigest` and `taskIds`, and no other key. */
export function parseReopenRequest(raw: string): DomainResult<ReopenRequest, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return refused(`reopening payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) return refused("reopening payload must be an object");
  if (!hasExactKeys(value, REOPEN_REQUEST_KEYS)) {
    return refused("reopening payload must contain exactly runId/wave/authorityDigest/taskIds");
  }
  const { wave } = value;
  const runId = parseOrchestrationRunId(value.runId);
  const authorityDigest = parseArtifactDigest(value.authorityDigest);
  const taskIds = parseTaskIds(value.taskIds);
  if (!runId.ok ||
      typeof wave !== "number" || !Number.isInteger(wave) || wave < 1 ||
      !authorityDigest.ok ||
      taskIds === null) {
    return refused("reopening payload has invalid run/wave/authority/task ids");
  }
  return { ok: true, value: Object.freeze({ runId: runId.value, wave, authorityDigest: authorityDigest.value, taskIds }) };
}
