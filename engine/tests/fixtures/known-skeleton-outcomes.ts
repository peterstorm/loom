/**
 * `skeletonOutcomesOf` for a test that names a Task its graph holds: the
 * outcomes, or a thrown error naming the unknown id, so a typo in a fixture
 * fails loudly instead of comparing two empty lists.
 */

import { skeletonOutcomesOf } from "../../src/core/skeleton/outcomes";
import type { PathObservation, PathSkeletonOutcome } from "../../src/core/skeleton/types";
import type { TaskGraph } from "../../src/types";

export function knownSkeletonOutcomes(
  graph: TaskGraph,
  taskId: string,
  observations: ReadonlyMap<string, PathObservation>,
): readonly PathSkeletonOutcome[] {
  const outcomes = skeletonOutcomesOf(graph, taskId, observations);
  if (!outcomes.ok) throw new Error(`fixture graph holds no Task ${outcomes.error.taskId}`);
  return outcomes.value;
}
