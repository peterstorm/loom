/**
 * The ONE Wave Review Epoch Authority spec-check-documents grammar (atl-1).
 *
 * Both transports — the State File load guard (state-manager.ts) and the
 * reviewer-context decode in core/wave-review-authority.ts — accept
 * `specCheckDocuments` only through `parseWaveSpecCheckDocumentsAuthority`, so
 * load-accept/decode-accept desynchronization is structurally impossible. These
 * pins hold the grammar's rejection facts and the load guard's exact decorated
 * prose (byte-identical to the pre-shared-parser diagnostics).
 */

import { describe, expect, it } from "vitest";
import {
  parseWaveSpecCheckDocumentAuthority,
  parseWaveSpecCheckDocumentsAuthority,
} from "../../src/core/wave-review-authority";
import { parseTaskGraph } from "../../src/state-manager";

const SHA = "a".repeat(64);
const epoch = (specCheckDocuments: unknown) => ({
  runId: "run.a",
  wave: 1,
  batchEpoch: SHA,
  ...(specCheckDocuments === undefined ? {} : { specCheckDocuments }),
});

describe("the shared wave spec-check-documents grammar", () => {
  it("accepts the exact persisted shape and freezes it, including the null/null document", () => {
    const valid = {
      spec: { path: ".claude/specs/run/spec.md", contentDigest: SHA },
      plan: { path: null, contentDigest: null },
    };
    const parsed = parseWaveSpecCheckDocumentsAuthority(valid);
    expect(parsed).toEqual({
      ok: true,
      value: {
        spec: { path: ".claude/specs/run/spec.md", contentDigest: SHA },
        plan: { path: null, contentDigest: null },
      },
    });
    expect(Object.isFrozen(parsed.ok ? parsed.value : null)).toBe(true);
    expect(parseWaveSpecCheckDocumentAuthority({ path: null, contentDigest: null })).toEqual({
      ok: true,
      value: { path: null, contentDigest: null },
    });
  });

  it("carries the rejection facts each transport decorates", () => {
    expect(parseWaveSpecCheckDocumentsAuthority("nope")).toMatchObject({
      ok: false, rejection: { kind: "not-an-object" },
    });
    expect(parseWaveSpecCheckDocumentsAuthority({ spec: {}, plan: {}, latest: true })).toMatchObject({
      ok: false, rejection: { kind: "unknown-fields", fields: ["latest"] },
    });
    expect(parseWaveSpecCheckDocumentsAuthority({ spec: {} })).toMatchObject({
      ok: false, rejection: { kind: "missing-fields", fields: ["plan"] },
    });
    expect(parseWaveSpecCheckDocumentsAuthority({ spec: {}, plan: {} })).toMatchObject({
      ok: false,
      rejection: { kind: "member", member: "spec", failure: { kind: "missing-fields", fields: ["path", "contentDigest"] } },
    });
    expect(parseWaveSpecCheckDocumentsAuthority({
      spec: { path: 42, contentDigest: SHA }, plan: { path: null, contentDigest: null },
    })).toMatchObject({
      ok: false, rejection: { kind: "member", member: "spec", failure: { kind: "path-not-string-or-null" } },
    });
    expect(parseWaveSpecCheckDocumentsAuthority({
      spec: { path: null, contentDigest: SHA }, plan: { path: null, contentDigest: null },
    })).toMatchObject({
      ok: false, rejection: { kind: "member", member: "spec", failure: { kind: "null-lockstep" } },
    });
    expect(parseWaveSpecCheckDocumentsAuthority({
      spec: { path: "spec.md", contentDigest: "zz" }, plan: { path: null, contentDigest: null },
    })).toMatchObject({
      ok: false,
      rejection: {
        kind: "member", member: "spec",
        failure: { kind: "invalid-digest", message: expect.stringContaining("lowercase SHA-256") },
      },
    });
    expect(parseWaveSpecCheckDocumentAuthority(["path", "contentDigest"])).toMatchObject({
      ok: false, rejection: { kind: "not-an-object" },
    });
    // tda-1: a blank path can never name a document — the shell mints this
    // authority from a real read at a real path and `null` is the explicit
    // no-document state — so blank is refused as hand-edit/corruption, not
    // accepted as an alternate spelling of either legitimate arm.
    expect(parseWaveSpecCheckDocumentAuthority({ path: "", contentDigest: SHA })).toMatchObject({
      ok: false, rejection: { kind: "path-blank" },
    });
    expect(parseWaveSpecCheckDocumentAuthority({ path: "   ", contentDigest: SHA })).toMatchObject({
      ok: false, rejection: { kind: "path-blank" },
    });
  });

  it("keeps the State File load guard's exact refusal prose for every rejection", () => {
    // The lifecycle fields parse first, so the minimal graph must satisfy them
    // to reach the epoch authority.
    const graph = { current_phase: "init", phase_artifacts: {}, skipped_phases: [] };
    const refuses = (specCheckDocuments: unknown, message: string) => {
      const parsed = parseTaskGraph({ ...graph, wave_review_epoch: epoch(specCheckDocuments) });
      expect(parsed).toMatchObject({ ok: false, error: message });
    };
    refuses("nope", "wave_review_epoch.specCheckDocuments must be an object when present");
    refuses(
      { spec: {}, plan: {}, latest: true },
      "wave_review_epoch.specCheckDocuments contains unknown field(s): latest",
    );
    refuses(
      { spec: {} },
      "wave_review_epoch.specCheckDocuments is missing field(s): plan",
    );
    refuses(
      { spec: {}, plan: {} },
      "wave_review_epoch.specCheckDocuments.spec is missing field(s): path, contentDigest",
    );
    refuses(
      { spec: { path: 42, contentDigest: SHA }, plan: { path: null, contentDigest: null } },
      "wave_review_epoch.specCheckDocuments.spec.path must be a string or null",
    );
    refuses(
      { spec: { path: null, contentDigest: SHA }, plan: { path: null, contentDigest: null } },
      "wave_review_epoch.specCheckDocuments.spec.path and contentDigest must both be null or both be present",
    );
    refuses(
      { spec: { path: "   ", contentDigest: SHA }, plan: { path: null, contentDigest: null } },
      "wave_review_epoch.specCheckDocuments.spec.path must not be blank when present",
    );
    refuses(
      { spec: { path: "spec.md", contentDigest: "zz" }, plan: { path: null, contentDigest: null } },
      "wave_review_epoch.specCheckDocuments.spec.contentDigest: artifact-digest must be a lowercase SHA-256 digest; received \"zz\"",
    );
  });
});
