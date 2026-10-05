import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import { parseContextPacket } from "../../src/core/context-packets";
import {
  canonicalStructuralEquals,
  createPublicationAuthorityResolver,
  parseBatchPublishedReceipt,
  parseIssuedSpawnRequest,
  sameAgentRequestAuthority,
  parseEffectReceipt,
  type PublicationAuthorityResolver,
} from "../../src/core/orchestration-contract";
import { admitStandaloneTranscript } from "../../src/core/standalone-transcript-admission";
import { canonicalStandaloneResultArtifact, serializeAdjudicatedStandaloneReview, serializeStandaloneReviewAuthority } from "../../src/core/standalone-review-records";
import { capturedReviewerResultFromBytes } from "../../src/core/standalone-reviewer-capture";
import { type FrozenStandaloneReviewAuthority } from "../../src/core/standalone-review-model";
import {
  isAuthoritativeStandaloneReviewResult,
  parseAuthoritativeStandaloneReviewResult,
  reduceStandaloneReviewMachine,
  startStandaloneReviewMachine,
} from "../../src/core/standalone-review-machine";
import { parseStandaloneReviewMachineState, serializeStandaloneReviewMachineState } from "../../src/core/standalone-review-checkpoint";
import { aggregateLegacyStandaloneReview } from "../../src/core/legacy-archive";
import { parseIssuedReviewerProtocol, resolveReviewFindings, type IssuedStandaloneReviewerProtocol, type ReviewerProtocolAuthorityResolver } from "../../src/core/review-output";
import { parseRegistration, parsedAuthority } from "../../src/handlers/helpers/programs/registration";
import { loadReviewerV1Golden, type ReviewerV1Golden } from "../fixtures/reviewer-protocol-v1";
import inventory from "../fixtures/reviewer-protocol-v1/inventory.json";
import storage from "../fixtures/reviewer-protocol-v1/storage.json";
import { decodeReviewerV1Pack, parseReviewerV1Pack } from "../fixtures/reviewer-protocol-v1/pack";
import archive from "../../../references/reviewer-protocol-v1/inventory.json";

// Packing/replay cases are synchronous CPU work; allow task-update RPCs between cases.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

const names = ["pr48-clean", "seven-reviewers-retry"] as const;
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const record = z.record(z.string(), z.unknown());
const text = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function required<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

function bytesAt(files: ReviewerV1Golden["files"], path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`Missing golden artifact: ${path}`);
  return bytes;
}

function jsonAt(files: ReviewerV1Golden["files"], path: string): unknown {
  return JSON.parse(text(bytesAt(files, path)));
}

function registeredAuthority(files: ReviewerV1Golden["files"]): FrozenStandaloneReviewAuthority {
  return required(parsedAuthority(required(parseRegistration(jsonAt(files, "program.json")))));
}

/** Existing persistence port, backed only by independently captured publications. */
function publications(files: ReviewerV1Golden["files"]): PublicationAuthorityResolver {
  return createPublicationAuthorityResolver(({ effectId }) => {
    const path = `artifacts/publications/${sha256(effectId)}.json`;
    const bytes = files.get(path);
    return bytes === undefined
      ? { ok: false, error: { kind: "publication-authority-unavailable", message: `Missing ${path}` } }
      : { ok: true, value: [...bytes] };
  });
}

/**
 * Baseline LC-2 has no independent context port. Join real packets/reservations
 * at the test adapter, not by minting a new authority. B2 can replace this join
 * with its required reviewerProtocols input without changing loadReviewerV1Golden.
 */
function contextualPublications(files: ReviewerV1Golden["files"]): PublicationAuthorityResolver {
  const resolvePublication = publications(files);
  const authority = registeredAuthority(files);
  const checked = new Set<string>();
  return (identity) => {
    const published = resolvePublication(identity);
    if (!published.ok || checked.has(identity.publicationDigest)) return published;
    for (const request of published.value.receipt.issuedRequests) {
      const raw = files.get(request.context.slot.path);
      const packet = parseContextPacket(raw === undefined ? null : JSON.parse(text(raw)));
      if (!packet.ok) return { ok: false, error: {
        kind: "publication-authority-unavailable", message: packet.error.message,
      } };
      const reservation = jsonAt(files, `requests/${request.authority.requestId}.json`);
      if (packet.value.digest !== request.authority.contextDigest ||
          packet.value.requestId !== request.authority.requestId ||
          packet.value.role !== request.authority.role ||
          packet.value.requiredSkill !== (request.authority.requiredSkill ?? "none") ||
          !canonicalStructuralEquals(reservation, request.authority)) {
        return { ok: false, error: { kind: "publication-authority-unavailable", message: "Historical request/context mismatch" } };
      }
      if (request.authority.program === "standalone-review") {
        const section = packet.value.fixedContext.find(({ label }) => label === "standalone-review-authority");
        const subject: unknown = section === undefined ? null : JSON.parse(text(Uint8Array.from(section.bytes)));
        if (!canonicalStructuralEquals(subject, {
          runId: authority.runId, scope: authority.scope, role: request.authority.role, attempt: request.authority.attempt,
        })) return { ok: false, error: { kind: "publication-authority-unavailable", message: "Historical subject mismatch" } };
      }
    }
    checked.add(identity.publicationDigest);
    return published;
  };
}

