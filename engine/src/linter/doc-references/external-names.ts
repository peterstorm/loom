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
import { resolveReference, type ReferenceFrame } from "./resolve";
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

/** Every listed name, to its group. The config parse refuses a name listed twice. */
export const externalNameIndex = (groups: readonly ExternalNameGroup[]): ExternalNameIndex =>
  new Map(groups.flatMap((group) => group.names.map((name) => [name, group] as const)));

/** Why a listed external name no longer earns its place. */
export type StaleExternalName = Readonly<{
  name: ExternalName;
  group: ExternalNameGroup;
  /** `unreferenced`: no governed document names it. `in-source`: the source corpus already resolves it. */
  why: "unreferenced" | "in-source";
}>;

/** A frame with no external names: what the source alone resolves. A word reference reads nothing else of a frame. */
const SOURCE_ONLY: ReferenceFrame = Object.freeze({ from: "", sourceRoots: [], externalNames: new Map() });

/** Does the source corpus already resolve the name, as the resolver decides a word reference written so? */
function resolvedBySource(name: ExternalName, index: ReferenceIndex): boolean {
  const reference = spanReference({ line: 0, text: name });
  return reference !== null && resolveReference(reference, SOURCE_ONLY, index).ok;
}

/**
 * The listed names that have decayed. `referenced` is the text of every word
 * reference the governed documents make, read over the whole project; a name
 * both unreferenced and held by the source is reported once, as unreferenced.
 */
export function staleExternalNames(
  groups: readonly ExternalNameGroup[],
  referenced: ReadonlySet<string>,
  index: ReferenceIndex,
): readonly StaleExternalName[] {
  return groups.flatMap((group) => group.names.flatMap((name): readonly StaleExternalName[] => {
    if (!referenced.has(name)) return [{ name, group, why: "unreferenced" }];
    return resolvedBySource(name, index) ? [{ name, group, why: "in-source" }] : [];
  }));
}

function assertNever(value: never): never {
  throw new Error(`unreachable external-name refusal: ${JSON.stringify(value)}`);
}
