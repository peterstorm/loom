/**
 * Wave reviewer payload fixtures: the exact envelope the issued reviewer
 * descriptor admits (ADR-0083). A v4 Wave Gate refuses `packetId` and
 * `generation` (the engine binds both from the issued subject); a v2 Wave Gate
 * registered before v4 still requires them. The version is always read from
 * issued authority, never assumed, so a fixture cannot silently emit the
 * envelope of the other protocol.
 */
import type { ContextPacket } from "../../src/core/context-packets";
import { readWaveReviewContext } from "../../src/core/wave-review-authority";

/** The Wave reviewer descriptor versions a schema-2 registration can carry. */
export type WaveReviewerProtocolVersion = 2 | 4;

/** The reviewer-judged body every Wave envelope shares. */
export type WaveReviewerPayloadBody = Readonly<{
  prior_findings: readonly unknown[];
  findings: readonly unknown[];
}>;

/** The issued Review Packet identity a v2 payload must echo. */
export type WavePacketIdentity = Readonly<{ packetId: string; generation: number }>;

/** The exact Wave payload `version` admits: v4 carries no packet identity, v2 echoes it. */
export function waveReviewerPayload(
  version: WaveReviewerProtocolVersion,
  identity: WavePacketIdentity,
  body: WaveReviewerPayloadBody,
): string {
  switch (version) {
    case 4:
      return JSON.stringify({ schemaVersion: 4, kind: "wave-review", prior_findings: body.prior_findings, findings: body.findings });
    case 2:
      return JSON.stringify({ schemaVersion: 2, kind: "wave-review", packetId: identity.packetId,
        generation: identity.generation, prior_findings: body.prior_findings, findings: body.findings });
    default:
      return assertNever(version);
  }
}

/**
 * The v4 envelope that still copies the issued packet identity — the shape a
 * v4 Wave Gate must refuse (ADR-0083), and the one a v2 reviewer would emit
 * with the v4 `schemaVersion`.
 */
export function waveReviewerPayloadV4WithIdentity(identity: WavePacketIdentity, body: WaveReviewerPayloadBody): string {
  return JSON.stringify({ schemaVersion: 4, kind: "wave-review", packetId: identity.packetId,
    generation: identity.generation, prior_findings: body.prior_findings, findings: body.findings });
}

/** The descriptor version an issued Task review packet carries; an archived v1 packet has none. */
function issuedWaveReviewerVersion(packet: ContextPacket): WaveReviewerProtocolVersion {
  if (packet.schemaVersion !== 2) throw new Error("an archived v1 Wave packet issues no JSON reviewer payload");
  return packet.reviewerProtocol.version;
}

/** The issued Review Packet identity of a Task review packet. */
export function issuedWavePacketIdentity(packet: ContextPacket): WavePacketIdentity {
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.taskRun === null) throw new Error("expected an issued Wave Task review context");
  return { packetId: context.value.taskRun.packetId, generation: context.value.taskRun.generation };
}

/** The exact payload the issued packet's own descriptor admits, for `body`. */
export function issuedWaveReviewerPayload(packet: ContextPacket, body: WaveReviewerPayloadBody): string {
  return waveReviewerPayload(issuedWaveReviewerVersion(packet), issuedWavePacketIdentity(packet), body);
}

function assertNever(value: never): never {
  throw new Error(`unreachable Wave reviewer protocol version: ${JSON.stringify(value)}`);
}
