/**
 * Which task graph governs one spawn batch.
 *
 * The sanctioned implementation chain (admission → registration → write
 * grants → settlement) arms on `graphIsActive`, and that fact used to be
 * computed solely from the orchestrator runtime's cwd. When the orchestrator
 * session is rooted in the main checkout but a spawn targets a linked
 * worktree (via the spawn's declared `cwd`), the chain never armed: children
 * spawned untracked (no write grant) and failed closed at their first edit,
 * because the child's own cwd-rooted runtime DOES see the worktree graph and
 * its edit gate fails closed for an ungranted implementation agent.
 *
 * The graph that governs a repository lives IN that repository — the same
 * assumption the engine's own SubagentStart bookkeeping states ("runs in
 * orchestrator's cwd where task graph exists") — so the spawn's declared cwd
 * is the boundary-trusted source for which graph authority the batch targets.
 * This module decides, per batch, whether a spawn-cwd graph exists and what
 * it is. The resolution reuses the engine's ONE task-graph finder
 * (`findTaskGraphPathFrom`), so the observation and the registration core can
 * never disagree about where the graph sits.
 *
 * The decision is fail-closed: diverging graph authorities inside one batch
 * refuse the whole batch (the batch-level registration machinery is
 * single-graph), and a malformed batch resolves to the runtime polarity — the
 * admission's parse blocks those batches anyway, so the observation never
 * gates a batch the admission would refuse.
 */

import { resolve } from "node:path";
import { findTaskGraphPathFrom, pathExistsFailClosed } from "../engine/src/config";

/** The raw batch entries, whichever spawn shape the caller used (`tasks`,
 *  `chain`, or a bare single entry). `null` = the input is too malformed to
 *  address entries at all; the admission's parse refuses those batches, so
 *  the observation answers with the runtime polarity instead of guessing.
 *  Shared with `pi/extension.ts`'s `piSpawnItem` so the batch-shape read
 *  lives in exactly one place. */
export function spawnBatchEntries(raw: unknown): readonly unknown[] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (Array.isArray(input.tasks)) return input.tasks;
  if (Array.isArray(input.chain)) return input.chain;
  return [input];
}

/** The raw batch entry at `index`, or `null` when the input cannot address
 *  one. Returned by reference: callers such as `replacePiSpawnTask` write its
 *  `task` field in place. */
export function spawnEntryAt(raw: unknown, index: number): Record<string, unknown> | null {
  const entries = spawnBatchEntries(raw);
  if (entries === null) return null;
  const entry = entries[index];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  return entry as Record<string, unknown>;
}

/** One batch's per-item spawn cwds, resolved against the parent cwd with the
 *  same precedence `piSpawnCwd` applies (item cwd → batch cwd → parent cwd).
 *  `unresolved` means the raw input is malformed; the admission blocks those
 *  batches, so the runtime graph polarity applies and nothing is gated that
 *  the admission would not already have refused. */
export type SpawnBatchCwds =
  | Readonly<{ kind: "resolved"; cwds: readonly string[] }>
  | Readonly<{ kind: "unresolved" }>;

export function extractSpawnBatchCwds(raw: unknown, defaultCwd: string): SpawnBatchCwds {
  const entries = spawnBatchEntries(raw);
  if (entries === null) return Object.freeze({ kind: "unresolved" });
  const input = raw as Record<string, unknown>;
  const batchCwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const cwds: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return Object.freeze({ kind: "unresolved" });
    }
    const item = entry as Record<string, unknown>;
    const cwd = typeof item.cwd === "string" ? item.cwd : batchCwd ?? defaultCwd;
    cwds.push(resolve(defaultCwd, cwd));
  }
  return Object.freeze({ kind: "resolved", cwds: Object.freeze(cwds) });
}

/**
 * Which task graph one spawn batch targets.
 *
 * `runtime` — no spawn-cwd graph governs the batch (or the input is
 * malformed): the orchestrator runtime's own graph applies exactly as before,
 * which for a session with no runtime graph means the ad-hoc behavior.
 *
 * `spawn` — every item's declared cwd resolves to this graph: the batch is an
 * orchestration dispatch against the spawn's repository, and the whole chain
 * (registration, write grants, pointer binding, settlement) arms against it.
 *
 * `diverged` — the items resolve to disagreeing authorities (two different
 * graphs, or one graph and one absence): the single-graph registration
 * machinery cannot represent the batch, so it is refused and the operator
 * partitions it by spawn cwd.
 */
export type SpawnBatchGraphObservation =
  | Readonly<{ kind: "runtime" }>
  | Readonly<{ kind: "spawn"; graphPath: string }>
  | Readonly<{ kind: "diverged"; reason: string }>;

const diverged = (first: string, second: string): SpawnBatchGraphObservation =>
  Object.freeze({
    kind: "diverged",
    reason:
      `spawn batch items resolve to diverging task-graph authorities (${first} vs ${second}); ` +
      "partition the batch so every item targets one repository",
  });

/** Decide which graph authority one spawn batch targets. Every item's
 *  resolved cwd probes the engine's ONE task-graph finder, so the observation
 *  and the registration can never see different graphs; the all-or-refuse
 *  aggregation keeps the single-graph batch machinery intact.
 *
 *  `seen` is the has-any-item-been-probed flag, kept separate from
 *  `graphPath` because null is both the not-yet-assigned sentinel and the
 *  legitimate no-graph answer: collapsing the two made an absence-first
 *  batch adopt a later item's graph via the assignment branch instead of
 *  returning diverged, silently arming against a graph the contract says
 *  the operator partitions by spawn cwd. */
export function observeSpawnBatchGraph(raw: unknown, defaultCwd: string): SpawnBatchGraphObservation {
  const cwds = extractSpawnBatchCwds(raw, defaultCwd);
  if (cwds.kind === "unresolved") return Object.freeze({ kind: "runtime" });
  let seen = false;
  let graphPath: string | null = null;
  for (const cwd of cwds.cwds) {
    const candidate = findTaskGraphPathFrom(cwd);
    const authority = pathExistsFailClosed(candidate) ? candidate : null;
    if (!seen) {
      seen = true;
      graphPath = authority;
      continue;
    }
    if (graphPath !== authority) {
      return diverged(graphPath ?? "no graph", authority ?? "no graph");
    }
  }
  return graphPath === null
    ? Object.freeze({ kind: "runtime" })
    : Object.freeze({ kind: "spawn", graphPath });
}
