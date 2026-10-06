/**
 * A ready-to-finalize checkpoint whose durable Refutation Panel completion
 * receipt does not re-prove still refuses, and the refusal now names WHY: the
 * receipt is absent, its re-proof refused (with the re-proof's own
 * diagnostic), or it differs from the re-proof. Replayed over the real
 * `seven-reviewers-retry` golden, through the same independent publication and
 * protocol adapters `reviewer-protocol-history.test.ts` uses.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseContextPacket } from "../../src/core/context-packets";
import {
  canonicalStructuralEquals,
  createPublicationAuthorityResolver,
  parseBatchPublishedReceipt,
  parseIssuedSpawnRequest,
  sameAgentRequestAuthority,
  type PublicationAuthorityResolver,
} from "../../src/core/orchestration-contract";
import type { FrozenStandaloneReviewAuthority } from "../../src/core/standalone-review-model";
import { parseStandaloneReviewMachineState } from "../../src/core/standalone-review-checkpoint";
import { parseIssuedReviewerProtocol, type ReviewerProtocolAuthorityResolver } from "../../src/core/review-output";
import { parseRegistration, parsedAuthority } from "../../src/handlers/helpers/programs/registration";
import { loadReviewerV1Golden, type ReviewerV1Golden } from "../fixtures/reviewer-protocol-v1";

type Files = ReviewerV1Golden["files"];
const record = z.record(z.string(), z.unknown());
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const text = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function required<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

function jsonAt(files: Files, path: string): unknown {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`Missing golden artifact: ${path}`);
  return JSON.parse(text(bytes));
}

function registeredAuthority(files: Files): FrozenStandaloneReviewAuthority {
  return required(parsedAuthority(required(parseRegistration(jsonAt(files, "program.json")))));
}

function contextualPublications(files: Files): PublicationAuthorityResolver {
  const resolvePublication = createPublicationAuthorityResolver(({ effectId }) => {
    const bytes = files.get(`artifacts/publications/${sha256(effectId)}.json`);
    return bytes === undefined
      ? { ok: false, error: { kind: "publication-authority-unavailable", message: "missing publication" } }
      : { ok: true, value: [...bytes] };
  });
  return (identity) => {
    const published = resolvePublication(identity);
    if (!published.ok) return published;
    for (const request of published.value.receipt.issuedRequests) {
      const raw = files.get(request.context.slot.path);
      const packet = parseContextPacket(raw === undefined ? null : JSON.parse(text(raw)));
      if (!packet.ok || packet.value.digest !== request.authority.contextDigest ||
          !canonicalStructuralEquals(jsonAt(files, `requests/${request.authority.requestId}.json`), request.authority)) {
        return { ok: false, error: { kind: "publication-authority-unavailable", message: "Historical request/context mismatch" } };
      }
    }
    return published;
  };
}

function protocols(files: Files): ReviewerProtocolAuthorityResolver {
  const registration = required(parseRegistration(jsonAt(files, "program.json")));
  const authority = required(parsedAuthority(registration));
  if (registration.schemaVersion !== 1) throw new Error("historical registration must remain v1");
  const resolvePublication = contextualPublications(files);
  return (request) => {
    for (const [path, bytes] of files) {
      if (!path.startsWith("artifacts/publications/")) continue;
      const receipt = required(parseBatchPublishedReceipt(JSON.parse(text(bytes))));
      const index = receipt.issuedRequests.findIndex((entry) => sameAgentRequestAuthority(entry.authority, request));
      if (index < 0) continue;
      const issued = required(parseIssuedSpawnRequest(resolvePublication, {
        ...receipt.issuedRequests[index], issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof",
          runId: receipt.runId, effectId: receipt.effectId, publicationDigest: receipt.publicationDigest, batchIndex: index },
      }));
      const packet = required(parseContextPacket(jsonAt(files, `contexts/${request.contextDigest}.json`)));
      return parseIssuedReviewerProtocol({ request: issued, packet,
        registration: { schemaVersion: registration.schemaVersion, runId: authority.runId, program: registration.kind },
        subject: { kind: "standalone-review", runId: authority.runId, scope: authority.scope },
      });
    }
    return { ok: false, error: { kind: "reviewer-protocol-failed", code: "authority-unavailable", path: "/golden-publications", message: "original publication missing" } };
  };
}

const files = loadReviewerV1Golden("seven-reviewers-retry").files;
const checkpoint = record.parse(jsonAt(files, "checkpoint.json"));
const completion = record.parse(checkpoint.refutationCompletion);

function replayRefusal(refutationCompletion: unknown): string {
  const replayed = parseStandaloneReviewMachineState(
    { ...checkpoint, kind: "ready-to-finalize", refutationCompletion },
    contextualPublications(files),
    protocols(files),
    registeredAuthority(files),
  );
  expect(replayed.ok).toBe(false);
  if (replayed.ok) throw new Error("unreachable");
  return replayed.error.message;
}

const PREFIX = "checkpoint lacks a valid durable Refutation Panel completion receipt: ";

describe("durable Refutation Panel completion receipt restore diagnostics", () => {
  it("replays the untampered receipt", () => {
    const replayed = parseStandaloneReviewMachineState(
      { ...checkpoint, kind: "ready-to-finalize" }, contextualPublications(files), protocols(files), registeredAuthority(files),
    );
    expect(replayed.ok).toBe(true);
  });

  it("names an absent receipt", () => {
    expect(replayRefusal(null)).toBe(`${PREFIX}the persisted completion receipt is absent or not an object`);
  });

  it("names a receipt that differs from its re-proof", () => {
    expect(replayRefusal({ ...completion, outcomeDigest: "0".repeat(64) }))
      .toBe(`${PREFIX}the persisted completion receipt differs from its re-proof`);
  });

  it("carries the re-proof's own diagnostic when the persisted T2 evidence refuses", () => {
    const panelCheckpoint = record.parse(completion.completedPanelCheckpoint);
    const events = z.array(record).parse(panelCheckpoint.events);
    const message = replayRefusal({
      ...completion,
      completedPanelState: undefined,
      completedPanelCheckpoint: { ...panelCheckpoint, events: [{ ...events[0], value: {} }, ...events.slice(1)] },
    });
    expect(message.startsWith(PREFIX)).toBe(true);
    const cause = message.slice(PREFIX.length);
    expect(cause).not.toBe("");
    expect(cause).not.toContain("differs from its re-proof");
    expect(cause).not.toContain("absent or not an object");
  });
});
