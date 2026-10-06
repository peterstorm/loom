/** Published advisory revision authentication. Receives nominal same-source lineage; never loads a predecessor or drives publication. */
import { dirname, join } from "node:path";
import { canonicalStructuralEquals } from "../../../core/orchestration-contract";
import { parseBoundedReviewerJson } from "../../../core/reviewer-protocol";
import { STANDALONE_LINEAGE_LIMITS } from "../../../core/standalone-lineage-contract";
import {
  prepareStandaloneDisposition,
  readPublishedStandaloneDisposition,
  type StandaloneLineageSource,
  type PreparedStandaloneDisposition,
} from "../../../core/standalone-lineage";
import type { PublishedStandaloneDisposition, StandaloneDispositionPublicationReference } from "../../../core/standalone-review-model";
import { parseRegisteredStandaloneDispositionProgram, startStandaloneDisposition,
  standaloneDispositionReceipt, reduceStandaloneDisposition, checkStandaloneDispositionCheckpoint,
  type RegisteredStandaloneDispositionProgram, type StandaloneDispositionStartInput, type StandaloneDispositionState } from "../../../core/standalone-disposition-machine";
import { openRegisteredRunDirectory, type RunDirHandle } from "../../../orchestration/run-directory-handle";
import { openDirectoryNoFollow, closeAnchoredDirectory, readRunBytesNoFollow } from "../../../orchestration/no-follow-fs";
import type { ProgramParse } from "./program-result";

