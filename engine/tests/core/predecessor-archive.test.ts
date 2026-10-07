import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gzipSync } from "node:zlib";
import type { ContextProjectionInput } from "../../src/core/context-packet-projection";
import { buildReviewerContextPacket, buildStandaloneReviewerContextPacketV3, encodeByteSection, storedContextPacket } from "../../src/core/context-packets";
import { sha256Bytes } from "../../src/core/digest";
import { parseRequestId } from "../../src/core/orchestration-contract";
import {
  admitFrozenPredecessorArchive, expandGzipPredecessorArchive, parsePredecessorArchiveArguments, parsePredecessorArchiveRecord,
  projectArchivedPredecessor, publishedPacketReference, serializePublishedPacketReference, verifyPredecessorArchiveBytes,
  type ArchivedPredecessorRefusal, type PredecessorArchiveRecord, type PredecessorArchiveRefusal, type PublishedPacketReference,
  type PublishedPacketFile, type ResolvePublishedPacket,
} from "../../src/core/predecessor-archive";
import { refusal, value } from "../fixtures/parse-result";

const BOUNDS = { expandedBytes: 16_777_216, encodedBytes: 16_777_216 };
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const gzipRecord = (bytes: Uint8Array) => ({ encoding: "gzip-base64", contentBase64: gzipSync(bytes).toString("base64"),
  byteLength: bytes.byteLength, digest: sha256Bytes(bytes) });
const referenceRecord = (bytes: Uint8Array, path = "/runs/source/contexts/a.json", purpose = "v1-v2") =>
  ({ encoding: "published-packet-reference", byteLength: bytes.byteLength, digest: sha256Bytes(bytes), path, purpose });
const parsed = (raw: unknown, bounds = BOUNDS): PredecessorArchiveRecord => value(parsePredecessorArchiveRecord(raw, bounds));
const refusalKind = (raw: unknown, bounds = BOUNDS): PredecessorArchiveRefusal["kind"] =>
  refusal(parsePredecessorArchiveRecord(raw, bounds)).kind;
const packet = bytesOf('{"schemaVersion":2,"requestId":"request:a"}');

