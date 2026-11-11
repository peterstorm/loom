/**
 * The Distill Snapshot (ADR-0068 §5): the bytes a Distill Task attempt's scope
 * held at registration, kept in Git's object store as one tree under
 * `distillSnapshotRef(authorityDigest)` so a pass that cannot prove it
 * preserved behaviour is written back.
 *
 * This module owns the pure half: the port the shells capture, restore and
 * discard through, its typed failures, the tree's wire format, which trial
 * settlement restores (`distillRestoreOf`, over `distillRestoreDecision`),
 * and which settlement lets the snapshot go (`distillSnapshotRetention`).
 * `orchestration/distill-snapshot.ts` is the Git adapter. Pure.
 */
import { match } from "ts-pattern";
import { distillRestoreDecision, distillSnapshotRef, isDistillTask, type DistillRestoreDecision } from "./distill-task";
import type { DomainResult } from "./orchestration-contract";

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** Why a snapshot operation did not happen. Expected failures are values. */
export type DistillSnapshotFailure =
  /** No snapshot is stored under the attempt's ref: never captured, or already discarded. */
  | Readonly<{ kind: "no-snapshot"; ref: string }>
  /** A Git command the operation needs did not succeed. */
  | Readonly<{ kind: "git-failed"; command: string; detail: string }>
  /** A scope path could not be read, written or removed (a path outside the
   *  repository boundary, an unsupported node, a filesystem error). */
  | Readonly<{ kind: "scope-path-failed"; path: string; detail: string }>;

/** A stored, restored or discarded snapshot names its ref. */
export type DistillSnapshotResult = DomainResult<Readonly<{ ref: string }>, DistillSnapshotFailure>;

/**
 * Where a Distill Task attempt's scope bytes are kept. `scope` is the
 * attempt's own scope (`distillSnapshotScope`), as repository-relative paths.
 *
 * - `capture` stores each scope path as it is on disk (a missing path is
 *   absent from the snapshot) and replaces any snapshot the ref already holds.
 * - `restore` makes each scope path what the snapshot holds: bytes, the
 *   executable bit and symlinks written back, a path the snapshot lacks
 *   removed. It is idempotent and keeps the snapshot.
 * - `discard` forgets the snapshot; discarding none is not a failure.
 */
export type DistillSnapshotPort = Readonly<{
  capture: (root: string, authorityDigest: string, scope: readonly string[]) => DistillSnapshotResult;
  restore: (root: string, authorityDigest: string, scope: readonly string[]) => DistillSnapshotResult;
  discard: (root: string, authorityDigest: string) => DistillSnapshotResult;
}>;

/** One failure as an operator reads it. */
export const describeDistillSnapshotFailure = (failure: DistillSnapshotFailure): string =>
  match(failure)
    .with({ kind: "no-snapshot" }, ({ ref }) => `no distill snapshot is stored under ${ref}`)
    .with({ kind: "git-failed" }, ({ command, detail }) => `git ${command} ${detail}`)
    .with({ kind: "scope-path-failed" }, ({ path, detail }) => `${path}: ${detail}`)
    .exhaustive();

/**
 * The paths one attempt's snapshot covers: exactly the artifacts of its
 * attempt baseline, which are the paths `behaviour-preserved` judges
 * (`attemptScopeChangedPaths`). Registration captures them and settlement
 * restores them, so the two cannot name different scopes.
 */
export const distillSnapshotScope = (
  attemptBaseline: readonly Readonly<{ artifact: string }>[] | undefined,
): readonly string[] => Object.freeze((attemptBaseline ?? []).map(({ artifact }) => artifact));

// ---------------------------------------------------------------------------
// The snapshot tree
// ---------------------------------------------------------------------------

/** The Git modes a snapshot leaf may carry: a file, an executable file, a symlink. */
export type DistillSnapshotMode = "100644" | "100755" | "120000";

