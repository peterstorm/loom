/**
 * `lint-project --write-baseline` as data: which sites each baselined rule
 * flags today, and the project `config.json` that records them.
 *
 * Pure. The script walks the tree, reads the sources and writes every harness
 * rules directory's `config.json`; the decisions live here, where they are
 * tested without a filesystem:
 *   - `recordedBaselines` — each owner's detector over the sources its
 *     extensions cover, sorted, ignoring the current baseline (so a re-run after
 *     a site is proven total drops its entry);
 *   - `configWithBaselines` — the next config object: every other field kept,
 *     each recorded list written under its owner's key where that key stood,
 *     and an EMPTY list removed rather than written (no debt, no key).
 */

import { extname } from "node:path";
import type { BaselineConfigKey, BaselineKey, BaselineOwner } from "./baseline";

/** One source file as the detectors read it: its project-relative path and content. */
export type BaselineSource = Readonly<{ path: string; content: string }>;

/** One owner's recorded list, under the config key it lives in. */
export type RecordedBaseline = Readonly<{ configKey: BaselineConfigKey; keys: readonly BaselineKey[] }>;

/** The sites each owner flags in `sources` (those with an extension it reads), sorted. */
export function recordedBaselines(
  owners: readonly BaselineOwner[],
  sources: readonly BaselineSource[],
): readonly RecordedBaseline[] {
  return owners.map((owner) => ({
    configKey: owner.configKey,
    keys: [...sources
      .filter((source) => owner.extensions.includes(extname(source.path)))
      .flatMap((source) => owner.detect(source.content, source.path))].sort(),
  }));
}

/** One existing config entry after `recorded` is written: kept as is, replaced
 *  in place by its recorded list, or dropped when that list is empty. */
function entryAfter(
  [key, value]: readonly [string, unknown],
  recorded: ReadonlyMap<string, readonly string[]>,
): readonly (readonly [string, unknown])[] {
  const keys = recorded.get(key);
  if (keys === undefined) return [[key, value]];
  return keys.length === 0 ? [] : [[key, keys]];
}

/** The config `existing` becomes once `recorded` is written into it: every
 *  other field kept in place, a recorded list replacing its key where it
 *  stood (or appended when new), and an empty list removed rather than
 *  written. */
export function configWithBaselines(
  existing: Readonly<Record<string, unknown>>,
  recorded: readonly RecordedBaseline[],
): Readonly<Record<string, unknown>> {
  const lists = new Map<string, readonly string[]>(recorded.map(({ configKey, keys }) => [configKey, keys]));
  const updated = Object.entries(existing).flatMap((entry) => entryAfter(entry, lists));
  const added = recorded
    .filter(({ configKey, keys }) => keys.length > 0 && !Object.hasOwn(existing, configKey))
    .map(({ configKey, keys }) => [configKey, keys] as const);
  return Object.fromEntries([...updated, ...added]);
}
