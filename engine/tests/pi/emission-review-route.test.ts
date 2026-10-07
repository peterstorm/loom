/**
 * The Pi review-route seam: how a Pi parent associates each spawn item with
 * its admission outcome, classifies an issued request under a registered
 * review facade, decides the issued-review capture, and qualifies a published
 * request's route so descriptor admission binds to issued authority rather
 * than to task text. No Pi runtime is loaded; the real pi validator, agent
 * loop and resolver pins are emission-tool-runtime.test.ts.
 */
import { describe, expect, it } from "vitest";
import { issueEmissionBinding } from "../../src/core/emission-tool";
import { parseContextDigest } from "../../src/core/orchestration-contract/identity";
import { sha256Hex } from "../../src/core/digest";
import { associatePiSpawnLifecycle } from "../../../pi/tool-input";
import {
  classifyPiIssuedReviewRequest,
  qualifyPiIssuedReviewRequest,
  type PiIssuedReviewRequestClass,
} from "../../../pi/review-run-authority";
import { piIssuedReviewerCaptureObservation } from "../../../pi/review-capture";
import type { AdmittedSpawnItem } from "../../src/core/spawn-admission";
import {
  expectedSpawnEmissionCapability,
  renderEmissionDescriptor,
  spawnEmissionRefusalMessage,
  type IssuedSpawnEmissionAuthority,
} from "../../src/core/issued-emission-capability";
import { planPiWriteGrants } from "../../src/core/pi-write-grant-plan";
import { mintedBindingFor, OBSERVED_REQUEST_ID, REVIEWER_V2_CELL, REVIEWER_V3_CELL } from "../fixtures/emission-registry-cells";

const issuedLookupContext = (() => {
  const parsed = parseContextDigest(sha256Hex("t5-issued-refutation-lookup"));
  if (!parsed.ok) throw new Error(`fixture context digest refused: ${parsed.error.message}`);
  return parsed.value;
})();

