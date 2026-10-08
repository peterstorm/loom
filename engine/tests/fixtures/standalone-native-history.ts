import type { ContextPacket } from "../../src/core/context-packets";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import type { ReviewerIssueRoute } from "../../src/core/model-profiles";
import { value } from "./parse-result";

/** Genuine owned legacy issuance, never a relocated history pack or downgraded current Run.
 *  `issueRoute` elects the roster's reviewer profile through the catalog's one
 *  issue-route election (`issuedReviewerProfile`), so the SAME fixture mints
 *  the archived v1 contract under either parent route without re-deriving
 *  bindings from ambient environment. */
export async function startNativeLegacyReview(handle: RunDirHandle, issueRoute: ReviewerIssueRoute = "catalog") {
  const scopePolicy = await import("../../src/core/standalone-review-scope");
  const preparation = await import("../../src/core/standalone-review-preparation");
  const packets = await import("../../src/core/context-packets");
  const models = await import("../../src/core/model-profiles");
  const changedPaths = await import("../../src/handlers/helpers/programs/changed-paths");
  const standaloneRequests = await import("../../src/handlers/helpers/programs/standalone-requests");
  const publication = await import("../../src/handlers/helpers/programs/request-publication");
  const history = await import("./standalone-reviewer-protocol");
  const machine = await import("../../src/core/standalone-review");
  const checkpoint = await import("../../src/core/standalone-review-checkpoint");
  const scope = ["src/repair.mjs", "src/types.ts", "README.md"];
  const head = changedPaths.gitText(["rev-parse", "HEAD"], "refuse");
  const source = standaloneRequests.frozenScopeSection(scope, head);
  const contexts: ContextPacket[] = [];
  const roster = scopePolicy.STANDALONE_REVIEWER_ROLES.map(role => {
    const policy = value(models.resolveAgentPolicy(role));
    const profile = value(models.issuedReviewerProfile(role, "standalone-review", issueRoute));
    return { slotId: `slot:${role}`, attempts: ([1, 2] as const).map(attempt => {
      const identity = { runId: handle.runId, requestId: standaloneRequests.standaloneRequestId(handle.runId, role, attempt),
        role, attempt, requiredSkill: policy.requiredSkill };
      const legacy = history.legacyStandaloneContext(identity, scope);
      const packet = value(packets.buildContextPacket({ ...legacy, fixedContext: [...legacy.fixedContext, source] }));
      contexts.push(packet);
      return { ...identity, slotId: `slot:${role}`, program: "standalone-review", modelProfile: profile.id,
        harnessBinding: { pi: models.lowerModelProfile(profile, "pi"), claude: models.lowerModelProfile(profile, "claude-code") },
        contextDigest: packet.digest, outputSlot: `transcripts/slot:${role}/attempt-${attempt}.raw` };
    }) };
  });
  const prepared = value(preparation.prepareStandaloneReview({ runId: handle.runId, explicitScope: scope,
    changedPaths: { unstaged: scope, staged: [], committed: [], base_revision: null, head_revision: head },
    reviewMetadata: { requested_kinds: ["all"], docs_only: false, source_or_test_changed: true, types_changed: true,
      comments_changed: true, additions: 1, file_count: scope.length, new_structure: false, languages: ["TypeScript"] },
    scopeSafety: scope.map(path => ({ path, status: "safe" })), roster }));
  const registration = history.standaloneFixtureRegistration(prepared.authority);
  value(await handle.registerProgram(registration));
  const batch = await publication.publishLegacyInitialBatch(handle, prepared.initialRequests.map(authority => ({ authority,
    context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` } })), contexts, "standalone-review");
  if (!batch.ok) throw Error(batch.message);
  const awaiting = value(machine.reduceStandaloneReviewMachine(machine.startStandaloneReviewMachine(prepared.authority), { kind: "review-batch-published", runId: handle.runId }));
  await handle.writeCheckpoint(checkpoint.serializeStandaloneReviewMachineState(awaiting));
  return { ok: true as const, action: batch.action };
}
