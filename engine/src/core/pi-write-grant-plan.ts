/**
 * Which Pi child write grants a spawn batch needs.
 *
 * Pure policy. `pi/write-grant.ts` MINTS the capability and the pi extension
 * ENFORCES it per write; this module only decides, per batch item, whether a
 * capability is required at all and what it must be bound to.
 *
 * The decision turns on one fact the shell supplies: is a Loom task graph
 * active for this session? A write grant exists solely to satisfy
 * `shouldBlockDirectEdit`, and that gate's FIRST act is to allow every edit
 * when no task graph exists (core/block-direct-edits.ts). So outside
 * orchestration a grant authorizes nothing that was not already permitted —
 * while REQUIRING one made every implementation agent unspawnable ad hoc on
 * Pi: the binding needs a `T\d+` Task ID that only a decomposed task graph
 * produces, and its absence threw, which the tool-call guard turned into a
 * refused spawn. Claude Code has no such asymmetry (its hook shims exit early
 * with no graph), so this is also what makes the two harnesses agree.
 *
 * The `graphIsActive` fact is deliberately a parameter and not a probe: the
 * shell already computes it as a union (graph path, child task-graph pointer,
 * rejected-grant session) and both this planner and the edit gate must judge
 * the same instant.
 *
 * The decision functions perform no I/O, clock, or randomness. Importing this
 * module is not currently side-effect-free: its Agent policy dependencies reach
 * `config.ts`, whose initialization resolves the Task Graph through filesystem
 * and Git probes. Splitting runtime discovery from Agent policy is tracked as
 * a separate configuration-seam deepening.
 */

import { match } from "ts-pattern";
import type { TaskExecutionSpawn } from "./validate-task-execution";
import { deriveArtifactWriteScope } from "./artifact-write-scope";
import { extractTaskId } from "../utils/extract-task-id";
import { PHASE_AGENT_MAP } from "../config";
import { stripNamespace } from "../utils/strip-namespace";

/** One batch item's spawn shape, as the Pi transport presents it. */
export type PiWriteGrantCandidate = Readonly<{ agent: string; task: string }>;

/**
 * What a single item needs. `none` is a first-class outcome, not a null: an
 * ad-hoc spawn, a read-only agent, and a writer with no derivable scope all
 * legitimately receive nothing, and the shell must not have to distinguish
 * "no grant" from "grant lookup failed".
 */
export type PiWriteGrantRequirement =
  | Readonly<{ kind: "none" }>
  /** Whole-session capability for an implementation item, bound to its Task ID. */
  | Readonly<{ kind: "session"; taskId: string }>
  /** Artifact-confined capability for a phase/panel writer. */
  | Readonly<{ kind: "scoped"; taskId: string; scopeDirs: readonly string[] }>;

export type PiWriteGrantPlan =
  | Readonly<{ ok: true; requirements: readonly PiWriteGrantRequirement[] }>
  | Readonly<{ ok: false; error: string }>;

const NONE: PiWriteGrantRequirement = Object.freeze({ kind: "none" });

/**
 * Plan the grants for one classified batch.
 *
 * `items` and `spawns` are parallel arrays produced by the same batch parse;
 * a length disagreement is a caller bug, reported rather than silently
 * short-planned (an under-planned batch would spawn a writer with no
 * capability and fail confusingly at its first edit).
 */
export function planPiWriteGrants(
  items: readonly PiWriteGrantCandidate[],
  spawns: readonly (TaskExecutionSpawn | undefined)[],
  graphIsActive: boolean,
): PiWriteGrantPlan {
  if (items.length !== spawns.length) {
    return { ok: false, error: "Pi write-grant plan requires one classified spawn per batch item" };
  }
  // Outside orchestration nothing is gated, so nothing needs authorizing.
  // Minting a capability here would bind it to a task graph that does not
  // exist, and demanding a Task ID would refuse the spawn outright.
  if (!graphIsActive) {
    return { ok: true, requirements: Object.freeze(items.map(() => NONE)) };
  }

  const requirements: PiWriteGrantRequirement[] = [];
  for (const [index, item] of items.entries()) {
    const spawn = spawns[index];
    const requirement = match(spawn?.kind)
      .with("implementation", (): PiWriteGrantRequirement | string => {
        const taskId = extractTaskId(item.task);
        return taskId === null
          ? `implementation item ${index + 1} has no Task ID for write-grant binding`
          : { kind: "session", taskId };
      })
      .with("non-implementation", (): PiWriteGrantRequirement | string => {
        const scopeDirs = deriveArtifactWriteScope(item.agent, item.task);
        if (scopeDirs === null) return NONE;
        const phase = PHASE_AGENT_MAP[stripNamespace(item.agent)];
        return { kind: "scoped", taskId: `phase:${phase ?? "artifact"}`, scopeDirs };
      })
      // `standalone` (marked review runs) and an unclassified item both carry
      // no write contract.
      .otherwise((): PiWriteGrantRequirement | string => NONE);
    if (typeof requirement === "string") return { ok: false, error: requirement };
    requirements.push(requirement);
  }
  return { ok: true, requirements: Object.freeze(requirements) };
}
