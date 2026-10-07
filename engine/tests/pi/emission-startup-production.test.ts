/**
 * T5: the PRODUCTION loom child extension through the real barrier protocol
 * (FR-008 / FR-001 / AD-4). The readiness command, the exact tool
 * registration, the in-child hold and the honest readiness payload all come
 * from the loaded production sources (pi/extension.ts, which wires
 * pi/emission-readiness.ts over pi/emission-tool.ts, via -e) in a real
 * headless pi child. Only the model transport (the counting substitute) and
 * the constrained route's provider registration are infrastructure — the
 * provider substitute registers NO emission tool and NO readiness command, so
 * every readiness behavior observed here is production behavior (AS-005
 * negative controls through the production path). The stale-launcher drift
 * surfaces live on the launcher side (expectation revision, issued request)
 * or on the provisioning boundary (absent/garbage binding env), never on
 * production knobs. The suite also covers the hold's wedge-to-readiness
 * release arc and its shutdown release (through the extension's named
 * `registerLoomEmissionReadiness` seam), and runs the parent bridge's SHIPPED
 * `verifyReadiness` against a real production child through the harness's
 * real-RPC readiness adapter. Both barrier paths cross the one production
 * launcher step sequence (`pi/emission-readiness-sequence.ts`): the shipped
 * verifier as its bridge adapter, and the shared launcher harness's
 * `runLauncherBarrier` (`engine/tests/fixtures/emission-child-harness.ts`) as
 * its real-RPC harness adapter.
 */

import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureLoomRuntimeIdentity } from "../../src/runtime-compatibility";
import { issueEmissionBinding } from "../../src/core/emission-tool";
import { canonicalRecord } from "../../src/core/orchestration-contract/identity";
import {
  EMISSION_HOLD_ENTRY_TYPE,
  LOOM_EMISSION_BINDING_ENV,
} from "../../../pi/emission-tool";
import { EMISSION_READINESS_COMMAND, EMISSION_READINESS_ENTRY_TYPE } from "../../../pi/emission-readiness-protocol";
import {
  EMISSION_STARTUP_REMEDIATIONS,
  parseReadinessReport,
  type EmissionStartupDecision,
  type EmissionStartupExpectation,
  type ReadinessReport,
} from "../../../pi/emission-readiness-gate";
import type { PiEmissionLaunchExpectation } from "../../../pi/emission-launch-bridge";
import type { PiEmissionReadinessRegistration } from "../../../pi/emission-readiness";
import {
  actOnGateVerdict,
  awaitFirstCountedRequest,
  awaitFirstRequestOrDeadline,
  bindRouteWithSettle,
  boundedDiagnostic,
  boundedEvent,
  contextDigestOf,
  customEntriesOf,
  entryDataOf,
  expectOpenRun,
  expectZeroRequestRefusal,
  HOLD_ENTRY_TYPE,
  isolatedPiEnv,
  issuedPromptText,
  makeExpectation,
  nextRequestId,
  observeChannel,
  openPiRpcChild,
  orderingPair,
  piIdentity,
  PRODUCTION_HOLD_FIRST_REQUEST_TIMEOUT_MS,
  PRODUCTION_STATE_TIMEOUT_MS,
  READINESS_COMMAND_NAME,
  READINESS_ENTRY_TYPE,
  readinessAbsentWithinWindow,
  recordOf,
  repoRoot,
  rpcReadinessClient,
  runLauncherBarrier,
  settleWait,
  sleep,
  STALE_REVISION,
  startCountingServer,
  stringifyUnknown,
  withBarrierResources,
  withProcessState,
  type CountingServer,
  type PiReadinessVerifier,
  type PiRpcChild,
  type SettledWait,
} from "../fixtures/emission-child-harness";
import { sha256Hex } from "../../src/core/digest";
import { cellSchemaDigest, JUDGE_V1_CELL, REVIEWER_V2_CELL, type RegistryCell } from "../fixtures/emission-registry-cells";
import {
  bridgeLaunchExpectation,
  issuedLaunchDirective,
} from "../fixtures/emission-launch-port";

const PRODUCTION_EXTENSION_PATH = join(repoRoot, "pi", "extension.ts");

/** The per-run provider substitute: infrastructure for the gate's
 *  fail-closed route binding, registered at session start — proven to fire in
 *  RPC children (the T4 protocol's set_model binding runs after it). */
const productionProviderExtensionSource = (baseUrl: string): string => `/**
 * Emission-startup suite provider substitute (infrastructure, not under test).
 */
export default function (pi) {
  pi.on("session_start", async () => {
    pi.registerProvider("loom-counting", {
      name: "Loom Counting Provider",
      baseUrl: ${JSON.stringify(baseUrl)},
      apiKey: "$LOOM_EMISSION_STARTUP_PROVIDER_KEY",
      api: "openai-completions",
      models: [
        {
          id: "loom-counting-model",
          name: "Loom Counting Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
    });
    return undefined;
  });
}
`;

type ChildProvisioning =
  | Readonly<{ kind: "minted"; cell: RegistryCell; requestId?: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "garbage"; raw: string }>;

/** The one drift a production negative control applies. The production child
 *  itself is never configured: drift lives on the launcher's expectation, on
 *  the provisioning boundary, or on the spawn's --tools allowlist. */
