/**
 * Claude implementation-attempt correlation sidecars.
 *
 * One exact schema and one no-follow filesystem adapter own the complete
 * lifecycle: atomic publication at SubagentStart, snapshot before cleanup at
 * SubagentStop, and exact removal during cleanup/rollback.
 */

import { randomUUID } from "node:crypto";
import { linkSync, unlinkSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { subagentDir } from "./config";
import {
  anchoredChildPath,
  closeAnchorGuarded,
  ensureResolvedBaseDirectory,
  openDirectoryNoFollow,
  readDirectoryFileNoFollow,
  removeDirectoryFileNoFollow,
  resolveBaseDirectory,
  writeDirectoryFileExclusiveNoFollow,
  type AnchoredDirectory,
} from "./orchestration/no-follow-fs";
import {
  parseImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "./core/implementation-completion";
import {
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  parseReportedAgentId,
  parseSessionId,
  type AgentId,
  type SessionId,
} from "./machine";

export type ClaudeImplementationAttemptSidecar = Readonly<{
  schemaVersion: 1;
  kind: "claude-implementation-attempt-sidecar";
  sessionId: SessionId;
  agentId: AgentId;
  canonicalTaskGraphPath: string;
  authority: ImplementationAttemptAuthority;
}>;

export type ImplementationAuthorityObservation =
  | Readonly<{
      kind: "authority-observed";
      sidecar: ClaudeImplementationAttemptSidecar;
    }>
  | Readonly<{
      kind: "authority-unavailable";
      failure: Readonly<{
        kind: "missing-sidecar" | "malformed-sidecar" | "unreadable-sidecar" | "invalid-sidecar-identity";
        message: string;
      }>;
    }>;

const exactKeys = (raw: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Reflect.ownKeys(raw);
  return keys.length === expected.length && keys.every((key) =>
    typeof key === "string" && expected.includes(key));
};

type SidecarIdentity = Readonly<{ sessionId: SessionId; agentId: AgentId }>;

function parsedIdentity(
  rawSessionId: unknown,
  rawAgentId: unknown,
): SidecarIdentity | null {
  const sessionId = typeof rawSessionId === "string" ? parseSessionId(rawSessionId) : null;
  const agentId = typeof rawAgentId === "string" ? parseReportedAgentId(rawAgentId) : null;
  return sessionId !== null && agentId !== null ? Object.freeze({ sessionId, agentId }) : null;
}

function canonicalStoredPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !isAbsolute(raw) || resolve(raw) !== raw) return null;
  return raw;
}

