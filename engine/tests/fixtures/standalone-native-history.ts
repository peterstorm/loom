import type { ContextPacket } from "../../src/core/context-packets";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { value } from "./standalone-successor-remediation";

/** Genuine owned legacy issuance, never a relocated history pack or downgraded current Run. */
export async function startNativeLegacyReview(handle: RunDirHandle) {
  const core = await import("../../src/core/standalone-review");
  const packets = await import("../../src/core/context-packets");
  const models = await import("../../src/core/model-profiles");
  const helpers = await import("../../src/handlers/helpers/programs/helpers");
  const history = await import("./standalone-reviewer-protocol");
  const machine = await import("../../src/core/standalone-review-machine");
  const scope = ["src/repair.mjs", "src/types.ts", "README.md"];
  const head = helpers.gitText(["rev-parse", "HEAD"], "refuse");
  const source = helpers.frozenScopeSection(scope, head);
  const contexts: ContextPacket[] = [];
  const roster = core.STANDALONE_REVIEWER_ROLES.map(role => {
    const policy = value(models.resolveAgentPolicy(role));
    const profile = value(models.resolveModelProfile(policy.profile));
    return { slotId: `slot:${role}`, attempts: ([1, 2] as const).map(attempt => {
      const identity = { runId: handle.runId, requestId: helpers.standaloneRequestId(handle.runId, role, attempt),
        role, attempt, requiredSkill: policy.requiredSkill };
      const legacy = history.legacyStandaloneContext(identity, scope);
      const packet = value(packets.buildContextPacket({ ...legacy, fixedContext: [...legacy.fixedContext, source] }));
      contexts.push(packet);
      return { ...identity, slotId: `slot:${role}`, program: "standalone-review", modelProfile: policy.profile,
        harnessBinding: { pi: models.lowerModelProfile(profile, "pi"), claude: models.lowerModelProfile(profile, "claude-code") },
        contextDigest: packet.digest, outputSlot: `transcripts/slot:${role}/attempt-${attempt}.raw` };
    }) };
  });
  const prepared = value(core.prepareStandaloneReview({ runId: handle.runId, explicitScope: scope,
    changedPaths: { unstaged: scope, staged: [], committed: [], base_revision: null, head_revision: head },
    reviewMetadata: { requested_kinds: ["all"], docs_only: false, source_or_test_changed: true, types_changed: true,
      comments_changed: true, additions: 1, file_count: scope.length, new_structure: false, languages: ["TypeScript"] },
    scopeSafety: scope.map(path => ({ path, status: "safe" })), roster }));
  const registration = history.standaloneFixtureRegistration(prepared.authority);
  value(await handle.registerProgram(registration));
  const batch = await helpers.publishInitialBatch(handle, prepared.initialRequests.map(authority => ({ authority,
    context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` } })), contexts, "standalone-review");
  if (!batch.ok) throw Error(batch.message);
  const awaiting = value(machine.reduceStandaloneReviewMachine(machine.startStandaloneReviewMachine(prepared.authority), { kind: "review-batch-published", runId: handle.runId }));
  await handle.writeCheckpoint(machine.serializeStandaloneReviewMachineState(awaiting));
  return { ok: true as const, action: batch.action };
}
