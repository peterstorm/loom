import { renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseOrchestrationRunId, parseRequestId, type RequestId } from "../core/orchestration-contract";
import { compareStrings } from "../core/ordering";
import { ORCHESTRATION_RUNS_SUFFIX, parseSessionId, type SessionId } from "../machine/evidence";
import {
  type AnchoredDirectory,
  anchoredChildPath,
  closeAnchoredDirectory,
  ensureResolvedBaseDirectory,
  openDirectoryNoFollow,
  readDirectoryFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileExclusiveNoFollow,
} from "./no-follow-fs";
import { parseRunDirectoryReference, type RunDirectoryReference } from "./run-directory-handle";

export { ORCHESTRATION_RUNS_SUFFIX } from "../machine/evidence";

export type SessionRunBinding = Readonly<RunDirectoryReference & {
  requestIds: readonly RequestId[];
  resultDigest: string | null;
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
const bindingIdentity = ({ runsRoot, runDirectory }: Pick<SessionRunBinding, "runsRoot" | "runDirectory">): string =>
  `${runsRoot}\0${runDirectory}`;

function exactRecord(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseBinding(raw: unknown, index: number): BindingResult<SessionRunBinding> {
  if (!exactRecord(raw, ["runId", "runsRoot", "runDirectory", "requestIds", "resultDigest"])) {
    return failed(`session run binding ${index} must contain exactly runId, runsRoot, runDirectory, requestIds, and resultDigest`);
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
  if (raw.resultDigest !== null &&
      (typeof raw.resultDigest !== "string" || !/^[0-9a-f]{64}$/.test(raw.resultDigest))) {
    return failed(`session run binding ${index} resultDigest must be null or a lowercase SHA-256 digest`);
  }
  const identity = parseRunDirectoryReference(resolve(raw.runsRoot), resolve(raw.runDirectory));
  if (!identity.ok) return failed(`session run binding ${index}: ${identity.error.message}`);
  if (identity.value.runId !== runId.value) {
    return failed(`session run binding ${index} runId does not match its parsed run directory identity`);
  }
  return ok(Object.freeze({
    ...identity.value,
    requestIds: Object.freeze([...requestIds].sort()),
    resultDigest: raw.resultDigest,
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
  const identities = bindings.map(bindingIdentity);
  if (new Set(identities).size !== identities.length) {
    return failed("session run binding registry contains duplicate run identities");
  }
  return ok(sessionRunBindingRegistry(sessionId, bindings));
}

function registryFile(sessionId: SessionId): string {
  return `${sessionId}${ORCHESTRATION_RUNS_SUFFIX}`;
}

const sessionRunBindingRegistry = (
  sessionId: SessionId,
  bindings: readonly SessionRunBinding[],
): SessionRunBindingRegistry => Object.freeze({
  schemaVersion: 1,
  kind: "session-run-bindings",
  harness: "pi",
  sessionId,
  bindings: Object.freeze([...bindings]),
});

function readRegistryFromDirectory(
  directory: AnchoredDirectory,
  sessionId: SessionId,
): BindingResult<SessionRunBindingRegistry> {
  let bytes: Buffer;
  try {
    bytes = readDirectoryFileNoFollow(directory, registryFile(sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(sessionRunBindingRegistry(sessionId, []));
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
    const anchored = openBindingDirectory(directory);
    try {
      const registry = readRegistryFromDirectory(anchored, sessionId);
      return registry.ok ? ok(registry.value.bindings) : registry;
    } finally {
      closeAnchoredDirectory(anchored);
    }
  } catch (error) {
    return failed(`cannot open Pi session run binding directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The binding directory is the run BASE, so it is resolved once here rather
 * than walked strictly from the filesystem root: on macOS its configured path
 * runs through the system's `/tmp` → `/private/tmp` symlink, which is layout
 * rather than attack. Every path opened BELOW the resolved base is still held
 * to the strict no-symlink rule by the anchored primitives.
 */
const openBindingDirectory = (directory: string): AnchoredDirectory =>
  openDirectoryNoFollow(ensureResolvedBaseDirectory(directory));

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
    const base = ensureResolvedBaseDirectory(directory);
    return await withAnchoredDirectoryLock(base, `${sessionId}.orchestration-runs.lock`, (anchored) => {
      const current = readRegistryFromDirectory(anchored, sessionId);
      if (!current.ok) return current;
      const identity = bindingIdentity(parsedBinding.value);
      const previous = current.value.bindings.find((binding) => bindingIdentity(binding) === identity);
      if (previous !== undefined && previous.resultDigest !== null && parsedBinding.value.resultDigest !== null &&
          previous.resultDigest !== parsedBinding.value.resultDigest) {
        return failed("Pi session run binding result digest conflicts with its previous completion receipt");
      }
      const mergedBinding = previous === undefined
        ? parsedBinding.value
        : Object.freeze({
            ...parsedBinding.value,
            requestIds: Object.freeze([...new Set([...previous.requestIds, ...parsedBinding.value.requestIds])].sort()),
            resultDigest: previous.resultDigest ?? parsedBinding.value.resultDigest,
          });
      const bindings = [
        ...current.value.bindings.filter((binding) => bindingIdentity(binding) !== identity),
        mergedBinding,
      ].sort((left, right) => compareStrings(bindingIdentity(left), bindingIdentity(right)));
      const next = sessionRunBindingRegistry(sessionId, bindings);
      const finalName = registryFile(sessionId);
      const stagedName = `${finalName}.staged-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        writeDirectoryFileExclusiveNoFollow(anchored, stagedName, `${JSON.stringify(next, null, 2)}\n`);
        renameSync(anchoredChildPath(anchored, stagedName), anchoredChildPath(anchored, finalName));
      } catch (error) {
        const stagedPath = anchoredChildPath(anchored, stagedName);
        let cleanupFailure: string | null = null;
        try {
          unlinkSync(stagedPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            cleanupFailure = `${stagedPath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          }
        }
        if (cleanupFailure === null) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; staged cleanup failed: ${cleanupFailure}`,
        );
      }
      return ok(next);
    });
  } catch (error) {
    return failed(`cannot publish Pi session run binding: ${error instanceof Error ? error.message : String(error)}`);
  }
}
