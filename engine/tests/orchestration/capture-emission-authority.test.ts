/**
 * The capture seam's issued emission authority (`reviewerCaptureEmissionAuthority`)
 * judges a Pi child by the decision spawn admission recorded with its
 * correlator, never by a route recomputed at capture time (PR #179 review).
 *
 * A recomputation reads the parent model, `model-routing.json` and a served
 * provider as they are when the result ARRIVES: a model switch, an edited
 * config or a served provider that went down would turn a child dispatched
 * with the emission tool into extraction-only authority and refuse its call
 * as `unexpected-emission-call`. These tests pin the decision to the recorded
 * one under exactly such a hostile routing context — and prove no route was
 * resolved at all, because the served provider's key command never ran.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_VLLM_ROUTE } from "../../src/core/model-profiles";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import type { IssuedReviewerProtocol } from "../../src/core/reviewer-emission-route";
import { reviewerCaptureEmissionAuthority } from "../../src/orchestration/harness-capture-runtime";
import type { AdmittedEmission } from "../../src/orchestration/run-directory-handle";
import { routedChildLaunchRoute } from "../../src/utils/child-launch-route";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { withEnvOverlaySync } from "../fixtures/env-overlay";
import { hostileServedRouting, type HostileServedRouting } from "../fixtures/hostile-served-routing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const PROTOCOL = { ok: true as const, value: { schemaVersion: 2 as const, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL } satisfies IssuedReviewerProtocol };
const REQUEST = agentRequestAuthority("run.capture-authority");
const ENABLED: AdmittedEmission = { kind: "enabled", route: { provider: DESKTOP_VLLM_ROUTE.provider, model: DESKTOP_VLLM_ROUTE.model } };

async function hostile(): Promise<HostileServedRouting> {
  const routing = await hostileServedRouting();
  cleanups.push(routing.remove);
  return routing;
}

const under = <T>(routing: HostileServedRouting, operation: () => T): T =>
  withEnvOverlaySync({ PI_CODING_AGENT_DIR: routing.dir, ...routing.parentEnv }, operation);

describe("capture authority from the recorded admission decision", () => {
  it("control: resolving the child's route live under this context refuses, after running the key command", async () => {
    const routing = await hostile();
    expect(under(routing, () => routedChildLaunchRoute(REQUEST.role)))
      .toMatchObject({ ok: false, error: { kind: "served-model-unknown", cause: { kind: "unreachable" } } });
    expect(routing.keyCommandRan()).toBe(true);
  });

  it("keeps an enabled child's emission authority while the served provider is down and the parent model has switched", async () => {
    const routing = await hostile();
    expect(under(routing, () => reviewerCaptureEmissionAuthority(PROTOCOL, REQUEST, "pi", ENABLED)).kind).toBe("emission");
    expect(routing.keyCommandRan()).toBe(false);
  });

  it("captures a child admission dispatched without the tool as extraction-only, naming the decision", () => {
    expect(reviewerCaptureEmissionAuthority(PROTOCOL, REQUEST, "pi", { kind: "not-enabled" })).toEqual({
      kind: "extraction-only",
      reason: `spawn admission dispatched request ${REQUEST.requestId} without the emission tool`,
    });
  });

  it("qualifies a Pi correlator that recorded no decision against its frozen route alone", async () => {
    const routing = await hostile();
    expect(under(routing, () => reviewerCaptureEmissionAuthority(PROTOCOL, REQUEST, "pi", { kind: "unrecorded" })).kind).toBe("emission");
    expect(routing.keyCommandRan()).toBe(false);
  });

  it("is extraction-only off the qualified route, even when the recorded route claims it", () => {
    const cloud = agentRequestAuthority("run.capture-authority", {
      harnessBinding: { pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, claude: { harness: "claude-code", model: "sonnet" } },
    });
    expect(reviewerCaptureEmissionAuthority(PROTOCOL, cloud, "pi", ENABLED).kind).toBe("extraction-only");
  });

  it("keeps a Claude child extraction-only whatever the correlator records", () => {
    for (const admitted of [ENABLED, { kind: "not-enabled" as const }, { kind: "unrecorded" as const }]) {
      expect(reviewerCaptureEmissionAuthority(PROTOCOL, REQUEST, "claude", admitted).kind).toBe("extraction-only");
    }
  });

  it("leaves a request outside the reviewer contract ineligible", () => {
    const panel = agentRequestAuthority("run.capture-authority", { program: "spec-check" });
    expect(reviewerCaptureEmissionAuthority(PROTOCOL, panel, "pi", ENABLED)).toEqual({ kind: "ineligible" });
  });
});
