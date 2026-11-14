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

declare const ignoredProjectBrand: unique symbol;

/** One repository whose coverage reminder the user has silenced, and why: an
 *  absolute path and a non-blank reason. Minted only by `ignoredProject`, so
 *  the parser and every update hold the same invariant. */
export type IgnoredProject = Readonly<{ path: string; reason: string }> & { readonly [ignoredProjectBrand]: true };
export type CoverageIgnoreList = readonly IgnoredProject[];

/** Why an entry cannot be an ignored project. */
export type IgnoredProjectError =
  | Readonly<{ kind: "relative-path"; path: string }>
  | Readonly<{ kind: "blank-reason" }>;

export type IgnoredProjectParse =
  | Readonly<{ ok: true; value: IgnoredProject }>
  | Readonly<{ ok: false; error: IgnoredProjectError }>;

/** The read of an ignore list: the list, or why it is refused. */
export type IgnoreListParse =
  | Readonly<{ ok: true; value: CoverageIgnoreList }>
  | Readonly<{ ok: false; error: string }>;

/** The smart constructor: the one place an ignored project's invariant is checked. */
export function ignoredProject(path: string, reason: string): IgnoredProjectParse {
  if (!path.startsWith("/")) return { ok: false, error: { kind: "relative-path", path } };
  if (reason.trim().length === 0) return { ok: false, error: { kind: "blank-reason" } };
  // The brand is minted here and nowhere else: both checks above have passed.
  return { ok: true, value: Object.freeze({ path, reason }) as IgnoredProject };
}

/** The refusal in the field's own words, prefixed by where it was found. */
export function describeIgnoredProjectError(error: IgnoredProjectError, where: string): string {
  switch (error.kind) {
    case "relative-path": return `${where}path must be an absolute path`;
    case "blank-reason": return `${where}reason must be a non-empty string`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}

type EntryParse = Readonly<{ ok: true; value: IgnoredProject }> | Readonly<{ ok: false; error: string }>;

const parseEntry = (raw: unknown, index: number): EntryParse => {
  const where = `ignore[${index}]`;
  if (!isRecord(raw)) return { ok: false, error: `${where} must be an object { path, reason }` };
  const unknownKeys = Object.keys(raw).filter((key) => key !== "path" && key !== "reason");
  if (unknownKeys.length > 0) return { ok: false, error: `${where} has unknown key '${unknownKeys[0]}'` };
  const refuse = (error: IgnoredProjectError): EntryParse => ({ ok: false, error: describeIgnoredProjectError(error, `${where}.`) });
  const { path, reason } = raw;
  // A field of the wrong type is refused in the words a relative or blank value is.
  if (typeof path !== "string") return refuse({ kind: "relative-path", path: String(path) });
  if (typeof reason !== "string") return refuse({ kind: "blank-reason" });
  const entry = ignoredProject(path, reason);
  return entry.ok ? entry : refuse(entry.error);
};

/** Parse the document `{ "ignore": [{ path, reason }] }`, strictly: the first
 *  refused entry, in order, refuses the list. */
export function parseCoverageIgnoreList(raw: unknown): IgnoreListParse {
  if (!isRecord(raw) || !Array.isArray(raw.ignore)) return { ok: false, error: "expected { \"ignore\": [{ path, reason }] }" };
  const unknownKeys = Object.keys(raw).filter((key) => key !== "ignore");
  if (unknownKeys.length > 0) return { ok: false, error: `unknown key '${unknownKeys[0]}'` };
  const entries: readonly unknown[] = raw.ignore;
  const list: IgnoredProject[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseEntry(entry, index);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    list.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(list) };
}

export const isIgnored = (list: CoverageIgnoreList, projectRoot: string): boolean =>
  list.some((entry) => entry.path === projectRoot);

export const withoutIgnored = (list: CoverageIgnoreList, path: string): CoverageIgnoreList =>
  Object.freeze(list.filter((entry) => entry.path !== path));

/** The list with `entry` ignored, replacing an earlier entry for its path. */
export const withIgnored = (list: CoverageIgnoreList, entry: IgnoredProject): CoverageIgnoreList =>
  Object.freeze([...withoutIgnored(list, entry.path), entry]);

export const renderCoverageIgnoreList = (list: CoverageIgnoreList): string =>
  `${JSON.stringify({ ignore: list }, null, 2)}\n`;
