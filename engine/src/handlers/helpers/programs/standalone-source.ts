/** Shared downward source authentication for remediation and advisory custody. No source I/O lives in core. */
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { encodeByteSection, type ByteSection } from "../../../core/context-packets";
import { parseBoundedReviewerJson } from "../../../core/reviewer-protocol";
import { selectStandaloneReviewers } from "../../../core/standalone-review";
import { prepareStandaloneSuccessor, type PreparedStandaloneSuccessor, type StandaloneDispositionSelection } from "../../../core/standalone-lineage";
import { readSelectedStandaloneDisposition } from "./standalone-disposition-source";
import { boundedStandaloneReadHandle as boundedSourceHandle, successorSourceSnapshot, standaloneSuccessorPackets, SUCCESSOR_CONTEXT_PAYLOAD_BYTES } from "./standalone-successor-source";
import type { RegisteredStandaloneSuccessorProgram, StandaloneSuccessorStartInput } from "./standalone-successor-registration";
import type { StandaloneReviewMetadata, FrozenStandaloneReviewAuthority } from "../../../core/standalone-review";
import { sameRegisteredStandalonePrograms, standaloneReviewerProtocolResolver } from "./helpers";
import { canonicalStructuralEquals } from "../../../core/orchestration-contract";
import { parseStandaloneReviewMachineState, reduceStandaloneReviewMachine, type StandaloneDoneState } from "../../../core/standalone-review-machine";
import { serializeStandaloneReviewAuthority } from "../../../core/standalone-review";
import { STANDALONE_LINEAGE_LIMITS, type StandalonePreviousSnapshot } from "../../../core/standalone-lineage-contract";
import { prepareStandaloneLineageSource, type StandaloneLineageSource } from "../../../core/standalone-lineage";
import { readStandaloneReviewedSource, replayStandaloneCliCaptures } from "./standalone-evidence";
import { readRunBytesNoFollow } from "../../../orchestration/no-follow-fs";
import { openRegisteredRunDirectory, type RunDirHandle } from "../../../orchestration/run-directory-handle";
import { parsedAuthority, parseRegistration, publishedReviewerRequest, publicationResolver, readPublishedStandaloneResult, type ProgramParse } from "./helpers";

type SuccessorSourcePreparation = Readonly<{ prepared: PreparedStandaloneSuccessor;
  packets: Extract<ReturnType<typeof standaloneSuccessorPackets>, { ok: true }>["value"]["packets"];
  contexts: Extract<ReturnType<typeof standaloneSuccessorPackets>, { ok: true }>["value"]["contexts"] }>;

/** Preserve the originally issued archive encoding; compressor versions never select new context bytes on resume. */
function predecessorContextSection(label: string, bytes: Buffer, frozen: ByteSection | undefined,
  path: string, purpose: "v1-v2" | "standalone-successor"): ProgramParse<ByteSection> {
  const reference = { encoding: "published-packet-reference", byteLength: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), path, purpose };
  if (frozen === undefined) {
    const section = encodeByteSection(label, JSON.stringify(reference));
    return section.ok ? section : { ok: false, message: section.error.message };
  }
  const decoded = parseBoundedReviewerJson(Uint8Array.from(frozen.bytes), SUCCESSOR_CONTEXT_PAYLOAD_BYTES);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) return { ok: false, message: "invalid frozen predecessor archive" };
  const archive = decoded.value;
  if ("encoding" in archive && archive.encoding === "published-packet-reference") {
    return canonicalStructuralEquals(archive, reference) ? { ok: true, value: frozen }
      : { ok: false, message: "predecessor reference differs from independently authenticated exact packet" };
  }
  if (Object.keys(archive).length !== 4 || !("encoding" in archive) || archive.encoding !== "gzip-base64" ||
      !("contentBase64" in archive) || typeof archive.contentBase64 !== "string" || archive.contentBase64.length > SUCCESSOR_CONTEXT_PAYLOAD_BYTES ||
      !("byteLength" in archive) || archive.byteLength !== bytes.length || !("digest" in archive) ||
      archive.digest !== createHash("sha256").update(bytes).digest("hex")) return { ok: false, message: "predecessor archive identity differs from authenticated bytes" };
  const compressed = Buffer.from(archive.contentBase64, "base64");
  if (compressed.toString("base64") !== archive.contentBase64 || !gunzipSync(compressed, { maxOutputLength: bytes.length + 1 }).equals(bytes)) {
    return { ok: false, message: "predecessor archive does not retain exact authenticated Context Packet bytes" };
  }
  return { ok: true, value: frozen };
}