function protocols(files: ReviewerV1Golden["files"]): ReviewerProtocolAuthorityResolver {
  const registration = required(parseRegistration(jsonAt(files, "program.json")));
  const authority = required(parsedAuthority(registration));
  if (registration.schemaVersion !== 1) throw new Error("historical registration must remain v1");
  const resolvePublication = contextualPublications(files);
  return (request) => {
    try {
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
    } catch {
      return { ok: false, error: { kind: "reviewer-protocol-failed", code: "authority-unavailable", path: "/golden-publications", message: "original publication/context invalid" } };
    }
    return { ok: false, error: { kind: "reviewer-protocol-failed", code: "authority-unavailable", path: "/golden-publications", message: "original publication missing" } };
  };
}

function historicalProtocol(files: ReviewerV1Golden["files"], request: FrozenStandaloneReviewAuthority["roster"]["orderedSlots"][number]["attempts"][number]): IssuedStandaloneReviewerProtocol {
  const protocol = required(protocols(files)(request));
  if (protocol.subject.kind !== "standalone-review") throw new Error("standalone history required");
  return protocol as IssuedStandaloneReviewerProtocol;
}

function replay(files: ReviewerV1Golden["files"], raw: unknown = jsonAt(files, "checkpoint.json")) {
  return parseStandaloneReviewMachineState(raw, contextualPublications(files), protocols(files), registeredAuthority(files));
}

function ready(files: ReviewerV1Golden["files"]) {
  // An in-memory replay projection, NOT a historical checkpoint rewrite.
  const state = required(replay(files, { ...record.parse(jsonAt(files, "checkpoint.json")), kind: "ready-to-finalize" }));
  if (state.kind !== "ready-to-finalize") throw new Error(`Expected ready, received ${state.kind}`);
  return state;
}

