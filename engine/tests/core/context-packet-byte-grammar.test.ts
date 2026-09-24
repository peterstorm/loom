/**
 * The ONE Context Packet byte grammar, owned by `boundedByteIterable`.
 *
 * Three consumers accept section bytes only through it — the packet builder,
 * the packet parser, and the standalone successor registration parser — so no
 * consumer can drift from the others on what a legal section is. These tests
 * pin the grammar itself, the packet parser's exact refusal prose for each
 * violation, the builder's typed (never throwing) refusal, and the
 * cross-parser agreement with the successor path.
 */

import { describe, expect, it } from "vitest";
import {
  boundedByteIterable,
  buildContextPacket,
  encodeByteSection,
  parseContextPacket,
} from "../../src/core/context-packets";
import { parseArtifactByteLength, parseArtifactDigest, parseRequestId } from "../../src/core/orchestration-contract";
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from "../../src/core/standalone-lineage-contract";
import { parseStandaloneSuccessorRegistration } from "../../src/handlers/helpers/programs/standalone-successor-registration";

const request = parseRequestId("reviewer-request-1");
if (!request.ok) throw new Error("invalid fixture request");
const digest = parseArtifactDigest("0".repeat(64));
const byteLength = parseArtifactByteLength(1);
if (!digest.ok || !byteLength.ok) throw new Error("invalid fixture authority constants");

const packet = (bytes: unknown) => ({
  schemaVersion: 1,
  requestId: request.value,
  role: "code-reviewer",
  requiredSkill: "none",
  outputContract: "legacy Machine Summary",
  fixedContext: [{ label: "scope", bytes, digest: digest.value, byteLength: byteLength.value }],
  variableContext: [],
});

describe("the shared Context Packet byte grammar", () => {
  it("accepts arrays, other iterables, and immutable sequences within the bound", () => {
    const encoded = encodeByteSection("scope", "abc");
    if (!encoded.ok) throw new Error(encoded.error.message);
    for (const raw of [[1, 2, 3], new Set([1, 2, 3]), new Uint8Array([1, 2, 3])]) {
      const parsed = boundedByteIterable(raw, 3);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      if (parsed.ok) expect([...parsed.value]).toEqual([1, 2, 3]);
    }
    const sequence = boundedByteIterable(encoded.value.bytes, 3);
    expect(sequence.ok).toBe(true);
    if (sequence.ok) expect([...sequence.value]).toEqual([97, 98, 99]);
  });

  it("refuses non-iterables, non-byte values, sparse holes, and bound excess with typed violations", () => {
    expect(boundedByteIterable("abc", 3)).toMatchObject({ ok: false, error: { rule: "iterable" } });
    expect(boundedByteIterable(42, 3)).toMatchObject({ ok: false, error: { rule: "iterable" } });
    expect(boundedByteIterable({}, 3)).toMatchObject({ ok: false, error: { rule: "iterable" } });
    expect(boundedByteIterable(null, 3)).toMatchObject({ ok: false, error: { rule: "iterable" } });
    expect(boundedByteIterable([1, 256], 3)).toMatchObject({ ok: false, error: { rule: "byte" } });
    expect(boundedByteIterable([1, -1], 3)).toMatchObject({ ok: false, error: { rule: "byte" } });
    expect(boundedByteIterable([1, 1.5], 3)).toMatchObject({ ok: false, error: { rule: "byte" } });
    expect(boundedByteIterable([1, undefined], 3)).toMatchObject({ ok: false, error: { rule: "byte" } });
    const sparse: number[] = [1, 2];
    sparse.length = 4; // holes materialize as undefined: density is enforced by the byte test
    expect(boundedByteIterable(sparse, 8)).toMatchObject({ ok: false, error: { rule: "byte" } });
    expect(boundedByteIterable([1, 2, 3, 4], 3))
      .toMatchObject({ ok: false, error: { rule: "bound", count: 4, maximum: 3 } });
  });

  it("keeps the packet parser's exact refusal prose for each violation", () => {
    expect(parseContextPacket(packet("abc"))).toMatchObject({
      ok: false,
      error: { field: "fixedContext[0].bytes", message: "a context section must carry iterable bytes" },
    });
    expect(parseContextPacket(packet(42))).toMatchObject({
      ok: false,
      error: { field: "fixedContext[0].bytes", message: "a context section must carry iterable bytes" },
    });
    expect(parseContextPacket(packet([300]))).toMatchObject({
      ok: false,
      error: { field: "fixedContext[0].bytes", message: "a context section byte must be an integer from 0 through 255" },
    });
    expect(parseContextPacket(packet([1, undefined]))).toMatchObject({
      ok: false,
      error: { field: "fixedContext[0].bytes", message: "a context section byte must be an integer from 0 through 255" },
    });
  });

  it("builds packets through the grammar and refuses hostile bytes as typed data instead of throwing", () => {
    const built = buildContextPacket({
      requestId: request.value,
      role: "code-reviewer",
      requiredSkill: "none",
      outputContract: "legacy Machine Summary",
      fixedContext: [{ label: "scope", bytes: {} as unknown as Iterable<number>, digest: digest.value, byteLength: byteLength.value }],
      variableContext: [],
    });
    expect(built).toMatchObject({
      ok: false,
      error: { field: "fixedContext[0]", message: "a context section must contain only bytes whose digest and length cover the exact content" },
    });
    const encoded = encodeByteSection("task", "exact");
    if (!encoded.ok) throw new Error(encoded.error.message);
    const honest = buildContextPacket({
      requestId: request.value,
      role: "code-reviewer",
      requiredSkill: "none",
      outputContract: "legacy Machine Summary",
      fixedContext: [encoded.value],
      variableContext: [],
    });
    expect(honest.ok).toBe(true);
  });

  it("the successor registration parser shares the grammar: same inputs, same verdicts", () => {
    const input = { schemaVersion: 3, kind: "types", files: ["a.ts"], dryRun: false,
      successor: { source: { locator: "/owned/source", runId: "source", resultDigest: "a".repeat(64) },
        disposition: { kind: "selected-record", publication: { locator: "/owned/policy", runId: "policy", dispositionDigest: "b".repeat(64) } } } };
    const section = encodeByteSection("standalone-frozen-source", JSON.stringify({ kind: "fixture" }));
    if (!section.ok) throw new Error(section.error.message);
    const registration = (bytes: unknown) => ({
      schemaVersion: 3,
      kind: "standalone-review",
      reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3,
      input,
      authority: {},
      currentSource: { label: "standalone-frozen-source", bytes, digest: section.value.digest, byteLength: section.value.byteLength },
      previousContexts: [],
    });

    // The exact encoded shape — sequence bytes included — is admitted, and the
    // section re-encodes to the same digest and length the registration carried.
    const admitted = parseStandaloneSuccessorRegistration(registration(section.value.bytes));
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.value.currentSource.digest).toBe(section.value.digest);
      expect(admitted.value.currentSource.byteLength).toBe(section.value.byteLength);
      expect(admitted.value.previousContexts).toEqual([]);
    }

    // Every hostile byte shape the packet grammar refuses, the successor path
    // refuses too — through the same validator, not a parallel re-implementation.
    for (const hostile of ["abc", 42, {}, null, [300], [1, -1], [1, undefined]]) {
      const packetVerdict = parseContextPacket(packet(hostile));
      expect(packetVerdict.ok, JSON.stringify(hostile)).toBe(false);
      expect(parseStandaloneSuccessorRegistration(registration(hostile))).toMatchObject({
        ok: false,
        message: "invalid bounded frozen successor source section",
      });
    }
  });
});
