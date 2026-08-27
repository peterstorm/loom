/** Shared no-follow/atomic session TaskGraph pointer lifecycle. */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { subagentDir } from "../config";
import {
  closeAnchoredDirectory,
  ensureDirectoryNoFollow,
  openDirectoryNoFollow,
  readDirectoryFileNoFollow,
  removeDirectoryFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileAtomicNoFollow,
  writeDirectoryFileExclusiveNoFollow,
  type AnchoredDirectory,
} from "../orchestration/no-follow-fs";
import {
  parseAgentId,
  parseSessionId,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
  TASK_GRAPH_POINTER_LEASES_SUFFIX,
  type AgentId,
  type SessionId,
} from "./evidence";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

declare const POINTER_GENERATION_ID: unique symbol;
declare const POINTER_LEASE_ID: unique symbol;
declare const CANONICAL_TASK_GRAPH_POINTER: unique symbol;
type PointerGenerationId = string & { readonly [POINTER_GENERATION_ID]: true };
type PointerLeaseId = string & { readonly [POINTER_LEASE_ID]: true };
export type CanonicalTaskGraphPointer = string & { readonly [CANONICAL_TASK_GRAPH_POINTER]: true };

export type CanonicalTaskGraphPointerParse =
  | Readonly<{ ok: true; value: CanonicalTaskGraphPointer }>
  | Readonly<{ ok: false; error: string }>;

/** Parse exact pointer bytes; normalization must never repair persisted authority. */
export function parseCanonicalTaskGraphPointer(raw: unknown): CanonicalTaskGraphPointerParse {
  if (typeof raw !== "string" || raw === "" || raw.trim() !== raw ||
      !isAbsolute(raw) || normalize(raw) !== raw) {
    return Object.freeze({ ok: false, error: "TaskGraph pointer must be one exact canonical absolute path" });
  }
  return Object.freeze({ ok: true, value: raw as CanonicalTaskGraphPointer });
}

export type SessionTaskGraphPointerLeaseRegistry = Readonly<{
  schemaVersion: 1;
  kind: "session-task-graph-pointer-leases";
  generationId: PointerGenerationId;
  target: string;
  previous: string | null;
  leases: readonly [PointerLeaseId, ...PointerLeaseId[]];
}>;

export type SessionTaskGraphPointerLeaseRegistryParse =
  | Readonly<{ ok: true; value: SessionTaskGraphPointerLeaseRegistry }>
  | Readonly<{ ok: false; error: string }>;

export type SessionTaskGraphPointerBinding = Readonly<{
  directory: string;
  pointerName: string;
  registryName: string;
  target: string;
  generationId: PointerGenerationId;
  leaseId: PointerLeaseId;
}>;

export type SessionTaskGraphPointerRollback = "rolled-back" | "not-owned" | "ownership-lost";

export type PersistedSessionTaskGraphPointerBinding = Readonly<{
  schemaVersion: 1;
  kind: "persisted-session-task-graph-pointer-binding";
  sessionId: SessionId;
  agentId: AgentId;
  binding: SessionTaskGraphPointerBinding;
}>;

export type PersistedSessionTaskGraphPointerRelease =
  | SessionTaskGraphPointerRollback
  | "binding-missing";

export type PersistedSessionTaskGraphPointerClaim =
  | Readonly<{ kind: "persisted"; binding: SessionTaskGraphPointerBinding }>
  | Readonly<{ kind: "already-owned"; binding: SessionTaskGraphPointerBinding }>;

const parseUuid = <Brand extends string>(raw: unknown): Brand | null =>
  typeof raw === "string" && UUID.test(raw) ? raw as Brand : null;

