/**
 * Reviewer protocol resolution: which issued reviewer protocol governs one
 * request, proved from independently parsed durable registration, the exact
 * durable publication, and the published Context Packet — never from the
 * reviewer payload's shape or a global current version.
 */
import type { PreparedStandaloneSuccessor } from '../../../core/standalone-review-model';
import { parseIssuedStandaloneSuccessorReviewer, standaloneSuccessorReviewerRegistration } from '../../../core/standalone-successor-reviewer';
import type { FrozenStandaloneReviewAuthority } from '../../../core/standalone-review-model';
import type { StandaloneReviewerProtocolResolver } from '../../../core/standalone-review';
import { canonicalStructuralEquals, sameAgentRequestAuthority, type AgentRequestAuthority, type DomainResult } from '../../../core/orchestration-contract';
import { safeIoCause } from '../../../core/safe-io-cause';
import type { ContextPacket } from '../../../core/context-packets';
import type { ReviewerProtocolFailure } from '../../../core/reviewer-contract';
import { parseIssuedReviewerProtocol, type ReviewerProtocolAuthorityResolver, type ReviewerProtocolRegistration, type ReviewerSubjectBinding } from '../../../core/review-output';
import { readWaveReviewContext } from '../../../core/wave-review-authority';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { RegisteredStandaloneSuccessorProgram } from './standalone-successor-registration';
import { parsedAuthority, parseRegisteredFacadeProgram, parseRegistration, sameRegisteredStandalonePrograms, type RegisteredStandaloneProgram } from './registration';
import { publishedReviewerRequest } from './durable-requests';
import type { ProgramParse } from './program-result';

const protocolUnavailable = (message: string): DomainResult<never, ReviewerProtocolFailure> => ({
  ok: false, error: Object.freeze({ kind: "reviewer-protocol-failed", code: "authority-unavailable", path: "/registration", message }),
});

function registeredReviewerSubject(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram | RegisteredWaveGateProgram,
  request: AgentRequestAuthority,
  packet: ContextPacket,
): ProgramParse<ReviewerSubjectBinding> {
  if (registration.kind === "standalone-review") {
    const authority = parsedAuthority(registration);
    if (!authority.ok) return authority;
    const expected = authority.value.roster.orderedSlots.flatMap(({ attempts }) => attempts)
      .find((entry) => entry.requestId === request.requestId);
    if (authority.value.runId !== handle.runId || expected === undefined || !sameAgentRequestAuthority(expected, request)) {
      return { ok: false, message: "reviewer request differs from the registered standalone roster" };
    }
    return { ok: true, value: Object.freeze({ kind: "standalone-review", runId: handle.runId, scope: authority.value.scope }) };
  }
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.task === null || context.value.taskRun === null || context.value.packetId === null) {
    return { ok: false, message: "published Wave reviewer context authority is unavailable" };
  }
  const { task, taskRun } = context.value;
  if (context.value.runId !== handle.runId || context.value.wave !== registration.input.wave ||
      context.value.authorityDigest !== registration.authorityDigest || !registration.taskIds.includes(task.id)) {
    return { ok: false, message: "published Wave context differs from its complete program registration" };
  }
  return { ok: true, value: Object.freeze({ kind: "wave-review", runId: handle.runId, taskId: task.id,
    packetId: context.value.packetId, generation: taskRun.generation,
    priorFindingIds: Object.freeze(task.priorFindings.map(({ id }) => id)),
    scope: Object.freeze([...new Set([...task.declaredFiles, ...task.modifiedFiles])].sort()),
  }) };
}

/** Legacy resolution retains its exact joins; the explicit successor arm requires nominal source authority. */
export function reviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneProgram | RegisteredWaveGateProgram,
  maximumBytes?: number): ReviewerProtocolAuthorityResolver;
export function reviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneProgram,
  maximumBytes: number, successor: PreparedStandaloneSuccessor): StandaloneReviewerProtocolResolver;
