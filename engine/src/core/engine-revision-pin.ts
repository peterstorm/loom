/**
 * The engine revision a TaskGraph is written by (loom#198, Cause 4).
 *
 * The plugin path points at a Loom checkout. When another session switched
 * that checkout to a branch without a fix, hooks ran older engine code than
 * the CLI, mid-orchestration, and judged the same TaskGraph by different
 * rules. Population now pins the content-addressed runtime revision
 * (`runtime-compatibility.ts`), and the State File's one write boundary
 * (`StateManager`) refuses to persist a graph whose pin is not the running
 * engine's: a State File is only ever written by the engine revision it
 * records. Reads and guards are unaffected, so protection never lapses.
 *
 * Changing engine is an explicit, audited act: `orchestration
 * adopt-engine-revision --reason` re-pins to the running revision and records
 * the move. A graph populated before the pin existed carries none and is not
 * enforced until it adopts one.
 *
 * Loom orchestrating its own package in place is the one case a pin cannot
 * serve: every Wave changes the engine it runs on. Population records that as
 * `self-hosted` and nothing is enforced.
 *
 * Pure.
 */

import type { DomainResult } from "./orchestration-contract";
import type { EngineRevisionAdoption, EngineRevisionPin, TaskGraph } from "../types";

export const MAX_ENGINE_REVISION_REASON_LENGTH = 500;

const freeze = Object.freeze;
const REVISION = /^sha256:[0-9a-f]{64}$/u;

/** Whether `raw` is a runtime revision as `runtimeRevisionFromEntries` mints one. */
export const isEngineRevision = (raw: unknown): raw is string => typeof raw === "string" && REVISION.test(raw);

/**
 * Whether the orchestrated repository holds the engine package itself: the
 * package root is the repository root or beneath it. Both are canonical
 * absolute paths with `separator` between segments.
 */
export const isSelfHosted = (packageRoot: string, repositoryRoot: string, separator: string): boolean =>
  packageRoot === repositoryRoot || packageRoot.startsWith(`${repositoryRoot}${separator}`);

/** The pin population records: the running revision, or `self-hosted` when the project is the engine package itself. */
export function engineRevisionPinAtPopulation(runningRevision: string, selfHosted: boolean): EngineRevisionPin {
  return selfHosted
    ? freeze({ schemaVersion: 1 as const, kind: "self-hosted" as const })
    : freeze({ schemaVersion: 1 as const, kind: "pinned" as const, revision: runningRevision, adoptions: freeze([]) });
}

/**
 * Why the running engine may not persist `state`, or null when it may: the
 * graph is pinned to a different revision. An unpinned (pre-pin) or
 * self-hosted graph is never refused.
 */
export function engineRevisionWriteRefusal(state: Pick<TaskGraph, "engine_revision">, runningRevision: string): string | null {
  const pin = state.engine_revision;
  if (pin === undefined || pin.kind === "self-hosted" || pin.revision === runningRevision) return null;
  return [
    `This TaskGraph is pinned to Loom engine revision ${pin.revision}, but the running engine is ${runningRevision};`,
    "nothing was written. The plugin checkout changed under a live orchestration.",
    "Restore the engine the run was pinned to, or continue on this one with",
    "`helper orchestration adopt-engine-revision --reason \"<why this engine>\"` (recorded in the graph).",
  ].join(" ");
}

export type EngineRevisionAdoptionOutcome =
  | Readonly<{ kind: "adopted"; graph: TaskGraph; adoption: EngineRevisionAdoption }>
  | Readonly<{ kind: "already-pinned"; revision: string }>;

/**
 * Re-pin `graph` to the running revision, recording where it moved from and
 * why. Idempotent: a graph already pinned to it is unchanged. An unpinned
 * graph gains its first pin (`from: null`). A self-hosted graph is refused:
 * nothing is pinned there to move.
 */
export function adoptEngineRevision(
  graph: TaskGraph,
  runningRevision: string,
  rawReason: string,
): DomainResult<EngineRevisionAdoptionOutcome, string> {
  const reason = rawReason.trim();
  if (reason.length === 0) return freeze({ ok: false as const, error: "--reason must say why the run continues on this engine" });
  if (reason.length > MAX_ENGINE_REVISION_REASON_LENGTH) {
    return freeze({ ok: false as const, error: `--reason is at most ${MAX_ENGINE_REVISION_REASON_LENGTH} characters` });
  }
  if (!isEngineRevision(runningRevision)) return freeze({ ok: false as const, error: `the running engine revision ${runningRevision} is not a runtime revision` });
  const pin = graph.engine_revision;
  if (pin?.kind === "self-hosted") {
    return freeze({ ok: false as const, error: "this TaskGraph orchestrates the engine package itself (self-hosted); there is no pin to move" });
  }
  if (pin?.revision === runningRevision) return freeze({ ok: true as const, value: freeze({ kind: "already-pinned" as const, revision: runningRevision }) });
  const adoption: EngineRevisionAdoption = freeze({ from: pin?.revision ?? null, to: runningRevision, reason });
  const repinned: EngineRevisionPin = freeze({
    schemaVersion: 1 as const,
    kind: "pinned" as const,
    revision: runningRevision,
    adoptions: freeze([...(pin?.adoptions ?? []), adoption]),
  });
  return freeze({ ok: true as const, value: freeze({ kind: "adopted" as const, graph: freeze({ ...graph, engine_revision: repinned }), adoption }) });
}
