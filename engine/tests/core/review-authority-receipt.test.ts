/**
 * The review-authority receipt wire contract and its reviewed-source codec —
 * the one pure owner both the Pi producer and the bridge consumer use.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isBareGitSha } from "../fixtures/git-sha-oracle";
import {
  parseLoomReviewAuthorityReceipt,
  parseStandaloneReviewedSource,
  type LoomReviewAuthorityReceipt,
  type StandaloneReviewedSource,
  type StandaloneReviewedSourceFile,
} from "../../src/core/review-authority-receipt";

const receipt: LoomReviewAuthorityReceipt = Object.freeze<LoomReviewAuthorityReceipt>({
  schemaVersion: 1, kind: "loom-review-authority-receipt", sessionId: "session-1", runId: "review-run-1",
  runsRoot: "/project/.loom/runs", runDirectory: "/project/.loom/runs/review-run-1",
  requestIds: ["request:" + "a".repeat(64)], resultDigest: "b".repeat(64),
  reviewedSource: { schemaVersion: 1, headRevision: "c".repeat(40), files: [
    { path: "src/a.ts", kind: "file", digest: "d".repeat(64), byteLength: 12 },
    { path: "src/gone.ts", kind: "absent", digest: null, byteLength: 0 },
  ] },
});

const hex = (length: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${length}}$`));
const reviewedFile: fc.Arbitrary<StandaloneReviewedSourceFile> = fc.oneof(
  fc.record({
    path: fc.stringMatching(/^[a-z][a-z0-9/._-]{0,20}$/),
    kind: fc.constant("file" as const),
    digest: hex(64),
    byteLength: fc.nat(),
  }),
  fc.record({
    path: fc.stringMatching(/^[a-z][a-z0-9/._-]{0,20}$/),
    kind: fc.constant("absent" as const),
    digest: fc.constant(null),
    byteLength: fc.constant(0 as const),
  }),
);
const reviewedSource: fc.Arbitrary<StandaloneReviewedSource> = fc.record({
  schemaVersion: fc.constant(1 as const),
  headRevision: fc.oneof(hex(40), hex(64)),
  files: fc.array(reviewedFile, { maxLength: 6 }),
});

describe("reviewed-source codec", () => {
  it("property: every well-formed attestation round-trips through JSON and comes back frozen", () => {
    fc.assert(fc.property(reviewedSource, (source) => {
      const parsed = parseStandaloneReviewedSource(JSON.parse(JSON.stringify(source)));
      expect(parsed).toEqual(source);
      expect(parsed !== null && Object.isFrozen(parsed) && Object.isFrozen(parsed.files)).toBe(true);
    }), { numRuns: 200 });
  });

  it("property: a head revision is admitted exactly when it is a bare 40- or 64-hex SHA", () => {
    fc.assert(fc.property(fc.string({ maxLength: 70 }), (headRevision) => {
      const admitted = isBareGitSha(headRevision);
      expect(parseStandaloneReviewedSource({ ...receipt.reviewedSource, headRevision }) !== null).toBe(admitted);
    }), { numRuns: 200 });
  });

  it.each([
    ["an empty path", { path: "", kind: "file", digest: "d".repeat(64), byteLength: 1 }],
    ["a negative length", { path: "x", kind: "file", digest: "d".repeat(64), byteLength: -1 }],
    ["a fractional length", { path: "x", kind: "file", digest: "d".repeat(64), byteLength: 1.5 }],
    ["an absent entry with length", { path: "x", kind: "absent", digest: null, byteLength: 1 }],
    ["a surplus field", { path: "x", kind: "file", digest: "d".repeat(64), byteLength: 1, content: "" }],
  ])("refuses a file with %s", (_label, file) => {
    expect(parseStandaloneReviewedSource({ ...receipt.reviewedSource, files: [file] })).toBeNull();
  });
});

describe("review-authority receipt parse", () => {
  it("brands a well-formed receipt", () => {
    expect(parseLoomReviewAuthorityReceipt(receipt)).toEqual({ ok: true, value: receipt });
  });

  it.each([
    ["shape", "a non-object", null],
    ["shape", "an extra field", { ...receipt, extra: 1 }],
    ["schema", "another schema version", { ...receipt, schemaVersion: 2 }],
    ["schema", "another kind", { ...receipt, kind: "receipt" }],
    ["sessionId", "an empty session", { ...receipt, sessionId: "" }],
    ["runId", "an empty Run id", { ...receipt, runId: "" }],
    ["runId", "a path-like Run id", { ...receipt, runId: "../escape" }],
    ["runsRoot", "a relative runs root", { ...receipt, runsRoot: "runs" }],
    ["runDirectory", "a relative Run directory", { ...receipt, runDirectory: "runs/review-run-1" }],
    ["requestIds", "no captured requests", { ...receipt, requestIds: [] }],
    ["requestIds", "a non-string request", { ...receipt, requestIds: [7] }],
    ["resultDigest", "an uppercase digest", { ...receipt, resultDigest: "B".repeat(64) }],
    ["reviewedSource", "a short head revision", { ...receipt, reviewedSource: { ...receipt.reviewedSource, headRevision: "abc" } }],
    ["reviewedSource", "an absent file with a digest", { ...receipt, reviewedSource: { ...receipt.reviewedSource,
      files: [{ path: "x", kind: "absent", digest: "d".repeat(64), byteLength: 0 }] } }],
    ["reviewedSource", "a file of unknown kind", { ...receipt, reviewedSource: { ...receipt.reviewedSource,
      files: [{ path: "x", kind: "link", digest: "d".repeat(64), byteLength: 1 }] } }],
  ])("refuses %s: %s", (field, _name, raw) => {
    expect(parseLoomReviewAuthorityReceipt(raw)).toEqual({ ok: false, error: `receipt ${field} is malformed` });
  });
});