/** Mutation controls always own new arrays, including unchanged sibling files. */
function copyFiles(files: ReviewerV1Golden["files"]): Map<string, Uint8Array> {
  return new Map([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
}

function replaceJson(files: ReviewerV1Golden["files"], path: string, value: unknown): ReadonlyMap<string, Uint8Array> {
  const copy = copyFiles(files);
  copy.set(path, new TextEncoder().encode(JSON.stringify(value)));
  return copy;
}

function diskPaths(root: URL, prefix = ""): readonly string[] {
  return readdirSync(new URL(prefix, root), { withFileTypes: true }).flatMap((entry) => {
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.isDirectory() || entry.isFile()).toBe(true);
    return entry.isDirectory() ? diskPaths(root, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`];
  }).sort();
}

describe("bounded lossless historical fixture storage", () => {
  it("keeps the original logical inventory and only two binary packs, with no raw duplication or symlinks", () => {
    const root = new URL("../fixtures/reviewer-protocol-v1/", import.meta.url);
    expect(diskPaths(root)).toEqual([
      "README.md", "illustrative/malformed-block.raw", "illustrative/normalization-and-duplicates.raw",
      "illustrative/shortfall.raw", "index.ts", "inventory.json", "pack.ts", "pr48-clean.json.gz",
      "seven-reviewers-retry.json.gz", "storage.json",
    ]);
    expect(sha256(readFileSync(new URL("inventory.json", root))))
      .toBe("fb483ed8ae1480a97c0856bff2c90bb7806c94d7e91c798e3bf4689d699cf234");
    expect(inventory.goldens.reduce((sum, entry) => sum + entry.fileCount, 0)).toBe(90);
    expect(inventory.goldens.reduce((sum, entry) => sum + entry.totalByteLength, 0)).toBe(20_250_407);
    expect(storage.format).toBe("gzip-json-path-base64bytes-v1");
    expect(Object.keys(storage.goldens)).toEqual([...names]);
  });

  for (const name of names) describe(name, () => {
    const packed = () => readFileSync(new URL(`../fixtures/reviewer-protocol-v1/${name}.json.gz`, import.meta.url));
    const entries = () => [...loadReviewerV1Golden(name).files].map(([path, bytes]) =>
      ({ path, base64bytes: Buffer.from(bytes).toString("base64") }));
    const canonical = () => Buffer.from(JSON.stringify(entries()));

    it("encodes deterministically twice, including gzip metadata", () => {
      const raw = canonical();
      const first = gzipSync(raw, { level: 9 });
      const second = gzipSync(raw, { level: 9 });
      expect(first.equals(second)).toBe(true);
      const stored = packed();
      // Storage bytes are pinned; valid deflate encodings are not unique across runtimes.
      expect(stored.length).toBe(storage.goldens[name].compressedByteLength);
      expect(sha256(stored)).toBe(storage.goldens[name].sha256);
      expect(first.readUInt32LE(4)).toBe(0); // gzip MTIME, not wall-clock time
      expect(stored.readUInt32LE(4)).toBe(0);
      expect(first.subarray(0, 4).equals(Buffer.from([0x1f, 0x8b, 8, 0]))).toBe(true);
      expect(stored.subarray(0, 4).equals(Buffer.from([0x1f, 0x8b, 8, 0]))).toBe(true);
      expect(raw.length).toBe(storage.goldens[name].decompressedByteLength);
      expect(gunzipSync(stored, { maxOutputLength: raw.length }).equals(raw)).toBe(true);
      expect(gunzipSync(first, { maxOutputLength: raw.length }).equals(raw)).toBe(true);
    });

    it("decodes an alternative valid deflate encoding without accepting it as the pinned stored pack", () => {
      const raw = canonical();
      const alternative = gzipSync(raw, { level: 0 });
      expect(alternative.equals(packed())).toBe(false);
      const inflated = gunzipSync(alternative, { maxOutputLength: raw.length });
      expect(inflated.equals(raw)).toBe(true);
      const decoded = required(parseReviewerV1Pack(name, inflated));
      const stored = required(decodeReviewerV1Pack(name, packed()));
      expect([...decoded.keys()]).toEqual([...stored.keys()]);
      for (const entry of inventory.goldens.find((entry) => entry.name === name)!.files) {
        const bytes = bytesAt(decoded, entry.path);
        expect(Buffer.from(bytes).equals(Buffer.from(bytesAt(stored, entry.path)))).toBe(true);
        expect(bytes.length).toBe(entry.byteLength);
        expect(sha256(bytes)).toBe(entry.sha256);
      }
      // Portability belongs to inflation + canonical parsing, never a storage hash bypass.
      expect(alternative.length).toBeGreaterThan(storage.goldens[name].compressedByteLength);
      expect(decodeReviewerV1Pack(name, alternative)).toEqual({ ok: false, error: "compressed-size" });
      const tampered = Buffer.from(inflated);
      tampered[tampered.indexOf(Buffer.from('"base64bytes":"')) + '"base64bytes":"'.length] ^= 1;
      expect(parseReviewerV1Pack(name, tampered).ok).toBe(false);
    });

    it("round trips every exact logical byte into independent copies", () => {
      const decoded = required(decodeReviewerV1Pack(name, packed()));
      const fresh = required(parseReviewerV1Pack(name, canonical()));
      for (const entry of inventory.goldens.find((entry) => entry.name === name)!.files) {
        expect(sha256(bytesAt(decoded, entry.path))).toBe(entry.sha256);
        expect(bytesAt(decoded, entry.path).length).toBe(entry.byteLength);
        expect(bytesAt(decoded, entry.path) === bytesAt(fresh, entry.path)).toBe(false);
      }
      bytesAt(decoded, "result.json")[0] ^= 1;
      expect(sha256(bytesAt(loadReviewerV1Golden(name).files, "result.json")))
        .toBe(inventory.goldens.find((entry) => entry.name === name)!.resultDigest);
    });

    it("refuses oversized compressed input, bounded inflation overflow, malformed gzip and compressed hash mismatch", () => {
      expect(decodeReviewerV1Pack(name, Buffer.alloc(storage.goldens[name].compressedByteLength + 1)))
        .toEqual({ ok: false, error: "compressed-size" });
      const bomb = gzipSync(Buffer.alloc(storage.goldens[name].decompressedByteLength + 1));
      expect(bomb.length).toBeLessThan(storage.goldens[name].compressedByteLength);
      expect(decodeReviewerV1Pack(name, bomb)).toEqual({ ok: false, error: "gzip" });
      expect(decodeReviewerV1Pack(name, Buffer.from("not gzip"))).toEqual({ ok: false, error: "gzip" });
      const changed = Buffer.from(packed());
      changed[4] ^= 1; // valid gzip with different metadata
      expect(decodeReviewerV1Pack(name, changed)).toEqual({ ok: false, error: "compressed-hash" });
      expect(decodeReviewerV1Pack(name, packed().subarray(0, -1)).ok).toBe(false);
      expect(parseReviewerV1Pack(name, Buffer.alloc(storage.goldens[name].decompressedByteLength + 1)))
        .toEqual({ ok: false, error: "decompressed-size" });
    });

    it("refuses missing, extra, duplicate, transposed, traversal and malformed path entries without partial maps", () => {
      const original = entries();
      const first = original[0]!;
      const variants: readonly unknown[] = [
        {}, null, original.slice(1), [...original, first], [first, first, ...original.slice(2)],
        [original[1], first, ...original.slice(2)],
        [{ ...first, path: "../result.json" }, ...original.slice(1)],
        [{ ...first, path: 1 }, ...original.slice(1)],
        [{ ...first, extra: true }, ...original.slice(1)],
        [{ path: first.path }, ...original.slice(1)],
        [{ ...first, base64bytes: null }, ...original.slice(1)],
      ];
      for (const variant of variants) {
        const result = parseReviewerV1Pack(name, Buffer.from(JSON.stringify(variant)));
        expect(result.ok).toBe(false);
        expect("value" in result).toBe(false);
      }
    });

    it("refuses noncanonical JSON, duplicate/escaped keys, invalid UTF-8, base64 aliases and wrong byte counts", () => {
      const raw = canonical().toString();
      for (const changed of [" " + raw, raw + " ", "\ufeff" + raw, "{", raw.replace('"path":', '"path":"ignored","path":'),
        raw.replace('"path":', '"pa\\u0074h":'), raw.replace('"path":', '"pa\\u0074h":"ignored","path":')]) {
        expect(parseReviewerV1Pack(name, Buffer.from(changed)).ok).toBe(false);
      }
      expect(parseReviewerV1Pack(name, Buffer.from([0xff])).ok).toBe(false);
      const original = entries();
      const first = original[0]!;
      // Leave room below the size ceiling so these exercise canonical parsing, not just the bound.
      const shorter = JSON.stringify([{ ...first, base64bytes: first.base64bytes.slice(64) }, ...original.slice(1)]);
      for (const changed of [" " + shorter, shorter + " ",
        shorter.replace('"path":', '"path":"ignored","path":'),
        shorter.replace('"path":', '"pa\\u0074h":'),
        shorter.replace('"path":', '"pa\\u0074h":"ignored","path":')]) {
        expect(parseReviewerV1Pack(name, Buffer.from(changed))).toEqual({ ok: false, error: "noncanonical" });
      }
      const reversedKeys = [{ base64bytes: first.base64bytes, path: first.path }, ...original.slice(1)];
      expect(parseReviewerV1Pack(name, Buffer.from(JSON.stringify(reversedKeys))))
        .toEqual({ ok: false, error: "noncanonical" });
      for (const base64bytes of [first.base64bytes + "=", first.base64bytes.slice(1), "!" + first.base64bytes.slice(1),
        first.base64bytes.replace(/.{4}$/, "AAAA"), first.base64bytes.replace(/.{4}$/, " AA="), ""]) {
        expect(parseReviewerV1Pack(name, Buffer.from(JSON.stringify([{ ...first, base64bytes }, ...original.slice(1)]))).ok).toBe(false);
      }
    });

    it("rejects nonzero base64 pad-bit aliases even when decoded bytes match, and transposed artifact bytes", () => {
      const original = entries();
      const padded = original.find((entry) => entry.base64bytes.endsWith("="))!;
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const at = padded.base64bytes.indexOf("=") - 1;
      const alias = padded.base64bytes.slice(0, at) + alphabet[alphabet.indexOf(padded.base64bytes[at]!) + 1] + padded.base64bytes.slice(at + 1);
      expect(Buffer.from(alias, "base64").equals(Buffer.from(padded.base64bytes, "base64"))).toBe(true);
      const mutated = original.map((entry) => entry.path === padded.path ? { ...entry, base64bytes: alias } : entry);
      expect(parseReviewerV1Pack(name, Buffer.from(JSON.stringify(mutated)))).toEqual({ ok: false, error: "logical-bytes" });
      const transposed = original.map((entry, index) => ({ ...entry,
        base64bytes: index < 2 ? original[1 - index]!.base64bytes : entry.base64bytes }));
      expect(parseReviewerV1Pack(name, Buffer.from(JSON.stringify(transposed)))).toEqual({ ok: false, error: "logical-bytes" });
    });

    it.each(inventory.goldens.find((entry) => entry.name === name)!.files)(
      "rejects single-byte corruption in $path, never returning a partial map", ({ path }) => {
        const original = entries();
        const entry = original.find((entry) => entry.path === path)!;
        const changed = Buffer.from(entry.base64bytes, "base64");
        changed[0] ^= 1;
        const mutated = original.map((entry) => entry.path === path ? { ...entry, base64bytes: changed.toString("base64") } : entry);
        expect(parseReviewerV1Pack(name, Buffer.from(JSON.stringify(mutated))))
          .toEqual({ ok: false, error: "logical-bytes" });
      });

    it("rejects arbitrary compressed single-byte mutations without exposing a partial inventory", () => {
      const original = packed();
      fc.assert(fc.property(fc.integer({ min: 0, max: original.length - 1 }), fc.integer({ min: 1, max: 255 }), (offset, mask) => {
        const changed = Buffer.from(original);
        changed[offset] ^= mask;
        const result = decodeReviewerV1Pack(name, changed);
        expect(result.ok).toBe(false);
        expect("value" in result).toBe(false);
      }), { numRuns: 15, seed: 224007 });
    });
  });
});

describe("exact 224f0d7 reviewer-v1 archive", () => {
  it("pins the eight complete Git blobs, not retrospectively frozen historical personas", () => {
    expect(archive.baselineCommit).toBe("224f0d74373ddab619c1620738c5ba4fa6b44e0e");
    expect(archive.files.map(({ path }) => path)).toEqual([
      "agents/_shared/wire-contract.md", "agents/code-reviewer.md", "agents/silent-failure-hunter.md",
      "agents/pr-test-analyzer.md", "agents/type-design-analyzer.md", "agents/comment-analyzer.md",
      "agents/architecture-tech-lead.md", "agents/code-simplifier.md",
    ]);
    for (const entry of archive.files) {
      const bytes = readFileSync(new URL(`../../../references/reviewer-protocol-v1/${entry.path}`, import.meta.url));
      expect(bytes.length).toBe(entry.byteLength);
      expect(sha256(bytes)).toBe(entry.sha256);
      expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(entry.gitBlob);
    }
  });
});

for (const name of names) describe(`historical ${name}`, () => {
  const golden = loadReviewerV1Golden(name);
  const files = golden.files;
  const entry = inventory.goldens.find((candidate) => candidate.name === name)!;

  it("retains the complete inventory, original anchoring metadata, and independently copied bytes", () => {
    expect([...files.keys()]).toEqual(entry.files.map(({ path }) => path));
    expect(files.size).toBe(name === "pr48-clean" ? 31 : 59);
    expect([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)).toBe(entry.totalByteLength);
    const anchoring = record.parse(jsonAt(files, "authority.json"));
    const originalRoot = name === "pr48-clean"
      ? "/home/peterstorm/dev/claude-plugins/loom-verification-junit/.claude/reviews/review-and-fix-runs"
      : "/home/peterstorm/dev/claude-plugins/loom/.claude/reviews/standalone-review-runs";
    expect(anchoring.runsRoot).toBe(originalRoot);
    expect(anchoring.runDirectory).toBe(`${originalRoot}/${registeredAuthority(files).runId}`);
    const fresh = loadReviewerV1Golden(name);
    for (const file of entry.files) {
      expect(sha256(bytesAt(files, file.path))).toBe(file.sha256);
      expect(bytesAt(files, file.path).length).toBe(file.byteLength);
      // Compare identity as a scalar: Vitest's negated object matcher can
      // eagerly traverse/render megabyte byte arrays even on success.
      expect(fresh.files.get(file.path) === files.get(file.path)).toBe(false);
    }
    expect(golden.resultByteLength).toBe(name === "pr48-clean" ? 4485 : 16038);
    expect(golden.resultDigest).toBe(name === "pr48-clean"
      ? "22619aea74b057a82c361da6f0bb7f55c6f9f95d9a1bce515ceafa6e4069c58e"
      : "78213a071825e206547f8bbabd3b8c2ed8b2f396fad34c5c918c48d0eb83fbb2");
  });

  it("parses every frozen packet, including unissued attempt two and full source bytes", () => {
    const contexts = [...files].filter(([path]) => path.startsWith("contexts/"));
    expect(contexts).toHaveLength(name === "pr48-clean" ? 10 : 17);
    for (const [path, bytes] of contexts) {
      const packet = required(parseContextPacket(JSON.parse(text(bytes))));
      expect(path).toBe(`contexts/${packet.digest}.json`);
      expect(packet.schemaVersion).toBe(1);
      if (packet.role !== "review-verifier-agent") {
        expect(packet.fixedContext.map(({ label }) => label)).toContain("standalone-frozen-source");
      }
    }
  });

  it("replays the complete LC-2 checkpoint and independently publishes identical result bytes", () => {
    const state = required(replay(files));
    expect(state.kind).toBe("done");
    if (state.kind !== "done") throw new Error("Historical checkpoint did not complete");
    expect(serializeStandaloneReviewAuthority(state.authority)).toBe(serializeStandaloneReviewAuthority(registeredAuthority(files)));
    expect(isAuthoritativeStandaloneReviewResult(state.result)).toBe(true);
    const prepared = ready(files);
    const result = required(parseAuthoritativeStandaloneReviewResult(prepared, jsonAt(files, "result.json"),
      jsonAt(files, `receipts/${prepared.publicationIntent.effectId}.json`)));
    const serialized = new TextEncoder().encode(serializeAdjudicatedStandaloneReview(result));
    expect(serialized).toEqual(bytesAt(files, "result.json"));
    expect(sha256(serialized)).toBe(golden.resultDigest);
    expect(serialized.length).toBe(golden.resultByteLength);
    expect(isAuthoritativeStandaloneReviewResult(result)).toBe(true);
    expect(required(canonicalStandaloneResultArtifact(result)).digest).toBe(golden.resultDigest);
    const restored = required(replay(files, JSON.parse(serializeStandaloneReviewMachineState(state))));
    expect(restored.kind).toBe("done");
    if (restored.kind !== "done") throw new Error("Round trip lost done state");
    expect(serializeAdjudicatedStandaloneReview(restored.result)).toBe(text(serialized));
    for (const accepted of prepared.completion.results) {
      const bytes = bytesAt(files, accepted.authority.outputSlot.path);
      expect(required(capturedReviewerResultFromBytes(accepted.value.artifact, bytes))).toEqual(accepted.value);
    }
  });

  it("pins exact final counts, ordered IDs, duplicate claims, attempts, and panel history", () => {
    const state = required(replay(files));
    if (state.kind !== "done") throw new Error("Expected completed history");
    const result = state.result;
    const prepared = ready(files);
    expect(result.reviewerEvidence).toHaveLength(name === "pr48-clean" ? 5 : 7);
    expect(result.survivingCriticals.map(({ id }) => id)).toEqual(name === "pr48-clean" ? [] : ["code-reviewer-1", "silent-failure-hunter-1"]);
    expect(result.refutedCriticals).toEqual([]);
    expect(result.advisories.map(({ id }) => id)).toEqual(name === "pr48-clean" ? [] : [
      "silent-failure-hunter-2", "pr-test-analyzer-1", "pr-test-analyzer-2", "type-design-analyzer-1",
      "type-design-analyzer-2", "type-design-analyzer-3", "comment-analyzer-1", "comment-analyzer-2",
      "comment-analyzer-3", "architecture-tech-lead-1", "architecture-tech-lead-2",
      "code-simplifier-1", "code-simplifier-2", "code-simplifier-3",
    ]);
    expect(prepared.completion.results.map(({ authority }) => [authority.role, authority.attempt])).toEqual(name === "pr48-clean" ? [
      ["code-reviewer", 1], ["silent-failure-hunter", 1], ["pr-test-analyzer", 1],
      ["type-design-analyzer", 1], ["architecture-tech-lead", 1],
    ] : [
      ["code-reviewer", 2], ["silent-failure-hunter", 1], ["pr-test-analyzer", 1],
      ["type-design-analyzer", 1], ["comment-analyzer", 1], ["architecture-tech-lead", 1], ["code-simplifier", 1],
    ]);
    if (name === "pr48-clean") {
      expect(result.panel).toBeNull();
      expect(prepared.refutationCompletion).toBeNull();
    } else {
      const duplicate = result.advisories.filter(({ id }) => id.startsWith("pr-test-analyzer-"));
      expect(duplicate).toHaveLength(2);
      expect(duplicate[0]!.claim).not.toBe(duplicate[1]!.claim);
      expect(duplicate[0]!.claim).toBe(duplicate[1]!.claim.replaceAll("`", ""));
      expect(result.panel?.lenses).toEqual(["reproduction", "intent", "blast-radius"]);
      expect(result.panel?.threshold).toBe(2);
      expect(prepared.refutationCompletion?.completedPanelState.stage).toBe("done");
      expect(prepared.refutationCompletion?.completedPanelCheckpoint?.events.map(({ type }) => type)).toEqual([
        "refutation-verdict-accepted", "refutation-verdict-accepted", "refutation-verdict-accepted", "refutation-tally-completed",
      ]);
    }
  });

  it("refuses missing or tampered independent publication receipts, without changing any original bytes", () => {
    const path = entry.files.find(({ path }) => path.startsWith("artifacts/publications/"))!.path;
    const missing = copyFiles(files);
    missing.delete(path);
    expect(replay(missing).ok).toBe(false);
    const receipt = record.parse(jsonAt(files, path));
    const tampered = replaceJson(files, path, { ...receipt, publicationDigest: "0".repeat(64) });
    expect(replay(tampered).ok).toBe(false);
    expect(sha256(bytesAt(files, path))).toBe(entry.files.find((file) => file.path === path)!.sha256);
  });

  it("refuses context corruption at the independent in-memory adapter, never inferring clean legacy evidence", () => {
    const first = ready(files).completion.results[0];
    const path = first.issuedRequest.context.slot.path;
    const packet = record.parse(jsonAt(files, path));
    expect(replay(replaceJson(files, path, { ...packet, outputContract: "tampered" })).ok).toBe(false);
    const missing = copyFiles(files);
    missing.delete(path);
    expect(replay(missing).ok).toBe(false);
  });

  it("rejects raw-byte mutations through the actual capture parser for every accepted reviewer", () => {
    const accepted = ready(files).completion.results;
    fc.assert(fc.property(fc.integer({ min: 0, max: accepted.length - 1 }), fc.nat(), (index, offset) => {
      const result = accepted[index]!;
      const bytes = Uint8Array.from(bytesAt(files, result.authority.outputSlot.path));
      const at = offset % bytes.length;
      bytes[at] = bytes[at]! ^ 1;
      expect(capturedReviewerResultFromBytes(result.value.artifact, bytes).ok).toBe(false);
      expect(required(capturedReviewerResultFromBytes(result.value.artifact,
        bytesAt(files, result.authority.outputSlot.path)))).toEqual(result.value);
    }), { numRuns: 30 });
  });

  it("reconciles all actual capture receipts with original raw bytes (PR48 has none)", () => {
    const receipts = [...files].filter(([path]) => path.startsWith("receipts/effect:capture:"));
    expect(receipts).toHaveLength(name === "pr48-clean" ? 0 : 11);
    for (const [, bytes] of receipts) {
      const receipt = required(parseEffectReceipt(JSON.parse(text(bytes))));
      if (receipt.kind !== "raw-transcript-captured") throw new Error("Expected historical raw capture receipt");
      const raw = bytesAt(files, receipt.artifact.slot.path);
      expect(required(capturedReviewerResultFromBytes(receipt.artifact, raw)).artifact).toEqual(receipt.artifact);
      const changed = Uint8Array.from(raw);
      changed[0] = changed[0]! ^ 1;
      expect(capturedReviewerResultFromBytes(receipt.artifact, changed).ok).toBe(false);
    }
  });

  it("refuses a corrupted raw capture envelope in the complete LC-2 checkpoint", () => {
    const checkpoint = record.parse(jsonAt(files, "checkpoint.json"));
    const completion = record.parse(checkpoint.completion);
    const results = z.array(record).parse(completion.results);
    const first = results[0]!;
    const captured = record.parse(first.value);
    const rawBytes = record.parse(captured.rawBytes);
    const data = z.string().parse(rawBytes.data);
    const tampered = replaceJson(files, "checkpoint.json", { ...checkpoint, completion: {
      ...completion, results: [{ ...first, value: { ...captured, rawBytes: {
        ...rawBytes, data: `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`,
      } } }, ...results.slice(1)],
    } });
    expect(replay(tampered).ok).toBe(false);
  });

  it("rejects valid-JSON result and result-receipt mutations at the opaque publication seam", () => {
    const prepared = ready(files);
    const result = record.parse(jsonAt(files, "result.json"));
    const receiptPath = `receipts/${prepared.publicationIntent.effectId}.json`;
    const receipt = jsonAt(files, receiptPath);
    const changedResult = replaceJson(files, "result.json", { ...result, subject_id: "foreign" });
    expect(parseAuthoritativeStandaloneReviewResult(prepared, jsonAt(changedResult, "result.json"), receipt).ok).toBe(false);
    expect(parseAuthoritativeStandaloneReviewResult(prepared, result, null).ok).toBe(false);
    const changedReceipt = replaceJson(files, receiptPath, { ...record.parse(receipt), runId: "foreign" });
    expect(parseAuthoritativeStandaloneReviewResult(prepared, result, jsonAt(changedReceipt, receiptPath)).ok).toBe(false);
    const checkpoint = record.parse(jsonAt(files, "checkpoint.json"));
    expect(replay(files, { ...checkpoint, result: { ...result, subject_id: "foreign" } }).ok).toBe(false);
  });
});

