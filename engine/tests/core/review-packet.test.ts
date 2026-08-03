import { describe, expect, it } from "vitest";
import {
  createReviewPacket,
  parseReviewPacket,
  serializeReviewPacket,
  sha256Hex,
  type ReviewPacketInput,
} from "../../src/core/review-packet";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function input(overrides: Partial<ReviewPacketInput> = {}): ReviewPacketInput {
  return {
    task: { id: "T1", description: "Implement packet", metadata: { wave: 2, enabled: true } },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    declaredPaths: ["engine/src/core/z.ts", "engine/src/core/a.ts"],
    modifiedPaths: ["engine/src/core/z.ts", "engine/src/core/a.ts"],
    artifacts: [
      { path: "engine/src/core/z.ts", diff: "+z\n", postimage: "export const z = 1;\n" },
      { path: "engine/src/core/a.ts", diff: "+a\n", postimage: "export const a = 1;\n" },
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

  it("changes packet identity for every review-relevant byte category", () => {
    const baseline = createReviewPacket(input());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const mutations: ReviewPacketInput[] = [
      input({ task: { ...input().task, description: "Changed" } }),
      input({ baseSha: "c".repeat(40) }),
      input({ headSha: "d".repeat(40) }),
      input({
        declaredPaths: [...input().declaredPaths, "README.md"],
        artifacts: [...input().artifacts, { path: "README.md", diff: "readme diff", postimage: "readme" }],
      }),
      input({ artifacts: input().artifacts.map((artifact, index) => index === 0 ? { ...artifact, diff: `${artifact.diff}x` } : artifact) }),
      input({ artifacts: input().artifacts.map((artifact, index) => index === 0 ? { ...artifact, postimage: `${artifact.postimage}x` } : artifact) }),
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
  ])("rejects unsafe or aliased path %s", (path, message) => {
    expectError(createReviewPacket(input({ declaredPaths: [path] })), message);
  });

  it("rejects duplicate paths, duplicate artifacts, empty scope, and missing artifact coverage", () => {
    expectError(createReviewPacket(input({ declaredPaths: ["a.ts", "a.ts"] })), /repeats path/);
    expectError(createReviewPacket(input({
      modifiedPaths: ["a.ts"],
      declaredPaths: ["a.ts"],
      artifacts: [
        { path: "a.ts", diff: "a", postimage: "a" },
        { path: "a.ts", diff: "b", postimage: "b" },
      ],
    })), /artifacts repeats path/);
    expectError(createReviewPacket(input({ declaredPaths: [], modifiedPaths: [], artifacts: [] })), /scope must be non-empty/);
    expectError(createReviewPacket(input({ modifiedPaths: ["a.ts"], declaredPaths: ["a.ts"], artifacts: [] })), /has no artifact/);
    expectError(createReviewPacket(input({
      modifiedPaths: ["a.ts"],
      declaredPaths: ["a.ts"],
      artifacts: [{ path: "outside.ts", diff: "x", postimage: "x" }],
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

  it("rejects malformed JSON, artifact tampering, hash tampering, and packet-id tampering", () => {
    expect(parseReviewPacket("{").ok).toBe(false);
    const created = createReviewPacket(input());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    type SerializedArtifact = {
      diff: { content: string; sha256: string };
      postimage: { content: string; sha256: string } | null;
    };
    type SerializedPacket = Record<string, unknown> & { artifacts: SerializedArtifact[]; packetId: string };
    const raw = JSON.parse(serializeReviewPacket(created.value)) as SerializedPacket;

    const contentTampered = structuredClone(raw);
    contentTampered.artifacts[0]!.diff.content += "tampered";
    const contentResult = parseReviewPacket(contentTampered);
    expect(contentResult.ok).toBe(false);
    if (!contentResult.ok) expect(contentResult.errors.join("\n")).toMatch(/does not match/);

    const digestTampered = structuredClone(raw);
    if (digestTampered.artifacts[0]!.postimage === null) throw new Error("fixture postimage missing");
    digestTampered.artifacts[0]!.postimage.sha256 = "0".repeat(64);
    expect(parseReviewPacket(digestTampered).ok).toBe(false);

    const idTampered = structuredClone(raw);
    idTampered.packetId = "0".repeat(64);
    const idResult = parseReviewPacket(idTampered);
    expect(idResult.ok).toBe(false);
    if (!idResult.ok) expect(idResult.errors.join("\n")).toMatch(/packetId does not match/);
  });
});
