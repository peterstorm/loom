/**
 * The Distill Snapshot (ADR-0068 §5): the bytes a Distill Task attempt's scope
 * held at registration, kept in Git's object store as one tree under
 * `distillSnapshotRef(authorityDigest)` so a pass that cannot prove it
 * preserved behaviour is written back.
 *
 * This module owns the pure half: the port the shells capture, restore and
 * discard through, its typed failures, the tree's wire format, and what a
 * settlement means for the attempt's bytes and for its snapshot
 * (`distillSettlementOutcome`). `orchestration/distill-snapshot.ts` is the
 * Git adapter. Pure.
 */
import { match } from "ts-pattern";
import { distillSnapshotRef, isDistillTask } from "./distill-task";
import { nonEmpty, type DomainResult, type NonEmpty } from "./orchestration-contract";

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
// Settlement: what a settlement does with the attempt's bytes and its snapshot
// ---------------------------------------------------------------------------

/** What settlement does with a Distill Task attempt's bytes. */
export type DistillRestoreDecision =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "restore"; after: NonEmpty<string> }>;

/** Whether a settled attempt's snapshot is still needed. */
export type DistillSnapshotRetention = "discard" | "keep";

/** Every transition a settlement receipt records. */
type SettlementTransition =
  | "implemented"
  | "retry-required"
  | "escalation-required"
  | "infrastructure-blocked"
  | "escalation-remediated";

/**
 * What this module reads of a settlement. It is declared here, not imported:
 * `core/implementation-application` reaches `distill-task`, so importing its
 * result type back would close an import cycle. Every
 * `ImplementationSettlementApplicationResult` has this shape, and a new
 * application or transition kind makes it unassignable here until
 * `distillSettlementOutcome` says what the kind means.
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

/** What one settlement means for a Distill Task attempt: its bytes, and its snapshot. */
export type DistillSettlementOutcome = Readonly<{
  /** Whether the shell writes the snapshot back before the settlement stands. */
  restore: DistillRestoreDecision;
  /** Whether the snapshot is still needed once the settlement is persisted. */
  retention: DistillSnapshotRetention;
}>;

const KEEP: DistillRestoreDecision = Object.freeze({ kind: "keep" });

/** An application that settled nothing changes nothing: bytes and snapshot both stay. */
const NOTHING_SETTLED: DistillSettlementOutcome = Object.freeze({ restore: KEEP, retention: "keep" });

/**
 * The one rule for which transition settles a snapshot. A semantic transition
 * (`implemented`, `retry-required`, `escalation-required`, and the
 * `escalation-remediated` receipt that restates an escalated attempt) judged
 * the scope bytes and restored them where they were unproven, so the snapshot
 * has no reader left. `infrastructure-blocked` judged nothing: its snapshot is
 * the only copy of the bytes the attempt started from, and it is kept for the
 * operator.
 */
const snapshotRetentionAfter = (transition: SettlementTransition): DistillSnapshotRetention =>
  match(transition)
    .with("implemented", "retry-required", "escalation-required", "escalation-remediated", (): DistillSnapshotRetention => "discard")
    .with("infrastructure-blocked", (): DistillSnapshotRetention => "keep")
    .exhaustive();

/**
 * What a settlement means for a Distill Task attempt, decided in one place.
 *
 * `restore`: the snapshot is written back exactly when the attempt changed
 * scope paths and the settlement is a semantic failure. The pass could not
 * prove it preserved behaviour, so its edits must not reach review; the
 * receipt's failure kinds become the evidence's `after`. `implemented` proved
 * the bytes, and an `infrastructure-blocked`, `ignored` or `error` application
 * judged nothing, so none of them restores.
 *
 * `retention`: `snapshotRetentionAfter` for an applied transition; an
 * `ignored` or `error` application settled nothing and keeps the snapshot.
 *
 * The shell reads `restore` of the trial settlement, with the attempt's raw
 * scope delta, and `retention` of the settlement it persisted.
 */
export const distillSettlementOutcome = (
  changedScopePaths: readonly string[],
  settlement: DistillTrialSettlement,
): DistillSettlementOutcome =>
  match(settlement)
    .with({ kind: "applied" }, ({ transition }) => Object.freeze({
      restore: match(transition)
        .with({ kind: "retry-required" }, { kind: "escalation-required" }, ({ receipt }): DistillRestoreDecision => {
          const after = nonEmpty(receipt.failureKinds);
          return changedScopePaths.length === 0 || after === null ? KEEP : Object.freeze({ kind: "restore", after });
        })
        .with({ kind: "implemented" }, { kind: "infrastructure-blocked" }, () => KEEP)
        .exhaustive(),
      retention: snapshotRetentionAfter(transition.kind),
    }))
    .with({ kind: "ignored" }, { kind: "error" }, () => NOTHING_SETTLED)
    .exhaustive();

/** What `settledDistillSnapshotDigests` reads of a Task: its agent and its settlement receipts. */
export type DistillSnapshotHistory = Readonly<{
  agent?: unknown;
  implementation_attempt_history?: readonly Readonly<{ authorityDigest: string; transition: SettlementTransition }>[];
}>;

/**
 * The attempts of a Distill Task whose snapshot nothing needs any more: every
 * attempt whose receipt `snapshotRetentionAfter` discards. Registration
 * discards these, so a snapshot whose discard was lost after its settlement
 * persisted does not outlive the Task's next attempt. Empty for any other
 * Task.
 */
export function settledDistillSnapshotDigests(task: DistillSnapshotHistory): readonly string[] {
  if (!isDistillTask(task)) return Object.freeze([]);
  const settled = (task.implementation_attempt_history ?? [])
    .filter(({ transition }) => snapshotRetentionAfter(transition) === "discard")
    .map(({ authorityDigest }) => authorityDigest);
  return Object.freeze([...new Set(settled)]);
}

/** How a kept snapshot is named to the operator who may need its bytes. */
export const keptDistillSnapshotNote = (authorityDigest: string): string =>
  `the attempt's starting bytes are kept as the Git tree ${distillSnapshotRef(authorityDigest)}`;
