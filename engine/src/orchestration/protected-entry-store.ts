/**
 * A protected entry store: an immutable, name-bound, no-follow directory of
 * `<sha256>.json` entries inside the protected `subagentDir()` (one of
 * `config.PERSISTENT_SUBAGENT_STORES`). The one adapter behind the
 * security-audit run registry and the capture attestation store, which keep
 * only their own grammar — how an entry is named and what its bytes must be.
 *
 * What every such store shares, owned here once:
 *
 *  - **No-follow.** The configured base (`subagentDir()`) is resolved once —
 *    the documented `/tmp` → `/private/tmp` tolerance — and every component
 *    below it is held to the strict no-symlink rule, so a planted symlink can
 *    neither redirect an entry nor substitute a forged one.
 *  - **Immutable, exclusive publication.** An entry is published by
 *    hard-linking a fully written prepared file, so a reader never sees a
 *    partial entry and an entry is never replaced. A publish that finds its
 *    name taken hands the existing bytes back for the store's grammar to judge
 *    (idempotent re-record, or a refusal).
 *  - **Name-bound entries.** Every entry is `<64 hex>.json`; what an
 *    interrupted publish leaves behind (`<entry>.claim-…`) is never an entry.
 *    The store's own parser binds the name to the content.
 *  - **Bounded.** One entry is at most `MAXIMUM_ENTRY_BYTES`; a listing reads
 *    at most the caller's bound of names.
 *  - **Fail-closed reads.** Opening an existing store THROWS when the subagent
 *    dir is unobservable or the store cannot be opened (a symlink in its place,
 *    dangling or not, included); only a subagent dir or store that is absent
 *    is the documented empty answer.
 */

import { subagentDir, type PersistentSubagentStore } from "../config";
import { observePathPresence } from "../utils/path-presence";
import {
  closeAnchoredDirectory,
  ensureDirectoryNoFollow,
  ensureResolvedBaseDirectory,
  listDirectoryNamesNoFollow,
  openChildDirectoryNoFollow,
  openDirectoryNoFollow,
  publishDirectoryFileExclusiveNoFollow,
  readDirectoryFileNoFollow,
  removeDirectoryFileNoFollow,
  resolveBaseDirectory,
  type AnchoredDirectory,
} from "../utils/no-follow-fs";

/** An entry is one short record. */
export const MAXIMUM_ENTRY_BYTES = 16 * 1024;

const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
/** What an interrupted exclusive publish leaves behind (`<entry>.claim-…`):
 *  never an entry, never authority, so a reader skips it. */
const CLAIM_LEFTOVER = /^[0-9a-f]{64}\.json\.claim-[A-Za-z0-9.-]+$/;

/** Is `name` an entry name (`<64 hex>.json`)? */
export const isEntryName = (name: string): boolean => ENTRY_NAME.test(name);

export const describeStoreError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function withAnchored<T>(directory: AnchoredDirectory, use: (directory: AnchoredDirectory) => T): T {
  try {
    return use(directory);
  } finally {
    closeAnchoredDirectory(directory);
  }
}

/** Open `store` for writing — the base resolved, the store created when
 *  absent, both no-follow — and run `use` over it. Throws on any I/O failure. */
export function withWritableEntryStore<T>(store: PersistentSubagentStore, use: (directory: AnchoredDirectory) => T): T {
  const storePath = `${ensureResolvedBaseDirectory(subagentDir())}/${store.entry}`;
  ensureDirectoryNoFollow(storePath);
  return withAnchored(openDirectoryNoFollow(storePath), use);
}

/**
 * Open an EXISTING `store` for reading and run `use` over it; `absent()` when
 * the subagent dir or the store does not exist. Absence of the store is read
 * from the anchored parent's own listing: any entry under that name — a
 * symlink, dangling or not, included — is opened no-follow and refused, never
 * treated as absent. THROWS when the subagent dir is unobservable or the store
 * cannot be opened.
 */
export function withExistingEntryStore<T>(
  store: PersistentSubagentStore,
  use: (directory: AnchoredDirectory) => T,
  absent: () => T,
): T {
  const presence = observePathPresence(subagentDir());
  if (presence.kind === "absent") return absent();
  if (presence.kind === "unknown") throw new Error(`cannot observe ${subagentDir()}: ${presence.cause}`);
  const directory = withAnchored(openDirectoryNoFollow(resolveBaseDirectory(subagentDir())), (parent) =>
    listDirectoryNamesNoFollow(parent).includes(store.entry) ? openChildDirectoryNoFollow(parent, store.entry) : null);
  return directory === null ? absent() : withAnchored(directory, use);
}

/** What publishing an entry found: it published, or the name already holds
 *  an entry (its exact text), for the store's grammar to judge. */
export type EntryPublication =
  | Readonly<{ kind: "published" }>
  | Readonly<{ kind: "exists"; text: string }>;

/** Publish `bytes` under `name` exactly once; an existing entry is never
 *  replaced, and its bytes are handed back. Throws on any other failure. */
export function publishEntryOnce(directory: AnchoredDirectory, name: string, bytes: string): EntryPublication {
  try {
    publishDirectoryFileExclusiveNoFollow(directory, name, bytes);
    return { kind: "published" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { kind: "exists", text: readEntry(directory, name) };
}

/** One entry's text, read no-follow and bounded. Throws when it cannot be read. */
export const readEntry = (directory: AnchoredDirectory, name: string): string =>
  readDirectoryFileNoFollow(directory, name, MAXIMUM_ENTRY_BYTES).toString("utf-8");

/** One entry's text, or null when NO entry has that name (ENOENT is the only
 *  absent answer). Throws on anything else — a symlink, an oversized or
 *  unreadable entry — so damage never reads as absence. */
export function readEntryIfPresent(directory: AnchoredDirectory, name: string): string | null {
  try {
    return readEntry(directory, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Every name in the store except an interrupted publish's leftovers, at most
 *  `maximumNames` of them (more throws). The caller judges each name with
 *  `isEntryName`. */
export const listEntryNames = (directory: AnchoredDirectory, maximumNames: number): readonly string[] =>
  listDirectoryNamesNoFollow(directory, maximumNames).filter((name) => !CLAIM_LEFTOVER.test(name));

/** Remove one entry; an entry already gone is success. */
export const removeEntry = (directory: AnchoredDirectory, name: string): void => removeDirectoryFileNoFollow(directory, name);
