/**
 * The issued emission capability contract, tested at its own seam: the
 * descriptor grammar, the parent-side expected-capability decision over an
 * in-memory issued-request reader, the issuance-side route decision and
 * qualification, the task-text projection, and the capability ADT mints. Pure
 * — no Run Directory, no subprocess, no SpawnAdmissionPorts; the batch gate
 * chain that composes this decision is spawn-admission.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import {
  decideRequestEmissionRoute,
  EMISSION_DESCRIPTOR_MARKER,
  emissionToolPrimaryInstruction,
  expectedSpawnEmissionCapability,
  issuedReviewerPayloadClaim,
  notProvidedEmissionCapability,
  parseEmissionDescriptor,
  projectEmissionTaskText,
  providedEmissionCapability,
  qualifyIssuedSpawnEmissionRoute,
  renderEmissionDescriptor,
  spawnEmissionRefusalMessage,
  type EmissionDescriptorParse,
  type EmissionToolCapability,
  type IssuedProducerClaim,
  type IssuedSpawnEmissionAuthority,
  type IssuedSpawnEmissionRoute,
  type IssuedSpawnRequestReader,
  type SpawnEmissionAdmission,
  type SpawnEmissionRefusal,
} from "../../src/core/issued-emission-capability";
import { DESKTOP_VLLM_ROUTE, lowerModelProfile, resolveModelProfile, type LoomAgentName } from "../../src/core/model-profiles";
import { LOOM_OWNED_AGENTS } from "../../src/core/agent-catalog-projections";
import type { PiSpawnItem } from "../../src/core/pi-spawn-input";
import {
  canonicalStructuralEquals,
  parseRequestId,
  type ArtifactDigest,
  type ContextDigest,
  type RequestId,
} from "../../src/core/orchestration-contract/identity";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import {
  claimOf,
  CONTEXT_DIGEST,
  emissionItem,
  emissionRouteFor,
  emissionTask,
  issuedFor,
  issuedTask,
  JUDGE_V1,
  missingIssuedRequest,
  mintEmissionBinding,
  OTHER_CONTEXT_DIGEST,
  REFUTATION_V1,
  REGISTRY_CELLS,
  REVIEWER_V2,
  REVIEWER_V3,
  spawnItem,
} from "../fixtures/issued-emission";
import { value } from "../fixtures/parse-result";

/** Run `body` with `overrides` applied to `process.env`, restoring every key —
 *  deleting the ones that were unset — once `body` settles, even on failure.
 *  Used only to prove the decision reads no ambient parent state. */