type ProductionDrift =
  /** The issued tool excluded by the real --tools allowlist (honest-inactive). */
  | Readonly<{ kind: "tool-excluded" }>
  /** The child is provisioned for another binding (request or cell), or not at all. */
  | Readonly<{ kind: "provisioning"; provisioning: ChildProvisioning }>
  /** The launcher-side expectation's revision; the production child always
   *  reports its true load identity. */
  | Readonly<{ kind: "expectation-revision"; revision: string }>;

type ProductionScenarioSpec = Readonly<{ label: string; issuedCell: RegistryCell }> & (
  /** A matching child: the gate opens, the prompt is delivered, and the run
   *  waits for its first counted request. `invocations: 2` re-invokes the
   *  readiness command (the idempotence control). */
  | Readonly<{ kind: "matching"; invocations: 1 | 2 }>
  /** A zero-request negative control. */
  | Readonly<{ kind: "negative-control"; drift: ProductionDrift }>
);

/** One production scenario resolved for one run. */
type ProductionPlan = Readonly<{
  provisioning: ChildProvisioning;
  expectationRevision: string;
  allowlist: readonly string[];
  invocations: 1 | 2;
  waitForRequest: boolean;
}>;

const productionPlanOf = (spec: ProductionScenarioSpec): ProductionPlan => {
  const drift = spec.kind === "negative-control" ? spec.drift : null;
  const provisioning: ChildProvisioning = drift?.kind === "provisioning"
    ? drift.provisioning
    : canonicalRecord({ kind: "minted" as const, cell: spec.issuedCell });
  const provisioningCell = provisioning.kind === "minted" ? provisioning.cell : spec.issuedCell;
  return Object.freeze({
    provisioning,
    // The launcher's expectation carries the PARENT's content-addressed
    // revision — never the T4 protocol fixture's placeholder string.
    expectationRevision: drift?.kind === "expectation-revision" ? drift.revision : PARENT_RUNTIME_REVISION,
    allowlist: Object.freeze(drift?.kind === "tool-excluded" ? ["read"] : [provisioningCell.spec.toolName]),
    invocations: spec.kind === "matching" ? spec.invocations : 1,
    waitForRequest: spec.kind === "matching",
  });
};

type ProductionRun = Readonly<{
  label: string;
  decision: EmissionStartupDecision;
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commandListed: boolean;
  invocationCount: number;
  readinessPayloads: readonly unknown[];
  readinessObservedAt: number | null;
  extensionErrors: readonly Readonly<{ event: string; error: string }>[];
  holdEntries: readonly unknown[];
  prompted: boolean;
  firstRequestAt: number | null;
  requestCount: number;
  requestBodies: readonly string[];
  issuedRequestId: string;
  childPid: number | null;
  childKilled: boolean;
  countingBaseUrl: string;
  stderr: string;
}>;

/** The launcher-side provisioning the production child receives: the minted
 *  issued binding (registry-certified claims) plus the context digest — the
 *  same record shape a real barrier provisions with. */
const childProvisioningEnv = (
  expectation: EmissionStartupExpectation,
  issuedRequestId: string,
  provisioning: ChildProvisioning,
): string | undefined => {
  if (provisioning.kind === "absent") return undefined;
  if (provisioning.kind === "garbage") return provisioning.raw;
  const requestId = provisioning.requestId ?? issuedRequestId;
  const contextDigest = requestId === issuedRequestId
    ? expectation.contextDigest
    : contextDigestOf(`emission-startup-context:${requestId}`);
  const minted = issueEmissionBinding({
    requestId,
    kind: provisioning.cell.kind,
    version: provisioning.cell.version,
    toolName: provisioning.cell.spec.toolName,
    schemaDigest: cellSchemaDigest(provisioning.cell),
  });
  if (!minted.ok) {
    throw new Error(`production child provisioning mint refused: ${minted.error.code} — ${minted.error.message}`);
  }
  return JSON.stringify({
    requestId: minted.value.requestId,
    contextDigest,
    kind: minted.value.kind.kind,
    version: minted.value.version,
    toolName: minted.value.toolName,
    schemaDigest: minted.value.schemaDigest,
  });
};

/** The production child's spawn: the production loom extension beside the
 *  per-run provider substitute, provisioned with `envBinding` (absent when
 *  undefined) — any ambient binding is stripped first. */
const openProductionChild = async (
  label: string,
  tmp: string,
  server: CountingServer,
  envBinding: string | undefined,
  allowlist: readonly string[],
): Promise<PiRpcChild> => {
  const providerExtPath = join(tmp, "loom-counting-provider.mjs");
  await writeFile(providerExtPath, productionProviderExtensionSource(server.baseUrl), "utf8");
  const args: string[] = ["--mode", "rpc", "--no-session", "-ne", "-e", PRODUCTION_EXTENSION_PATH, "-e", providerExtPath];
  if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...await isolatedPiEnv(tmp) };
  delete childEnv["PI_CODING_AGENT"];
  delete childEnv[LOOM_EMISSION_BINDING_ENV];
  if (envBinding !== undefined) childEnv[LOOM_EMISSION_BINDING_ENV] = envBinding;
  childEnv["LOOM_EMISSION_STARTUP_PROVIDER_KEY"] = "loom-counting-key";
  return openPiRpcChild({
    role: "production child",
    idPrefix: `t5-${label}`,
    args,
    cwd: tmp,
    env: childEnv,
    responseTimeoutMs: PRODUCTION_STATE_TIMEOUT_MS,
  });
};