/** Authentication data shared by initial issuance and every resume; no parsed JSON can supply membership. */
export async function prepareStandaloneSuccessorSource(input: StandaloneSuccessorStartInput, runId: string,
  currentSource: ByteSection, reviewers: StandaloneReviewMetadata | readonly string[],
  traversal: SourceTraversal = { visited: [], remaining: 64 * 1024 * 1024 },
  frozenPreviousContexts?: readonly ByteSection[]): Promise<ProgramParse<SuccessorSourcePreparation>> {
  const reference = input.successor.source;
  const source = await readAuthenticatedStandaloneLineageSource(dirname(reference.locator), reference.locator, traversal);
  if (!source.ok) return source;
  if (!canonicalStructuralEquals(source.value.publication, reference)) return { ok: false as const, message: "successor predecessor differs from exact published Run/result identity" };
  let disposition: StandaloneDispositionSelection = { kind: "historical-decision-unavailable" };
  if (input.successor.disposition.kind === "selected-record") {
    const selected = readSelectedStandaloneDisposition(source.value, input.successor.disposition.publication);
    if (!selected.ok) return selected;
    disposition = { kind: "selected-record", disposition: selected.value };
  }
  const snapshot = successorSourceSnapshot(currentSource, input.files);
  if (!snapshot.ok) return snapshot;
  const roles = "requestedKinds" in reviewers ? selectStandaloneReviewers(reviewers) : reviewers;
  const prepared = prepareStandaloneSuccessor(source.value, Buffer.from(JSON.stringify({ runId, snapshot: snapshot.value, reviewers: roles })), disposition);
  if (!prepared.ok) return { ok: false as const, message: prepared.error.message };
  const previous = openRegisteredRunDirectory(dirname(reference.locator), reference.locator);
  if (!previous.ok || previous.value.runDirectory !== reference.locator || previous.value.runId !== reference.runId) {
    return { ok: false as const, message: "predecessor locator differs from anchored identity" };
  }
  const raw = previous.value.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!raw.ok) return { ok: false as const, message: raw.error.message };
  const registration = parseRegistration(raw.value);
  if (!registration.ok) return registration;
  // Retain every issued predecessor attempt's exact packet bytes, including a semantic retry.
  // Unissued historical contexts are not invented or represented as observed publication.
  const requests = previous.value.readIssuedRequests(STANDALONE_LINEAGE_LIMITS.retainedBytes, 128);
  if (!requests.ok) return { ok: false as const, message: requests.error.message };
  const contexts: ByteSection[] = [];
  let remaining = 64 * 1024 * 1024;
  for (const role of source.value.reviewers) {
    const candidates = requests.value.filter(request => request.program === "standalone-review" && request.role === role)
      .sort((left, right) => left.attempt - right.attempt);
    if (candidates.length < 1 || candidates.length > 2 || candidates[0]!.attempt !== 1 ||
        (candidates.length === 2 && candidates[1]!.attempt !== 2)) return { ok: false as const, message: "predecessor context requires exact issued attempt roster" };
    for (const request of candidates) {
      const issued = publishedReviewerRequest(previous.value, request, STANDALONE_LINEAGE_LIMITS.retainedBytes);
      if (!issued.ok) return issued;
      const bytes = readRunBytesNoFollow(join(reference.locator, "contexts", `${request.contextDigest}.json`), Math.min(remaining, traversal.remaining));
      remaining -= bytes.length; traversal.remaining -= bytes.length;
      const packet = registration.value.schemaVersion === 3
        ? previous.value.readStandaloneSuccessorContext(request.contextDigest, STANDALONE_LINEAGE_LIMITS.retainedBytes)
        : previous.value.readContext(request.contextDigest, STANDALONE_LINEAGE_LIMITS.retainedBytes);
      const decoded = parseBoundedReviewerJson(bytes, STANDALONE_LINEAGE_LIMITS.retainedBytes);
      // The packet's ImmutableByteSequence sections equal their parsed wire
      // arrays under canonicalStructuralEquals, so the live packet compares
      // against the authenticated bytes directly — no untyped JSON projection
      // sits between the observation and the proof, and JSON.stringify's
      // silent-drop semantics never touch a published-identity comparison.
      if (!packet.ok || !decoded.ok || !canonicalStructuralEquals(packet.value, decoded.value)) {
        return { ok: false as const, message: "predecessor exact Context Packet bytes changed during observation" };
      }
      // Exact published-byte references avoid recursively embedding predecessor packets.
      // Original files stay mandatory: neither source replay nor the reader can fall back.
      const label = `predecessor-context:${role}${request.attempt === 2 ? ":attempt-2" : ""}`;
      const frozen = frozenPreviousContexts?.find(section => section.label === label);
      if (frozenPreviousContexts !== undefined && frozen === undefined) return { ok: false, message: "missing frozen predecessor context" };
      const archived = predecessorContextSection(label, bytes, frozen,
        join(reference.locator, "contexts", `${request.contextDigest}.json`), registration.value.schemaVersion === 3 ? "standalone-successor" : "v1-v2");
      if (!archived.ok) return archived;
      contexts.push(archived.value);
      if (contexts.length === 1) {
        const sources = [...packet.value.fixedContext, ...packet.value.variableContext].filter(row => row.label === "standalone-frozen-source");
        const archiveData: unknown = JSON.parse(Buffer.from(archived.value.bytes).toString("utf8"));
        const legacyArchive = typeof archiveData === "object" && archiveData !== null && "encoding" in archiveData && archiveData.encoding === "gzip-base64";
        let previousSourceText: string;
        if (legacyArchive) previousSourceText = sources.length === 1 ? Buffer.from(sources[0]!.bytes).toString("utf8")
          : JSON.stringify({ kind: "historical-unknown", snapshot: source.value.snapshot });
        else previousSourceText = JSON.stringify({ kind: "published-source-reference", snapshot: source.value.snapshot,
          archive: label, purpose: registration.value.schemaVersion === 3 ? "standalone-successor" : "v1-v2",
          usage: "Use --archive with this label and --archive-purpose, then --file EXACT_PATH to read original source." });
        const previousSource = encodeByteSection("predecessor-frozen-source", previousSourceText);
        if (!previousSource.ok) return { ok: false, message: previousSource.error.message };
        contexts.push(previousSource.value);
      }
    }
  }
  if (frozenPreviousContexts !== undefined && !canonicalStructuralEquals(frozenPreviousContexts, contexts)) return { ok: false, message: "frozen predecessor source/context inventory differs from authenticated observations" };
  const packets = standaloneSuccessorPackets(prepared.value, currentSource, contexts);
  return packets.ok ? { ok: true as const, value: Object.freeze({ prepared: prepared.value, ...packets.value }) } : packets;
}

