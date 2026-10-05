import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import {
  prepareStandaloneLineageSource,
  prepareStandaloneDisposition,
  prepareStandaloneSuccessor,
  readPublishedStandaloneDisposition,
  type PreparedStandaloneDisposition,
} from "../../src/core/standalone-lineage";
import { standaloneOriginReference, findingOf } from "../../src/core/standalone-finding-origin";
import { type PublishedStandaloneDisposition } from "../../src/core/standalone-review-model";
import { parseStandaloneDispositionStartBytes, parseStandaloneDispositionStartInput, parseRegisteredStandaloneDispositionProgram, registerStandaloneDisposition,
  startStandaloneDisposition, reduceStandaloneDisposition, standaloneDispositionReceipt, checkStandaloneDispositionCheckpoint } from "../../src/core/standalone-disposition-machine";
import { standaloneFixture, valueOf } from "../fixtures/standalone-remediation-authority";
import { dispositionPublicationFixture } from "../fixtures/standalone-disposition-publication";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const source = valueOf(prepareStandaloneLineageSource(standaloneFixture(["a.ts"], false,
  { firstTranscript: "CRITICAL_COUNT: 0\nADVISORY_COUNT: 1\nADVISORY: bounded advisory" }).input.standaloneResult, "/owned/source"));
function fixture(reason = "Declared reason") {
  const record = { schemaVersion: 1, source: source.publication, provenance: "DECLARED", revision: { kind: "initial" },
    entries: source.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), decision: "accepted", reason })) };
  const prepared = valueOf(prepareStandaloneDisposition(source, bytes(record)));
  const input = valueOf(parseStandaloneDispositionStartBytes(bytes({ source: source.publication, record, previous: null })));
  const registration = valueOf(registerStandaloneDisposition("run.policy", input));
  return { prepared, input, registration };
}