/** Every pi command-error event the child emitted, bounded. */
const extensionErrorsOf = (rpc: PiRpcChild): readonly Readonly<{ event: string; error: string }>[] =>
  rpc.bus.snapshot()
    .filter((event) => event.type === "extension_error")
    .map((event) => canonicalRecord({ event: stringifyUnknown(event["event"]), error: stringifyUnknown(event["error"]) }));

/**
 * The production barrier run: the harness's one `runLauncherBarrier`
 * sequence against a child whose extension IS the production loom
 * extension. The production readiness command registers the exact tool and
 * appends the bound payload; its failures surface as extension_error events
 * (pi's command-error channel), never as fabricated payloads — so an
 * unanswered wait over a reported command error is `startup-unavailable`.
 */
const runProductionGate = (spec: ProductionScenarioSpec): Promise<ProductionRun> =>
  withBarrierResources(`loom-emission-startup-t5-${spec.label}-`, async ({ server, tmp, adopt }) => {
    const issuedRequestId = nextRequestId(`t5-${spec.label}`);
    const plan = productionPlanOf(spec);
    const expectation = canonicalRecord({
      ...makeExpectation(spec.issuedCell, issuedRequestId, server.baseUrl),
      revision: plan.expectationRevision,
    });
    const envBinding = childProvisioningEnv(expectation, issuedRequestId, plan.provisioning);
    const rpc = adopt(await openProductionChild(spec.label, tmp, server, envBinding, plan.allowlist));
    const barrier = await runLauncherBarrier(rpc, expectation, {
      invocations: plan.invocations,
      wait: { kind: "waits" },
      unobserved: () => {
        const refusalErrors = extensionErrorsOf(rpc);
        return refusalErrors.length > 0
          ? canonicalRecord({
              kind: "startup-unavailable" as const,
              reason: refusalErrors[refusalErrors.length - 1]!.error,
            })
          : readinessAbsentWithinWindow();
      },
    }, {
      afterPrompt: async () => {
        if (plan.waitForRequest) await awaitFirstRequestOrDeadline(server);
      },
    });
    await rpc.dispose();
    const hits = server.hits;
    return canonicalRecord({
      label: spec.label,
      decision: barrier.decision,
      channelAlive: barrier.channelAlive,
      channelDiagnostic: barrier.channelDiagnostic,
      commandListed: barrier.commandListed,
      invocationCount: barrier.invocationCount,
      readinessPayloads: Object.freeze(customEntriesOf(rpc.bus, READINESS_ENTRY_TYPE).map(entryDataOf)),
      readinessObservedAt: barrier.readinessObservedAt,
      extensionErrors: extensionErrorsOf(rpc),
      holdEntries: Object.freeze(customEntriesOf(rpc.bus, EMISSION_HOLD_ENTRY_TYPE).map(entryDataOf)),
      prompted: barrier.prompted,
      firstRequestAt: hits.length > 0 ? hits[0]!.at : null,
      requestCount: hits.length,
      requestBodies: Object.freeze(hits.map((hit) => hit.body)),
      issuedRequestId,
      childPid: typeof rpc.child.pid === "number" ? rpc.child.pid : null,
      childKilled: rpc.releasedAt() !== null,
      countingBaseUrl: server.baseUrl,
      stderr: rpc.stderr(),
    });
  });

/** One run of the SHIPPED verifier against a real production child. */
type ShippedVerifierRun = Readonly<{
  label: string;
  verdict: Awaited<ReturnType<PiReadinessVerifier>>;
  prompted: boolean;
  requestCount: number;
  readinessPayloads: readonly unknown[];
  childKilled: boolean;
  stderr: string;
}>;

/**
 * The launcher's barrier as the installed launcher runs it: the parent
 * bridge's staged directive provisions the child (its `bindingEnv` IS the
 * child's binding), then the bridge's shipped `verifyReadiness` drives the
 * real child through the real-RPC readiness adapter, and the prompt is
 * delivered only on `ok: true`. The launch pins the per-run counting route;
 * the expectation's revision is the parent runtime's unless a control drifts it.
 */
