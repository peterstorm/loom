/**
 * The doc-reference contract: what a governed file references, why a
 * reference dangles, and the project a reference is resolved against.
 *
 * `no-dangling-doc-reference` holds every backticked reference in a governed
 * document or code comment to the project as it is: a path names a file or
 * directory, an anchor names a heading, a symbol or string occurs in the
 * source, a plan's spec ids are in its spec, an ADR id names an ADR. The
 * extractor (`extract.ts`) yields `DocReference`s from text, the resolver
 * (`resolve.ts`) decides each against a `ReferenceIndex`, and the index
 * (`reference-index.ts`) is built from a `ProjectSnapshot` — the one port, with
 * the filesystem adapter in `project-snapshot.ts` and an in-memory fake in the
 * tests.
 *
 * Pure: types and constructors only.
 */

import type { ReasonedPath } from "../types";

/** How a governed file is read. */
export type DocReading =
  /** A Markdown document: every path, anchor, link, token and ADR id. */
  | "document"
  /** A plan: its spec header, the spec ids it cites and ADR ids — never paths or tokens, which name what is not built yet. */
  | "plan"
  /** A source file: the backticked spans and ADR ids in its comments. */
  | "source-comments";

/**
 * One reference a governed file makes, at its 1-based line. `text` is the
 * reference as written: the baseline key and the violation quote it.
 */
export type DocReference =
  /** A backticked path (it holds a `/`, or names a Markdown file with a `#` anchor). Resolved in the referring file's directory, each directory above it, then each source root. */
  | Readonly<{ kind: "path"; line: number; text: string; path: string; directory: boolean; anchor: string | null }>
  /** A backticked bare file name (`ledger.json`): a file in one of the path frames, or a name the source text holds. */
  | Readonly<{ kind: "file-name"; line: number; text: string; name: string }>
  /** A Markdown link target. Resolved against the referring file's directory (or the root, for `/…`); an empty path is the document itself. */
  | Readonly<{ kind: "link"; line: number; text: string; path: string; anchor: string | null }>
  /** A backticked symbol, call (`name()`) or dotted path (`a.b.c`): each segment is held by the source text. */
  | Readonly<{ kind: "token"; line: number; text: string; segments: readonly [string, ...string[]] }>
  /** A plan's `**Spec:**` header: the spec file must exist and parse. */
  | Readonly<{ kind: "spec"; line: number; text: string; path: string }>
  /** An `FR-` / `AS-` / `OOS-` id a plan cites: its spec must define it. */
  | Readonly<{ kind: "spec-id"; line: number; text: string; spec: string }>
  /** An `ADR-NNNN` id: an ADR file must carry that number. */
  | Readonly<{ kind: "adr"; line: number; text: string }>;

/** Why a reference resolves to nothing. Closed: the rule's message and the tests cover every arm. */
export type DanglingReason =
  /** An absolute path: it names one machine's checkout, never a file of the project as every clone has it. */
  | Readonly<{ kind: "absolute-path"; path: string }>
  | Readonly<{ kind: "no-such-path"; tried: readonly string[] }>
  | Readonly<{ kind: "no-such-heading"; target: string; anchor: string }>
  | Readonly<{ kind: "not-in-source"; missing: readonly string[] }>
  | Readonly<{ kind: "spec-missing"; tried: readonly string[] }>
  | Readonly<{ kind: "spec-unreadable"; spec: string; detail: string }>
  | Readonly<{ kind: "id-not-in-spec"; spec: string }>
  | Readonly<{ kind: "no-such-adr"; directory: string }>;

/** What a reference resolved to. */
export type Resolved =
  /** A file or directory, at its project-relative path. */
  | Readonly<{ via: "entry"; path: string }>
  /** The source text holds every segment. */
  | Readonly<{ via: "source" }>
  /** The spec defines the id, or the spec header names a spec that parses. */
  | Readonly<{ via: "spec"; spec: string }>
  /** The plan's spec is missing or unreadable: its header reference already fails, so the id is not judged twice. */
  | Readonly<{ via: "spec-unavailable"; spec: string }>
  /** An ADR file carries the id. */
  | Readonly<{ via: "adr" }>;

/** A file or directory in the project, or nothing. */
export type EntryKind = "file" | "directory";

/**
 * The project as the index reads it — the one port. Paths are
 * project-relative and forward-slashed.
 */
export type ProjectSnapshot = Readonly<{
  /** Every file of the project walk (the directories that never hold source skipped), sorted. */
  files: () => readonly string[];
  /** Whatever is at a path — also beneath the directories the walk skips — or null. */
  entryAt: (path: string) => EntryKind | null;
  /** A file's text, or null when it is not a readable file. */
  read: (path: string) => string | null;
}>;

/** A plan's spec, as the index read it. */
export type SpecIds =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unreadable"; detail: string }>
  | Readonly<{ kind: "read"; ids: ReadonlySet<string> }>;

/**
 * Everything a reference is resolved against. Each member is answered from
 * the snapshot on first use and remembered, so a lint run that resolves no
 * token never reads the source corpus.
 */
export type ReferenceIndex = Readonly<{
  entryAt: (path: string) => EntryKind | null;
  /** The anchors a Markdown file defines: its heading slugs and its HTML `id`/`name` anchors. Empty when it is not a file. */
  anchorsOf: (path: string) => ReadonlySet<string>;
  /** Does the source text hold this word? */
  inSource: (word: string) => boolean;
  specOf: (path: string) => SpecIds;
  /** Every `ADR-NNNN` an ADR file carries. */
  adrIds: () => ReadonlySet<string>;
}>;

/** The directory an `ADR-NNNN` id resolves in. */
export const ADR_DIRECTORY = "docs/adr";

/**
 * One project's doc-reference scope, parsed from `config.json`
 * (`docReferences`). Absent, the rule governs nothing.
 */
export type DocReferenceScope = Readonly<{
  /** Documents and source files whose references must resolve in full. */
  govern: readonly [ReasonedPath, ...ReasonedPath[]];
  /** Plans: only their spec header, spec ids and ADR ids are resolved. */
  plans: readonly ReasonedPath[];
  /** Trees inside `govern` or `plans` that are not governed: vendored text, framework guidance. */
  exclude: readonly ReasonedPath[];
  /** Directories a path may also be written relative to (`engine/src`), after the referring file's directory and the root. */
  sourceRoots: readonly string[];
}>;