describe("predecessor archive codec: retained-record ADT", () => {
  it("round-trips every issued reference through its exact wire bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 512 }), fc.stringMatching(/^\/[a-z0-9/._-]{0,40}$/),
      fc.constantFrom("v1-v2" as const, "standalone-successor" as const), (bytes, path, purpose) => {
        const reference = publishedPacketReference(bytes, path, purpose);
        const wire = serializePublishedPacketReference(reference);
        expect(Object.keys(JSON.parse(wire))).toEqual(["encoding", "byteLength", "digest", "path", "purpose"]);
        expect(parsed(JSON.parse(wire))).toEqual(reference);
        expect(verifyPredecessorArchiveBytes(reference, bytes).ok).toBe(true);
      }));
  });

  it("expands any inline gzip archive back to exactly its verified bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 2048 }), bytes => {
      const record = parsed(gzipRecord(bytes));
      if (record.encoding !== "gzip-base64") throw Error("expected gzip");
      const expanded = expandGzipPredecessorArchive(record);
      expect(expanded.ok && Buffer.compare(expanded.value, bytes)).toBe(0);
      expect(expanded.ok && verifyPredecessorArchiveBytes(record, expanded.value).ok).toBe(true);
    }));
  });

  it("refuses any single flipped byte of retained content as bytes that differ", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), fc.nat(), (bytes, at) => {
      const record = parsed(referenceRecord(bytes));
      const tampered = Uint8Array.from(bytes);
      tampered[at % tampered.length]! ^= 0xff;
      const verified = verifyPredecessorArchiveBytes(record, tampered);
      expect(!verified.ok && verified.error.kind).toBe("bytes-differ");
    }));
  });

  it.each([
    ["a non-object", null, "malformed-record"],
    ["an array", [], "malformed-record"],
    ["an unknown encoding", { ...referenceRecord(packet), encoding: "zstd" }, "unsupported-encoding"],
    ["a reference with an extra key", { ...referenceRecord(packet), extra: 1 }, "invalid-reference"],
    ["a reference without a purpose", (({ purpose: _, ...rest }) => rest)(referenceRecord(packet)), "invalid-reference"],
    ["a relative reference path", referenceRecord(packet, "runs/source/a.json"), "invalid-reference"],
    ["an unsupported decode purpose", referenceRecord(packet, "/runs/a.json", "v4"), "invalid-reference"],
    ["a zero byteLength", { ...referenceRecord(packet), byteLength: 0 }, "invalid-reference"],
    ["a fractional byteLength", { ...referenceRecord(packet), byteLength: 1.5 }, "invalid-reference"],
    ["a non-hex digest", { ...referenceRecord(packet), digest: "A".repeat(64) }, "invalid-reference"],
    ["a gzip record with a path", { ...gzipRecord(packet), path: "/x" }, "invalid-gzip-record"],
    ["a gzip record with a numeric payload", { ...gzipRecord(packet), contentBase64: 7 }, "invalid-gzip-record"],
    ["non-canonical base64", { ...gzipRecord(packet), contentBase64: `${gzipRecord(packet).contentBase64}\n` }, "noncanonical-base64"],
  ])("refuses %s", (_name, raw, kind) => {
    expect(refusalKind(raw)).toBe(kind);
  });

  it("holds byteLength and the encoded payload to the caller's bounds", () => {
    expect(refusalKind(referenceRecord(packet), { expandedBytes: packet.byteLength - 1, encodedBytes: 1024 })).toBe("invalid-reference");
    expect(refusalKind(gzipRecord(packet), { expandedBytes: packet.byteLength - 1, encodedBytes: 1024 })).toBe("invalid-gzip-record");
    const record = gzipRecord(packet);
    expect(refusalKind(record, { expandedBytes: 1024, encodedBytes: record.contentBase64.length - 1 })).toBe("invalid-gzip-record");
    expect(parsed(record, { expandedBytes: packet.byteLength, encodedBytes: record.contentBase64.length }).byteLength).toBe(packet.byteLength);
  });

  it("refuses expansion past the declared length with the decoder's own error", () => {
    const record = parsed({ ...gzipRecord(packet), byteLength: packet.byteLength - 1 });
    if (record.encoding !== "gzip-base64") throw Error("expected gzip");
    const expanded = expandGzipPredecessorArchive(record);
    expect(expanded.ok).toBe(false);
    if (!expanded.ok && expanded.error.kind === "expansion-failed") expect(expanded.error.cause).toBeInstanceOf(RangeError);
    else throw Error("expected an expansion failure");
  });

  it("refuses a corrupt gzip stream as an expansion failure", () => {
    const record = parsed({ ...gzipRecord(packet), contentBase64: Buffer.from("not gzip").toString("base64") });
    if (record.encoding !== "gzip-base64") throw Error("expected gzip");
    const expanded = expandGzipPredecessorArchive(record);
    expect(!expanded.ok && expanded.error.kind).toBe("expansion-failed");
  });

  it("returns frozen records", () => {
    expect(Object.isFrozen(parsed(referenceRecord(packet)))).toBe(true);
    expect(Object.isFrozen(publishedPacketReference(packet, "/a", "v1-v2"))).toBe(true);
  });
});

