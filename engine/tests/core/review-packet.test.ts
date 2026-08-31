import { describe, expect, expectTypeOf, it } from "vitest";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import {
  createReviewPacket,
  canonicalJson,
  parseJsonValue,
  parseReviewPacket,
  parseReviewPacketRecovery,
  serializeReviewPacket,
  sha256Bytes,
  sha256Hex,
  parseBaseSha,
  parseHeadSha,
  type BaseSha,
  type HeadSha,
  type IssuedReviewPacketRegistration,
  type PacketId,
  type ReviewPacketInput,
  type ReviewPath,
} from "../../src/core/review-packet";

const base = (hex: string): BaseSha => {
  const parsed = parseBaseSha(hex);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};
const head = (hex: string): HeadSha => {
  const parsed = parseHeadSha(hex);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};
const BASE_SHA = base("a".repeat(40));
const HEAD_SHA = head("b".repeat(40));
const bytes = (text: string): Uint8Array => Buffer.from(text, "utf-8");

function input(overrides: Partial<ReviewPacketInput> = {}): ReviewPacketInput {
  return {
    task: { id: "T1", description: "Implement packet", metadata: { wave: 2, enabled: true } },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    declaredPaths: ["engine/src/core/z.ts", "engine/src/core/a.ts"],
    modifiedPaths: ["engine/src/core/z.ts", "engine/src/core/a.ts"],
    artifacts: [
      { path: "engine/src/core/z.ts", diff: "+z\n", postimage: bytes("export const z = 1;\n") },
      { path: "engine/src/core/a.ts", diff: "+a\n", postimage: bytes("export const a = 1;\n") },
    ],
    planContext: { section: "Phase 3", goals: ["deterministic", "scoped"] },
    proofObligations: [{ kind: "tests", command: "vitest run" }, { kind: "artifacts" }],
    ...overrides,
  };
}

function expectError(result: ReturnType<typeof createReviewPacket>, text: RegExp): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.join("\n")).toMatch(text);
}