/** Pure exact parser for the immutable registry persisted beside the pointer. */
export function parseSessionTaskGraphPointerLeaseRegistry(
  raw: unknown,
): SessionTaskGraphPointerLeaseRegistryParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return Object.freeze({ ok: false, error: "pointer lease registry must be a plain object" });
  }
  const record = raw as Record<string, unknown>;
  const expected = ["generationId", "kind", "leases", "previous", "schemaVersion", "target"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return Object.freeze({ ok: false, error: `pointer lease registry must contain exactly ${expected.join(", ")}` });
  }
  if (record.schemaVersion !== 1 || record.kind !== "session-task-graph-pointer-leases") {
    return Object.freeze({ ok: false, error: "pointer lease registry tag is invalid" });
  }
  const generationId = parseUuid<PointerGenerationId>(record.generationId);
  if (generationId === null) return Object.freeze({ ok: false, error: "pointer lease registry generationId is invalid" });
  const target = parseCanonicalTaskGraphPointer(record.target);
  if (!target.ok) {
    return Object.freeze({ ok: false, error: "pointer lease registry target must be one canonical absolute path" });
  }
  if (record.previous !== null && (typeof record.previous !== "string" ||
      record.previous.trim() === "" || record.previous.trim() !== record.previous)) {
    return Object.freeze({ ok: false, error: "pointer lease registry previous must be null or one exact non-empty path" });
  }
  if (!Array.isArray(record.leases) || record.leases.length === 0) {
    return Object.freeze({ ok: false, error: "pointer lease registry leases must be non-empty" });
  }
  const leases = record.leases.map((lease) => parseUuid<PointerLeaseId>(lease));
  if (leases.some((lease) => lease === null)) {
    return Object.freeze({ ok: false, error: "pointer lease registry contains an invalid lease id" });
  }
  const parsedLeases = leases as PointerLeaseId[];
  if (new Set(parsedLeases).size !== parsedLeases.length) {
    return Object.freeze({ ok: false, error: "pointer lease registry lease ids must be unique" });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "session-task-graph-pointer-leases",
      generationId,
      target: target.value,
      previous: record.previous as string | null,
      leases: Object.freeze(parsedLeases) as readonly [PointerLeaseId, ...PointerLeaseId[]],
    }),
  });
}

