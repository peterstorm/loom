/**
 * Shared downward source authentication for remediation and advisory custody.
 * This module is the shell: it opens Run Directories and gathers bytes. Every
 * decision about the predecessor walk — Run/cycle bound, byte budget, attempt
 * roster, labels, anchored identity — is the pure `core/standalone-predecessor-chain`,
 * and the retained archive record is the pure `core/predecessor-archive` codec.
 */
import { dirname, join } from "node:path";
import { encodeByteSection, parseStandaloneReviewerContextPacketV3, type ByteSection } from "../../../core/context-packets";
import { parseContextPacket } from "../../../orchestration/context-packets";
import { parseBoundedReviewerJson } from "../../../core/reviewer-protocol";
import { selectStandaloneReviewers } from "../../../core/standalone-review-scope";
import { prepareStandaloneSuccessor } from "../../../core/standalone-lineage";
import { type PreparedStandaloneSuccessor, type StandaloneDispositionSelection } from "../../../core/standalone-review-model";
import { readSelectedStandaloneDisposition } from "./standalone-disposition-source";
import { boundedStandaloneReadHandle as boundedSourceHandle, successorSourceSnapshot, standaloneSuccessorPackets, SUCCESSOR_CONTEXT_PAYLOAD_BYTES } from "./standalone-successor-source";
import type { RegisteredStandaloneSuccessorProgram, StandaloneSuccessorStartInput } from "./standalone-successor-registration";
import type { StandaloneReviewMetadata } from "../../../core/standalone-review-scope";
import type { FrozenStandaloneReviewAuthority } from "../../../core/standalone-review-model";
import { sameRegisteredStandalonePrograms } from "./registration";
import { standaloneReviewerProtocolResolver } from "./reviewer-protocol-resolution";
import { canonicalStructuralEquals } from "../../../core/orchestration-contract";
import { parseStandaloneReviewMachineState } from "../../../core/standalone-review-checkpoint";
import { reduceStandaloneReviewMachine, type StandaloneDoneState } from "../../../core/standalone-review-machine";
import { serializeStandaloneReviewAuthority } from "../../../core/standalone-review-records";
import { STANDALONE_LINEAGE_LIMITS, type StandalonePreviousSnapshot } from "../../../core/standalone-lineage-contract";
import { prepareStandaloneLineageSource, type StandaloneLineageSource } from "../../../core/standalone-lineage";
import { admitFrozenPredecessorArchive, publishedPacketReference, serializePublishedPacketReference,
  type PredecessorArchivePurpose, type PredecessorArchiveRecord } from "../../../core/predecessor-archive";
import { admitAnchoredRunAuthority, chargePredecessorBytes, enterPredecessorRun, predecessorAttemptRoster, predecessorContextLabel,
  predecessorFrozenSourceText, predecessorReadBound, predecessorTraversal, resumeAfterChildWalk,
  type PredecessorTraversal } from "../../../core/standalone-predecessor-chain";
import { readStandaloneReviewedSource, replayStandaloneCliCaptures } from "./standalone-evidence";
import { readRunBytesNoFollow } from "../../../orchestration/no-follow-fs";
import { openRegisteredRunDirectory, type RunDirHandle } from "../../../orchestration/run-directory-handle";
import { readStoredContextPacketFile } from "../../../orchestration/stored-context-packets";
import { parsedAuthority, parseRegistration } from "./registration";
import { publishedReviewerRequest, publicationResolver } from "./durable-requests";
import { readPublishedStandaloneResult } from "./standalone-requests";
import { type ProgramParse } from "./program-result";

type SuccessorSourcePreparation = Readonly<{ prepared: PreparedStandaloneSuccessor;
  packets: Extract<ReturnType<typeof standaloneSuccessorPackets>, { ok: true }>["value"]["packets"];
  contexts: Extract<ReturnType<typeof standaloneSuccessorPackets>, { ok: true }>["value"]["contexts"] }>;
type SuccessorAdmission = SuccessorSourcePreparation & { readonly authority: FrozenStandaloneReviewAuthority };
type CompletedSource = StandaloneDoneState & { readonly locator: string };

/** One shell step's result and the walk's remaining traversal: returned, never mutated in place. */
type Walked<T> = ProgramParse<Readonly<{ walked: T; traversal: PredecessorTraversal }>>;

/** A caller-supplied walk, held to the carried byte control. */
const normalized = (traversal: PredecessorTraversal) => predecessorTraversal(traversal.visited, traversal.remaining);

