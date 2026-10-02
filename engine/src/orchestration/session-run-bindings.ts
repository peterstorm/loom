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

/**
 * The harness whose session published a registry.
 *
 * There is one registry file per session id whichever harness owns the
 * session. The harness is recorded IN the registry and every reader names the
 * harness it expects, so a registry Pi published can never authorize a Claude
 * Code hook, nor the reverse, even if the two ever shared a session id.
 */
const SESSION_BINDING_HARNESSES = ["pi", "claude-code"] as const;
export type SessionBindingHarness = (typeof SESSION_BINDING_HARNESSES)[number];

/** The operator-facing name of each harness, used in every binding diagnostic. */
export const HARNESS_LABEL: Readonly<Record<SessionBindingHarness, string>> = Object.freeze({
  "pi": "Pi",
  "claude-code": "Claude Code",
});

const isSessionBindingHarness = (raw: unknown): raw is SessionBindingHarness =>
  (SESSION_BINDING_HARNESSES as readonly unknown[]).includes(raw);

export type SessionRunBindingRegistry = Readonly<{
  schemaVersion: 1;
  kind: "session-run-bindings";
  harness: SessionBindingHarness;
  sessionId: SessionId;
  bindings: readonly SessionRunBinding[];
}>;

export type BindingResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

/** The BindingResult constructors every binding reader shares. */
export const ok = <T>(value: T): BindingResult<T> => ({ ok: true, value });
export const failed = <T = never>(message: string): BindingResult<T> => ({ ok: false, message });
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

/**
 * Parse one registry as `expectedHarness` expects it. The harness is required:
 * a registry published by the other harness is refused by name rather than read.
 */
export function parseSessionRunBindingRegistry(
  raw: unknown,
  expectedSessionId: string,
  expectedHarness: SessionBindingHarness,
): BindingResult<SessionRunBindingRegistry> {
  const sessionId = parseSessionId(expectedSessionId);
  if (sessionId === null) {
    return failed(`invalid ${HARNESS_LABEL[expectedHarness]} session id ${JSON.stringify(expectedSessionId)}`);
  }
  if (!exactRecord(raw, ["schemaVersion", "kind", "harness", "sessionId", "bindings"]) ||
      raw.schemaVersion !== 1 || raw.kind !== "session-run-bindings" || !isSessionBindingHarness(raw.harness) ||
      raw.sessionId !== sessionId || !Array.isArray(raw.bindings)) {
    return failed("session run binding registry is malformed or belongs to another session");
  }
  if (raw.harness !== expectedHarness) {
    return failed(
      `session run binding registry belongs to ${HARNESS_LABEL[raw.harness]}, not ${HARNESS_LABEL[expectedHarness]}`,
    );
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
  return ok(sessionRunBindingRegistry(expectedHarness, sessionId, bindings));
}

function registryFile(sessionId: SessionId): string {
  return `${sessionId}${ORCHESTRATION_RUNS_SUFFIX}`;
}

const sessionRunBindingRegistry = (
  harness: SessionBindingHarness,
  sessionId: SessionId,
  bindings: readonly SessionRunBinding[],
): SessionRunBindingRegistry => Object.freeze({
  schemaVersion: 1,
  kind: "session-run-bindings",
  harness,
  sessionId,
  bindings: Object.freeze([...bindings]),
});

function readRegistryFromDirectory(
  directory: AnchoredDirectory,
  harness: SessionBindingHarness,
  sessionId: SessionId,
): BindingResult<SessionRunBindingRegistry> {
  const label = HARNESS_LABEL[harness];
  let bytes: Buffer;
  try {
    bytes = readDirectoryFileNoFollow(directory, registryFile(sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(sessionRunBindingRegistry(harness, sessionId, []));
    }
    return failed(`cannot read ${label} session run bindings: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseSessionRunBindingRegistry(JSON.parse(bytes.toString("utf-8")) as unknown, sessionId, harness);
  } catch (error) {
    return failed(`${label} session run bindings are invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read one session's bindings as `harness` expects them; a registry another harness published is refused. */
export function readSessionRunBindings(
  directory: string,
  rawSessionId: string,
  harness: SessionBindingHarness,
): BindingResult<readonly SessionRunBinding[]> {
  const label = HARNESS_LABEL[harness];
  const sessionId = parseSessionId(rawSessionId);
  if (sessionId === null) return failed(`invalid ${label} session id ${JSON.stringify(rawSessionId)}`);
  try {
    const anchored = openBindingDirectory(directory);
    try {
      const registry = readRegistryFromDirectory(anchored, harness, sessionId);
      return registry.ok ? ok(registry.value.bindings) : registry;
    } finally {
      closeAnchoredDirectory(anchored);
    }
  } catch (error) {
    return failed(`cannot open ${label} session run binding directory: ${error instanceof Error ? error.message : String(error)}`);
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
  harness: SessionBindingHarness,
): Promise<BindingResult<SessionRunBindingRegistry>> {
  const label = HARNESS_LABEL[harness];
  const sessionId = parseSessionId(rawSessionId);
  if (sessionId === null) return failed(`invalid ${label} session id ${JSON.stringify(rawSessionId)}`);
  const parsedBinding = parseBinding(binding, 0);
  if (!parsedBinding.ok) return parsedBinding;

  try {
    const base = ensureResolvedBaseDirectory(directory);
    return await withAnchoredDirectoryLock(base, `${sessionId}.orchestration-runs.lock`, (anchored) => {
      const current = readRegistryFromDirectory(anchored, harness, sessionId);
      if (!current.ok) return current;
      const identity = bindingIdentity(parsedBinding.value);
      const previous = current.value.bindings.find((binding) => bindingIdentity(binding) === identity);
      if (previous !== undefined && previous.resultDigest !== null && parsedBinding.value.resultDigest !== null &&
          previous.resultDigest !== parsedBinding.value.resultDigest) {
        return failed(`${label} session run binding result digest conflicts with its previous completion receipt`);
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
      const next = sessionRunBindingRegistry(harness, sessionId, bindings);
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
    return failed(`cannot publish ${label} session run binding: ${error instanceof Error ? error.message : String(error)}`);
  }
}
