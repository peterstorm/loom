/**
 * Task dependencies: whether one Task waits for another, directly or through
 * a chain, and the cycles a TaskGraph's edges close (ADR-0081).
 *
 * A same-Wave edge is satisfied once its Task settles its implementation (the
 * `dependency` Dispatch Hold); an earlier-Wave edge once its Task is
 * `completed` (registration). A cycle can never be satisfied, so neither an
 * edit nor the State File admits one.
 *
 * Pure.
 */

/** Whether a Task with `dependsOn` reaches any of `targets` through `dependenciesOf`. */
export function dependsOnAny(
  dependsOn: readonly string[],
  targets: ReadonlySet<string>,
  dependenciesOf: (taskId: string) => readonly string[],
): boolean {
  const seen = new Set<string>();
  const queue = [...dependsOn];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (targets.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...dependenciesOf(id));
  }
  return false;
}

type DependencyTask = Readonly<{ id: string; wave: number; depends_on?: readonly string[] }>;

/** The edges of `task`, as the graph holds them. */
const edgesOf = (task: DependencyTask): readonly string[] => task.depends_on ?? [];

/**
 * A path of `depends_on` edges from `from` to `to` (both included), or null.
 * Depth-first in edge order, so the path named is stable.
 */
export function dependencyPath(tasks: readonly DependencyTask[], from: string, to: string): readonly string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const visited = new Set<string>();
  const walk = (id: string): readonly string[] | null => {
    if (id === to) return [id];
    if (visited.has(id)) return null;
    visited.add(id);
    const task = byId.get(id);
    for (const next of task === undefined ? [] : edgesOf(task)) {
      const rest = walk(next);
      if (rest !== null) return [id, ...rest];
    }
    return null;
  };
  return walk(from);
}

/**
 * The cycle adding the edge `from → to` would close, as the Task ids around
 * it starting and ending at `from`, or null when the edge closes none.
 */
export function cycleClosedBy(tasks: readonly DependencyTask[], from: string, to: string): readonly string[] | null {
  const back = dependencyPath(tasks, to, from);
  return back === null ? null : Object.freeze([from, ...back]);
}

/**
 * Every dependency cycle of `tasks`, each once as one sentence naming its
 * members, in graph order. Self and unknown edges are the State File's to
 * refuse (`taskDependencyErrors`); they close no cycle here.
 */
export function dependencyCycles(tasks: readonly DependencyTask[]): readonly string[] {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const problems: string[] = [];
  const reported = new Set<string>();
  for (const task of tasks) {
    if (reported.has(task.id)) continue;
    for (const id of edgesOf(task)) {
      if (id === task.id || !byId.has(id)) continue;
      const cycle = dependencyPath(tasks, id, task.id);
      if (cycle === null) continue;
      const around = [task.id, ...cycle];
      around.forEach((member) => reported.add(member));
      problems.push(`dependency cycle: ${around.join(" → ")}`);
      break;
    }
  }
  return Object.freeze(problems);
}
