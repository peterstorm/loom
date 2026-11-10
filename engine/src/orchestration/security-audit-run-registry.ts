/**
 * The security-audit run registry (ADR-0067 D6): which directories are audit
 * runs, recorded by every writing `helper security-audit` operation (and by
 * `security-verification` start and resume) and read by the subagent write
 * guard, so the guard never has to trust a command line to learn where a
 * run's authority files live.
 *
 * Layout: one entry file per run in the protected entry store
 * `PERSISTENT_SUBAGENT_STORES.securityAuditRunRegistry` (inside the protected
 * `subagentDir()`), named by the SHA-256 of the canonical run directory and
 * holding exactly that directory (a run is registered under every spelling it
 * has — as spelled and its realpath). One file per entry, rather than one
 * shared list, makes registration a single exclusive publish: two runs started
 * at once can never lose each other's entry to a read-modify-write race, and
 * the synchronous API needs no lock. Registering the same directory again
 * finds its own entry and succeeds (idempotent).
 *
 * The no-follow, exclusive-publication and fail-closed plumbing is the shared
 * `protected-entry-store.ts`; this module owns only the registration grammar.
 *
 * Reading fails CLOSED: a registry that exists but cannot be read, or holds an
 * entry that is not a well-formed registration bound to its own name, THROWS.
 * The guard treats a throw as "the run set is unknown" and refuses writes onto
 * any authority-shaped path, rather than reading an empty set and protecting
 * nothing.
 */

