/**
 * Anchored run-directory handle.
 *
 * The handle exposes a FIXED set of operations over one proven run directory
 * and has no arbitrary path API: a caller can publish a context, reserve a
 * transcript slot, or record a receipt, but it cannot ask the handle to write
 * "some path". That is the point — every write lands in a slot the layout
 * already names, so a compromised or buggy caller cannot redirect bytes.
 *
 * Layout:
 *   authority.json                     immutable run/roster/root authority
 *   checkpoint.json                    atomic projection, not primary history
 *   events/<sequence>-<dedup>.json     immutable domain events
 *   requests/<request-id>.json         immutable request authority
 *   requests/correlators/<digest>.json immutable native-id/request binding
 *   contexts/<digest>.json             complete immutable context packets
 *   transcripts/<slot>/attempt-<n>.raw exact harness bytes
 *   receipts/<effect-id>.json          typed effect/publication receipts
 *   artifacts/...                      domain artifacts and final outputs
 *
 * Immutable artifacts are written with O_EXCL through a descriptor anchored at
 * their parent, so republishing a slot fails loudly instead of silently
 * rewriting history.
 */

import { createHash } from "node:crypto";
import { linkSync, lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  parseStoredAgentRequestAuthority,
  parseArtifactByteLength,
  parseOrchestrationRunId,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type ArtifactRef,
  type DomainResult,
  type EffectId,
  type EffectReceipt,
  type OrchestrationRunId,
} from "../core/orchestration-contract";
import { captureKey, type CaptureKey } from "../core/harness-capture";
import type { ContextPacket } from "./context-packets";
import { parseContextPacket } from "./context-packets";
import {
  ensureRelativeDirectoryNoFollow,
  listDirectoryNamesNoFollow,
  openChildDirectoryNoFollow,
  openDirectoryNoFollow,
  anchoredChildPath,
  closeAnchoredDirectory,
  type AnchoredDirectory,
  readDirectoryFileNoFollow,
  publishStagedRunFile,
  readRunBytesNoFollow,
  readRunFileNoFollow,
  removeRunFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileExclusiveNoFollow,
  writeRunBytesExclusiveNoFollow,
  writeRunFileExclusiveNoFollow,
  writeRunFileNoFollow,
} from "./no-follow-fs";
import {
  parseProgramEventRecord,
  type ProgramEventRecord,
  type ProgramJournal,
} from "./fugue-program-runtime";

export const RUN_DIRECTORY_SCHEMA_VERSION = 1;

const EVENTS = "events";
const REQUESTS = "requests";
const CORRELATORS = "correlators";
const CONTEXTS = "contexts";
const TRANSCRIPTS = "transcripts";
const RECEIPTS = "receipts";
const ARTIFACTS = "artifacts";
const AUTHORITY_FILE = "authority.json";
const PROGRAM_FILE = "program.json";
const CHECKPOINT_FILE = "checkpoint.json";
const PROGRESS_FILE = "progress.json";

const FIXED_SUBDIRECTORIES: readonly string[] = [
  EVENTS,
  REQUESTS,
  join(REQUESTS, CORRELATORS),
  CONTEXTS,
  TRANSCRIPTS,
  RECEIPTS,
  ARTIFACTS,
];

export type RunDirectoryError = Readonly<{
  kind: "invalid-run-directory";
  field: string;
  message: string;
}>;

const failure = <T>(field: string, message: string): DomainResult<T, RunDirectoryError> =>
  ({ ok: false, error: canonicalRecord({ kind: "invalid-run-directory" as const, field, message }) });

const success = <T>(value: T): DomainResult<T, RunDirectoryError> => ({ ok: true, value });

/** Immutable run authority, written once when the directory is created. */
export type RunAuthority = Readonly<{
  schemaVersion: typeof RUN_DIRECTORY_SCHEMA_VERSION;
  runId: OrchestrationRunId;
  runsRoot: string;
  runDirectory: string;
}>;

export type ContextPublishedReceipt = Readonly<{
  kind: "context-published";
  runId: OrchestrationRunId;
  digest: ContextPacket["digest"];
  slotPath: string;
}>;

export type TranscriptReserved = Readonly<{
  kind: "transcript-reserved";
  runId: OrchestrationRunId;
  requestId: AgentRequestAuthority["requestId"];
  slotPath: string;
}>;

export type HarnessCorrelatorBinding = Readonly<{
  schemaVersion: typeof RUN_DIRECTORY_SCHEMA_VERSION;
  harness: "pi" | "claude";
  nativeId: string;
  requestId: AgentRequestAuthority["requestId"];
  role: AgentRequestAuthority["role"];
  attempt: AgentRequestAuthority["attempt"];
}>;

declare const ARTIFACT_RELATIVE_PATH: unique symbol;
export type ArtifactRelativePath = string & { readonly [ARTIFACT_RELATIVE_PATH]: true };

/** Bytes staged for publication under one parsed artifact-relative slot. */
export type StagedArtifact = Readonly<{
  relativePath: ArtifactRelativePath;
  bytes: readonly number[];
}>;

/** Untrusted shell input; `publishArtifactSet` parses it before any write. */
export type StagedArtifactInput = Readonly<{
  relativePath: unknown;
  bytes: readonly number[];
}>;

export function parseArtifactRelativePath(raw: unknown): DomainResult<ArtifactRelativePath, RunDirectoryError> {
  if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("/") || raw.endsWith("/") || raw.includes("\\")) {
    return failure("artifacts", "artifact path must be a non-empty POSIX-relative path");
  }
  const components = raw.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    return failure("artifacts", "artifact path must not contain empty, dot, or traversal components");
  }
  return success(raw as ArtifactRelativePath);
}

