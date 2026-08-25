/** Shared no-follow/atomic session TaskGraph pointer lifecycle. */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { subagentDir } from "../config";
import {
  readDirectoryFileNoFollow,
  removeDirectoryFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileAtomicNoFollow,
  type AnchoredDirectory,
} from "../orchestration/no-follow-fs";
import { TASK_GRAPH_POINTER_LEASES_SUFFIX, type SessionId } from "./evidence";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

declare const POINTER_GENERATION_ID: unique symbol;
declare const POINTER_LEASE_ID: unique symbol;
type PointerGenerationId = string & { readonly [POINTER_GENERATION_ID]: true };
type PointerLeaseId = string & { readonly [POINTER_LEASE_ID]: true };

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
  if (typeof record.target !== "string" || record.target.trim() !== record.target ||
      !isAbsolute(record.target) || normalize(record.target) !== record.target) {
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
      target: record.target,
      previous: record.previous as string | null,
      leases: Object.freeze(parsedLeases) as readonly [PointerLeaseId, ...PointerLeaseId[]],
    }),
  });
}

function optionalPointer(directory: AnchoredDirectory, pointerName: string): string | null {
  try {
    const pointer = readDirectoryFileNoFollow(directory, pointerName).toString("utf8").trim();
    if (pointer === "") throw new Error(`session TaskGraph pointer ${pointerName} is empty`);
    return pointer;
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

/**
 * Acquire one lease on the session's canonical active graph. Registry and
 * pointer state are observed and changed under the same no-follow lock. A
 * different target cannot replace a generation while any lease is live.
 */
export async function bindSessionTaskGraphPointer(
  sessionId: SessionId,
  activeTaskGraphPath: string,
  directory = subagentDir(),
): Promise<SessionTaskGraphPointerBinding> {
  const target = realpathSync.native(activeTaskGraphPath);
  const pointerName = `${sessionId}.task_graph`;
  const registryName = `${sessionId}${TASK_GRAPH_POINTER_LEASES_SUFFIX}`;
  const lockName = `${sessionId}.task-graph-pointer.lock`;
  return withAnchoredDirectoryLock(directory, lockName, (anchored) => {
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
      return bindingFor(directory, pointerName, registryName, next, leaseId);
    }

    const next: SessionTaskGraphPointerLeaseRegistry = Object.freeze({
      schemaVersion: 1,
      kind: "session-task-graph-pointer-leases",
      generationId: randomUUID() as PointerGenerationId,
      target,
      previous: pointer,
      leases: Object.freeze([leaseId]) as readonly [PointerLeaseId],
    });
    // Registry first is deliberate: a crash before pointer publication leaves
    // a detectable mismatch. Publishing the pointer first could lose `previous`
    // and let a later bind silently treat the half-written target as preexisting.
    writeRegistry(anchored, registryName, next);
    writeDirectoryFileAtomicNoFollow(anchored, pointerName, target);
    return bindingFor(directory, pointerName, registryName, next, leaseId);
  });
}

/** Release only this lease; restore the previous pointer after the final lease. */
export async function rollbackSessionTaskGraphPointer(
  binding: SessionTaskGraphPointerBinding,
): Promise<SessionTaskGraphPointerRollback> {
  const lockName = `${binding.pointerName.slice(0, -".task_graph".length)}.task-graph-pointer.lock`;
  return withAnchoredDirectoryLock(binding.directory, lockName, (anchored) => {
    const registry = optionalRegistry(anchored, binding.registryName);
    if (registry === null) return "not-owned" as const;
    if (registry.generationId !== binding.generationId || registry.target !== binding.target) {
      return "ownership-lost" as const;
    }
    if (optionalPointer(anchored, binding.pointerName) !== registry.target) return "ownership-lost" as const;
    if (!registry.leases.includes(binding.leaseId)) return "not-owned" as const;
    const remaining = registry.leases.filter((lease) => lease !== binding.leaseId);
    if (remaining.length > 0) {
      writeRegistry(anchored, binding.registryName, Object.freeze({
        ...registry,
        leases: Object.freeze(remaining) as readonly [PointerLeaseId, ...PointerLeaseId[]],
      }));
      return "rolled-back" as const;
    }
    // Pointer first is deliberate: a crash before registry removal leaves a
    // detectable mismatch. Removing authority first could expose `target` as a
    // fresh unowned pointer and later restore stale state.
    if (registry.previous === null) removeDirectoryFileNoFollow(anchored, binding.pointerName);
    else writeDirectoryFileAtomicNoFollow(anchored, binding.pointerName, registry.previous);
    removeDirectoryFileNoFollow(anchored, binding.registryName);
    return "rolled-back" as const;
  });
}
