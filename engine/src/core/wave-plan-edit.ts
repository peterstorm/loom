/**
 * The audited plan edits a TaskGraph carries in `wave_plan_edits` (loom#198
 * Cause 3; ADR-0081, ADR-0086, ADR-0105). This leaf module is the one home of an edit's
 * invariants: the commands that write one (`core/task-rescope.ts`,
 * `core/task-dependency-edit.ts`, `core/task-addition.ts`,
 * `core/export-binding-amendment.ts`) and the State File
 * parser that reads one back both build it through the constructor of its
 * kind, so neither can hold a value the other would refuse.
 *
 * Pure.
 */

import { isExactGitSha } from "./git-sha";
import { nonEmpty, type DomainResult, type OrchestrationRunId } from "./orchestration-contract";
import { parseReviewPath } from "./review-packet";
import { applyExportChange, parseContractId, parseIdentifier } from "./skeleton/bindings";
import type { BoundExport, ExportBindingChange, Identifier } from "./skeleton/types";
import { parseTaskId } from "./task-id";
import type { DependencyAddedEdit, ExportBindingAmendedEdit, TaskAddedEdit, TaskRescopedEdit, TaskWithdrawnEdit } from "../types";

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

/** `raw` as distinct Task ids none of which is `self`, or why not. */
function otherTaskIds(raw: readonly string[], label: string, self: string): DomainResult<readonly string[], string> {
  const ids: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const id = parseTaskId(entry, `${label}[${index}]`);
    if (!id.ok) return fail(id.error.errors.join("; "));
    if (id.value === self) return fail(`${label} names ${self} itself`);
    if (ids.includes(id.value)) return fail(`${label} names ${id.value} twice`);
    ids.push(id.value);
  }
  return freeze({ ok: true as const, value: freeze(ids) });
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
  const sealedPaths = nonEmpty(sealed.value);
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
      ...(sealedPaths === null ? {} : { sealed: sealedPaths }),
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
  const ids = otherTaskIds(input.dependsOn, "dependsOn", taskId.value);
  if (!ids.ok) return ids;
  const dependsOn = nonEmpty(ids.value);
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

export type TaskAddedEditInput = Readonly<{
  wave: number;
  taskId: string;
  files: readonly string[];
  /** The files a completed Wave sealed, named explicitly; a subset of `files`. */
  sealed: readonly string[];
  dependsOn: readonly string[];
  dependents: readonly string[];
  reason: string;
  abandonedRunId: OrchestrationRunId | null;
}>;

/**
 * A `task-added` edit, or why it is not one: a Wave of at least 1, a Task id,
 * at least one distinct review path, sealed paths that are distinct listed
 * files, distinct dependency and dependent ids that name neither the Task nor
 * each other, and a reason `parsePlanEditReason` admits. Whether those Tasks
 * exist, where they sit and whether a sealed path is sealed are the caller's
 * to check.
 */
export function taskAddedEdit(input: TaskAddedEditInput): DomainResult<TaskAddedEdit, string> {
  if (!Number.isSafeInteger(input.wave) || input.wave < 1) return fail("wave must be an integer >= 1");
  const taskId = parseTaskId(input.taskId, "taskId");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const files = distinctPaths(input.files, "files");
  if (!files.ok) return files;
  const fileList = nonEmpty(files.value);
  if (fileList === null) return fail("files names no path");
  const sealed = distinctPaths(input.sealed, "sealed");
  if (!sealed.ok) return sealed;
  const unlisted = sealed.value.find((path) => !files.value.includes(path));
  if (unlisted !== undefined) return fail(`sealed names ${unlisted}, which is not in files`);
  const sealedPaths = nonEmpty(sealed.value);
  const dependsOn = otherTaskIds(input.dependsOn, "dependsOn", taskId.value);
  if (!dependsOn.ok) return dependsOn;
  const dependents = otherTaskIds(input.dependents, "dependents", taskId.value);
  if (!dependents.ok) return dependents;
  const both = dependsOn.value.find((id) => dependents.value.includes(id));
  if (both !== undefined) return fail(`${both} is both a dependency and a dependent, a cycle`);
  const reason = parsePlanEditReason(input.reason);
  if (!reason.ok) return fail(`reason ${reason.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      schemaVersion: 1 as const,
      kind: "task-added" as const,
      wave: input.wave,
      taskId: taskId.value,
      files: fileList,
      ...(sealedPaths === null ? {} : { sealed: sealedPaths }),
      dependsOn: dependsOn.value,
      dependents: dependents.value,
      reason: reason.value,
      abandonedRunId: input.abandonedRunId,
    }),
  });
}

export type TaskWithdrawnEditInput = Readonly<{
  wave: number;
  taskId: string;
  reason: string;
  abandonedRunId: OrchestrationRunId | null;
}>;

/** A `task-withdrawn` edit, or why it is not one: a Wave of at least 1, a Task id and an admitted reason. */
export function taskWithdrawnEdit(input: TaskWithdrawnEditInput): DomainResult<TaskWithdrawnEdit, string> {
  if (!Number.isSafeInteger(input.wave) || input.wave < 1) return fail("wave must be an integer >= 1");
  const taskId = parseTaskId(input.taskId, "taskId");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const reason = parsePlanEditReason(input.reason);
  if (!reason.ok) return fail(`reason ${reason.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      schemaVersion: 1 as const,
      kind: "task-withdrawn" as const,
      wave: input.wave,
      taskId: taskId.value,
      reason: reason.value,
      abandonedRunId: input.abandonedRunId,
    }),
  });
}