export async function readStandaloneSuccessorAuthority(handle: RunDirHandle, registration: RegisteredStandaloneSuccessorProgram,
  traversal: SourceTraversal = { visited: [handle.runDirectory], remaining: 64 * 1024 * 1024 }): Promise<ProgramParse<SuccessorSourcePreparation & { readonly authority: FrozenStandaloneReviewAuthority }>> {
  const stored = handle.readProgramRegistration(STANDALONE_LINEAGE_LIMITS.retainedBytes);
  const observed = stored.ok ? parseRegistration(stored.value) : { ok: false as const };
  const supplied = parseRegistration(registration);
  if (!observed.ok || !supplied.ok || !sameRegisteredStandalonePrograms(observed.value, supplied.value)) return { ok: false as const, message: "successor registration differs from independently read durable bytes" };
  const raw = registration.authority;
  if (typeof raw !== "object" || raw === null || !("reviewers" in raw) || !Array.isArray(raw.reviewers) || raw.reviewers.some(role => typeof role !== "string")) {
    return { ok: false as const, message: "successor frozen reviewer roster is malformed" };
  }
  const prepared = await prepareStandaloneSuccessorSource(registration.input, handle.runId, registration.currentSource, raw.reviewers, traversal, registration.previousContexts);
  if (!prepared.ok) return prepared;
  const authority = parsedAuthority(registration, prepared.value.prepared);
  if (!authority.ok) return authority;
  if (authority.value.runId !== handle.runId || !canonicalStructuralEquals(authority.value.scope, registration.input.files) ||
      !canonicalStructuralEquals(authority.value.reviewMetadata.requestedKinds, [registration.input.kind]) ||
      authority.value.roster.orderedSlots.some((slot, index) => slot.attempts.some((request, attempt) =>
        request.contextDigest !== prepared.value.contexts[index]?.attempts[attempt]))) {
    return { ok: false as const, message: "successor source/roster/context bytes differ from frozen registration" };
  }
  return { ok: true as const, value: Object.freeze({ ...prepared.value, authority: authority.value }) };
}

