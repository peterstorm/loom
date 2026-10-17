/**
 * The in-memory `StopCheckBlockCounters`: the test adapter of the stop checks'
 * keyed counter port, beside the file-backed production adapter and the unkept
 * report-only one (`UNKEPT_BLOCK_COUNTERS`). Every stop-check test that counts
 * blocks uses this one fake, so a change to the port is made once.
 */

import type { StopCheckBlockCount, StopCheckBlockCounters, StopCheckName } from "../../src/core/affected-stop-check-types";

export type InMemoryBlockCountersOptions = Readonly<{
  /** What a check's counter reads before anything is recorded: a starting
   *  count, or an unreadable counter, which stays unreadable. */
  presets?: Partial<Readonly<Record<StopCheckName, StopCheckBlockCount>>>;
  /** Checks whose `clear` throws, as a read-only counter directory would. */
  clearFails?: readonly StopCheckName[];
}>;

export type InMemoryBlockCounters = Readonly<{
  counters: StopCheckBlockCounters;
  /** What each check recorded, per agent key. A cleared counter reads 0. */
  counts: Readonly<Record<StopCheckName, Map<string, number>>>;
}>;

export function inMemoryBlockCounters(options: InMemoryBlockCountersOptions = {}): InMemoryBlockCounters {
  const counts = { acceptance: new Map<string, number>(), affected: new Map<string, number>() };
  const counters: StopCheckBlockCounters = {
    issued: (check, key) => {
      const preset = options.presets?.[check];
      if (preset?.kind === "unreadable") return preset;
      return { kind: "count", blocks: counts[check].get(key) ?? preset?.blocks ?? 0 };
    },
    record: (check, key, blocks) => { counts[check].set(key, blocks); },
    clear: (check, key) => {
      if (options.clearFails?.includes(check) === true) throw new Error("EROFS: counter directory is read-only");
      counts[check].set(key, 0);
    },
  };
  return { counters, counts };
}