describe("predecessor archive codec: writer-side frozen admission", () => {
  const path = "/runs/source/contexts/a.json";
  const expected = publishedPacketReference(packet, path, "v1-v2");
  const admit = (frozen: unknown, bytes = packet) => admitFrozenPredecessorArchive(frozen, bytes, expected, 4_194_304);

  it("admits the exact frozen reference and an exact earlier gzip archive", () => {
    expect(admit(JSON.parse(serializePublishedPacketReference(expected)))).toMatchObject({ ok: true, value: expected });
    expect(admit(gzipRecord(packet))).toMatchObject({ ok: true, value: { encoding: "gzip-base64" } });
  });

  it.each([
    ["a non-object", [], "invalid frozen predecessor archive"],
    ["a reference to another file", referenceRecord(packet, "/runs/other.json"), "predecessor reference differs from independently authenticated exact packet"],
    ["a reference with another purpose", referenceRecord(packet, path, "standalone-successor"), "predecessor reference differs from independently authenticated exact packet"],
    ["a reference with an extra key", { ...referenceRecord(packet, path), extra: true }, "predecessor reference differs from independently authenticated exact packet"],
    ["a reference with another digest", { ...referenceRecord(packet, path), digest: "0".repeat(64) }, "predecessor reference differs from independently authenticated exact packet"],
    ["a gzip archive of other bytes", gzipRecord(bytesOf("other")), "predecessor archive identity differs from authenticated bytes"],
    ["an unknown encoding", { ...gzipRecord(packet), encoding: "brotli" }, "predecessor archive identity differs from authenticated bytes"],
    ["a gzip archive whose content differs", { ...gzipRecord(packet), contentBase64: gzipSync(bytesOf("x".repeat(packet.byteLength))).toString("base64") },
      "predecessor archive does not retain exact authenticated Context Packet bytes"],
    ["non-canonical base64", { ...gzipRecord(packet), contentBase64: `${gzipRecord(packet).contentBase64}\n` },
      "predecessor archive does not retain exact authenticated Context Packet bytes"],
  ])("refuses %s", (_name, frozen, message) => {
    expect(admit(frozen)).toEqual({ ok: false, error: message });
  });
});

describe("predecessor archive selection arguments", () => {
  const regular = ["--packet", "/p.json", "--request", "request:a"];

  it("passes regular arguments through when no archive is selected", () => {
    expect(parsePredecessorArchiveArguments(regular)).toEqual({ ok: true, value: { regular, selection: { kind: "none" } } });
  });

  it("pairs --archive with an explicit purpose in either order", () => {
    for (const args of [[...regular, "--archive", "predecessor-context:code-reviewer", "--archive-purpose", "v1-v2"],
      ["--archive-purpose", "v1-v2", ...regular, "--archive", "predecessor-context:code-reviewer"]]) {
      expect(parsePredecessorArchiveArguments(args)).toEqual({ ok: true, value: { regular,
        selection: { kind: "archive", label: "predecessor-context:code-reviewer", purpose: "v1-v2" } } });
    }
  });

  it.each([
    ["a dangling value", [...regular, "--archive"], "missing reader argument"],
    ["a duplicate archive", [...regular, "--archive", "a", "--archive", "b", "--archive-purpose", "v1-v2"], "duplicate archive selection"],
    ["a duplicate purpose", [...regular, "--archive", "a", "--archive-purpose", "v1-v2", "--archive-purpose", "v1-v2"], "duplicate archive selection"],
    ["an unpaired archive", [...regular, "--archive", "a"], "archive requires exact label and explicit --archive-purpose v1-v2 or standalone-successor"],
    ["an unpaired purpose", [...regular, "--archive-purpose", "v1-v2"], "archive requires exact label and explicit --archive-purpose v1-v2 or standalone-successor"],
    ["an unsupported purpose", [...regular, "--archive", "a", "--archive-purpose", "v3"], "archive requires exact label and explicit --archive-purpose v1-v2 or standalone-successor"],
  ])("refuses %s", (_name, args, error) => {
    expect(parsePredecessorArchiveArguments(args)).toEqual({ ok: false, error });
  });
});