function withEnv<T>(overrides: Readonly<Record<string, string>>, body: () => T): T {
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, overrides);
  try {
    return body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type RenderedEmissionAdmission =
  | Extract<SpawnEmissionAdmission, { ok: true }>
  | Readonly<{ ok: false; refusal: SpawnEmissionRefusal; reason: string }>;

/** The pure decision, with each typed refusal rendered exactly as the batch
 *  admission's block edge renders it: `refusal.code` pins the cause and
 *  `reason` pins the byte-identical operator text. */
const renderedEmissionAdmission = (
  item: PiSpawnItem,
  readIssuedRequest: IssuedSpawnRequestReader = missingIssuedRequest,
): RenderedEmissionAdmission => {
  const admission = expectedSpawnEmissionCapability(item, readIssuedRequest);
  return admission.ok
    ? admission
    : { ok: false, refusal: admission.refusal, reason: spawnEmissionRefusalMessage(admission.refusal) };
};

/** The emission capabilities and issued Pi routes the route-decision suites
 *  share: one definition, so the request, T6, and T9 suites cannot drift. */
const extraction = notProvidedEmissionCapability("extraction-only surface", "extraction");
const hardRefuse = notProvidedEmissionCapability("child revision does not carry the tool", "refuse");
const issuedPiRoute = (provider: string, model: string) => Object.freeze({
  harnessBinding: Object.freeze({ pi: Object.freeze({ provider, model }) }),
});
/** The issued binding of the catalog's single qualified route owner —
 *  derived, so a requalified model changes `DESKTOP_VLLM_ROUTE` alone and only
 *  the requalification guard (pinned to the retained evidence) must move. */
const qualifiedRoute = issuedPiRoute(DESKTOP_VLLM_ROUTE.provider, DESKTOP_VLLM_ROUTE.model);

/** The archived schema-1 reviewer claim for the v2 fixture's request, built
 *  through the production claim constructor — one archived claim every
 *  archived-route test shares. */
const ARCHIVED_V1_CLAIM: IssuedProducerClaim = issuedReviewerPayloadClaim(
  { schemaVersion: 1 },
  { requestId: REVIEWER_V2.requestId, contextDigest: CONTEXT_DIGEST },
);

describe("EmissionToolCapability mints", () => {
  it("mints the provided capability with its branded schema digest", () => {
    const digest = "a".repeat(64) as ArtifactDigest;
    const capability = providedEmissionCapability(digest);
    expect(canonicalStructuralEquals(capability, { kind: "provided", schemaDigest: digest })).toBe(true);
  });

  it("mints the not-provided capability with its degradation class as data", () => {
    const refused = notProvidedEmissionCapability(
      "the loaded runtime revision does not contain the emission-tool module",
      "refuse",
    );
    expect(canonicalStructuralEquals(refused, {
      kind: "not-provided",
      reason: "the loaded runtime revision does not contain the emission-tool module",
      degradation: "refuse",
    })).toBe(true);

    const extractionCapability = notProvidedEmissionCapability("no Loom extension seam", "extraction");
    expect(canonicalStructuralEquals(extractionCapability, {
      kind: "not-provided",
      reason: "no Loom extension seam",
      degradation: "extraction",
    })).toBe(true);
  });
});

describe("issued emission descriptor render/parse", () => {
  it("round-trips every frozen registry cell byte-for-byte", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      const rendered = renderEmissionDescriptor(binding, CONTEXT_DIGEST);
      expect(rendered.startsWith(`${EMISSION_DESCRIPTOR_MARKER}: `)).toBe(true);
      expect(rendered.endsWith("\n")).toBe(true);
      const parsed = parseEmissionDescriptor(`preamble\n${rendered}postamble`);
      expect(parsed).toMatchObject({ kind: "issued" });
      if (parsed.kind !== "issued") return;
      expect(parsed.binding).toEqual(binding);
      expect(parsed.contextDigest).toBe(CONTEXT_DIGEST);
    }));
  });

  it("renders the frozen field order over the exact marker", () => {
    expect(renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST)).toBe(
      `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    );
  });

  it("answers absent for tasks without a descriptor line", () => {
    expect(parseEmissionDescriptor(spawnItem("code-reviewer").task)).toEqual({ kind: "absent" });
  });

  const malformed = (label: string, task: string, expected: RegExp) => {
    it(`refuses ${label}`, () => {
      const parsed = parseEmissionDescriptor(task);
      expect(parsed.kind).toBe("malformed");
      if (parsed.kind !== "malformed") return;
      expect(parsed.reason).toMatch(expected);
    });
  };

  malformed(
    "a tool name that does not certify the kind's registry tool",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_judge_verdict reviewer-payload v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /tool-name-mismatch/,
  );
  malformed(
    "a producer kind the registry does not freeze",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload decompose-verdict v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /unknown-producer-kind/,
  );
  malformed(
    "a schema version outside the closed vocabulary",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v4 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /unsupported-schema-version/,
  );
  malformed(
    "a version the kind's tool does not carry",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_judge_verdict judge-verdict v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /unsupported-schema-version/,
  );
  malformed(
    "a digest that does not certify the frozen bytes",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${"b".repeat(64)}\n`,
    /schema-digest-mismatch/,
  );
  malformed(
    "a non-canonical request id",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 not a request ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /invalid-request-identity|must carry exactly/,
  );
  malformed(
    "a non-digest context field",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId} /run/contexts/x.json ${REVIEWER_V2.schemaDigest}\n`,
    /must carry exactly|context digest/,
  );
  malformed(
    "two descriptor lines in one task",
    `${renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST)}${renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST)}work`,
    /exactly one descriptor/,
  );
  malformed(
    "a truncated field list",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId}\n`,
    /must carry exactly 6/,
  );
  malformed(
    "an empty field from a doubled separator",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId}  ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /must carry exactly 6/,
  );

  it("retains structural and registry refusal codes as typed parse data", () => {
    expect(parseEmissionDescriptor(`${EMISSION_DESCRIPTOR_MARKER}: truncated\n`)).toMatchObject({
      kind: "malformed",
      code: "descriptor-fields",
    });
    expect(parseEmissionDescriptor(
      `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v4 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    )).toMatchObject({ kind: "malformed", code: "unsupported-schema-version" });
  });

  it("is total over arbitrary task text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (task) => {
      const parsed: EmissionDescriptorParse = parseEmissionDescriptor(task);
      expect(["absent", "malformed", "issued"]).toContain(parsed.kind);
    }));
  });
});

describe("expected spawn emission capability", () => {
  it("keeps ordinary descriptor-free, marker-free tasks on the no-tool baseline without an authority read", () => {
    expect(renderedEmissionAdmission(spawnItem("code-reviewer"), () => {
      throw new Error("unbound items must not consult the Run Directory");
    })).toEqual({
      ok: true,
      expectation: { kind: "no-emission-tool" },
    });
  });

  it("consults issued authority and blocks descriptor loss on an emission-enabled request", () => {
    let reads = 0;
    const admission = renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      (...args) => {
        reads += 1;
        return issuedFor("code-reviewer", REVIEWER_V2)(...args);
      },
    );
    expect(reads).toBe(1);
    expect(admission).toMatchObject({
      ok: false,
      refusal: { code: "descriptor-missing", requestId: REVIEWER_V2.requestId },
      reason: expect.stringContaining("missing its required LOOM_EMISSION_DESCRIPTOR"),
    });
  });

  it("honors an explicit extraction-only issued route over a registry-supported claim", () => {
    const route = Object.freeze({ kind: "extraction-only" as const, reason: "issued route was not qualified" });
    const reader = issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route);
    expect(renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      reader,
    )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    expect(renderedEmissionAdmission(
      emissionItem("code-reviewer", REVIEWER_V2),
      reader,
    )).toMatchObject({
      ok: false,
      refusal: { code: "extraction-upgrade", basis: { kind: "extraction-only-route", reason: "issued route was not qualified" } },
      reason: expect.stringContaining("independently issued route is extraction-only"),
    });
  });

  it("requires the descriptor for an explicit emission-enabled issued route", () => {
    const route = Object.freeze({
      kind: "emission" as const,
      binding: REVIEWER_V2,
      contextDigest: CONTEXT_DIGEST,
    });
    const reader = issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route);
    expect(renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      reader,
    )).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing its required LOOM_EMISSION_DESCRIPTOR"),
    });
    expect(renderedEmissionAdmission(
      emissionItem("code-reviewer", REVIEWER_V2),
      reader,
    )).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
  });

  it("refuses an emission-enabled route whose request ID is mixed with another issued claim", () => {
    const routeBinding = mintEmissionBinding({
      requestId: "request:mixed-route-id",
      kind: "reviewer-payload",
      version: REVIEWER_V2.version,
      schemaDigest: REVIEWER_V2.schemaDigest,
    });
    const admission = renderedEmissionAdmission(
      emissionItem("code-reviewer", REVIEWER_V2),
      issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, emissionRouteFor(routeBinding)),
    );
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.refusal).toEqual({
      code: "route-mismatch",
      agent: "code-reviewer",
      routeRequestId: routeBinding.requestId,
      requestId: REVIEWER_V2.requestId,
    });
    expect(admission.reason).toContain("issued emission route");
    expect(admission.reason).toContain(routeBinding.requestId);
    expect(admission.reason).toContain(REVIEWER_V2.requestId);
  });

  it("fails closed when request-bound authority is unavailable", () => {
    const admission = renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      missingIssuedRequest,
    );
    expect(admission).toMatchObject({
      ok: false,
      refusal: { code: "authority-unavailable" },
      reason: expect.stringContaining("issued emission request authority unavailable"),
    });
  });

  it("fails closed with a diagnostic when authority lookup throws for a request-bound task", () => {
    const admission = renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      () => { throw new Error("run directory read exploded"); },
    );
    expect(admission).toMatchObject({
      ok: false,
      refusal: { code: "authority-unreadable", cause: { name: "Error", message: "run directory read exploded" } },
      reason: expect.stringMatching(/could not be read safely.*run directory read exploded/),
    });
  });

  it("allows an explicitly issued archived extraction-only request without a descriptor", () => {
    const archivedReader: IssuedSpawnRequestReader = () => ({
      ok: true,
      value: {
        role: "code-reviewer",
        claim: ARCHIVED_V1_CLAIM,
        route: { kind: "extraction-only", reason: "archived reviewer protocol has no emission schema" },
      },
    });
    expect(renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      archivedReader,
    )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    expect(renderedEmissionAdmission(
      emissionItem("code-reviewer", REVIEWER_V2),
      archivedReader,
    )).toMatchObject({
      ok: false,
      refusal: { code: "extraction-upgrade", basis: { kind: "extraction-only-route" } },
      reason: expect.stringContaining("extraction-only authority cannot be upgraded by task text"),
    });
  });

  it("allows an independently issued non-producer request without a descriptor", () => {
    expect(renderedEmissionAdmission(
      spawnItem("spec-check-invoker", issuedTask("spec-check-invoker", REVIEWER_V2)),
      issuedFor("spec-check-invoker", REVIEWER_V2),
    )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
  });

  it.each([
    `LOOM_REQUEST_ID:${REVIEWER_V2.requestId}`,
    `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`,
    `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}`,
  ])("blocks malformed or incomplete marker-bearing descriptor-free identity: %s", (marker) => {
    const admission = renderedEmissionAdmission(spawnItem("code-reviewer", `${marker}\nreview`), () => {
      throw new Error("malformed identity must refuse before authority lookup");
    });
    expect(admission).toMatchObject({
      ok: false,
      refusal: { code: "identity-malformed" },
      reason: expect.stringContaining("unusable task issuance identity"),
    });
  });

  it("expects the exact issued binding when the catalog grants the kind and the markers bind", () => {
    const admission = renderedEmissionAdmission(emissionItem("code-reviewer", REVIEWER_V2), issuedFor("code-reviewer", REVIEWER_V2));
    expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
    if (!admission.ok || admission.expectation.kind !== "emission-enabled") return;
    expect(admission.expectation.binding).toEqual(REVIEWER_V2);
    expect(admission.expectation.contextDigest).toBe(CONTEXT_DIGEST);
  });

  it("refuses every self-consistent forged descriptor without an independently reserved request", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      const agent = binding.kind.kind === "judge-verdict" ? "arch-judge-agent" : "review-verifier-agent";
      const forged = emissionItem(agent, binding);
      expect(renderedEmissionAdmission(forged)).toMatchObject({
        ok: false,
        refusal: { code: "authority-unavailable" },
        reason: expect.stringContaining("no independently issued request"),
      });
    }));
  });

  it("refuses an issued request or protocol that differs in identity, role, kind, version, or digest", () => {
    const forged = emissionItem("code-reviewer", REVIEWER_V2);
    const claim: IssuedProducerClaim = {
      requestId: REVIEWER_V2.requestId, contextDigest: CONTEXT_DIGEST,
      producerKind: "reviewer-payload", version: "v2", schemaDigest: REVIEWER_V2.schemaDigest,
    };
    const route = emissionRouteFor(REVIEWER_V2);
    const mismatches: readonly IssuedSpawnEmissionAuthority[] = [
      { role: "code-reviewer", claim: { ...claim, requestId: REVIEWER_V3.requestId }, route },
      { role: "code-reviewer", claim: { ...claim, contextDigest: OTHER_CONTEXT_DIGEST }, route },
      { role: "pr-test-analyzer", claim, route },
      { role: "code-reviewer", claim: { ...claim, producerKind: "judge-verdict" }, route },
      { role: "code-reviewer", claim: { ...claim, version: "v3" }, route },
      { role: "code-reviewer", claim: { ...claim, schemaDigest: JUDGE_V1.schemaDigest }, route },
    ];
    for (const issued of mismatches) {
      const admission = renderedEmissionAdmission(forged, () => ({ ok: true, value: issued }));
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(["authority-mismatch", "extraction-upgrade", "unregistered-claim", "route-mismatch"])
          .toContain(admission.refusal.code);
        expect(admission.reason).toMatch(/differs|cannot be upgraded/);
      }
    }
  });

  it("admits the successor v3 cell for the same reviewer role", () => {
    const admission = renderedEmissionAdmission(emissionItem("code-reviewer", REVIEWER_V3), issuedFor("code-reviewer", REVIEWER_V3));
    expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
  });

  it("admits each kind of the review-verifier Agent only when the issued context names it (AD-6)", () => {
    for (const binding of [REVIEWER_V2, REFUTATION_V1]) {
      const admission = renderedEmissionAdmission(emissionItem("review-verifier-agent", binding), issuedFor("review-verifier-agent", binding));
      expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
    }
  });

  it("admits the arch-judge Agent's catalog-derived judge-verdict kind", () => {
    const admission = renderedEmissionAdmission(emissionItem("arch-judge-agent", JUDGE_V1), issuedFor("arch-judge-agent", JUDGE_V1));
    expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
  });

  it("refuses a descriptor whose kind the Agent's catalog row does not grant", () => {
    const admission = renderedEmissionAdmission(
      emissionItem("arch-judge-agent", REVIEWER_V2),
      issuedFor("arch-judge-agent", REVIEWER_V2),
    );
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.refusal).toEqual({
      code: "extraction-upgrade",
      agent: "arch-judge-agent",
      basis: { kind: "ineligible-producer", producerKind: "reviewer-payload", eligible: ["judge-verdict"] },
    });
    expect(admission.reason).toContain("cannot produce reviewer-payload");
    expect(admission.reason).toContain("judge-verdict");
    expect(admission.reason).toContain("AD-6");
  });

  it("refuses a descriptor on a non-producer Agent", () => {
    const admission = renderedEmissionAdmission(
      spawnItem("code-implementer-agent", emissionTask("code-implementer-agent", REVIEWER_V2)),
      issuedFor("code-implementer-agent", REVIEWER_V2),
    );
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.refusal).toMatchObject({ code: "extraction-upgrade", basis: { kind: "ineligible-producer", eligible: [] } });
    expect(admission.reason).toContain("no producer kind");
  });

  it("refuses when the descriptor does not bind the independently issued request named by the task", () => {
    const otherRequest = value(parseRequestId("request:other-attempt"));
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(
      `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`,
      `LOOM_REQUEST_ID: ${otherRequest}`,
    );
    const otherBinding = mintEmissionBinding({
      requestId: otherRequest,
      kind: "reviewer-payload",
      version: "v2",
      schemaDigest: REVIEWER_V2.schemaDigest,
    });
    const admission = renderedEmissionAdmission(spawnItem("code-reviewer", task), () => ({
      ok: true,
      value: { role: "code-reviewer", claim: {
        requestId: otherRequest,
        contextDigest: CONTEXT_DIGEST,
        producerKind: "reviewer-payload",
        version: "v2",
        schemaDigest: REVIEWER_V2.schemaDigest,
      }, route: emissionRouteFor(otherBinding) },
    }));
    expect(admission).toMatchObject({
      ok: false,
      refusal: { code: "descriptor-mismatch" },
      reason: expect.stringContaining("differs from the descriptor"),
    });
  });

  it("refuses when the task carries no request identity marker at all", () => {
    const task = emissionTask("code-reviewer", REVIEWER_V2)
      .split("\n")
      .filter((line) => !line.startsWith("LOOM_REQUEST_ID:"))
      .join("\n");
    const admission = renderedEmissionAdmission(spawnItem("code-reviewer", task));
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.refusal.code).toBe("identity-malformed");
    expect(admission.reason).toContain("LOOM_REQUEST_ID marker is absent");
  });

  it("refuses when the descriptor does not bind the independently issued context named by the task", () => {
    const task = emissionTask("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST).replace(
      `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}`,
      `LOOM_CONTEXT_DIGEST: ${OTHER_CONTEXT_DIGEST}`,
    );
    const admission = renderedEmissionAdmission(spawnItem("code-reviewer", task), () => ({
      ok: true,
      value: { role: "code-reviewer", claim: {
        requestId: REVIEWER_V2.requestId,
        contextDigest: OTHER_CONTEXT_DIGEST,
        producerKind: "reviewer-payload",
        version: "v2",
        schemaDigest: REVIEWER_V2.schemaDigest,
      }, route: emissionRouteFor(REVIEWER_V2, OTHER_CONTEXT_DIGEST) },
    }));
    expect(admission).toMatchObject({
      ok: false,
      refusal: { code: "descriptor-mismatch" },
      reason: expect.stringContaining("differs from the descriptor"),
    });
  });

  it.each([
    ["request", `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`, "LOOM_REQUEST_ID: request:contradiction"],
    ["context", `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}`, `LOOM_CONTEXT_DIGEST: ${OTHER_CONTEXT_DIGEST}`],
  ])("refuses contradictory %s identity markers", (_label, marker, contradiction) => {
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(marker, `${marker}\n${contradiction}`);
    const admission = renderedEmissionAdmission(spawnItem("code-reviewer", task));
    expect(admission).toMatchObject({ ok: false });
    if (!admission.ok) {
      expect(admission.refusal.code).toBe("identity-malformed");
      expect(admission.reason).toContain("is contradictory");
    }
  });

  it("refuses a whitespace-bearing identity marker value as contradictory", () => {
    const marker = `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`;
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(marker, `${marker} foreign`);
    const admission = renderedEmissionAdmission(spawnItem("code-reviewer", task));
    expect(admission).toMatchObject({ ok: false });
    if (!admission.ok) {
      expect(admission.refusal.code).toBe("identity-malformed");
      expect(admission.reason).toContain("is contradictory");
    }
  });

  it("refuses a malformed descriptor instead of defaulting to any tool", () => {
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(" v2 ", " v4 ");
    const admission = renderedEmissionAdmission(
      spawnItem("code-reviewer", task),
      issuedFor("code-reviewer", REVIEWER_V2),
    );
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.refusal).toMatchObject({ code: "descriptor-malformed", descriptorCode: "unsupported-schema-version" });
    expect(admission.reason).toContain("unusable issued emission descriptor");
    expect(admission.reason).toContain("unsupported-schema-version");
  });

  it("is total over arbitrary task text for every catalog Agent", () => {
    fc.assert(fc.property(fc.constantFrom<LoomAgentName>(...LOOM_OWNED_AGENTS), fc.string({ maxLength: 300 }), (agent, task) => {
      expect(() => renderedEmissionAdmission({ agent, task })).not.toThrow();
    }));
  });
});

describe("request emission routes", () => {

  it("closes issued claim typing and renders genuine v1/v2/v3 protocol paths", () => {
    type ClaimAuthority = Readonly<{
      requestId: RequestId;
      contextDigest: ContextDigest;
      producerKind: "reviewer-payload";
    }>;
    expectTypeOf<IssuedProducerClaim["requestId"]>().toEqualTypeOf<RequestId>();
    expectTypeOf<Extract<IssuedProducerClaim, { version: "v2" | "v3" }>["schemaDigest"]>()
      .toEqualTypeOf<ArtifactDigest>();
    expectTypeOf<ClaimAuthority & { version: "v2" }>().not.toMatchTypeOf<IssuedProducerClaim>();
    expectTypeOf<ClaimAuthority & { version: "v1"; schemaDigest: string }>()
      .not.toMatchTypeOf<IssuedProducerClaim>();

    const request = { requestId: REVIEWER_V2.requestId, contextDigest: CONTEXT_DIGEST };
    const archived = issuedReviewerPayloadClaim({ schemaVersion: 1 }, request);
    expect(archived).toEqual({
      requestId: request.requestId,
      contextDigest: CONTEXT_DIGEST,
      producerKind: "reviewer-payload",
      version: "v1",
    });
    expect("schemaDigest" in archived).toBe(false);
    const archivedRoute = decideRequestEmissionRoute(
      archived,
      providedEmissionCapability(REVIEWER_V2.schemaDigest),
    );
    expect(archivedRoute.kind).toBe("extraction-only");
    if (archivedRoute.kind !== "extraction-only") throw new Error("archived v1 fixture must be extraction-only");
    expect(projectEmissionTaskText(archivedRoute, "archived final-message instruction"))
      .toEqual({ descriptor: "", instruction: "archived final-message instruction", decision: archivedRoute });

    for (const { schemaVersion, binding } of [
      { schemaVersion: 2 as const, binding: REVIEWER_V2 },
      { schemaVersion: 3 as const, binding: REVIEWER_V3 },
    ]) {
      const current = issuedReviewerPayloadClaim(
        { schemaVersion, reviewerProtocol: { schemaDigest: binding.schemaDigest } },
        { requestId: binding.requestId, contextDigest: CONTEXT_DIGEST },
      );
      expect(current).toMatchObject({ version: binding.version, schemaDigest: binding.schemaDigest });
      const route = decideRequestEmissionRoute(current, providedEmissionCapability(binding.schemaDigest));
      expect(route.kind).toBe("emission");
      if (route.kind !== "emission") throw new Error(`reviewer ${binding.version} fixture must emit`);
      expect(projectEmissionTaskText(route, "current instruction").descriptor)
        .toBe(renderEmissionDescriptor(binding, CONTEXT_DIGEST));
    }
  });

  it("qualifies emission only from the frozen issued Pi binding and actual Pi-parent existence", () => {
    const claim = claimOf(REVIEWER_V2);
    const qualified = qualifiedRoute;
    expect(qualifyIssuedSpawnEmissionRoute(claim, qualified, true)).toMatchObject({
      kind: "emission",
      binding: REVIEWER_V2,
      contextDigest: CONTEXT_DIGEST,
    });
    expect(qualifyIssuedSpawnEmissionRoute(claim, qualified, false)).toMatchObject({
      kind: "extraction-only",
      reason: expect.stringContaining("parent harness is not Pi"),
    });
  });

  it.each([
    ["the current v2", REVIEWER_V2],
    ["the successor v3", REVIEWER_V3],
  ] as const)("pins the qualified emission route to the catalog's qualified-local-review profile for %s claim (requalification drift guard)", (_label, binding) => {
    const pi = lowerModelProfile(value(resolveModelProfile("qualified-local-review")), "pi");
    // The emission capability trusts exactly the catalog profile the issue
    // route election derives from the qualified-local parent handshake. Both
    // name the catalog's single route owner, so they cannot drift apart.
    expect({ provider: pi.provider, model: pi.model }).toEqual(DESKTOP_VLLM_ROUTE);
    expect(qualifyIssuedSpawnEmissionRoute(claimOf(binding), issuedPiRoute(pi.provider, pi.model), true))
      .toMatchObject({ kind: "emission" });
    expect(qualifyIssuedSpawnEmissionRoute(claimOf(binding), issuedPiRoute(DESKTOP_VLLM_ROUTE.provider, "some-other-local-model"), true))
      .toMatchObject({ kind: "extraction-only" });
  });

  it("binds the single qualified route literal to the retained qualification evidence (requalification guard)", () => {
    // One owner means a catalog model switch moves emission qualification with
    // it, so the switch must not land without new evidence (ADR-0012
    // requalification trigger): the owner is pinned to the served model and
    // provider the retained wire recordings were captured against.
    const evidence = join(LOOM_PACKAGE_ROOT, "probes", "emission-qualification");
    const recordedModels = new Set(readdirSync(join(evidence, "recordings"))
      .filter((name) => name.endsWith("-request.json"))
      .map((name) => (JSON.parse(readFileSync(join(evidence, "recordings", name), "utf8")) as { model: string }).model));
    expect([...recordedModels]).toEqual([DESKTOP_VLLM_ROUTE.model]);
    expect(readFileSync(join(evidence, "README.md"), "utf8"))
      .toContain(`**Qualified route:** \`${DESKTOP_VLLM_ROUTE.provider}\` (vLLM) · model \`${DESKTOP_VLLM_ROUTE.model}\``);
  });

  it("carries only the exact qualified child route in enabled expectations", () => {
    const qualified = qualifyIssuedSpawnEmissionRoute(
      claimOf(REVIEWER_V2),
      qualifiedRoute,
      true,
    );
    expect(qualified.kind).toBe("emission");
    if (qualified.kind !== "emission") throw new Error("qualified fixture must enable emission");
    const enabledAdmission = renderedEmissionAdmission(
      emissionItem("code-reviewer", REVIEWER_V2),
      issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, qualified),
    );
    expect(enabledAdmission).toMatchObject({
      ok: true,
      expectation: {
        kind: "emission-enabled",
        route: DESKTOP_VLLM_ROUTE,
      },
    });
    if (!enabledAdmission.ok || enabledAdmission.expectation.kind !== "emission-enabled") {
      throw new Error("qualified fixture must produce an enabled expectation");
    }
    expect(Object.isFrozen(enabledAdmission.expectation.route)).toBe(true);

    const extractionOnlyRequests = [
      ["swapped provider and model", DESKTOP_VLLM_ROUTE.model, DESKTOP_VLLM_ROUTE.provider],
      ["unqualified", "openai-codex", "gpt-5.6-sol"],
    ] as const;
    for (const [label, provider, model] of extractionOnlyRequests) {
      const route = qualifyIssuedSpawnEmissionRoute(claimOf(REVIEWER_V2), issuedPiRoute(provider, model), true);
      expect(route.kind, label).toBe("extraction-only");
      if (route.kind !== "extraction-only") throw new Error(`${label} fixture must remain extraction-only`);
      const admission = renderedEmissionAdmission(
        spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
        issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route),
      );
      expect(admission, label).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
      if (admission.ok) expect("route" in admission.expectation, label).toBe(false);
    }
  });

  it("cannot upgrade an extraction-only issued profile when the mutable parent model changes", () => {
    const route = qualifyIssuedSpawnEmissionRoute(
      claimOf(REVIEWER_V2),
      issuedPiRoute("openai-codex", "gpt-5.6-sol"),
      true,
    );
    expect(route).toMatchObject({
      kind: "extraction-only",
      reason: expect.stringContaining("issued Pi route openai-codex/gpt-5.6-sol"),
    });
  });

  it("keeps a frozen cloud-issued extraction route no-tool when the ambient Pi parent model is qualified", () => {
    withEnv({ PI_CODING_AGENT: "true", PI_PROVIDER: DESKTOP_VLLM_ROUTE.provider, PI_MODEL: DESKTOP_VLLM_ROUTE.model }, () => {
      const route = qualifyIssuedSpawnEmissionRoute(
        claimOf(REVIEWER_V2),
        issuedPiRoute("openai-codex", "gpt-5.6-sol"),
        true,
      );
      if (route.kind !== "extraction-only") throw new Error("cloud-issued fixture must remain extraction-only");
      expect(renderedEmissionAdmission(
        spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
        issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route),
      )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    });
  });

  it("routes a certified issued contract on a provided surface to emission with the minted binding", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), providedEmissionCapability(REVIEWER_V2.schemaDigest));
    expect(route).toMatchObject({ kind: "emission" });
    if (route.kind !== "emission") return;
    expect(route.binding).toEqual(REVIEWER_V2);
    expect(route.binding.toolName).toBe("loom_emit_reviewer_payload");
    expect(route.contextDigest).toBe(CONTEXT_DIGEST);
  });

  it("hard-refuses a provided surface whose declared digest is not the issued cell's (US4 containment)", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), providedEmissionCapability(`${"e".repeat(64)}` as typeof REVIEWER_V2.schemaDigest));
    expect(route).toMatchObject({ kind: "refused" });
    if (route.kind !== "refused") return;
    expect(route.reason).toContain("stale loaded revision");
    expect(route.reason).toContain(REVIEWER_V2.schemaDigest);
  });

  it("routes a not-provided extraction surface to extraction-only with the surface's own reason", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), extraction);
    expect(route).toEqual({ kind: "extraction-only", reason: "extraction-only surface" });
  });

  it("hard-refuses a not-provided refuse surface (US4)", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), hardRefuse);
    expect(route).toMatchObject({ kind: "refused" });
    if (route.kind !== "refused") return;
    expect(route.reason).toContain("child revision does not carry the tool");
  });

  it("routes an archived v1 contract to extraction-only regardless of the surface (no schema rewrite)", () => {
    expect(decideRequestEmissionRoute(ARCHIVED_V1_CLAIM, providedEmissionCapability(REVIEWER_V2.schemaDigest))).toMatchObject({
      kind: "extraction-only",
      reason: expect.stringContaining("unsupported-schema-version"),
    });
    expect(decideRequestEmissionRoute(ARCHIVED_V1_CLAIM, extraction).kind).toBe("extraction-only");
  });

  it("routes a non-certifying issued digest to extraction-only, never to emission", () => {
    const nonCertifying: IssuedProducerClaim = Object.freeze({
      ...claimOf(REVIEWER_V2),
      version: "v3" as const,
      schemaDigest: REVIEWER_V2.schemaDigest,
    });
    const route = decideRequestEmissionRoute(nonCertifying, providedEmissionCapability(REVIEWER_V2.schemaDigest));
    expect(route).toMatchObject({ kind: "extraction-only" });
    if (route.kind !== "extraction-only") return;
    expect(route.reason).toContain("schema-digest-mismatch");
  });

  it("never routes a deliberately forged unsupported claim to emission for any capability arm", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      // Trust-boundary negative control: v4 is intentionally impossible in
      // IssuedProducerClaim, so the cast explicitly forges the bad runtime
      // input whose fail-closed behavior this test preserves.
      const unsupported = Object.freeze({
        requestId: binding.requestId,
        contextDigest: CONTEXT_DIGEST,
        producerKind: binding.kind.kind,
        version: "v4",
      }) as unknown as IssuedProducerClaim;
      const arms: readonly EmissionToolCapability[] = [
        providedEmissionCapability(binding.schemaDigest),
        extraction,
        hardRefuse,
      ];
      for (const capability of arms) {
        expect(decideRequestEmissionRoute(unsupported, capability).kind).toBe("extraction-only");
      }
    }));
  });

  it("projects the emission route: descriptor line plus tool-primary instruction after the base", () => {
    const base = "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.";
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), providedEmissionCapability(REVIEWER_V2.schemaDigest));
    if (route.kind !== "emission") throw new Error("fixture route must be emission");
    const projected = projectEmissionTaskText(route, base);
    expect(projected.descriptor).toBe(renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST));
    expect(projected.instruction).toBe(`${base}\n${emissionToolPrimaryInstruction(REVIEWER_V2)}`);
  });

  it("projects the extraction-only route: no descriptor and the caller's instruction verbatim (FR-020)", () => {
    const base = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), extraction);
    if (route.kind !== "extraction-only") throw new Error("fixture route must be extraction-only");
    expect(projectEmissionTaskText(route, base)).toEqual({ descriptor: "", instruction: base, decision: route });
  });

  it("projects an archived v1 route as extraction-only: the archived final-message contract is preserved verbatim (AS-012)", () => {
    const base = "Read the issued Context Packet FIRST. This is an issued schema-1 reviewer request.";
    const route = decideRequestEmissionRoute(ARCHIVED_V1_CLAIM, providedEmissionCapability(REVIEWER_V2.schemaDigest));
    if (route.kind !== "extraction-only") throw new Error("fixture route must be extraction-only");
    expect(projectEmissionTaskText(route, base)).toEqual({ descriptor: "", instruction: base, decision: route });
  });

  it("projects explicit v2/v3 capability simulations through the issued core route without a production render override", () => {
    const cases = [
      { schemaVersion: 2 as const, binding: REVIEWER_V2, instruction: "review current payload" },
      { schemaVersion: 3 as const, binding: REVIEWER_V3, instruction: "review successor payload" },
    ];

    for (const testCase of cases) {
      const claim = issuedReviewerPayloadClaim(
        { schemaVersion: testCase.schemaVersion, reviewerProtocol: { schemaDigest: testCase.binding.schemaDigest } },
        { requestId: testCase.binding.requestId, contextDigest: CONTEXT_DIGEST },
      );
      expect(claim.version).toBe(testCase.binding.version);

      const issuedRoute = decideRequestEmissionRoute(
        claim,
        providedEmissionCapability(testCase.binding.schemaDigest),
      );
      if (issuedRoute.kind !== "emission") {
        throw new Error(`reviewer ${claim.version} fixture route must be emission`);
      }
      const projection = projectEmissionTaskText(issuedRoute, testCase.instruction);
      expect(projection.descriptor).toBe(renderEmissionDescriptor(testCase.binding, CONTEXT_DIGEST));
      expect(parseEmissionDescriptor(projection.descriptor)).toEqual({
        kind: "issued",
        binding: testCase.binding,
        contextDigest: CONTEXT_DIGEST,
      });
      expect(projection.instruction).toContain(`calling the exact tool ${testCase.binding.toolName} exactly once`);

      const refused = decideRequestEmissionRoute(
        claim,
        providedEmissionCapability("e".repeat(64) as typeof testCase.binding.schemaDigest),
      );
      expect(refused).toMatchObject({ kind: "refused", reason: expect.stringContaining("stale loaded revision") });
    }
  });


  it("the tool-primary instruction names the exact tool, the one-call rule, and the extraction fallback", () => {
    for (const binding of REGISTRY_CELLS) {
      const instruction = emissionToolPrimaryInstruction(binding);
      const mentions = instruction.split(binding.toolName).length - 1;
      expect(mentions).toBeGreaterThanOrEqual(2);
      expect(instruction).toContain("exactly once");
      expect(instruction).toContain("a second time");
      expect(instruction).toContain("fall back to the final message");
      // The extraction-only admission prose stays out of the tool-primary arm:
      // the pinned standalone/wave suites assert current v2 tasks never carry it.
      expect(instruction).not.toContain("Machine Summary");
    }
  });
});

