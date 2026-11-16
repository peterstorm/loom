/**
 * External names — the words a project's documents name that its source never
 * spells: an OpenTelemetry attribute emitted at runtime, a Python scorer, a
 * Graph permission, a model id. A word
 * reference resolves only when the source corpus holds it, so without this list
 * such a name cannot be written as a code span at all, and its siblings end up
 * half backticked.
 *
 * `docReferences.externalNames` lists them in groups, each with the reason its
 * names live outside the source. A listed name is exact: it is shaped as the
 * extractor reads a word reference (`extract.ts`), and only a word reference
 * written exactly so resolves through it. Paths, links, spec ids and ADR ids
 * never do.
 *
 * Like every list that only subtracts, it reports its own decay on the full
 * run: a name no governed document references excuses nothing, and a name the
 * source already holds is not external.
 *
 * Pure: strings in, names, an index and stale entries out.
 */

import { spanReference } from "./extract";
import { resolveWordInSource } from "./resolve";
import type { ExternalName, ExternalNameGroup, ExternalNameIndex, ReferenceIndex } from "./types";

/** Why a configured string is not an external name. */
export type ExternalNameRefusal =
  /** A glob or wildcard: an external name is exact. */
  | Readonly<{ kind: "pattern"; raw: string }>
  /** Whitespace: a code span holding it is a fragment, never a reference. */
  | Readonly<{ kind: "whitespace"; raw: string }>
  /** Not a word or dotted path as the rule reads one: a path, a file name, a call, a placeholder or another document's id. */
  | Readonly<{ kind: "not-a-word"; raw: string }>;

export type ExternalNameParse =
  | Readonly<{ ok: true; value: ExternalName }>
  | Readonly<{ ok: false; error: ExternalNameRefusal }>;

/** The characters of a glob or a regular-expression wildcard. */
const PATTERN = /[*?[\]{}]/;

/**
 * A configured string as an external name: exactly a word or dotted path the
 * extractor reads as a word reference, so that some document could name it.
 * A call (`name()`) is refused: the list names the word, not one spelling of it.
 */
export function parseExternalName(raw: string): ExternalNameParse {
  if (PATTERN.test(raw)) return { ok: false, error: { kind: "pattern", raw } };
  if (/\s/.test(raw)) return { ok: false, error: { kind: "whitespace", raw } };
  const reference = spanReference({ line: 0, text: raw });
  return reference?.kind === "token" && !raw.endsWith("()")
    ? { ok: true, value: raw as ExternalName }
    : { ok: false, error: { kind: "not-a-word", raw } };
}

/** One sentence: why the string is refused. */
export function describeExternalNameRefusal(refusal: ExternalNameRefusal): string {
  switch (refusal.kind) {
    case "pattern":
      return `'${refusal.raw}' is a pattern — an external name is one exact word or dotted path`;
    case "whitespace":
      return `'${refusal.raw}' holds whitespace — an external name is one word or dotted path`;
    case "not-a-word":
      return `'${refusal.raw}' is not a word or dotted path the rule reads as a reference (a path, file name, call, placeholder or document id never resolves through this list)`;
    default:
      return assertNever(refusal);
  }
}

/** Why groups do not make an index: a name listed twice, in one group or two. */
export type ExternalNameIndexRefusal = Readonly<{ kind: "listed-twice"; name: ExternalName }>;

export type ExternalNameIndexing =
  | Readonly<{ ok: true; value: ExternalNameIndex }>
  | Readonly<{ ok: false; error: ExternalNameIndexRefusal }>;

/**
 * The groups as an index: every listed name to its one group. The only way to
 * mint an `ExternalNameIndex`, so no index holds a name twice — the config
 * parse builds the scope's one index here.
 */
export function externalNameIndex(groups: readonly ExternalNameGroup[]): ExternalNameIndexing {
  const byName = new Map<string, ExternalNameGroup>();
  for (const group of groups) {
    for (const name of group.names) {
      if (byName.has(name)) return { ok: false, error: { kind: "listed-twice", name } };
      byName.set(name, group);
    }
  }
  return { ok: true, value: minted(groups, byName) };
}

/** The brand, stamped where the invariant was just checked — `externalNameIndex`, and the empty index. */
function minted(groups: readonly ExternalNameGroup[], byName: ReadonlyMap<string, ExternalNameGroup>): ExternalNameIndex {
  const index: Omit<ExternalNameIndex, "__brand"> = Object.freeze({ groups: Object.freeze([...groups]), byName });
  return index as ExternalNameIndex;
}

/** A scope with no external names: the source alone resolves a word. */
export const NO_EXTERNAL_NAMES: ExternalNameIndex = minted([], new Map());

/** Why a listed external name no longer earns its place. */
export type StaleExternalName = Readonly<{
  name: ExternalName;
  group: ExternalNameGroup;
  /** `unreferenced`: no governed document names it. `in-source`: the source corpus already resolves it. */
  why: "unreferenced" | "in-source";
}>;

/** Does the source corpus already resolve the name, as the resolver decides a word reference written so? */
function resolvedBySource(name: ExternalName, index: ReferenceIndex): boolean {
  const reference = spanReference({ line: 0, text: name });
  return reference?.kind === "token" && resolveWordInSource(reference, index).ok;
}

/**
 * What the governed files reference, as the decay check reads it: every word
 * reference they make, or `withheld` when some governed file could not be
 * read — a name only that file uses would look unreferenced, so no name is
 * judged unreferenced.
 */
export type ReferencedWords =
  | Readonly<{ kind: "read"; words: ReadonlySet<string> }>
  | Readonly<{ kind: "withheld" }>;

/**
 * The listed names that have decayed. A name both unreferenced and held by
 * the source is reported once, as unreferenced; while `referenced` is
 * withheld, only the names the source already resolves are reported.
 */
export function staleExternalNames(
  names: ExternalNameIndex,
  referenced: ReferencedWords,
  index: ReferenceIndex,
): readonly StaleExternalName[] {
  return names.groups.flatMap((group) => group.names.flatMap((name): readonly StaleExternalName[] => {
    if (referenced.kind === "read" && !referenced.words.has(name)) return [{ name, group, why: "unreferenced" }];
    return resolvedBySource(name, index) ? [{ name, group, why: "in-source" }] : [];
  }));
}

function assertNever(value: never): never {
  throw new Error(`unreachable external-name refusal: ${JSON.stringify(value)}`);
}