/** Preserve the originally issued archive encoding; compressor versions never select new context bytes on resume. */
function predecessorContextSection(label: string, bytes: Buffer, frozen: ByteSection | undefined,
  path: string, purpose: PredecessorArchivePurpose): ProgramParse<Readonly<{ section: ByteSection; record: PredecessorArchiveRecord }>> {
  const reference = publishedPacketReference(bytes, path, purpose);
  if (frozen === undefined) {
    const section = encodeByteSection(label, serializePublishedPacketReference(reference));
    return section.ok ? { ok: true, value: { section: section.value, record: reference } } : { ok: false, message: section.error.message };
  }
  const decoded = parseBoundedReviewerJson(Uint8Array.from(frozen.bytes), SUCCESSOR_CONTEXT_PAYLOAD_BYTES);
  if (!decoded.ok) return { ok: false, message: "invalid frozen predecessor archive" };
  const admitted = admitFrozenPredecessorArchive(decoded.value, bytes, reference, SUCCESSOR_CONTEXT_PAYLOAD_BYTES);
  return admitted.ok ? { ok: true, value: { section: frozen, record: admitted.value } } : { ok: false, message: admitted.error };
}

/** Authentication data shared by initial issuance and every resume; no parsed JSON can supply membership. */
export async function prepareStandaloneSuccessorSource(input: StandaloneSuccessorStartInput, runId: string,
  currentSource: ByteSection, reviewers: StandaloneReviewMetadata | readonly string[],
  traversal: PredecessorTraversal = predecessorTraversal(),
  frozenPreviousContexts?: readonly ByteSection[]): Promise<ProgramParse<SuccessorSourcePreparation>> {
  const prepared = await prepareSuccessorSourceWithin(input, runId, currentSource, reviewers, normalized(traversal), frozenPreviousContexts);
  return prepared.ok ? { ok: true, value: prepared.value.walked } : prepared;
}

async function prepareSuccessorSourceWithin(input: StandaloneSuccessorStartInput, runId: string,
  currentSource: ByteSection, reviewers: StandaloneReviewMetadata | readonly string[], traversal: PredecessorTraversal,
  frozenPreviousContexts: readonly ByteSection[] | undefined): Promise<Walked<SuccessorSourcePreparation>> {
  const reference = input.successor.source;
  const source = await authenticateLineageSourceWithin(dirname(reference.locator), reference.locator, traversal);
  if (!source.ok) return source;
  const lineage = source.value.walked;
  let walk = source.value.traversal;
  if (!canonicalStructuralEquals(lineage.publication, reference)) return { ok: false as const, message: "successor predecessor differs from exact published Run/result identity" };
  let disposition: StandaloneDispositionSelection = { kind: "historical-decision-unavailable" };
  if (input.successor.disposition.kind === "selected-record") {
    const selected = readSelectedStandaloneDisposition(lineage, input.successor.disposition.publication);
    if (!selected.ok) return selected;
    disposition = { kind: "selected-record", disposition: selected.value };
  }
  const snapshot = successorSourceSnapshot(currentSource, input.files);
  if (!snapshot.ok) return snapshot;
  const roles = "requestedKinds" in reviewers ? selectStandaloneReviewers(reviewers) : reviewers;
  const prepared = prepareStandaloneSuccessor(lineage, Buffer.from(JSON.stringify({ runId, snapshot: snapshot.value, reviewers: roles })), disposition);
  if (!prepared.ok) return { ok: false as const, message: prepared.error.message };
  const previous = openRegisteredRunDirectory(dirname(reference.locator), reference.locator);
  if (!previous.ok || previous.value.runDirectory !== reference.locator || previous.value.runId !== reference.runId) {
    return { ok: false as const, message: "predecessor locator differs from anchored identity" };
  }
  const raw = previous.value.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!raw.ok) return { ok: false as const, message: raw.error.message };
  const registration = parseRegistration(raw.value);
  if (!registration.ok) return registration;
  const purpose: PredecessorArchivePurpose = registration.value.schemaVersion === 3 ? "standalone-successor" : "v1-v2";
  // Retain every issued predecessor attempt's exact packet bytes, including a semantic retry.
  // Unissued historical contexts are not invented or represented as observed publication.
  const requests = previous.value.readIssuedRequests(STANDALONE_LINEAGE_LIMITS.retainedBytes, 128);
  if (!requests.ok) return { ok: false as const, message: requests.error.message };
  const roster = predecessorAttemptRoster(requests.value, lineage.reviewers);
  if (!roster.ok) return { ok: false as const, message: roster.error };
  const contexts: ByteSection[] = [];
  for (const { role, attempts } of roster.value) {
    for (const request of attempts) {
      const issued = publishedReviewerRequest(previous.value, request, STANDALONE_LINEAGE_LIMITS.retainedBytes);
      if (!issued.ok) return issued;
      // One read is both the published-byte identity and the parsed packet,
      // so the archived reference and the observed packet cannot diverge.
      const packetPath = join(reference.locator, "contexts", `${request.contextDigest}.json`);
      const stored = readStoredContextPacketFile(packetPath, { file: walk.remaining, section: walk.remaining });
      if (!stored.ok) return { ok: false as const, message: stored.error };
      const bytes = stored.value.fileBytes;
      // The traversal budget covers every byte observed: the packet file and
      // each section blob it resolved.
      const charged = chargePredecessorBytes(walk, bytes.length + stored.value.sectionBytes, "predecessor Context Packet");
      if (!charged.ok) return { ok: false as const, message: charged.error };
      walk = charged.value;
      const packet = registration.value.schemaVersion === 3
        ? parseStandaloneReviewerContextPacketV3(stored.value.record)
        : parseContextPacket(stored.value.record);
      if (!packet.ok || packet.value.digest !== request.contextDigest) {
        return { ok: false as const, message: "predecessor Context Packet does not prove its issued digest" };
      }
      // Exact published-byte references avoid recursively embedding predecessor packets.
      // Original files stay mandatory: neither source replay nor the reader can fall back.
      const label = predecessorContextLabel(role, request.attempt);
      const frozen = frozenPreviousContexts?.find(section => section.label === label);
      if (frozenPreviousContexts !== undefined && frozen === undefined) return { ok: false, message: "missing frozen predecessor context" };
      const archived = predecessorContextSection(label, bytes, frozen, packetPath, purpose);
      if (!archived.ok) return archived;
      contexts.push(archived.value.section);
      if (contexts.length === 1) {
        const sources = [...packet.value.fixedContext, ...packet.value.variableContext]
          .filter(row => row.label === "standalone-frozen-source").map(row => Uint8Array.from(row.bytes));
        const previousSource = encodeByteSection("predecessor-frozen-source",
          predecessorFrozenSourceText(archived.value.record, sources, lineage.snapshot, label, purpose));
        if (!previousSource.ok) return { ok: false, message: previousSource.error.message };
        contexts.push(previousSource.value);
      }
    }
  }
  if (frozenPreviousContexts !== undefined && !canonicalStructuralEquals(frozenPreviousContexts, contexts)) return { ok: false, message: "frozen predecessor source/context inventory differs from authenticated observations" };
  const packets = standaloneSuccessorPackets(prepared.value, currentSource, contexts);
  return packets.ok
    ? { ok: true as const, value: { walked: Object.freeze({ prepared: prepared.value, ...packets.value }), traversal: walk } }
    : packets;
}

