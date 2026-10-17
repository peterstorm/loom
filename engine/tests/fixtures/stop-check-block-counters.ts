/**
 * The in-memory `StopCheckBlockCounters`: the test adapter of the stop checks'
 * keyed counter port, beside the file-backed production adapter and the unkept
 * report-only one (`UNKEPT_BLOCK_COUNTERS`). Every stop-check test that counts
 * blocks uses this one fake, so a change to the port is made once.
 *
 * It keeps the file adapter's `clear` contract: a cleared counter is absent,
 * as a removed counter file is, and reads no block issued whatever its preset.
 */

import type { StopCheckBlockCount, StopCheckBlockCounters, StopCheckName } from "../../src/core/affected-stop-check-types";

export type InMemoryBlockCountersOptions = Readonly<{
  /** What a check's counter reads before anything is recorded or cleared: a
   *  starting count, or an unreadable counter, as a corrupt file reads. */
  presets?: Partial<Readonly<Record<StopCheckName, StopCheckBlockCount>>>;
  /** Checks whose `clear` throws, as a read-only counter directory would. */
  clearFails?: readonly StopCheckName[];
}>;

export type InMemoryBlockCounters = Readonly<{
  counters: StopCheckBlockCounters;
  /** What each check recorded, per agent key. A cleared counter has no entry. */
  counts: Readonly<Record<StopCheckName, Map<string, number>>>;
}>;

const NONE_ISSUED: StopCheckBlockCount = Object.freeze({ kind: "count", blocks: 0 });

export function inMemoryBlockCounters(options: InMemoryBlockCountersOptions = {}): InMemoryBlockCounters {
  const counts = { acceptance: new Map<string, number>(), affected: new Map<string, number>() };
  const cleared = { acceptance: new Set<string>(), affected: new Set<string>() };
  const counters: StopCheckBlockCounters = {
    issued: (check, key) => {
      const recorded = counts[check].get(key);
      if (recorded !== undefined) return { kind: "count", blocks: recorded };
      // A cleared counter is gone, so its preset no longer applies.
      if (cleared[check].has(key)) return NONE_ISSUED;
      return options.presets?.[check] ?? NONE_ISSUED;
    },
    record: (check, key, blocks) => { counts[check].set(key, blocks); },
    clear: (check, key) => {
      if (options.clearFails?.includes(check) === true) throw new Error("EROFS: counter directory is read-only");
      counts[check].delete(key);
      cleared[check].add(key);
    },
  };
  return { counters, counts };
}
