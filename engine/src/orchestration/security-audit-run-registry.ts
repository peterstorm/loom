/**
 * The security-audit run registry (ADR-0065 D6): which directories are audit
 * runs, recorded by every writing `helper security-audit` operation and read by the subagent
 * write guard, so the guard never has to trust a command line to learn where a
 * run's authority files live.
 *
 * Layout: one entry file per run under `securityAuditRunRegistryDir()` (inside
 * the protected `subagentDir()`), named by the SHA-256 of the canonical run
 * directory and holding exactly that directory (a run is registered under
 * every spelling it has — as spelled and its realpath). One file per entry, rather than
 * one shared list, makes registration a single exclusive publish: two runs
 * started at once can never lose each other's entry to a read-modify-write
 * race, and the synchronous API needs no lock. Registering the same directory
 * again finds its own entry and succeeds (idempotent).
 *
 * Every path is handled no-follow: the configured base is resolved once (the
 * documented `/tmp` → `/private/tmp` tolerance), and every component below it
 * is held to the strict no-symlink rule, so a planted symlink cannot redirect
 * an entry or substitute a forged one.
 *
 * Reading fails CLOSED: a registry that exists but cannot be read, or holds an
 * entry that is not a well-formed registration bound to its own name, THROWS.
 * The guard treats a throw as "the run set is unknown" and refuses writes onto
 * any authority-shaped path, rather than reading an empty set and protecting
 * nothing.
 */

import { isAbsolute, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { securityAuditRunRegistryDir, subagentDir, SECURITY_AUDIT_RUN_REGISTRY_ENTRY } from "../config";
import { sha256Hex } from "../core/digest";
import { observePathPresence } from "../utils/path-presence";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
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
} from "./no-follow-fs";

type Registration = Readonly<{
  schemaVersion: 1;
  kind: "security-audit-run-registration";
  runDirectory: string;
}>;

/** An entry is bounded: a registration is one short path. */
const MAXIMUM_ENTRY_BYTES = 16 * 1024;
/** A registry is bounded too: past this many LIVE runs (entries whose
 *  directory still exists) the read fails closed. Exported for its test. */
export const MAXIMUM_ENTRIES = 4_096;
/** The hard bound on names one listing reads, live or vanished. */
const MAXIMUM_LISTED_NAMES = 4 * MAXIMUM_ENTRIES;

const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
/** What an interrupted exclusive publish leaves behind (`<entry>.claim-…`):
 *  never an entry, never authority, so a reader skips it. */
const CLAIM_LEFTOVER = /^[0-9a-f]{64}\.json\.claim-[A-Za-z0-9.-]+$/;

const entryName = (runDirectory: string): string => `${sha256Hex(runDirectory)}.json`;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
    return failure(`registry entry ${name} is not JSON: ${describe(error)}`);
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
    return failure(`cannot resolve security-audit run directory ${runDirectory}: ${describe(error)}`);
  }
}

/** Does a registered run directory still exist? An unobservable one counts
 *  as existing: pruning or skipping it would protect less, never more. */
const runDirectoryGone = (runDirectory: string): boolean => observePathPresence(runDirectory).kind === "absent";

function withRegistryDirectory<T>(open: () => AnchoredDirectory, use: (registry: AnchoredDirectory) => T): T {
  const registry = open();
  try {
    return use(registry);
  } finally {
    closeAnchoredDirectory(registry);
  }
}

/**
 * Record `runDirectory` as a security-audit run. The directory must be
 * absolute and exist; it is stored realpath-normalised. Idempotent: an entry
 * already holding the same directory is success; an entry under the same name
 * holding anything else is a refusal (a damaged registry is reported, never
 * overwritten).
 */