/** Current contexts must contain their source observation; only genuinely historical absence stays unknown. */
export async function readAuthenticatedStandaloneLineageSource(sourceRunsRoot: string, sourceRun: string,
  traversal: SourceTraversal = { visited: [], remaining: 64 * 1024 * 1024 }): Promise<ProgramParse<StandaloneLineageSource>> {
  const completed = await readCompletedStandaloneSource(sourceRunsRoot, sourceRun, traversal);
  if (!completed.ok) return completed;
  if (completed.value.result.schemaVersion === 3) {
    const prepared = prepareStandaloneLineageSource(completed.value.result, completed.value.locator);
    return prepared.ok ? prepared : { ok: false, message: prepared.error.message };
  }
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
    if (serializeStandaloneReviewAuthority(authority.value) !== serializeStandaloneReviewAuthority(completed.value.authority)) {
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
      for (const slot of completed.value.authority.roster.orderedSlots) {
        const packet = handle.readContext(slot.attempts[0].contextDigest);
        if (!packet.ok) return { ok: false, message: packet.error.message };
        if (packet.value.fixedContext.some(section => section.label === "standalone-frozen-source")) return observation;
      }
      snapshot = Object.freeze(completed.value.result.scope.map(path => Object.freeze({ kind: "historical-unknown" as const, path })));
    }
    const prepared = prepareStandaloneLineageSource(completed.value.result, handle.runDirectory, snapshot);
    return prepared.ok ? prepared : { ok: false, message: prepared.error.message };
  } catch (cause) {
    return { ok: false, message: `predecessor observation unavailable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

export async function readAuthenticatedStandaloneSource(sourceRunsRoot: string, sourceRun: string): Promise<ProgramParse<StandaloneDoneState>> {
  return readCompletedStandaloneSource(sourceRunsRoot, sourceRun, { visited: [], remaining: 64 * 1024 * 1024 });
}

/** One bounded explicit predecessor walk; neither a missing nor corrupt current source is history. */
type SourceTraversal = { readonly visited: readonly string[]; remaining: number };

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

async function readCompletedStandaloneSource(sourceRunsRoot: string, sourceRun: string, traversal: SourceTraversal): Promise<ProgramParse<StandaloneDoneState & { readonly locator: string }>> {
  try {
    const opened = openRegisteredRunDirectory(sourceRunsRoot, sourceRun);
    if (!opened.ok) return { ok: false, message: `source run: ${opened.error.message}` };
    const handle = boundedSourceHandle(opened.value);
    if (traversal.visited.length >= 64 || traversal.visited.includes(handle.runDirectory)) return { ok: false, message: "predecessor traversal is cyclic or exceeds 64 Runs" };
    const child: SourceTraversal = { visited: [...traversal.visited, handle.runDirectory], remaining: traversal.remaining };
    const program = handle.readProgramRegistration();
    if (!program.ok) return { ok: false, message: program.error.message };
    if (program.value === null) return { ok: false, message: "source standalone review registration is missing" };
    const registration = parseRegistration(program.value);
    if (!registration.ok) return registration;
    const successor = registration.value.schemaVersion === 3 ? await readStandaloneSuccessorAuthority(handle, registration.value, child) : undefined;
    if (successor !== undefined && !successor.ok) return successor;
    const prepared = successor?.value.prepared;
    const authority = parsedAuthority(registration.value, prepared);
    if (!authority.ok) return authority;
    if (authority.value.runId !== handle.runId) return { ok: false, message: "source registration belongs to another Run" };
    const state = (() => {
      if (registration.value.schemaVersion === 3) {
        const replay = replayStandaloneCliCaptures(handle, registration.value, prepared);
        if (!replay.ok) return { ok: false as const, error: { message: replay.message } };
        const result = readRunBytesNoFollow(join(handle.runDirectory, "result.json"), Math.min(STANDALONE_LINEAGE_LIMITS.retainedBytes, child.remaining));
        child.remaining -= result.length;
        if (result.toString("utf8") !== replay.json) return { ok: false as const, error: { message: "published successor result differs from checkpoint-independent capture replay" } };
        const receipt = handle.readReceipt(replay.ready.publicationIntent.effectId, STANDALONE_LINEAGE_LIMITS.retainedBytes);
        if (!receipt.ok) return receipt;
        if (receipt.value?.kind !== "artifact-set-published") return { ok: false as const, error: { message: "successor source lacks exact result publication receipt" } };
        return reduceStandaloneReviewMachine(replay.ready, { kind: "result-published", result: JSON.parse(replay.json), receipt: receipt.value });
      }
      const checkpoint = readSourceCheckpoint(handle, Math.min(STANDALONE_LINEAGE_LIMITS.retainedBytes, child.remaining));
      if (!checkpoint.ok) return { ok: false as const, error: { message: checkpoint.message } };
      child.remaining -= checkpoint.value.length;
      return parseStandaloneReviewMachineState(JSON.parse(checkpoint.value.toString("utf8")),
        publicationResolver(handle, STANDALONE_LINEAGE_LIMITS.retainedBytes),
        standaloneReviewerProtocolResolver(handle, registration.value, prepared, STANDALONE_LINEAGE_LIMITS.retainedBytes), authority.value);
    })();
    if (!state.ok || state.value.kind !== "done") return { ok: false, message: state.ok ? "source standalone review is not done" : state.error.message };
    const published = readPublishedStandaloneResult(handle, state.value, STANDALONE_LINEAGE_LIMITS.retainedBytes);
    if (!published.ok) return published;
    // A source must still name the same anchored Run after all receipt/context reads.
    const identity = readRunBytesNoFollow(join(handle.runDirectory, "authority.json"), 16_384);
    if (!canonicalStructuralEquals(JSON.parse(identity.toString("utf8")), { schemaVersion: 1, runId: handle.runId,
      runsRoot: handle.identity.runsRoot, runDirectory: handle.runDirectory })) return { ok: false, message: "source Run authority changed during authentication" };
    traversal.remaining = child.remaining;
    return { ok: true, value: Object.freeze({ ...published.value, locator: handle.runDirectory }) };
  } catch (cause) {
    return { ok: false, message: `source standalone review is unavailable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
