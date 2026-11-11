/**
 * The one skeleton-outcome derivation (AD-13, INV-4 owner): exactly one
 * `SkeletonOutcome` per non-test file_list path (FR-030), and the one
 * judgment of whether an existing file is an untouched engine skeleton
 * (AD-4's content-addressed recognition), with what an untouched one holds
 * (`presentSkeletonOf`). Registration, the contract stop, revision, status
 * and the brief all call these; none compares digests or orders the outcomes
 * itself. Pure.
 *
 * Precedence, first match wins:
 *   1. an untouched engine skeleton → `skeleton-written` with its record's
 *      origin (`spawn` when adopted from canonical bytes with no record);
 *   2. any other present path → `exists-not-skeletonized`;
 *   3. unbound → `contract-has-no-types-file` when the Task claims a
 *      `Types file: none` contract, else `no-bound-exports`;
 *   4. bound, but `skeletonLanguageOf` says unsupported → `unsupported-language`;
 *   5. bound and supported → `skeleton-written { origin: "spawn" }` (to write).
 *
 * A Distill Task is the one exception (`distillOutcomeOf`, ADR-0068 §9): it
 * never reports `skeleton-written`, so the planner derives no write for it.
 *
 * A path the observations do not mention is absent. A Task id the graph does
 * not hold is `unknown-task`, never an empty outcome list: no Task and a Task
 * with no production files stay distinguishable.
 */

import { match } from "ts-pattern";
import { contractRole } from "../acceptance-contract";
import { isDistillTask } from "../distill-task";
import { samePlanPath } from "../plan-path-match";
import type { Task, TaskGraph } from "../../types";
import { skeletonLanguageOf } from "./language";
import { productionFiles } from "./graph-view";
import type {
  PathObservation,
  PathSkeletonOutcome,
  SkeletonOrigin,
  SkeletonOutcome,
  SkeletonOutcomesOfFn,
  SkeletonRecord,
} from "./types";

/**
 * Whether a file's current bytes are the engine's: they equal the digest the
 * engine recorded writing, or the canonical bytes the generator produces for
 * the current surface. A missing file (`currentSha` null) never is.
 */
export function isUntouchedSkeleton(record: SkeletonRecord | undefined, currentSha: string | null, canonicalSha: string | null): boolean {
  return currentSha !== null && (currentSha === record?.engineSha256 || currentSha === canonicalSha);
}

/**
 * What a present file at a skeleton path holds, the one judgment every writer
 * step acts on: anyone else's bytes (`touched`, never written over), the
 * canonical bytes already (`canonical`, adopted or kept as they are), or the
 * engine's bytes from an older surface (`engine-bytes`, which a refresh
 * replaces when there are canonical bytes to write).
 */
export type PresentSkeleton = "touched" | "canonical" | "engine-bytes";

export function presentSkeletonOf(record: SkeletonRecord | undefined, currentSha: string, canonicalSha: string | null): PresentSkeleton {
  if (!isUntouchedSkeleton(record, currentSha, canonicalSha)) return "touched";
  return currentSha === canonicalSha ? "canonical" : "engine-bytes";
}

const written = (origin: SkeletonOrigin): SkeletonOutcome => Object.freeze({ kind: "skeleton-written", origin });
const EXISTS: SkeletonOutcome = Object.freeze({ kind: "exists-not-skeletonized" });
const NO_BOUND_EXPORTS: SkeletonOutcome = Object.freeze({ kind: "no-bound-exports" });
const NO_TYPES_FILE: SkeletonOutcome = Object.freeze({ kind: "contract-has-no-types-file" });
/** What a path the observations do not mention is: absent. */
export const ABSENT: PathObservation = Object.freeze({ kind: "absent" });

/** Whether the Task claims a contract that freezes no types file. */
const claimsTypelessContract = (graph: TaskGraph, task: Task): boolean =>
  (graph.acceptance_contracts ?? []).some((contract) =>
    contract.types.kind === "none" && contractRole(contract, task, graph.tasks).kind === "claimant");

function outcomeOf(graph: TaskGraph, task: Task, path: string, observation: PathObservation): SkeletonOutcome {
  if (observation.kind === "present") {
    const record = (graph.skeletons ?? []).find((recorded) => samePlanPath(recorded.path, path));
    return isUntouchedSkeleton(record, observation.sha256, observation.canonicalSha256) ? written(record?.origin ?? "spawn") : EXISTS;
  }
  if (!(graph.export_bindings ?? []).some((binding) => samePlanPath(binding.path, path))) {
    return claimsTypelessContract(graph, task) ? NO_TYPES_FILE : NO_BOUND_EXPORTS;
  }
  const target = skeletonLanguageOf(path);
  return target.kind === "unsupported" ? Object.freeze({ kind: "unsupported-language", reason: target.reason }) : written("spawn");
}

/**
 * A Distill Task's outcome at one path (ADR-0068 §9), given the outcome a
 * holder of the path would get, or null where no outcome is true of it.
 *
 * No Skeleton is ever written, adopted or refreshed on a Distill Task's
 * behalf, so it never reports `skeleton-written`:
 * - a present path is `exists-not-skeletonized`, even while it still holds
 *   the engine's bytes (that Skeleton is its holder's);
 * - an absent path keeps the holder's reason no Skeleton belongs there
 *   (unbound, or an unsupported language);
 * - an absent path a holder would be given a Skeleton at has NO outcome: a
 *   sibling deleted it, nothing is written, and none of the five outcomes
 *   says so. It is the one path FR-030's "exactly one outcome" leaves out.
 */
function distillOutcomeOf(holderOutcome: SkeletonOutcome, observation: PathObservation): SkeletonOutcome | null {
  if (observation.kind === "present") return EXISTS;
  return holderOutcome.kind === "skeleton-written" ? null : holderOutcome;
}

export const skeletonOutcomesOf: SkeletonOutcomesOfFn = (graph, taskId, observations) => {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return { ok: false, error: Object.freeze({ kind: "unknown-task", taskId }) };
  const distill = isDistillTask(task);
  return {
    ok: true,
    value: Object.freeze(productionFiles(graph, task).flatMap((path): readonly PathSkeletonOutcome[] => {
      const observation = observations.get(path) ?? ABSENT;
      const holderOutcome = outcomeOf(graph, task, path, observation);
      const outcome = distill ? distillOutcomeOf(holderOutcome, observation) : holderOutcome;
      return outcome === null ? [] : [Object.freeze({ path, outcome })];
    })),
  };
};

/** The exact operator wording of each outcome (FR-030). */
export const renderSkeletonOutcome = (outcome: SkeletonOutcome): string =>
  match(outcome)
    .with({ kind: "skeleton-written" }, () => "skeleton written")
    .with({ kind: "no-bound-exports" }, () => "no bound exports, no skeleton")
    .with({ kind: "contract-has-no-types-file" }, () => "contract has no types file, no skeletons")
    .with({ kind: "unsupported-language" }, () => "unsupported language, no skeleton")
    .with({ kind: "exists-not-skeletonized" }, () => "exists, not skeletonized")
    .exhaustive();
