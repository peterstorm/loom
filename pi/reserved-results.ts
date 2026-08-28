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

import { agentsOfKind } from "../engine/src/core/model-profiles";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { type TaskExecutionSpawn } from "../engine/src/core/validate-task-execution";
import type { ImplementationAttemptAuthority } from "../engine/src/core/implementation-completion";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { parsePiSubagentResults, type PiSubagentResultEntry } from "./subagent-result";

const REVIEW_AGENTS: ReadonlySet<string> = new Set(agentsOfKind("reviewer"));
const isReviewAgent = (agentType: string): boolean => REVIEW_AGENTS.has(agentType);

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

export type PiImplementationAuthorityAlignment =
  | Readonly<{ ok: true; authoritiesBySlot: readonly (ImplementationAttemptAuthority | null)[] }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Align the implementation-only ordered registration result back onto the
 * complete Pi spawn roster. Non-implementation slots deliberately carry null;
 * an implementation slot may never fall back to prompt/result inference.
 */
export function alignPiImplementationAuthorities(
  items: readonly Readonly<{ agent: string; task: string }>[],
  spawns: readonly TaskExecutionSpawn[],
  authorities: readonly ImplementationAttemptAuthority[],
): PiImplementationAuthorityAlignment {
  if (items.length !== spawns.length) {
    return { ok: false, error: "Pi spawn roster and execution classification lengths differ" };
  }
  const aligned: (ImplementationAttemptAuthority | null)[] = [];
  let authorityIndex = 0;
  for (const [index, spawn] of spawns.entries()) {
    if (spawn.kind !== "implementation") {
      aligned.push(null);
      continue;
    }
    const authority = authorities[authorityIndex++];
    const promptTaskId = extractTaskId(items[index]?.task ?? "");
    if (authority === undefined) {
      return { ok: false, error: `implementation spawn slot ${index + 1} has no returned attempt authority` };
    }
    if (promptTaskId === null || authority.taskId !== promptTaskId) {
      return {
        ok: false,
        error: `implementation spawn slot ${index + 1} Task binding does not match returned authority ${authority.taskId}`,
      };
    }
    aligned.push(authority);
  }
  if (authorityIndex !== authorities.length) {
    return { ok: false, error: "registration returned surplus implementation attempt authorities" };
  }
  return { ok: true, authoritiesBySlot: Object.freeze(aligned) };
}

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
 * The agent name from a parsed result envelope at this batch position, or
 * `null` when the position is absent or its envelope was rejected. A mismatch
 * is treated exactly like an absence — malformed or wrong-agent evidence does
 * not prove that the expected Agent reported.
 */
function returnedAgentAt(entries: readonly PiSubagentResultEntry[], index: number): string | null {
  const entry = entries[index];
  return entry?.ok === true ? stripNamespace(entry.result.agent) : null;
}

export function classifyMissingReservedResults<T extends ReservedResultItem>(
  items: readonly T[],
  rawResults: readonly unknown[],
  orchestrationRunBound: boolean,
): MissingReservedResults<T> {
  const entries = parsePiSubagentResults(rawResults);
  const missing = (predicate: (item: T) => boolean): readonly MissingReservedResult<T>[] =>
    Object.freeze(items.flatMap((item, index) =>
      predicate(item) && returnedAgentAt(entries, index) !== item.agentType
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