describe("one closed emission-route vocabulary (T6)", () => {
  it("issues the request programs' own decision as spawn authority and projection input, with no translation", () => {
    for (const binding of [REVIEWER_V2, REVIEWER_V3]) {
      const route = qualifyIssuedSpawnEmissionRoute(claimOf(binding), qualifiedRoute, true);
      expect(route).toEqual({ kind: "emission", binding, contextDigest: CONTEXT_DIGEST });
      expect(route).toEqual(decideRequestEmissionRoute(claimOf(binding), providedEmissionCapability(binding.schemaDigest)));
      if (route.kind !== "emission") throw new Error("qualified fixture route must emit");
      // The same value is parent-admission authority and projection input.
      expect(renderedEmissionAdmission(
        emissionItem("code-reviewer", binding),
        issuedFor("code-reviewer", binding, CONTEXT_DIGEST, route),
      )).toMatchObject({ ok: true, expectation: { kind: "emission-enabled", binding } });
      expect(projectEmissionTaskText(route, "review").descriptor).toBe(renderEmissionDescriptor(binding, CONTEXT_DIGEST));
    }
  });

  it("names exactly emission, extraction-only, and refused, and issued authority excludes refused", () => {
    expectTypeOf<ReturnType<typeof qualifyIssuedSpawnEmissionRoute>["kind"]>()
      .toEqualTypeOf<"emission" | "extraction-only" | "refused">();
    expectTypeOf<IssuedSpawnEmissionRoute["kind"]>().toEqualTypeOf<"emission" | "extraction-only">();
  });
});

