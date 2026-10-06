/**
 * Codecs that moved their exact-record admission onto the shared kernel
 * (`plain-record`'s `parseExactRecord`, or `canonicalStructuralEquals` for an
 * exact policy value). Each keeps accepting parsed JSON and now also refuses
 * what the kernel refuses and the hand-rolled `Object.keys` checks let
 * through: symbol keys and non-plain prototypes.
 */
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/core/digest";
import { parsePredecessorArchiveRecord } from "../../src/core/predecessor-archive";
import { STANDALONE_READ_COVERAGE_V1, parseStandaloneReadCoverage } from "../../src/core/standalone-read-coverage";
import { parseWaveFrozenSource, waveFrozenSource } from "../../src/core/wave-frozen-source";
import { observedWorkspace } from "../fixtures/reviewed-workspace";

const BOUNDS = { expandedBytes: 1_024, encodedBytes: 1_024 };
const packet = new Uint8Array(Buffer.from('{"schemaVersion":2}', "utf8"));
const reference = () => ({
  encoding: "published-packet-reference", byteLength: packet.byteLength, digest: sha256Bytes(packet),
  path: "/runs/source/contexts/a.json", purpose: "v1-v2",
});
const withSymbolKey = <T extends object>(record: T): T => Object.assign({ ...record }, { [Symbol("extra")]: true });
class Foreign { constructor(fields: object) { Object.assign(this, fields); } }

describe("predecessor archive record admission", () => {
  it("accepts a parsed JSON reference record", () => {
    expect(parsePredecessorArchiveRecord(JSON.parse(JSON.stringify(reference())), BOUNDS).ok).toBe(true);
  });

  it("refuses a symbol-keyed or non-plain reference record as an invalid reference", () => {
    for (const raw of [withSymbolKey(reference()), new Foreign(reference())]) {
      const result = parsePredecessorArchiveRecord(raw, BOUNDS);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("invalid-reference");
    }
  });

  it("keeps refusing a non-object as a malformed record", () => {
    const result = parsePredecessorArchiveRecord(["encoding"], BOUNDS);
    expect(result.ok ? null : result.error.kind).toBe("malformed-record");
  });
});

describe("wave frozen source admission", () => {
  const source = () => JSON.parse(JSON.stringify(waveFrozenSource(observedWorkspace("T1", ["src/a.ts"], [
    { path: "src/a.ts", bytes: Buffer.from("a\n") },
  ])))) as Record<string, unknown> & { files: Record<string, unknown>[] };

  it("accepts the parsed JSON encoding", () => {
    expect(parseWaveFrozenSource(source()).ok).toBe(true);
  });

  it("refuses a symbol key or a non-plain prototype at the top level", () => {
    expect(parseWaveFrozenSource(withSymbolKey(source()))).toEqual({ ok: false, error: "wave frozen source has an invalid schema" });
    expect(parseWaveFrozenSource(new Foreign(source()))).toEqual({ ok: false, error: "wave frozen source has an invalid schema" });
  });

  it("refuses a symbol key on a file entry", () => {
    const raw = source();
    const tampered = { ...raw, files: [withSymbolKey(raw.files[0]!)] };
    expect(parseWaveFrozenSource(tampered)).toEqual({ ok: false, error: "wave frozen source file 0 is malformed" });
  });
});

describe("read coverage policy admission", () => {
  it("accepts the exact policy as parsed JSON", () => {
    expect(parseStandaloneReadCoverage(JSON.parse(JSON.stringify(STANDALONE_READ_COVERAGE_V1))))
      .toEqual({ ok: true, value: STANDALONE_READ_COVERAGE_V1 });
  });

  it("refuses the same fields on a non-plain prototype, a changed value, or a surplus key", () => {
    for (const raw of [
      new Foreign(STANDALONE_READ_COVERAGE_V1),
      { ...STANDALONE_READ_COVERAGE_V1, pageUnits: STANDALONE_READ_COVERAGE_V1.pageUnits + 1 },
      { ...STANDALONE_READ_COVERAGE_V1, extra: true },
    ]) {
      expect(parseStandaloneReadCoverage(raw).ok).toBe(false);
    }
  });
});