const maximum = STANDALONE_LINEAGE_LIMITS.retainedBytes;
const encoded = (raw: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(raw));
/** Shell-local cumulative allocation budget for explicit revision traversal, not a whole-Run heap claim. */
type ReadBudget = { remaining: number };
const budget = (): ReadBudget => ({ remaining: 64 * 1024 * 1024 });
function readBytes(path: string, allowance: ReadBudget, optional = false): Uint8Array | null {
  try {
    const bytes = readRunBytesNoFollow(path, Math.min(maximum, allowance.remaining));
    allowance.remaining -= bytes.length;
    return bytes;
  } catch (cause) {
    if (optional && (cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}
function readJson(path: string, allowance: ReadBudget, optional = false): unknown | null {
  const bytes = readBytes(path, allowance, optional);
  if (bytes === null) return null;
  const parsed = parseBoundedReviewerJson(bytes, maximum);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}
export function openStandalonePublicationRun(locator: string, runId: string): RunDirHandle {
  // Unlike user-configured legacy roots, an explicit publication locator must already be canonical/no-follow.
  const anchor = openDirectoryNoFollow(locator);
  closeAnchoredDirectory(anchor);
  const opened = openRegisteredRunDirectory(dirname(locator), locator);
  if (!opened.ok) throw new Error(opened.error.message);
  if (opened.value.runDirectory !== locator || opened.value.runId !== runId) throw new Error("publication locator differs from anchored Run identity");
  return opened.value;
}

function readRegistration(handle: RunDirHandle, allowance: ReadBudget): RegisteredStandaloneDispositionProgram {
  const parsed = parseRegisteredStandaloneDispositionProgram(readJson(join(handle.runDirectory, "program.json"), allowance));
  if (!parsed.ok) throw new Error(parsed.error.message);
  if (parsed.value.runId !== handle.runId) throw new Error("disposition registration belongs to another Run");
  return parsed.value;
}

function prepareRecord(source: StandaloneLineageSource, input: StandaloneDispositionStartInput,
  allowance: ReadBudget, visited: readonly string[]): PreparedStandaloneDisposition {
  const previous = input.previous === null ? undefined : readRevision(source, input.previous, allowance, visited);
  const prepared = prepareStandaloneDisposition(source, encoded(input.record), previous);
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
}

function inspectPublication(handle: RunDirHandle, registration: RegisteredStandaloneDispositionProgram,
  prepared: PreparedStandaloneDisposition, allowance: ReadBudget): Readonly<{ state: StandaloneDispositionState; published: PublishedStandaloneDisposition | null }> {
  const expected = standaloneDispositionReceipt(registration);
  const artifact = readBytes(join(handle.runDirectory, "artifacts/disposition.json"), allowance, true);
  const receipt = readJson(join(handle.runDirectory, "receipts", `${expected.effectId}.json`), allowance, true);
  let state = startStandaloneDisposition(registration);
  if (artifact !== null) {
    if (!Buffer.from(artifact).equals(Buffer.from(encoded(prepared.record)))) throw new Error("different disposition bytes occupy publication slot");
    const next = reduceStandaloneDisposition(registration, state, { kind: "artifact-published" });
    if (!next.ok) throw new Error(next.error.message);
    state = next.value;
  }
  let published: PublishedStandaloneDisposition | null = null;
  if (receipt !== null) {
    if (artifact === null) throw new Error("receipt has no exact artifact");
    const next = reduceStandaloneDisposition(registration, state, { kind: "receipt-recorded", receipt });
    if (!next.ok) throw new Error(next.error.message);
    const reference = { locator: handle.runDirectory, runId: handle.runId, dispositionDigest: prepared.digest };
    const confirmed = readPublishedStandaloneDisposition(prepared, reference, lookup =>
      canonicalStructuralEquals(lookup, reference)
        ? { ok: true, value: { recordBytes: artifact, receipt } }
        : { ok: false, error: { message: "foreign disposition publication lookup" } });
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    published = confirmed.value;
    state = next.value;
  }
  const checked = checkStandaloneDispositionCheckpoint(registration, state, readJson(join(handle.runDirectory, "checkpoint.json"), allowance, true));
  if (!checked.ok) throw new Error(checked.error.message);
  return Object.freeze({ state: checked.value, published });
}

function readRevision(source: StandaloneLineageSource, reference: StandaloneDispositionPublicationReference,
  allowance: ReadBudget, visited: readonly string[]): PublishedStandaloneDisposition {
  if (visited.length >= STANDALONE_LINEAGE_LIMITS.historyPerOrigin || visited.includes(reference.locator)) throw new Error("disposition revision chain is cyclic or exceeds 64 revisions");
  const handle = openStandalonePublicationRun(reference.locator, reference.runId);
  const registration = readRegistration(handle, allowance);
  const prepared = prepareRecord(source, registration.input, allowance, [...visited, reference.locator]);
  if (prepared.digest !== reference.dispositionDigest) throw new Error("selected current revision differs from exact declaration digest");
  const publication = inspectPublication(handle, registration, prepared, allowance);
  if (publication.published === null) throw new Error("selected disposition revision is not published; missing artifact/receipt is not historical absence");
  return publication.published;
}

/** Explicit revision selection. Never returns historical absence for an expected current publication. */
export function readSelectedStandaloneDisposition(source: StandaloneLineageSource,
  reference: StandaloneDispositionPublicationReference): ProgramParse<PublishedStandaloneDisposition> {
  try { return { ok: true, value: readRevision(source, reference, budget(), []) }; }
  catch (cause) { return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }; }
}

/** Preflight checks the complete same-source correction chain before destination creation. */
export function prepareStandaloneDispositionRecord(source: StandaloneLineageSource,
  input: StandaloneDispositionStartInput, destination: string): PreparedStandaloneDisposition {
  return prepareRecord(source, input, budget(), [destination]);
}

/** Read registration first; finish the exact publication join only after the caller authenticates its source.
 * The operation-local budget spans both reads. Callers cannot replace any evidence join.
 */
export function readStandaloneDispositionPublication(handle: RunDirHandle,
  expected: RegisteredStandaloneDispositionProgram) {
  const allowance = budget();
  const registration = readRegistration(handle, allowance);
  if (!canonicalStructuralEquals(registration, expected)) throw new Error("disposition registration differs from independently read authority");
  return Object.freeze({
    registration,
    reconcile(source: StandaloneLineageSource) {
      const prepared = prepareRecord(source, registration.input, allowance, [handle.runDirectory]);
      return { registration, prepared, ...inspectPublication(handle, registration, prepared, allowance) };
    },
  });
}