/** One leaf of a snapshot tree: its mode, its blob and its repository-relative path. */
export type DistillSnapshotEntry = Readonly<{ mode: DistillSnapshotMode; sha: string; path: string }>;

const SNAPSHOT_MODES = { "100644": true, "100755": true, "120000": true } as const satisfies Record<DistillSnapshotMode, true>;

const isSnapshotMode = (mode: string): mode is DistillSnapshotMode => Object.hasOwn(SNAPSHOT_MODES, mode);

/** The mode a worktree file's permission bits snapshot as: Git keeps only the owner's executable bit. */
export const snapshotFileMode = (permissions: number): DistillSnapshotMode =>
  (permissions & 0o100) === 0 ? "100644" : "100755";

/** `git update-index -z --index-info` input for `entries`: `<mode> SP <sha> TAB <path> NUL` each. */
export const snapshotIndexInfo = (entries: readonly DistillSnapshotEntry[]): string =>
  entries.map(({ mode, sha, path }) => `${mode} ${sha}\t${path}\0`).join("");

/**
 * The leaves of a snapshot tree from `git ls-tree -r -z` output
 * (`<mode> SP <type> SP <sha> TAB <path> NUL` each). A record that is no
 * file, executable or symlink blob is refused: capture never writes one.
 */
export function parseSnapshotTree(listing: string): DomainResult<readonly DistillSnapshotEntry[], string> {
  const entries: DistillSnapshotEntry[] = [];
  for (const record of listing.split("\0").filter((line) => line !== "")) {
    const parsed = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
    const mode = parsed?.[1];
    if (parsed === null || mode === undefined || !isSnapshotMode(mode)) {
      return { ok: false, error: `unreadable snapshot tree record ${JSON.stringify(record)}` };
    }
    entries.push(Object.freeze({ mode, sha: parsed[2] ?? "", path: parsed[3] ?? "" }));
  }
  return { ok: true, value: Object.freeze(entries) };
}

/** Whether `path` is `scopePath` itself or lies below it. */
export const withinScopePath = (scopePath: string, path: string): boolean =>
  path === scopePath || path.startsWith(`${scopePath}/`);

/** The snapshot's leaves at or below one scope path, in tree order. */
export const snapshotEntriesUnder = (
  entries: readonly DistillSnapshotEntry[],
  scopePath: string,
): readonly DistillSnapshotEntry[] => entries.filter(({ path }) => withinScopePath(scopePath, path));

/**
 * The permission bits a restored file gets: what it has now, with the
 * executable bits set wherever a read bit is (as Git checks a `100755` blob
 * out) or cleared, so a restore changes only what the snapshot records.
 */
export const restoredFilePermissions = (current: number, executable: boolean): number =>
  executable ? current | ((current & 0o444) >> 2) : current & ~0o111;

// ---------------------------------------------------------------------------
// Restore: which trial settlement writes the snapshot back
// ---------------------------------------------------------------------------

/**
 * What the restore decision reads of a trial settlement. It is declared here,
 * not imported: `core/implementation-application` reaches `distill-task`, so
 * importing its result type back would close an import cycle. Every
 * `ImplementationSettlementApplicationResult` has this shape, and a new
 * application or transition kind makes it unassignable here until
 * `distillTrialFailureKinds` says what the kind means.
 */
export type DistillTrialSettlement =
  | Readonly<{
      kind: "applied";
      transition:
        | Readonly<{ kind: "implemented" }>
        | Readonly<{ kind: "retry-required" | "escalation-required"; receipt: Readonly<{ failureKinds: readonly string[] }> }>
        | Readonly<{ kind: "infrastructure-blocked" }>;
    }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "error" }>;

/**
 * The semantic failure kinds a trial settlement would settle with, as its
 * receipt names them. Only a semantic failure (`retry-required`,
 * `escalation-required`) has any: `implemented` proved the bytes, and an
 * `infrastructure-blocked`, `ignored` or `error` application judged nothing,
 * so none of them is a reason to restore.
 */
