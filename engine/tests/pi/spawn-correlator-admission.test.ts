/**
 * The Pi spawn boundary records each child's emission admission with its
 * correlator (`recordPiSpawnCorrelators`, PR #179 review), so capture reads the
 * decision the child was dispatched under (`admittedEmission`) instead of
 * resolving the route again when the result arrives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueEmissionBinding } from "../../src/core/emission-tool";
import { issuedReviewerPayloadClaim } from "../../src/core/issued-emission-capability";
import { DESKTOP_VLLM_ROUTE } from "../../src/core/model-profiles";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import type { AdmittedSpawnItem } from "../../src/core/spawn-admission";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import { createRunDirectory, openRegisteredRunDirectory } from "../../src/orchestration/run-directory-handle";
import { classifyPiIssuedReviewRequest, qualifyPiIssuedReviewRequest, recordPiSpawnCorrelators } from "../../../pi/review-run-authority";
import { piSpawnRosterId } from "../../../pi/tool-input";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { withEnvOverlay, withEnvOverlaySync } from "../fixtures/env-overlay";
import { hostileServedRouting } from "../fixtures/hostile-served-routing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const RUN = "run.spawn-correlator";

async function stagedRun(request: AgentRequestAuthority): Promise<string> {
  const runsRoot = mkdtempSync(join(tmpdir(), "loom-spawn-correlator-"));
  cleanups.push(() => rmSync(runsRoot, { recursive: true, force: true }));
  const created = createRunDirectory(runsRoot, RUN);
  if (!created.ok) throw new Error(created.error.message);
  const reserved = await created.value.reserveRequest(request);
  if (!reserved.ok) throw new Error(reserved.error.message);
  return runsRoot;
}

const task = (request: AgentRequestAuthority): string =>
  [`LOOM_REQUEST_ID: ${request.requestId}`, `LOOM_CONTEXT_DIGEST: ${request.contextDigest}`, "Review the issued request"].join("\n");

describe("recording the admission decision with a Pi spawn correlator", () => {
  it("records an emission-enabled child with the route it was admitted on", async () => {
    const request = agentRequestAuthority(RUN);
    const runsRoot = await stagedRun(request);
    const claim = issuedReviewerPayloadClaim({ schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }, request);
    const binding = issueEmissionBinding({ requestId: claim.requestId, kind: claim.producerKind, version: claim.version, schemaDigest: claim.schemaDigest });
    if (!binding.ok) throw new Error(binding.error.message);
    const admitted: AdmittedSpawnItem = {
      item: { agent: "code-reviewer", task: task(request) },
      taskExecutionSpawn: { kind: "non-implementation" },
      emissionExpectation: { kind: "emission-enabled", binding: binding.value, contextDigest: request.contextDigest, route: DESKTOP_VLLM_ROUTE },
    };
    const rosterId = piSpawnRosterId("call-enabled", 0, "code-reviewer");
    const rawInput = { agent: "code-reviewer", task: task(request) };

    await withEnvOverlay({ [RUNS_ROOT_ENV]: runsRoot, [RUN_DIR_ENV]: join(runsRoot, RUN) }, () =>
      recordPiSpawnCorrelators([admitted], [rosterId], "session-enabled", rawInput));

    const opened = openRegisteredRunDirectory(runsRoot, RUN);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.readHarnessCorrelator("pi", rosterId)).toMatchObject({
      ok: true,
      value: {
        requestId: request.requestId,
        admittedEmission: { kind: "enabled", route: { provider: DESKTOP_VLLM_ROUTE.provider, model: DESKTOP_VLLM_ROUTE.model } },
      },
    });
  });

  it("records a child admitted without the emission tool as not-enabled", async () => {
    // A spec-check request carries no reviewer contract, so its canonical re-render needs no registration.
    const request = agentRequestAuthority(RUN, {
      requestId: "request:spec-check:1",
      role: "spec-check-invoker",
      modelProfile: "spec-check-review",
    });
    const runsRoot = await stagedRun(request);
    const admitted: AdmittedSpawnItem = {
      item: { agent: "spec-check-invoker", task: task(request) },
      taskExecutionSpawn: { kind: "non-implementation" },
      emissionExpectation: { kind: "no-emission-tool" },
    };
    const rosterId = piSpawnRosterId("call-not-enabled", 0, "spec-check-invoker");
    const rawInput = { agent: "spec-check-invoker", task: task(request) };

    await withEnvOverlay({ [RUNS_ROOT_ENV]: runsRoot, [RUN_DIR_ENV]: join(runsRoot, RUN) }, () =>
      recordPiSpawnCorrelators([admitted], [rosterId], "session-not-enabled", rawInput));

    const opened = openRegisteredRunDirectory(runsRoot, RUN);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.readHarnessCorrelator("pi", rosterId))
      .toMatchObject({ ok: true, value: { requestId: request.requestId, admittedEmission: { kind: "not-enabled" } } });
  });
});

describe("admission when the child's route cannot be resolved", () => {
  it("refuses the issued review request as a typed failure naming the served target, never a throw", async () => {
    const routing = await hostileServedRouting();
    cleanups.push(routing.remove);
    const request = agentRequestAuthority(RUN);
    const classified = classifyPiIssuedReviewRequest(RUN, { kind: "wave-gate", schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }, request);
    if (!classified.ok) throw new Error(classified.error.message);
    const qualified = withEnvOverlaySync({ PI_CODING_AGENT_DIR: routing.dir, ...routing.parentEnv }, () =>
      qualifyPiIssuedReviewRequest(classified.value, { role: "code-reviewer", harnessBinding: { pi: DESKTOP_VLLM_ROUTE } }));
    expect(qualified).toEqual({
      ok: false,
      error: { message: expect.stringMatching(/^cannot resolve the routed launch route for agent 'code-reviewer': routing rule everything-to-the-down-server selects target "down", served by provider 'down-vllm', whose model is unknown: cannot reach provider 'down-vllm'/) },
    });
  });
});
