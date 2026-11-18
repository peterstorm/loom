/**
 * Wave reviewer payload fixtures: the exact envelope the issued reviewer
 * descriptor admits (ADR-0084). A v4 Wave Gate refuses `packetId` and
 * `generation` (the engine binds both from the issued subject); a v2 Wave Gate
 * registered before v4 still requires them. The version is always read from
 * issued authority, never assumed, so a fixture cannot silently emit the
 * envelope of the other protocol.
 */
import type { ContextPacket } from "../../src/core/context-packets";
import type { ReviewerProtocolDescriptor } from "../../src/core/reviewer-contract";
import { readWaveReviewContext } from "../../src/core/wave-review-authority";
import { assertNever } from "./assert-never";

/** The reviewer-judged body every Wave envelope shares. */
export type WaveReviewerPayloadBody = Readonly<{
  prior_findings: readonly unknown[];
  findings: readonly unknown[];
}>;

/** The issued Review Packet identity a v2 payload must echo. */
export type WavePacketIdentity = Readonly<{ packetId: string; generation: number }>;

/**
 * What one Wave envelope is built from, per descriptor version: a v4 payload
 * carries no packet identity, so its input has none to pass; a v2 payload
 * echoes it, so its input cannot omit it.
 */
export type WaveReviewerPayloadInput =
  | Readonly<{ version: 4; body: WaveReviewerPayloadBody }>
  | Readonly<{ version: 2; identity: WavePacketIdentity; body: WaveReviewerPayloadBody }>;

/** The exact Wave payload `input.version` admits. */
export function waveReviewerPayload(input: WaveReviewerPayloadInput): string {
  switch (input.version) {
    case 4:
      return JSON.stringify({ schemaVersion: 4, kind: "wave-review",
        prior_findings: input.body.prior_findings, findings: input.body.findings });
    case 2:
      return JSON.stringify({ schemaVersion: 2, kind: "wave-review", packetId: input.identity.packetId,
        generation: input.identity.generation, prior_findings: input.body.prior_findings, findings: input.body.findings });
    default:
      return assertNever(input);
  }
}

/**
 * The exact Wave payload an issued descriptor admits, for a caller that holds
 * the issued packet identity: `identity` is read only when the descriptor is
 * v2, the one envelope that echoes it.
 */
export function issuedDescriptorWavePayload(
  descriptor: ReviewerProtocolDescriptor,
  identity: () => WavePacketIdentity,
  body: WaveReviewerPayloadBody,
): string {
  switch (descriptor.version) {
    case 4:
      return waveReviewerPayload({ version: 4, body });
    case 2:
      return waveReviewerPayload({ version: 2, identity: identity(), body });
    default:
      return assertNever(descriptor);
  }
}

/**
 * The v4 envelope that still copies the issued packet identity — the shape a
 * v4 Wave Gate must refuse (ADR-0084), and the one a v2 reviewer would emit
 * with the v4 `schemaVersion`.
 */
export function waveReviewerPayloadV4WithIdentity(identity: WavePacketIdentity, body: WaveReviewerPayloadBody): string {
  return JSON.stringify({ schemaVersion: 4, kind: "wave-review", packetId: identity.packetId,
    generation: identity.generation, prior_findings: body.prior_findings, findings: body.findings });
}

/** The issued Review Packet identity of a Task review packet. */
export function issuedWavePacketIdentity(packet: ContextPacket): WavePacketIdentity {
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.taskRun === null) throw new Error("expected an issued Wave Task review context");
  return { packetId: context.value.taskRun.packetId, generation: context.value.taskRun.generation };
}

/** The exact payload the issued packet's own descriptor admits, for `body`; an archived v1 packet issues none. */
export function issuedWaveReviewerPayload(packet: ContextPacket, body: WaveReviewerPayloadBody): string {
  if (packet.schemaVersion !== 2) throw new Error("an archived v1 Wave packet issues no JSON reviewer payload");
  return issuedDescriptorWavePayload(packet.reviewerProtocol, () => issuedWavePacketIdentity(packet), body);
}