const runShippedVerifier = (label: string, revision: string): Promise<ShippedVerifierRun> =>
  withBarrierResources(`loom-emission-startup-t5-shipped-${label}-`, async ({ server, tmp, adopt }) => {
    const staged = bridgeLaunchExpectation(JUDGE_V1_CELL, `tool-call-shipped-${label}`, { kind: "single", index: 0 });
    const launch: PiEmissionLaunchExpectation = Object.freeze({
      ...staged,
      revision,
      expectation: Object.freeze({
        ...staged.expectation,
        route: Object.freeze({ provider: "loom-counting", model: "loom-counting-model" }),
      }),
    });
    const directive = issuedLaunchDirective(launch);
    const rpc = adopt(await openProductionChild(`shipped-${label}`, tmp, server, directive.bindingEnv, [launch.expectation.binding.toolName]));
    // The launcher's channel check precedes the verifier: a cold child's
    // first get_state carries the startup budget.
    const channel = await observeChannel(rpc);
    if (!channel.channelAlive) throw new Error(`the production child never came up: ${channel.channelDiagnostic ?? "no diagnostic"}`);
    const verdict = await directive.verifyReadiness(rpcReadinessClient(rpc));
    const acted = await actOnGateVerdict(rpc, launch.expectation, verdict.ok, () => awaitFirstRequestOrDeadline(server));
    rpc.release();
    return canonicalRecord({
      label,
      verdict,
      prompted: acted.prompted,
      requestCount: server.hits.length,
      readinessPayloads: Object.freeze(customEntriesOf(rpc.bus, READINESS_ENTRY_TYPE).map(entryDataOf)),
      childKilled: rpc.releasedAt() !== null,
      stderr: rpc.stderr(),
    });
  });

/** A stale-launcher prompt delivered before readiness must wedge. The
 *  release variant then performs the readiness exchange against that SAME
 *  child and proves the awaited prompt resumes; refusal variants stay wedged
 *  until their own child is killed. */
type ProductionHoldGateSpec = Readonly<{
  label: string;
  issuedCell: RegistryCell;
  provisioning?: ChildProvisioning;
  releaseThroughReadiness?: boolean;
}>;

type HoldPromptResponse =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "succeeded"; diagnostic: string }>
  | Readonly<{ kind: "refused"; diagnostic: string }>
  | Readonly<{ kind: "transport-failed"; diagnostic: string }>;

const holdPromptResponseOf = (outcome: SettledWait): HoldPromptResponse => {
  if (outcome.kind === "failed") {
    return canonicalRecord({ kind: "transport-failed" as const, diagnostic: boundedDiagnostic(outcome.error) });
  }
  return canonicalRecord({
    kind: outcome.event["success"] === true ? "succeeded" as const : "refused" as const,
    diagnostic: boundedEvent(outcome.event),
  });
};

const HOLD_PROBE_WINDOW_MS = 2_500;

const runProductionHoldGate = (spec: ProductionHoldGateSpec): Promise<Readonly<{
  holdPhases: readonly string[];
  childAliveDuringProbe: boolean;
  agentStartCount: number;
  promptResponse: HoldPromptResponse;
  requestCount: number;
  stderr: string;
}>> => withBarrierResources(`loom-emission-startup-t5-${spec.label}-`, async ({ server, tmp, adopt }) => {
  const issuedRequestId = nextRequestId(`t5-${spec.label}`);
  const expectation = makeExpectation(spec.issuedCell, issuedRequestId, server.baseUrl);
  const provisioning = spec.provisioning ?? canonicalRecord({ kind: "minted" as const, cell: spec.issuedCell });
  const envBinding = childProvisioningEnv(expectation, issuedRequestId, provisioning);
  if (envBinding === undefined) throw new Error("the hold control's provisioning env is absent");
  const rpc = adopt(await openProductionChild(`hold-${spec.label}`, tmp, server, envBinding, [spec.issuedCell.spec.toolName]));
  await rpc.rpcRequest({ type: "get_state" }, "get_state");
  // The stale launcher binds the route and delivers the prompt WITHOUT a
  // readiness exchange. Keep the request live so the release variant can
  // prove this exact awaited prompt resumes after readiness.
  await rpc.rpcRequest(
    { type: "set_model", provider: expectation.route.provider, modelId: expectation.route.modelId },
    "stale-launcher set_model",
  );
  await rpc.rpcRequest({ type: "set_auto_retry", enabled: false }, "set_auto_retry");
  let promptResponse: HoldPromptResponse = canonicalRecord({ kind: "pending" as const });
  const promptOutcome = settleWait(rpc.rpcRequest(
    { type: "prompt", message: issuedPromptText(expectation) },
    "stale-launcher prompt delivery",
  )).then((outcome) => {
    promptResponse = holdPromptResponseOf(outcome);
    return outcome;
  });
  await sleep(HOLD_PROBE_WINDOW_MS);
  if (rpc.gone()) {
    throw new Error("the production hold child died or failed to spawn inside the probe window");
  }
  const promptResponseBeforeReadiness: HoldPromptResponse = promptResponse;
  if (spec.releaseThroughReadiness === true) {
    const readinessResponse = await rpc.rpcRequest(
      { type: "prompt", message: `/${EMISSION_READINESS_COMMAND}` },
      "hold-release readiness command",
    );
    if (readinessResponse["success"] !== true) {
      throw new Error(`the hold-release readiness command failed: ${boundedEvent(readinessResponse)}`);
    }
    // The early binding above intentionally models a stale launcher. The
    // provider registry can refresh while readiness registers the tool;
    // mirror the real launcher's post-readiness bind before requiring the
    // first model request from this already-wedged prompt. Otherwise a
    // refreshed default model can receive it instead of the counting route.
    const rebound = await bindRouteWithSettle(rpc.rpcRequest, expectation.route);
    if (rebound.kind !== "bound" || rebound.model.provider !== expectation.route.provider ||
        rebound.model.id !== expectation.route.modelId) {
      throw new Error(`the hold-release route was not rebound after readiness: ${JSON.stringify(rebound)}`);
    }
    const resumed = await promptOutcome;
    if (resumed.kind === "failed") {
      throw new Error(`the wedged prompt did not resume: ${boundedDiagnostic(resumed.error)}; stderr: ${rpc.stderr()}`);
    }
    if (resumed.event["success"] !== true) {
      throw new Error(`the resumed prompt response was refused: ${boundedEvent(resumed.event)}; stderr: ${rpc.stderr()}`);
    }
    await awaitFirstCountedRequest(
      server,
      PRODUCTION_HOLD_FIRST_REQUEST_TIMEOUT_MS,
      () => `prompt response: ${JSON.stringify(promptResponse)}; stderr: ${rpc.stderr()}`,
    );
  }
  await sleep(400);
  if (rpc.gone()) {
    throw new Error("the production hold child died or failed to spawn before the probe completed");
  }
  const holdPhases = customEntriesOf(rpc.bus, EMISSION_HOLD_ENTRY_TYPE)
    .map((event) => recordOf(entryDataOf(event)))
    .map((data) => (data === null ? undefined : data["phase"]))
    .filter((phase): phase is string => typeof phase === "string");
  await rpc.dispose();
  return canonicalRecord({
    holdPhases: Object.freeze(holdPhases),
    childAliveDuringProbe: true,
    agentStartCount: rpc.bus.snapshot().filter((event) => event.type === "agent_start").length,
    promptResponse: spec.releaseThroughReadiness === true ? promptResponse : promptResponseBeforeReadiness,
    requestCount: server.hits.length,
    stderr: rpc.stderr(),
  });
});

