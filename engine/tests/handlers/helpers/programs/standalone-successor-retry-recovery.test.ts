/**
 * Successor retry recovery re-proves the durable attempt-2 packet under the
 * layout it was issued with (ADR-0077) before it trusts any publication: a
 * Run issued before the Standalone Assessment Roster still recovers its exact
 * retry, a packet no issued layout produces is refused as differing, and one
 * that cannot be rebuilt at all says so with its cause.
 *
 * The handle and frozen authority are narrow stubs: recovery reads only the
 * successor packet, the run directory and the successor itself. The durable
 * receipt path is a directory, so a re-proved packet stops at the durable
 * step with a message no re-proof outcome produces.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStandaloneReviewerContextPacketV3, encodeByteSection, type StandaloneReviewerContextPacketV3 } from "../../../../src/core/context-packets";
import { mintAgentRequestAuthority, parseOrchestrationRunId } from "../../../../src/core/orchestration-contract";
import { success } from "../../../../src/core/orchestration-contract/identity";
import { standaloneAssessmentRoster } from "../../../../src/core/standalone-assessment-roster";
import { STANDALONE_ASSESSMENT_ROSTER_SECTION } from "../../../../src/core/standalone-lineage-contract";
import {
  buildStandaloneSuccessorReviewerContext, prepareStandaloneLineageSource, prepareStandaloneSuccessor, type StandaloneLineageSource,
} from "../../../../src/core/standalone-review";
import type { FrozenStandaloneReviewAuthority, PreparedStandaloneSuccessor } from "../../../../src/core/standalone-review-model";
import { publicationFile, publicationResolver, refutationBatchEffectId } from "../../../../src/handlers/helpers/programs/durable-requests";
import type { RegisteredReviewProgram } from "../../../../src/handlers/helpers/programs/registration";
import { recoverOrPublishStandaloneRetry } from "../../../../src/handlers/helpers/programs/standalone-requests";
import type { RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { agentRequestIdentity } from "../../../fixtures/agent-request-identity";
import { value } from "../../../fixtures/parse-result";
import { standaloneFixture } from "../../../fixtures/standalone-remediation-authority";

const SLOT = "slot:code-reviewer";
const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));
const source = (refute = false) => value(prepareStandaloneLineageSource(
  standaloneFixture(["src/main.ts"], true, { refute }).input.standaloneResult, "/owned/predecessor"));
const successor = (prior: StandaloneLineageSource) => value(prepareStandaloneSuccessor(prior, bytes({ runId: "run.successor",
  snapshot: prior.scope.map(path => ({ kind: "present", path, digest: "a".repeat(64), mode: "100644" })), reviewers: prior.reviewers }),
  { kind: "historical-decision-unavailable" }));

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** One slot's two minted requests, attempt 2 bound to `contextDigest`. */
function slot(runId: string, contextDigest: string) {
  const mint = <Attempt extends 1 | 2>(attempt: Attempt, digest: string) =>
    value(mintAgentRequestAuthority(agentRequestIdentity("code-reviewer", attempt, { runId, slotId: SLOT, contextDigest: digest })));
  return { slotId: SLOT, attempts: [mint(1, "1".repeat(64)), mint(2, contextDigest)] as const };
}

/** Recover `slot`'s retry against a run directory holding `packet` and an unreadable durable receipt. */
async function recover(prepared: PreparedStandaloneSuccessor, packet: StandaloneReviewerContextPacketV3, retrySlot: ReturnType<typeof slot>) {
  const runDirectory = mkdtempSync(join(tmpdir(), "successor-retry-"));
  directories.push(runDirectory);
  const effectId = value(refutationBatchEffectId(`standalone-review-retry:${SLOT}`, [retrySlot.attempts[1].requestId]));
  mkdirSync(join(runDirectory, "artifacts", publicationFile(effectId)), { recursive: true });
  const handle = { runId: value(parseOrchestrationRunId(prepared.runId)), runDirectory,
    readStandaloneSuccessorContext: () => success(packet) } as unknown as RunDirHandle;
  // Recovery reads only the frozen successor; publication (the emission authority) is never reached.
  const authority = { schemaVersion: 3, successor: prepared } as unknown as FrozenStandaloneReviewAuthority;
  return recoverOrPublishStandaloneRetry(handle, authority, retrySlot, publicationResolver(handle), {} as RegisteredReviewProgram);
}

/** The attempt-2 packet under the current layout, and the same sections without the roster (the pre-#185 layout). */
function issuedPackets(prepared: PreparedStandaloneSuccessor) {
  const request = slot(prepared.runId, "2".repeat(64)).attempts[1];
  const current = value(buildStandaloneSuccessorReviewerContext(prepared, request, []));
  const [authority, lineage] = current.fixedContext;
  const earlier = value(buildStandaloneReviewerContextPacketV3({ requestId: current.requestId, role: current.role,
    requiredSkill: current.requiredSkill, fixedContext: [authority!, lineage!], variableContext: [] }));
  return { current, earlier, authority: authority!, lineage: lineage! };
}

describe("standalone successor retry recovery re-proves the durable attempt-2 packet", () => {
  it.each(["current", "earlier"] as const)("recovers a %s-layout retry packet past re-proof to its durable publication", async layout => {
    const prepared = successor(source());
    const packet = issuedPackets(prepared)[layout];
    const recovered = await recover(prepared, packet, slot(prepared.runId, packet.digest));
    expect(recovered).toMatchObject({ ok: false, message: expect.stringContaining("cannot read durable publication receipt") });
  });

  it("refuses a retry packet carrying a roster this lineage does not project", async () => {
    const prepared = successor(source());
    const { current, authority, lineage } = issuedPackets(prepared);
    const foreignRoster = value(encodeByteSection(STANDALONE_ASSESSMENT_ROSTER_SECTION,
      JSON.stringify(standaloneAssessmentRoster(successor(source(true))))));
    const forged = value(buildStandaloneReviewerContextPacketV3({ requestId: current.requestId, role: current.role,
      requiredSkill: current.requiredSkill, fixedContext: [authority, lineage, foreignRoster], variableContext: [] }));
    expect(await recover(prepared, forged, slot(prepared.runId, forged.digest)))
      .toEqual({ ok: false, message: "successor retry packet differs from frozen authority" });
  });

  it("reports a retry the successor cannot rebuild with its cause, not as a mismatch", async () => {
    const prepared = successor(source());
    const { current } = issuedPackets(prepared);
    expect(await recover(prepared, current, slot("run.foreign", current.digest))).toEqual({ ok: false,
      message: "successor retry packet could not be rebuilt for re-proof: Successor context requires the exact prepared source and expected reviewer." });
  });
});
