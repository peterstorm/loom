/**
 * The user's list of repositories whose lint-coverage reminder is silenced:
 * repositories they do not own, or do not want Loom's linter in. It lives in
 * the user's own config directory, never in the repository, so silencing a
 * reminder writes nothing another contributor sees. Every entry carries its
 * reason, like every other exclusion Loom keeps.
 *
 * Pure: the document's parse and its updates. The file is read and written by
 * `handlers/lint-coverage-shell.ts`.
 */

import { isRecord } from "./plain-record";

/** One repository whose coverage reminder the user has silenced, and why. */
export type IgnoredProject = Readonly<{ path: string; reason: string }>;
export type CoverageIgnoreList = readonly IgnoredProject[];

export type IgnoreListParse =
  | Readonly<{ ok: true; value: CoverageIgnoreList }>
  | Readonly<{ ok: false; error: string }>;

const ignoredProject = (raw: unknown, index: number): IgnoredProject | string => {
  if (!isRecord(raw)) return `ignore[${index}] must be an object { path, reason }`;
  const unknownKeys = Object.keys(raw).filter((key) => key !== "path" && key !== "reason");
  if (unknownKeys.length > 0) return `ignore[${index}] has unknown key '${unknownKeys[0]}'`;
  const { path, reason } = raw;
  if (typeof path !== "string" || !path.startsWith("/")) return `ignore[${index}].path must be an absolute path`;
  if (typeof reason !== "string" || reason.trim().length === 0) return `ignore[${index}].reason must be a non-empty string`;
  return Object.freeze({ path, reason });
};

/** Parse the document `{ "ignore": [{ path, reason }] }`, strictly. */
export function parseCoverageIgnoreList(raw: unknown): IgnoreListParse {
  if (!isRecord(raw) || !Array.isArray(raw.ignore)) return { ok: false, error: "expected { \"ignore\": [{ path, reason }] }" };
  const unknownKeys = Object.keys(raw).filter((key) => key !== "ignore");
  if (unknownKeys.length > 0) return { ok: false, error: `unknown key '${unknownKeys[0]}'` };
  const entries: readonly unknown[] = raw.ignore;
  const parsed = entries.map(ignoredProject);
  const refusal = parsed.find((entry): entry is string => typeof entry === "string");
  if (refusal !== undefined) return { ok: false, error: refusal };
  return { ok: true, value: Object.freeze(parsed.filter((entry): entry is IgnoredProject => typeof entry !== "string")) };
}

export const isIgnored = (list: CoverageIgnoreList, projectRoot: string): boolean =>
  list.some((entry) => entry.path === projectRoot);

export const withoutIgnored = (list: CoverageIgnoreList, path: string): CoverageIgnoreList =>
  Object.freeze(list.filter((entry) => entry.path !== path));

/** The list with `path` ignored for `reason`, replacing an earlier entry for it. */
export const withIgnored = (list: CoverageIgnoreList, path: string, reason: string): CoverageIgnoreList =>
  Object.freeze([...withoutIgnored(list, path), Object.freeze({ path, reason })]);

export const renderCoverageIgnoreList = (list: CoverageIgnoreList): string =>
  `${JSON.stringify({ ignore: list }, null, 2)}\n`;