const matchingScenario = (
  label: string,
  options: Readonly<{ issuedCell?: RegistryCell; invocations?: 1 | 2 }> = {},
): ProductionScenarioSpec => ({
  label,
  issuedCell: options.issuedCell ?? REVIEWER_V2_CELL,
  kind: "matching",
  invocations: options.invocations ?? 1,
});

const negativeControl = (label: string, drift: ProductionDrift): ProductionScenarioSpec => ({
  label,
  issuedCell: REVIEWER_V2_CELL,
  kind: "negative-control",
  drift,
});

const provisioned = (provisioning: ChildProvisioning): ProductionDrift =>
  canonicalRecord({ kind: "provisioning" as const, provisioning });

/** The parent-side content-addressed runtime identity: the revision the
 *  launcher (the expectation mint) holds. The production child computes the
 *  same identity from the same sources at its own load — the equality is the
 *  FR-031 handshake the readiness report is checked against. */
const PARENT_RUNTIME_REVISION = captureLoomRuntimeIdentity(repoRoot).revision;

const asProvisionedPayload = (run: ProductionRun, index = 0): ReadinessReport => {
  const payload = run.readinessPayloads[index];
  if (payload === undefined) throw new Error(`[${run.label}] no readiness payload at index ${index}`);
  const parsed = parseReadinessReport(payload);
  if (!parsed.ok) throw new Error(`[${run.label}] the production readiness payload violates its contract: ${parsed.error.reason}`);
  return parsed.value;
};

/** A registered handler as the fake records it: kept for identity checks
 *  only — the test drives the seam's named handlers, never these. */
type RegisteredHandler = (...args: never[]) => unknown;

/** The emission readiness host (`PiEmissionReadinessHost`), faked: the
 *  journal refuses hold entries, so every hold marker surfaces as its bounded
 *  stderr diagnostic. */
class EmissionHoldFakePi {
  readonly handlers = new Map<string, RegisteredHandler[]>();
  readonly commands = new Map<string, Readonly<{ handler: RegisteredHandler }>>();
  readonly tools = new Map<string, Readonly<{ name: string }>>();
  readonly entries: Readonly<{ customType: string; data: unknown }>[] = [];

  on(event: string, handler: RegisteredHandler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: Readonly<{ handler: RegisteredHandler }>): void {
    this.commands.set(name, command);
  }

  registerTool(tool: Readonly<{ name: string }>): void {
    this.tools.set(tool.name, tool);
  }

  appendEntry(customType: string, data: unknown): void {
    if (customType === EMISSION_HOLD_ENTRY_TYPE) {
      throw new Error(`hold journal unavailable ${"x".repeat(10_000)}`);
    }
    this.entries.push(Object.freeze({ customType, data }));
  }

  getActiveTools(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }

  getAllTools(): readonly Readonly<{ name: string }>[] {
    return Object.freeze([...this.tools.values()]);
  }
}

/** The one handler the fake recorded for `event`, by identity. */
const soleHandler = (pi: EmissionHoldFakePi, event: string): RegisteredHandler | undefined => {
  const handlers = pi.handlers.get(event) ?? [];
  return handlers.length === 1 ? handlers[0] : undefined;
};

/**
 * Register the production extension's emission readiness through its NAMED
 * seam (`registerLoomEmissionReadiness`, the one the extension factory itself
 * calls) on a fake host provisioned with one minted judge-v1 binding, and run
 * `body` against the returned handlers with stderr captured. No other bridge
 * registers on this host, so no handler is reached by registration position.
 */
