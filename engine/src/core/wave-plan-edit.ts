/**
 * The audited plan edits a TaskGraph carries in `wave_plan_edits` (loom#198
 * Cause 3; ADR-0081). This leaf module is the one home of an edit's
 * invariants: the commands that write one (`core/task-rescope.ts`,
 * `core/task-dependency-edit.ts`) and the State File parser that reads one
 * back both build it through `taskRescopedEdit` or `dependencyAddedEdit`, so
 * neither can hold a value the other would refuse.
 *
 * Pure.
 */

import { isExactGitSha } from "./git-sha";
import { nonEmpty, type DomainResult } from "./orchestration-contract";
import { parseReviewPath } from "./review-packet";
import { parseTaskId } from "./task-id";
import type { DependencyAddedEdit, TaskRescopedEdit } from "../types";

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
  /** The added paths that a completed Wave sealed, named explicitly; a subset of `added`. */
  sealed: readonly string[];
  reason: string;
}>;

/**
 * A `task-rescoped` edit, or why it is not one: a Wave of at least 1,
 * distinct and disjoint review paths with at least one change, a baseline
 * revision that is an exact Git commit id when something was added to a
 * baselined Task and null otherwise, sealed paths that are distinct added
 * paths, and a reason `parsePlanEditReason` admits. Whether the Task exists in
 * that Wave, and whether a sealed path is sealed, are the caller's to check.
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
  const sealed = distinctPaths(input.sealed, "sealed");
  if (!sealed.ok) return sealed;
  const unadded = sealed.value.find((path) => !added.value.includes(path));
  if (unadded !== undefined) return fail(`sealed names ${unadded}, which is not added`);
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
      ...(sealed.value.length === 0 ? {} : { sealed: sealed.value }),
      reason: reason.value,
    }),
  });
}

export type DependencyAddedEditInput = Readonly<{
  wave: number;
  taskId: string;
  dependsOn: readonly string[];
  reason: string;
}>;

/**
 * A `dependency-added` edit, or why it is not one: a Wave of at least 1, a
 * Task id, at least one distinct dependency id that is not the Task itself,
 * and a reason `parsePlanEditReason` admits. Whether the edges point at the
 * active Wave or an earlier one, and close no cycle, is the caller's to check.
 */
export function dependencyAddedEdit(input: DependencyAddedEditInput): DomainResult<DependencyAddedEdit, string> {
  if (!Number.isSafeInteger(input.wave) || input.wave < 1) return fail("wave must be an integer >= 1");
  const taskId = parseTaskId(input.taskId, "taskId");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const ids: string[] = [];
  for (const [index, raw] of input.dependsOn.entries()) {
    const id = parseTaskId(raw, `dependsOn[${index}]`);
    if (!id.ok) return fail(id.error.errors.join("; "));
    if (id.value === taskId.value) return fail(`${taskId.value} cannot depend on itself`);
    if (ids.includes(id.value)) return fail(`dependsOn names ${id.value} twice`);
    ids.push(id.value);
  }
  const dependsOn = nonEmpty(ids);
  if (dependsOn === null) return fail("dependsOn names no Task");
  const reason = parsePlanEditReason(input.reason);
  if (!reason.ok) return fail(`reason ${reason.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      schemaVersion: 1 as const,
      kind: "dependency-added" as const,
      wave: input.wave,
      taskId: taskId.value,
      dependsOn: freeze(dependsOn),
      reason: reason.value,
    }),
  });
}
