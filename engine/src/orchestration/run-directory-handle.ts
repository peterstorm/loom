/**
 * Anchored run-directory handle.
 *
 * The handle exposes a FIXED set of operations over one proven run directory
 * and no arbitrary filesystem-path API. Most writes land in slots the layout
 * names; `publishArtifactSet` additionally accepts parser-proven relative
 * destinations confined beneath the fixed `artifacts/` namespace. No caller
 * can redirect bytes outside the run or into its protected authority slots.
 *
 * Layout:
 *   authority.json                     immutable run/roster/root authority
 *   abandoned.json                     immutable operator retirement marker
 *   program.json                       immutable registered program input
 *   progress.json                      mutable operator-facing progress view
 *   checkpoint.json                    atomic projection, not primary history
 *   events/<sequence>-<dedup>.json     immutable domain events
 *   requests/<request-id>.json         immutable request authority
 *   requests/correlators/<digest>.json immutable native-id/request binding
 *   contexts/<digest>.json             complete immutable context packets
 *   transcripts/<slot>/attempt-<n>.raw exact harness bytes
 *   transcripts/<slot>/attempt-<n>.rejected immutable terminal capture refusal
 *   receipts/<effect-id>.json          typed effect/publication receipts
 *   artifacts/...                      domain artifacts and final outputs
 *
 * On Linux, immutable artifacts are written with O_EXCL through a descriptor
 * anchored at their parent. On Darwin, Node exposes no openat-style child API,
 * so the same operations use an O_NOFOLLOW_ANY-proven parent pathname and retain
 * the module's documented post-acquisition parent-swap risk. Two slots reach
 * immutability by a different route and say so at their own call sites:
 * transcripts land via `linkSync` (EEXIST from the link itself), and promoted
 * artifacts via `renameSync` plus an explicit byte comparison, because
 * `rename` has no O_EXCL.
 */

