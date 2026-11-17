/**
 * The audited plan edits a TaskGraph carries in `wave_plan_edits` (loom#198
 * Cause 3; the union loom#199's further edit kinds extend). This leaf module
 * is the one home of an edit's invariants: the command that writes one
 * (`core/task-rescope.ts`) and the State File parser that reads one back both
 * build it through `taskRescopedEdit`, so neither can hold a value the other
 * would refuse.
 *
 * Pure.
 */

import { isExactGitSha } from "./git-sha";
import type { DomainResult } from "./orchestration-contract";
import { parseReviewPath } from "./review-packet";
import type { TaskRescopedEdit } from "../types";

/** The longest reason an operator may give for a plan edit. */
export const MAX_PLAN_EDIT_REASON_LENGTH = 500;

const freeze = Object.freeze;
const fail = (error: string) => freeze({ ok: false as const, error });

/** A plan edit's reason: a trimmed, non-blank string of at most `MAX_PLAN_EDIT_REASON_LENGTH` characters. */
export function parsePlanEditReason(raw: unknown): DomainResult<string, string> {
  if (typeof raw !== "string") return fail("must be a string");
  if (raw.trim().length === 0) return fail("must say why the plan changes");
  if (raw.trim() !== raw) return fail("must not start or end with whitespace");
  if (raw.length > MAX_PLAN_EDIT_REASON_LENGTH) return fail(`is at most ${MAX_PLAN_EDIT_REASON_LENGTH} characters`);
  return freeze({ ok: true as const, value: raw });
}

/** `paths` as distinct review paths, or why they are not. */
function distinctPaths(paths: readonly string[], label: string): DomainResult<readonly string[], string> {
  const parsed: string[] = [];
  for (const [index, raw] of paths.entries()) {
    const path = parseReviewPath(raw, `${label}[${index}]`);
    if (!path.ok) return fail(path.errors.join("; "));
    if (parsed.includes(path.value)) return fail(`${label} names ${path.value} twice`);
    parsed.push(path.value);
  }
  return freeze({ ok: true as const, value: freeze(parsed) });
}

export type TaskRescopedEditInput = Readonly<{
  wave: number;
  taskId: string;
  added: readonly string[];
  removed: readonly string[];
  baselineRevision: string | null;
  reason: string;
}>;

/**
 * A `task-rescoped` edit, or why it is not one: a Wave of at least 1,
 * distinct and disjoint review paths with at least one change, a baseline
 * revision that is an exact Git commit id when something was added to a
 * baselined Task and null otherwise, and a reason `parsePlanEditReason`
 * admits. Whether the Task exists in that Wave is the caller's to check.
 */
export function taskRescopedEdit(input: TaskRescopedEditInput): DomainResult<TaskRescopedEdit, string> {
  if (!Number.isSafeInteger(input.wave) || input.wave < 1) return fail("wave must be an integer >= 1");
  const added = distinctPaths(input.added, "added");
  if (!added.ok) return added;
  const removed = distinctPaths(input.removed, "removed");
  if (!removed.ok) return removed;
  if (added.value.length + removed.value.length === 0) return fail("adds and removes nothing");
  const both = added.value.find((path) => removed.value.includes(path));
  if (both !== undefined) return fail(`both adds and removes ${both}`);
  const revision = input.baselineRevision;
  if (revision !== null && !isExactGitSha(revision)) return fail("baselineRevision must be an exact Git commit id or null");
  if (revision !== null && added.value.length === 0) return fail("baselineRevision must be null when nothing was added");
  const reason = parsePlanEditReason(input.reason);
  if (!reason.ok) return fail(`reason ${reason.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      schemaVersion: 1 as const,
      kind: "task-rescoped" as const,
      wave: input.wave,
      taskId: input.taskId,
      added: added.value,
      removed: removed.value,
      baselineRevision: revision,
      reason: reason.value,
    }),
  });
}