export const distillTrialFailureKinds = (trial: DistillTrialSettlement): readonly string[] =>
  match(trial)
    .with({ kind: "applied" }, ({ transition }) =>
      match(transition)
        .with({ kind: "implemented" }, (): readonly string[] => [])
        .with({ kind: "retry-required" }, { kind: "escalation-required" }, ({ receipt }) => receipt.failureKinds)
        .with({ kind: "infrastructure-blocked" }, (): readonly string[] => [])
        .exhaustive())
    .with({ kind: "ignored" }, (): readonly string[] => [])
    .with({ kind: "error" }, (): readonly string[] => [])
    .exhaustive();

/**
 * What settlement does with a Distill Task attempt's bytes after its trial:
 * `distillRestoreDecision` over the attempt's raw scope delta and the trial's
 * semantic failure kinds.
 */
export const distillRestoreOf = (
  changedScopePaths: readonly string[],
  trial: DistillTrialSettlement,
): DistillRestoreDecision => distillRestoreDecision(changedScopePaths, distillTrialFailureKinds(trial));

// ---------------------------------------------------------------------------
// Release: which settlement lets the snapshot go
// ---------------------------------------------------------------------------

/** Whether a settled attempt's snapshot is still needed. */
export type DistillSnapshotRetention = "discard" | "keep";

/**
 * What a persisted settlement means for its attempt's snapshot. A semantic
 * settlement (`implemented`, `retry-required`, `escalation-required`) judged
 * the scope bytes and restored them where they were unproven, so the snapshot
 * has no reader left. An `infrastructure-blocked` settlement judged nothing:
 * its snapshot is the only copy of the bytes the attempt started from, and it
 * is kept for the operator. An `ignored` or `error` application settled
 * nothing.
 */
export const distillSnapshotRetention = (settlement: DistillTrialSettlement): DistillSnapshotRetention =>
  match(settlement)
    .with({ kind: "applied" }, ({ transition }) =>
      match(transition)
        .with({ kind: "implemented" }, { kind: "retry-required" }, { kind: "escalation-required" }, (): DistillSnapshotRetention => "discard")
        .with({ kind: "infrastructure-blocked" }, (): DistillSnapshotRetention => "keep")
        .exhaustive())
    .with({ kind: "ignored" }, { kind: "error" }, (): DistillSnapshotRetention => "keep")
    .exhaustive();

/** What `settledDistillSnapshotDigests` reads of a Task: its agent and its settlement receipts. */
export type DistillSnapshotHistory = Readonly<{
  agent?: unknown;
  implementation_attempt_history?: readonly Readonly<{
    authorityDigest: string;
    transition: "implemented" | "retry-required" | "escalation-required" | "infrastructure-blocked" | "escalation-remediated";
  }>[];
}>;

/**
 * The attempts of a Distill Task whose snapshot nothing needs any more: every
 * attempt its history records a semantic settlement for (an
 * `escalation-remediated` receipt restates its escalated attempt's digest).
 * Registration discards these, so a snapshot whose discard was lost after its
 * settlement persisted does not outlive the Task's next attempt. An
 * `infrastructure-blocked` attempt is never listed: see
 * `distillSnapshotRetention`. Empty for any other Task.
 */
export function settledDistillSnapshotDigests(task: DistillSnapshotHistory): readonly string[] {
  if (!isDistillTask(task)) return Object.freeze([]);
  const settled = (task.implementation_attempt_history ?? []).flatMap(({ authorityDigest, transition }) =>
    match(transition)
      .with("implemented", "retry-required", "escalation-required", "escalation-remediated", () => [authorityDigest])
      .with("infrastructure-blocked", (): string[] => [])
      .exhaustive());
  return Object.freeze([...new Set(settled)]);
}

/** How a kept snapshot is named to the operator who may need its bytes. */
export const keptDistillSnapshotNote = (authorityDigest: string): string =>
  `the attempt's starting bytes are kept as the Git tree ${distillSnapshotRef(authorityDigest)}`;