import { isAbsolute, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { PERSISTENT_SUBAGENT_STORES } from "../config";
import { sha256Hex } from "../core/digest";
import { observePathPresence } from "../utils/path-presence";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import type { AnchoredDirectory } from "../utils/no-follow-fs";
import {
  describeStoreError,
  isEntryName,
  listEntryNames,
  publishEntryOnce,
  readEntry,
  removeEntry,
  withExistingEntryStore,
  withWritableEntryStore,
} from "./protected-entry-store";

const STORE = PERSISTENT_SUBAGENT_STORES.securityAuditRunRegistry;

type Registration = Readonly<{
  schemaVersion: 1;
  kind: "security-audit-run-registration";
  runDirectory: string;
}>;

/** A registry is bounded too: past this many LIVE runs (entries whose
 *  directory still exists) the read fails closed. Exported for its test. */
export const MAXIMUM_ENTRIES = 4_096;
/** The hard bound on names one listing reads, live or vanished. */
const MAXIMUM_LISTED_NAMES = 4 * MAXIMUM_ENTRIES;

const entryName = (runDirectory: string): string => `${sha256Hex(runDirectory)}.json`;

const render = (runDirectory: string): string =>
  `${JSON.stringify({ schemaVersion: 1, kind: "security-audit-run-registration", runDirectory } satisfies Registration)}\n`;

/** The registration an entry's bytes hold, or the reason they are not one.
 *  The name must be the digest of the directory it holds, so an entry cannot
 *  be renamed to shadow another run's. */
function parseEntry(name: string, bytes: string): DomainResult<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch (error) {
    return failure(`registry entry ${name} is not JSON: ${describeStoreError(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure(`registry entry ${name} is not an object`);
  }
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "kind,runDirectory,schemaVersion") {
    return failure(`registry entry ${name} must hold exactly schemaVersion, kind and runDirectory`);
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "security-audit-run-registration") {
    return failure(`registry entry ${name} is not a schemaVersion 1 security-audit-run-registration`);
  }
  const runDirectory = record.runDirectory;
  if (typeof runDirectory !== "string" || !isAbsolute(runDirectory) || runDirectory.includes("\0")) {
    return failure(`registry entry ${name} must name an absolute run directory`);
  }
  if (entryName(runDirectory) !== name) {
    return failure(`registry entry ${name} does not match the run directory it names`);
  }
  return success(runDirectory);
}

/**
 * Every spelling a run directory is registered under: the path as the
 * operator spelled it (`resolve(out)`, normalised) AND its realpath, when they
 * differ (`/tmp/…` vs `/private/tmp/…`, a symlinked ancestor). The guard also
 * canonicalises the paths it judges, but registering both spellings means a
 * write named either way is known even when one spelling cannot be resolved
 * at decision time. Or why the directory cannot be registered.
 */
function runDirectorySpellings(runDirectory: string): DomainResult<readonly string[], string> {
  if (!isAbsolute(runDirectory)) {
    return failure(`security-audit run directory must be absolute: ${JSON.stringify(runDirectory)}`);
  }
  const spelled = resolve(runDirectory);
  try {
    const canonical = realpathSync.native(spelled);
    if (!statSync(canonical).isDirectory()) return failure(`security-audit run directory is not a directory: ${canonical}`);
    return success(canonical === spelled ? [canonical] : [spelled, canonical]);
  } catch (error) {
    return failure(`cannot resolve security-audit run directory ${runDirectory}: ${describeStoreError(error)}`);
  }
}

/** Does a registered run directory still exist? An unobservable one counts
 *  as existing: pruning or skipping it would protect less, never more. */
const runDirectoryGone = (runDirectory: string): boolean => observePathPresence(runDirectory).kind === "absent";

/**
 * Record `runDirectory` as a security-audit run. The directory must be
 * absolute and exist; it is stored under every spelling it has. Idempotent: an
 * entry already holding the same directory is success; an entry under the
 * same name holding anything else is a refusal (a damaged registry is
 * reported, never overwritten).
 */
export function registerSecurityAuditRun(runDirectory: string): DomainResult<void, string> {
  const spellings = runDirectorySpellings(runDirectory);
  if (!spellings.ok) return spellings;
  try {
    return withWritableEntryStore(STORE, (registry) => {
      pruneVanishedRuns(registry);
      for (const spelling of spellings.value) {
        const registered = publishRegistration(registry, spelling);
        if (!registered.ok) return registered;
      }
      return success(undefined);
    });
  } catch (error) {
    return failure(`cannot register security-audit run ${spellings.value.join(" / ")} in ${STORE.dir()}: ${describeStoreError(error)}`);
  }
}

/** Publish one spelling's entry, idempotently: an existing entry under the
 *  same name must be a well-formed registration, which binds it to exactly
 *  this directory. */
function publishRegistration(registry: AnchoredDirectory, runDirectory: string): DomainResult<void, string> {
  const name = entryName(runDirectory);
  const published = publishEntryOnce(registry, name, render(runDirectory));
  if (published.kind === "published") return success(undefined);
  const existing = parseEntry(name, published.text);
  return existing.ok ? success(undefined) : failure(`security-audit run registry is damaged: ${existing.error}`);
}

/**
 * Keep the registry inside its cap without failing closed on history: once it
 * holds `MAXIMUM_ENTRIES` entries, the entries of run directories that no
 * longer exist are removed (a deleted audit has nothing left to protect). The
 * registrar — the parent's CLI — prunes; the guard only reads. A malformed
 * entry is never pruned: it stays, and the reader keeps failing closed on it.
 */
function pruneVanishedRuns(registry: AnchoredDirectory): void {
  const names = listEntryNames(registry, MAXIMUM_LISTED_NAMES).filter(isEntryName);
  if (names.length < MAXIMUM_ENTRIES) return;
  for (const name of names) {
    const parsed = parseEntry(name, readEntry(registry, name));
    if (parsed.ok && runDirectoryGone(parsed.value)) removeEntry(registry, name);
  }
}

/**
 * Every registered run directory, sorted. A missing subagent dir or registry
 * is the empty set. THROWS when the registry exists but cannot be read, or
 * holds a malformed entry or an unexpected name — the caller must fail closed
 * on a throw, never treat it as "no runs".
 */
export function registeredSecurityAuditRuns(): readonly string[] {
  return withExistingEntryStore(STORE, (registry) => {
    const runs: string[] = [];
    for (const name of listEntryNames(registry, MAXIMUM_LISTED_NAMES)) {
      if (!isEntryName(name)) throw new Error(`security-audit run registry holds an unexpected entry ${JSON.stringify(name)}`);
      const parsed = parseEntry(name, readEntry(registry, name));
      if (!parsed.ok) throw new Error(`security-audit run registry is damaged: ${parsed.error}`);
      // A run directory that no longer exists protects nothing; it does not
      // count toward the cap (the registrar prunes it on its next write).
      if (!runDirectoryGone(parsed.value)) runs.push(parsed.value);
    }
    if (runs.length > MAXIMUM_ENTRIES) {
      throw new Error(`security-audit run registry holds ${runs.length} live runs, more than ${MAXIMUM_ENTRIES}`);
    }
    return Object.freeze(runs.sort());
  }, () => Object.freeze([]));
}