/** A bound export as a plan edit's input carries it: two strings, not yet proven identifiers. */
export type RawBoundExport = Readonly<{ name: string; alias: string }>;

/** A change as a plan edit's input carries it: its kind and names, not yet proven identifiers. */
export type RawExportBindingChange =
  | Readonly<{ kind: "dropped"; name: string }>
  | Readonly<{ kind: "rebound"; name: string; to: string }>;

export type ExportBindingAmendedEditInput = Readonly<{
  wave: number;
  taskId: string;
  path: string;
  contract: string;
  change: RawExportBindingChange;
  /** The binding's exports before the change, in binding order. */
  before: readonly RawBoundExport[];
  reason: string;
}>;

function identifierOf(raw: string, label: string): DomainResult<Identifier, string> {
  const parsed = parseIdentifier(raw);
  return parsed.ok ? parsed : fail(`${label} '${raw}' is no identifier (${parsed.error})`);
}

/** `raw` as distinct bound exports with identifier names and aliases, at least one, or why not. */
function boundExports(raw: readonly RawBoundExport[]): DomainResult<readonly [BoundExport, ...BoundExport[]], string> {
  const exports: BoundExport[] = [];
  for (const [index, entry] of raw.entries()) {
    const name = identifierOf(entry.name, `before[${index}].name`);
    if (!name.ok) return name;
    const alias = identifierOf(entry.alias, `before[${index}].alias`);
    if (!alias.ok) return alias;
    if (exports.some((bound) => bound.name === name.value)) return fail(`before binds '${name.value}' twice`);
    exports.push(freeze({ name: name.value, alias: alias.value }));
  }
  const listed = nonEmpty(exports);
  return listed === null ? fail("before binds no export") : freeze({ ok: true as const, value: listed });
}

function exportChange(raw: RawExportBindingChange): DomainResult<ExportBindingChange, string> {
  const name = identifierOf(raw.name, "change.name");
  if (!name.ok) return name;
  if (raw.kind === "dropped") return freeze({ ok: true as const, value: freeze({ kind: "dropped" as const, name: name.value }) });
  const to = identifierOf(raw.to, "change.to");
  if (!to.ok) return to;
  if (to.value === name.value) return fail(`change rebinds '${name.value}' to itself`);
  return freeze({ ok: true as const, value: freeze({ kind: "rebound" as const, name: name.value, to: to.value }) });
}

/**
 * An `export-binding-amended` edit (ADR-0105), or why it is not one: a Wave
 * of at least 1, a Task id, a review path, a contract id, distinct
 * identifier exports before the change, a change of a name `before` binds
 * (a rebind to a new, distinct identifier that the binding grammar admits),
 * and an admitted reason. `after` is derived here (`applyExportChange`), never
 * taken as input, so the stored after can only be what the change leaves.
 * Whether the Task holds the path and the stamp held `before` are the
 * caller's to check.
 */
export function exportBindingAmendedEdit(input: ExportBindingAmendedEditInput): DomainResult<ExportBindingAmendedEdit, string> {
  if (!Number.isSafeInteger(input.wave) || input.wave < 1) return fail("wave must be an integer >= 1");
  const taskId = parseTaskId(input.taskId, "taskId");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const path = parseReviewPath(input.path, "path");
  if (!path.ok) return fail(path.errors.join("; "));
  const contract = parseContractId(input.contract);
  if (!contract.ok) return fail(`contract '${input.contract}' is no contract id CT-<n>`);
  const before = boundExports(input.before);
  if (!before.ok) return before;
  const change = exportChange(input.change);
  if (!change.ok) return change;
  const after = applyExportChange(path.value, before.value, change.value);
  if (!after.ok) return fail(`change cannot apply to before: ${after.error.kind} '${after.error.name}'`);
  const reason = parsePlanEditReason(input.reason);
  if (!reason.ok) return fail(`reason ${reason.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      schemaVersion: 1 as const,
      kind: "export-binding-amended" as const,
      wave: input.wave,
      taskId: taskId.value,
      path: path.value,
      contract: contract.value,
      change: change.value,
      before: before.value,
      after: after.value,
      reason: reason.value,
    }),
  });
}