export function reviewerProtocolResolver(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram | RegisteredWaveGateProgram,
  maximumBytes?: number,
  successor?: PreparedStandaloneSuccessor,
): StandaloneReviewerProtocolResolver {
  if (successor !== undefined) return registration.kind === "standalone-review" && registration.schemaVersion === 3
    ? successorReviewerProtocolResolver(handle, registration, successor, maximumBytes ?? 16_777_216)
    : () => protocolUnavailable("successor purpose requires an explicit standalone v3 registration");
  return (request) => {
    try {
      const stored = handle.readProgramRegistration();
      if (!stored.ok) return protocolUnavailable("reviewer program registration is unavailable");
      const parsed = parseRegisteredFacadeProgram(stored.value);
      const expected = parseRegisteredFacadeProgram(registration);
      if (parsed.kind !== "registered" || (parsed.program.kind !== "standalone-review" && parsed.program.kind !== "wave-gate") || expected.kind !== "registered" ||
          !canonicalStructuralEquals(parsed.program, expected.program) || request.runId !== handle.runId ||
          request.program !== parsed.program.kind) {
        return protocolUnavailable("reviewer registration or request differs from independently parsed durable authority");
      }
      if (parsed.program.schemaVersion === 3) return protocolUnavailable("standalone v3 requires the independently authenticated successor purpose");
      const published = publishedReviewerRequest(handle, request, maximumBytes);
      if (!published.ok) return protocolUnavailable(published.message);
      const packet = handle.readContext(request.contextDigest);
      if (!packet.ok) return protocolUnavailable("published reviewer Context Packet is unavailable");
      const subject = registeredReviewerSubject(handle, parsed.program, request, packet.value);
      if (!subject.ok) return protocolUnavailable(subject.message);
      const protocol: ReviewerProtocolRegistration = parsed.program.schemaVersion === 2
        ? { schemaVersion: 2, runId: handle.runId, program: parsed.program.kind, reviewerProtocol: parsed.program.reviewerProtocol }
        : { schemaVersion: 1, runId: handle.runId, program: parsed.program.kind };
      return parseIssuedReviewerProtocol({ request: published.value, packet: packet.value, registration: protocol, subject: subject.value });
    } catch (cause) {
      return protocolUnavailable(`reviewer registration/publication/context cannot be read safely (${safeIoCause(cause)})`);
    }
  };
}

/** Select from registration, never reviewer payload shape or a global current version. */
export function standaloneReviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneProgram,
  successor?: PreparedStandaloneSuccessor, maximumBytes = 16_777_216): StandaloneReviewerProtocolResolver {
  if (registration.schemaVersion !== 3) return reviewerProtocolResolver(handle, registration, maximumBytes);
  return successor === undefined ? () => protocolUnavailable("successor resolver requires independently authenticated predecessor")
    : reviewerProtocolResolver(handle, registration, maximumBytes, successor);
}

function successorReviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneSuccessorProgram,
  successor: PreparedStandaloneSuccessor, maximumBytes: number): StandaloneReviewerProtocolResolver {
  // One operation-local immutable registration snapshot; every request still proves
  // its own publication/reservation and rereads its exact Context Packet bytes.
  const authority = readRegisteredStandaloneAuthority(handle, registration, successor);
  return request => {
    try {
      if (!authority.ok) return protocolUnavailable(authority.message);
      const expected = authority.value.roster.orderedSlots.flatMap(slot => slot.attempts).find(entry => entry.requestId === request.requestId);
      if (expected === undefined || !sameAgentRequestAuthority(expected, request)) return protocolUnavailable("successor request differs from registered roster");
      const issued = publishedReviewerRequest(handle, request, maximumBytes);
      if (!issued.ok) return protocolUnavailable(issued.message);
      const packet = handle.readStandaloneSuccessorContext(request.contextDigest, maximumBytes);
      if (!packet.ok) return protocolUnavailable(packet.error.message);
      return parseIssuedStandaloneSuccessorReviewer({ request: issued.value, packet: packet.value,
        registration: standaloneSuccessorReviewerRegistration(successor), prepared: successor });
    } catch (cause) { return protocolUnavailable(`successor publication/context unavailable (${safeIoCause(cause)})`); }
  };
}

export function readRegisteredStandaloneAuthority(
  handle: RunDirHandle,
  expected: RegisteredStandaloneProgram,
  successor?: PreparedStandaloneSuccessor,
): ProgramParse<FrozenStandaloneReviewAuthority> {
  const raw = handle.readProgramRegistration();
  if (!raw.ok) return { ok: false, message: "standalone program registration is unavailable" };
  const registered = parseRegistration(raw.value);
  const supplied = parseRegistration(expected);
  if (!registered.ok || !supplied.ok || !sameRegisteredStandalonePrograms(registered.value, supplied.value)) {
    return { ok: false, message: "standalone registration differs from independently parsed durable program authority" };
  }
  return parsedAuthority(registered.value, successor);
}