describe("issued v1 retry history and derived unfinished test prefixes", () => {
  const files = loadReviewerV1Golden("seven-reviewers-retry").files;

  it("pins the actual first-attempt refusal and unchanged frozen retry source/contract", () => {
    const authority = registeredAuthority(files);
    const slot = authority.roster.orderedSlots[0];
    expect(slot.attempts[0].role).toBe("code-reviewer");
    const rejected = admitStandaloneTranscript(historicalProtocol(files, slot.attempts[0]),
      bytesAt(files, slot.attempts[0].outputSlot.path));
    expect(rejected).toEqual({ ok: false, problems: [
      "code-reviewer: CRITICAL_COUNT marker not found; ADVISORY_COUNT marker not found in agent output",
    ] });
    const eventPath = [...files.keys()].find((path) => path.startsWith("events/"))!;
    const event = record.parse(record.parse(jsonAt(files, eventPath)).event);
    expect(event.diagnostic).toBe(!rejected.ok ? rejected.problems[0] : null);
    expect(event.requestId).toBe(slot.attempts[0].requestId);
    const packets = slot.attempts.map(({ contextDigest }) =>
      required(parseContextPacket(jsonAt(files, `contexts/${contextDigest}.json`))));
    expect(packets[0]!.outputContract).toBe("Review the exact frozen scope. Return the Loom Machine Summary and findings contract for your reviewer role.");
    expect(packets[1]!.outputContract).toBe(packets[0]!.outputContract);
    expect(packets[1]!.fixedContext.find(({ label }) => label === "standalone-frozen-source"))
      .toEqual(packets[0]!.fixedContext.find(({ label }) => label === "standalone-frozen-source"));
    expect(packets[1]!.digest).not.toBe(packets[0]!.digest);
  });

  it("replays pending attempt one and pending/partially published attempt two with an accepted sibling", () => {
    // These are reducer-produced illustrative prefixes over actual issued v1
    // bytes, not claims that an original unfinished checkpoint was recovered.
    const prepared = ready(files);
    const authority = registeredAuthority(files);
    const slot = authority.roster.orderedSlots[0];
    const sibling = prepared.completion.results[1]!;
    const started = startStandaloneReviewMachine(authority);
    const awaiting = required(reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId }));
    const acceptedSibling = required(reduceStandaloneReviewMachine(awaiting, { kind: "result-accepted", result: sibling }));
    const retry = prepared.completion.results[0];
    const retryPublication = `artifacts/publications/${sha256(retry.issuedRequest.issuance.effectId)}.json`;
    const pendingFiles = copyFiles(files);
    pendingFiles.delete(retryPublication);
    pendingFiles.delete(`requests/${retry.authority.requestId}.json`);
    pendingFiles.delete(retry.authority.outputSlot.path);
    pendingFiles.delete("result.json");
    const pendingOne = required(replay(pendingFiles, JSON.parse(serializeStandaloneReviewMachineState(acceptedSibling))));
    expect(pendingOne.kind).toBe("awaiting-results");
    expect(pendingOne.accepted).toEqual(acceptedSibling.accepted);
    expect(pendingOne.pending.find(({ slotId }) => slotId === slot.slotId)?.expectedAttempt).toBe(1);
    const admission = admitStandaloneTranscript(historicalProtocol(files, slot.attempts[0]), bytesAt(files, slot.attempts[0].outputSlot.path));
    if (admission.ok) throw new Error("Historical first attempt must be refused");
    const pendingTwo = required(reduceStandaloneReviewMachine(acceptedSibling, {
      kind: "result-rejected", request: slot.attempts[0], message: admission.problems.join("; "),
    }));
    const raw: unknown = JSON.parse(serializeStandaloneReviewMachineState(pendingTwo));
    const unpublished = required(replay(pendingFiles, raw));
    expect(unpublished.kind).toBe("awaiting-results");
    expect(unpublished.accepted).toEqual(acceptedSibling.accepted);
    expect(unpublished.pending.find(({ slotId }) => slotId === slot.slotId)).toMatchObject({
      expectedAttempt: 2, rejectionDiagnostic: admission.problems.join("; "),
    });
    const partiallyPublished = copyFiles(pendingFiles);
    partiallyPublished.set(`requests/${retry.authority.requestId}.json`, Uint8Array.from(bytesAt(files, `requests/${retry.authority.requestId}.json`)));
    expect(serializeStandaloneReviewMachineState(required(replay(partiallyPublished, raw))))
      .toBe(serializeStandaloneReviewMachineState(unpublished));
    expect(sha256(bytesAt(files, retryPublication))).toBe(sha256(bytesAt(loadReviewerV1Golden("seven-reviewers-retry").files, retryPublication)));
  });

  it("rejects changed panel event evidence through complete LC-2 replay", () => {
    const checkpoint = record.parse(jsonAt(files, "checkpoint.json"));
    const completion = record.parse(checkpoint.refutationCompletion);
    const panelCheckpoint = record.parse(completion.completedPanelCheckpoint);
    const events = z.array(record).parse(panelCheckpoint.events);
    const changed = {
      ...checkpoint,
      refutationCompletion: { ...completion, completedPanelCheckpoint: {
        ...panelCheckpoint, events: [{ ...events[0], value: {} }, ...events.slice(1)],
      } },
    };
    expect(replay(files, changed).ok).toBe(false);
  });
});