import { createHash } from "node:crypto";
import { linkSync, lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  parseEffectReceipt,
  parseStoredAgentRequestAuthority,
  parseArtifactByteLength,
  parseContextDigest,
  parseOrchestrationRunId,
  parseRequestId,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type ArtifactRef,
  type ContextDigest,
  type DomainResult,
  type EffectId,
  type EffectReceipt,
  type OrchestrationRunId,
} from "../core/orchestration-contract";
import { captureKey, type CaptureKey } from "../core/harness-capture";
import { parseSemanticAttempt } from "../core/implementation-completion";
import { canonicalJson, parseJsonValue } from "../core/review-packet";
import type { ContextPacket } from "./context-packets";
import { parseContextPacket } from "./context-packets";
import {
  ensureRelativeDirectoryNoFollow,
  listDirectoryNamesNoFollow,
  openChildDirectoryNoFollow,
  openDirectoryNoFollow,
  anchoredChildPath,
  closeAnchorGuarded,
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
const ABANDONMENT_FILE = "abandoned.json";

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

type AnchoredOutcome<T> =
  | Readonly<{ kind: "returned"; value: T }>
  | Readonly<{ kind: "threw"; error: unknown }>;

function errorDetail(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorDetail).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Own one anchor from acquisition through guarded release. */
function withOwnedAnchor<T>(
  acquire: () => AnchoredDirectory,
  operation: string,
  use: (directory: AnchoredDirectory) => T,
): T {
  const directory = acquire();
  let outcome: AnchoredOutcome<T>;
  try {
    outcome = { kind: "returned", value: use(directory) };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  if (outcome.kind === "threw") {
    const settled = closeAnchorGuarded(directory, outcome.error, operation);
    if (settled instanceof AggregateError) {
      throw new AggregateError(settled.errors, errorDetail(settled));
    }
    throw settled ?? outcome.error;
  }
  const closeError = closeAnchorGuarded(directory, null, operation);
  if (closeError !== null) throw closeError;
  return outcome.value;
}

/** Immutable run authority, written once when the directory is created. */
export type RunAuthority = Readonly<{
  schemaVersion: typeof RUN_DIRECTORY_SCHEMA_VERSION;
  runId: OrchestrationRunId;
  runsRoot: string;
  runDirectory: string;
}>;

/**
 * An operator's terminal decision that a run is finished with, and by what.
 *
 * A run directory is never deleted — it holds the evidence of why it ended the
 * way it did — so a superseded run stays in the listing forever with nothing in
 * it pointing at its replacement. The only record used to be the parent
 * session's notes, which the next operator does not have.
 *
 * Written O_EXCL and compared byte-for-byte on re-write, so the marker is
 * immutable once placed: abandonment is terminal, and a run that could be
 * re-abandoned under a different replacement would make the pointer a guess.
 * It carries no timestamp for the same reason — a clock reading would make two
 * identical abandonments differ and turn the idempotent repeat into a conflict.
 *
 * It is deliberately NOT a program event. The event log is folded by each
 * program's machine on every replay, and a record no machine has a transition
 * for is a corruption risk in the one file the run cannot afford to lose. This
 * is metadata ABOUT the run, so it sits beside the authority instead.
 */
export type RunAbandonment = Readonly<{
  schemaVersion: typeof RUN_DIRECTORY_SCHEMA_VERSION;
  kind: "run-abandoned";
  runId: OrchestrationRunId;
  /** The run that replaces this one, or `null` when nothing does. */
  supersededBy: OrchestrationRunId | null;
  reason: string;
}>;

export type RunAbandonmentInput = Readonly<{
  supersededBy: string | null;
  reason: string;
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

function copiedBytes(bytes: readonly number[]): readonly number[] | null {
  if (!Array.isArray(bytes)) return null;
  const copy = Array.from(bytes);
  return copy.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? Object.freeze(copy)
    : null;
}

export function createStagedArtifact(
  relativePath: unknown,
  bytes: readonly number[],
): DomainResult<StagedArtifact, RunDirectoryError> {
  const parsedPath = parseArtifactRelativePath(relativePath);
  if (!parsedPath.ok) return parsedPath;
  const parsedBytes = copiedBytes(bytes);
  if (parsedBytes === null) {
    return failure("artifacts", "staged artifact bytes must be integers from 0 through 255");
  }
  return success(Object.freeze({ relativePath: parsedPath.value, bytes: parsedBytes }));
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
 * The rebase happens BEFORE the anchored walk, so a runs root that traverses a
 * symlink is rewritten to its real path here rather than refused by the walk:
 * any root that worked before keeps working, and everything BELOW the resolved
 * base is held to the strict no-symlink rule.
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
 * exist. Both are resolved and compared as strings. This parser retains only
 * pathname identity: each Linux operation becomes descriptor-anchored after
 * acquisition, but a pathname replacement between operations can redirect a
 * later acquisition. Darwin re-opens with O_NOFOLLOW_ANY through the proven
 * pathname and retains the documented post-acquisition parent-swap risk.
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
  let stats: ReturnType<typeof statSync>;
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
  if (!stats.isDirectory()) {
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
  /** Terminal, immutable, and idempotent on identical input; never deletes anything. */
  abandonRun(input: RunAbandonmentInput): Promise<DomainResult<RunAbandonment, RunDirectoryError>>;
  /** `success(null)` = never abandoned; a failure = marked but unreadable. */
  readAbandonment(): DomainResult<RunAbandonment | null, RunDirectoryError>;
  /** True only when authority, optional program, and otherwise-empty canonical directories are the entire run (`requests/` may contain only the empty `correlators/` child). */
  isPristine(): DomainResult<boolean, RunDirectoryError>;
  publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>>;
  readContext(digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError>;
  publishDecisionContext(
    digest: ContextDigest,
    bytes: readonly number[],
  ): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>>;
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
  /** Read one parser-proven immutable artifact slot; null means only that the slot is absent. */
  readArtifactBytes(relativePath: unknown): DomainResult<Uint8Array | null, RunDirectoryError>;
  publishArtifactSet(staged: readonly StagedArtifactInput[]): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>>;
  recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>>;
  /** `success(null)` = never recorded; a failure = recorded but unreadable. */
  readReceipt(effectId: EffectId): DomainResult<EffectReceipt | null, RunDirectoryError>;
}

/**
 * Create run subdirectories one proven component at a time.
 *
 * `mkdirSync(path, { recursive: true })` hands the whole path to the kernel,
 * which resolves every intermediate component with ordinary symlink-following
 * semantics. A component swapped to a symlink — the adversary this module's
 * no-follow primitives exist to refuse — would therefore have directories
 * created at the link's TARGET before the anchored write refused it. On Linux,
 * `ensureRelativeDirectoryNoFollow` addresses mkdir through the retained parent
 * descriptor. On Darwin, where Node exposes no `mkdirat`, it proves the parent
 * identity with `O_NOFOLLOW_ANY`, performs pathname mkdir, then no-follow opens
 * the child before using it as the next parent.
 */
function ensureRunSubdirectories(runDirectory: string, targets: readonly string[]): void {
  withOwnedAnchor(
    () => openDirectoryNoFollow(runDirectory),
    `subdirectory creation under ${runDirectory}`,
    (root) => {
      for (const target of targets) ensureRelativeDirectoryNoFollow(root, runDirectory, target);
    },
  );
}

function ensureFixedLayout(runDirectory: string): void {
  ensureRunSubdirectories(runDirectory, FIXED_SUBDIRECTORIES.map((child) => join(runDirectory, child)));
}

function digestOf(bytes: readonly number[]): ArtifactDigest {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest;
}

function contextDigestOf(bytes: readonly number[]): ContextDigest {
  const parsed = parseContextDigest(digestOf(bytes));
  if (!parsed.ok) throw new Error("internal context digest construction failed");
  return parsed.value;
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

function inspectExistingDirectory(path: string): DomainResult<boolean, RunDirectoryError> {
  try {
    return success(statSync(path).isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success(false);
    return failure(
      "artifacts",
      `cannot inspect artifact slot ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Remove staged bytes that will never be promoted and retain every real cleanup failure. */
function discardStaged(entries: readonly Readonly<{ staged: string }>[]): readonly string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      removeRunFileNoFollow(entry.staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failures.push(`${entry.staged}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return Object.freeze(failures);
}

function cleanupFailureSuffix(failures: readonly string[]): string {
  return failures.length === 0 ? "" : `; staged cleanup failed: ${failures.join("; ")}`;
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
      typeof record["role"] !== "string" || record["role"].length === 0 ||
      (record["attempt"] !== 1 && record["attempt"] !== 2)) {
    return failure("correlator", "harness correlator binding violates its field contract");
  }
  const requestId = parseRequestId(record["requestId"]);
  if (!requestId.ok) return failure("correlator", requestId.error.message);
  return success(canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    harness: record["harness"],
    nativeId: record["nativeId"],
    requestId: requestId.value,
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

  // Identity parsing proves a direct child with existing-directory shape;
  // `openDirectoryNoFollow` supplies the no-symlink authority before any fixed
  // layout can be created through that child.
  try {
    withOwnedAnchor(() => openDirectoryNoFollow(directory), `layout probe for ${directory}`, () => undefined);
    ensureFixedLayout(directory);
  } catch (error) {
    return failure(
      "runDirectory",
      `run directory layout is not safely reachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
 * failure. Linux creates the child relative to the retained root descriptor.
 * Darwin proves the retained root's pathname identity with `O_NOFOLLOW_ANY`,
 * performs pathname mkdir, and no-follow opens the child; an entry already
 * occupied by a symlink is refused rather than followed on both platforms.
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
  try {
    withOwnedAnchor(
      () => openDirectoryNoFollow(root),
      `run directory creation for ${directory}`,
      (anchor) => ensureRelativeDirectoryNoFollow(anchor, root, directory),
    );
  } catch (error) {
    return failure("runDirectory", `cannot create run directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
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
    ...abandonmentOperations(runId, directory),
    ...journalOperations(directory),
    ...contextOperations(runId, directory),
    ...requestOperations(runId, directory),
    ...artifactOperations(runId, identity.runsRoot, directory),
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

/**
 * Write `body` to `path` exactly once, treating a byte-identical repeat as the
 * idempotent retry it is and anything else as a conflicting second claim.
 *
 * Six operations — program registration, abandonment, context publication,
 * request reservation, correlator binding, receipt recording — each hand-rolled
 * this same "write exclusive; on EEXIST read back and compare bytes" idiom. It
 * is the run directory's whole write-once discipline, and six copies of it is
 * six chances for one to compare the wrong thing, or to treat a genuine write
 * error as a conflict. They differ only in the field name and the two
 * diagnostics, so those are the parameters.
 */
function claimIdempotentWrite(
  path: string,
  body: string,
  field: string,
  writeFailure: (cause: string) => string,
  conflict: string,
): DomainResult<void, RunDirectoryError> {
  try {
    writeRunFileExclusiveNoFollow(path, body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return failure(field, writeFailure((error as Error).message));
    }
    try {
      if (readRunFileNoFollow(path) !== body) return failure(field, conflict);
    } catch (readError) {
      return failure(field, writeFailure((readError as Error).message));
    }
  }
  return success(undefined);
}

/**
 * The registered program as CANONICAL bytes.
 *
 * This wrote `JSON.stringify(registration)` — the CALLER's key order — while
 * the slot is claimed by byte comparison. Re-registering the same program built
 * from a different literal order therefore failed that comparison and was
 * reported as "already registered under different program authority": a
 * non-idempotent replay of an immutable slot. Parsing to JSON data and
 * re-serialising through `canonicalJson` makes the stored bytes a function of
 * the program alone, and makes non-JSON input a refusal instead of a silently
 * lossy `undefined` body.
 */
function canonicalProgramBody(registration: unknown): DomainResult<string, RunDirectoryError> {
  const parsed = parseJsonValue(registration, "program");
  return parsed.ok
    ? success(canonicalJson(parsed.value))
    : failure("program", `orchestration program registration is not JSON data: ${parsed.errors.join("; ")}`);
}

function programOperations(runId: OrchestrationRunId, directory: string) {
  return {
    async registerProgram(registration: unknown): Promise<DomainResult<OrchestrationRunId, RunDirectoryError>> {
      const canonical = canonicalProgramBody(registration);
      if (!canonical.ok) return canonical;
      const path = join(directory, PROGRAM_FILE);
      const claimed = claimIdempotentWrite(path, canonical.value, "program",
        (cause) => `cannot register orchestration program: ${cause}`,
        "run is already registered under different program authority");
      if (!claimed.ok) return claimed;
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

const MAX_ABANDONMENT_REASON = 512;

/**
 * Parse an abandonment claim into the marker it may become.
 *
 * The self-reference refusal is the invariant that matters: a run naming itself
 * as its own replacement is a pointer that reads as "look elsewhere" and sends
 * the operator back to the run they are already standing in. The reason is
 * required and bounded because an unexplained abandonment tells the next
 * operator nothing the directory listing did not already say.
 */
export function parseRunAbandonment(
  runId: OrchestrationRunId,
  input: RunAbandonmentInput,
): DomainResult<RunAbandonment, RunDirectoryError> {
  const reason = input.reason.trim();
  if (reason === "") return failure("abandonment", "an abandonment must carry a reason");
  if (reason.length > MAX_ABANDONMENT_REASON) {
    return failure("abandonment", `abandonment reason exceeds ${MAX_ABANDONMENT_REASON} characters`);
  }
  if (input.supersededBy === null) {
    return success(canonicalRecord({
      schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
      kind: "run-abandoned" as const,
      runId,
      supersededBy: null,
      reason,
    }));
  }
  const supersededBy = parseOrchestrationRunId(input.supersededBy);
  if (!supersededBy.ok) return failure("abandonment", `superseding run id: ${supersededBy.error.message}`);
  if (supersededBy.value === runId) {
    return failure("abandonment", "a run cannot supersede itself");
  }
  return success(canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    kind: "run-abandoned" as const,
    runId,
    supersededBy: supersededBy.value,
    reason,
  }));
}

function abandonmentOperations(runId: OrchestrationRunId, directory: string) {
  const path = join(directory, ABANDONMENT_FILE);
  return {
    async abandonRun(input: RunAbandonmentInput): Promise<DomainResult<RunAbandonment, RunDirectoryError>> {
      const parsed = parseRunAbandonment(runId, input);
      if (!parsed.ok) return parsed;
      const body = JSON.stringify(parsed.value, null, 2);
      const claimed = claimIdempotentWrite(path, body, "abandonment",
        (cause) => `cannot record run abandonment: ${cause}`,
        "run is already abandoned under a different marker");
      if (!claimed.ok) return claimed;
      return success(parsed.value);
    },

    readAbandonment(): DomainResult<RunAbandonment | null, RunDirectoryError> {
      let raw: unknown;
      try {
        raw = readJsonNoFollow(path);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("abandonment", `run abandonment marker is unreadable: ${(error as Error).message}`);
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return failure("abandonment", "run abandonment marker is malformed");
      }
      const record = raw as Record<string, unknown>;
      if (record["schemaVersion"] !== RUN_DIRECTORY_SCHEMA_VERSION || record["kind"] !== "run-abandoned" ||
          record["runId"] !== runId || typeof record["reason"] !== "string" ||
          (record["supersededBy"] !== null && typeof record["supersededBy"] !== "string")) {
        return failure("abandonment", "run abandonment marker does not describe this run");
      }
      const reparsed = parseRunAbandonment(runId, {
        supersededBy: record["supersededBy"] as string | null,
        reason: record["reason"],
      });
      return reparsed.ok ? reparsed : failure("abandonment", `stored abandonment is invalid: ${reparsed.error.message}`);
    },
  };
}

/**
 * The sequence prefix is the append ORDER, and O_EXCL on the filename cannot
 * arbitrate it; the read-count-write is therefore serialized by the directory
 * lock while the dedup key keeps retry idempotency.
 */
function appendEventOperation(directory: string) {
  return async (record: ProgramEventRecord): Promise<void> => {
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
  };
}

function readEventsOperation(directory: string) {
  return async (): Promise<readonly ProgramEventRecord[]> =>
    withAnchoredDirectoryLock(
      join(directory, EVENTS),
      "append.lock",
      (eventsDirectory) => readEventRecords(eventsDirectory),
    );
}

function readCheckpointOperation(directory: string) {
  return async (): Promise<string | null> => {
    try {
      return readRunFileNoFollow(join(directory, CHECKPOINT_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

function writeCheckpointOperation(directory: string) {
  return async (json: string): Promise<void> => {
    const staged = join(directory, `${CHECKPOINT_FILE}.staged`);
    writeRunFileNoFollow(staged, json);
    publishStagedRunFile(staged, join(directory, CHECKPOINT_FILE));
  };
}

/** Append-only event log plus the checkpoint and progress projections. */
function journalOperations(directory: string) {
  return {
    appendEvent: appendEventOperation(directory),
    readEvents: readEventsOperation(directory),
    readCheckpoint: readCheckpointOperation(directory),
    writeCheckpoint: writeCheckpointOperation(directory),
    writeProgress: async (percent: number): Promise<void> => {
      writeRunFileNoFollow(join(directory, PROGRESS_FILE), JSON.stringify({ percent }));
    },
  };
}

function contextPublished(
  runId: OrchestrationRunId,
  digest: ContextDigest,
  path: string,
): DomainResult<ContextPublishedReceipt, RunDirectoryError> {
  return success(canonicalRecord({ kind: "context-published" as const, runId, digest, slotPath: path }));
}

function readContextPacket(directory: string, digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError> {
  try {
    const parsed = parseContextPacket(readJsonNoFollow(join(directory, CONTEXTS, `${digest}.json`)));
    if (!parsed.ok) return failure("context", parsed.error.message);
    return parsed.value.digest === digest
      ? success(parsed.value)
      : failure("context", "stored context packet digest does not match its slot");
  } catch (error) {
    return failure("context", `context packet ${digest} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decisionContextBody(rawDigest: ContextDigest, bytes: readonly number[]): DomainResult<Readonly<{ digest: ContextDigest; body: string }>, RunDirectoryError> {
  const digest = parseContextDigest(rawDigest);
  if (!digest.ok) return failure("context", digest.error.message);
  const parsedBytes = copiedBytes(bytes);
  if (parsedBytes === null) {
    return failure("context", "decision context bytes must be integers from 0 through 255");
  }
  if (contextDigestOf(parsedBytes) !== digest.value) {
    return failure("context", "decision context digest does not match its exact bytes");
  }
  try {
    const body = new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(parsedBytes));
    JSON.parse(body);
    return success(Object.freeze({ digest: digest.value, body }));
  } catch (error) {
    return failure("context", `decision context must be valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Content-addressed context packets. */
function contextOperations(runId: OrchestrationRunId, directory: string) {
  return {
    async publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>> {
      const path = join(directory, CONTEXTS, `${packet.digest}.json`);
      const claimed = claimIdempotentWrite(path, JSON.stringify(packet), "context",
        (cause) => `cannot publish context packet: ${cause}`,
        "a different context packet already occupies this digest");
      return claimed.ok ? contextPublished(runId, packet.digest, path) : claimed;
    },

    readContext: (digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError> =>
      readContextPacket(directory, digest),

    async publishDecisionContext(
      rawDigest: ContextDigest,
      bytes: readonly number[],
    ): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>> {
      const parsed = decisionContextBody(rawDigest, bytes);
      if (!parsed.ok) return parsed;
      const path = join(directory, CONTEXTS, `${parsed.value.digest}.json`);
      const claimed = claimIdempotentWrite(path, parsed.value.body, "context",
        (cause) => `cannot publish decision context: ${cause}`,
        "different decision context bytes already occupy this digest");
      return claimed.ok ? contextPublished(runId, parsed.value.digest, path) : claimed;
    },
  };
}

/** The three answers a reservation lookup can give, kept distinct. */
type ReservationLookup =
  | Readonly<{ kind: "reserved"; authority: AgentRequestAuthority }>
  | Readonly<{ kind: "unreserved" }>
  | Readonly<{ kind: "unreadable"; message: string }>;

function lookupReservation(
  directory: string,
  requestId: AgentRequestAuthority["requestId"],
): ReservationLookup {
  const requestPath = join(directory, REQUESTS, `${requestId}.json`);
  let rawReservation: unknown;
  try {
    rawReservation = JSON.parse(readRunFileNoFollow(requestPath)) as unknown;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "unreserved" }
      : { kind: "unreadable", message: `request ${requestId} authority is unreadable: ${(error as Error).message}` };
  }
  const reserved = parseStoredAgentRequestAuthority(rawReservation);
  if (!reserved.ok) {
    return { kind: "unreadable", message: `request ${requestId} authority is malformed: ${reserved.error.violations.map(({ message }) => message).join("; ")}` };
  }
  return reserved.value.requestId === requestId
    ? { kind: "reserved", authority: reserved.value }
    : { kind: "unreadable", message: `request ${requestId} authority body belongs to ${reserved.value.requestId}` };
}

function readReservedAuthority(
  directory: string,
  requestId: AgentRequestAuthority["requestId"],
): DomainResult<AgentRequestAuthority, RunDirectoryError> {
  const found = lookupReservation(directory, requestId);
  switch (found.kind) {
    case "reserved":
      return success(found.authority);
    case "unreserved":
      return failure("request", `request ${requestId} was never reserved`);
    case "unreadable":
      return failure("request", found.message);
  }
}

/**
 * Verified write authority for transcript-slot mutations: parse the supplied
 * authority, prove it is byte-identical to the reservation this run wrote, and
 * only then name a path. Reads use `verifiedReservationAddress` below because
 * retry recovery intentionally verifies only the request/slot/attempt address.
 */
function verifiedReservedRequest(
  directory: string,
  runId: OrchestrationRunId,
  authority: AgentRequestAuthority,
  malformed: string,
  foreignRun: string,
  mismatch: (requestId: string) => string,
): DomainResult<AgentRequestAuthority, RunDirectoryError> {
  const supplied = parseStoredAgentRequestAuthority(authority);
  if (!supplied.ok) {
    return failure("request", `${malformed}: ${supplied.error.violations.map(({ message }) => message).join("; ")}`);
  }
  if (supplied.value.runId !== runId) return failure("request", foreignRun);
  const reserved = readReservedAuthority(directory, supplied.value.requestId);
  if (!reserved.ok) return reserved;
  return canonicalStructuralEquals(reserved.value, supplied.value)
    ? success(supplied.value)
    : failure("request", mismatch(supplied.value.requestId));
}

function reserveRequestOperation(runId: OrchestrationRunId, directory: string): RunDirHandle["reserveRequest"] {
  return async (authority) => {
    const parsed = parseStoredAgentRequestAuthority(authority);
    if (!parsed.ok) {
      return failure("request", `request authority is malformed: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
    }
    const request = parsed.value;
    if (request.runId !== runId) return failure("request", "request authority belongs to a different run");
    const requestPath = join(directory, REQUESTS, `${request.requestId}.json`);
    const claimed = claimIdempotentWrite(requestPath, JSON.stringify(request), "request",
      (cause) => `cannot reserve request authority: ${cause}`,
      `request ${request.requestId} is already reserved under different authority`);
    if (!claimed.ok) return claimed;
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
  };
}

function readIssuedRequestsOperation(runId: OrchestrationRunId, directory: string): RunDirHandle["readIssuedRequests"] {
  return () => {
    try {
      return withOwnedAnchor(
        () => openDirectoryNoFollow(join(directory, REQUESTS)),
        "issued-request inspection",
        (requests) => {
          const issued: AgentRequestAuthority[] = [];
          for (const name of listDirectoryNamesNoFollow(requests)) {
            if (!name.endsWith(".json")) continue;
            let raw: unknown;
            try {
              raw = JSON.parse(readDirectoryFileNoFollow(requests, name).toString("utf-8")) as unknown;
            } catch (error) {
              throw new Error(`request authority ${name} is unreadable: ${(error as Error).message}`, { cause: error });
            }
            const parsed = parseStoredAgentRequestAuthority(raw);
            if (!parsed.ok) {
              throw new Error(`request authority ${name} is malformed: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
            }
            if (name !== `${parsed.value.requestId}.json`) {
              throw new Error(`request authority ${name} does not match body request id ${parsed.value.requestId}`);
            }
            if (parsed.value.runId !== runId) throw new Error(`request authority ${name} belongs to a different run`);
            issued.push(parsed.value);
          }
          return success(Object.freeze(issued));
        },
      );
    } catch (error) {
      return failure("request", `cannot inspect issued requests safely: ${(error as Error).message}`);
    }
  };
}

function readCapturedAttemptsOperation(directory: string): RunDirHandle["readCapturedAttempts"] {
  return () => {
    try {
      return withOwnedAnchor(
        () => openDirectoryNoFollow(join(directory, TRANSCRIPTS)),
        "captured-attempt inspection",
        (transcripts) => {
          const captured = new Set<CaptureKey>();
          for (const slot of listDirectoryNamesNoFollow(transcripts)) {
            const inspected = inspectCapturedSlot(transcripts, slot, captured);
            if (!inspected.ok) throw new Error(inspected.error.message);
          }
          return success(captured);
        },
      );
    } catch (error) {
      return failure("transcript", `cannot inspect captured attempts safely: ${(error as Error).message}`);
    }
  };
}

function inspectCapturedSlot(
  transcripts: AnchoredDirectory,
  slot: string,
  captured: Set<CaptureKey>,
): DomainResult<void, RunDirectoryError> {
  if (slot === "capture.lock" || slot === "capture.lock.recovery" || slot.startsWith("capture.lock.tomb-")) {
    return success(undefined);
  }
  try {
    return withOwnedAnchor(
      () => openChildDirectoryNoFollow(transcripts, slot),
      `transcript-slot inspection for ${slot}`,
      (slotDirectory) => {
        for (const name of listDirectoryNamesNoFollow(slotDirectory)) {
          const match = /^attempt-([12])\.raw$/.exec(name);
          if (match === null) continue;
          // The ATTEMPT itself is parsed by the domain rule that owns the concept,
          // not by a second type cast of the filename capture group.
          const attempt = parseSemanticAttempt(Number(match[1]), `transcript slot ${slot}/${name}`);
          if (!attempt.ok) throw new Error(`transcript slot ${slot} holds an unparsable attempt file ${name}`);
          captured.add(captureKey(slot, attempt.value));
        }
        return success(undefined);
      },
    );
  } catch (error) {
    return failure(
      "transcript",
      `cannot inspect transcript slot ${slot} safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type CaptureRejectionMarker = Readonly<{
  requestId: AgentRequestAuthority["requestId"];
  diagnostic: string;
}>;

function parseCaptureRejectionMarker(raw: unknown): DomainResult<CaptureRejectionMarker, RunDirectoryError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("transcript", "capture rejection marker must be an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "diagnostic" || keys[1] !== "requestId") {
    return failure("transcript", "capture rejection marker has unexpected fields");
  }
  const requestId = parseRequestId(record["requestId"]);
  if (!requestId.ok) return failure("transcript", `capture rejection marker request id is invalid: ${requestId.error.message}`);
  if (typeof record["diagnostic"] !== "string") {
    return failure("transcript", "capture rejection marker diagnostic must be a string");
  }
  return success(canonicalRecord({ requestId: requestId.value, diagnostic: record["diagnostic"] }));
}

function readCaptureRejectionMarker(
  slotDirectory: AnchoredDirectory,
  markerName: string,
): DomainResult<CaptureRejectionMarker, RunDirectoryError> {
  try {
    return parseCaptureRejectionMarker(
      JSON.parse(readDirectoryFileNoFollow(slotDirectory, markerName).toString("utf8")) as unknown,
    );
  } catch (error) {
    return failure("transcript", `capture rejection marker is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeCaptureRejectionMarker(
  slotDirectory: AnchoredDirectory,
  supplied: AgentRequestAuthority,
  diagnostic: string,
): void {
  const markerName = `attempt-${supplied.attempt}.rejected`;
  const expected = canonicalRecord({ requestId: supplied.requestId, diagnostic });
  try {
    writeDirectoryFileExclusiveNoFollow(slotDirectory, markerName, JSON.stringify(expected));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readCaptureRejectionMarker(slotDirectory, markerName);
    if (!existing.ok || !canonicalStructuralEquals(existing.value, expected)) {
      throw new Error(
        existing.ok
          ? `capture rejection marker replay conflicts with its immutable diagnostic for ${supplied.requestId}`
          : existing.error.message,
      );
    }
  }
}

function rejectCaptureOperation(runId: OrchestrationRunId, directory: string): RunDirHandle["rejectCapture"] {
  return async (authority, diagnostic = "capture was rejected without a diagnostic") => {
    const supplied = verifiedReservedRequest(
      directory,
      runId,
      authority,
      "capture rejection authority is malformed",
      "capture rejection authority belongs to a different run",
      (requestId) => `request ${requestId} rejection authority does not match its immutable reservation`,
    );
    if (!supplied.ok) return supplied;
    const key = captureKey(supplied.value.slotId, supplied.value.attempt);
    try {
      await withAnchoredDirectoryLock(join(directory, TRANSCRIPTS), "capture.lock", (transcriptsDirectory) =>
        withOwnedAnchor(
          () => openChildDirectoryNoFollow(transcriptsDirectory, supplied.value.slotId),
          `capture rejection for ${supplied.value.slotId}`,
          (slotDirectory) => {
            try {
              readDirectoryFileNoFollow(slotDirectory, `attempt-${supplied.value.attempt}.raw`);
              throw new Error(`attempt ${supplied.value.attempt} for slot ${supplied.value.slotId} is already captured`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            writeCaptureRejectionMarker(slotDirectory, supplied.value, diagnostic);
          },
        ));
      return success(key);
    } catch (error) {
      return failure("transcript", `cannot reject capture safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

type ReservationAddressPolicy = Readonly<{
  label: "capture rejection" | "transcript read";
  unreserved: "null" | "failure";
}>;

function verifiedReservationAddress(
  directory: string,
  runId: OrchestrationRunId,
  authority: AgentRequestAuthority,
  policy: ReservationAddressPolicy,
): DomainResult<AgentRequestAuthority | null, RunDirectoryError> {
  const supplied = parseStoredAgentRequestAuthority(authority);
  if (!supplied.ok) {
    return failure("request", `${policy.label} authority is malformed: ${supplied.error.violations.map(({ message }) => message).join("; ")}`);
  }
  if (supplied.value.runId !== runId) {
    return failure("request", `${policy.label} authority belongs to a different run`);
  }
  const reserved = lookupReservation(directory, supplied.value.requestId);
  if (reserved.kind === "unreadable") return failure("request", reserved.message);
  if (reserved.kind === "unreserved") {
    return policy.unreserved === "null"
      ? success(null)
      : failure("request", `request ${supplied.value.requestId} was never reserved`);
  }
  if (reserved.authority.slotId !== supplied.value.slotId ||
      reserved.authority.attempt !== supplied.value.attempt) {
    return failure(
      "request",
      `request ${supplied.value.requestId} ${policy.label} authority does not match its immutable reservation`,
    );
  }
  return success(supplied.value);
}

function readCaptureRejectionOperation(
  runId: OrchestrationRunId,
  directory: string,
): RunDirHandle["readCaptureRejection"] {
  return (authority) => {
    // Reads verify the request id and the slot/attempt fields that ADDRESS the
    // marker. Whole-authority equality is deliberately reserved for writes:
    // retry recovery asks whether an earlier attempt was rejected while carrying
    // a re-planned context digest. An unreserved request therefore means no
    // marker (`success(null)`), never authority to read an arbitrary slot.
    const supplied = verifiedReservationAddress(directory, runId, authority, {
      label: "capture rejection",
      unreserved: "null",
    });
    if (!supplied.ok) return supplied;
    if (supplied.value === null) return success(null);
    try {
      const raw = JSON.parse(readRunFileNoFollow(join(
        directory, TRANSCRIPTS, supplied.value.slotId, `attempt-${supplied.value.attempt}.rejected`,
      ))) as unknown;
      const marker = parseCaptureRejectionMarker(raw);
      if (!marker.ok || marker.value.requestId !== supplied.value.requestId) {
        return failure("transcript", "capture rejection marker is malformed or belongs to different authority");
      }
      return success(marker.value.diagnostic);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? success(null)
        : failure("transcript", `cannot read capture rejection marker safely: ${(error as Error).message}`);
    }
  };
}

function isPristineOperation(directory: string): RunDirHandle["isPristine"] {
  return () => {
    try {
      return withOwnedAnchor(
        () => openDirectoryNoFollow(directory),
        "pristine-run inspection",
        (root) => {
          const allowedRoot = new Set([AUTHORITY_FILE, PROGRAM_FILE, ...FIXED_SUBDIRECTORIES.map((path) => path.split("/")[0]!) ]);
          const rootEntries = listDirectoryNamesNoFollow(root);
          if (rootEntries.some((entry) => !allowedRoot.has(entry))) return success(false);
          for (const relative of FIXED_SUBDIRECTORIES) {
            const occupied = withOwnedAnchor(
              () => openDirectoryNoFollow(join(directory, relative)),
              `pristine child inspection for ${relative}`,
              (child) => {
                const allowed = relative === REQUESTS ? new Set([CORRELATORS]) : new Set<string>();
                return listDirectoryNamesNoFollow(child).some((entry) => !allowed.has(entry));
              },
            );
            if (occupied) return success(false);
          }
          return success(true);
        },
      );
    } catch (error) {
      return failure("pristine", `cannot prove replacement run pristine: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function recordHarnessCorrelatorOperation(directory: string): RunDirHandle["recordHarnessCorrelator"] {
  return async (binding) => {
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
    const claimed = claimIdempotentWrite(path, JSON.stringify(parsed.value), "correlator",
      (cause) => `cannot record harness correlator: ${cause}`,
      "native harness correlator is already bound to different request authority");
    return claimed.ok ? success(parsed.value) : claimed;
  };
}

function readHarnessCorrelatorOperation(directory: string): RunDirHandle["readHarnessCorrelator"] {
  return (harness, nativeId) => {
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
  };
}

function rejectedCaptureProblem(
  slotDirectory: AnchoredDirectory,
  supplied: AgentRequestAuthority,
): DomainResult<null, RunDirectoryError> {
  const rejectionName = `attempt-${supplied.attempt}.rejected`;
  try {
    const rejected = parseCaptureRejectionMarker(
      JSON.parse(readDirectoryFileNoFollow(slotDirectory, rejectionName).toString("utf8")) as unknown,
    );
    if (!rejected.ok || rejected.value.requestId !== supplied.requestId) {
      return failure("transcript", "capture rejection marker does not match immutable request authority");
    }
    return failure("transcript", `attempt ${supplied.attempt} for slot ${supplied.slotId} is terminally rejected`);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? success(null)
      : failure("transcript", `cannot inspect capture rejection marker safely: ${(error as Error).message}`);
  }
}

function publishTranscriptBytes(
  runId: OrchestrationRunId,
  slotDirectory: AnchoredDirectory,
  supplied: AgentRequestAuthority,
  bytes: readonly number[],
): DomainResult<ArtifactRef, RunDirectoryError> {
  const rawName = `attempt-${supplied.attempt}.raw`;
  const stagedName = `${rawName}.staged-${process.pid}-${createHash("sha256").update(Uint8Array.from(bytes)).digest("hex").slice(0, 16)}`;
  let publicationAttempted = false;
  try {
    writeDirectoryFileExclusiveNoFollow(slotDirectory, stagedName, Uint8Array.from(bytes));
    publicationAttempted = true;
    linkSync(anchoredChildPath(slotDirectory, stagedName), anchoredChildPath(slotDirectory, rawName));
  } catch (error) {
    const cleanupFailures = discardStaged([{ staged: anchoredChildPath(slotDirectory, stagedName) }]);
    const primary = publicationAttempted && (error as NodeJS.ErrnoException).code === "EEXIST"
      ? `attempt ${supplied.attempt} for slot ${supplied.slotId} is already captured`
      : `cannot capture transcript: ${(error as Error).message}`;
    return failure("transcript", `${primary}${cleanupFailureSuffix(cleanupFailures)}`);
  }

  // The hard link above is the commit point. Cleanup cannot turn durable final
  // bytes back into a failed capture; retain a loud diagnostic if the staged
  // name cannot be removed, and let later maintenance remove that inert link.
  try {
    unlinkSync(anchoredChildPath(slotDirectory, stagedName));
  } catch (error) {
    process.stderr.write(
      `WARNING: captured transcript but staged cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  const byteLength = parseArtifactByteLength(bytes.length);
  return byteLength.ok
    ? success(canonicalRecord({
        runId,
        slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `${TRANSCRIPTS}/${supplied.slotId}/attempt-${supplied.attempt}.raw` }),
        digest: digestOf(bytes),
        byteLength: byteLength.value,
      }))
    : failure("transcript", byteLength.error.message);
}

function captureTranscriptOperation(runId: OrchestrationRunId, directory: string): RunDirHandle["captureTranscript"] {
  return async (authority, bytes) => {
    const supplied = verifiedReservedRequest(
      directory,
      runId,
      authority,
      "capture authority is malformed",
      "capture authority belongs to a different run",
      (requestId) => `request ${requestId} capture authority does not match its immutable reservation`,
    );
    if (!supplied.ok) return supplied;
    try {
      return await withAnchoredDirectoryLock(join(directory, TRANSCRIPTS), "capture.lock", (transcriptsDirectory) =>
        withOwnedAnchor(
          () => openChildDirectoryNoFollow(transcriptsDirectory, supplied.value.slotId),
          `transcript capture for ${supplied.value.slotId}`,
          (slotDirectory) => {
            const rejected = rejectedCaptureProblem(slotDirectory, supplied.value);
            if (!rejected.ok) throw new Error(rejected.error.message);
            const published = publishTranscriptBytes(runId, slotDirectory, supplied.value, bytes);
            if (!published.ok) throw new Error(published.error.message);
            return published;
          },
        ));
    } catch (error) {
      return failure("transcript", `cannot capture transcript safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function readTranscriptBytesOperation(
  runId: OrchestrationRunId,
  directory: string,
): RunDirHandle["readTranscriptBytes"] {
  return (authority) => {
    const supplied = verifiedReservationAddress(directory, runId, authority, {
      label: "transcript read",
      unreserved: "failure",
    });
    if (!supplied.ok) return supplied;
    if (supplied.value === null) return failure("request", "internal transcript reservation resolution failed");
    try {
      return success(new Uint8Array(readRunBytesNoFollow(transcriptSlotPath(directory, supplied.value))));
    } catch (error) {
      return failure("transcript", `cannot read captured transcript: ${(error as Error).message}`);
    }
  };
}

/** Request reservations and their exclusive transcript slots. */
function requestOperations(runId: OrchestrationRunId, directory: string) {
  return {
    reserveRequest: reserveRequestOperation(runId, directory),
    readIssuedRequests: readIssuedRequestsOperation(runId, directory),
    readCapturedAttempts: readCapturedAttemptsOperation(directory),
    rejectCapture: rejectCaptureOperation(runId, directory),
    readCaptureRejection: readCaptureRejectionOperation(runId, directory),
    isPristine: isPristineOperation(directory),
    recordHarnessCorrelator: recordHarnessCorrelatorOperation(directory),
    readHarnessCorrelator: readHarnessCorrelatorOperation(directory),
    captureTranscript: captureTranscriptOperation(runId, directory),
    readTranscriptBytes: readTranscriptBytesOperation(runId, directory),
  };
}

const STAGED_ARTIFACT_PROMOTION: unique symbol = Symbol("loom.staged-artifact-promotion");
const MINTED_STAGED_ARTIFACT_PROMOTIONS = new WeakSet<object>();

/** Opaque authority to promote one parser-proven staged artifact within a Run Directory. */
export type StagedArtifactPromotion = Readonly<{
  staged: string;
  final: string;
  [STAGED_ARTIFACT_PROMOTION]: true;
}>;

/**
 * Parse a staged/final pair into promotion authority. Both paths must be
 * canonical absolute paths under this Run Directory's artifacts root, and the
 * staged leaf must use the exact suffix shape produced by `stageArtifactSet`.
 */
export function parseStagedArtifactPromotion(
  runsRoot: string,
  directory: string,
  raw: unknown,
): DomainResult<StagedArtifactPromotion, RunDirectoryError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("artifacts", "staged artifact promotion must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record["staged"] !== "string" || typeof record["final"] !== "string") {
    return failure("artifacts", "staged artifact promotion paths must be strings");
  }
  const identity = parseRunDirectoryIdentity(runsRoot, directory);
  if (!identity.ok) return identity;
  const artifactsRoot = resolve(identity.value.runDirectory, ARTIFACTS);
  const final = resolve(record["final"]);
  const finalRelative = relative(artifactsRoot, final).split(sep).join("/");
  const parsedRelative = parseArtifactRelativePath(finalRelative);
  if (record["final"] !== final || !parsedRelative.ok || join(artifactsRoot, parsedRelative.ok ? parsedRelative.value : "") !== final) {
    return failure("artifacts", "final artifact promotion path must be canonical and remain beneath the Run Directory artifacts root");
  }
  const staged = resolve(record["staged"]);
  const stagedPrefix = `${final}.staged-`;
  const stagedSuffix = staged.slice(stagedPrefix.length);
  if (record["staged"] !== staged || !staged.startsWith(stagedPrefix) || !/^[0-9a-f]{24}$/.test(stagedSuffix)) {
    return failure("artifacts", "staged artifact promotion path must be the canonical sibling generated for its final artifact");
  }
  const promotion = Object.freeze({ staged, final, [STAGED_ARTIFACT_PROMOTION]: true as const });
  MINTED_STAGED_ARTIFACT_PROMOTIONS.add(promotion);
  return success(promotion);
}

/** Parse the complete publication set before any directory or staged file exists. */
function parseStagedArtifactSet(
  staged: readonly StagedArtifactInput[],
): DomainResult<readonly StagedArtifact[], RunDirectoryError> {
  const parsedArtifacts: StagedArtifact[] = [];
  const destinations = new Set<ArtifactRelativePath>();
  for (const artifact of staged) {
    const parsed = createStagedArtifact(artifact.relativePath, artifact.bytes);
    if (!parsed.ok) return parsed;
    if (destinations.has(parsed.value.relativePath)) {
      return failure("artifacts", `artifact destination is duplicated: ${parsed.value.relativePath}`);
    }
    destinations.add(parsed.value.relativePath);
    parsedArtifacts.push(parsed.value);
  }
  return success(Object.freeze(parsedArtifacts));
}

/**
 * Write parser-minted members beside their final names. A fault attempts to
 * discard every staged member; cleanup failures are reported and may leave
 * inert staged files that carry no publication receipt.
 */
function stageArtifactSet(
  runsRoot: string,
  directory: string,
  artifacts: readonly StagedArtifact[],
): DomainResult<readonly StagedArtifactPromotion[], RunDirectoryError> {
  const stagedPaths: StagedArtifactPromotion[] = [];
  const publicationId = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}:${artifacts.map(({ relativePath }) => relativePath).join("\0")}`)
    .digest("hex")
    .slice(0, 24);
  try {
    for (const artifact of artifacts) {
      const final = join(directory, ARTIFACTS, artifact.relativePath);
      ensureRunSubdirectories(directory, [resolve(final, "..")]);
      const stagedPath = `${final}.staged-${publicationId}`;
      writeRunBytesExclusiveNoFollow(stagedPath, Uint8Array.from(artifact.bytes));
      const promotion = parseStagedArtifactPromotion(runsRoot, directory, { staged: stagedPath, final });
      if (!promotion.ok) throw new Error(promotion.error.message);
      stagedPaths.push(promotion.value);
    }
  } catch (error) {
    const cleanupFailures = discardStaged(stagedPaths);
    return failure("artifacts", `cannot stage artifact set: ${(error as Error).message}${cleanupFailureSuffix(cleanupFailures)}`);
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

type StagedBytesComparison =
  | Readonly<{ kind: "identical" }>
  | Readonly<{ kind: "different" }>
  | Readonly<{ kind: "unreadable"; cause: string }>;

/** Compare staged bytes without collapsing a read fault into byte inequality. */
function stagedBytesMatch(stagedPath: string, occupied: Uint8Array): StagedBytesComparison {
  try {
    return sameBytes(occupied, readRunBytesNoFollow(stagedPath))
      ? Object.freeze({ kind: "identical" })
      : Object.freeze({ kind: "different" });
  } catch (error) {
    return Object.freeze({
      kind: "unreadable",
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function occupiedArtifactConflict(
  entry: StagedArtifactPromotion,
  occupied: Uint8Array | Readonly<{ __unreadable: string }>,
): string | null {
  if (!(occupied instanceof Uint8Array)) {
    // The `__unreadable` sentinel collected the read cause so an operator can
    // tell EACCES from an ELOOP symlink race from a directory-in-slot — the
    // same rule `readRunAuthority` applies to its own unreadable reads. A
    // refusal that dropped it sent all three causes down one unactionable path.
    return `artifact slot is occupied by unreadable bytes: ${entry.final} (${occupied.__unreadable})`;
  }
  const comparison = stagedBytesMatch(entry.staged, occupied);
  if (comparison.kind === "different") {
    return `a different artifact already occupies this slot: ${entry.final}`;
  }
  if (comparison.kind === "unreadable") {
    return `cannot compare staged artifact bytes for ${entry.final}: ${entry.staged} is unreadable (${comparison.cause})`;
  }
  return null;
}

/**
 * Promote internal staged paths. Every target is checked BEFORE any rename,
 * which rules out predictable conflicts while the set is entirely staged.
 * An unexpected later rename fault can leave earlier final files in place.
 * Those bytes carry no publication authority because no successful result or
 * Effect Receipt exists; the low-level `readArtifactBytes` operation is not
 * receipt-gated, so consumers must follow only successful publication refs.
 * Publication authority is all-or-none even though filesystem promotion is not.
 *
 * The fault-injection seam is exported, but structural path pairs are not
 * authority: every member must carry the runtime mint issued by
 * `parseStagedArtifactPromotion`, which proves both paths remain beneath one
 * Run Directory's artifacts root. Production receives the same mint from
 * `stageArtifactSet` after deriving its paths from parsed artifacts.
 *
 * `renameSync` replaces an existing regular file, so the O_EXCL immutability
 * this module promises has to be enforced here explicitly: an occupied slot is
 * refused unless its bytes are already identical to what would be written, in
 * which case the promotion is a no-op replay rather than a rewrite of history.
 */
export function promoteArtifactSet(
  stagedPaths: readonly StagedArtifactPromotion[],
): DomainResult<readonly StagedArtifactPromotion[], RunDirectoryError> {
  if (stagedPaths.some((entry) => !MINTED_STAGED_ARTIFACT_PROMOTIONS.has(entry))) {
    return failure("artifacts", "artifact promotion requires parser-minted staged authority");
  }
  for (const entry of stagedPaths) {
    const inspected = inspectExistingDirectory(entry.final);
    if (!inspected.ok || inspected.value) {
      const cleanupFailures = discardStaged(stagedPaths);
      const reason = inspected.ok
        ? `artifact slot is occupied by a directory: ${entry.final}`
        : inspected.error.message;
      return failure("artifacts", `${reason}${cleanupFailureSuffix(cleanupFailures)}`);
    }
  }

  for (const entry of stagedPaths) {
    const occupied = occupiedArtifactBytes(entry.final);
    if (occupied === null) continue;
    const reason = occupiedArtifactConflict(entry, occupied);
    if (reason !== null) {
      const cleanupFailures = discardStaged(stagedPaths);
      return failure("artifacts", `${reason}${cleanupFailureSuffix(cleanupFailures)}`);
    }
  }

  // A failure here must still not report success. Any member already promoted
  // stays on disk but carries no publication authority: the effect runner
  // records a receipt only on a successful return. Low-level path reads remain
  // possible, so callers must consume only refs from successful publication.
  for (const [index, entry] of stagedPaths.entries()) {
    try {
      publishStagedRunFile(entry.staged, entry.final);
    } catch (error) {
      const cleanupFailures = discardStaged(stagedPaths.slice(index));
      return failure("artifacts", `cannot publish artifact set: ${(error as Error).message}${cleanupFailureSuffix(cleanupFailures)}`);
    }
  }
  return success(stagedPaths);
}

/** Stage and promote only artifacts minted by `createStagedArtifact`. */
function stageAndPromoteArtifactSet(
  runsRoot: string,
  directory: string,
  artifacts: readonly StagedArtifact[],
): DomainResult<readonly StagedArtifact[], RunDirectoryError> {
  const stagedPaths = stageArtifactSet(runsRoot, directory, artifacts);
  if (!stagedPaths.ok) return stagedPaths;
  const promoted = promoteArtifactSet(stagedPaths.value);
  return promoted.ok ? success(artifacts) : promoted;
}

function readArtifactBytesOperation(directory: string) {
  return (relativePath: unknown): DomainResult<Uint8Array | null, RunDirectoryError> => {
    const parsed = parseArtifactRelativePath(relativePath);
    if (!parsed.ok) return parsed;
    try {
      return success(new Uint8Array(readRunBytesNoFollow(join(directory, ARTIFACTS, parsed.value))));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? success(null)
        : failure(
            "artifacts",
            `artifact ${parsed.value} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
  };
}

function publishedArtifactRef(
  runId: OrchestrationRunId,
  directory: string,
  artifact: StagedArtifact,
): DomainResult<ArtifactRef, RunDirectoryError> {
  let publishedBytes: Uint8Array;
  try {
    publishedBytes = readRunBytesNoFollow(join(directory, ARTIFACTS, artifact.relativePath));
  } catch (error) {
    return failure("artifacts", `cannot verify published artifact ${artifact.relativePath}: ${(error as Error).message}`);
  }
  const byteLength = parseArtifactByteLength(publishedBytes.length);
  if (!byteLength.ok) return failure("artifacts", byteLength.error.message);
  return success(canonicalRecord({
    runId,
    slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `${ARTIFACTS}/${artifact.relativePath}` }),
    digest: digestOf([...publishedBytes]),
    byteLength: byteLength.value,
  }));
}

function publishedArtifactRefs(
  runId: OrchestrationRunId,
  directory: string,
  artifacts: readonly StagedArtifact[],
): DomainResult<readonly ArtifactRef[], RunDirectoryError> {
  const refs: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    const ref = publishedArtifactRef(runId, directory, artifact);
    if (!ref.ok) return ref;
    refs.push(ref.value);
  }
  return success(Object.freeze(refs));
}

function publishArtifactSetOperation(runId: OrchestrationRunId, runsRoot: string, directory: string) {
  return async (staged: readonly StagedArtifactInput[]): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>> => {
    if (staged.length === 0) return failure("artifacts", "an artifact set must not be empty");
    const artifacts = parseStagedArtifactSet(staged);
    if (!artifacts.ok) return artifacts;
    try {
      return await withAnchoredDirectoryLock(join(directory, ARTIFACTS), "publish.lock", async () => {
        const promoted = stageAndPromoteArtifactSet(runsRoot, directory, artifacts.value);
        return promoted.ok ? publishedArtifactRefs(runId, directory, promoted.value) : promoted;
      });
    } catch (error) {
      return failure("artifacts", `cannot lock artifact publication safely: ${(error as Error).message}`);
    }
  };
}

/** Receipt-gated artifact set publication; failed partial finals carry no publication authority. */
function artifactOperations(runId: OrchestrationRunId, runsRoot: string, directory: string) {
  return {
    readArtifactBytes: readArtifactBytesOperation(directory),
    publishArtifactSet: publishArtifactSetOperation(runId, runsRoot, directory),
  };
}

/** Typed effect receipts, recorded once under their own effect id. */
function receiptOperations(directory: string) {
  return {
    async recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>> {
      const path = join(directory, RECEIPTS, `${receipt.effectId}.json`);
      const body = JSON.stringify(receipt);
      const claimed = claimIdempotentWrite(path, body, "receipt",
        (cause) => `cannot record receipt: ${cause}`,
        `effect ${receipt.effectId} already recorded a different receipt`);
      if (!claimed.ok) return claimed;
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
        // PARSED, not asserted. A bare `as EffectReceipt` typed whatever JSON
        // was on disk as a valid receipt, so a truncated or hand-edited file
        // reached the effect runner as authority to SKIP an effect — the exact
        // outcome this method's own doc says must never be indistinguishable
        // from "never ran".
        const parsed = parseEffectReceipt(readJsonNoFollow(path));
        return parsed.ok
          ? success(parsed.value)
          : failure("receipt", `receipt for effect ${effectId} is malformed: ${parsed.error.message}`);
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