describe("projectArchivedPredecessor: the reader's whole --archive path", () => {
  const ROLE = "code-reviewer";
  const LABEL = `predecessor-context:${ROLE}`;
  const PREDECESSOR_PATH = "/runs/prior/contexts/predecessor.json";
  const requestId = (name: string) => value(parseRequestId(`request:${name}`));
  const section = (label: string, text: string) => value(encodeByteSection(label, text));
  /** A packet as the reader sees it: its stored JSON record, never the in-memory sealed object. */
  const stored = (packet: unknown): unknown => JSON.parse(JSON.stringify(packet));

  const predecessor = value(buildReviewerContextPacket({ requestId: requestId("prior"), role: ROLE, requiredSkill: "review",
    fixedContext: [], variableContext: [section("prior-notes", "the predecessor's retained notes")] }));
  const predecessorBytes = bytesOf(JSON.stringify(predecessor));
  const reference = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...referenceRecord(predecessorBytes, PREDECESSOR_PATH), ...overrides });
  const gzipArchive = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...gzipRecord(predecessorBytes), ...overrides });

  type BlobStore = ReadonlyMap<string, Uint8Array | "unreadable">;
  /** The plain in-memory published-packet port: exact file bytes by path and a
   *  section-blob store, recording each lookup. It can hand over bytes only. */
  const resolverOf = (files: ReadonlyMap<string, Uint8Array>, blobs: BlobStore = new Map()) => {
    const lookups: PublishedPacketReference[] = [];
    const readSectionBlob: PublishedPacketFile["readSectionBlob"] = (digest) => {
      const blob = blobs.get(digest);
      return blob === "unreadable" ? { ok: false, error: `blob ${digest} is unreadable` } : { ok: true, value: blob ?? null };
    };
    const resolveReference: ResolvePublishedPacket = (ref) => {
      lookups.push(ref);
      const fileBytes = files.get(ref.path);
      return fileBytes === undefined
        ? { ok: false, error: `context packet ${ref.path} is unreadable` }
        : { ok: true, value: { fileBytes, readSectionBlob } };
    };
    return { lookups, resolveReference };
  };

  /** One successor v3 packet retaining `retained` (raw section text) under LABEL, plus its exact reader input. */
  function successor(retained: string) {
    const packet = value(buildStandaloneReviewerContextPacketV3({ requestId: requestId("successor"), role: ROLE,
      requiredSkill: "review", fixedContext: [], variableContext: [section(LABEL, retained)] }));
    const input: ContextProjectionInput = { path: "/runs/successor/contexts/successor.json", requestId: packet.requestId,
      digest: packet.digest, role: ROLE, requiredSkill: "review", selection: { kind: "index", offset: 0, limit: 32 },
      purpose: "standalone-successor" };
    return { outer: stored(packet), input };
  }

  type ReadOptions = Readonly<{ purpose?: "v1-v2" | "standalone-successor"; label?: string;
    files?: ReadonlyMap<string, Uint8Array>; blobs?: BlobStore; input?: Partial<ContextProjectionInput> }>;
  const read = (retained: string, options: ReadOptions = {}) => {
    const { outer, input } = successor(retained);
    const resolver = resolverOf(options.files ?? new Map([[PREDECESSOR_PATH, predecessorBytes]]), options.blobs);
    const result = projectArchivedPredecessor(outer, { ...input, ...options.input },
      { kind: "archive", label: options.label ?? LABEL, purpose: options.purpose ?? "v1-v2" },
      { bounds: BOUNDS, resolveReference: resolver.resolveReference });
    return { result, lookups: resolver.lookups };
  };
  const refusedWith = (outcome: ReturnType<typeof read>): ArchivedPredecessorRefusal => refusal(outcome.result);

  it.each([["a published packet reference", reference()], ["an earlier inline gzip archive", gzipArchive()]])(
    "expands %s to the predecessor packet's own projection under its retained identity", (_name, retained) => {
      expect(value(read(retained).result)).toMatchObject({ schemaVersion: 2, requestId: predecessor.requestId,
        digest: predecessor.digest, role: ROLE, requiredSkill: "review", sections: expect.arrayContaining([expect.objectContaining({ label: "prior-notes" })]) });
    });

  it("resolves a reference through the port exactly once, with the parsed reference itself", () => {
    const outcome = read(reference());
    expect(outcome.result.ok).toBe(true);
    expect(outcome.lookups).toEqual([referenceRecord(predecessorBytes, PREDECESSOR_PATH)]);
    expect(read(gzipArchive()).lookups).toEqual([]);
  });

  it("decodes a successor-purpose predecessor as a standalone successor packet, never guessing the decoder", () => {
    const prior = value(buildStandaloneReviewerContextPacketV3({ requestId: requestId("prior-successor"), role: ROLE,
      requiredSkill: "review", fixedContext: [], variableContext: [section("prior-notes", "notes")] }));
    const priorBytes = bytesOf(JSON.stringify(prior));
    const files = new Map([[PREDECESSOR_PATH, priorBytes]]);
    const asSuccessor = JSON.stringify(referenceRecord(priorBytes, PREDECESSOR_PATH, "standalone-successor"));
    expect(value(read(asSuccessor, { purpose: "standalone-successor", files }).result))
      .toMatchObject({ schemaVersion: 3, requestId: prior.requestId });
    // The same v3 bytes under the v1-v2 decode purpose are refused by the v1/v2 packet parser.
    expect(refusedWith(read(JSON.stringify(referenceRecord(priorBytes, PREDECESSOR_PATH)), { files })))
      .toMatchObject({ kind: "refused", message: expect.stringMatching(/^packet integrity or supported contract check failed/) });
  });

  it.each([
    ["an outer packet read without the successor purpose", reference(), { input: { purpose: undefined } }, "archive requires exact successor packet identity"],
    ["an outer packet that differs from the expected identity", reference(), { input: { digest: "0".repeat(64) } },
      "archive requires exact successor packet identity: packet differs from expected issued identity"],
    ["an absent label", reference(), { label: `${LABEL}:attempt-2` }, "archive label is absent"],
    ["a label outside the predecessor namespace", reference(), { label: "notes" }, "archive label is absent"],
    ["an unsupported encoding", reference({ encoding: "zstd" }), {}, "unsupported predecessor encoding"],
    ["a relative reference path", reference({ path: "predecessor.json" }), {}, "invalid explicit predecessor reference"],
    ["a purpose that differs from the selection", reference({ purpose: "standalone-successor" }), {}, "invalid explicit predecessor reference"],
    ["a byteLength past the expansion bound", reference({ byteLength: 16_777_217 }), {}, "invalid explicit predecessor reference"],
    ["a reference whose digest differs", reference({ digest: "0".repeat(64) }), {}, "archive bytes differ"],
    ["a reference whose length differs", reference({ byteLength: predecessorBytes.byteLength - 1 }), {}, "archive bytes differ"],
    ["a reference whose file the port cannot read", reference(), { files: new Map() }, `context packet ${PREDECESSOR_PATH} is unreadable`],
    ["a gzip archive whose digest differs", gzipArchive({ digest: "0".repeat(64) }), {}, "archive bytes differ"],
    ["non-canonical base64", gzipArchive({ contentBase64: `${gzipRecord(predecessorBytes).contentBase64}\n` }), {}, "invalid archive encoding"],
    ["a retained record that is not an object", "[]", {}, "retained predecessor archive is not a JSON object"],
  ] satisfies readonly (readonly [string, string, ReadOptions, string])[])("refuses %s", (_name, retained, options, message) => {
    expect(refusedWith(read(retained, options))).toEqual({ kind: "refused", message });
  });

  it.each([
    ["a retained record that is not JSON", "not json", SyntaxError],
    ["a gzip archive declaring fewer bytes than it expands to", gzipArchive({ byteLength: predecessorBytes.byteLength - 1 }), RangeError],
    ["a gzip archive whose expansion is not JSON", JSON.stringify(gzipRecord(bytesOf("not json"))), SyntaxError],
  ])("refuses %s with the decoder's own error as the cause", (_name, retained, decoderError) => {
    const refused = refusedWith(read(retained));
    expect(refused.kind).toBe("decoder-failed");
    if (refused.kind === "decoder-failed") expect(refused.cause).toBeInstanceOf(decoderError);
  });

  it("refuses a verified predecessor that lacks its retained identity, naming the first missing field", () => {
    const anonymous = bytesOf(JSON.stringify({ requestId: "request:prior", digest: "d" }));
    expect(refusedWith(read(JSON.stringify(referenceRecord(anonymous, PREDECESSOR_PATH)), { files: new Map([[PREDECESSOR_PATH, anonymous]]) })))
      .toEqual({ kind: "refused", message: "archived predecessor packet lacks a string role" });
  });

  it("refuses a verified predecessor whose bytes are not an issued packet of its retained identity", () => {
    const forged = bytesOf(JSON.stringify({ requestId: predecessor.requestId, digest: predecessor.digest, role: ROLE, requiredSkill: "review" }));
    expect(refusedWith(read(JSON.stringify(referenceRecord(forged, PREDECESSOR_PATH)), { files: new Map([[PREDECESSOR_PATH, forged]]) })))
      .toMatchObject({ kind: "refused", message: expect.stringMatching(/^packet integrity or supported contract check failed/) });
  });

  it("names the outer projection's own integrity refusal, distinct from a wrong purpose", () => {
    const { outer, input } = successor(reference());
    const tampered = { ...(outer as Record<string, unknown>), role: "silent-failure-hunter" };
    const result = projectArchivedPredecessor(tampered, input, { kind: "archive", label: LABEL, purpose: "v1-v2" },
      { bounds: BOUNDS, resolveReference: resolverOf(new Map()).resolveReference });
    expect(result).toMatchObject({ ok: false, error: { kind: "refused",
      message: expect.stringMatching(/^archive requires exact successor packet identity: packet integrity or supported contract check failed/) } });
  });

  describe("a predecessor stored with its sections in the run's blob store", () => {
    const stored = storedContextPacket(predecessor);
    const storedBytes = bytesOf(stored.text);
    const files = new Map([[PREDECESSOR_PATH, storedBytes]]);
    const blobs: BlobStore = new Map(stored.blobs.map(({ digest, bytes }) => [digest, bytes]));
    const retained = JSON.stringify(referenceRecord(storedBytes, PREDECESSOR_PATH));
    const sectionDigest = stored.blobs[0]!.digest;

    it("derives the record from the verified file bytes and restores its sections through the blob lookup", () => {
      expect(value(read(retained, { files, blobs }).result)).toMatchObject({ requestId: predecessor.requestId,
        digest: predecessor.digest, sections: expect.arrayContaining([expect.objectContaining({ label: "prior-notes" })]) });
    });

    it("refuses a fake that serves different bytes under a section's digest: the record cannot disagree with the bytes", () => {
      const lying: BlobStore = new Map([...blobs, [sectionDigest, bytesOf("bytes that are not the retained section")]]);
      expect(refusedWith(read(retained, { files, blobs: lying })))
        .toMatchObject({ kind: "refused", message: expect.stringMatching(/^packet integrity or supported contract check failed/) });
    });

    it.each([
      ["an absent blob", new Map(), `context section blob ${sectionDigest} is missing from the run's blob store`],
      ["an unreadable blob", new Map([[sectionDigest, "unreadable" as const]]), `blob ${sectionDigest} is unreadable`],
    ] satisfies readonly (readonly [string, BlobStore, string])[])("refuses %s with its own cause", (_name, store, message) => {
      expect(refusedWith(read(retained, { files, blobs: store }))).toEqual({ kind: "refused", message });
    });

    it("never reads a blob before the file bytes verify against the reference", () => {
      const reads: string[] = [];
      const resolveReference: ResolvePublishedPacket = () => ({ ok: true, value: { fileBytes: storedBytes,
        readSectionBlob: (digest) => { reads.push(digest); return { ok: true, value: null }; } } });
      const { outer, input } = successor(JSON.stringify({ ...referenceRecord(storedBytes, PREDECESSOR_PATH), digest: "0".repeat(64) }));
      const result = projectArchivedPredecessor(outer, input, { kind: "archive", label: LABEL, purpose: "v1-v2" },
        { bounds: BOUNDS, resolveReference });
      expect(result).toEqual({ ok: false, error: { kind: "refused", message: "archive bytes differ" } });
      expect(reads).toEqual([]);
    });
  });

  it("admits no port value that carries a decoded record beside the bytes", () => {
    const readSectionBlob: PublishedPacketFile["readSectionBlob"] = () => ({ ok: true, value: null });
    // @ts-expect-error the port returns bytes and a blob lookup only; a separately supplied record is not part of it
    const inconsistent: PublishedPacketFile = { fileBytes: predecessorBytes, readSectionBlob, record: { requestId: "request:forged" } };
    // Even smuggled past the type, a record is never read: the projection is the verified bytes' own packet.
    const outcome = read(reference(), {});
    const smuggled = projectArchivedPredecessor(successor(reference()).outer, successor(reference()).input,
      { kind: "archive", label: LABEL, purpose: "v1-v2" }, { bounds: BOUNDS, resolveReference: () => ({ ok: true, value: inconsistent }) });
    expect(value(smuggled)).toEqual(value(outcome.result));
    expect(value(smuggled)).toMatchObject({ requestId: predecessor.requestId });
  });
});