export function createStagedArtifact(
  relativePath: unknown,
  bytes: readonly number[],
): DomainResult<StagedArtifact, RunDirectoryError> {
  const parsedPath = parseArtifactRelativePath(relativePath);
  if (!parsedPath.ok) return parsedPath;
  if (!Array.isArray(bytes) || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return failure("artifacts", "staged artifact bytes must be integers from 0 through 255");
  }
  return success(Object.freeze({ relativePath: parsedPath.value, bytes: Object.freeze([...bytes]) }));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

declare const RUN_DIRECTORY_REFERENCE: unique symbol;
declare const RUN_DIRECTORY_IDENTITY: unique symbol;
export type RunDirectoryReference = Readonly<{
  runsRoot: string;
  runDirectory: string;
  runId: OrchestrationRunId;
  readonly [RUN_DIRECTORY_REFERENCE]: true;
}>;
export type RunDirectoryIdentity = Readonly<RunDirectoryReference & {
  /** Present only after the referenced directory was observed to exist. */
  readonly [RUN_DIRECTORY_IDENTITY]: true;
}>;

export type RunDirectoryEntryInspection =
  | Readonly<{ kind: "absent"; reference: RunDirectoryReference }>
  | Readonly<{ kind: "directory"; reference: RunDirectoryReference }>
  | Readonly<{ kind: "occupied"; reference: RunDirectoryReference; entryKind: "symlink" | "other" }>;

/**
 * Resolve a caller's run reference to an absolute path.
 *
 * A run reference always arrives beside the runs-root it belongs to — the
 * `--run` flag beside `--runs-root`, the remediation payload's `sourceRun`
 * beside its `sourceRunsRoot` — so the natural way to write one is the run's
 * bare name. Resolving that against the process CWD, the only reading `resolve`
 * has, turned every bare name into a path outside the root and then refused it
 * as "not a direct child": a diagnostic about the RELATION, handed to a caller
 * whose only omission was a prefix the root already carries.
 *
 * A canonical run id is separator-free by construction (`SAFE_AUTHORITY_ID`
 * admits no `/`, and requires a leading alphanumeric, so neither `.` nor `..`
 * can be one). Reading exactly that form as the child it names can therefore
 * only ever produce a direct child of the root, and every other form keeps
 * exact path semantics and is still held to the relation checked below.
 */
function resolveRunDirectoryPath(root: string, runDirectory: string): string {
  return parseOrchestrationRunId(runDirectory).ok ? join(root, runDirectory) : resolve(runDirectory);
}

/** Parse the stable direct-child relation without requiring the run to remain live. */
export function parseRunDirectoryReference(
  runsRoot: string,
  runDirectory: string,
): DomainResult<RunDirectoryReference, RunDirectoryError> {
  const root = resolve(runsRoot);
  const directory = resolveRunDirectoryPath(root, runDirectory);
  if (join(root, basename(directory)) !== directory) {
    return failure("runDirectory", `run directory must be a direct child of ${root}`);
  }
  const runId = parseOrchestrationRunId(basename(directory));
  if (!runId.ok) return failure("runDirectory", runId.error.message);
  return success(canonicalRecord({
    runsRoot: root,
    runDirectory: directory,
    runId: runId.value,
  }) as RunDirectoryReference);
}

/** Inspect one lexical direct-child entry without following its leaf. ENOENT is
 * the only absent result; permission, I/O, and malformed-path failures remain
 * typed refusals. Recovery uses this proof so a symlink or non-directory can
 * never masquerade as an orphaned Run Directory. */
export function inspectRunDirectoryEntry(
  runsRoot: string,
  runDirectory: string,
): DomainResult<RunDirectoryEntryInspection, RunDirectoryError> {
  const reference = parseRunDirectoryReference(runsRoot, runDirectory);
  if (!reference.ok) return reference;
  try {
    const stat = lstatSync(reference.value.runDirectory);
    if (stat.isSymbolicLink()) {
      return success(canonicalRecord({ kind: "occupied", reference: reference.value, entryKind: "symlink" }));
    }
    return success(stat.isDirectory()
      ? canonicalRecord({ kind: "directory", reference: reference.value })
      : canonicalRecord({ kind: "occupied", reference: reference.value, entryKind: "other" }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return success(canonicalRecord({ kind: "absent", reference: reference.value }));
    }
    return failure(
      "runDirectory",
      `cannot inspect run directory entry ${reference.value.runDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Re-express a validated identity against the REAL path of its runs root.
 *
 * The runs root is the run BASE, and the operator's own path to it may
 * legitimately traverse system symlinks — on macOS `/tmp` and `/var` are
 * symlinks (`/tmp` → `/private/tmp`), so a rule that refused every symlink
 * from the filesystem root down would refuse every real run. Resolving the
 * base exactly once, here, is what lets everything BELOW it be held to the
 * strict no-symlink rule the anchored primitives enforce.
 *
 * The direct-child relation is checked BEFORE rebasing, against the caller's
 * original pair, so resolution can never launder an unrelated directory into
 * looking like a child of the root.
 *
 * On Linux this is an identity: a runs root containing a symlink is already
 * refused by the anchored walk, so any root that works keeps working.
 */
function rebasedOnRealRunsRoot(
  reference: RunDirectoryReference,
): DomainResult<RunDirectoryReference, RunDirectoryError> {
  let realRoot: string;
  try {
    realRoot = realpathSync.native(reference.runsRoot);
  } catch (error) {
    return failure("runsRoot", `cannot resolve runs root ${reference.runsRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (realRoot === reference.runsRoot) return success(reference);
  return parseRunDirectoryReference(realRoot, join(realRoot, basename(reference.runDirectory)));
}

/**
 * A run directory must be a direct child of its runs-root and must already
 * exist. Both are resolved and compared as strings, and every later access
 * re-opens the path with no component followed, so a component swapped to a
 * symlink after this check still cannot be followed.
 */
export function parseRunDirectoryIdentity(
  runsRoot: string,
  runDirectory: string,
): DomainResult<RunDirectoryIdentity, RunDirectoryError> {
  const lexical = parseRunDirectoryReference(runsRoot, runDirectory);
  if (!lexical.ok) return lexical;
  const reference = rebasedOnRealRunsRoot(lexical.value);
  if (!reference.ok) return reference;
  const directory = reference.value.runDirectory;
  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(directory);
  } catch (error) {
    // ENOENT is the one absent answer, and it says so — the same sentence the
    // not-a-directory branch below uses, because both mean "there is no run
    // here". EACCES, ELOOP (symlink cycle — the attack this module's no-follow
    // discipline exists to refuse), ENOTDIR, and EIO surface their REAL cause
    // instead: "does not exist" on a permission-broken or symlink-swapped run
    // directory sends the operator to recreate a run rather than fix the actual
    // fault. The discrimination was documented here before it was implemented;
    // every errno used to produce the generic message.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return failure("runDirectory", `run directory does not exist: ${directory}`);
    }
    return failure("runDirectory", `cannot inspect run directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stats === undefined || !stats.isDirectory()) {
    return failure("runDirectory", `run directory does not exist: ${directory}`);
  }
  return success(reference.value as RunDirectoryIdentity);
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface RunDirHandle extends ProgramJournal {
  readonly identity: RunDirectoryIdentity;
  readonly runId: OrchestrationRunId;
  readonly runDirectory: string;
  readAuthority(): DomainResult<RunAuthority, RunDirectoryError>;
  registerProgram(registration: unknown): Promise<DomainResult<OrchestrationRunId, RunDirectoryError>>;
  readProgramRegistration(): DomainResult<unknown | null, RunDirectoryError>;
  /** True only when authority, optional program, and otherwise-empty canonical directories are the entire run (`requests/` may contain only the empty `correlators/` child). */
  isPristine(): DomainResult<boolean, RunDirectoryError>;
  publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>>;
  readContext(digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError>;
  reserveRequest(authority: AgentRequestAuthority): Promise<DomainResult<TranscriptReserved, RunDirectoryError>>;
  readIssuedRequests(): DomainResult<readonly AgentRequestAuthority[], RunDirectoryError>;
  readCapturedAttempts(): DomainResult<ReadonlySet<CaptureKey>, RunDirectoryError>;
  /** Atomically mark one attempt terminally rejected; fails if bytes already landed. */
  rejectCapture(authority: AgentRequestAuthority, diagnostic?: string): Promise<DomainResult<CaptureKey, RunDirectoryError>>;
  readCaptureRejection(authority: AgentRequestAuthority): DomainResult<string | null, RunDirectoryError>;
  recordHarnessCorrelator(
    binding: HarnessCorrelatorBinding,
  ): Promise<DomainResult<HarnessCorrelatorBinding, RunDirectoryError>>;
  readHarnessCorrelator(
    harness: HarnessCorrelatorBinding["harness"],
    nativeId: string,
  ): DomainResult<HarnessCorrelatorBinding | null, RunDirectoryError>;
  captureTranscript(
    authority: AgentRequestAuthority,
    bytes: readonly number[],
  ): Promise<DomainResult<ArtifactRef, RunDirectoryError>>;
  /** Read captured bytes back exactly, for parity and byte-equality proofs. */
  readTranscriptBytes(authority: AgentRequestAuthority): DomainResult<Uint8Array, RunDirectoryError>;
  publishArtifactSet(staged: readonly StagedArtifactInput[]): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>>;
  recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>>;
  /** `success(null)` = never recorded; a failure = recorded but unreadable. */
  readReceipt(effectId: EffectId): DomainResult<EffectReceipt | null, RunDirectoryError>;
}

/**
 * Create run subdirectories through descriptors anchored at the run directory.
 *
 * `mkdirSync(path, { recursive: true })` hands the whole path to the kernel,
 * which resolves every intermediate component with ordinary symlink-following
 * semantics. A component swapped to a symlink — the adversary this module's
 * O_NOFOLLOW primitives exist to refuse — would therefore have directories
 * created at the link's TARGET, and that side effect lands before the anchored
 * write that would have refused it. `ensureRelativeDirectoryNoFollow` walks one
 * component at a time under O_NOFOLLOW instead, so directory creation is held
 * to the same anchoring as every read and write here.
 */
function ensureRunSubdirectories(runDirectory: string, targets: readonly string[]): void {
  const root = openDirectoryNoFollow(runDirectory);
  try {
    for (const target of targets) ensureRelativeDirectoryNoFollow(root, runDirectory, target);
  } finally {
    closeAnchoredDirectory(root);
  }
}

function ensureFixedLayout(runDirectory: string): void {
  ensureRunSubdirectories(runDirectory, FIXED_SUBDIRECTORIES.map((child) => join(runDirectory, child)));
}

function digestOf(bytes: readonly number[]): ArtifactDigest {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest;
}

function readJsonNoFollow(path: string): unknown {
  return JSON.parse(readRunFileNoFollow(path)) as unknown;
}

/** The event records only; the retained descriptor also contains the lock. */
function eventFileNames(events: AnchoredDirectory): readonly string[] {
  return listDirectoryNamesNoFollow(events).filter((name) => name.endsWith(".json"));
}

const EVENT_FILE = /^(\d{6,})-([A-Za-z0-9:_-]{1,256})\.json$/;

function readEventRecords(events: AnchoredDirectory): readonly ProgramEventRecord[] {
  const seenDedup = new Set<string>();
  return Object.freeze(eventFileNames(events).map((name, index) => {
    const match = EVENT_FILE.exec(name);
    if (match === null) throw new Error(`Corrupt program event filename ${name}`);
    const filenameSequence = Number(match[1]);
    const filenameDedup = match[2]!;
    if (!Number.isSafeInteger(filenameSequence) || filenameSequence !== index) {
      throw new Error(`Corrupt program event ${name}: sequence prefix is not contiguous from zero`);
    }
    const raw = JSON.parse(readDirectoryFileNoFollow(events, name).toString("utf-8")) as unknown;
    const record = parseProgramEventRecord(raw, name);
    if (record.sequence !== filenameSequence || record.dedupKey !== filenameDedup) {
      throw new Error(`Corrupt program event ${name}: filename does not match record identity`);
    }
    if (seenDedup.has(record.dedupKey)) {
      throw new Error(`Corrupt program event ${name}: duplicate dedup key ${record.dedupKey}`);
    }
    seenDedup.add(record.dedupKey);
    return record;
  }));
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Remove staged bytes that will never be promoted; a leftover is inert but noisy. */
function discardStaged(entries: readonly Readonly<{ staged: string }>[]): void {
  for (const entry of entries) {
    try {
      removeRunFileNoFollow(entry.staged);
    } catch {
      // The set is already abandoned; a leftover staged file publishes nothing.
    }
  }
}

function transcriptSlotPath(runDirectory: string, authority: AgentRequestAuthority): string {
  return join(runDirectory, TRANSCRIPTS, authority.slotId, `attempt-${authority.attempt}.raw`);
}

function correlatorPath(directory: string, harness: HarnessCorrelatorBinding["harness"], nativeId: string): string {
  const key = createHash("sha256").update(`${harness}\0${nativeId}`).digest("hex");
  return join(directory, REQUESTS, CORRELATORS, `${key}.json`);
}

function parseHarnessCorrelatorBinding(raw: unknown): DomainResult<HarnessCorrelatorBinding, RunDirectoryError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("correlator", "harness correlator binding must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== RUN_DIRECTORY_SCHEMA_VERSION ||
      (record["harness"] !== "pi" && record["harness"] !== "claude") ||
      typeof record["nativeId"] !== "string" || record["nativeId"].length === 0 ||
      typeof record["requestId"] !== "string" || record["requestId"].length === 0 ||
      typeof record["role"] !== "string" || record["role"].length === 0 ||
      (record["attempt"] !== 1 && record["attempt"] !== 2)) {
    return failure("correlator", "harness correlator binding violates its field contract");
  }
  return success(canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    harness: record["harness"],
    nativeId: record["nativeId"],
    requestId: record["requestId"] as AgentRequestAuthority["requestId"],
    role: record["role"] as AgentRequestAuthority["role"],
    attempt: record["attempt"],
  }));
}

/**
 * Open a handle over an existing run directory, creating the fixed layout if
 * this is its first use. The authority file is written exactly once: a second
 * open of the same directory reads it rather than replacing it.
 */
export function openRunDirectory(
  runsRoot: string,
  runDirectory: string,
): DomainResult<RunDirHandle, RunDirectoryError> {
  const identity = parseRunDirectoryIdentity(runsRoot, runDirectory);
  if (!identity.ok) return identity;
  const { runId, runDirectory: directory } = identity.value;

  // Prove every hop is a real directory BEFORE creating anything: `resolve`
  // is pure path math and `statSync` follows links, so a symlinked run
  // directory would otherwise have the fixed layout built through it.
  try {
    closeAnchoredDirectory(openDirectoryNoFollow(directory));
  } catch (error) {
    return failure("runDirectory", `run directory is not safely reachable: ${(error as Error).message}`);
  }
  ensureFixedLayout(directory);

  const authorityPath = join(directory, AUTHORITY_FILE);
  const authority: RunAuthority = canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    runId,
    runsRoot: identity.value.runsRoot,
    runDirectory: directory,
  });
  try {
    writeRunFileExclusiveNoFollow(authorityPath, JSON.stringify(authority, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return failure("authority", `cannot claim run authority: ${(error as Error).message}`);
    }
    const existing = readRunAuthority(authority, authorityPath);
    if (!existing.ok) return existing;
  }

  return success(buildHandle(identity.value, authority, directory, authorityPath));
}

/**
 * Create one fresh Run Directory under its runs-root, then open it.
 *
 * `openRunDirectory` requires the directory to already exist, and must keep
 * requiring it: an operation that RESUMES a run has to fail closed when its
 * evidence is gone, because an absent directory is the orphan case that
 * recovery exists to adjudicate — never an invitation to start over silently.
 * The three operations that CREATE a run carry the opposite obligation, and the
 * engine is the only party that knows the fixed layout, so making the caller
 * `mkdir` first was a step whose sole purpose was to satisfy a check the engine
 * itself owns.
 *
 * The runs-root is never created. A run name is chosen fresh per run and a typo
 * costs one empty directory, but a mistyped ROOT would silently grow a whole
 * second tree of runs that no later command would look in, so it stays a loud
 * failure. Creation is anchored exactly like every other write here: the single
 * child component is made through a descriptor held on the root, and an entry
 * already occupied by a symlink is refused rather than followed.
 */
export function createRunDirectory(
  runsRoot: string,
  runDirectory: string,
): DomainResult<RunDirHandle, RunDirectoryError> {
  const lexical = parseRunDirectoryReference(runsRoot, runDirectory);
  if (!lexical.ok) return lexical;
  const reference = rebasedOnRealRunsRoot(lexical.value);
  if (!reference.ok) return reference;
  const { runsRoot: root, runDirectory: directory } = reference.value;
  let anchor: AnchoredDirectory | null = null;
  try {
    anchor = openDirectoryNoFollow(root);
    ensureRelativeDirectoryNoFollow(anchor, root, directory);
  } catch (error) {
    return failure("runDirectory", `cannot create run directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (anchor !== null) closeAnchoredDirectory(anchor);
  }
  return openRunDirectory(root, directory);
}

/**
 * The handle is assembled from one group of operations per concern rather than
 * written as a single object literal. Each group closes over the same proven
 * run identity, so composition changes nothing about what the handle can do —
 * it only keeps each concern small enough to read on its own.
 */
function buildHandle(
  identity: RunDirectoryIdentity,
  authority: RunAuthority,
  directory: string,
  authorityPath: string,
): RunDirHandle {
  const { runId } = authority;
  return Object.freeze({
    identity,
    runId,
    runDirectory: directory,
    readAuthority: (): DomainResult<RunAuthority, RunDirectoryError> =>
      readRunAuthority(authority, authorityPath),
    ...programOperations(runId, directory),
    ...journalOperations(directory),
    ...contextOperations(runId, directory),
    ...requestOperations(runId, directory),
    ...artifactOperations(runId, directory),
    ...receiptOperations(directory),
  });
}

function readRunAuthority(
  expected: RunAuthority,
  authorityPath: string,
): DomainResult<RunAuthority, RunDirectoryError> {
  // The read cause is CARRIED, not discarded. It used to be captured into
  // `{ __unreadable: message }` and then dropped: a sentinel object reaches the
  // schema comparison below, fails it, and the caller is told the authority
  // "does not describe this run" — so EACCES on the run directory, an ELOOP
  // from a symlink swapped under the O_NOFOLLOW read, and genuinely corrupt
  // JSON all report as the same content mismatch. Those need different
  // responses from an operator, and the one that matters most (a symlink race)
  // is the one the generic message hides.
  const read = ((): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; cause: string }> => {
    try {
      return { ok: true, value: readJsonNoFollow(authorityPath) };
    } catch (error) {
      return { ok: false, cause: error instanceof Error ? error.message : String(error) };
    }
  })();
  if (!read.ok) return failure("authority", `run authority is unreadable: ${read.cause}`);
  const raw = read.value;
  if (typeof raw !== "object" || raw === null) return failure("authority", "run authority is unreadable");
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== RUN_DIRECTORY_SCHEMA_VERSION ||
      record["runId"] !== expected.runId ||
      typeof record["runsRoot"] !== "string" ||
      typeof record["runDirectory"] !== "string") {
    return failure("authority", "run authority does not describe this run");
  }
  const parsed = canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    runId: expected.runId,
    runsRoot: resolve(record["runsRoot"]),
    runDirectory: resolve(record["runDirectory"]),
  });
  return canonicalStructuralEquals(parsed, expected)
    ? success(expected)
    : failure("authority", "existing run authority does not match the opened run identity");
}

