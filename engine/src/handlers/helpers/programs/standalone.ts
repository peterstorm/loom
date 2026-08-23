/**
 * Façade program driver volume (A14): the imperative shell's program drivers
 * were one 2,900-line module; this volume owns ONE program's driver (or, for
 * helpers, the shared recovery/git/scope machinery). The public surface is
 * re-exported by index.ts so all existing import sites are unchanged.
 */
import { createHash } from 'node:crypto';
import { parseAgentRequestAuthority, parseIssuedSpawnRequest, type AgentRequestAuthority, type InitialSpawnRequestInput, type SpawnRequest } from '../../../core/orchestration-contract';
import { aggregateStandaloneReview, bindStandaloneCaptureAuthority, captureStandaloneReviewerBytes, canonicalStandaloneResultArtifact, completeStandaloneReviewerCapture, parseStandaloneReviewScope, prepareFreshStandaloneReview, proveStandaloneRosterCompletion, serializeStandaloneReviewAuthority, serializeAdjudicatedStandaloneReview, admitStandaloneTranscript, type FrozenStandaloneReviewAuthority, type StandaloneTranscriptAdmission } from '../../../core/standalone-review';
import { parseStandaloneReviewMachineState, reduceStandaloneReviewMachine, freezeStandaloneRefutationPanelAuthority, parseStandaloneRefutationCompletion, serializeStandaloneReviewMachineState, startStandaloneReviewMachine, type StandaloneReviewMachineState } from '../../../core/standalone-review-machine';
import { buildStandaloneFindingBrief, defaultRefutationThreshold, reviewSignals, selectReviewLenses } from '../../../core/review-panel';
import { completePersistentRefutationPanel, deriveRefutationVerifierBinding, panelRequestIdentity, parseRefutationPanelAuthority, refutationPanelCheckpoint, startPersistentRefutationPanel, submitRefutationVerdict, type PersistentRefutationPanelEvent } from '../../../core/panel-program';
import { buildContextPacket, encodeByteSection, type ContextPacket } from '../../../orchestration/context-packets';
import { readRunBytesNoFollow, writeRunBytesExclusiveNoFollow } from '../../../orchestration/no-follow-fs';
import { captureKey } from '../../../core/harness-capture';
import { type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { resolveModelProfile, lowerModelProfile } from '../../../core/model-profiles';
import { decodeReviewerTranscript, deriveChangedPaths, durableCaptureRejection, durablePublicationDigest, durableRefutationRequests, durableRequests, exactObject, executableRefutationRequests, failed, metadata, parsedAuthority, publicationFile, publicationResolver, publishInitialBatch, recoverOrPublishRefutationRetry, recoverOrPublishStandaloneRetry, refutationRejectionDiagnostic, renderSpawnTask, safeScope, standalonePackets, standalonePublicationEffectId, standaloneRetryEffectId, standaloneRetryTask, type FacadeDriveResult, type RegisteredStandaloneProgram } from './helpers';

export async function startStandaloneFacade(
  handle: RunDirHandle,
  input: RegisteredStandaloneProgram["input"],
): Promise<FacadeDriveResult> {
  try {
    const changed = deriveChangedPaths();
    const union = [...new Set([
      ...changed.authority.unstaged,
      ...changed.authority.staged,
      ...changed.authority.committed,
    ])].sort();
    const parsedScope = parseStandaloneReviewScope(input.files ?? union);
    if (!parsedScope.ok) return failed(parsedScope.errors.join("; "));
    const scope = parsedScope.value;
    const reviewMetadata = metadata(input.kind, scope, changed);
    const packetSet = standalonePackets(handle.runId, reviewMetadata, scope, changed.authority.head_revision);
    const prepared = prepareFreshStandaloneReview({
      runId: handle.runId,
      ...(input.files === null ? {} : { explicitScope: scope }),
      changedPaths: changed.authority,
      reviewMetadata: {
        requested_kinds: reviewMetadata.requestedKinds,
        docs_only: reviewMetadata.docsOnly,
        source_or_test_changed: reviewMetadata.sourceOrTestChanged,
        types_changed: reviewMetadata.typesChanged,
        comments_changed: reviewMetadata.commentsChanged,
        additions: reviewMetadata.additions,
        file_count: reviewMetadata.fileCount,
        new_structure: reviewMetadata.newStructure,
        languages: reviewMetadata.languages,
      },
      scopeSafety: safeScope(scope),
      reviewerContexts: packetSet.contexts,
    });
    if (!prepared.ok) return failed(prepared.error.errors.join("; "));
    const registration: RegisteredStandaloneProgram = Object.freeze({
      schemaVersion: 1,
      kind: "standalone-review",
      input,
      authority: JSON.parse(serializeStandaloneReviewAuthority(prepared.value.authority)),
    });
    const registered = await handle.registerProgram(registration);
    if (!registered.ok) return failed(registered.error.message);
    const initialRequests = prepared.value.initialRequests.map((authority) => Object.freeze({
      authority,
      context: Object.freeze({
        digest: authority.contextDigest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
      }),
    }));
    // Publish every attempt-1 AND attempt-2 context up front. Attempt 2 is the
    // engine's only recovery path for a semantically rejected reviewer slot; a
    // retry must find its frozen packet already content-addressed in the run
    // directory, so the attempt-2 digest the roster froze at start can never
    // drift from the bytes a later retry reads (the frozen-source section hashes
    // worktree bytes at start time and must not be re-derived later).
    for (const packet of packetSet.packets) {
      const published = await handle.publishContext(packet);
      if (!published.ok) return failed(published.error.message);
    }
    const batch = await publishInitialBatch(handle, initialRequests, packetSet.packets.filter((_, index) => index % 2 === 0), "standalone-review");
    if (!batch.ok) return failed(batch.message);
    const awaiting = reduceStandaloneReviewMachine(startStandaloneReviewMachine(prepared.value.authority), {
      kind: "review-batch-published", runId: handle.runId,
    });
    if (!awaiting.ok) return failed(awaiting.error.message);
    await handle.writeCheckpoint(serializeStandaloneReviewMachineState(awaiting.value));
    return { ok: true, action: batch.action };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

export function standaloneRefutationPreparation(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  aggregate: import("../../../core/standalone-review").StandaloneReviewAggregate,
) {
  const brief = buildStandaloneFindingBrief(aggregate);
  const selected = selectReviewLenses(reviewSignals(brief.findings), 3);
  if (!selected.ok) throw new Error(selected.errors.join("; "));
  const lenses = selected.value;
  const slots = [];
  const packets: ContextPacket[] = [];
  const inputs: InitialSpawnRequestInput[] = [];
  const retryInputs: Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[] = [];
  const profile = resolveModelProfile("refutation");
  if (!profile.ok) throw new Error(profile.error.message);
  for (let index = 0; index < lenses.length; index += 1) {
    const lens = lenses[index]!;
    const [firstFinding, ...otherFindings] = brief.findings;
    if (firstFinding === undefined) throw new Error("standalone refutation requires a non-empty critical Finding set");
    const binding = deriveRefutationVerifierBinding(
      handle.runId,
      lens,
      [firstFinding.id, ...otherFindings.map(({ id }) => id)],
    );
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = binding.value.requestIds[attempt - 1];
      const section = encodeByteSection("refutation-authority", JSON.stringify({
        runId: handle.runId, lens, findings: brief.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId,
        role: "review-verifier-agent",
        requiredSkill: "none",
        outputContract: `Adjudicate every Finding through lens '${lens}' and emit the exact refutation verdict JSON contract.`,
        fixedContext: Object.freeze([section.value]), variableContext: Object.freeze([]),
      });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const parsed = parseAgentRequestAuthority({
        runId: handle.runId, requestId, slotId: binding.value.slotId,
        program: "refutation-panel", role: "review-verifier-agent", attempt,
        modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest,
        outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw`,
      });
      if (!parsed.ok) throw new Error(parsed.error.violations.map(({ message }) => message).join("; "));
      const input = { authority: parsed.value, context: {
        digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` },
      } };
      if (attempt === 1) inputs.push(input);
      else retryInputs.push(Object.freeze({ input: Object.freeze(input), packet: packet.value }));
      return parsed.value;
    });
    slots.push({ slotId: binding.value.slotId, attempts });
  }
  const panel = parseRefutationPanelAuthority({ runId: handle.runId, findings: brief.findings, lenses, verifierSlots: slots });
  if (!panel.ok) throw new Error(panel.error.message);
  const threshold = defaultRefutationThreshold(lenses.length);
  const frozen = freezeStandaloneRefutationPanelAuthority({ standaloneAuthority: authority, aggregate, panelAuthority: panel.value, threshold });
  if (!frozen.ok) throw new Error(frozen.error.message);
  return { brief, lenses, panel: panel.value, frozen: frozen.value, threshold, packets, inputs, retryInputs };
}

export type StandaloneEvidenceReplayResult =
  | Readonly<{ ok: true; json: string; digest: string }>
  | Readonly<{ ok: false; message: string }>;

export type StandaloneCaptureWitness = Readonly<{
  requestId: string;
  role: string;
  contextDigest: string;
  digest: string;
  byteLength: number;
}>;

type StandaloneScopePacketAuthority = Readonly<{
  runId: string;
  scope: readonly string[];
  role: string;
  attempt: 1 | 2;
}>;

export type StandaloneReviewedSourceFile =
  | Readonly<{ path: string; kind: "file"; digest: string; byteLength: number }>
  | Readonly<{ path: string; kind: "absent"; digest: null; byteLength: 0 }>;

export type StandaloneReviewedSource = Readonly<{
  schemaVersion: 1;
  headRevision: string;
  files: readonly StandaloneReviewedSourceFile[];
}>;

function parseScopePacketAuthority(bytes: readonly number[]):
  | Readonly<{ ok: true; value: StandaloneScopePacketAuthority }>
  | Readonly<{ ok: false; message: string }> {
  try {
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return Object.freeze({ ok: false, message: "standalone-review-authority context section must be an object" });
    }
    const record = raw as Record<string, unknown>;
    if (!exactObject(record, ["attempt", "role", "runId", "scope"]) ||
        typeof record.runId !== "string" || typeof record.role !== "string" ||
        (record.attempt !== 1 && record.attempt !== 2) || !Array.isArray(record.scope) ||
        record.scope.length === 0 || record.scope.some((path) => typeof path !== "string" || path.length === 0)) {
      return Object.freeze({ ok: false, message: "standalone-review-authority context section is malformed" });
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        runId: record.runId,
        scope: Object.freeze([...(record.scope as string[])]),
        role: record.role,
        attempt: record.attempt,
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      message: `standalone-review-authority context section is invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function parseReviewedSource(bytes: readonly number[], scope: readonly string[]):
  | Readonly<{ ok: true; value: StandaloneReviewedSource }>
  | Readonly<{ ok: false; message: string }> {
  const malformed = (message: string) => Object.freeze({ ok: false as const, message });
  try {
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return malformed("standalone-frozen-source context section must be an object");
    }
    const record = raw as Record<string, unknown>;
    if (!exactObject(record, ["files", "headRevision", "schemaVersion"]) ||
        record.schemaVersion !== 1 || typeof record.headRevision !== "string" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.headRevision) ||
        !Array.isArray(record.files) || record.files.length !== scope.length) {
      return malformed("standalone-frozen-source context section is malformed");
    }
    const files: StandaloneReviewedSourceFile[] = [];
    for (const [index, rawFile] of record.files.entries()) {
      if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
        return malformed(`standalone-frozen-source file ${index} must be an object`);
      }
      const file = rawFile as Record<string, unknown>;
      if (file.path !== scope[index] || typeof file.kind !== "string") {
        return malformed(`standalone-frozen-source file ${index} does not match the registered scope`);
      }
      if (file.kind === "absent") {
        if (!exactObject(file, ["byteLength", "digest", "kind", "path"]) ||
            file.digest !== null || file.byteLength !== 0) {
          return malformed(`standalone-frozen-source absent file ${index} is malformed`);
        }
        files.push(Object.freeze({ path: file.path as string, kind: "absent", digest: null, byteLength: 0 }));
        continue;
      }
      const contentKey = file.kind === "text" ? "content" : file.kind === "binary" ? "contentBase64" : null;
      if (contentKey === null || typeof file.digest !== "string" || !/^[0-9a-f]{64}$/.test(file.digest) ||
          !Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0 || typeof file[contentKey] !== "string" ||
          !exactObject(file, ["byteLength", contentKey, "digest", "kind", "path"])) {
        return malformed(`standalone-frozen-source file ${index} is malformed`);
      }
      const content = file[contentKey] as string;
      const sourceBytes = file.kind === "text" ? Buffer.from(content, "utf8") : Buffer.from(content, "base64");
      if ((file.kind === "binary" && sourceBytes.toString("base64") !== content) ||
          sourceBytes.byteLength !== file.byteLength ||
          createHash("sha256").update(sourceBytes).digest("hex") !== file.digest) {
        return malformed(`standalone-frozen-source file ${index} content does not match its digest and length`);
      }
      files.push(Object.freeze({
        path: file.path as string,
        kind: "file",
        digest: file.digest,
        byteLength: file.byteLength as number,
      }));
    }
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        schemaVersion: 1 as const,
        headRevision: record.headRevision,
        files: Object.freeze(files),
      }),
    });
  } catch (error) {
    return malformed(`standalone-frozen-source context section is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scopePacketProblem(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  request: AgentRequestAuthority,
): string | null {
  const packet = handle.readContext(request.contextDigest);
  if (!packet.ok) return packet.error.message;
  if (packet.value.requestId !== request.requestId || packet.value.role !== request.role) {
    return `context ${request.contextDigest} does not match issued request ${request.requestId}`;
  }
  const sections = packet.value.fixedContext.filter(({ label }) => label === "standalone-review-authority");
  if (sections.length !== 1) {
    return `context ${request.contextDigest} must contain exactly one standalone-review-authority section`;
  }
  const parsed = parseScopePacketAuthority(sections[0]!.bytes);
  if (!parsed.ok) return parsed.message;
  const witnessed = parsed.value;
  if (witnessed.runId !== authority.runId || witnessed.role !== request.role ||
      witnessed.attempt !== request.attempt || JSON.stringify(witnessed.scope) !== JSON.stringify(authority.scope)) {
    return `context ${request.contextDigest} scope authority does not match registered standalone authority`;
  }
  return null;
}

export function readStandaloneReviewedSource(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram,
): Readonly<{ ok: true; value: StandaloneReviewedSource }> | Readonly<{ ok: false; message: string }> {
  const authorityResult = parsedAuthority(registration);
  if (!authorityResult.ok) return authorityResult;
  const authority = authorityResult.value;
  let reviewed: StandaloneReviewedSource | null = null;
  let sectionDigest: string | null = null;
  for (const slot of authority.roster.orderedSlots) {
    const request = slot.attempts[0];
    const packetProblem = scopePacketProblem(handle, authority, request);
    if (packetProblem !== null) return Object.freeze({ ok: false, message: packetProblem });
    const packet = handle.readContext(request.contextDigest);
    if (!packet.ok) return Object.freeze({ ok: false, message: packet.error.message });
    const sections = packet.value.fixedContext.filter(({ label }) => label === "standalone-frozen-source");
    if (sections.length !== 1) {
      return Object.freeze({
        ok: false,
        message: `context ${request.contextDigest} must contain exactly one standalone-frozen-source section`,
      });
    }
    if (sectionDigest !== null && sections[0]!.digest !== sectionDigest) {
      return Object.freeze({ ok: false, message: "standalone reviewer contexts attest different frozen source snapshots" });
    }
    const parsed = parseReviewedSource(sections[0]!.bytes, authority.scope);
    if (!parsed.ok) return parsed;
    sectionDigest = sections[0]!.digest;
    reviewed = parsed.value;
  }
  return reviewed === null
    ? Object.freeze({ ok: false, message: "standalone authority has no reviewer source snapshot" })
    : Object.freeze({ ok: true, value: reviewed });
}

function durableStandaloneRetryRequest(
  handle: RunDirHandle,
  slot: FrozenStandaloneReviewAuthority["roster"]["orderedSlots"][number],
  resolver: ReturnType<typeof publicationResolver>,
): Readonly<{ ok: true; value: SpawnRequest }> | Readonly<{ ok: false; message: string }> {
  const authority = slot.attempts[1];
  const effectId = standaloneRetryEffectId(slot.slotId, authority.requestId);
  if (!effectId.ok) return effectId;
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind !== "found") {
    return Object.freeze({
      ok: false,
      message: publication.kind === "absent"
        ? `standalone retry publication is absent for ${slot.slotId}`
        : publication.message,
    });
  }
  const parsed = parseIssuedSpawnRequest(resolver, {
    authority,
    context: {
      digest: authority.contextDigest,
      slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` },
    },
    issuance: {
      schemaVersion: 1,
      kind: "issued-spawn-request-proof",
      runId: handle.runId,
      effectId: effectId.value,
      publicationDigest: publication.digest,
      batchIndex: 0,
    },
  });
  return parsed.ok
    ? Object.freeze({ ok: true, value: parsed.value })
    : Object.freeze({ ok: false, message: `durable standalone retry request is invalid: ${parsed.error.message}` });
}

/**
 * Recompute the canonical result from frozen authority and captured evidence.
 *
 * This deliberately does not read the machine checkpoint or an existing
 * result.json. Callers use it when those completion projections are evidence
 * to verify rather than authority to trust. Scope comes from the immutable
 * request Context Packets witnessed by the Pi process, not merely from the
 * reread registration. Supported semantic attempt-2 retries are reconstructed
 * from their durable publication authority and the exact witnessed bytes.
 */
export function replayStandaloneResultFromEvidence(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram,
  witnesses: ReadonlyMap<string, StandaloneCaptureWitness>,
): StandaloneEvidenceReplayResult {
  const failed = (message: string): Extract<StandaloneEvidenceReplayResult, { ok: false }> =>
    Object.freeze({ ok: false, message });
  const witnessedBytes = (request: AgentRequestAuthority) => {
    const key = captureKey(request.slotId, request.attempt);
    const witness = witnesses.get(key);
    if (witness === undefined || witness.requestId !== request.requestId || witness.role !== request.role ||
        witness.contextDigest !== request.contextDigest) {
      return { ok: false as const, message: `capture ${key} does not match its process witness` };
    }
    const bytes = handle.readTranscriptBytes(request);
    if (!bytes.ok) return { ok: false as const, message: bytes.error.message };
    const digest = createHash("sha256").update(bytes.value).digest("hex");
    return digest === witness.digest && bytes.value.byteLength === witness.byteLength
      ? { ok: true as const, value: bytes.value }
      : { ok: false as const, message: `capture ${key} changed after it was witnessed` };
  };
  try {
    const authorityResult = parsedAuthority(registration);
    if (!authorityResult.ok) return failed(authorityResult.message);
    const authority = authorityResult.value;
    const resolver = publicationResolver(handle);
    const initial = durableRequests(handle, authority, resolver);
    if (initial.kind !== "found") {
      return failed(initial.kind === "absent" ? "standalone publication authority is absent" : initial.message);
    }
    if (initial.requests.some(({ authority: request }) => request.attempt !== 1)) {
      return failed("checkpoint-independent replay requires the initial reviewer attempt for every slot");
    }
    const captured = handle.readCapturedAttempts();
    if (!captured.ok) return failed(captured.error.message);
    const initialBySlot = new Map(initial.requests.map((request) => [request.authority.slotId, request] as const));
    const selected: SpawnRequest[] = [];
    const selectedBytes = new Map<string, Uint8Array>();
    const retriedAttemptOne: AgentRequestAuthority[] = [];
    for (const slot of authority.roster.orderedSlots) {
      const attemptOne = initialBySlot.get(slot.slotId);
      if (attemptOne === undefined) return failed(`initial reviewer authority is missing for ${slot.slotId}`);
      const packetProblem = scopePacketProblem(handle, authority, attemptOne.authority);
      if (packetProblem !== null) return failed(packetProblem);
      const attemptOneKey = captureKey(slot.slotId, 1);
      if (captured.value.has(attemptOneKey)) {
        const bytes = witnessedBytes(attemptOne.authority);
        if (!bytes.ok) return failed(bytes.message);
        const admission = admitCapturedStandaloneTranscript(
          authority.scope,
          bytes.value,
          attemptOne.authority.role,
        );
        if (admission.ok) {
          selected.push(attemptOne);
          selectedBytes.set(attemptOne.authority.requestId, bytes.value);
          continue;
        }
      }

      const retry = durableStandaloneRetryRequest(handle, slot, resolver);
      if (!retry.ok) return failed(retry.message);
      const retryPacketProblem = scopePacketProblem(handle, authority, retry.value.authority);
      if (retryPacketProblem !== null) return failed(retryPacketProblem);
      if (!captured.value.has(captureKey(slot.slotId, 2))) {
        return failed(`checkpoint-independent replay is missing ${retry.value.authority.requestId}`);
      }
      const retryBytes = witnessedBytes(retry.value.authority);
      if (!retryBytes.ok) return failed(retryBytes.message);
      const retryAdmission = admitCapturedStandaloneTranscript(
        authority.scope,
        retryBytes.value,
        retry.value.authority.role,
      );
      if (!retryAdmission.ok) {
        return failed(`checkpoint-independent replay rejected ${retry.value.authority.requestId}: ${retryAdmission.problems.join("; ")}`);
      }
      selected.push(retry.value);
      selectedBytes.set(retry.value.authority.requestId, retryBytes.value);
      retriedAttemptOne.push(attemptOne.authority);
    }

    const captureAuthority = bindStandaloneCaptureAuthority(authority, selected);
    if (!captureAuthority.ok) return failed(captureAuthority.error.message);
    const accepted = [];
    for (const request of selected) {
      const bytes = selectedBytes.get(request.authority.requestId);
      if (bytes === undefined) return failed(`checkpoint-independent replay lost ${request.authority.requestId}`);
      const prepared = captureStandaloneReviewerBytes(captureAuthority.value, request.authority.requestId, bytes);
      if (!prepared.ok) return failed(prepared.error.message);
      const completed = completeStandaloneReviewerCapture(prepared.value, {
        kind: "raw-transcript-captured",
        effectId: prepared.value.intent.effectId,
        runId: handle.runId,
        requestId: request.authority.requestId,
        artifact: prepared.value.expectedArtifact,
      });
      if (!completed.ok) return failed(completed.error.message);
      accepted.push(completed.value);
    }

    const completion = proveStandaloneRosterCompletion(authority, resolver, accepted);
    if (!completion.ok) return failed(completion.error.violations.map((entry) => JSON.stringify(entry)).join("; "));
    const awaiting = reduceStandaloneReviewMachine(startStandaloneReviewMachine(authority), {
      kind: "review-batch-published",
      runId: handle.runId,
    });
    if (!awaiting.ok || awaiting.value.kind !== "awaiting-results") {
      return failed(awaiting.ok ? "standalone replay did not reach awaiting-results" : awaiting.error.message);
    }
    let replayState: StandaloneReviewMachineState = awaiting.value;
    for (const attemptOne of retriedAttemptOne) {
      const rejected = reduceStandaloneReviewMachine(replayState, {
        kind: "result-rejected",
        request: {
          runId: handle.runId,
          slotId: attemptOne.slotId,
          requestId: attemptOne.requestId,
          attempt: 1,
        },
        message: "attempt 1 was rejected by witnessed replay evidence",
      });
      if (!rejected.ok || rejected.value.kind !== "awaiting-results") {
        return failed(rejected.ok ? "standalone replay did not admit reviewer retry" : rejected.error.message);
      }
      replayState = rejected.value;
    }
    let reduced = reduceStandaloneReviewMachine(replayState, { kind: "complete-roster-proved", completion: completion.value });
    if (!reduced.ok || reduced.value.kind !== "aggregating") {
      return failed(reduced.ok ? "standalone replay did not reach aggregation" : reduced.error.message);
    }
    const aggregated = aggregateStandaloneReview({ authority, completion: completion.value });
    if (!aggregated.ok) return failed(aggregated.errors.join("; "));

    let ready: Extract<StandaloneReviewMachineState, { kind: "ready-to-finalize" }>;
    if (aggregated.value.kind === "clean") {
      reduced = reduceStandaloneReviewMachine(reduced.value, {
        kind: "aggregate-clean",
        aggregate: aggregated.value.aggregate,
      });
      if (!reduced.ok || reduced.value.kind !== "ready-to-finalize") {
        return failed(reduced.ok ? "clean standalone replay did not reach finalization" : reduced.error.message);
      }
      ready = reduced.value;
    } else {
      const preparation = standaloneRefutationPreparation(handle, authority, aggregated.value.aggregate);
      reduced = reduceStandaloneReviewMachine(reduced.value, {
        kind: "aggregate-has-criticals",
        aggregate: aggregated.value.aggregate,
        panelAuthority: preparation.frozen,
        refutationAuthority: preparation.panel,
      });
      if (!reduced.ok || reduced.value.kind !== "awaiting-refutation") {
        return failed(reduced.ok ? "critical standalone replay did not reach refutation" : reduced.error.message);
      }
      const durablePanel = durableRefutationRequests(handle, preparation.inputs, resolver);
      if (durablePanel.kind !== "found") {
        return failed(durablePanel.kind === "absent" ? "standalone refutation publication authority is absent" : durablePanel.message);
      }
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      const panelEvents: PersistentRefutationPanelEvent[] = [];
      for (const request of durablePanel.requests) {
        if (request.authority.attempt !== 1 ||
            !captured.value.has(captureKey(request.authority.slotId, request.authority.attempt))) {
          return failed(`checkpoint-independent replay is missing initial refutation ${request.authority.requestId}`);
        }
        const bytes = witnessedBytes(request.authority);
        if (!bytes.ok) return failed(bytes.message);
        let submitted = submitRefutationVerdict(
          panelState,
          resolver,
          panelRequestIdentity(request),
          Buffer.from(bytes.value).toString("utf8"),
        );
        if (!submitted.ok) return failed(submitted.error.message);
        panelState = submitted.value.state;
        if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const prepared = preparation.retryInputs.find(({ input }) =>
            (input.authority as AgentRequestAuthority).requestId === retryAuthority.requestId &&
            JSON.stringify(input.authority) === JSON.stringify(retryAuthority));
          if (prepared === undefined) {
            return failed(`refutation retry ${retryAuthority.requestId} is not exact prepared attempt-2 authority`);
          }
          const retryLabel = `standalone-refutation-retry:${retryAuthority.slotId}`;
          const retry = durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
          if (retry.kind !== "found") {
            return failed(retry.kind === "absent"
              ? `refutation retry publication is absent for ${retryAuthority.slotId}`
              : retry.message);
          }
          const retryRequest = retry.requests[0]!;
          if (!captured.value.has(captureKey(retryAuthority.slotId, 2))) {
            return failed(`checkpoint-independent replay is missing refutation retry ${retryAuthority.requestId}`);
          }
          const retryBytes = witnessedBytes(retryRequest.authority);
          if (!retryBytes.ok) return failed(retryBytes.message);
          submitted = submitRefutationVerdict(
            panelState,
            resolver,
            panelRequestIdentity(retryRequest),
            Buffer.from(retryBytes.value).toString("utf8"),
          );
          if (!submitted.ok) return failed(submitted.error.message);
          panelState = submitted.value.state;
          if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
          if (submitted.value.action?.kind === "refutation-blocked") {
            return failed(submitted.value.action.diagnostic.message);
          }
        }
      }
      const completedPanel = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
      if (!completedPanel.ok || completedPanel.value.state.stage !== "done") {
        return failed(completedPanel.ok ? "standalone refutation replay did not complete" : completedPanel.error.message);
      }
      if (completedPanel.value.recordedEvent !== undefined) panelEvents.push(completedPanel.value.recordedEvent);
      const canonical = refutationPanelCheckpoint(completedPanel.value.state, panelEvents, resolver);
      if (!canonical.ok) return failed(canonical.error.message);
      const refutation = parseStandaloneRefutationCompletion({
        panelAuthority: preparation.frozen,
        aggregate: aggregated.value.aggregate,
        completedPanelState: completedPanel.value.state,
        completedPanelCheckpoint: canonical.value,
        publicationResolver: resolver,
      });
      if (!refutation.ok) return failed(refutation.error.message);
      reduced = reduceStandaloneReviewMachine(reduced.value, { kind: "refutation-completed", completion: refutation.value });
      if (!reduced.ok || reduced.value.kind !== "ready-to-finalize") {
        return failed(reduced.ok ? "standalone refutation replay did not reach finalization" : reduced.error.message);
      }
      ready = reduced.value;
    }

    const json = serializeAdjudicatedStandaloneReview(ready.result);
    return Object.freeze({
      ok: true as const,
      json,
      digest: createHash("sha256").update(json).digest("hex"),
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

export async function finalizeStandaloneState(
  handle: RunDirHandle,
  ready: Extract<StandaloneReviewMachineState, { kind: "ready-to-finalize" }>,
): Promise<FacadeDriveResult> {
  const json = serializeAdjudicatedStandaloneReview(ready.result);
  const artifact = canonicalStandaloneResultArtifact(ready.result);
  if (!artifact.ok) return failed(artifact.error.message);
  const resultBytes = Buffer.from(json, "utf8");
  try { writeRunBytesExclusiveNoFollow(`${handle.runDirectory}/result.json`, resultBytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return failed(error instanceof Error ? error.message : String(error));
    }
    let existing: Buffer;
    try {
      existing = readRunBytesNoFollow(`${handle.runDirectory}/result.json`);
    } catch (readError) {
      return failed(
        `cannot verify existing standalone result after exclusive publication collision: ${readError instanceof Error ? readError.message : String(readError)}`,
      );
    }
    if (!existing.equals(resultBytes)) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
  const receipt = { kind: "artifact-set-published" as const, effectId: ready.publicationIntent.effectId,
    runId: handle.runId, artifacts: Object.freeze([artifact.value]) as readonly [typeof artifact.value] };
  const recorded = await handle.recordReceipt(receipt);
  if (!recorded.ok) return failed(`cannot durably record publication receipt: ${recorded.error.message}`);
  const done = reduceStandaloneReviewMachine(ready, { kind: "result-published", result: JSON.parse(json), receipt });
  if (!done.ok || done.value.kind !== "done") return failed(done.ok ? "standalone result did not reach done" : done.error.message);
  await handle.writeCheckpoint(serializeStandaloneReviewMachineState(done.value));
  return { ok: true, action: { kind: "done", runId: handle.runId, outcome: done.value.outcome } };
}

/**
 * Record that one standalone reviewer result was refused.
 *
 * Phase A (attempt-1 rejections, which stay awaiting-results) and Phase C (an
 * attempt-2 rejection, which terminal-blocks) wrote the same event with the same
 * dedup-key derivation, independently. Note the deliberate asymmetry the shared
 * form preserves: the dedup key is keyed by the SLOT's own attempt, so a replay
 * of the same slot is a no-op, while `eventAttempt` is what the machine already
 * reduced against.
 */
async function appendStandaloneRejection(
  handle: RunDirHandle,
  slot: Readonly<{ requestId: string; slotId: string; attempt: number }>,
  eventAttempt: number,
  diagnostic: string,
): Promise<void> {
  await handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `standalone-result-rejected:${createHash("sha256").update(`${slot.requestId}:${slot.attempt}`).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: {
      kind: "standalone-result-rejected",
      runId: handle.runId,
      requestId: slot.requestId,
      slotId: slot.slotId,
      attempt: eventAttempt,
      diagnostic,
    },
  });
}

function admitCapturedStandaloneTranscript(
  scope: readonly string[],
  bytes: Uint8Array,
  role: string,
): StandaloneTranscriptAdmission {
  const decoded = decodeReviewerTranscript(bytes, role);
  return decoded.ok
    ? admitStandaloneTranscript(scope, decoded.text, role)
    : Object.freeze({ ok: false, problems: Object.freeze([decoded.message]) });
}

export async function resumeStandaloneFacade(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram,
): Promise<FacadeDriveResult> {
  try {
    const authorityResult = parsedAuthority(registration);
    if (!authorityResult.ok) return failed(authorityResult.message);
    const resolver = publicationResolver(handle);
    const checkpoint = await handle.readCheckpoint();
    let rawState: unknown;
    if (checkpoint === null) {
      // Initial-batch crash window: publishInitialBatch persists contexts,
      // requests, and the publication receipt BEFORE the awaiting-results
      // checkpoint is written. A crash inside that window leaves no checkpoint;
      // reconstruct the exact awaiting-results state from the registered frozen
      // authority (the same pure state start would have checkpointed) so
      // reviewer evidence captured before the crash is not discarded.
      const effectId = standalonePublicationEffectId(authorityResult.value);
      if (!effectId.ok) return failed(effectId.error.message);
      const publication = durablePublicationDigest(handle, effectId.value);
      if (publication.kind === "corrupt") return failed(publication.message);
      if (publication.kind === "found") {
        const reconstructed = reduceStandaloneReviewMachine(
          startStandaloneReviewMachine(authorityResult.value),
          { kind: "review-batch-published", runId: handle.runId },
        );
        if (!reconstructed.ok || reconstructed.value.kind !== "awaiting-results") {
          return failed(reconstructed.ok
            ? "standalone recovery did not reach awaiting-results"
            : reconstructed.error.message);
        }
        const serialized = serializeStandaloneReviewMachineState(reconstructed.value);
        await handle.writeCheckpoint(serialized);
        rawState = JSON.parse(serialized) as unknown;
      } else {
        return failed("standalone review checkpoint is missing and no durable batch publication exists");
      }
    } else {
      try {
        rawState = JSON.parse(checkpoint);
      } catch (error) {
        return failed(
          `standalone review checkpoint is invalid JSON for ${handle.runDirectory}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const state = parseStandaloneReviewMachineState(rawState, resolver);
    if (!state.ok) return failed(state.error.message);
    if (state.value.kind === "done") return { ok: true, action: { kind: "done", runId: handle.runId, outcome: state.value.outcome } };
    if (state.value.kind === "terminal-blocked" || state.value.kind === "recoverable-blocked") {
      return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: state.value } };
    }
    if (state.value.kind === "ready-to-finalize") return finalizeStandaloneState(handle, state.value);
    if (state.value.kind === "awaiting-refutation") {
      const preparation = standaloneRefutationPreparation(handle, state.value.authority, state.value.aggregate);
      const recovered = durableRefutationRequests(handle, preparation.inputs, resolver);
      if (recovered.kind === "corrupt") return failed(recovered.message);
      if (recovered.kind === "absent") {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const panelRequests = recovered.requests;
      const captured = handle.readCapturedAttempts();
      if (!captured.ok) return failed(captured.error.message);
      const missing = panelRequests.filter((request) => !captured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) {
        return {
          ok: true,
          action: { kind: "spawn-batch", runId: handle.runId, requests: executableRefutationRequests(handle, missing, true) },
        };
      }
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      // Collect the FULL immutable event prefix as the panel runs. The legacy
      // completed-state projection records accepted verdicts only, so a slot
      // accepted on attempt 2 (after an attempt-1 verdict was rejected) cannot
      // be replayed from it — the durable restart would see the slot still
      // awaiting attempt 1 and reject the :2 request. The canonical T2
      // checkpoint below carries the rejection events and replay reaches the
      // exact terminal state.
      const panelEvents: PersistentRefutationPanelEvent[] = [];
      for (const request of panelRequests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return failed(bytes.error.message);
        let submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return failed(submitted.error.message);
        panelState = submitted.value.state;
        if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const retry = await recoverOrPublishRefutationRetry(
            handle, retryAuthority, preparation.retryInputs, resolver, "standalone-refutation",
          );
          if (!retry.ok) return failed(retry.message);
          const attempts = handle.readCapturedAttempts();
          if (!attempts.ok) return failed(attempts.error.message);
          if (!attempts.value.has(captureKey(retry.request.authority.slotId, retry.request.authority.attempt))) {
            return { ok: true, action: {
              kind: "spawn-batch", runId: handle.runId,
              requests: executableRefutationRequests(
                handle, [retry.request], true, refutationRejectionDiagnostic(submitted.value.recordedEvent),
              ),
            } };
          }
          const retryBytes = handle.readTranscriptBytes(retry.request.authority);
          if (!retryBytes.ok) return failed(retryBytes.error.message);
          submitted = submitRefutationVerdict(
            panelState, resolver, panelRequestIdentity(retry.request), Buffer.from(retryBytes.value).toString("utf8"),
          );
          if (!submitted.ok) return failed(submitted.error.message);
          panelState = submitted.value.state;
          if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
          if (submitted.value.action?.kind === "refutation-blocked") {
            return failed(submitted.value.action.diagnostic.message);
          }
        }
      }
      const completed = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
      if (!completed.ok || completed.value.state.stage !== "done") return failed(completed.ok ? "refutation did not reach done" : completed.error.message);
      if (completed.value.recordedEvent !== undefined) panelEvents.push(completed.value.recordedEvent);
      const canonical = refutationPanelCheckpoint(completed.value.state, panelEvents, resolver);
      if (!canonical.ok) return failed(canonical.error.message);
      const completion = parseStandaloneRefutationCompletion({
        panelAuthority: preparation.frozen,
        aggregate: state.value.aggregate,
        completedPanelState: completed.value.state,
        completedPanelCheckpoint: canonical.value,
        publicationResolver: resolver,
      });
      if (!completion.ok) return failed(completion.error.message);
      const ready = reduceStandaloneReviewMachine(state.value, { kind: "refutation-completed", completion: completion.value });
      if (!ready.ok || ready.value.kind !== "ready-to-finalize") return failed(ready.ok ? "refutation did not unlock finalization" : ready.error.message);
      return finalizeStandaloneState(handle, ready.value);
    }
    if (state.value.kind !== "awaiting-results") return failed(`unsupported standalone resume state ${state.value.kind}`);

    const activeAuthority = state.value.authority;
    const recovered = durableRequests(handle, activeAuthority, resolver);
    if (recovered.kind !== "found") {
      return failed(recovered.kind === "absent"
        ? "standalone publication authority is absent"
        : recovered.message);
    }
    const attemptOneBySlot = new Map(recovered.requests.map((request) => [request.authority.slotId, request] as const));
    const captured = handle.readCapturedAttempts();
    if (!captured.ok) return failed(captured.error.message);
    const pendingBySlot = new Map(state.value.pending.map(({ slotId, expectedAttempt }) => [slotId, expectedAttempt] as const));
    const scope = activeAuthority.scope;

    // Phase A — admission check for every attempt-1 slot the machine still
    // expects at attempt 1. Two independent refusal classes both REJECT the
    // slot HERE — where the LC-2 lifecycle can advance it to attempt 2 —
    // instead of dead-ending the whole run with no recovery path:
    //   1. captured transcript the frozen-scope validator refuses (semantic);
    //   2. capture that was terminally rejected by the harness runtime (no
    //      bytes landed at all, e.g. a child that exited without a final
    //      payload). Without case 2 the façade re-issues the terminally
    //      rejected attempt-1 request on every resume — the capture runtime
    //      will never accept its bytes again — dead-locking the roster.
    const rejected: Readonly<{ slot: AgentRequestAuthority; problems: readonly string[] }>[] = [];
    for (const slot of activeAuthority.roster.orderedSlots) {
      if ((pendingBySlot.get(slot.slotId) ?? 1) !== 1) continue;
      const attemptOne = attemptOneBySlot.get(slot.slotId);
      if (attemptOne === undefined) {
        return failed(`standalone attempt-1 issuance authority is missing for ${slot.slotId}`);
      }
      if (!captured.value.has(captureKey(attemptOne.authority.slotId, 1))) {
        const captureRejection = await durableCaptureRejection(handle, attemptOne.authority);
        if (captureRejection !== null) {
          rejected.push({ slot: attemptOne.authority, problems: Object.freeze([captureRejection]) });
        }
        continue;
      }
      const bytes = handle.readTranscriptBytes(attemptOne.authority);
      if (!bytes.ok) return failed(bytes.error.message);
      const admission = admitCapturedStandaloneTranscript(
        scope,
        bytes.value,
        attemptOne.authority.role,
      );
      if (!admission.ok) rejected.push({ slot: attemptOne.authority, problems: [...admission.problems] });
    }
    let machine: StandaloneReviewMachineState = state.value;
    if (rejected.length > 0) {
      for (const { slot, problems } of rejected) {
        const reduced = reduceStandaloneReviewMachine(machine, {
          kind: "result-rejected",
          request: { runId: handle.runId, slotId: slot.slotId, requestId: slot.requestId, attempt: 1 },
          message: problems.join("; "),
        });
        if (!reduced.ok || reduced.value.kind !== "awaiting-results") {
          return failed(reduced.ok ? "standalone semantic rejection did not remain awaiting results" : reduced.error.message);
        }
        machine = reduced.value;
      }
      await handle.writeCheckpoint(serializeStandaloneReviewMachineState(machine));
      for (const { slot, problems } of rejected) {
        await appendStandaloneRejection(handle, slot, slot.attempt, problems.join("; "));
      }
    }

    // Phase B — assemble the issued-request set. Slots still expected at
    // attempt 1 come from the original batch publication; slots at attempt 2
    // (freshly rejected here or retried in an earlier resume) come from the
    // per-slot retry batch, published now if a crash left it unpublished.
    const rejectedSlotIds = new Set(rejected.map(({ slot }) => slot.slotId));
    // Read the diagnostic off the REDUCED machine, not off this pass's `rejected`
    // set: a resume that merely re-issues an already-recorded retry has an empty
    // `rejected` set, and reading from it there silently degraded the attempt-2
    // prompt to the generic fallback.
    const rejectedDiagnostics = new Map(machine.pending.flatMap(({ slotId, rejectionDiagnostic }) =>
      rejectionDiagnostic === null ? [] : [[slotId, rejectionDiagnostic] as const]));
    const issued: SpawnRequest[] = [];
    for (const slot of activeAuthority.roster.orderedSlots) {
      const expected = rejectedSlotIds.has(slot.slotId) ? 2 : (pendingBySlot.get(slot.slotId) ?? 1);
      if (expected === 1) {
        const attemptOne = attemptOneBySlot.get(slot.slotId);
        if (attemptOne === undefined) {
          return failed(`standalone attempt-1 issuance authority is missing for ${slot.slotId}`);
        }
        issued.push(attemptOne);
        continue;
      }
      const retry = await recoverOrPublishStandaloneRetry(handle, activeAuthority, slot, resolver);
      if (!retry.ok) return failed(retry.message);
      issued.push(retry.request);
    }
    const captureAuthority = bindStandaloneCaptureAuthority(activeAuthority, issued);
    if (!captureAuthority.ok) return failed(captureAuthority.error.message);

    // Phase C — accept captured expected attempts. A captured attempt 2 that
    // STILL fails the frozen-scope validator terminal-blocks the run exactly as
    // the LC-2 lifecycle prescribes for a second and final attempt.
    const accepted = [];
    const missing: SpawnRequest[] = [];
    for (const request of issued) {
      if (!captured.value.has(captureKey(request.authority.slotId, request.authority.attempt))) {
        missing.push(request);
        continue;
      }
      const bytes = handle.readTranscriptBytes(request.authority);
      if (!bytes.ok) return failed(bytes.error.message);
      if (request.authority.attempt === 2) {
        const admission = admitCapturedStandaloneTranscript(
          scope,
          bytes.value,
          request.authority.role,
        );
        if (!admission.ok) {
          const problems = [...admission.problems];
          const terminal = reduceStandaloneReviewMachine(machine, {
            kind: "result-rejected",
            request: { runId: handle.runId, slotId: request.authority.slotId, requestId: request.authority.requestId, attempt: 2 },
            message: problems.join("; "),
          });
          if (!terminal.ok || terminal.value.kind !== "terminal-blocked") {
            return failed(terminal.ok ? "standalone attempt-2 rejection did not terminal-block" : terminal.error.message);
          }
          await handle.writeCheckpoint(serializeStandaloneReviewMachineState(terminal.value));
          await appendStandaloneRejection(handle, request.authority, 2, problems.join("; "));
          return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: terminal.value } };
        }
      }
      const prepared = captureStandaloneReviewerBytes(captureAuthority.value, request.authority.requestId, bytes.value);
      if (!prepared.ok) return failed(prepared.error.message);
      const completed = completeStandaloneReviewerCapture(prepared.value, {
        kind: "raw-transcript-captured",
        effectId: prepared.value.intent.effectId,
        runId: handle.runId,
        requestId: request.authority.requestId,
        artifact: prepared.value.expectedArtifact,
      });
      if (!completed.ok) return failed(completed.error.message);
      accepted.push(completed.value);
    }
    if (missing.length > 0) {
      const effectId = standalonePublicationEffectId(activeAuthority);
      if (!effectId.ok) return failed(effectId.error.message);
      const receipt = JSON.parse(readRunBytesNoFollow(
        `${handle.runDirectory}/artifacts/${publicationFile(effectId.value)}`,
      ).toString("utf8")) as Record<string, unknown>;
      return { ok: true, action: {
        kind: "spawn-batch",
        runId: handle.runId,
        publicationIdentity: {
          schemaVersion: 1,
          kind: "batch-publication-identity",
          runId: handle.runId,
          effectId: effectId.value,
          publicationDigest: receipt.publicationDigest,
        },
        idempotencyKey: { runId: handle.runId, effectId: effectId.value },
        receipt,
        requests: missing.map((request) => {
          const task = renderSpawnTask(
            handle,
            request.authority,
            "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.",
            { standalone: true },
          );
          return {
            ...request,
            task: request.authority.attempt === 2
              ? standaloneRetryTask(task, rejectedDiagnostics.get(request.authority.slotId) ?? null)
              : task,
          };
        }),
      } };
    }
    const completion = proveStandaloneRosterCompletion(activeAuthority, resolver, accepted);
    if (!completion.ok) return failed(completion.error.violations.map((entry) => JSON.stringify(entry)).join("; "));
    let reduced = reduceStandaloneReviewMachine(machine, { kind: "complete-roster-proved", completion: completion.value });
    if (!reduced.ok) return failed(reduced.error.message);
    if (reduced.value.kind !== "aggregating") return failed("standalone roster did not reach aggregation");
    const aggregate = aggregateStandaloneReview({ authority: activeAuthority, completion: completion.value });
    if (!aggregate.ok) return failed(aggregate.errors.join("; "));
    if (aggregate.value.kind !== "clean") {
      const preparation = standaloneRefutationPreparation(handle, activeAuthority, aggregate.value.aggregate);
      reduced = reduceStandaloneReviewMachine(reduced.value, {
        kind: "aggregate-has-criticals",
        aggregate: aggregate.value.aggregate,
        panelAuthority: preparation.frozen,
        refutationAuthority: preparation.panel,
      });
      if (!reduced.ok || reduced.value.kind !== "awaiting-refutation") return failed(reduced.ok ? "critical route did not reach refutation" : reduced.error.message);
      await handle.writeCheckpoint(serializeStandaloneReviewMachineState(reduced.value));
      const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
      return published.ok ? { ok: true, action: published.action } : failed(published.message);
    }
    reduced = reduceStandaloneReviewMachine(reduced.value, { kind: "aggregate-clean", aggregate: aggregate.value.aggregate });
    if (!reduced.ok || reduced.value.kind !== "ready-to-finalize") return failed(reduced.ok ? "standalone finalization did not become ready" : reduced.error.message);
    return finalizeStandaloneState(handle, reduced.value);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