describe("Review Packet", () => {
  it("owns packet registration types without importing the outer schema aggregate", () => {
    const source = readFileSync(new URL("../../src/core/review-packet.ts", import.meta.url), "utf-8");

    expect(source).not.toMatch(/from ["']\.\.\/types["']/);
  });

  it("implements standard SHA-256 deterministically without ambient crypto", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("🧵 loom")).toHaveLength(64);
  });

  it("canonicalizes path, artifact, and object-key permutations to one packet id", () => {
    const first = createReviewPacket(input());
    const second = createReviewPacket(input({
      task: { metadata: { enabled: true, wave: 2 }, description: "Implement packet", id: "T1" },
      declaredPaths: ["engine/src/core/a.ts", "engine/src/core/z.ts"],
      modifiedPaths: ["engine/src/core/a.ts", "engine/src/core/z.ts"],
      artifacts: [...input().artifacts].reverse(),
      planContext: { goals: ["deterministic", "scoped"], section: "Phase 3" },
    }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.packetId).toBe(second.value.packetId);
    expect(first.value.declaredPaths).toEqual(["engine/src/core/a.ts", "engine/src/core/z.ts"]);
    expect(first.value.artifacts.map((artifact) => artifact.path)).toEqual([
      "engine/src/core/a.ts",
      "engine/src/core/z.ts",
    ]);
    expect(serializeReviewPacket(first.value)).toBe(serializeReviewPacket(second.value));
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.artifacts[0])).toBe(true);
  });

  it("preserves own __proto__ members at every JSON depth and in packet authority", () => {
    const raw = JSON.parse(
      '{"nested":{"value":1,"__proto__":{"deep":true}},"__proto__":{"root":true}}',
    ) as unknown;
    const parsed = parseJsonValue(raw, "authority");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return;

    expect(Object.prototype.hasOwnProperty.call(parsed.value, "__proto__")).toBe(true);
    const nested: unknown = Reflect.get(parsed.value, "nested");
    expect(nested !== null && typeof nested === "object" && !Array.isArray(nested) &&
      Object.prototype.hasOwnProperty.call(nested, "__proto__")).toBe(true);
    expect(canonicalJson(parsed.value)).toBe(
      '{"__proto__":{"root":true},"nested":{"__proto__":{"deep":true},"value":1}}',
    );

    const withPrototypeData = createReviewPacket(input({
      task: JSON.parse('{"id":"T1","__proto__":{"admin":true}}'),
    }));
    const withoutPrototypeData = createReviewPacket(input({ task: { id: "T1" } }));
    expect(withPrototypeData.ok).toBe(true);
    expect(withoutPrototypeData.ok).toBe(true);
    if (!withPrototypeData.ok || !withoutPrototypeData.ok) return;
    expect(withPrototypeData.value.packetId).not.toBe(withoutPrototypeData.value.packetId);
    expect(serializeReviewPacket(withPrototypeData.value)).toContain('"__proto__"');
  });

  it("keeps issued packet provenance in distinct branded domains", () => {
    expectTypeOf<IssuedReviewPacketRegistration["packet_id"]>().toEqualTypeOf<PacketId>();
    expectTypeOf<IssuedReviewPacketRegistration["base_sha"]>().toEqualTypeOf<BaseSha>();
    expectTypeOf<IssuedReviewPacketRegistration["head_sha"]>().toEqualTypeOf<HeadSha>();
  });

  it("returns parser-branded canonical paths in packets", () => {
    const created = createReviewPacket(input());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expectTypeOf(created.value.declaredPaths).toEqualTypeOf<readonly ReviewPath[]>();
    expectTypeOf(created.value.modifiedPaths).toEqualTypeOf<readonly ReviewPath[]>();
    expectTypeOf(created.value.artifacts[0]!.path).toEqualTypeOf<ReviewPath>();
  });

  it("changes packet identity for every review-relevant byte category", () => {
    const baseline = createReviewPacket(input());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const mutations: ReviewPacketInput[] = [
      input({ task: { ...input().task, description: "Changed" } }),
      input({ baseSha: base("c".repeat(40)) }),
      input({ headSha: head("d".repeat(40)) }),
      input({
        declaredPaths: [...input().declaredPaths, "README.md"],
        artifacts: [...input().artifacts, { path: "README.md", diff: "readme diff", postimage: bytes("readme") }],
      }),
      input({ artifacts: input().artifacts.map((artifact, index) => index === 0 ? { ...artifact, diff: `${artifact.diff}x` } : artifact) }),
      input({ artifacts: input().artifacts.map((artifact, index) => index === 0
        ? { ...artifact, postimage: artifact.postimage === null ? null : Buffer.concat([artifact.postimage, bytes("x")]) }
        : artifact) }),
      input({ planContext: { section: "changed" } }),
      input({ proofObligations: [{ kind: "different" }] }),
    ];
    for (const mutation of mutations) {
      const changed = createReviewPacket(mutation);
      expect(changed.ok).toBe(true);
      if (changed.ok) expect(changed.value.packetId).not.toBe(baseline.value.packetId);
    }
  });

  it.each([
    ["../secret", /traversal/],
    ["engine/../secret", /traversal/],
    ["/etc/passwd", /relative.*absolute/],
    ["C:\\secret", /relative.*absolute/],
    ["engine\\src\\x.ts", /POSIX/],
    ["engine//src/x.ts", /canonical/],
    ["./engine/src/x.ts", /canonical/],
    ["engine/src/bad\npath.ts", /single line/],
    ["engine/src/bad\0path.ts", /NUL/],
  ])("rejects unsafe or aliased path %s", (path, message) => {
    expectError(createReviewPacket(input({ declaredPaths: [path] })), message);
  });

  it("rejects duplicate paths, duplicate artifacts, empty scope, and missing artifact coverage", () => {
    expectError(createReviewPacket(input({ declaredPaths: ["a.ts", "a.ts"] })), /repeats path/);
    expectError(createReviewPacket(input({
      modifiedPaths: ["a.ts"],
      declaredPaths: ["a.ts"],
      artifacts: [
        { path: "a.ts", diff: "a", postimage: bytes("a") },
        { path: "a.ts", diff: "b", postimage: bytes("b") },
      ],
    })), /artifacts repeats path/);
    expectError(createReviewPacket(input({ declaredPaths: [], modifiedPaths: [], artifacts: [] })), /scope must be non-empty/);
    expectError(createReviewPacket(input({ modifiedPaths: ["a.ts"], declaredPaths: ["a.ts"], artifacts: [] })), /has no artifact/);
    expectError(createReviewPacket(input({
      modifiedPaths: ["a.ts"],
      declaredPaths: ["a.ts"],
      artifacts: [{ path: "outside.ts", diff: "x", postimage: bytes("x") }],
    })), /outside the.*scope/);
  });

  it("parses and verifies unknown JSON and has fixed-point serialization", () => {
    const created = createReviewPacket(input());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const serialized = serializeReviewPacket(created.value);
    const parsed = parseReviewPacket(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeReviewPacket(parsed.value)).toBe(serialized);
  });

  it("round-trips arbitrary postimage bytes without replacement-character loss", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 1024 }), (postimage) => {
      const created = createReviewPacket(input({
        declaredPaths: ["asset.bin"],
        modifiedPaths: ["asset.bin"],
        artifacts: [{ path: "asset.bin", diff: "binary diff", postimage }],
      }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const encoded = created.value.artifacts[0]!.postimage;
      expect(encoded).not.toBeNull();
      if (encoded === null) return;
      const decoded = Buffer.from(encoded.content, encoded.encoding === "utf8" ? "utf-8" : "base64");
      expect(decoded).toEqual(Buffer.from(postimage));
      expect(encoded.sha256).toBe(sha256Bytes(postimage));
      expect(parseReviewPacket(serializeReviewPacket(created.value)).ok).toBe(true);
    }));
  });

  it("uses base64 and hashes original bytes for a PNG-like binary postimage", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);
    const created = createReviewPacket(input({
      declaredPaths: ["icon.png"], modifiedPaths: ["icon.png"],
      artifacts: [{ path: "icon.png", diff: "binary", postimage: png }],
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const postimage = created.value.artifacts[0]!.postimage;
    expect(postimage).toEqual({
      encoding: "base64",
      content: png.toString("base64"),
      sha256: sha256Bytes(png),
    });
    expect(postimage?.content).not.toContain("�");
  });

  it("verifies legacy v1 packet metadata only at the explicit recovery boundary", () => {
    const diff = { content: "+legacy\n", sha256: sha256Hex("+legacy\n") };
    const postimage = { content: "legacy text\n", sha256: sha256Hex("legacy text\n") };
    const body = {
      schemaVersion: 1,
      task: { id: "T1", description: "legacy" },
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      declaredPaths: ["legacy.ts"],
      modifiedPaths: ["legacy.ts"],
      artifacts: [{ path: "legacy.ts", diff, postimage }],
      planContext: "",
      proofObligations: [],
    };
    const raw = { ...body, packetId: sha256Hex(canonicalJson(body)) };

    expect(parseReviewPacket(raw).ok).toBe(false);
    const recovered = parseReviewPacketRecovery(raw);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value).toMatchObject({
        schemaVersion: 1,
        taskId: "T1",
        modifiedPaths: ["legacy.ts"],
        artifacts: [{ path: "legacy.ts", postimageSha256: postimage.sha256 }],
      });
    }

    const tampered = structuredClone(raw);
    tampered.modifiedPaths = ["invented.ts"];
    expect(parseReviewPacketRecovery(tampered).ok).toBe(false);
  });

  it("rejects malformed JSON, artifact tampering, hash tampering, and packet-id tampering", () => {
    expect(parseReviewPacket("{").ok).toBe(false);
    const created = createReviewPacket(input());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    type SerializedArtifact = {
      diff: { content: string; sha256: string };
      postimage: { encoding: "utf8" | "base64"; content: string; sha256: string } | null;
    };
    type SerializedPacket = Record<string, unknown> & { artifacts: SerializedArtifact[]; packetId: string };
    const raw = JSON.parse(serializeReviewPacket(created.value)) as SerializedPacket;

    const legacySchema = structuredClone(raw);
    legacySchema.schemaVersion = 1;
    const legacyResult = parseReviewPacket(legacySchema);
    expect(legacyResult.ok).toBe(false);
    if (!legacyResult.ok) expect(legacyResult.errors.join("\n")).toMatch(/schemaVersion must equal 2/);

    const contentTampered = structuredClone(raw);
    contentTampered.artifacts[0]!.diff.content += "tampered";
    const contentResult = parseReviewPacket(contentTampered);
    expect(contentResult.ok).toBe(false);
    if (!contentResult.ok) expect(contentResult.errors.join("\n")).toMatch(/does not match/);

    const digestTampered = structuredClone(raw);
    if (digestTampered.artifacts[0]!.postimage === null) throw new Error("fixture postimage missing");
    digestTampered.artifacts[0]!.postimage.sha256 = "0".repeat(64);
    expect(parseReviewPacket(digestTampered).ok).toBe(false);

    const encodingTampered = structuredClone(raw);
    if (encodingTampered.artifacts[0]!.postimage === null) throw new Error("fixture postimage missing");
    encodingTampered.artifacts[0]!.postimage.encoding = "base64";
    expect(parseReviewPacket(encodingTampered).ok).toBe(false);

    const malformedBase64 = structuredClone(raw);
    if (malformedBase64.artifacts[0]!.postimage === null) throw new Error("fixture postimage missing");
    malformedBase64.artifacts[0]!.postimage.encoding = "base64";
    malformedBase64.artifacts[0]!.postimage.content = "not base64!";
    expect(parseReviewPacket(malformedBase64).ok).toBe(false);

    const idTampered = structuredClone(raw);
    idTampered.packetId = "0".repeat(64);
    const idResult = parseReviewPacket(idTampered);
    expect(idResult.ok).toBe(false);
    if (!idResult.ok) expect(idResult.errors.join("\n")).toMatch(/packetId does not match/);
  });
});