const withRegisteredEmissionHold = async (
  label: string,
  body: (pi: EmissionHoldFakePi, registration: PiEmissionReadinessRegistration, stderr: () => string) => Promise<void>,
): Promise<void> => {
  const requestId = nextRequestId(`t5-${label}`);
  const expectation = makeExpectation(JUDGE_V1_CELL, requestId, "http://127.0.0.1:9/v1");
  const rawBinding = childProvisioningEnv(
    expectation,
    requestId,
    canonicalRecord({ kind: "minted" as const, cell: JUDGE_V1_CELL }),
  );
  if (rawBinding === undefined) throw new Error(`the ${label} fixture failed to mint provisioning`);

  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  try {
    await withProcessState({ env: { [LOOM_EMISSION_BINDING_ENV]: rawBinding } }, async () => {
      const { registerLoomEmissionReadiness } = await import("../../../pi/extension");
      const pi = new EmissionHoldFakePi();
      const registration = registerLoomEmissionReadiness(pi);
      // The seam registered exactly its named handlers on the host.
      expect(soleHandler(pi, "before_agent_start")).toBe(registration.holdPrompt);
      expect(soleHandler(pi, "session_shutdown")).toBe(registration.releaseHoldOnShutdown);
      expect(pi.commands.get(EMISSION_READINESS_COMMAND)?.handler).toBe(registration.readinessCommand);
      await body(pi, registration, () => stderr.mock.calls.map(([chunk]) => String(chunk)).join(""));
    });
  } finally {
    stderr.mockRestore();
  }
};