function programOperations(runId: OrchestrationRunId, directory: string) {
  return {
    async registerProgram(registration: unknown): Promise<DomainResult<OrchestrationRunId, RunDirectoryError>> {
      const body = JSON.stringify(registration);
      const path = join(directory, PROGRAM_FILE);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("program", `cannot register orchestration program: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(path) !== body) {
          return failure("program", "run is already registered under different program authority");
        }
      }
      return success(runId);
    },

    readProgramRegistration(): DomainResult<unknown | null, RunDirectoryError> {
      try {
        return success(JSON.parse(readRunFileNoFollow(join(directory, PROGRAM_FILE))) as unknown);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("program", `orchestration program registration is unreadable: ${(error as Error).message}`);
      }
    },
  };
}

/** Append-only event log plus the checkpoint and progress projections. */
function journalOperations(directory: string) {
  return {
    /**
     * The sequence prefix is the append ORDER, and O_EXCL on the filename
     * cannot arbitrate it: two appenders carrying different dedup keys observe
     * the same directory snapshot, compute the same `events.length`, and write
     * two differently-named files that both claim that sequence. `readEvents`
     * then reconstructs order by sorting filenames, so a collision degrades
     * ordering to a comparison of dedup-key text — unrelated to happens-before
     * — and `replayProgram`/`resumeProgram` fold in that wrong order.
     *
     * The read-count-write is therefore serialized. Exclusivity on the
     * filename still carries idempotency (the dedup key), and the lock carries
     * the ordering claim that a derived count cannot make on its own.
     */
    async appendEvent(record: ProgramEventRecord): Promise<void> {
      const parsedInput = parseProgramEventRecord(record, "append input");
      await withAnchoredDirectoryLock(join(directory, EVENTS), "append.lock", (eventsDirectory) => {
        const events = readEventRecords(eventsDirectory);
        if (events.some((event) => event.dedupKey === parsedInput.dedupKey)) return;
        const sequence = events.length;
        const sequenced = Object.freeze({ ...parsedInput, sequence });
        writeDirectoryFileExclusiveNoFollow(
          eventsDirectory,
          `${String(sequence).padStart(6, "0")}-${sequenced.dedupKey}.json`,
          JSON.stringify(sequenced),
        );
      });
    },

    async readEvents(): Promise<readonly ProgramEventRecord[]> {
      return withAnchoredDirectoryLock(
        join(directory, EVENTS),
        "append.lock",
        (eventsDirectory) => readEventRecords(eventsDirectory),
      );
    },

    /**
     * `null` means the run never wrote a checkpoint. Anything that exists but
     * cannot be READ is a failure, exactly as `readReceipt` treats a receipt:
     * `resumeProgram` short-circuits on `null` and skips the
     * checkpoint-vs-replay corruption check entirely, so collapsing "absent"
     * into "unreadable" would turn an ELOOP from a checkpoint path swapped to a
     * symlink — the very attack the no-follow reads exist to refuse — into a
     * clean resume.
     */
    async readCheckpoint(): Promise<string | null> {
      try {
        return readRunFileNoFollow(join(directory, CHECKPOINT_FILE));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    /** Checkpoints are a projection, so they are replaced through a staged rename. */
    async writeCheckpoint(json: string): Promise<void> {
      const staged = join(directory, `${CHECKPOINT_FILE}.staged`);
      writeRunFileNoFollow(staged, json);
      publishStagedRunFile(staged, join(directory, CHECKPOINT_FILE));
    },

    async writeProgress(percent: number): Promise<void> {
      writeRunFileNoFollow(join(directory, PROGRESS_FILE), JSON.stringify({ percent }));
    },
  };
}

/** Content-addressed context packets. */
function contextOperations(runId: OrchestrationRunId, directory: string) {
  return {
    async publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>> {
      const path = join(directory, CONTEXTS, `${packet.digest}.json`);
      const body = JSON.stringify(packet);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("context", `cannot publish context packet: ${(error as Error).message}`);
        }
        // Content-addressed: an identical digest must carry identical bytes.
        if (readRunFileNoFollow(path) !== body) {
          return failure("context", "a different context packet already occupies this digest");
        }
      }
      return success(canonicalRecord({
        kind: "context-published" as const,
        runId,
        digest: packet.digest,
        slotPath: path,
      }));
    },

    readContext(digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError> {
      // Same rule as `readRunAuthority`: report WHY the read failed instead of
      // handing the parser a sentinel and letting a permission or symlink-race
      // failure surface as a packet-schema complaint.
      const read = ((): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; cause: string }> => {
        try {
          return { ok: true, value: readJsonNoFollow(join(directory, CONTEXTS, `${digest}.json`)) };
        } catch (error) {
          return { ok: false, cause: error instanceof Error ? error.message : String(error) };
        }
      })();
      if (!read.ok) return failure("context", `context packet ${digest} is unreadable: ${read.cause}`);
      const parsed = parseContextPacket(read.value);
      if (!parsed.ok) return failure("context", parsed.error.message);
      if (parsed.value.digest !== digest) return failure("context", "stored context packet digest does not match its slot");
      return success(parsed.value);
    },
  };
}

function readReservedAuthority(
  directory: string,
  requestId: AgentRequestAuthority["requestId"],
): DomainResult<AgentRequestAuthority, RunDirectoryError> {
  const requestPath = join(directory, REQUESTS, `${requestId}.json`);
  let rawReservation: unknown;
  try {
    rawReservation = JSON.parse(readRunFileNoFollow(requestPath)) as unknown;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? failure("request", `request ${requestId} was never reserved`)
      : failure("request", `request ${requestId} authority is unreadable: ${(error as Error).message}`);
  }
  const reserved = parseStoredAgentRequestAuthority(rawReservation);
  return reserved.ok
    ? success(reserved.value)
    : failure("request", `request ${requestId} authority is malformed: ${reserved.error.violations.map(({ message }) => message).join("; ")}`);
}

/** Request reservations and their exclusive transcript slots. */
function requestOperations(runId: OrchestrationRunId, directory: string) {
  return {
    /**
     * Reserve one request's authority and transcript slot before it can be
     * spawned. Exclusive creation makes the reservation the proof: a second
     * reservation of the same request cannot silently overwrite the first.
     */
    async reserveRequest(authority: AgentRequestAuthority): Promise<DomainResult<TranscriptReserved, RunDirectoryError>> {
      const parsed = parseStoredAgentRequestAuthority(authority);
      if (!parsed.ok) {
        return failure("request", `request authority is malformed: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
      }
      const request = parsed.value;
      if (request.runId !== runId) return failure("request", "request authority belongs to a different run");
      const requestPath = join(directory, REQUESTS, `${request.requestId}.json`);
      const body = JSON.stringify(request);
      try {
        writeRunFileExclusiveNoFollow(requestPath, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("request", `cannot reserve request authority: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(requestPath) !== body) {
          return failure("request", `request ${request.requestId} is already reserved under different authority`);
        }
      }
      // Anchored creation REFUSES a symlinked or otherwise unsafe component
      // rather than following it, so this is a reachable failure and belongs in
      // the result channel: a throw here would escape the DomainResult contract
      // every other refusal in this handle honours.
      try {
        ensureRunSubdirectories(directory, [join(directory, TRANSCRIPTS, request.slotId)]);
      } catch (error) {
        return failure("request", `cannot reserve transcript slot: ${(error as Error).message}`);
      }
      return success(canonicalRecord({
        kind: "transcript-reserved" as const,
        runId,
        requestId: request.requestId,
        slotPath: transcriptSlotPath(directory, request),
      }));
    },

    readIssuedRequests(): DomainResult<readonly AgentRequestAuthority[], RunDirectoryError> {
      let requests: AnchoredDirectory | null = null;
      try {
        requests = openDirectoryNoFollow(join(directory, REQUESTS));
        const issued: AgentRequestAuthority[] = [];
        for (const name of listDirectoryNamesNoFollow(requests)) {
          if (!name.endsWith(".json")) continue;
          let raw: unknown;
          try {
            raw = JSON.parse(readDirectoryFileNoFollow(requests, name).toString("utf-8")) as unknown;
          } catch (error) {
            return failure("request", `request authority ${name} is unreadable: ${(error as Error).message}`);
          }
          const parsed = parseStoredAgentRequestAuthority(raw);
          if (!parsed.ok) {
            return failure("request", `request authority ${name} is malformed: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
          }
          if (parsed.value.runId !== runId) {
            return failure("request", `request authority ${name} belongs to a different run`);
          }
          issued.push(parsed.value);
        }
        return success(Object.freeze(issued));
      } catch (error) {
        return failure("request", `cannot inspect issued requests safely: ${(error as Error).message}`);
      } finally {
        if (requests !== null) closeAnchoredDirectory(requests);
      }
    },

    readCapturedAttempts(): DomainResult<ReadonlySet<CaptureKey>, RunDirectoryError> {
      let transcripts: AnchoredDirectory | null = null;
      try {
        transcripts = openDirectoryNoFollow(join(directory, TRANSCRIPTS));
        const captured = new Set<CaptureKey>();
        for (const slot of listDirectoryNamesNoFollow(transcripts)) {
          if (slot === "capture.lock" || slot === "capture.lock.recovery" || slot.startsWith("capture.lock.tomb-")) continue;
          let slotDirectory: AnchoredDirectory | null = null;
          try {
            slotDirectory = openChildDirectoryNoFollow(transcripts, slot);
            for (const name of listDirectoryNamesNoFollow(slotDirectory)) {
              const match = /^attempt-(1|2)\.raw$/.exec(name);
              if (match !== null) captured.add(captureKey(slot, Number(match[1]) as 1 | 2));
            }
          } catch (error) {
            return failure(
              "transcript",
              `cannot inspect transcript slot ${slot} safely: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            if (slotDirectory !== null) closeAnchoredDirectory(slotDirectory);
          }
        }
        return success(captured);
      } catch (error) {
        return failure("transcript", `cannot inspect captured attempts safely: ${(error as Error).message}`);
      } finally {
        if (transcripts !== null) closeAnchoredDirectory(transcripts);
      }
    },

    async rejectCapture(authority: AgentRequestAuthority, diagnostic = "capture was rejected without a diagnostic"): Promise<DomainResult<CaptureKey, RunDirectoryError>> {
      const supplied = parseStoredAgentRequestAuthority(authority);
      if (!supplied.ok) {
        return failure("request", `capture rejection authority is malformed: ${supplied.error.violations.map(({ message }) => message).join("; ")}`);
      }
      if (supplied.value.runId !== runId) return failure("request", "capture rejection authority belongs to a different run");
      const reserved = readReservedAuthority(directory, supplied.value.requestId);
      if (!reserved.ok) return reserved;
      if (!canonicalStructuralEquals(reserved.value, supplied.value)) {
        return failure("request", `request ${supplied.value.requestId} rejection authority does not match its immutable reservation`);
      }
      const key = captureKey(supplied.value.slotId, supplied.value.attempt);
      try {
        await withAnchoredDirectoryLock(join(directory, TRANSCRIPTS), "capture.lock", (transcriptsDirectory) => {
          const slotDirectory = openChildDirectoryNoFollow(transcriptsDirectory, supplied.value.slotId);
          try {
            const rawName = `attempt-${supplied.value.attempt}.raw`;
            try {
              readDirectoryFileNoFollow(slotDirectory, rawName);
              throw new Error(`attempt ${supplied.value.attempt} for slot ${supplied.value.slotId} is already captured`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const markerName = `attempt-${supplied.value.attempt}.rejected`;
            try {
              writeDirectoryFileExclusiveNoFollow(slotDirectory, markerName, JSON.stringify({
                requestId: supplied.value.requestId,
                diagnostic,
              }));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              const existing = JSON.parse(readDirectoryFileNoFollow(slotDirectory, markerName).toString("utf8")) as unknown;
              if (typeof existing !== "object" || existing === null ||
                  (existing as Record<string, unknown>).requestId !== supplied.value.requestId) throw error;
            }
          } finally {
            closeAnchoredDirectory(slotDirectory);
          }
        });
        return success(key);
      } catch (error) {
        return failure("transcript", `cannot reject capture safely: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    readCaptureRejection(authority: AgentRequestAuthority): DomainResult<string | null, RunDirectoryError> {
      const supplied = parseStoredAgentRequestAuthority(authority);
      if (!supplied.ok) return failure("request", `capture rejection authority is malformed: ${supplied.error.violations.map(({ message }) => message).join("; ")}`);
      try {
        const raw = JSON.parse(readRunFileNoFollow(join(
          directory, TRANSCRIPTS, supplied.value.slotId, `attempt-${supplied.value.attempt}.rejected`,
        ))) as unknown;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
            (raw as Record<string, unknown>).requestId !== supplied.value.requestId ||
            typeof (raw as Record<string, unknown>).diagnostic !== "string") {
          return failure("transcript", "capture rejection marker is malformed or belongs to different authority");
        }
        return success((raw as Record<string, unknown>).diagnostic as string);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("transcript", `cannot read capture rejection marker safely: ${(error as Error).message}`);
      }
    },

    isPristine(): DomainResult<boolean, RunDirectoryError> {
      let root: AnchoredDirectory | null = null;
      try {
        root = openDirectoryNoFollow(directory);
        const allowedRoot = new Set([AUTHORITY_FILE, PROGRAM_FILE, ...FIXED_SUBDIRECTORIES.map((path) => path.split("/")[0]!) ]);
        const rootEntries = listDirectoryNamesNoFollow(root);
        if (rootEntries.some((entry) => !allowedRoot.has(entry))) return success(false);
        for (const relative of FIXED_SUBDIRECTORIES) {
          let child: AnchoredDirectory | null = null;
          try {
            child = openDirectoryNoFollow(join(directory, relative));
            const allowed = relative === REQUESTS ? new Set([CORRELATORS]) : new Set<string>();
            if (listDirectoryNamesNoFollow(child).some((entry) => !allowed.has(entry))) return success(false);
          } finally {
            if (child !== null) closeAnchoredDirectory(child);
          }
        }
        return success(true);
      } catch (error) {
        return failure("pristine", `cannot prove replacement run pristine: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (root !== null) closeAnchoredDirectory(root);
      }
    },

    async recordHarnessCorrelator(
      binding: HarnessCorrelatorBinding,
    ): Promise<DomainResult<HarnessCorrelatorBinding, RunDirectoryError>> {
      const parsed = parseHarnessCorrelatorBinding(binding);
      if (!parsed.ok) return parsed;
      const reserved = readReservedAuthority(directory, parsed.value.requestId);
      if (!reserved.ok) return reserved;
      if (reserved.value.attempt !== parsed.value.attempt) {
        return failure("correlator", `correlator attempt does not match request ${parsed.value.requestId}`);
      }
      if (reserved.value.role !== parsed.value.role) {
        return failure("correlator", `correlator role ${parsed.value.role} does not match request ${parsed.value.requestId}/${reserved.value.role}`);
      }
      const path = correlatorPath(directory, parsed.value.harness, parsed.value.nativeId);
      const body = JSON.stringify(parsed.value);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("correlator", `cannot record harness correlator: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(path) !== body) {
          return failure("correlator", "native harness correlator is already bound to different request authority");
        }
      }
      return success(parsed.value);
    },

    readHarnessCorrelator(
      harness: HarnessCorrelatorBinding["harness"],
      nativeId: string,
    ): DomainResult<HarnessCorrelatorBinding | null, RunDirectoryError> {
      if ((harness !== "pi" && harness !== "claude") || nativeId.length === 0) return success(null);
      const path = correlatorPath(directory, harness, nativeId);
      let raw: unknown;
      try {
        raw = JSON.parse(readRunFileNoFollow(path)) as unknown;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("correlator", `harness correlator authority is unreadable: ${(error as Error).message}`);
      }
      const parsed = parseHarnessCorrelatorBinding(raw);
      if (!parsed.ok) return parsed;
      return parsed.value.harness === harness && parsed.value.nativeId === nativeId
        ? success(parsed.value)
        : failure("correlator", "stored harness correlator does not match its immutable lookup identity");
    },

    /**
     * Write the exact harness bytes into the reserved attempt slot. The slot is
     * exclusive: a late or duplicate capture for an attempt that already landed
     * is refused rather than allowed to replace accepted evidence.
     */
    async captureTranscript(
      authority: AgentRequestAuthority,
      bytes: readonly number[],
    ): Promise<DomainResult<ArtifactRef, RunDirectoryError>> {
      const supplied = parseStoredAgentRequestAuthority(authority);
      if (!supplied.ok) {
        return failure("request", `capture authority is malformed: ${supplied.error.violations.map(({ message }) => message).join("; ")}`);
      }
      if (supplied.value.runId !== runId) return failure("request", "capture authority belongs to a different run");
      const reserved = readReservedAuthority(directory, supplied.value.requestId);
      if (!reserved.ok) return reserved;
      if (!canonicalStructuralEquals(reserved.value, supplied.value)) {
        return failure("request", `request ${supplied.value.requestId} capture authority does not match its immutable reservation`);
      }
      try {
        return await withAnchoredDirectoryLock(join(directory, TRANSCRIPTS), "capture.lock", (transcriptsDirectory) => {
          const slotDirectory = openChildDirectoryNoFollow(transcriptsDirectory, supplied.value.slotId);
          try {
            const rejectionName = `attempt-${supplied.value.attempt}.rejected`;
            try {
                const rejected = JSON.parse(readDirectoryFileNoFollow(slotDirectory, rejectionName).toString("utf8")) as unknown;
              if (typeof rejected !== "object" || rejected === null ||
                  (rejected as Record<string, unknown>).requestId !== supplied.value.requestId) {
                return failure("transcript", "capture rejection marker does not match immutable request authority");
              }
              return failure("transcript", `attempt ${supplied.value.attempt} for slot ${supplied.value.slotId} is terminally rejected`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return failure("transcript", `cannot inspect capture rejection marker safely: ${(error as Error).message}`);
              }
            }
            const rawName = `attempt-${supplied.value.attempt}.raw`;
            const stagedName = `${rawName}.staged-${process.pid}-${createHash("sha256").update(Uint8Array.from(bytes)).digest("hex").slice(0, 16)}`;
            try {
              writeDirectoryFileExclusiveNoFollow(slotDirectory, stagedName, Uint8Array.from(bytes));
              // link(2) is the no-overwrite atomic publication point: the
              // fully-written staged inode becomes visible at rawName, while
              // EEXIST preserves the previously published attempt.
              linkSync(anchoredChildPath(slotDirectory, stagedName), anchoredChildPath(slotDirectory, rawName));
              unlinkSync(anchoredChildPath(slotDirectory, stagedName));
            } catch (error) {
              try { unlinkSync(anchoredChildPath(slotDirectory, stagedName)); } catch { /* inert staged cleanup */ }
              return failure("transcript", (error as NodeJS.ErrnoException).code === "EEXIST"
                ? `attempt ${supplied.value.attempt} for slot ${supplied.value.slotId} is already captured`
                : `cannot capture transcript: ${(error as Error).message}`);
            }
            const byteLength = parseArtifactByteLength(bytes.length);
            if (!byteLength.ok) return failure("transcript", byteLength.error.message);
            return success(canonicalRecord({
              runId,
              slot: canonicalRecord({
                kind: "fixed-artifact-slot" as const,
                path: `${TRANSCRIPTS}/${supplied.value.slotId}/attempt-${supplied.value.attempt}.raw`,
              }),
              digest: digestOf(bytes),
              byteLength: byteLength.value,
            }));
          } finally {
            closeAnchoredDirectory(slotDirectory);
          }
        });
      } catch (error) {
        return failure("transcript", `cannot capture transcript safely: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    readTranscriptBytes(authority: AgentRequestAuthority): DomainResult<Uint8Array, RunDirectoryError> {
      try {
        return success(new Uint8Array(readRunBytesNoFollow(transcriptSlotPath(directory, authority))));
      } catch (error) {
        return failure("transcript", `cannot read captured transcript: ${(error as Error).message}`);
      }
    },
  };
}

type StagedPair = Readonly<{ staged: string; final: string }>;

/** Write every member beside its final name; a fault discards the whole set. */
function stageArtifactSet(
  directory: string,
  staged: readonly StagedArtifactInput[],
): DomainResult<readonly StagedPair[], RunDirectoryError> {
  const parsedArtifacts: StagedArtifact[] = [];
  const destinations = new Set<string>();
  for (const artifact of staged) {
    const parsed = createStagedArtifact(artifact.relativePath, artifact.bytes);
    if (!parsed.ok) return parsed;
    if (destinations.has(parsed.value.relativePath)) {
      return failure("artifacts", `artifact destination is duplicated: ${parsed.value.relativePath}`);
    }
    destinations.add(parsed.value.relativePath);
    parsedArtifacts.push(parsed.value);
  }

  const stagedPaths: StagedPair[] = [];
  const publicationId = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}:${parsedArtifacts.map(({ relativePath }) => relativePath).join("\0")}`)
    .digest("hex")
    .slice(0, 24);
  try {
    for (const artifact of parsedArtifacts) {
      const final = join(directory, ARTIFACTS, artifact.relativePath);
      ensureRunSubdirectories(directory, [resolve(final, "..")]);
      const stagedPath = `${final}.staged-${publicationId}`;
      writeRunBytesExclusiveNoFollow(stagedPath, Uint8Array.from(artifact.bytes));
      stagedPaths.push({ staged: stagedPath, final });
    }
  } catch (error) {
    discardStaged(stagedPaths);
    return failure("artifacts", `cannot stage artifact set: ${(error as Error).message}`);
  }
  return success(Object.freeze(stagedPaths));
}

/**
 * Read an already-occupied artifact slot for the byte comparison below.
 * `null` means the slot is free; a slot that exists but cannot be read is a
 * distinct, non-empty result so it can never be mistaken for a free slot.
 */
function occupiedArtifactBytes(path: string): Uint8Array | Readonly<{ __unreadable: string }> | null {
  try {
    return readRunBytesNoFollow(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : Object.freeze({ __unreadable: (error as Error).message });
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * True only when the staged bytes are provably identical to what already
 * occupies the slot. A staged file that cannot be read answers `false`, so an
 * unreadable member refuses the promotion instead of licensing an overwrite.
 */
function stagedBytesMatch(stagedPath: string, occupied: Uint8Array): boolean {
  try {
    return sameBytes(occupied, readRunBytesNoFollow(stagedPath));
  } catch {
    return false;
  }
}

/**
 * Promote a fully staged set. Every target is checked BEFORE any rename,
 * because renaming is the one step that cannot be undone member-by-member —
 * ruling out the predictable failures while the set is still entirely staged
 * is what keeps "all or none" true rather than merely intended.
 *
 * `renameSync` replaces an existing regular file, so the O_EXCL immutability
 * this module promises has to be enforced here explicitly: an occupied slot is
 * refused unless its bytes are already identical to what would be written, in
 * which case the promotion is a no-op replay rather than a rewrite of history.
 *
 * EXPORTED for tests. The rename loop's recovery arm handles the failures the
 * pre-checks cannot rule out — a concurrently removed parent, an EIO — which by
 * construction cannot be provoked through the lock-protected
 * `publishArtifactSet` path: every failure reachable from outside is one the
 * pre-checks turn into an all-staged refusal first. Driving this function
 * directly with explicit staged pairs is therefore the only way to prove the
 * partial-promotion arm behaves, and an unproven recovery arm is how "all or
 * none" quietly stops being true.
 */
export function promoteArtifactSet(
  stagedPaths: readonly StagedPair[],
): DomainResult<readonly StagedPair[], RunDirectoryError> {
  const blocked = stagedPaths.find((entry) => isExistingDirectory(entry.final));
  if (blocked !== undefined) {
    discardStaged(stagedPaths);
    return failure("artifacts", `artifact slot is occupied by a directory: ${blocked.final}`);
  }

  for (const entry of stagedPaths) {
    const occupied = occupiedArtifactBytes(entry.final);
    if (occupied === null) continue;
    const reason = !(occupied instanceof Uint8Array)
      ? `artifact slot is occupied by unreadable bytes: ${entry.final}`
      : !stagedBytesMatch(entry.staged, occupied)
        ? `a different artifact already occupies this slot: ${entry.final}`
        : null;
    if (reason !== null) {
      discardStaged(stagedPaths);
      return failure("artifacts", reason);
    }
  }

  // A failure here must still not report success. Any member already promoted
  // stays on disk but is inert: nothing treats a set as published until its
  // receipt is recorded, and the effect runner records that receipt only on a
  // successful return.
  for (const [index, entry] of stagedPaths.entries()) {
    try {
      publishStagedRunFile(entry.staged, entry.final);
    } catch (error) {
      discardStaged(stagedPaths.slice(index));
      return failure("artifacts", `cannot publish artifact set: ${(error as Error).message}`);
    }
  }
  return success(stagedPaths);
}

/** All-or-nothing artifact set publication. */
function artifactOperations(runId: OrchestrationRunId, directory: string) {
  return {
    /**
     * Publish a whole artifact set or none of it. Every member is staged first
     * and only renamed into place once all of them are on disk, so a fault
     * mid-set never leaves a partially published set behind.
     */
    async publishArtifactSet(
      staged: readonly StagedArtifactInput[],
    ): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>> {
      if (staged.length === 0) return failure("artifacts", "an artifact set must not be empty");

      try {
        return await withAnchoredDirectoryLock(join(directory, ARTIFACTS), "publish.lock", async () => {
        const stagedPaths = stageArtifactSet(directory, staged);
        if (!stagedPaths.ok) return stagedPaths;
        const promoted = promoteArtifactSet(stagedPaths.value);
        if (!promoted.ok) return promoted;

        const refs: ArtifactRef[] = [];
        for (const input of staged) {
          const parsed = createStagedArtifact(input.relativePath, input.bytes);
          if (!parsed.ok) return parsed;
          const artifact = parsed.value;
          let publishedBytes: Uint8Array;
          try {
            publishedBytes = readRunBytesNoFollow(join(directory, ARTIFACTS, artifact.relativePath));
          } catch (error) {
            return failure("artifacts", `cannot verify published artifact ${artifact.relativePath}: ${(error as Error).message}`);
          }
          const byteLength = parseArtifactByteLength(publishedBytes.length);
          if (!byteLength.ok) return failure("artifacts", byteLength.error.message);
          refs.push(canonicalRecord({
            runId,
            slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `${ARTIFACTS}/${artifact.relativePath}` }),
            digest: digestOf([...publishedBytes]),
            byteLength: byteLength.value,
          }));
        }
        return success(Object.freeze(refs));
        });
      } catch (error) {
        return failure("artifacts", `cannot lock artifact publication safely: ${(error as Error).message}`);
      }
    },
  };
}

/** Typed effect receipts, recorded once under their own effect id. */
function receiptOperations(directory: string) {
  return {
    async recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>> {
      const path = join(directory, RECEIPTS, `${receipt.effectId}.json`);
      const body = JSON.stringify(receipt);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("receipt", `cannot record receipt: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(path) !== body) {
          return failure("receipt", `effect ${receipt.effectId} already recorded a different receipt`);
        }
      }
      return success(receipt.effectId);
    },

    /**
     * `success(null)` means the effect never recorded a receipt; anything that
     * exists but cannot be read or parsed is a failure. Collapsing the two
     * would let a truncated receipt read as "never ran", and the effect runner
     * would re-execute an effect it already performed.
     */
    readReceipt(effectId: EffectId): DomainResult<EffectReceipt | null, RunDirectoryError> {
      const path = join(directory, RECEIPTS, `${effectId}.json`);
      try {
        return success(readJsonNoFollow(path) as EffectReceipt);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("receipt", `receipt for effect ${effectId} is unreadable: ${(error as Error).message}`);
      }
    },
  };
}

/** Exposed for the handle's own use and for callers proving anchored access. */
export { anchoredChildPath };