describe("Pi mixed-batch lifecycle association", () => {
  it("keeps each item paired with its guard, emission expectation, roster identity, and write-grant decision", () => {
    const emissionBinding = mintedBindingFor(REVIEWER_V2_CELL, OBSERVED_REQUEST_ID);
    const contextDigest = parseContextDigest(sha256Hex("t5-mixed-batch-context"));
    if (!contextDigest.ok) throw new Error(`fixture context digest refused: ${contextDigest.error.message}`);

    const admitted: readonly AdmittedSpawnItem[] = Object.freeze([
      Object.freeze({
        item: Object.freeze({ agent: "code-reviewer" as const, task: "review the issued payload" }),
        taskExecutionSpawn: Object.freeze({ kind: "non-implementation" as const }),
        emissionExpectation: Object.freeze({
          kind: "emission-enabled" as const,
          binding: emissionBinding,
          contextDigest: contextDigest.value,
          route: Object.freeze({ provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14" }),
        }),
      }),
      Object.freeze({
        item: Object.freeze({ agent: "code-implementer-agent" as const, task: "Task ID: T5\nimplement the shell" }),
        taskExecutionSpawn: Object.freeze({
          kind: "implementation" as const,
          prompt: "Task ID: T5\nimplement the shell",
          description: "",
        }),
        emissionExpectation: Object.freeze({ kind: "no-emission-tool" as const }),
      }),
      Object.freeze({
        item: Object.freeze({ agent: "review-verifier-agent" as const, task: "verify the prior finding" }),
        taskExecutionSpawn: Object.freeze({ kind: "standalone" as const }),
        emissionExpectation: Object.freeze({ kind: "no-emission-tool" as const }),
      }),
    ]);

    const associated = associatePiSpawnLifecycle(admitted, "tool-call-mixed-t5");
    expect(associated.map(({ slot, admission }) => ({
      slot,
      agent: admission.item.agent,
      guard: admission.taskExecutionSpawn.kind,
      expectation: admission.emissionExpectation.kind,
    }))).toEqual([
      { slot: 0, agent: "code-reviewer", guard: "non-implementation", expectation: "emission-enabled" },
      { slot: 1, agent: "code-implementer-agent", guard: "implementation", expectation: "no-emission-tool" },
      { slot: 2, agent: "review-verifier-agent", guard: "standalone", expectation: "no-emission-tool" },
    ]);
    expect(new Set(associated.map(({ rosterId }) => rosterId)).size).toBe(3);
    expect(Object.isFrozen(associated)).toBe(true);
    for (const [slot, association] of associated.entries()) {
      expect(association.admission).toBe(admitted[slot]);
      expect(Object.isFrozen(association)).toBe(true);
    }

    // The existing grant planner remains unchanged. The shell derives its two
    // positional inputs locally from these paired records, then immediately
    // rejoins each requirement to the same slot; the implementation child
    // keeps T5's session grant while reviewer/verifier guards keep no grant.
    const grantPlan = planPiWriteGrants(
      associated.map(({ admission }) => admission.item),
      associated.map(({ admission }) => admission.taskExecutionSpawn),
      true,
    );
    expect(grantPlan).toEqual({
      ok: true,
      requirements: [
        { kind: "none" },
        { kind: "session", taskId: "T5" },
        { kind: "none" },
      ],
    });
  });
});

describe("Pi issued-request classification under a registered review facade", () => {
  const runId = "run.t5-issued-refutation";
  const requestId = mintedBindingFor(REVIEWER_V2_CELL, OBSERVED_REQUEST_ID).requestId;
  const refutationRequest = {
    runId,
    requestId,
    contextDigest: issuedLookupContext,
    program: "refutation-panel",
    role: "review-verifier-agent",
  } as const;

  it("admits independently published refutation children of standalone and Wave programs as extraction-only until they carry their own descriptor", () => {
    const programs = [
      {
        kind: "standalone-review" as const,
        schemaVersion: 3 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V3_CELL.spec.schemaVersions.v3!.schemaBytes) },
      },
      {
        kind: "wave-gate" as const,
        schemaVersion: 2 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V2_CELL.spec.schemaVersions.v2!.schemaBytes) },
      },
    ];
    for (const program of programs) {
      const classified = classifyPiIssuedReviewRequest(runId, program, refutationRequest);
      expect(classified.ok, program.kind).toBe(true);
      if (!classified.ok) continue;
      expect(classified.value).toEqual({
        kind: "refutation-panel-extraction",
        claim: {
          requestId,
          contextDigest: issuedLookupContext,
          producerKind: "reviewer-payload",
          version: "v1",
        },
      });
    }
  });

  it("keeps a direct registered reviewer request on its exact issued emission protocol", () => {
    const schemaDigest = mintedBindingFor(REVIEWER_V2_CELL, OBSERVED_REQUEST_ID).schemaDigest;
    const classified = classifyPiIssuedReviewRequest(
      runId,
      { kind: "wave-gate", schemaVersion: 2, reviewerProtocol: { schemaDigest } },
      { ...refutationRequest, program: "wave-gate", role: "code-reviewer" },
    );
    expect(classified).toEqual({
      ok: true,
      value: {
        kind: "review-program-emission",
        claim: {
          requestId,
          contextDigest: issuedLookupContext,
          producerKind: "reviewer-payload",
          version: "v2",
          schemaDigest,
        },
      },
    });
  });

  it("fails closed for a forged run, a substituted refutation role, and a foreign child program", () => {
    for (const request of [
      { ...refutationRequest, runId: "run.forged" },
      { ...refutationRequest, role: "code-reviewer" },
      { ...refutationRequest, program: "architecture-panel" },
    ]) {
      const classified = classifyPiIssuedReviewRequest(
        runId,
        { kind: "standalone-review", schemaVersion: 1 },
        request,
      );
      expect(classified.ok).toBe(false);
      if (!classified.ok) expect(classified.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("the production issued-review capture decision", () => {
  const runId = "run.t5-capture-decision";
  const request = {
    runId,
    requestId: mintedBindingFor(REVIEWER_V2_CELL, OBSERVED_REQUEST_ID).requestId,
    contextDigest: issuedLookupContext,
    program: "wave-gate",
    role: "code-reviewer",
  } as const;
  const finalMessages = [{
    role: "assistant",
    content: [{ type: "text", text: '{"schemaVersion":2,"kind":"wave-review","packetId":"p","generation":1,"prior_findings":[],"findings":[]}' }],
  }];

  it.each([
    {
      version: "v2",
      program: {
        kind: "wave-gate" as const,
        schemaVersion: 2 as const,
        reviewerProtocol: { schemaDigest: sha256Hex("not-the-issued-frozen-schema-v2") },
      },
    },
    {
      version: "v3",
      program: {
        kind: "standalone-review" as const,
        schemaVersion: 3 as const,
        reviewerProtocol: { schemaDigest: sha256Hex("not-the-issued-frozen-schema-v3") },
      },
    },
  ])("makes a malformed current $version issued binding unavailable instead of falling through to final-message extraction", ({ program }) => {
    const classified = classifyPiIssuedReviewRequest(
      runId,
      program,
      { ...request, program: program.kind },
    );
    if (!classified.ok) throw new Error(classified.error.message);

    const observation = piIssuedReviewerCaptureObservation(classified.value, finalMessages);
    expect(observation.kind).toBe("unavailable");
    if (observation.kind === "unavailable") {
      expect(observation.reason).toBe("emission-binding");
      expect(observation.message).toContain("schema-digest-mismatch");
      expect(observation.message).toContain("issued reviewer emission binding is unavailable");
      expect(Buffer.byteLength(observation.message, "utf8")).toBeLessThan(1_000);
    }
  });

  it("keeps the explicit archived reviewer v1 final-message fallback", () => {
    const classified = classifyPiIssuedReviewRequest(
      runId,
      { kind: "wave-gate", schemaVersion: 1 },
      request,
    );
    if (!classified.ok) throw new Error(classified.error.message);

    const observation = piIssuedReviewerCaptureObservation(classified.value, finalMessages);
    expect(observation.kind).toBe("candidates");
    if (observation.kind === "candidates") {
      expect(observation.candidates).toEqual([{
        origin: "content[0].text",
        text: finalMessages[0]!.content[0]!.text,
      }]);
    }
  });
});

describe("qualified published Pi request routes bind descriptor admission independently of task text", () => {
  const reviewPrograms = [
    {
      version: "v2" as const,
      program: {
        kind: "wave-gate" as const,
        schemaVersion: 2 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V2_CELL.spec.schemaVersions.v2!.schemaBytes) },
      },
    },
    {
      version: "v3" as const,
      program: {
        kind: "standalone-review" as const,
        schemaVersion: 3 as const,
        reviewerProtocol: { schemaDigest: sha256Hex(REVIEWER_V3_CELL.spec.schemaVersions.v3!.schemaBytes) },
      },
    },
  ] as const;

  const qualifiedAuthority = (
    classified: PiIssuedReviewRequestClass,
    role: "code-reviewer" | "review-verifier-agent",
    provider: string,
    model: string,
  ): IssuedSpawnEmissionAuthority => {
    const qualified = qualifyPiIssuedReviewRequest(classified, {
      role,
      harnessBinding: { pi: { provider, model } },
    });
    if (!qualified.ok) throw new Error(`fixture route qualification refused: ${qualified.error.message}`);
    return qualified.value;
  };

  const admissionFor = (
    authority: IssuedSpawnEmissionAuthority,
    agent: "code-reviewer" | "review-verifier-agent",
    descriptor = "",
  ) => expectedSpawnEmissionCapability({
    agent,
    task: `LOOM_REQUEST_ID: ${authority.claim.requestId}\n` +
      `LOOM_CONTEXT_DIGEST: ${authority.claim.contextDigest}\n${descriptor}`,
  }, () => ({ ok: true, value: authority }));

  it("admits v2/v3 cloud-pinned reviewers without a descriptor as no-tool, and a valid-looking descriptor cannot upgrade either route", () => {
    const previousAmbientModel = process.env["PI_MODEL"];
    process.env["PI_MODEL"] = "glm-5.3-flash-spark-tp2-v14";
    try {
      for (const { version, program } of reviewPrograms) {
        const request = {
          runId: `run.t5-cloud-${version}`,
          requestId: mintedBindingFor(version === "v2" ? REVIEWER_V2_CELL : REVIEWER_V3_CELL, `req-t5-cloud-${version}`).requestId,
          contextDigest: issuedLookupContext,
          program: program.kind,
          role: "code-reviewer",
        } as const;
        const classified = classifyPiIssuedReviewRequest(request.runId, program, request);
        if (!classified.ok) throw new Error(classified.error.message);
        const authority = qualifiedAuthority(classified.value, request.role, "openai-codex", "gpt-6-sol");
        expect(authority.route, version).toMatchObject({ kind: "extraction-only" });
        expect(admissionFor(authority, request.role), version).toEqual({
          ok: true,
          expectation: { kind: "no-emission-tool" },
        });

        const minted = issueEmissionBinding({
          requestId: authority.claim.requestId,
          kind: authority.claim.producerKind,
          version: authority.claim.version,
          schemaDigest: authority.claim.schemaDigest,
        });
        if (!minted.ok) throw new Error(minted.error.message);
        const forgedUpgrade = admissionFor(
          authority,
          request.role,
          renderEmissionDescriptor(minted.value, authority.claim.contextDigest),
        );
        expect(forgedUpgrade.ok, version).toBe(false);
        if (!forgedUpgrade.ok) {
          expect(forgedUpgrade.refusal).toMatchObject({ code: "extraction-upgrade", basis: { kind: "extraction-only-route" } });
          expect(spawnEmissionRefusalMessage(forgedUpgrade.refusal)).toContain("independently issued route is extraction-only");
        }
      }
    } finally {
      if (previousAmbientModel === undefined) delete process.env["PI_MODEL"];
      else process.env["PI_MODEL"] = previousAmbientModel;
    }
  });

  it("requires the exact descriptor for qualified frozen v2/v3 desktop routes and refuses omitted or forged descriptors", () => {
    for (const { version, program } of reviewPrograms) {
      const request = {
        runId: `run.t5-qualified-${version}`,
        requestId: mintedBindingFor(version === "v2" ? REVIEWER_V2_CELL : REVIEWER_V3_CELL, `req-t5-qualified-${version}`).requestId,
        contextDigest: issuedLookupContext,
        program: program.kind,
        role: "code-reviewer",
      } as const;
      const classified = classifyPiIssuedReviewRequest(request.runId, program, request);
      if (!classified.ok) throw new Error(classified.error.message);
      const authority = qualifiedAuthority(
        classified.value,
        request.role,
        "desktop-vllm",
        "glm-5.3-flash-spark-tp2-v14",
      );
      if (authority.route?.kind !== "emission") {
        throw new Error(`expected an emission ${version} route`);
      }

      const omitted = admissionFor(authority, request.role);
      expect(omitted.ok, version).toBe(false);
      if (!omitted.ok) {
        expect(omitted.refusal.code).toBe("descriptor-missing");
        expect(spawnEmissionRefusalMessage(omitted.refusal)).toContain("missing its required LOOM_EMISSION_DESCRIPTOR descriptor");
      }

      const forgedContext = parseContextDigest(sha256Hex(`t5-forged-descriptor-${version}`));
      if (!forgedContext.ok) throw new Error(forgedContext.error.message);
      const forged = admissionFor(
        authority,
        request.role,
        renderEmissionDescriptor(authority.route.binding, forgedContext.value),
      );
      expect(forged.ok, version).toBe(false);
      if (!forged.ok) {
        expect(forged.refusal.code).toBe("descriptor-mismatch");
        expect(spawnEmissionRefusalMessage(forged.refusal)).toContain("differs from the descriptor");
      }

      expect(admissionFor(
        authority,
        request.role,
        renderEmissionDescriptor(authority.route.binding, authority.route.contextDigest),
      ), version).toEqual({
        ok: true,
        expectation: {
          kind: "emission-enabled",
          binding: authority.route.binding,
          contextDigest: authority.route.contextDigest,
          route: {
            provider: "desktop-vllm",
            model: "glm-5.3-flash-spark-tp2-v14",
          },
        },
      });
    }
  });

  it("keeps an older refutation-panel request extraction-only even on the qualified desktop route", () => {
    const request = {
      runId: "run.t5-old-refutation-route",
      requestId: mintedBindingFor(REVIEWER_V2_CELL, "req-t5-old-refutation-route").requestId,
      contextDigest: issuedLookupContext,
      program: "refutation-panel",
      role: "review-verifier-agent",
    } as const;
    const program = reviewPrograms[0]!.program;
    const classified = classifyPiIssuedReviewRequest(request.runId, program, request);
    if (!classified.ok) throw new Error(classified.error.message);
    expect(classified.value.kind).toBe("refutation-panel-extraction");
    const authority = qualifiedAuthority(
      classified.value,
      request.role,
      "desktop-vllm",
      "glm-5.3-flash-spark-tp2-v14",
    );
    expect(authority.route).toMatchObject({ kind: "extraction-only" });
    expect(admissionFor(authority, request.role)).toEqual({
      ok: true,
      expectation: { kind: "no-emission-tool" },
    });

    const descriptorBinding = issueEmissionBinding({
      requestId: request.requestId,
      kind: "reviewer-payload",
      version: "v2",
    });
    if (!descriptorBinding.ok) throw new Error(descriptorBinding.error.message);
    const forgedUpgrade = admissionFor(
      authority,
      request.role,
      renderEmissionDescriptor(descriptorBinding.value, request.contextDigest),
    );
    expect(forgedUpgrade.ok).toBe(false);
    if (!forgedUpgrade.ok) {
      expect(forgedUpgrade.refusal).toMatchObject({ code: "extraction-upgrade", basis: { kind: "extraction-only-route" } });
      expect(spawnEmissionRefusalMessage(forgedUpgrade.refusal)).toContain("independently issued route is extraction-only");
    }
  });
});