describe("durable standalone disposition lifecycle and nominal policy", () => {
  it("preparation alone can neither correct nor select policy; copied publication authority is refused", () => {
    const f = fixture();
    const correction = bytes({ ...f.prepared.record, revision: { kind: "correction", previousDigest: f.prepared.digest } });
    const selection = bytes({ runId: "run.next", snapshot: [{ kind: "absent", path: "a.ts" }], reviewers: source.reviewers });
    const published = dispositionPublicationFixture(f.prepared).published;
    for (const hostile of [f.prepared as unknown as PublishedStandaloneDisposition, { ...published }]) {
      expect(prepareStandaloneDisposition(source, correction, hostile).ok).toBe(false);
      expect(prepareStandaloneSuccessor(source, selection, { kind: "selected-record", disposition: hostile }).ok).toBe(false);
    }
    expect(prepareStandaloneDisposition(source, correction, published).ok).toBe(true);
    expect(prepareStandaloneSuccessor(source, selection, { kind: "selected-record", disposition: published }).ok).toBe(true);
    expectTypeOf<PreparedStandaloneDisposition>().not.toMatchTypeOf<PublishedStandaloneDisposition>();
  });
  it("rejects a critical from the same authentic mixed source rather than only foreign origins", () => {
    const mixed = valueOf(prepareStandaloneLineageSource(standaloneFixture(["a.ts"], true, {
      firstTranscript: "CRITICAL_COUNT: 1\nADVISORY_COUNT: 1\nCRITICAL: original blocking assertion\nADVISORY: original optional assertion",
    }).input.standaloneResult, "/owned/mixed"));
    const advisory = mixed.inventory.find(row => findingOf(row).severity === "advisory")!;
    const critical = mixed.inventory.find(row => findingOf(row).severity === "critical")!;
    const record = { schemaVersion: 1, source: mixed.publication, provenance: "DECLARED", revision: { kind: "initial" },
      entries: [{ origin: standaloneOriginReference(advisory.origin), decision: "dismissed", reason: "Parent policy, not adjudication" }] };
    expect(prepareStandaloneDisposition(mixed, bytes(record)).ok).toBe(true);
    expect(prepareStandaloneDisposition(mixed, bytes({ ...record, entries: [{ ...record.entries[0], origin: standaloneOriginReference(critical.origin) }] })).ok).toBe(false);
    expect(prepareStandaloneDisposition(mixed, bytes({ ...record, entries: [...record.entries, { ...record.entries[0], origin: standaloneOriginReference(critical.origin) }] })).ok).toBe(false);
  });
  it("requires exact actual reader evidence, not internally consistent changed bytes, Run, effect or receipt", () => {
    const f = fixture();
    const publication = dispositionPublicationFixture(f.prepared);
    expect(readPublishedStandaloneDisposition(f.prepared, publication.reference, () => ({ ok: false, error: { message: "absent" } })).ok).toBe(false);
    for (const receipt of [{ ...publication.receipt, runId: "run.foreign" }, { ...publication.receipt, effectId: "effect:foreign" },
      { ...publication.receipt, artifacts: [] }, { ...publication.receipt, artifacts: [{ ...publication.receipt.artifacts[0], digest: "f".repeat(64) }] }]) {
      expect(readPublishedStandaloneDisposition(f.prepared, publication.reference, () => ({ ok: true, value: { recordBytes: publication.recordBytes, receipt } })).ok).toBe(false);
    }
    expect(readPublishedStandaloneDisposition(f.prepared, publication.reference, () => ({ ok: true, value: { recordBytes: bytes({ ...f.prepared.record, provenance: "PROVEN" }), receipt: publication.receipt } })).ok).toBe(false);
  });
  it("round trips registration and idempotently reconciles every legal crash prefix", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }).filter(text => text.trim() !== ""), reason => {
      const f = fixture(reason);
      expect(parseRegisteredStandaloneDispositionProgram(JSON.parse(JSON.stringify(f.registration)))).toEqual({ ok: true, value: f.registration });
      const registered = startStandaloneDisposition(f.registration);
      const artifact = valueOf(reduceStandaloneDisposition(f.registration, registered, { kind: "artifact-published" }));
      const receipt = standaloneDispositionReceipt(f.registration);
      expect(reduceStandaloneDisposition(f.registration, registered, { kind: "receipt-recorded", receipt }).ok).toBe(false);
      const done = valueOf(reduceStandaloneDisposition(f.registration, artifact, { kind: "receipt-recorded", receipt }));
      expect(reduceStandaloneDisposition(f.registration, done, { kind: "receipt-recorded", receipt })).toEqual({ ok: true, value: done });
      expect(reduceStandaloneDisposition(f.registration, done, { kind: "artifact-published" })).toEqual({ ok: true, value: done });
      for (const checkpoint of [null, registered, artifact, done]) expect(checkStandaloneDispositionCheckpoint(f.registration, done, checkpoint).ok).toBe(true);
      expect(checkStandaloneDispositionCheckpoint(f.registration, artifact, done).ok).toBe(false);
      expect(checkStandaloneDispositionCheckpoint(f.registration, registered, artifact).ok).toBe(false);
      expect(checkStandaloneDispositionCheckpoint(f.registration, done, { ...done, registrationDigest: "f".repeat(64) }).ok).toBe(false);
    }), { seed: 5201, numRuns: 50 });
  });
  it("refuses unknown fields, malformed explicit correction relations, duplicate keys and oversized byte ingress", () => {
    const f = fixture();
    let getters = 0;
    const getter = { enumerable: true, get() { getters++; throw Error("hostile getter"); } };
    for (const input of [
      { ...f.input, source: Object.defineProperty({ ...f.input.source }, "locator", getter) },
      { ...f.input, record: Object.defineProperty({ ...f.input.record }, "entries", getter) },
      { ...f.input, record: { ...f.input.record, revision: Object.defineProperty({}, "kind", getter) } },
      { ...f.input, record: { ...f.input.record, entries: [Object.defineProperty({}, "origin", getter)] } },
    ]) expect(parseStandaloneDispositionStartInput(input).ok).toBe(false);
    expect(getters).toBe(0);
    for (const input of [{ ...f.input, previous: {} }, { ...f.input, extra: true }, { ...f.input, previous: dispositionPublicationFixture(f.prepared).reference },
      { ...f.input, record: { ...f.input.record, revision: { kind: "correction", previousDigest: f.prepared.digest } } }]) expect(parseStandaloneDispositionStartBytes(bytes(input)).ok).toBe(false);
    expect(parseRegisteredStandaloneDispositionProgram({ ...f.registration, registrationDigest: "f".repeat(64) }).ok).toBe(false);
    expect(parseStandaloneDispositionStartBytes(new Uint8Array(16_777_217)).ok).toBe(false);
    expect(parseStandaloneDispositionStartBytes(new TextEncoder().encode('{"source":null,"source":null}')).ok).toBe(false);
    fc.assert(fc.property(fc.uint8Array({ maxLength: 1024 }), raw => { expect(typeof parseStandaloneDispositionStartBytes(raw).ok).toBe("boolean"); }), { seed: 5202, numRuns: 50 });
  });
});