describe(`the PRODUCTION loom child extension through the real barrier protocol on ${piIdentity} (T5; FR-008/FR-001/AD-4)`, { timeout: 75_000 }, () => {
  it("carries the settled protocol names — the production constants and the barrier contract cannot drift apart", () => {
    expect(EMISSION_READINESS_COMMAND).toBe(READINESS_COMMAND_NAME);
    expect(EMISSION_READINESS_ENTRY_TYPE).toBe(READINESS_ENTRY_TYPE);
    expect(EMISSION_HOLD_ENTRY_TYPE).toBe(HOLD_ENTRY_TYPE);
  });

  it("retains bounded refused and transport-failed prompt responses as typed hold diagnostics", () => {
    expect(holdPromptResponseOf({
      kind: "observed",
      event: { type: "response", success: false, error: "provider rejected the resumed prompt", receivedAt: 0 },
    })).toEqual({
      kind: "refused",
      diagnostic: expect.stringContaining("provider rejected the resumed prompt"),
    });
    expect(holdPromptResponseOf({
      kind: "failed",
      error: new Error("RPC response channel closed"),
    })).toEqual({
      kind: "transport-failed",
      diagnostic: expect.stringContaining("RPC response channel closed"),
    });
  });

  it("bounds first-request observation and retains RPC/stderr diagnostics when no request arrives", async () => {
    const server = await startCountingServer();
    try {
      await expect(awaitFirstCountedRequest(
        server,
        25,
        () => "RPC response succeeded; stderr: provider dispatch remained pending",
      )).rejects.toThrow(
        "no counted model request arrived within 25ms; RPC response succeeded; stderr: provider dispatch remained pending",
      );
      expect(server.hits).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("logs a bounded append cause while the production hold remains fail-closed until readiness", async () => {
    await withRegisteredEmissionHold("hold-diagnostic-cause", async (pi, registration, stderr) => {
      let holdSettled = false;
      const heldPrompt = registration.holdPrompt().then(() => {
        holdSettled = true;
      });
      await sleep(20);
      expect(holdSettled).toBe(false);

      await registration.readinessCommand();
      await heldPrompt;
      expect(holdSettled).toBe(true);
      expect(pi.entries.some((entry) => entry.customType === EMISSION_READINESS_ENTRY_TYPE)).toBe(true);

      const diagnostic = stderr();
      expect(diagnostic).toContain("emission hold entered diagnostic append failed (Error: hold journal unavailable");
      expect(diagnostic).toContain("emission hold resolved diagnostic append failed (Error: hold journal unavailable");
      expect(diagnostic).toContain("the hold remains fail-closed");
      expect(diagnostic).toContain("…");
      expect(diagnostic.length).toBeLessThan(1_000);
    });
  });

  it("session shutdown releases an armed emission hold: the wedged prompt settles, the shutdown-released marker is attempted, and re-invocation is inert (AD-4 cleanup arm)", async () => {
    await withRegisteredEmissionHold("hold-shutdown-release", async (_pi, registration, stderr) => {
      let holdSettled = false;
      const heldPrompt = registration.holdPrompt().then(() => {
        holdSettled = true;
      });
      await sleep(20);
      expect(holdSettled).toBe(false);

      // Shutdown with the hold armed: the wedged coroutine resolves. The fake
      // journal refuses hold entries, so the shutdown-released marker
      // surfaces as the bounded stderr diagnostic — the entry emission is
      // attempted even when the journal is unavailable.
      await registration.releaseHoldOnShutdown();
      await heldPrompt;
      expect(holdSettled).toBe(true);

      // A second shutdown is inert: the hold is already released, so exactly
      // one shutdown-released diagnostic is emitted and nothing re-releases.
      await registration.releaseHoldOnShutdown();
      const diagnostic = stderr();
      expect(diagnostic).toContain("emission hold shutdown-released diagnostic append failed (Error: hold journal unavailable");
      expect(diagnostic.match(/shutdown-released diagnostic append failed/g)).toHaveLength(1);
      expect(diagnostic).toContain("the hold remains fail-closed");
    });
  });

  it("the SHIPPED readiness verifier, driven against a real production child through the real-RPC adapter, opens the gate on the bridge's own provisioning and the first model request follows", async () => {
    const run = await runShippedVerifier("matching", PARENT_RUNTIME_REVISION);
    expect(run.verdict, `${run.label}; stderr: ${run.stderr}`).toEqual({ ok: true });
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    // Exactly the one invocation the verifier is allowed.
    expect(run.readinessPayloads).toHaveLength(1);
  });

  it("the SHIPPED readiness verifier refuses a real production child's honest load identity against a stale expected revision, in the gate's vocabulary, with ZERO model requests", async () => {
    const run = await runShippedVerifier("stale-revision", STALE_REVISION);
    if (run.verdict.ok) throw new Error(`[${run.label}] the shipped verifier opened a stale-revision launch; stderr: ${run.stderr}`);
    expect(run.verdict.reason).toContain(STALE_REVISION);
    expect(run.verdict.reason).toContain(EMISSION_STARTUP_REMEDIATIONS["revision-mismatch"]);
    expect(run.prompted).toBe(false);
    expect(run.requestCount).toBe(0);
    expect(run.childKilled).toBe(true);
  });

  it.each([
    { label: "production-matching-judge-v1", cell: JUDGE_V1_CELL, kind: "judge-verdict", version: "v1", toolName: "loom_emit_judge_verdict" },
    { label: "production-matching-reviewer-v2", cell: REVIEWER_V2_CELL, kind: "reviewer-payload", version: "v2", toolName: "loom_emit_reviewer_payload" },
  ] as const)("matching readiness on the $kind $version cell opens the gate, exposes the exact registered tool to the constrained route, and the first model request lands after the readiness observation", async ({ label, cell, kind, version, toolName }) => {
    const run = await runProductionGate(matchingScenario(label, { issuedCell: cell }));
    const open = expectOpenRun(run);
    expect(run.channelAlive).toBe(true);
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    const readiness = asProvisionedPayload(run);
    expect(readiness.requestId).toBe(run.issuedRequestId);
    expect(readiness.kind).toBe(kind);
    expect(readiness.version).toBe(version);
    expect(readiness.toolName).toBe(toolName);
    expect(readiness.schemaDigest).toBe(cellSchemaDigest(cell));
    expect(readiness.active).toBe(true);
    expect(readiness.childPid).toBe(run.childPid);
    expect(readiness.revision).toBe(PARENT_RUNTIME_REVISION);
    expect(readiness.registeredTools).toContain(toolName);
    expect(open.route).toEqual({
      kind: "pinned-endpoint",
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: run.countingBaseUrl,
    });
    // FR-001 on the production path: the provider request carries the exact
    // registered emission tool.
    expect(run.requestBodies[0]).toContain(toolName);
    const { firstRequestAt, readinessObservedAt } = orderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
  });

  it("re-invoking the production readiness command is idempotent — identical payloads, exactly ONE registered emission tool", async () => {
    const run = await runProductionGate(matchingScenario("production-idempotent-reinvocation", { issuedCell: JUDGE_V1_CELL, invocations: 2 }));
    const open = expectOpenRun(run);
    expect(run.invocationCount).toBe(2);
    expect(run.readinessPayloads).toHaveLength(2);
    const [first, second] = [asProvisionedPayload(run, 0), asProvisionedPayload(run, 1)];
    expect(second).toEqual(first);
    // Exactly one emission tool: the idempotent invocation registered nothing
    // twice (the contradictory-refusal state machine guards the rest).
    const emissionTools = first.registeredTools.filter((name) => name.startsWith("loom_emit_"));
    expect(emissionTools).toEqual(["loom_emit_judge_verdict"]);
    expect(open.readiness.requestId).toBe(run.issuedRequestId);
    expect(run.requestCount).toBe(1);
  });

  it("an honestly-inactive tool under a real --tools allowlist exclusion is reported active:false by the production payload and refused with ZERO model requests", async () => {
    const run = await runProductionGate(negativeControl("production-honestly-inactive", { kind: "tool-excluded" }));
    const refusedDecision = expectZeroRequestRefusal(run, "tool-inactive");
    const readiness = asProvisionedPayload(run);
    expect(readiness.active).toBe(false);
    expect(readiness.toolName).toBe("loom_emit_reviewer_payload");
    expect(refusedDecision.message).toContain("--tools");
  });

  it("a production child provisioned for another request is refused as wrong-request with ZERO model requests, the message naming both request ids", async () => {
    const staleRequestId = nextRequestId("t5-production-stale-peer");
    const run = await runProductionGate(negativeControl("production-wrong-request", provisioned(
      canonicalRecord({ kind: "minted" as const, cell: REVIEWER_V2_CELL, requestId: staleRequestId }),
    )));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    const readiness = asProvisionedPayload(run);
    expect(readiness.requestId).toBe(staleRequestId);
    expect(refusedDecision.message).toContain(staleRequestId);
    expect(refusedDecision.message).toContain(run.issuedRequestId);
  });

  it("a production child provisioned for another producer kind is refused as unexpected-kind with ZERO model requests", async () => {
    const run = await runProductionGate(negativeControl("production-wrong-kind", provisioned(canonicalRecord({ kind: "minted" as const, cell: JUDGE_V1_CELL }))));
    const refusedDecision = expectZeroRequestRefusal(run, "unexpected-kind");
    const readiness = asProvisionedPayload(run);
    expect(readiness.kind).toBe("judge-verdict");
    expect(readiness.toolName).toBe("loom_emit_judge_verdict");
    expect(refusedDecision.message).toContain("judge-verdict");
  });

  it("a launcher expecting a stale revision is refused by the production child's honest load identity with ZERO model requests", async () => {
    const run = await runProductionGate(negativeControl("production-stale-revision", { kind: "expectation-revision", revision: STALE_REVISION }));
    const refusedDecision = expectZeroRequestRefusal(run, "revision-mismatch");
    const readiness = asProvisionedPayload(run);
    expect(readiness.revision).not.toBe(STALE_REVISION);
    expect(refusedDecision.message).toContain(STALE_REVISION);
  });

  it("a child with NO provisioned binding refuses the readiness invocation explicitly, emits no readiness, and sends ZERO model requests", async () => {
    const run = await runProductionGate(negativeControl("production-absent-provisioning", provisioned(canonicalRecord({ kind: "absent" as const }))));
    const refusedDecision = expectZeroRequestRefusal(run, "startup-unavailable");
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.readinessPayloads).toHaveLength(0);
    // The explicit refusal surfaced on pi's command-error channel and is the
    // parent-facing startup-unavailable decision, never a generic timeout.
    const readinessError = run.extensionErrors.map((error) => error.error).join(" | ");
    expect(readinessError).toContain(LOOM_EMISSION_BINDING_ENV);
    expect(readinessError).toContain("Remediation: the launcher barrier provisions the issued emission binding before readiness.");
    expect(refusedDecision.message).toContain(LOOM_EMISSION_BINDING_ENV);
  });

  it("a child whose provisioned claims select no frozen registry cell refuses with the mint's code and ZERO model requests", async () => {
    const run = await runProductionGate(negativeControl("production-garbage-provisioning", provisioned(canonicalRecord({
      kind: "garbage" as const,
      raw: JSON.stringify({ requestId: "req-t5-garbage-1", contextDigest: sha256Hex("ctx"), kind: "no-such-kind", version: "v1" }),
    }))));
    const refusedDecision = expectZeroRequestRefusal(run, "startup-unavailable");
    expect(run.readinessPayloads).toHaveLength(0);
    const readinessError = run.extensionErrors.map((error) => error.error).join(" | ");
    expect(readinessError).toContain("unknown-producer-kind");
    expect(readinessError).toContain("Remediation: respawn the child with the issued emission binding.");
    expect(refusedDecision.message).toContain("unknown-producer-kind");
  });

  it("a prompt delivered before the readiness exchange wedges on the production hold with ZERO model requests and zero agent starts (AD-4)", async () => {
    const run = await runProductionHoldGate({ label: "production-hold-gates", issuedCell: JUDGE_V1_CELL });
    expect(run.childAliveDuringProbe).toBe(true);
    expect(run.holdPhases).toEqual(["entered"]);
    expect(run.agentStartCount).toBe(0);
    expect(run.promptResponse).toEqual({ kind: "pending" });
    expect(run.requestCount).toBe(0);
  });

  it("a provisioning-refused child also wedges a delivered prompt with ZERO model requests", async () => {
    const run = await runProductionHoldGate({
      label: "production-refused-hold-gates",
      issuedCell: JUDGE_V1_CELL,
      provisioning: canonicalRecord({
        kind: "garbage" as const,
        raw: JSON.stringify({ requestId: "req-t5-hold-garbage", contextDigest: sha256Hex("ctx"), kind: "no-such-kind", version: "v1" }),
      }),
    });
    expect(run.childAliveDuringProbe).toBe(true);
    expect(run.holdPhases).toEqual(["entered"]);
    expect(run.agentStartCount).toBe(0);
    expect(run.promptResponse).toEqual({ kind: "pending" });
    expect(run.requestCount).toBe(0);
  });

  it("readiness releases the already-wedged prompt, appends the resolved marker, and permits its first model request", { timeout: 150_000 }, async () => {
    const run = await runProductionHoldGate({
      label: "production-hold-readiness-release",
      issuedCell: JUDGE_V1_CELL,
      releaseThroughReadiness: true,
    });
    expect(run.childAliveDuringProbe).toBe(true);
    expect(run.holdPhases).toEqual(["entered", "resolved"]);
    expect(run.agentStartCount).toBe(1);
    expect(run.promptResponse.kind).toBe("succeeded");
    if (run.promptResponse.kind === "succeeded") {
      expect(run.promptResponse.diagnostic).toContain('"success":true');
    }
    expect(run.requestCount, `prompt response: ${JSON.stringify(run.promptResponse)}; stderr: ${run.stderr}`).toBe(1);
  });
});