export async function readStandaloneSuccessorAuthority(handle: RunDirHandle, registration: RegisteredStandaloneSuccessorProgram,
  traversal: PredecessorTraversal = predecessorTraversal([handle.runDirectory])): Promise<ProgramParse<SuccessorAdmission>> {
  const admitted = await successorAuthorityWithin(handle, registration, normalized(traversal));
  return admitted.ok ? { ok: true, value: admitted.value.walked } : admitted;
}

async function successorAuthorityWithin(handle: RunDirHandle, registration: RegisteredStandaloneSuccessorProgram,
  traversal: PredecessorTraversal): Promise<Walked<SuccessorAdmission>> {
  const stored = handle.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
  const observed = stored.ok ? parseRegistration(stored.value) : { ok: false as const };
  const supplied = parseRegistration(registration);
  if (!observed.ok || !supplied.ok || !sameRegisteredStandalonePrograms(observed.value, supplied.value)) return { ok: false as const, message: "successor registration differs from independently read durable bytes" };
  const raw = registration.authority;
  if (typeof raw !== "object" || raw === null || !("reviewers" in raw) || !Array.isArray(raw.reviewers) || raw.reviewers.some(role => typeof role !== "string")) {
    return { ok: false as const, message: "successor frozen reviewer roster is malformed" };
  }
  const prepared = await prepareSuccessorSourceWithin(registration.input, handle.runId, registration.currentSource, raw.reviewers, traversal, registration.previousContexts);
  if (!prepared.ok) return prepared;
  const { walked: preparation, traversal: remaining } = prepared.value;
  const authority = parsedAuthority(registration, preparation.prepared);
  if (!authority.ok) return authority;
  if (authority.value.runId !== handle.runId || !canonicalStructuralEquals(authority.value.scope, registration.input.files) ||
      !canonicalStructuralEquals(authority.value.reviewMetadata.requestedKinds, [registration.input.kind]) ||
      authority.value.roster.orderedSlots.some((slot, index) => slot.attempts.some((request, attempt) =>
        request.contextDigest !== preparation.contexts[index]?.attempts[attempt]))) {
    return { ok: false as const, message: "successor source/roster/context bytes differ from frozen registration" };
  }
  return { ok: true as const, value: { walked: Object.freeze({ ...preparation, authority: authority.value }), traversal: remaining } };
}