// ---------------------------------------------------------------------------
// Successor v3 route parity across every degraded arm (T9): the successor's
// issued v3 claim takes the SAME closed route decision as the v2 claim on
// every degraded route — Claude Code (no Pi parent), a schema-incompatible
// (non-qualified) provider route, and an unprovidable child surface remain
// explicit extraction-only with unchanged extraction semantics, and no route
// arm can fail a producer request merely because strict sampling is
// unsupported (INV-1/AS-005: the capability vocabulary carries no strict arm
// at all, so "strict" is not an input the decision could demand).
// ---------------------------------------------------------------------------

describe("successor v3 route parity across every degraded arm (T9)", () => {

  it("routes the successor v3 claim to extraction-only on every degraded route, with unchanged extraction semantics (FR-010/AD-7)", () => {
    const v3Claim = claimOf(REVIEWER_V3);
    const degraded = [
      ["Claude Code: no Pi parent", qualifyIssuedSpawnEmissionRoute(v3Claim, qualifiedRoute, false)],
      ["schema-incompatible route", qualifyIssuedSpawnEmissionRoute(v3Claim, issuedPiRoute("openai-codex", "gpt-5.6-sol"), true)],
      ["unprovidable child surface", decideRequestEmissionRoute(v3Claim, extraction)],
    ] as const;
    for (const [label, route] of degraded) {
      expect(route.kind, label).toBe("extraction-only");
      if (route.kind !== "extraction-only") throw new Error(`${label} fixture must remain extraction-only`);
      // Extraction-only is a route, never a request failure: the reason
      // names the remediation and the projection stamps NO tool wording.
      expect(route.reason, label).not.toMatch(/strict/);
      const projected = projectEmissionTaskText(route, "successor final-message instruction");
      expect(projected.descriptor, label).toBe("");
      expect(projected.instruction, label).toBe("successor final-message instruction");
      expect(parseEmissionDescriptor(projected.instruction).kind, label).toBe("absent");
    }
    // The US4 arms stay the hard refusals they are for every kind — a stale
    // loaded revision and an unprovidable refuse-class surface (v3 pin).
    expect(decideRequestEmissionRoute(v3Claim, providedEmissionCapability(REVIEWER_V2.schemaDigest)))
      .toMatchObject({ kind: "refused", reason: expect.stringContaining("stale loaded revision") });
    expect(decideRequestEmissionRoute(v3Claim, hardRefuse))
      .toMatchObject({ kind: "refused", reason: expect.stringContaining("cannot provide the issued emission tool") });
  });

  it("keeps an explicitly extraction-only successor v3 spawn on the no-tool baseline and refuses a descriptor upgrade (AS-010)", () => {
    const route = qualifyIssuedSpawnEmissionRoute(claimOf(REVIEWER_V3), issuedPiRoute("openai-codex", "gpt-5.6-sol"), true);
    if (route.kind !== "extraction-only") throw new Error("fixture route must be extraction-only");
    const issued: IssuedSpawnRequestReader = (requestId, digest, role) =>
      requestId === REVIEWER_V3.requestId && digest === CONTEXT_DIGEST && role === "code-reviewer"
        ? { ok: true, value: { role, claim: claimOf(REVIEWER_V3), route: Object.freeze({ kind: "extraction-only" as const, reason: route.reason }) } }
        : { ok: false, error: { message: "the fixture's issued authority belongs to another request" } };
    // Descriptor-free: the ordinary extraction-only admission, no tool.
    expect(renderedEmissionAdmission(spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V3)), issued))
      .toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    // A descriptor cannot upgrade extraction-only authority (AD-7).
    const upgraded = renderedEmissionAdmission(emissionItem("code-reviewer", REVIEWER_V3), issued);
    expect(upgraded.ok).toBe(false);
    if (upgraded.ok) throw new Error("descriptor must not upgrade an extraction-only v3 route");
    expect(upgraded.reason).toContain("the independently issued route is extraction-only");
    expect(upgraded.reason).toContain("cannot be upgraded by task text");
  });

  it("admits the successor v3 route exactly like v2: qualified route, exact binding, and the qualified child route carried (T9 v3 parity)", () => {
    const qualified = qualifyIssuedSpawnEmissionRoute(claimOf(REVIEWER_V3), qualifiedRoute, true);
    expect(qualified).toMatchObject({ kind: "emission", binding: REVIEWER_V3, contextDigest: CONTEXT_DIGEST });
    if (qualified.kind !== "emission") throw new Error("qualified fixture must enable emission");
    const admission = renderedEmissionAdmission(
      emissionItem("code-reviewer", REVIEWER_V3),
      issuedFor("code-reviewer", REVIEWER_V3, CONTEXT_DIGEST, qualified),
    );
    expect(admission).toMatchObject({
      ok: true,
      expectation: {
        kind: "emission-enabled",
        binding: REVIEWER_V3,
        contextDigest: CONTEXT_DIGEST,
        route: DESKTOP_VLLM_ROUTE,
      },
    });
  });

  it("cannot upgrade an extraction-only successor v3 issued profile when the ambient parent model is qualified", () => {
    const extractionProfileRoute = qualifyIssuedSpawnEmissionRoute(
      claimOf(REVIEWER_V3),
      issuedPiRoute("openai-codex", "gpt-5.6-sol"),
      true,
    );
    expect(extractionProfileRoute.kind).toBe("extraction-only");
    if (extractionProfileRoute.kind !== "extraction-only") throw new Error("fixture must be extraction-only");
    const ambientQualifiedParent = renderedEmissionAdmission(
      spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V3)),
      (requestId, digest, role) => requestId === REVIEWER_V3.requestId && digest === CONTEXT_DIGEST && role === "code-reviewer"
        ? { ok: true, value: { role, claim: claimOf(REVIEWER_V3), route: extractionProfileRoute } }
        : { ok: false, error: { message: "foreign" } },
    );
    expect(ambientQualifiedParent).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
  });

  it("carries no strict-sampling arm in the capability vocabulary, so no route decision can demand strict support (INV-1/AS-005, property)", () => {
    // Type pin: the capability ADT's arms carry exactly a digest or a
    // reason+degradation — there is no strict field to require, so
    // "unsupported strict sampling" is not a decision input at all.
    expectTypeOf<Extract<EmissionToolCapability, { kind: "provided" }>>()
      .toEqualTypeOf<Readonly<{ kind: "provided"; schemaDigest: ArtifactDigest }>>();
    expectTypeOf<Extract<EmissionToolCapability, { kind: "not-provided" }>>()
      .toEqualTypeOf<Readonly<{ kind: "not-provided"; reason: string; degradation: "refuse" | "extraction" }>>();

    const capabilities = [
      providedEmissionCapability(REVIEWER_V2.schemaDigest),
      providedEmissionCapability(REVIEWER_V3.schemaDigest),
      providedEmissionCapability("e".repeat(64) as ArtifactDigest),
      extraction,
      hardRefuse,
    ];
    const claims = [claimOf(REVIEWER_V2), claimOf(REVIEWER_V3)];
    for (const claim of claims) {
      for (const capability of capabilities) {
        const decision = decideRequestEmissionRoute(claim, capability);
        expect(["emission", "extraction-only", "refused"], `${claim.version}/${capability.kind}`).toContain(decision.kind);
        if (decision.kind === "refused") {
          expect(decision.reason).toMatch(/stale loaded revision|cannot provide the issued emission tool/);
        }
        expect("reason" in decision && decision.reason !== null ? decision.reason : "")
          .not.toMatch(/strict/i);
        if (decision.kind === "emission") {
          expect(decision.binding.version).toBe(claim.version);
          expect(decision.binding.schemaDigest).toBe(claim.schemaDigest);
        }
      }
    }
    // The qualified (unconstrained-emission) route's decision is a pure
    // function of route identity and registry cell: the same claim and
    // capability mint the byte-identical decision, so a route that ignores
    // the preferred strict flag (AS-005) rides the identical matrix.
    const first = decideRequestEmissionRoute(claimOf(REVIEWER_V3), providedEmissionCapability(REVIEWER_V3.schemaDigest));
    const second = decideRequestEmissionRoute(claimOf(REVIEWER_V3), providedEmissionCapability(REVIEWER_V3.schemaDigest));
    expect(second).toEqual(first);
  });
});
