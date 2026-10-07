/**
 * Spawn preparation: the ordered observe → expand → admit pipeline one Pi
 * spawn batch passes before any lifecycle reservation.
 *
 * The order is load-bearing, and this function is its one home:
 *
 * 1. **Observe** which task graph governs the batch. The admission's gates
 *    consume that polarity, and brief rendering reads that graph, so nothing
 *    may run before it. Diverging authorities refuse the whole batch.
 * 2. **Expand** implementation brief markers against the observed graph and
 *    write the rendered briefs into the live payload, so every later gate
 *    judges exactly the bytes the child receives. A batch whose marker cannot
 *    be rendered is refused whole, with no rewrite applied.
 * 3. **Admit** the expanded payload under the observed graph authority.
 *
 * Every effect is a port, so tests drive the ordering with plain fakes. The
 * pipeline names the guard that was executing for every outcome, including a
 * crash in a port: the shell reports that guard and fails closed.
 */

import type { SpawnAdmission, SpawnGuardName } from "../engine/src/core/spawn-admission";
import type { ImplementationBrief } from "../engine/src/core/implementation-brief";
import type { DomainResult } from "../engine/src/core/orchestration-contract";
import { expandImplementationBriefMarkers } from "./implementation-brief-expansion";
import type { SpawnBatchGraphObservation } from "./spawn-graph";

/** The task-graph authority one batch is admitted and dispatched against.
 *  `spawnGraphPath` is non-null exactly when the spawn's declared cwd, not
 *  the orchestrator runtime, supplied the graph; `active` and `path` are the
 *  resolved polarity and location every later stage consumes. */
export type SpawnBatchGraphAuthority = Readonly<{
  active: boolean;
  path: string;
  spawnGraphPath: string | null;
}>;

export type SpawnPreparationGuard = SpawnGuardName | "implementation-brief-expansion";

export type SpawnPreparationPorts = Readonly<{
  /** Which graph authority the batch's declared cwds resolve to. */
  observeGraph: (input: unknown) => SpawnBatchGraphObservation;
  /** The orchestrator runtime's own graph, used when no spawn graph governs.
   *  The path is read lazily: a spawn-governed batch never resolves it. */
  runtimeGraph: Readonly<{ active: boolean; path: () => string }>;
  /** Render one Task's implementation brief against the governing graph. */
  renderBrief: (graphPath: string, taskId: string) => DomainResult<ImplementationBrief, string>;
  /** Write one rendered brief into the live spawn payload at `slot`. */
  rewriteTask: (slot: number, task: string) => void;
  /** Run the Spawn Admission core over the expanded payload. Admission ports
   *  that perform I/O call `enterGuard` first, so a crash names its gate. */
  admit: (
    input: unknown,
    graph: SpawnBatchGraphAuthority,
    enterGuard: (guard: SpawnGuardName) => void,
  ) => SpawnAdmission;
}>;

export type SpawnPreparation =
  | Readonly<{ kind: "block"; guard: SpawnPreparationGuard; reason: string }>
  | Readonly<{ kind: "pass-through" }>
  | Readonly<{
      kind: "admit";
      graph: SpawnBatchGraphAuthority;
      admission: Extract<SpawnAdmission, { kind: "admit" }>;
    }>
  | Readonly<{ kind: "crashed"; guard: SpawnPreparationGuard; cause: unknown }>;

export function prepareSpawnBatch(input: unknown, ports: SpawnPreparationPorts): SpawnPreparation {
  let guard: SpawnPreparationGuard = "parse-pi-subagent-batch";
  try {
    const observed = ports.observeGraph(input);
    if (observed.kind === "diverged") {
      return Object.freeze({ kind: "block", guard, reason: `BLOCKED: ${observed.reason}.` });
    }
    const spawnGraphPath = observed.kind === "spawn" ? observed.graphPath : null;
    const graph: SpawnBatchGraphAuthority = Object.freeze({
      active: spawnGraphPath !== null || ports.runtimeGraph.active,
      path: spawnGraphPath ?? ports.runtimeGraph.path(),
      spawnGraphPath,
    });

    guard = "implementation-brief-expansion";
    const briefs = expandImplementationBriefMarkers(input, (taskId) => ports.renderBrief(graph.path, taskId));
    if (!briefs.ok) return Object.freeze({ kind: "block", guard, reason: briefs.reason });
    for (const { slot, prompt } of briefs.rewrites) ports.rewriteTask(slot, prompt);

    const admission = ports.admit(input, graph, (entered) => { guard = entered; });
    if (admission.kind === "block") {
      return Object.freeze({ kind: "block", guard: admission.guard, reason: admission.reason });
    }
    if (admission.kind === "pass-through") return Object.freeze({ kind: "pass-through" });
    return Object.freeze({ kind: "admit", graph, admission });
  } catch (cause) {
    return Object.freeze({ kind: "crashed", guard, cause });
  }
}
