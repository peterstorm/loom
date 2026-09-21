/** Checkpoint-independent standalone evidence authentication and replay.
 * Source loaders supply independently authenticated nominal successor data;
 * this volume never loads a predecessor or drives program publication.
 */
import { createHash } from 'node:crypto';
import type { PreparedStandaloneSuccessor } from '../../../core/standalone-lineage';
import { admitStandaloneSuccessorReviewer } from '../../../core/standalone-successor-reviewer';
import { standaloneCurrentPanelCriticals, type StandaloneReviewerProtocolResolver } from '../../../core/standalone-review';
import type { IssuedStandaloneReviewerProtocol } from '../../../core/review-output';
import { canonicalStructuralEquals, parseEffectId, sameAgentRequestAuthority, parseAgentRequestAuthority, parseIssuedSpawnRequest, boundedThrownCause, type AgentRequestAuthority, type InitialSpawnRequestInput, type SpawnRequest } from '../../../core/orchestration-contract';
import { aggregateStandaloneReview, bindStandaloneCaptureAuthority, captureStandaloneReviewerBytes, completeStandaloneReviewerCapture, proveStandaloneRosterCompletion, serializeAdjudicatedStandaloneReview, admitStandaloneTranscript, type FrozenStandaloneReviewAuthority, type StandaloneTranscriptAdmission } from '../../../core/standalone-review';
import { reduceStandaloneReviewMachine, freezeStandaloneRefutationPanelAuthority, parseStandaloneRefutationCompletion, startStandaloneReviewMachine, type StandaloneReviewMachineState } from '../../../core/standalone-review-machine';
import { buildStandaloneFindingBrief, defaultRefutationThreshold, reviewSignals, selectReviewLenses } from '../../../core/review-panel';
import { completePersistentRefutationPanel, deriveRefutationVerifierBinding, panelRequestIdentity, parseRefutationPanelAuthority, refutationPanelCheckpoint, rejectRefutationVerdict, startPersistentRefutationPanel, submitRefutationVerdict, type PersistentPanelResult, type PersistentRefutationPanelEvent, type PersistentRefutationStep } from '../../../core/panel-program';
import { buildContextPacket, encodeByteSection, type ContextPacket } from '../../../orchestration/context-packets';
import { captureKey } from '../../../core/harness-capture';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { resolveModelProfile, lowerModelProfile } from '../../../core/model-profiles';
import { boundedStandaloneReadHandle, successorSourceSnapshot } from './standalone-successor-source';
import { parseRegistration, standaloneReviewerProtocolResolver, durablePublicationDigest, durableRefutationRequests, durableRequests, exactObject, readRegisteredStandaloneAuthority, publicationResolver, standaloneRetryEffectId, type RegisteredStandaloneProgram } from './helpers';
import type { ProgramParse } from './program-result';

function standalonePanelSources(handle: RunDirHandle, authority: FrozenStandaloneReviewAuthority) {
  if (authority.schemaVersion !== 3) return { fixed: [], variable: [] };
  const stored = handle.readProgramRegistration(16_777_216);
  if (!stored.ok) throw Error(stored.error.message);
  const registration = parseRegistration(stored.value);
  if (!registration.ok || registration.value.schemaVersion !== 3) throw Error("current panel requires exact successor registration");
  const snapshot = successorSourceSnapshot(registration.value.currentSource, authority.scope);
  if (!snapshot.ok || !canonicalStructuralEquals(snapshot.value, authority.successor.snapshot)) throw Error("current panel source differs from frozen successor snapshot");
  const lineage = encodeByteSection("standalone-lineage", JSON.stringify(authority.successor));
  if (!lineage.ok) throw Error(lineage.error.message);
  return { fixed: [lineage.value], variable: [registration.value.currentSource, ...registration.value.previousContexts] };
}