export function parseClaudeImplementationAttemptSidecar(
  raw: unknown,
): Readonly<{ ok: true; value: ClaudeImplementationAttemptSidecar }> |
  Readonly<{ ok: false; error: string }> {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "implementation sidecar must be a plain object" };
    }
    const record = raw as Record<string, unknown>;
    if (!exactKeys(record, [
      "schemaVersion", "kind", "sessionId", "agentId", "canonicalTaskGraphPath", "authority",
    ])) {
      return { ok: false, error: "implementation sidecar must contain exactly schemaVersion/kind/sessionId/agentId/canonicalTaskGraphPath/authority" };
    }
    if (record.schemaVersion !== 1 || record.kind !== "claude-implementation-attempt-sidecar") {
      return { ok: false, error: "implementation sidecar tag is invalid" };
    }
    const identity = parsedIdentity(record.sessionId, record.agentId);
    if (identity === null) return { ok: false, error: "implementation sidecar sessionId/agentId is invalid" };
    const graphPath = canonicalStoredPath(record.canonicalTaskGraphPath);
    if (graphPath === null) return { ok: false, error: "implementation sidecar TaskGraph path is not canonical absolute syntax" };
    const authority = parseImplementationAttemptAuthority(record.authority);
    if (!authority.ok) return { ok: false, error: authority.error.errors.join("; ") };
    return {
      ok: true,
      value: Object.freeze({
        schemaVersion: 1,
        kind: "claude-implementation-attempt-sidecar",
        ...identity,
        canonicalTaskGraphPath: graphPath,
        authority: authority.value,
      }),
    };
  } catch (error) {
    return { ok: false, error: `implementation sidecar could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function sidecarLeaf(identity: SidecarIdentity): string {
  return `${identity.sessionId}.${Buffer.from(identity.agentId, "utf8").toString("hex")}${IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX}`;
}

export function implementationAttemptSidecarLeaf(
  rawSessionId: string,
  rawAgentId: string,
): string | null {
  const identity = parsedIdentity(rawSessionId, rawAgentId);
  return identity === null ? null : sidecarLeaf(identity);
}

function canonicalTaskGraphPath(path: string): string {
  const canonical = realpathSync.native(path);
  if (!isAbsolute(canonical) || resolve(canonical) !== canonical) {
    throw new Error(`TaskGraph path did not resolve canonically: ${path}`);
  }
  return canonical;
}

export type SidecarPublicationOperations = Readonly<{
  writeStaged: (leaf: string, bytes: Buffer) => void;
  publishNoReplace: (stagedLeaf: string, liveLeaf: string) => void;
  readLive: (leaf: string) => Buffer;
  removeStaged: (leaf: string) => void;
}>;

function sidecarPublicationOperations(
  anchored: AnchoredDirectory,
): SidecarPublicationOperations {
  return Object.freeze({
    writeStaged: (leaf, bytes) => writeDirectoryFileExclusiveNoFollow(anchored, leaf, bytes),
    publishNoReplace: (stagedLeaf, liveLeaf) => {
      // link(2) is atomic and never replaces an existing destination. Unlike
      // rename(2), a racing different authority cannot overwrite the live key.
      linkSync(anchoredChildPath(anchored, stagedLeaf), anchoredChildPath(anchored, liveLeaf));
    },
    readLive: (leaf) => readDirectoryFileNoFollow(anchored, leaf),
    removeStaged: (leaf) => unlinkSync(anchoredChildPath(anchored, leaf)),
  });
}

/**
 * A staged-temporary cleanup that failed after the live sidecar was already
 * published. `code` carries the errno where one exists so callers can
 * distinguish a benign ENOENT race from real corruption.
 */
export type SidecarCleanupFailure = Readonly<{ message: string; code: string | undefined }>;

export type SidecarPublicationResult = Readonly<{
  disposition: "published" | "already-owned";
  cleanupFailure: SidecarCleanupFailure | null;
}>;;

export function publishSidecarBytes(
  leaf: string,
  bytes: Buffer,
  operations: SidecarPublicationOperations,
): SidecarPublicationResult {
  const staged = `${leaf}.tmp-${randomUUID()}`;
  let stagedPresent = false;
  let primaryError: unknown = null;
  let disposition: "published" | "already-owned" = "published";
  try {
    operations.writeStaged(staged, bytes);
    stagedPresent = true;
    try {
      operations.publishNoReplace(staged, leaf);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = operations.readLive(leaf);
      if (!existing.equals(bytes)) {
        throw new Error(`implementation sidecar ${leaf} already binds different bytes`);
      }
      disposition = "already-owned";
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown = null;
  if (stagedPresent) {
    try {
      operations.removeStaged(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
  }
  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `implementation sidecar ${leaf} publication and temporary-file cleanup both failed`,
    );
  }
  if (primaryError !== null) throw primaryError;
  return Object.freeze({
    disposition,
    cleanupFailure: cleanupError === null
      ? null
      : Object.freeze({
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          code: (cleanupError as NodeJS.ErrnoException).code,
        }),
  });
}

type PublishedImplementationSidecar = Readonly<{
  sidecar: ClaudeImplementationAttemptSidecar;
  disposition: "published" | "already-owned";
  cleanupFailure: SidecarCleanupFailure | null;
}>;

export function publishImplementationAttemptSidecar(args: Readonly<{
  sessionId: string;
  agentId: string;
  taskGraphPath: string;
  authority: unknown;
}>): PublishedImplementationSidecar {
  const identity = parsedIdentity(args.sessionId, args.agentId);
  if (identity === null) throw new Error("cannot publish implementation sidecar for invalid session/agent identity");
  const authority = parseImplementationAttemptAuthority(args.authority);
  if (!authority.ok) throw new Error(authority.error.errors.join("; "));
  const sidecar = Object.freeze({
    schemaVersion: 1 as const,
    kind: "claude-implementation-attempt-sidecar" as const,
    ...identity,
    canonicalTaskGraphPath: canonicalTaskGraphPath(args.taskGraphPath),
    authority: authority.value,
  });
  const parsed = parseClaudeImplementationAttemptSidecar(sidecar);
  if (!parsed.ok) throw new Error(parsed.error);

  // The subagent directory is the BASE: its configured path may traverse a
  // system symlink (macOS resolves `/tmp` to `/private/tmp`), so it is resolved
  // once here — the same reason `registerSessionRunBinding` resolves its base.
  // Every anchored open BELOW the resolved base is still held to the strict
  // no-symlink rule by the anchored primitives.
  const directory = ensureResolvedBaseDirectory(subagentDir());
  const anchored = openDirectoryNoFollow(directory);
  const leaf = sidecarLeaf(identity);
  let publication: PublishedImplementationSidecar | null = null;
  let primaryError: unknown = null;
  try {
    publication = Object.freeze({
      sidecar: parsed.value,
      ...publishSidecarBytes(
        leaf,
        Buffer.from(`${JSON.stringify(parsed.value)}\n`, "utf8"),
        sidecarPublicationOperations(anchored),
      ),
    });
  } catch (error) {
    primaryError = error;
  }
  const closeOutcome = closeAnchorGuarded(anchored, primaryError, `publication of implementation sidecar ${leaf}`);
  if (closeOutcome !== null) throw closeOutcome;
  if (publication === null) throw new Error(`publication of implementation sidecar ${leaf} produced no result`);
  return publication;
}

const unavailable = (
  kind: Extract<ImplementationAuthorityObservation, { kind: "authority-unavailable" }>["failure"]["kind"],
  message: string,
): ImplementationAuthorityObservation => Object.freeze({
  kind: "authority-unavailable",
  failure: Object.freeze({ kind, message }),
});

/**
 * Observe one anchored sidecar leaf. Total over its inputs: every failure the
 * body can observe is returned as an `authority-unavailable` observation, so
 * the caller only owes the anchor close.
 */
function observeAnchoredSidecarAuthority(
  anchored: AnchoredDirectory,
  identity: SidecarIdentity,
  leaf: string,
): ImplementationAuthorityObservation {
  let bytes: Buffer;
  try {
    bytes = readDirectoryFileNoFollow(anchored, leaf);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? unavailable("missing-sidecar", `implementation sidecar ${leaf} is absent`)
      : unavailable("unreadable-sidecar", `cannot read implementation sidecar ${leaf}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return unavailable("malformed-sidecar", `implementation sidecar JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseClaudeImplementationAttemptSidecar(raw);
  if (!parsed.ok) return unavailable("malformed-sidecar", parsed.error);
  if (parsed.value.sessionId !== identity.sessionId || parsed.value.agentId !== identity.agentId) {
    return unavailable("malformed-sidecar", "implementation sidecar identity does not match its filename key");
  }
  try {
    if (canonicalTaskGraphPath(parsed.value.canonicalTaskGraphPath) !== parsed.value.canonicalTaskGraphPath) {
      return unavailable("malformed-sidecar", "implementation sidecar TaskGraph path is not canonical");
    }
  } catch (error) {
    return unavailable("unreadable-sidecar", `implementation sidecar TaskGraph path is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({ kind: "authority-observed", sidecar: parsed.value });
}

export function snapshotImplementationAttemptSidecar(
  rawSessionId: string,
  rawAgentId: string,
): ImplementationAuthorityObservation {
  const identity = parsedIdentity(rawSessionId, rawAgentId);
  if (identity === null) {
    return unavailable("invalid-sidecar-identity", "SubagentStop session/agent identity cannot name an implementation sidecar");
  }
  const leaf = sidecarLeaf(identity);
  let anchored;
  try {
    // Absent base is the one absent answer and propagates ENOENT from the
    // resolve; the directory is inspected, never created, on this path.
    anchored = openDirectoryNoFollow(resolveBaseDirectory(subagentDir()));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? unavailable("missing-sidecar", "implementation sidecar directory is absent")
      : unavailable("unreadable-sidecar", `cannot open implementation sidecar directory without following links: ${error instanceof Error ? error.message : String(error)}`);
  }
  let observation: ImplementationAuthorityObservation | null = null;
  let primaryError: unknown = null;
  try {
    observation = observeAnchoredSidecarAuthority(anchored, identity, leaf);
  } catch (error) {
    primaryError = error;
  }
  const closeOutcome = closeAnchorGuarded(anchored, primaryError, `snapshot of implementation sidecar ${leaf}`);
  if (closeOutcome !== null) throw closeOutcome;
  // Unreachable while the observation body stays total over its inputs.
  if (observation === null) throw new Error(`snapshot of implementation sidecar ${leaf} produced no observation`);
  return observation;
}

export function removeImplementationAttemptSidecar(
  rawSessionId: string,
  rawAgentId: string,
): void {
  const identity = parsedIdentity(rawSessionId, rawAgentId);
  if (identity === null) throw new Error("cannot remove implementation sidecar for invalid session/agent identity");
  const leaf = sidecarLeaf(identity);
  let anchored;
  try {
    // ENOENT propagates: an absent base means there is nothing to remove.
    anchored = openDirectoryNoFollow(resolveBaseDirectory(subagentDir()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let primaryError: unknown = null;
  try {
    removeDirectoryFileNoFollow(anchored, leaf);
  } catch (error) {
    primaryError = error;
  }
  const closeOutcome = closeAnchorGuarded(anchored, primaryError, `removal of implementation sidecar ${leaf}`);
  if (closeOutcome !== null) throw closeOutcome;
}
