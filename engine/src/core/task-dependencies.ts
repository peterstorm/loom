/**
 * Whether one Task waits for another, directly or through a chain of
 * dependencies. The one rule plan-binding validation applies to invariant
 * owners and to contract Tasks alike.
 */

/** Whether a Task with `dependsOn` reaches any of `targets` through `dependenciesOf`. */
export function dependsOnAny(
  dependsOn: readonly string[],
  targets: ReadonlySet<string>,
  dependenciesOf: (taskId: string) => readonly string[],
): boolean {
  const seen = new Set<string>();
  const queue = [...dependsOn];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (targets.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...dependenciesOf(id));
  }
  return false;
}
