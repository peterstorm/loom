/**
 * Which reserved spawn slots came back without their result.
 *
 * A reservation is the authoritative expected batch. Pi may return a shorter or
 * reordered results array after a child disappears, so every gate-owned slot
 * has to be reconciled against what actually arrived — otherwise stale review
 * or spec-check evidence stays authoritative and the wave gate reads it as
 * green.
 *
 * Pure by construction: no state manager, no filesystem, no stderr. It grew
 * inline in `extension.ts`'s `tool_result` handler, where the only way to reach
 * these rules was through a full fake-harness integration fixture; the shell
 * now keeps the I/O and calls this for the decision.
 */

import { isReviewAgent } from "../engine/src/config";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { type TaskExecutionSpawn } from "../engine/src/core/validate-task-execution";

/**
 * The reservation fields the classification actually reads.
 *
 * `kind` is the closed lifecycle union, not a bare `string`: every construction
 * site already supplies a `TaskExecutionSpawn["kind"]`, and the predicates below
 * test it against the `"standalone"` member. Typed as `string`, a typo in that
 * comparison — or a new lifecycle arm — would silently reclassify every
 * reservation with no compile error at the site that did it.
 */
export type ReservedResultItem = Readonly<{
  agentType: string;
  taskId: string | null;
  kind: TaskExecutionSpawn["kind"];
}>;

/** One expected slot and the batch position its result should have occupied. */
export type MissingReservedResult<T extends ReservedResultItem> = Readonly<{
  item: T;
  index: number;
}>;

/**
 * The three categories are disjoint by construction, because
 * `orchestrationRunBound` selects between them: a run-bound batch reconciles
 * every slot as a run result, and only a NON-run-bound batch has gate-owned
 * review/spec-check evidence to invalidate.
 */
export type MissingReservedResults<T extends ReservedResultItem> = Readonly<{
  reviews: readonly MissingReservedResult<T>[];
  specChecks: readonly MissingReservedResult<T>[];
  runResults: readonly MissingReservedResult<T>[];
}>;

/**
 * The agent name the harness reported at this batch position, or `null` when
 * the position is absent or is not a result envelope at all. A mismatch is
 * treated exactly like an absence — a result from the wrong agent proves the
 * expected one did not report.
 */
function returnedAgentAt(rawResults: readonly unknown[], index: number): string | null {
  const raw = rawResults[index];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("agent" in raw)) return null;
  return typeof raw.agent === "string" ? stripNamespace(raw.agent) : null;
}

export function classifyMissingReservedResults<T extends ReservedResultItem>(
  items: readonly T[],
  rawResults: readonly unknown[],
  orchestrationRunBound: boolean,
): MissingReservedResults<T> {
  const missing = (predicate: (item: T) => boolean): readonly MissingReservedResult<T>[] =>
    Object.freeze(items.flatMap((item, index) =>
      predicate(item) && returnedAgentAt(rawResults, index) !== item.agentType
        ? [Object.freeze({ item, index })]
        : []));

  if (orchestrationRunBound) {
    // A run-bound batch owns its evidence through the Run Directory, so no
    // task-graph review or spec-check record is attributed here.
    return Object.freeze({
      reviews: Object.freeze([]),
      specChecks: Object.freeze([]),
      runResults: missing(() => true),
    });
  }
  return Object.freeze({
    reviews: missing((item) =>
      item.kind !== "standalone" && item.taskId !== null && isReviewAgent(item.agentType)),
    specChecks: missing((item) =>
      item.kind !== "standalone" && item.agentType === "spec-check-invoker"),
    runResults: Object.freeze([]),
  });
}
