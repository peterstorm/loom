import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
} from "../../src/core/orchestration-contract";
import { bindStandaloneCaptureAuthority, captureStandaloneReviewerBytes } from "../../src/core/standalone-reviewer-capture";
import { prepareStandaloneReview } from "../../src/core/standalone-review-preparation";

describe("request-bound standalone reviewer capture", () => {
  it("binds exact harness completion bytes to the issued request and refuses a foreign one", () => {
    const runId = "run.capture-route";
    const binding = {
      profile: "general-review",
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    } as const;
    const request = {
      runId,
      requestId: "request:capture-route:1",
      slotId: "slot:capture-route",
      program: "standalone-review" as const,
      role: "code-reviewer" as const,
      attempt: 1 as const,
      modelProfile: binding.profile,
      harnessBinding: { pi: binding.pi, claude: binding.claude },
      requiredSkill: null,
      contextDigest: "1".repeat(64),
      outputSlot: "transcripts/capture-route/attempt-1.raw",
    };
    const authority = prepareStandaloneReview({
      runId,
      explicitScope: ["src/x.ts"],
      changedPaths: {
        unstaged: ["src/x.ts"], staged: [], committed: [],
        base_revision: null, head_revision: "0123456789abcdef0123456789abcdef01234567",
      },
      reviewMetadata: {
        requested_kinds: ["comments"], docs_only: false, source_or_test_changed: false,
        types_changed: false, comments_changed: false, additions: 1, file_count: 1,
        new_structure: false, languages: ["TypeScript"],
      },
      scopeSafety: [{ path: "src/x.ts", status: "safe" }],
      roster: [{
        slotId: request.slotId,
        attempts: [request, {
          ...request,
          requestId: "request:capture-route:2",
          attempt: 2,
          contextDigest: "2".repeat(64),
          outputSlot: "transcripts/capture-route/attempt-2.raw",
        }],
      }],
    });
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;
    const rawRequests = [{
      authority: authority.value.initialRequests[0],
      context: {
        digest: authority.value.initialRequests[0].contextDigest,
        slot: `contexts/${authority.value.initialRequests[0].contextDigest}.json`,
      },
    }];
    const publication = prepareInitialBatchPublicationIntent(runId, "effect:capture-route-batch", rawRequests);
    expect(publication.ok).toBe(true);
    if (!publication.ok) return;
    const receipt = {
      schemaVersion: 1 as const,
      kind: "batch-published" as const,
      effectId: publication.value.identity.effectId,
      runId: publication.value.identity.runId,
      requestIds: publication.value.requestIds,
      contextDigests: publication.value.contextDigests,
      issuedRequests: publication.value.issuedRequests,
      publicationDigest: publication.value.identity.publicationDigest,
    };
    const receiptBytes = [...new TextEncoder().encode(JSON.stringify(receipt))];
    const issuance = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(() => ({ ok: true, value: receiptBytes })),
      createAtomicInitialPublicationClaimPort((claim) => ({
        ok: true,
        value: {
          schemaVersion: 1,
          kind: "initial-publication-claimed",
          key: claim.key,
          identity: claim.identity,
        },
      })),
    )(publication.value);
    expect(issuance.ok).toBe(true);
    if (!issuance.ok) return;
    const action = spawnBatchAction(issuance.value, rawRequests);
    expect(action.ok).toBe(true);
    if (!action.ok) return;
    const captureAuthority = bindStandaloneCaptureAuthority(authority.value.authority, action.value.requests);
    expect(captureAuthority.ok).toBe(true);
    if (!captureAuthority.ok) return;

    const bytes = Buffer.from("exact harness completion bytes\n", "utf-8");
    const captured = captureStandaloneReviewerBytes(captureAuthority.value, request.requestId, bytes);
    expect(captured.ok).toBe(true);
    if (captured.ok) {
      expect(captured.value.request.requestId).toBe(request.requestId);
      expect(captured.value.intent.request.outputSlot.path).toBe(request.outputSlot);
      expect(captured.value.intent.bytes).toEqual([...bytes]);
      expect(captured.value.expectedArtifact.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(captureStandaloneReviewerBytes(captureAuthority.value, "request:foreign", bytes).ok).toBe(false);
  });
});
