/**
 * Standalone review request issuance and recovery: the frozen-scope source
 * section, the per-role attempt-1/attempt-2 Context Packets, the durable
 * initial batch and per-slot attempt-2 retry publications, and the replayed
 * result publication check.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildStandaloneSuccessorReviewerContext } from '../../../core/standalone-successor-reviewer';
import {
  AGENT_REQUIRED_SKILLS,
  canonicalStructuralEquals,
  parseEffectId,
  parseIssuedSpawnRequest,
  parseRequestId,
  type AgentRequestAuthority,
  type EffectId,
  type InitialSpawnRequestInput,
  type PublicationAuthorityResolver,
  type SpawnRequest,
} from '../../../core/orchestration-contract';
import { serializeAdjudicatedStandaloneReview } from '../../../core/standalone-review-records';
import { selectStandaloneReviewers, type StandaloneReviewMetadata } from '../../../core/standalone-review-scope';
import { type FrozenStandaloneReviewAuthority } from '../../../core/standalone-review-model';
import { safeIoCause } from '../../../core/safe-io-cause';
import { buildContextPacket, buildReviewerContextPacket, encodeByteSection, type ContextPacket } from '../../../core/context-packets';
import type { StandaloneDoneState } from '../../../core/standalone-review-machine';
import { readRunBytesNoFollow } from '../../../orchestration/no-follow-fs';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { RegisteredReviewProgram } from './registration';
import { durablePublicationDigest, durableRefutationRequests, type DurableRequestRecovery } from './durable-requests';
import { publishReviewInitialBatch } from './request-publication';
import { freezeDiff, STANDALONE_FROZEN_DIFF_SECTION, type FrozenDiff, type FrozenDiffSide } from '../../../core/standalone-read-coverage';
import { baselineBlob } from './changed-paths';
import type { ProgramParse } from './program-result';

export function safeScope(scope: readonly string[]): readonly Readonly<{ path: string; status: "safe" | "absent" }>[] {
  return Object.freeze(scope.map((path) => {
    try {
      readRunBytesNoFollow(path);
      return Object.freeze({ path, status: "safe" as const });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ path, status: "absent" as const });
      throw error;
    }
  }));
}

export function standaloneRequestId(runId: string, role: string, attempt: 1 | 2): string {
  return `request:${createHash("sha256").update(`${runId}\u0000${role}\u0000${attempt}`).digest("hex")}`;
}

/** One scoped file as frozen at start: the exact worktree bytes both the
 *  frozen-source section and the frozen diff derive from. */
export type FrozenScopeFile =
  | Readonly<{ path: string; kind: "text"; digest: string; byteLength: number; content: string }>
  | Readonly<{ path: string; kind: "binary"; digest: string; byteLength: number; contentBase64: string }>
  | Readonly<{ path: string; kind: "absent"; digest: null; byteLength: 0 }>;

export function frozenScopeFiles(scope: readonly string[]): readonly FrozenScopeFile[] {
  return Object.freeze(scope.map((path): FrozenScopeFile => {
    try {
      const bytes = readRunBytesNoFollow(path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      try {
        return Object.freeze({
          path,
          kind: "text" as const,
          digest,
          byteLength: bytes.length,
          content: new TextDecoder("utf8", { fatal: true }).decode(bytes),
        });
      } catch {
        return Object.freeze({
          path,
          kind: "binary" as const,
          digest,
          byteLength: bytes.length,
          contentBase64: Buffer.from(bytes).toString("base64"),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ path, kind: "absent" as const, digest: null, byteLength: 0 });
      }
      throw error;
    }
  }));
}

export function frozenScopeSection(scope: readonly string[], headRevision: string) {
  return frozenSourceSection(frozenScopeFiles(scope), headRevision);
}

function frozenSourceSection(files: readonly FrozenScopeFile[], headRevision: string) {
  const section = encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, headRevision, files }));
  if (!section.ok) throw new Error(section.error.message);
  return section.value;
}

