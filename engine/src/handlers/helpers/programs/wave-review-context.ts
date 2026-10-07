/**
 * Reading one Wave Gate run's review authority: its durable registration, the
 * issued protocol of each Wave reviewer request, and each request's published
 * Context Packet parsed by the producer-owned core codec.
 */
import type { AgentRequestAuthority } from '../../../core/orchestration-contract';
import type { ContextPacket } from '../../../core/context-packets';
import type { IssuedReviewerProtocol, IssuedWaveReviewerProtocol } from '../../../core/review-output';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import { readWaveReviewContext, type WaveReviewContextRead } from '../../../core/wave-review-authority';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { FacadeDriveResult } from './program-result';
import { parseRegisteredFacadeProgram } from './registration';
import { reviewerProtocolResolver } from './reviewer-protocol-resolution';
import { waveBlocked } from './wave-gate-outcome';

export function readRegisteredWaveProgram(handle: RunDirHandle): RegisteredWaveGateProgram {
  const raw = handle.readProgramRegistration();
  if (!raw.ok) throw new Error(raw.error.message);
  const parsed = parseRegisteredFacadeProgram(raw.value);
  if (parsed.kind !== "registered" || parsed.program.kind !== "wave-gate") {
    throw new Error("Wave reviewer registered authority is unavailable");
  }
  return parsed.program;
}

function isWaveProtocol(protocol: IssuedReviewerProtocol): protocol is IssuedWaveReviewerProtocol {
  return protocol.subject.kind === "wave-review";
}

export function issuedWaveProtocol(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  request: AgentRequestAuthority,
): IssuedWaveReviewerProtocol {
  const issued = reviewerProtocolResolver(handle, registration)(request);
  if (!issued.ok) throw new Error(issued.error.message);
  if (!isWaveProtocol(issued.value)) throw new Error("Wave reviewer request lacks issued Wave protocol authority");
  return issued.value;
}

export type ReadableWaveReviewContext = Exclude<WaveReviewContextRead, Readonly<{ kind: "corrupt" }>>;

type WaveRequestContextRead =
  | Readonly<{ ok: true; packet: ContextPacket; context: ReadableWaveReviewContext }>
  | Readonly<{ ok: false; result: FacadeDriveResult }>;

export function readWaveRequestContext(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  identifyRequest = true,
): WaveRequestContextRead {
  const packet = handle.readContext(authority.contextDigest);
  if (!packet.ok) return { ok: false, result: waveBlocked(handle, packet.error.message) };
  const context = readWaveReviewContext([packet.value], authority.contextDigest);
  if (context.kind === "corrupt") {
    const suffix = identifyRequest ? ` (request ${authority.requestId})` : "";
    return { ok: false, result: waveBlocked(handle, `${context.message}${suffix}`) };
  }
  return { ok: true, packet: packet.value, context };
}

export function waveReviewContextTaskId(context: WaveReviewContextRead): string | null {
  return context.kind === "loaded" ? (context.value.taskRun?.taskId ?? null) : null;
}
