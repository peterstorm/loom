import { closeSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseOrchestrationRunId, parseRequestId, type RequestId } from "../core/orchestration-contract";
import { ORCHESTRATION_RUNS_SUFFIX, parseSessionId, type SessionId } from "../machine/evidence";
import {
  ensureDirectoryNoFollow,
  openDirectoryNoFollow,
  procFdChild,
  readDirectoryFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileExclusiveNoFollow,
} from "./no-follow-fs";
import { parseRunDirectoryReference, type RunDirectoryReference } from "./run-directory-handle";

export { ORCHESTRATION_RUNS_SUFFIX } from "../machine/evidence";

export type SessionRunBinding = Readonly<RunDirectoryReference & {
  requestIds: readonly RequestId[];
}>;

export type SessionRunBindingRegistry = Readonly<{
  schemaVersion: 1;
  kind: "session-run-bindings";
  harness: "pi";
  sessionId: SessionId;
  bindings: readonly SessionRunBinding[];
}>;

type BindingResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

const ok = <T>(value: T): BindingResult<T> => ({ ok: true, value });
const failed = <T = never>(message: string): BindingResult<T> => ({ ok: false, message });

function exactRecord(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseBinding(raw: unknown, index: number): BindingResult<SessionRunBinding> {
  if (!exactRecord(raw, ["runId", "runsRoot", "runDirectory", "requestIds"])) {
    return failed(`session run binding ${index} must contain exactly runId, runsRoot, runDirectory, and requestIds`);
  }
  const runId = parseOrchestrationRunId(raw.runId);
  if (!runId.ok) return failed(`session run binding ${index}: ${runId.error.message}`);
  if (typeof raw.runsRoot !== "string" || raw.runsRoot.length === 0 ||
      typeof raw.runDirectory !== "string" || raw.runDirectory.length === 0) {
    return failed(`session run binding ${index} paths must be non-empty strings`);
  }
  if (!Array.isArray(raw.requestIds) || raw.requestIds.length === 0) {
    return failed(`session run binding ${index} requestIds must be a non-empty array`);
  }
  const requestIds: RequestId[] = [];
  for (const [requestIndex, requestId] of raw.requestIds.entries()) {
    const parsed = parseRequestId(requestId);
    if (!parsed.ok) return failed(`session run binding ${index} request ${requestIndex}: ${parsed.error.message}`);
    requestIds.push(parsed.value);
  }
  if (new Set(requestIds).size !== requestIds.length) {
    return failed(`session run binding ${index} requestIds must be unique`);
  }
  const identity = parseRunDirectoryReference(resolve(raw.runsRoot), resolve(raw.runDirectory));
  if (!identity.ok) return failed(`session run binding ${index}: ${identity.error.message}`);
  if (identity.value.runId !== runId.value) {
    return failed(`session run binding ${index} runId does not match its parsed run directory identity`);
  }
  return ok(Object.freeze({
    ...identity.value,
    requestIds: Object.freeze([...requestIds].sort()),
  }));
}

export function parseSessionRunBindingRegistry(
  raw: unknown,
  expectedSessionId: string,
): BindingResult<SessionRunBindingRegistry> {
  const sessionId = parseSessionId(expectedSessionId);
  if (sessionId === null) return failed(`invalid Pi session id ${JSON.stringify(expectedSessionId)}`);
  if (!exactRecord(raw, ["schemaVersion", "kind", "harness", "sessionId", "bindings"]) ||
      raw.schemaVersion !== 1 || raw.kind !== "session-run-bindings" || raw.harness !== "pi" ||
      raw.sessionId !== sessionId || !Array.isArray(raw.bindings)) {
    return failed("session run binding registry is malformed or belongs to another session");
  }
  const bindings: SessionRunBinding[] = [];
  for (const [index, binding] of raw.bindings.entries()) {
    const parsed = parseBinding(binding, index);
    if (!parsed.ok) return parsed;
    bindings.push(parsed.value);
  }
  const identities = bindings.map(({ runsRoot, runDirectory }) => `${runsRoot}\0${runDirectory}`);
  if (new Set(identities).size !== identities.length) {
    return failed("session run binding registry contains duplicate run identities");
  }
  return ok(Object.freeze({
    schemaVersion: 1,
    kind: "session-run-bindings",
    harness: "pi",
    sessionId,
    bindings: Object.freeze(bindings),
  }));
}

function registryFile(sessionId: SessionId): string {
  return `${sessionId}${ORCHESTRATION_RUNS_SUFFIX}`;
}

function readRegistryFromDirectory(
  directoryFd: number,
  sessionId: SessionId,
): BindingResult<SessionRunBindingRegistry> {
  let bytes: Buffer;
  try {
    bytes = readDirectoryFileNoFollow(directoryFd, registryFile(sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(Object.freeze({
        schemaVersion: 1,
        kind: "session-run-bindings",
        harness: "pi",
        sessionId,
        bindings: Object.freeze([]),
      }));
    }
    return failed(`cannot read Pi session run bindings: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseSessionRunBindingRegistry(JSON.parse(bytes.toString("utf-8")) as unknown, sessionId);
  } catch (error) {
    return failed(`Pi session run bindings are invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readSessionRunBindings(
  directory: string,
  rawSessionId: string,
): BindingResult<readonly SessionRunBinding[]> {
  const sessionId = parseSessionId(rawSessionId);
  if (sessionId === null) return failed(`invalid Pi session id ${JSON.stringify(rawSessionId)}`);
  try {
    const directoryFd = openBindingDirectory(directory);
    try {
      const registry = readRegistryFromDirectory(directoryFd, sessionId);
      return registry.ok ? ok(registry.value.bindings) : registry;
    } finally {
      closeBindingDirectory(directoryFd);
    }
  } catch (error) {
    return failed(`cannot open Pi session run binding directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const openBindingDirectory = (directory: string): number => {
  ensureDirectoryNoFollow(directory);
  return openDirectoryNoFollow(directory);
};

const closeBindingDirectory = closeSync;

export async function registerSessionRunBinding(
  directory: string,
  rawSessionId: string,
  binding: unknown,
): Promise<BindingResult<SessionRunBindingRegistry>> {
  const sessionId = parseSessionId(rawSessionId);
  if (sessionId === null) return failed(`invalid Pi session id ${JSON.stringify(rawSessionId)}`);
  const parsedBinding = parseBinding(binding, 0);
  if (!parsedBinding.ok) return parsedBinding;

  try {
    ensureDirectoryNoFollow(directory);
    return await withAnchoredDirectoryLock(directory, `${sessionId}.orchestration-runs.lock`, (directoryFd) => {
      const current = readRegistryFromDirectory(directoryFd, sessionId);
      if (!current.ok) return current;
      const identity = `${parsedBinding.value.runsRoot}\0${parsedBinding.value.runDirectory}`;
      const previous = current.value.bindings.find(
        ({ runsRoot, runDirectory }) => `${runsRoot}\0${runDirectory}` === identity,
      );
      const mergedBinding = previous === undefined
        ? parsedBinding.value
        : Object.freeze({
            ...parsedBinding.value,
            requestIds: Object.freeze([...new Set([...previous.requestIds, ...parsedBinding.value.requestIds])].sort()),
          });
      const bindings = [
        ...current.value.bindings.filter(
          ({ runsRoot, runDirectory }) => `${runsRoot}\0${runDirectory}` !== identity,
        ),
        mergedBinding,
      ].sort((left, right) =>
        `${left.runsRoot}\0${left.runDirectory}`.localeCompare(`${right.runsRoot}\0${right.runDirectory}`));
      const next: SessionRunBindingRegistry = Object.freeze({
        schemaVersion: 1,
        kind: "session-run-bindings",
        harness: "pi",
        sessionId,
        bindings: Object.freeze(bindings),
      });
      const finalName = registryFile(sessionId);
      const stagedName = `${finalName}.staged-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        writeDirectoryFileExclusiveNoFollow(directoryFd, stagedName, `${JSON.stringify(next, null, 2)}\n`);
        renameSync(procFdChild(directoryFd, stagedName), procFdChild(directoryFd, finalName));
      } catch (error) {
        try { unlinkSync(procFdChild(directoryFd, stagedName)); } catch { /* never published */ }
        throw error;
      }
      return ok(next);
    });
  } catch (error) {
    return failed(`cannot publish Pi session run binding: ${error instanceof Error ? error.message : String(error)}`);
  }
}
