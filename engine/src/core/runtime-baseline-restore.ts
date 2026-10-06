/**
 * The runtime-baseline restoration rules for implementation settlement, as a
 * pure decision over facts the shell gathers (`utils/runtime-baseline-restore`).
 *
 * Covers the WHOLE runtime revision domain, not only an attempt's declared
 * artifacts. Two campaign-proven reasons:
 *
 * 1. An implementation attempt's necessary writes are not bounded by its
 *    declared artifact list — the render/wording changes ripple into the
 *    dispatch call sites that consume them, and the compiler drives the child
 *    to those files. Scoping the exemption to the declared list made every
 *    such attempt unsettlable: the settlement read the attempt's own
 *    authorized writes as runtime drift.
 * 2. A child's scratch file inside `engine/src`/`pi` (untracked, absent at
 *    HEAD) also moved the revision and broke the handshake mid-attempt. It is
 *    product under this boundary, mapped to `null` (excluded) exactly like an
 *    attempt-created declared artifact.
 *
 * For each domain path that is Git-dirty NOW, the settlement may hash it at
 * its attempt-start bytes instead of its live bytes when:
 *
 * - clean now → unmapped (live bytes ARE the baseline bytes);
 * - provably clean at spawn in EVERY in-flight attempt's repository baseline
 *   → mapped to the CURRENT HEAD: a path clean at spawn carried HEAD's bytes,
 *   and no one commits between spawn and settlement, so HEAD's bytes ARE the
 *   attempt-start bytes. A HEAD that moved can only fail closed — the
 *   restored bytes then mismatch the loaded identity and the write refuses;
 * - created by the attempt (absent at HEAD) → mapped to `null` (excluded from
 *   the revision entirely);
 * - dirty at spawn in ANY in-flight attempt's baseline → unmapped: the write
 *   boundary stays strict for that path. Fail closed — restoration is an
 *   exemption, and an exemption that cannot prove its precondition must not
 *   exist.
 *
 * An unparseable baseline refuses the WHOLE map (strict comparison
 * everywhere), not just its own task, and the refusal names its cause. So does
 * an in-flight attempt with NO recorded baseline: it proves nothing clean at
 * its spawn, so no path can be restored on its behalf.
 */
import { parseArtifactBaseline, type DeclaredArtifactBaseline } from "./artifact-baseline";
import { compareStrings } from "./ordering";
import type { DomainResult } from "./orchestration-contract";

/** The facts the restoration rules read, observed by the shell. */
export type RuntimeBaselineFacts = Readonly<{
  /** Git-visible paths whose worktree/index state differs from HEAD now. */
  dirtyNow: ReadonlySet<string>;
  /** Every path of the runtime revision domain. */
  domainPaths: readonly string[];
  /** Each in-flight attempt's repository baseline fact. */
  attemptRepositoryBaselines: readonly InFlightAttemptBaseline[];
}>;

/** One in-flight attempt's stored repository baseline: recorded (unparsed),
 *  or unrecorded — which proves nothing clean at its spawn. */
export type InFlightAttemptBaseline =
  | Readonly<{ kind: "recorded"; repositoryBaseline: unknown }>
  | Readonly<{ kind: "unrecorded"; taskId: string }>;

/** The task fields the rules read to find its in-flight attempt. */
export type RuntimeBaselineTask = Readonly<{
  id: string;
  active_implementation_attempt?: unknown;
  legacy_execution_reservation?: true;
  attempt_repository_baseline?: readonly DeclaredArtifactBaseline[];
}>;

/**
 * The attempt baseline fact one task contributes, or `null` when it has no
 * in-flight attempt (a task under review, say) and so no spawn to prove clean.
 * A stored baseline is recorded whatever the task's attempt shape; an active
 * or legacy-reserved attempt WITHOUT one is unrecorded.
 */
export function inFlightAttemptBaseline(task: RuntimeBaselineTask): InFlightAttemptBaseline | null {
  if (task.attempt_repository_baseline !== undefined) {
    return Object.freeze({ kind: "recorded", repositoryBaseline: task.attempt_repository_baseline });
  }
  return task.active_implementation_attempt !== undefined || task.legacy_execution_reservation === true
    ? Object.freeze({ kind: "unrecorded", taskId: task.id })
    : null;
}

/** A path restored at HEAD's bytes, or `null` when the attempt created it. */
export type RuntimeBaselineRestore = ReadonlyMap<string, string | null>;

export type RuntimeBaselineRestoreRefusal =
  | Readonly<{ kind: "unparseable-attempt-baseline"; errors: readonly string[] }>
  | Readonly<{ kind: "unrecorded-attempt-baseline"; taskId: string }>;

/** The dirty domain paths the rules let a settlement restore. */
export function runtimeBaselineRestoreCandidates(
  facts: RuntimeBaselineFacts,
): DomainResult<readonly string[], RuntimeBaselineRestoreRefusal> {
  if (facts.dirtyNow.size === 0) return { ok: true, value: Object.freeze([]) };
  // Dirty-at-spawn knowledge is unioned across every in-flight attempt: a path
  // ANY attempt observed dirty at its spawn stays strict for all of them.
  const dirtyAtSpawn = new Set<string>();
  for (const attempt of facts.attemptRepositoryBaselines) {
    // An unrecorded baseline cannot say what was dirty at spawn; skipping it
    // would read every one of its paths as provably clean.
    if (attempt.kind === "unrecorded") {
      return { ok: false, error: Object.freeze({ kind: "unrecorded-attempt-baseline", taskId: attempt.taskId }) };
    }
    const parsed = parseArtifactBaseline<"repository-change">(attempt.repositoryBaseline, "attempt repository baseline");
    if (!parsed.ok) {
      return { ok: false, error: Object.freeze({ kind: "unparseable-attempt-baseline", errors: parsed.errors }) };
    }
    for (const entry of parsed.value) dirtyAtSpawn.add(entry.artifact);
  }
  return {
    ok: true,
    value: Object.freeze(facts.domainPaths.filter((path) =>
      facts.dirtyNow.has(path) && !dirtyAtSpawn.has(path))),
  };
}

/** Map every candidate to `headRevision`, or to `null` when it has no leaf
 *  there (the attempt created it). Ordered by path. */
export function runtimeBaselineRestoreAt(
  candidates: readonly string[],
  headRevision: string,
  presentAtHead: ReadonlySet<string>,
): RuntimeBaselineRestore {
  return Object.freeze(new Map([...candidates]
    .sort(compareStrings)
    .map((path) => [path, presentAtHead.has(path) ? headRevision : null] as const)));
}

/** One diagnosable line for a refused restoration map. */
export function describeRuntimeBaselineRestoreRefusal(refusal: RuntimeBaselineRestoreRefusal): string {
  switch (refusal.kind) {
    case "unparseable-attempt-baseline":
      return `an in-flight attempt repository baseline is unparseable, so no runtime-baseline restore applies: ${refusal.errors.join("; ")}`;
    case "unrecorded-attempt-baseline":
      return `in-flight attempt ${refusal.taskId} has no recorded repository baseline, so no runtime-baseline restore applies`;
  }
}
