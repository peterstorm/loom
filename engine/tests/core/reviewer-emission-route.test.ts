/**
 * The ONE reviewer-route derivation both shells consume (render and capture):
 * eligibility, the registration's protocol projection, and the route. The
 * render path's descriptor and the capture runtime's selection binding are
 * this module's output, so pinning it pins their agreement.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  issuedReviewerEmissionRoute,
  projectRegisteredReviewerProtocol,
  reviewerEmissionEligible,
  type IssuedReviewerProtocol,
} from "../../src/core/reviewer-emission-route";
import { issueEmissionBinding } from "../../src/core/emission-tool";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from "../../src/core/standalone-lineage-contract";
import { STANDALONE_REVIEWER_ROLES } from "../../src/core/standalone-review-scope";
import { lowerModelProfile, resolveModelProfile } from "../../src/core/model-profiles";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

const qualifiedProfile = resolveModelProfile("qualified-local-review");
if (!qualifiedProfile.ok) throw new Error("fixture profile must resolve");
const QUALIFIED_PI = lowerModelProfile(qualifiedProfile.value, "pi");

const request = (overrides: Record<string, unknown> = {}): AgentRequestAuthority =>
  agentRequestAuthority("run.reviewer-route", overrides);
const qualified = (overrides: Record<string, unknown> = {}): AgentRequestAuthority => {
  const base = request(overrides);
  return { ...base, harnessBinding: { ...base.harnessBinding, pi: QUALIFIED_PI } } as AgentRequestAuthority;
};

const V1: IssuedReviewerProtocol = { schemaVersion: 1 };
const V2: IssuedReviewerProtocol = { schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL };
const V3: IssuedReviewerProtocol = { schemaVersion: 3, reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3 };

describe("reviewerEmissionEligible", () => {
  it("admits exactly the reviewer roles on standalone-review and wave-gate requests", () => {
    for (const role of STANDALONE_REVIEWER_ROLES) {
      expect(reviewerEmissionEligible({ role, program: "standalone-review" })).toBe(true);
      expect(reviewerEmissionEligible({ role, program: "wave-gate" })).toBe(true);
      expect(reviewerEmissionEligible({ role, program: "refutation-panel" } as never)).toBe(false);
    }
    expect(reviewerEmissionEligible({ role: "spec-check-invoker", program: "wave-gate" } as never)).toBe(false);
  });
});

describe("projectRegisteredReviewerProtocol — only the frozen descriptors project", () => {
  const registration = (fields: Record<string, unknown>) => fields;

  it("projects no reviewer program as null", () => {
    for (const raw of [null, "x", [], {}, registration({ kind: "refutation", schemaVersion: 2 })]) {
      expect(projectRegisteredReviewerProtocol(raw)).toEqual({ ok: true, value: null });
    }
  });

  it("projects the archived schema-1 contract and the exact frozen v2/v3 descriptors", () => {
    expect(projectRegisteredReviewerProtocol(registration({ kind: "wave-gate", schemaVersion: 1 })))
      .toEqual({ ok: true, value: { schemaVersion: 1 } });
    expect(projectRegisteredReviewerProtocol(registration({ kind: "wave-gate", schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL })))
      .toEqual({ ok: true, value: V2 });
    expect(projectRegisteredReviewerProtocol(registration({ kind: "standalone-review", schemaVersion: 3, reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3 })))
      .toMatchObject({ ok: true, value: { schemaVersion: 3, reviewerProtocol: { schemaDigest: STANDALONE_REVIEWER_PROTOCOL_V3.schemaDigest } } });
  });

  it("refuses drifted descriptors and unsupported schema versions — never an extraction downgrade", () => {
    const drift = { schemaDigest: "f".repeat(64) };
    expect(projectRegisteredReviewerProtocol(registration({ kind: "wave-gate", schemaVersion: 2, reviewerProtocol: { ...CURRENT_REVIEWER_PROTOCOL, ...drift } })))
      .toEqual({ ok: false, error: "program registration does not carry the exact frozen reviewer protocol descriptor" });
    expect(projectRegisteredReviewerProtocol(registration({ kind: "standalone-review", schemaVersion: 3, reviewerProtocol: { ...STANDALONE_REVIEWER_PROTOCOL_V3, ...drift } })).ok)
      .toBe(false);
    expect(projectRegisteredReviewerProtocol(registration({ kind: "standalone-review", schemaVersion: 3, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL })).ok)
      .toBe(false);
    expect(projectRegisteredReviewerProtocol(registration({ kind: "wave-gate", schemaVersion: 3, reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3 })))
      .toEqual({ ok: false, error: "program registration carries no supported reviewer protocol projection (schema version 3)" });
  });
});

describe("issuedReviewerEmissionRoute", () => {
  it.each([["v2", V2, "wave-gate"], ["v3", V3, "standalone-review"]] as const)(
    "routes a %s reviewer on the qualified Pi route to the mint's own cell",
    (version, protocol, program) => {
      const authority = qualified({ program });
      const route = issuedReviewerEmissionRoute(protocol, authority, true);
      expect(route.kind).toBe("emission");
      if (route.kind !== "emission") return;
      const minted = issueEmissionBinding({ requestId: authority.requestId, kind: "reviewer-payload", version });
      expect(minted.ok).toBe(true);
      if (minted.ok) expect(route.binding).toEqual(minted.value);
      expect(route.contextDigest).toBe(authority.contextDigest);
    },
  );

  it("keeps the archived schema-1 contract extraction-only even on the qualified route", () => {
    expect(issuedReviewerEmissionRoute(V1, qualified(), true).kind).toBe("extraction-only");
  });

  it("never routes to emission without a Pi parent or off the qualified route, for any issued protocol", () => {
    fc.assert(fc.property(
      fc.constantFrom(V1, V2, V3),
      fc.boolean(),
      fc.boolean(),
      (protocol, piParent, onQualifiedRoute) => {
        const authority = onQualifiedRoute ? qualified() : request();
        const route = issuedReviewerEmissionRoute(protocol, authority, piParent);
        const emission = route.kind === "emission";
        // Emission requires BOTH a Pi parent and the qualified route, and a
        // current (v2/v3) contract; the route is never refused for a reviewer.
        expect(emission).toBe(piParent && onQualifiedRoute && protocol.schemaVersion !== 1);
        expect(route.kind).not.toBe("refused");
      },
    ));
  });
});