export function registerSecurityAuditRun(runDirectory: string): DomainResult<void, string> {
  const spellings = runDirectorySpellings(runDirectory);
  if (!spellings.ok) return spellings;
  try {
    const base = ensureResolvedBaseDirectory(subagentDir());
    const registryPath = `${base}/${SECURITY_AUDIT_RUN_REGISTRY_ENTRY}`;
    ensureDirectoryNoFollow(registryPath);
    return withRegistryDirectory(() => openDirectoryNoFollow(registryPath), (registry) => {
      pruneVanishedRuns(registry);
      for (const spelling of spellings.value) {
        const registered = publishEntry(registry, spelling);
        if (!registered.ok) return registered;
      }
      return success(undefined);
    });
  } catch (error) {
    return failure(`cannot register security-audit run ${spellings.value.join(" / ")} in ${securityAuditRunRegistryDir()}: ${describe(error)}`);
  }
}

/** Publish one spelling's entry, idempotently: an existing entry under the
 *  same name must hold exactly this directory. */
function publishEntry(registry: AnchoredDirectory, runDirectory: string): DomainResult<void, string> {
  const name = entryName(runDirectory);
  try {
    publishDirectoryFileExclusiveNoFollow(registry, name, render(runDirectory));
    return success(undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const existing = parseEntry(name, readDirectoryFileNoFollow(registry, name, MAXIMUM_ENTRY_BYTES).toString("utf-8"));
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
  const names = listDirectoryNamesNoFollow(registry, MAXIMUM_LISTED_NAMES).filter((name) => ENTRY_NAME.test(name));
  if (names.length < MAXIMUM_ENTRIES) return;
  for (const name of names) {
    const parsed = parseEntry(name, readDirectoryFileNoFollow(registry, name, MAXIMUM_ENTRY_BYTES).toString("utf-8"));
    if (parsed.ok && runDirectoryGone(parsed.value)) removeDirectoryFileNoFollow(registry, name);
  }
}

/**
 * Every registered run directory, sorted. A missing subagent dir or registry
 * is the empty set. THROWS when the registry exists but cannot be read, or
 * holds a malformed entry or an unexpected name — the caller must fail closed
 * on a throw, never treat it as "no runs".
 */
export function registeredSecurityAuditRuns(): readonly string[] {
  const presence = observePathPresence(subagentDir());
  if (presence.kind === "absent") return Object.freeze([]);
  if (presence.kind === "unknown") throw new Error(`cannot observe ${subagentDir()}: ${presence.cause}`);
  // Absence of the registry is read from the anchored parent's own listing:
  // any entry under that name — a symlink, dangling or not, included — is
  // opened no-follow below, and a symlink is refused rather than treated as
  // "no runs".
  const parent = openDirectoryNoFollow(resolveBaseDirectory(subagentDir()));
  let registry: AnchoredDirectory;
  try {
    if (!listDirectoryNamesNoFollow(parent).includes(SECURITY_AUDIT_RUN_REGISTRY_ENTRY)) return Object.freeze([]);
    registry = openChildDirectoryNoFollow(parent, SECURITY_AUDIT_RUN_REGISTRY_ENTRY);
  } finally {
    closeAnchoredDirectory(parent);
  }
  return withRegistryDirectory(() => registry, (anchored) => {
    const runs: string[] = [];
    for (const name of listDirectoryNamesNoFollow(anchored, MAXIMUM_LISTED_NAMES)) {
      if (CLAIM_LEFTOVER.test(name)) continue;
      if (!ENTRY_NAME.test(name)) throw new Error(`security-audit run registry holds an unexpected entry ${JSON.stringify(name)}`);
      const parsed = parseEntry(name, readDirectoryFileNoFollow(anchored, name, MAXIMUM_ENTRY_BYTES).toString("utf-8"));
      if (!parsed.ok) throw new Error(`security-audit run registry is damaged: ${parsed.error}`);
      // A run directory that no longer exists protects nothing; it does not
      // count toward the cap (the registrar prunes it on its next write).
      if (!runDirectoryGone(parsed.value)) runs.push(parsed.value);
    }
    if (runs.length > MAXIMUM_ENTRIES) {
      throw new Error(`security-audit run registry holds ${runs.length} live runs, more than ${MAXIMUM_ENTRIES}`);
    }
    return Object.freeze(runs.sort());
  });
}