/** Current contexts must contain their source observation; only genuinely historical absence stays unknown. */
export async function readAuthenticatedStandaloneLineageSource(sourceRunsRoot: string, sourceRun: string,
  traversal: PredecessorTraversal = predecessorTraversal()): Promise<ProgramParse<StandaloneLineageSource>> {
  const source = await authenticateLineageSourceWithin(sourceRunsRoot, sourceRun, normalized(traversal));
  return source.ok ? { ok: true, value: source.value.walked } : source;
}

async function authenticateLineageSourceWithin(sourceRunsRoot: string, sourceRun: string,
  traversal: PredecessorTraversal): Promise<Walked<StandaloneLineageSource>> {
  const completed = await readCompletedStandaloneSource(sourceRunsRoot, sourceRun, traversal);
  if (!completed.ok) return completed;
  const { walked: source, traversal: remaining } = completed.value;
  const walked = (lineage: ReturnType<typeof prepareStandaloneLineageSource>): Walked<StandaloneLineageSource> =>
    lineage.ok ? { ok: true, value: { walked: lineage.value, traversal: remaining } } : { ok: false, message: lineage.error.message };
  if (source.result.schemaVersion === 3) return walked(prepareStandaloneLineageSource(source.result, source.locator));
  try {
    const opened = openRegisteredRunDirectory(sourceRunsRoot, sourceRun);
    if (!opened.ok) return { ok: false, message: opened.error.message };
    const handle = boundedSourceHandle(opened.value);
    const program = handle.readProgramRegistration();
    if (!program.ok) return { ok: false, message: program.error.message };
    const registration = parseRegistration(program.value);
    if (!registration.ok) return registration;
    const authority = parsedAuthority(registration.value);
    if (!authority.ok) return authority;
    if (serializeStandaloneReviewAuthority(authority.value) !== serializeStandaloneReviewAuthority(source.authority)) {
      return { ok: false, message: "predecessor observation registration changed after result authentication" };
    }
    const observation = readStandaloneReviewedSource(handle, registration.value, STANDALONE_LINEAGE_LIMITS.retainedBytes);
    let snapshot: StandalonePreviousSnapshot;
    if (observation.ok) {
      snapshot = Object.freeze(observation.value.files.map(file => file.kind === "absent"
        ? Object.freeze({ kind: "absent" as const, path: file.path })
        : Object.freeze({ kind: "present" as const, path: file.path, digest: file.digest, mode: null })));
    } else {
      if (registration.value.schemaVersion !== 1) return observation;
      // Never disguise a corrupt or partially present historical observation as absence.
      for (const slot of source.authority.roster.orderedSlots) {
        const packet = handle.readContext(slot.attempts[0].contextDigest);
        if (!packet.ok) return { ok: false, message: packet.error.message };
        if (packet.value.fixedContext.some(section => section.label === "standalone-frozen-source")) return observation;
      }
      snapshot = Object.freeze(source.result.scope.map(path => Object.freeze({ kind: "historical-unknown" as const, path })));
    }
    return walked(prepareStandaloneLineageSource(source.result, handle.runDirectory, snapshot));
  } catch (cause) {
    return { ok: false, message: `predecessor observation unavailable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

export async function readAuthenticatedStandaloneSource(sourceRunsRoot: string, sourceRun: string): Promise<ProgramParse<StandaloneDoneState>> {
  const completed = await readCompletedStandaloneSource(sourceRunsRoot, sourceRun, predecessorTraversal());
  return completed.ok ? { ok: true, value: completed.value.walked } : completed;
}

function readSourceCheckpoint(handle: RunDirHandle, maximumBytes: number): ProgramParse<Buffer> {
  try {
    return { ok: true, value: readRunBytesNoFollow(join(handle.runDirectory, "checkpoint.json"), maximumBytes) };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return { ok: false, message: "source standalone review checkpoint is missing" };
    }
    throw cause;
  }
}

/** The source's machine state, from checkpoint-independent replay (v3) or its checkpoint (v1/v2), with the bytes charged. */
function observeSourceState(handle: RunDirHandle, registration: Extract<ReturnType<typeof parseRegistration>, { ok: true }>["value"],
  prepared: PreparedStandaloneSuccessor | undefined, authority: FrozenStandaloneReviewAuthority,
  traversal: PredecessorTraversal): Walked<StandaloneDoneState> {
  const maximum = predecessorReadBound(traversal, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  let state;
  let bytes: Buffer;
  if (registration.schemaVersion === 3) {
    const replay = replayStandaloneCliCaptures(handle, registration, prepared);
    if (!replay.ok) return { ok: false, message: replay.message };
    bytes = readRunBytesNoFollow(join(handle.runDirectory, "result.json"), maximum);
    if (bytes.toString("utf8") !== replay.json) return { ok: false, message: "published successor result differs from checkpoint-independent capture replay" };
    const receipt = handle.readReceipt(replay.ready.publicationIntent.effectId, STANDALONE_LINEAGE_LIMITS.retainedBytes);
    if (!receipt.ok) return { ok: false, message: receipt.error.message };
    if (receipt.value?.kind !== "artifact-set-published") return { ok: false, message: "successor source lacks exact result publication receipt" };
    state = reduceStandaloneReviewMachine(replay.ready, { kind: "result-published", result: JSON.parse(replay.json), receipt: receipt.value });
  } else {
    const checkpoint = readSourceCheckpoint(handle, maximum);
    if (!checkpoint.ok) return checkpoint;
    bytes = checkpoint.value;
    state = parseStandaloneReviewMachineState(JSON.parse(bytes.toString("utf8")),
      publicationResolver(handle, STANDALONE_LINEAGE_LIMITS.retainedBytes),
      standaloneReviewerProtocolResolver(handle, registration, prepared, STANDALONE_LINEAGE_LIMITS.retainedBytes), authority);
  }
  if (!state.ok || state.value.kind !== "done") return { ok: false, message: state.ok ? "source standalone review is not done" : state.error.message };
  const charged = chargePredecessorBytes(traversal, bytes.length, "source standalone review state");
  return charged.ok ? { ok: true, value: { walked: state.value, traversal: charged.value } } : { ok: false, message: charged.error };
}

/** One bounded explicit predecessor walk; neither a missing nor corrupt current source is history. */
async function readCompletedStandaloneSource(sourceRunsRoot: string, sourceRun: string,
  traversal: PredecessorTraversal): Promise<Walked<CompletedSource>> {
  try {
    const opened = openRegisteredRunDirectory(sourceRunsRoot, sourceRun);
    if (!opened.ok) return { ok: false, message: `source run: ${opened.error.message}` };
    const handle = boundedSourceHandle(opened.value);
    const entered = enterPredecessorRun(traversal, handle.runDirectory);
    if (!entered.ok) return { ok: false, message: entered.error };
    let child = entered.value;
    const program = handle.readProgramRegistration();
    if (!program.ok) return { ok: false, message: program.error.message };
    if (program.value === null) return { ok: false, message: "source standalone review registration is missing" };
    const registration = parseRegistration(program.value);
    if (!registration.ok) return registration;
    let prepared: PreparedStandaloneSuccessor | undefined;
    if (registration.value.schemaVersion === 3) {
      const successor = await successorAuthorityWithin(handle, registration.value, child);
      if (!successor.ok) return successor;
      prepared = successor.value.walked.prepared;
      child = successor.value.traversal;
    }
    const authority = parsedAuthority(registration.value, prepared);
    if (!authority.ok) return authority;
    if (authority.value.runId !== handle.runId) return { ok: false, message: "source registration belongs to another Run" };
    const observed = observeSourceState(handle, registration.value, prepared, authority.value, child);
    if (!observed.ok) return observed;
    const published = readPublishedStandaloneResult(handle, observed.value.walked, STANDALONE_LINEAGE_LIMITS.retainedBytes);
    if (!published.ok) return published;
    // A source must still name the same anchored Run after all receipt/context reads.
    const identity = readRunBytesNoFollow(join(handle.runDirectory, "authority.json"), 16_384);
    const anchored = admitAnchoredRunAuthority(JSON.parse(identity.toString("utf8")),
      { runId: handle.runId, runsRoot: handle.identity.runsRoot, runDirectory: handle.runDirectory });
    if (!anchored.ok) return { ok: false, message: anchored.error };
    return { ok: true, value: { walked: Object.freeze({ ...published.value, locator: handle.runDirectory }),
      traversal: resumeAfterChildWalk(traversal, observed.value.traversal) } };
  } catch (cause) {
    return { ok: false, message: `source standalone review is unavailable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