export function standaloneRefutationPreparation(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  aggregate: import("../../../core/standalone-review").StandaloneReviewAggregate,
) {
  const brief = buildStandaloneFindingBrief({ subjectId: aggregate.subjectId, findings: standaloneCurrentPanelCriticals(aggregate) });
  const selected = selectReviewLenses(reviewSignals(brief.findings), 3);
  if (!selected.ok) throw new Error(selected.errors.join("; "));
  const lenses = selected.value;
  const sources = standalonePanelSources(handle, authority);
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
        ...(aggregate.schemaVersion === 3 ? { successorEvidence: { lineageDigest: aggregate.successor.lineageDigest,
          snapshotDigest: aggregate.successor.snapshotDigest, reports: aggregate.lineage.reports } } : {}),
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId,
        role: "review-verifier-agent",
        requiredSkill: "none",
        outputContract: `Adjudicate every Finding through lens '${lens}' and emit the exact refutation verdict JSON contract.`,
        fixedContext: Object.freeze([section.value, ...sources.fixed]), variableContext: Object.freeze(sources.variable),
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
  | Readonly<{ ok: true; json: string; digest: string; ready: Extract<StandaloneReviewMachineState, { kind: "ready-to-finalize" }> }>
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

function parseScopePacketAuthority(bytes: Iterable<number>):
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

function parseReviewedSource(bytes: Iterable<number>, scope: readonly string[], sourceVersion: 1 | 2 = 1):
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
        record.schemaVersion !== sourceVersion || typeof record.headRevision !== "string" ||
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
      let contentKey: "content" | "contentBase64" | null = null;
      if (file.kind === "text") contentKey = "content";
      else if (file.kind === "binary") contentKey = "contentBase64";
      if (contentKey === null || typeof file.digest !== "string" || !/^[0-9a-f]{64}$/.test(file.digest) ||
          !Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0 || typeof file[contentKey] !== "string" ||
          !exactObject(file, ["byteLength", contentKey, "digest", "kind", "path", ...(sourceVersion === 2 ? ["mode"] : [])]) ||
          (sourceVersion === 2 && file.mode !== "100644" && file.mode !== "100755")) {
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
  registration: RegisteredStandaloneProgram,
  maximumBytes?: number,
  reviewerProtocols?: StandaloneReviewerProtocolResolver,
): string | null {
  const protocol = (reviewerProtocols ?? standaloneReviewerProtocolResolver(handle, registration, authority.schemaVersion === 3 ? authority.successor : undefined, maximumBytes))(request);
  if (!protocol.ok) return protocol.error.message;
  if (protocol.value.protocolVersion !== authority.schemaVersion || !sameAgentRequestAuthority(protocol.value.request, request)) {
    return "reviewed source protocol differs from the registered request authority";
  }
  if (authority.schemaVersion === 3) return null;
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
  maximumBytes?: number,
  successor?: PreparedStandaloneSuccessor,
): Readonly<{ ok: true; value: StandaloneReviewedSource }> | Readonly<{ ok: false; message: string }> {
  const authorityResult = readRegisteredStandaloneAuthority(handle, registration, successor);
  if (!authorityResult.ok) return authorityResult;
  const authority = authorityResult.value;
  let reviewed: StandaloneReviewedSource | null = null;
  let sectionDigest: string | null = null;
  for (const slot of authority.roster.orderedSlots) {
    const request = slot.attempts[0];
    const packetProblem = scopePacketProblem(handle, authority, request, registration, maximumBytes);
    if (packetProblem !== null) return Object.freeze({ ok: false, message: packetProblem });
    const packet = registration.schemaVersion === 3 ? handle.readStandaloneSuccessorContext(request.contextDigest, maximumBytes)
      : handle.readContext(request.contextDigest);
    if (!packet.ok) return Object.freeze({ ok: false, message: packet.error.message });
    const sections = [...packet.value.fixedContext, ...packet.value.variableContext].filter(({ label }) => label === "standalone-frozen-source");
    if (sections.length !== 1) {
      return Object.freeze({
        ok: false,
        message: `context ${request.contextDigest} must contain exactly one standalone-frozen-source section`,
      });
    }
    if (sectionDigest !== null && sections[0]!.digest !== sectionDigest) {
      return Object.freeze({ ok: false, message: "standalone reviewer contexts attest different frozen source snapshots" });
    }
    if (reviewed !== null) continue; // Equal authenticated section digest: one immutable source parse per roster.
    const parsed = parseReviewedSource(sections[0]!.bytes, authority.scope, registration.schemaVersion === 3 ? 2 : 1);
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
 * to verify rather than authority to trust. Scope comes from immutable request
 * Context Packets, not merely from the reread registration. Generic replay
 * reconstructs witnesses from durable capture receipts; Pi callers may also
 * require matching current-session process witnesses. Supported semantic
 * attempt-2 retries are reconstructed from durable publication authority and
 * the exact witnessed bytes.
 */
export function replayStandaloneResultFromEvidence(
  opened: RunDirHandle,
  registration: RegisteredStandaloneProgram,
  witnesses: ReadonlyMap<string, StandaloneCaptureWitness>,
  successor?: PreparedStandaloneSuccessor,
): StandaloneEvidenceReplayResult {
  const handle = registration.schemaVersion === 3 ? boundedStandaloneReadHandle(opened) : opened;
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
    const authorityResult = readRegisteredStandaloneAuthority(handle, registration, successor);
    if (!authorityResult.ok) return failed(authorityResult.message);
    const authority = authorityResult.value;
    const reviewerProtocols = standaloneReviewerProtocolResolver(handle, registration, successor);
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
      const packetProblem = scopePacketProblem(handle, authority, attemptOne.authority, registration, undefined, reviewerProtocols);
      if (packetProblem !== null) return failed(packetProblem);
      const attemptOneKey = captureKey(slot.slotId, 1);
      if (captured.value.has(attemptOneKey)) {
        const bytes = witnessedBytes(attemptOne.authority);
        if (!bytes.ok) return failed(bytes.message);
        const admission = admitCapturedStandaloneTranscript(
          reviewerProtocols,
          attemptOne.authority,
          bytes.value,
        );
        if (admission.ok) {
          selected.push(attemptOne);
          selectedBytes.set(attemptOne.authority.requestId, bytes.value);
          continue;
        }
      }

      if (authority.schemaVersion === 3 && !captured.value.has(attemptOneKey)) {
        const rejected = handle.readCaptureRejection(attemptOne.authority);
        if (!rejected.ok || rejected.value === null) return failed("successor replay requires captured rejected attempt-one evidence or an exact terminal capture refusal");
      }
      const retry = durableStandaloneRetryRequest(handle, slot, resolver);
      if (!retry.ok) return failed(retry.message);
      const retryPacketProblem = scopePacketProblem(handle, authority, retry.value.authority, registration, undefined, reviewerProtocols);
      if (retryPacketProblem !== null) return failed(retryPacketProblem);
      if (!captured.value.has(captureKey(slot.slotId, 2))) {
        return failed(`checkpoint-independent replay is missing ${retry.value.authority.requestId}`);
      }
      const retryBytes = witnessedBytes(retry.value.authority);
      if (!retryBytes.ok) return failed(retryBytes.message);
      const retryAdmission = admitCapturedStandaloneTranscript(
        reviewerProtocols,
        retry.value.authority,
        retryBytes.value,
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

    const completion = proveStandaloneRosterCompletion(authority, resolver, accepted, reviewerProtocols);
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
        if (request.authority.attempt !== 1) {
          return failed("checkpoint-independent replay requires the initial refutation attempt for every slot");
        }
        // Two independent refusal classes for an attempt-1 refutation slot:
        //   1. captured transcript that fails its process witness or the panel's
        //      semantic validator (semantic);
        //   2. capture terminally rejected by the harness runtime (no bytes
        //      landed at all). Without case 2 the replay refuses a run whose
        //      result.json was produced through the resume path's tombstone
        //      advance — the evidence replay can never see the attempt-1
        //      verdict, so the tombstoned slot's attempt-2 capture IS its
        //      evidence and the slot advances to it through the panel's
        //      rejection path here, exactly as the resume path does.
        let submitted: PersistentPanelResult<PersistentRefutationStep>;
        if (captured.value.has(captureKey(request.authority.slotId, 1))) {
          const bytes = witnessedBytes(request.authority);
          if (!bytes.ok) return failed(bytes.message);
          submitted = submitRefutationVerdict(
            panelState,
            resolver,
            panelRequestIdentity(request),
            Buffer.from(bytes.value).toString("utf8"),
          );
          if (!submitted.ok) return failed(submitted.error.message);
        } else {
          const tombstone = handle.readCaptureRejection(request.authority);
          if (!tombstone.ok) return failed(tombstone.error.message);
          if (tombstone.value === null) {
            return failed(`checkpoint-independent replay is missing initial refutation ${request.authority.requestId}`);
          }
          submitted = rejectRefutationVerdict(panelState, resolver, panelRequestIdentity(request), tombstone.value);
          if (!submitted.ok) return failed(submitted.error.message);
        }
        panelState = submitted.value.state;
        if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const prepared = preparation.retryInputs.find(({ input }) => {
            const candidate = parseAgentRequestAuthority(input.authority);
            return candidate.ok && sameAgentRequestAuthority(candidate.value, retryAuthority);
          });
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
      ready,
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** One durable capture join for current resume, inspection, native witnesses and source replay. */
export function readStandaloneCaptureWitnesses(handle: RunDirHandle,
  processWitnesses?: ReadonlyMap<string, StandaloneCaptureWitness>): ProgramParse<ReadonlyMap<string, StandaloneCaptureWitness>> {
  try {
    const authority = handle.readAuthority();
    if (!authority.ok) return { ok: false, message: authority.error.message };
    const issued = handle.readIssuedRequests(16_384, 128);
    const captured = handle.readCapturedAttempts(128);
    if (!issued.ok) return { ok: false, message: `issued reviewer roster is unavailable: ${issued.error.message}` };
    if (!captured.ok) return { ok: false, message: `captured reviewer roster is unavailable: ${captured.error.message}` };
    const witnesses = new Map<string, StandaloneCaptureWitness>();
    for (const request of issued.value) {
      const key = captureKey(request.slotId, request.attempt);
      if (!captured.value.has(key)) continue;
      const effect = `effect:capture:${createHash("sha256").update(`${request.requestId}:${request.attempt}`).digest("hex")}`;
      const effectId = parseEffectId(effect);
      if (!effectId.ok) return { ok: false, message: effectId.error.message };
      const receipt = handle.readReceipt(effectId.value, 16_384);
      if (!receipt.ok || receipt.value?.kind !== "raw-transcript-captured" || receipt.value.effectId !== effectId.value || receipt.value.runId !== handle.runId ||
          receipt.value.requestId !== request.requestId || receipt.value.artifact.runId !== handle.runId ||
          receipt.value.artifact.slot.path !== request.outputSlot.path) return { ok: false, message: `durable capture receipt unavailable for ${request.requestId}; missing native or CLI provenance cannot be reconstructed` };
      const bytes = handle.readTranscriptBytes(request, 16_777_216);
      if (!bytes.ok || bytes.value.byteLength !== receipt.value.artifact.byteLength ||
          createHash("sha256").update(bytes.value).digest("hex") !== receipt.value.artifact.digest) return { ok: false, message: "captured bytes differ from their exact durable capture receipt" };
      const witness = { requestId: request.requestId, role: request.role, contextDigest: request.contextDigest,
        digest: receipt.value.artifact.digest, byteLength: receipt.value.artifact.byteLength };
      if (processWitnesses !== undefined) {
        const observed = processWitnesses.get(key);
        if (observed === undefined || observed.requestId !== witness.requestId || observed.role !== witness.role ||
            observed.contextDigest !== witness.contextDigest || observed.digest !== witness.digest || observed.byteLength !== witness.byteLength) {
          return { ok: false, message: "durable native receipt differs from exact current-session process witness" };
        }
      }
      witnesses.set(key, witness);
    }
    if (captured.value.size !== witnesses.size) return { ok: false, message: "captured roster includes a foreign unissued slot" };
    if (processWitnesses !== undefined && processWitnesses.size !== witnesses.size) return { ok: false, message: "current-session witness inventory differs from durable captured roster" };
    return { ok: true, value: witnesses };
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "successor standalone capture witnesses");
    return { ok: false, message: `standalone capture witness inspection failed: ${cause.name}: ${cause.message}` };
  }
}

/** Source authentication carries already authenticated lineage, avoiding recursive reauthentication. */
export function replayStandaloneCliCaptures(handle: RunDirHandle, registration: RegisteredStandaloneProgram,
  successor?: PreparedStandaloneSuccessor, processWitnesses?: ReadonlyMap<string, StandaloneCaptureWitness>): StandaloneEvidenceReplayResult {
  const witnesses = readStandaloneCaptureWitnesses(handle, processWitnesses);
  return witnesses.ok ? replayStandaloneResultFromEvidence(handle, registration, witnesses.value, successor) : witnesses;
}

export function admitCapturedStandaloneTranscript(
  reviewerProtocols: StandaloneReviewerProtocolResolver,
  request: AgentRequestAuthority,
  bytes: Uint8Array,
): Pick<Extract<StandaloneTranscriptAdmission, { ok: true }>, "ok"> | Extract<StandaloneTranscriptAdmission, { ok: false }> {
  const protocol = reviewerProtocols(request);
  if (!protocol.ok) throw new Error(protocol.error.message);
  if (protocol.value.protocolVersion === 3) {
    const admitted = admitStandaloneSuccessorReviewer(protocol.value, bytes);
    return admitted.ok ? { ok: true } : { ok: false, problems: [admitted.error.message] };
  }
  if (protocol.value.subject.kind !== "standalone-review" || !sameAgentRequestAuthority(protocol.value.request, request)) {
    throw new Error("resolved reviewer protocol differs from the exact standalone request");
  }
  return admitStandaloneTranscript(protocol.value as IssuedStandaloneReviewerProtocol, bytes);
}
