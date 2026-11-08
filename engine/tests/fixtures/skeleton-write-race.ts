/**
 * The race hook every skeleton-writer race test shares: run a concurrent
 * edit at the skeleton writer's first draw of randomness, its prepared name.
 *
 * The writer draws that name once the no-follow walk and the directory opens
 * are done, before it writes the replacement, reads the target's digest and
 * publishes. Every path the race tests drive draws no randomness before it:
 * the writer entry points directly, `refreshRevisedSkeletons`, and the
 * `revise-contract` handler, which observes and refreshes before its locked
 * State File update (the lock's owner token and the State File's temp name
 * draw later). So the first draw is the writer's, and the hook needs no
 * stack sniffing to find it.
 *
 * The hook fires once; the caller asserts `fired()` so a path that stops
 * drawing randomness fails loudly instead of passing without its race.
 */

import { vi } from "vitest";

export type RaceHook = Readonly<{ fired: () => boolean }>;

/** Run `during` once, at the first `Math.random` draw; later draws are real. */
export function duringPreparedName(during: () => void): RaceHook {
  let fired = false;
  vi.spyOn(Math, "random").mockImplementationOnce(() => {
    fired = true;
    during();
    return 0.5;
  });
  return { fired: () => fired };
}