function illustrative(name: string): string {
  return readFileSync(new URL(`../fixtures/reviewer-protocol-v1/illustrative/${name}.raw`, import.meta.url), "utf8");
}

describe("isolated legacy examples (not authoritative historical Runs)", () => {
  it("keeps malformed-block fallback and whitespace/sentinel normalization", () => {
    const resolution = resolveReviewFindings(illustrative("malformed-block"), "code-reviewer");
    expect(resolution.kind).toBe("findings");
    if (resolution.kind !== "findings") throw new Error("Expected historical fallback");
    expect(resolution.findings.blockStatus).toMatchObject({ kind: "rejected", reason: expect.stringContaining("invalid JSON:") });
    expect(resolution.findings.drafts).toEqual([{ severity: "critical", file: null, line: null, claim: "unchecked cast" }]);
    expect(resolution.findings.advisory).toEqual([]);
  });

  it("pins both synthetic shortfalls, original order/IDs, and declared rather than derived counts", () => {
    const output = illustrative("shortfall");
    const resolution = resolveReviewFindings(output, "code-reviewer");
    if (resolution.kind !== "findings") throw new Error("Expected legacy findings");
    expect(resolution.findings.criticalCount).toBe(3);
    expect(resolution.findings.advisoryCount).toBe(2);
    expect(resolution.findings.drafts.map(({ severity, claim }) => [severity, claim])).toEqual([
      ["critical", "Review output parsing failed - 2 of 3 critical findings not captured"],
      ["advisory", "Review output parsing failed - 1 of 2 advisory findings not captured"],
      ["critical", "captured blocker"], ["advisory", "captured benefit"],
    ]);
    const aggregate = required(aggregateLegacyStandaloneReview({ runId: "illustrative-shortfall", scope: ["src/x.ts"], transcripts: [{ agent: "code-reviewer", output }] }));
    expect(aggregate.aggregate.findings.map(({ id }) => id)).toEqual(["code-reviewer-1", "code-reviewer-2", "code-reviewer-3", "code-reviewer-4"]);
    expect(aggregate.aggregate.findings.filter(({ severity }) => severity === "critical")).toHaveLength(2);
  });

  it("preserves explicit duplicate multiplicity after normalization and filters sentinels", () => {
    const output = illustrative("normalization-and-duplicates");
    const aggregate = required(aggregateLegacyStandaloneReview({ runId: "illustrative-duplicates", scope: ["src/x.ts"], transcripts: [{ agent: "code-reviewer", output }] }));
    expect(aggregate.kind).toBe("clean");
    expect(aggregate.aggregate.findings).toEqual([1, 2].map((ordinal) => ({
      severity: "advisory", file: "src/x.ts", line: 4, claim: "repeated benefit", id: `code-reviewer-${ordinal}`, agent: "code-reviewer",
    })));
  });

  it("legacy aggregate normalization conserves every emitted duplicate and its ordinal", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), fc.constantFrom(" ", "   ", "\n", "\t", " \n\t "), (count, whitespace) => {
      const output = ["### Machine Summary", "CRITICAL_COUNT: 0", `ADVISORY_COUNT: ${count}`, "```findings",
        JSON.stringify(Array.from({ length: count }, () => ({ severity: "advisory", file: "src/x.ts", line: 4, claim: `${whitespace}repeated${whitespace}benefit${whitespace}` }))), "```"].join("\n");
      const aggregate = required(aggregateLegacyStandaloneReview({ runId: "illustrative-property", scope: ["src/x.ts"], transcripts: [{ agent: "code-reviewer", output }] }));
      expect(aggregate.aggregate.findings.map(({ id, claim }) => [id, claim])).toEqual(
        Array.from({ length: count }, (_, ordinal) => [`code-reviewer-${ordinal + 1}`, "repeated benefit"]));
    }), { numRuns: 50 });
  });
});
