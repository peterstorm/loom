/** A subagent probe that reports a subagent from its second observation on:
 *  quiet at a helper's pre-lock check, active at its in-lock re-check. */
export function appearsUnderTheLock() {
  let observations = 0;
  const probe = (_statePath: string): boolean => (observations += 1) >= 2;
  return { probe, observations: () => observations };
}
