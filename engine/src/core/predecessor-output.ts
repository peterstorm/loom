/**
 * Predecessor Output — what each direct dependency of a Task produced, as the
 * dependent's implementation brief shows it.
 *
 * Derived only from protected Task state, never from model-authored output: a
 * dependency's description and Completion Claims as decompose froze them, and
 * the files its settled implementation changed. A dependent is dispatched only
 * after every dependency is `completed` (a passing Wave Gate), so these facts
 * are final and reviewed by the time the brief renders.
 *
 * Pure: the shell passes the roster it already loaded.
 */

import { match } from "ts-pattern";
import type { DomainResult } from "./orchestration-contract";
import { parseReviewPath, type ReviewPath } from "./review-packet";
import type { Task } from "../types";

/** Literal substituted for `{predecessor_outputs}` when the Task has no dependencies. */
export const NO_PREDECESSORS = "None — this Task has no dependencies.";

/**
 * What a dependency's settled implementation changed. Three different facts:
 * a canonical record, no record at all (a legacy completed Task), and a legacy
 * record holding paths no current settlement could have written. The last two
 * are stated, never rendered as "nothing changed", and both fall back to the
 * declared files, which the State File boundary already proves canonical.
 */
export type PredecessorProduced =
  | Readonly<{ kind: "recorded"; changed: readonly ReviewPath[]; declaredUnchanged: readonly ReviewPath[] }>
  | Readonly<{ kind: "unrecorded"; declared: readonly ReviewPath[] }>
  | Readonly<{ kind: "non-canonical"; rejected: number; declared: readonly ReviewPath[] }>;

export type PredecessorOutput = Readonly<{
  taskId: string;
  description: string;
  completionClaims: readonly string[];
  produced: PredecessorProduced;
}>;

export type PredecessorOutputError =
  | Readonly<{ kind: "dependency-missing"; taskId: string }>
  | Readonly<{ kind: "dependency-not-completed"; taskId: string; status: Task["status"] }>
  | Readonly<{ kind: "declared-path-not-canonical"; taskId: string; path: string }>;

function declaredPaths(dependency: Task): DomainResult<readonly ReviewPath[], PredecessorOutputError> {
  const declared: ReviewPath[] = [];
  for (const raw of dependency.file_list ?? []) {
    const parsed = parseReviewPath(raw);
    if (!parsed.ok) return { ok: false, error: { kind: "declared-path-not-canonical", taskId: dependency.id, path: raw } };
    declared.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(declared) };
}

function producedBy(dependency: Task, declared: readonly ReviewPath[]): PredecessorProduced {
  if (dependency.files_modified === undefined) return Object.freeze({ kind: "unrecorded", declared });
  const parsed = dependency.files_modified.map((raw) => parseReviewPath(raw));
  const changed = parsed.flatMap((path) => (path.ok ? [path.value] : []));
  const rejected = parsed.length - changed.length;
  if (rejected > 0) return Object.freeze({ kind: "non-canonical", rejected, declared });
  const changedSet = new Set<string>(changed);
  return Object.freeze({
    kind: "recorded",
    changed: Object.freeze(changed),
    declaredUnchanged: Object.freeze(declared.filter((path) => !changedSet.has(path))),
  });
}

/**
 * One Predecessor Output per direct dependency, in `depends_on` order. A
 * dependency that is missing or not `completed` is refused rather than
 * rendered: dispatch already guarantees completion, and a brief that implied a
 * finished predecessor which is not finished would mislead the implementer.
 */
export function predecessorOutputs(
  task: Task,
  roster: readonly Task[],
): DomainResult<readonly PredecessorOutput[], PredecessorOutputError> {
  const byId = new Map(roster.map((candidate) => [candidate.id, candidate] as const));
  const outputs: PredecessorOutput[] = [];
  for (const id of task.depends_on) {
    const dependency = byId.get(id);
    if (dependency === undefined) return { ok: false, error: { kind: "dependency-missing", taskId: id } };
    if (dependency.status !== "completed") {
      return { ok: false, error: { kind: "dependency-not-completed", taskId: id, status: dependency.status } };
    }
    const declared = declaredPaths(dependency);
    if (!declared.ok) return declared;
    outputs.push(Object.freeze({
      taskId: dependency.id,
      description: dependency.description,
      completionClaims: Object.freeze([...(dependency.spec_anchors ?? [])]),
      produced: producedBy(dependency, declared.value),
    }));
  }
  return { ok: true, value: Object.freeze(outputs) };
}

/** One line of untrusted text, so it cannot open a heading or a list item of its own. */
const oneLine = (text: string): string => text.trim().replace(/\s*[\r\n]+\s*/gu, " ");

const pathList = (paths: readonly ReviewPath[]): string =>
  paths.length === 0 ? "\n    - none" : paths.map((path) => `\n    - ${path}`).join("");

function renderProduced(produced: PredecessorProduced): readonly string[] {
  return match<PredecessorProduced, readonly string[]>(produced)
    .with({ kind: "recorded" }, ({ changed, declaredUnchanged }) => [
      `  - Changed:${pathList(changed)}`,
      ...(declaredUnchanged.length === 0 ? [] : [`  - Declared but unchanged:${pathList(declaredUnchanged)}`]),
    ])
    .with({ kind: "unrecorded" }, ({ declared }) =>
      [`  - Changed: not recorded; read its declared files:${pathList(declared)}`])
    .with({ kind: "non-canonical" }, ({ rejected, declared }) =>
      [`  - Changed: ${rejected} recorded ${rejected === 1 ? "path is" : "paths are"} not a canonical repository path; ` +
        `read its declared files:${pathList(declared)}`])
    .exhaustive();
}

/** The brief's "What your dependencies produced" section body. */
export function renderPredecessorOutputs(outputs: readonly PredecessorOutput[]): string {
  if (outputs.length === 0) return NO_PREDECESSORS;
  return outputs.flatMap(({ taskId, description, completionClaims, produced }) => [
    `- **${taskId}** — ${oneLine(description)}`,
    `  - Completed: ${completionClaims.length === 0 ? "no Requirement Completion Claims" : completionClaims.map(oneLine).join(", ")}`,
    ...renderProduced(produced),
  ]).join("\n");
}

/** Operator-facing text for a refusal, owned by the type. */
export function predecessorOutputErrorMessage(error: PredecessorOutputError): string {
  return match<PredecessorOutputError, string>(error)
    .with({ kind: "dependency-missing" }, ({ taskId }) => `dependency ${taskId} is not in the TaskGraph`)
    .with({ kind: "dependency-not-completed" }, ({ taskId, status }) =>
      `dependency ${taskId} is ${status}, not completed; a dependent is dispatched only after its dependencies pass their Wave Gate`)
    .with({ kind: "declared-path-not-canonical" }, ({ taskId, path }) =>
      `dependency ${taskId} declares '${path}', which is not a canonical repository path`)
    .exhaustive();
}