const decodedSide = (bytes: Uint8Array): FrozenDiffSide => {
  try { return { kind: "text", text: new TextDecoder("utf8", { fatal: true }).decode(bytes) }; }
  catch { return { kind: "binary" }; }
};

/**
 * The read-coverage obligation of a scope (ADR-0022): each frozen file's diff
 * against its blob at the baseline revision — the same baseline the scope's
 * added-line count measures against. The head side is the exact frozen bytes,
 * never a second worktree read.
 */
export function frozenScopeDiff(files: readonly FrozenScopeFile[], baselineRevision: string, headRevision: string): FrozenDiff {
  return freezeDiff({
    baseRevision: baselineRevision,
    headRevision,
    files: files.map((file) => {
      const base = baselineBlob(baselineRevision, file.path);
      return {
        path: file.path,
        base: base === null ? { kind: "absent" as const } : decodedSide(base),
        head: file.kind === "absent" ? { kind: "absent" as const }
          : file.kind === "text" ? { kind: "text" as const, text: file.content } : { kind: "binary" as const },
      };
    }),
  });
}

/** Read coverage requested at start: the baseline the frozen diff is taken against. */
export type StandaloneReadCoverageStart = Readonly<{ baselineRevision: string }>;

export function standalonePackets(
  runId: string,
  reviewMetadata: StandaloneReviewMetadata,
  scope: readonly string[],
  headRevision: string,
  readCoverage?: StandaloneReadCoverageStart,
): Readonly<{
  contexts: readonly Readonly<{ attempts: readonly [string, string] }>[];
  packets: readonly ContextPacket[];
  /** The frozen read obligation, present exactly when read coverage was requested. */
  frozenDiff: FrozenDiff | null;
}> {
  const reviewers = selectStandaloneReviewers(reviewMetadata);
  const files = frozenScopeFiles(scope);
  const sourceSection = frozenSourceSection(files, headRevision);
  const frozenDiff = readCoverage === undefined ? null : frozenScopeDiff(files, readCoverage.baselineRevision, headRevision);
  const diffSection = frozenDiff === null ? null : encodeByteSection(STANDALONE_FROZEN_DIFF_SECTION, JSON.stringify(frozenDiff));
  if (diffSection !== null && !diffSection.ok) throw new Error(diffSection.error.message);
  const packets: ContextPacket[] = [];
  const contexts = reviewers.map((role) => {
    const buildAttempt = (attempt: 1 | 2) => {
      // The branded RequestId is minted through its parser, never asserted by
      // a cast: the template can only pass today, and a future template edit
      // that leaves the grammar refuses here instead of minting invalid
      // packet identity (type-design-analyzer-1).
      const requestId = parseRequestId(standaloneRequestId(runId, role, attempt));
      if (!requestId.ok) throw new Error(requestId.error.message);
      const section = encodeByteSection("standalone-review-authority", JSON.stringify({ runId, scope, role, attempt }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildReviewerContextPacket({
        requestId: requestId.value,
        role,
        requiredSkill: AGENT_REQUIRED_SKILLS[role] ?? "none",
        fixedContext: Object.freeze(diffSection === null ? [section.value, sourceSection] : [section.value, sourceSection, diffSection.value]),
        variableContext: Object.freeze([]),
      });
      if (!packet.ok) throw new Error(packet.error.message);
      packets.push(packet.value);
      return packet.value.digest;
    };
    // Structural two-tuple: the attempt pair's shape is compiler-proven, not
    // asserted by a cast (type-design-analyzer-1).
    return Object.freeze({ attempts: Object.freeze([buildAttempt(1), buildAttempt(2)] as const) });
  });
  return Object.freeze({ contexts: Object.freeze(contexts), packets: Object.freeze(packets), frozenDiff });
}

export function readPublishedStandaloneResult(handle: RunDirHandle, state: StandaloneDoneState, maximumBytes?: number): ProgramParse<StandaloneDoneState> {
  try {
    const receipt = handle.readReceipt(state.publicationReceipt.effectId);
    if (!receipt.ok || !canonicalStructuralEquals(receipt.value, state.publicationReceipt)) {
      return { ok: false, message: "standalone result publication receipt is missing or differs from replay" };
    }
    const bytes = readRunBytesNoFollow(join(handle.runDirectory, "result.json"), maximumBytes);
    if (!bytes.equals(Buffer.from(serializeAdjudicatedStandaloneReview(state.result)))) {
      return { ok: false, message: "published standalone result bytes differ from replay" };
    }
    return { ok: true, value: state };
  } catch (cause) {
    return { ok: false, message: `published standalone result is unavailable (${safeIoCause(cause)})` };
  }
}

export function standalonePublicationEffectId(authority: FrozenStandaloneReviewAuthority) {
  return parseEffectId(`effect:standalone-review:${createHash("sha256").update(authority.roster.orderedSlots.map((entry) =>
    entry.attempts[0].requestId).join("|")).digest("hex")}`);
}

export function durableRequests(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
): DurableRequestRecovery {
  const requests: SpawnRequest[] = [];
  const effectId = standalonePublicationEffectId(authority);
  if (!effectId.ok) return { kind: "corrupt", message: effectId.error.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind !== "found") return publication;
  for (const slot of authority.roster.orderedSlots) {
    const raw = slot.attempts[0];
    const parsed = parseIssuedSpawnRequest(resolver, {
      authority: raw,
      context: {
        digest: raw.contextDigest,
        slot: { kind: "fixed-artifact-slot", path: `contexts/${raw.contextDigest}.json` },
      },
      issuance: {
        schemaVersion: 1,
        kind: "issued-spawn-request-proof",
        runId: authority.runId,
        effectId: effectId.value,
        publicationDigest: publication.digest,
        batchIndex: requests.length,
      },
    });
    if (!parsed.ok) return { kind: "corrupt", message: `durable issued request is invalid: ${parsed.error.message}` };
    requests.push(parsed.value);
  }
  return { kind: "found", requests: Object.freeze(requests) };
}

/**
 * One rejected reviewer slot's attempt-2 recovery identity.
 *
 * The retry batch is published under its own effect label (exactly like the
 * refutation panel's per-slot retry batches), so a crash between the semantic
 * rejection checkpoint and the retry spawn is recovered on the next resume by
 * reading the durable publication receipt — never by re-deriving request
 * authority from prose.
 */
export function standaloneRetryEffectId(slotId: string, requestId: string): ProgramParse<EffectId> {
  const label = `standalone-review-retry:${slotId}`;
  const parsed = parseEffectId(`effect:${label}:${createHash("sha256").update(requestId).digest("hex")}`);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, message: parsed.error.message };
}

export async function recoverOrPublishStandaloneRetry(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  slot: Readonly<{ slotId: string; attempts: readonly [AgentRequestAuthority, AgentRequestAuthority] }>,
  resolver: PublicationAuthorityResolver,
  emissionAuthority: RegisteredReviewProgram,
): Promise<Readonly<{ ok: true; request: SpawnRequest }> | Readonly<{ ok: false; message: string }>> {
  const retryAuthority = slot.attempts[1];
  if (retryAuthority.attempt !== 2 || retryAuthority.program !== "standalone-review") {
    return { ok: false, message: `slot ${slot.slotId} has no canonical standalone attempt-2 authority` };
  }
  const input: InitialSpawnRequestInput = Object.freeze({
    authority: retryAuthority,
    context: Object.freeze({
      digest: retryAuthority.contextDigest,
      slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${retryAuthority.contextDigest}.json` }),
    }),
  });

  if (authority.schemaVersion === 3) {
    const packet = handle.readStandaloneSuccessorContext(retryAuthority.contextDigest);
    if (!packet.ok) return { ok: false, message: packet.error.message };
    const rebuilt = buildStandaloneSuccessorReviewerContext(authority.successor, retryAuthority, packet.value.variableContext);
    if (!rebuilt.ok || rebuilt.value.digest !== retryAuthority.contextDigest) return { ok: false, message: "successor retry packet differs from frozen authority" };
    const recovered = durableRefutationRequests(handle, [input], resolver, `standalone-review-retry:${slot.slotId}`);
    if (recovered.kind === "corrupt") return { ok: false, message: recovered.message };
    if (recovered.kind === "found") return { ok: true, request: recovered.requests[0]! };
    const published = await publishReviewInitialBatch(handle, [input], [packet.value], `standalone-review-retry:${slot.slotId}`, emissionAuthority);
    return published.ok ? { ok: true, request: published.requests[0]! } : published;
  }
  let packet = handle.readContext(retryAuthority.contextDigest);
  if (!packet.ok) {
    // Runs started before the engine published attempt-2 packets up front need
    // a deterministic fallback: the attempt-2 packet is rebuilt from the
    // PERSISTED attempt-1 packet — the frozen-source section is re-read from
    // the run directory rather than re-derived from worktree bytes, so the
    // digest can never drift — and the rebuild is refused if its digest does
    // not equal the digest the roster froze at start.
    const attemptOne = handle.readContext(slot.attempts[0].contextDigest);
    if (!attemptOne.ok) return { ok: false, message: attemptOne.error.message };
    const frozenSource = attemptOne.value.fixedContext.find((section) => section.label === "standalone-frozen-source");
    if (frozenSource === undefined) {
      return { ok: false, message: "attempt-1 context packet lacks the standalone-frozen-source section" };
    }
    const authoritySection = encodeByteSection("standalone-review-authority", JSON.stringify({
      runId: handle.runId,
      scope: authority.scope,
      role: retryAuthority.role,
      attempt: 2,
    }));
    if (!authoritySection.ok) return { ok: false, message: authoritySection.error.message };
    if (attemptOne.value.schemaVersion !== authority.schemaVersion) {
      return { ok: false, message: "retry predecessor protocol differs from frozen registration" };
    }
    const input = { requestId: retryAuthority.requestId, role: retryAuthority.role,
      requiredSkill: attemptOne.value.requiredSkill,
      fixedContext: Object.freeze([authoritySection.value, frozenSource]), variableContext: Object.freeze([]) };
    const rebuilt = authority.schemaVersion === 2 ? buildReviewerContextPacket(input)
      : buildContextPacket({ ...input, outputContract: attemptOne.value.outputContract });
    if (!rebuilt.ok) return { ok: false, message: rebuilt.error.message };
    if (rebuilt.value.digest !== retryAuthority.contextDigest) {
      return {
        ok: false,
        message: `rebuilt attempt-2 context digest ${rebuilt.value.digest} differs from the frozen roster digest ${retryAuthority.contextDigest}`,
      };
    }
    const published = await handle.publishContext(rebuilt.value);
    if (!published.ok) return { ok: false, message: published.error.message };
    packet = rebuilt;
  }
  const effectId = standaloneRetryEffectId(slot.slotId, retryAuthority.requestId);
  if (!effectId.ok) return { ok: false, message: effectId.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind === "corrupt") return { ok: false, message: publication.message };
  if (publication.kind === "found") {
    const parsed = parseIssuedSpawnRequest(resolver, {
      authority: input.authority,
      context: input.context,
      issuance: {
        schemaVersion: 1,
        kind: "issued-spawn-request-proof",
        runId: handle.runId,
        effectId: effectId.value,
        publicationDigest: publication.digest,
        batchIndex: 0,
      },
    });
    if (!parsed.ok) return { ok: false, message: `durable standalone retry request is invalid: ${parsed.error.message}` };
    return { ok: true, request: parsed.value };
  }
  const publishedBatch = await publishReviewInitialBatch(handle, [input], [packet.value], `standalone-review-retry:${slot.slotId}`, emissionAuthority);
  return publishedBatch.ok
    ? { ok: true, request: publishedBatch.requests[0]! }
    : { ok: false, message: publishedBatch.message };
}