function optionalPointer(directory: AnchoredDirectory, pointerName: string): CanonicalTaskGraphPointer | null {
  try {
    const parsed = parseCanonicalTaskGraphPointer(
      readDirectoryFileNoFollow(directory, pointerName).toString("utf8"),
    );
    if (!parsed.ok) throw new Error(`session TaskGraph pointer ${pointerName} is malformed: ${parsed.error}`);
    return parsed.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function optionalRegistry(
  directory: AnchoredDirectory,
  registryName: string,
): SessionTaskGraphPointerLeaseRegistry | null {
  let bytes: Buffer;
  try {
    bytes = readDirectoryFileNoFollow(directory, registryName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`pointer lease registry ${registryName} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseSessionTaskGraphPointerLeaseRegistry(raw);
  if (!parsed.ok) throw new Error(`pointer lease registry ${registryName} is malformed: ${parsed.error}`);
  return parsed.value;
}

const writeRegistry = (
  directory: AnchoredDirectory,
  registryName: string,
  registry: SessionTaskGraphPointerLeaseRegistry,
): void => writeDirectoryFileAtomicNoFollow(directory, registryName, JSON.stringify(registry));

const bindingFor = (
  directory: string,
  pointerName: string,
  registryName: string,
  registry: SessionTaskGraphPointerLeaseRegistry,
  leaseId: PointerLeaseId,
): SessionTaskGraphPointerBinding => Object.freeze({
  directory,
  pointerName,
  registryName,
  target: registry.target,
  generationId: registry.generationId,
  leaseId,
});

function acquirePointerLease(
  anchored: AnchoredDirectory,
  sessionId: SessionId,
  target: string,
  canonicalDirectory: string,
): SessionTaskGraphPointerBinding {
  const pointerName = `${sessionId}.task_graph`;
  const registryName = `${sessionId}${TASK_GRAPH_POINTER_LEASES_SUFFIX}`;
  const pointer = optionalPointer(anchored, pointerName);
  const registry = optionalRegistry(anchored, registryName);
  const leaseId = randomUUID() as PointerLeaseId;
  if (registry !== null) {
    if (pointer !== registry.target) {
      throw new Error(`pointer lease registry ${registryName} disagrees with ${pointerName}; refusing crash-state recovery`);
    }
    if (registry.target !== target) {
      throw new Error(`session ${sessionId} still has ${registry.leases.length} live pointer lease(s) for ${registry.target}; refusing target ${target}`);
    }
    const next = Object.freeze({
      ...registry,
      leases: Object.freeze([...registry.leases, leaseId]) as readonly [PointerLeaseId, ...PointerLeaseId[]],
    });
    writeRegistry(anchored, registryName, next);
    return bindingFor(canonicalDirectory, pointerName, registryName, next, leaseId);
  }
  const next: SessionTaskGraphPointerLeaseRegistry = Object.freeze({
    schemaVersion: 1,
    kind: "session-task-graph-pointer-leases",
    generationId: randomUUID() as PointerGenerationId,
    target,
    previous: pointer,
    leases: Object.freeze([leaseId]) as readonly [PointerLeaseId],
  });
  writeRegistry(anchored, registryName, next);
  writeDirectoryFileAtomicNoFollow(anchored, pointerName, target);
  return bindingFor(canonicalDirectory, pointerName, registryName, next, leaseId);
}

function releasePointerLease(
  anchored: AnchoredDirectory,
  binding: SessionTaskGraphPointerBinding,
): SessionTaskGraphPointerRollback {
  const registry = optionalRegistry(anchored, binding.registryName);
  if (registry === null) return "not-owned";
  if (registry.generationId !== binding.generationId || registry.target !== binding.target) return "ownership-lost";
  if (optionalPointer(anchored, binding.pointerName) !== registry.target) return "ownership-lost";
  if (!registry.leases.includes(binding.leaseId)) return "not-owned";
  const remaining = registry.leases.filter((lease) => lease !== binding.leaseId);
  if (remaining.length > 0) {
    writeRegistry(anchored, binding.registryName, Object.freeze({
      ...registry,
      leases: Object.freeze(remaining) as readonly [PointerLeaseId, ...PointerLeaseId[]],
    }));
    return "rolled-back";
  }
  if (registry.previous === null) removeDirectoryFileNoFollow(anchored, binding.pointerName);
  else writeDirectoryFileAtomicNoFollow(anchored, binding.pointerName, registry.previous);
  removeDirectoryFileNoFollow(anchored, binding.registryName);
  return "rolled-back";
}

/** Acquire one exact lease under the session pointer lock. */
export async function bindSessionTaskGraphPointer(
  sessionId: SessionId,
  activeTaskGraphPath: string,
  directory = subagentDir(),
): Promise<SessionTaskGraphPointerBinding> {
  const target = realpathSync.native(activeTaskGraphPath);
  const canonicalDirectory = realpathSync.native(directory);
  return withAnchoredDirectoryLock(canonicalDirectory, `${sessionId}.task-graph-pointer.lock`, (anchored) =>
    acquirePointerLease(anchored, sessionId, target, canonicalDirectory));
}

/** Release only this lease; restore the previous pointer after the final lease. */
export async function rollbackSessionTaskGraphPointer(
  binding: SessionTaskGraphPointerBinding,
): Promise<SessionTaskGraphPointerRollback> {
  const lockName = `${binding.pointerName.slice(0, -".task_graph".length)}.task-graph-pointer.lock`;
  return withAnchoredDirectoryLock(binding.directory, lockName, (anchored) =>
    releasePointerLease(anchored, binding));
}

function bindingSidecarLeaf(sessionId: SessionId, agentId: AgentId): string {
  return `${sessionId}.${Buffer.from(agentId, "utf8").toString("hex")}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`;
}

function parsePointerBinding(raw: unknown): SessionTaskGraphPointerBinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const expected = ["directory", "generationId", "leaseId", "pointerName", "registryName", "target"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  const generationId = parseUuid<PointerGenerationId>(record.generationId);
  const leaseId = parseUuid<PointerLeaseId>(record.leaseId);
  if (generationId === null || leaseId === null) return null;
  if (typeof record.directory !== "string" || !isAbsolute(record.directory) || normalize(record.directory) !== record.directory ||
      typeof record.pointerName !== "string" || typeof record.registryName !== "string" ||
      typeof record.target !== "string" || !isAbsolute(record.target) || normalize(record.target) !== record.target) {
    return null;
  }
  return Object.freeze({
    directory: record.directory,
    pointerName: record.pointerName,
    registryName: record.registryName,
    target: record.target,
    generationId,
    leaseId,
  });
}

export function parsePersistedSessionTaskGraphPointerBinding(
  raw: unknown,
): Readonly<{ ok: true; value: PersistedSessionTaskGraphPointerBinding }> |
  Readonly<{ ok: false; error: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return Object.freeze({ ok: false, error: "persisted pointer binding must be a plain object" });
  }
  const record = raw as Record<string, unknown>;
  const expected = ["agentId", "binding", "kind", "schemaVersion", "sessionId"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return Object.freeze({ ok: false, error: `persisted pointer binding must contain exactly ${expected.join(", ")}` });
  }
  if (record.schemaVersion !== 1 || record.kind !== "persisted-session-task-graph-pointer-binding") {
    return Object.freeze({ ok: false, error: "persisted pointer binding tag is invalid" });
  }
  const sessionId = typeof record.sessionId === "string" ? parseSessionId(record.sessionId) : null;
  const agentId = typeof record.agentId === "string" ? parseAgentId(record.agentId) : null;
  const binding = parsePointerBinding(record.binding);
  if (sessionId === null || agentId === null || binding === null ||
      binding.pointerName !== `${sessionId}.task_graph` ||
      binding.registryName !== `${sessionId}${TASK_GRAPH_POINTER_LEASES_SUFFIX}`) {
    return Object.freeze({ ok: false, error: "persisted pointer binding identity or binding is invalid" });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "persisted-session-task-graph-pointer-binding",
      sessionId,
      agentId,
      binding,
    }),
  });
}

/** Persist the exact Claude cleanup capability before allowing the Agent to run. */
export function persistSessionTaskGraphPointerBinding(
  sessionId: SessionId,
  agentId: AgentId,
  binding: SessionTaskGraphPointerBinding,
): PersistedSessionTaskGraphPointerClaim {
  const persisted: PersistedSessionTaskGraphPointerBinding = Object.freeze({
    schemaVersion: 1,
    kind: "persisted-session-task-graph-pointer-binding",
    sessionId,
    agentId,
    binding,
  });
  const parsed = parsePersistedSessionTaskGraphPointerBinding(persisted);
  if (!parsed.ok) throw new Error(parsed.error);
  ensureDirectoryNoFollow(binding.directory);
  const anchored = openDirectoryNoFollow(binding.directory);
  try {
    const leaf = bindingSidecarLeaf(sessionId, agentId);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, leaf, `${JSON.stringify(parsed.value)}\n`);
      return Object.freeze({ kind: "persisted", binding: parsed.value.binding });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingRaw: unknown;
      try {
        existingRaw = JSON.parse(readDirectoryFileNoFollow(anchored, leaf).toString("utf8")) as unknown;
      } catch (readError) {
        throw new Error(`existing persisted pointer binding ${leaf} is unreadable: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      const existing = parsePersistedSessionTaskGraphPointerBinding(existingRaw);
      const registry = optionalRegistry(anchored, binding.registryName);
      if (!existing.ok || existing.value.sessionId !== sessionId || existing.value.agentId !== agentId ||
          existing.value.binding.directory !== binding.directory || existing.value.binding.target !== binding.target ||
          registry === null || registry.generationId !== existing.value.binding.generationId ||
          registry.target !== existing.value.binding.target || !registry.leases.includes(existing.value.binding.leaseId) ||
          optionalPointer(anchored, binding.pointerName) !== registry.target) {
        throw new Error(`existing persisted pointer binding ${leaf} does not prove the same live authority`);
      }
      return Object.freeze({ kind: "already-owned", binding: existing.value.binding });
    }
  } finally {
    closeAnchoredDirectory(anchored);
  }
}

function readPersistedPointerBinding(
  anchored: AnchoredDirectory,
  leaf: string,
): PersistedSessionTaskGraphPointerBinding | null {
  let bytes: Buffer;
  try {
    bytes = readDirectoryFileNoFollow(anchored, leaf);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`persisted pointer binding ${leaf} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parsePersistedSessionTaskGraphPointerBinding(raw);
  if (!parsed.ok) throw new Error(`persisted pointer binding ${leaf} is malformed: ${parsed.error}`);
  return parsed.value;
}

/** Atomically acquire or reuse one exact Claude pointer capability. */
export async function claimPersistedSessionTaskGraphPointerBinding(
  sessionId: SessionId,
  agentId: AgentId,
  activeTaskGraphPath: string,
  directory = subagentDir(),
): Promise<PersistedSessionTaskGraphPointerClaim> {
  const target = realpathSync.native(activeTaskGraphPath);
  const canonicalDirectory = realpathSync.native(directory);
  const leaf = bindingSidecarLeaf(sessionId, agentId);
  return withAnchoredDirectoryLock(canonicalDirectory, `${sessionId}.task-graph-pointer.lock`, (anchored) => {
    const existing = readPersistedPointerBinding(anchored, leaf);
    if (existing !== null) {
      const registry = optionalRegistry(anchored, existing.binding.registryName);
      if (existing.sessionId !== sessionId || existing.agentId !== agentId ||
          existing.binding.directory !== canonicalDirectory || existing.binding.target !== target ||
          registry === null || registry.generationId !== existing.binding.generationId ||
          registry.target !== target || !registry.leases.includes(existing.binding.leaseId) ||
          optionalPointer(anchored, existing.binding.pointerName) !== target) {
        throw new Error(`existing persisted pointer binding ${leaf} does not prove the same live authority`);
      }
      return Object.freeze({ kind: "already-owned", binding: existing.binding });
    }
    const acquired = acquirePointerLease(anchored, sessionId, target, canonicalDirectory);
    const persisted: PersistedSessionTaskGraphPointerBinding = Object.freeze({
      schemaVersion: 1,
      kind: "persisted-session-task-graph-pointer-binding",
      sessionId,
      agentId,
      binding: acquired,
    });
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, leaf, `${JSON.stringify(persisted)}\n`);
      return Object.freeze({ kind: "persisted", binding: acquired });
    } catch (error) {
      const released = releasePointerLease(anchored, acquired);
      if (released !== "rolled-back") {
        throw new AggregateError(
          [error, new Error(`new pointer lease rollback returned ${released}`)],
          "pointer claim failed and its newly acquired lease could not be released",
        );
      }
      throw error;
    }
  });
}

/** Atomically release the persisted Claude lease and its sidecar. */
export async function releasePersistedSessionTaskGraphPointerBinding(
  sessionId: SessionId,
  agentId: AgentId,
  directory = subagentDir(),
): Promise<PersistedSessionTaskGraphPointerRelease> {
  let canonicalDirectory: string;
  try {
    canonicalDirectory = realpathSync.native(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "binding-missing";
    throw error;
  }
  const leaf = bindingSidecarLeaf(sessionId, agentId);
  return withAnchoredDirectoryLock(canonicalDirectory, `${sessionId}.task-graph-pointer.lock`, (anchored) => {
    const persisted = readPersistedPointerBinding(anchored, leaf);
    if (persisted === null) return "binding-missing";
    if (persisted.sessionId !== sessionId || persisted.agentId !== agentId ||
        persisted.binding.directory !== canonicalDirectory) {
      throw new Error(`persisted pointer binding ${leaf} belongs to different authority`);
    }
    const released = releasePointerLease(anchored, persisted.binding);
    if (released === "ownership-lost") return released;
    if (released === "not-owned") {
      throw new Error(
        `persisted pointer binding ${leaf} no longer owns its exact lease; retaining cleanup authority`,
      );
    }
    removeDirectoryFileNoFollow(anchored, leaf);
    return released;
  });
}
