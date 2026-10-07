/**
 * The emission-startup barrier protocol against a REAL headless pi child
 * (FR-008 / AS-020 / AD-4): an emission-enabled Pi child MUST NOT send a model
 * request before its ACTUAL registered-and-active emission tool matches the
 * issued request, producer kind, version and schema digest. Startup
 * observation is bounded and fails explicitly on absent or contradictory
 * readiness — without consuming semantic evidence retry authority.
 *
 * The seam is the probe-proven one (`probes/emission-readiness/`, PROBE PASS
 * 4/4 twice on installed pi 0.83.0; the same primitives exist in the
 * repo-resolved runtime and are re-proven here on every run): a real headless
 * `pi --mode rpc` child spawned with NO prompt, `get_state` as the channel
 * check (distinguishing "child up, readiness missing" from "child never came
 * up"), `get_commands` discovery BEFORE any invocation (an unknown /command
 * would fall through to a real model request — the launcher must never invoke
 * an unverified command), the readiness command invoked via the RPC prompt
 * command (extension commands execute without a model request), the bound
 * readiness payload through `entry_appended`, the pure gate decision, a
 * fail-closed `set_model` route binding, prompt delivery only on match, and
 * the in-child awaited `before_agent_start` hold as the defense-in-depth
 * layer. The child here is the probe-adapted fixture extension below; the
 * PRODUCTION extension repeats the protocol in
 * `emission-startup-production.test.ts`. Both suites drive the one barrier
 * sequence (`runLauncherBarrier`) of the shared launcher harness,
 * `engine/tests/fixtures/emission-child-harness.ts`.
 *
 * Covered: matching opens on the judge-v1 and reviewer-v2 cells; held
 * ordering; the zero-request negative controls (including an active,
 * digest-matching tool under a DRIFTED name and a readiness bound to a
 * foreign context digest — both discriminating only through the real
 * protocol); the bounded-observation law (a readiness entry arriving AFTER the
 * bounded window cannot reopen the decided barrier); the misbinding
 * precedence END-TO-END (a child provisioned for a stale peer's request AND a
 * different producer kind refuses wrong-request, never its capability
 * mismatch); the fail-closed route bind observed live (a bound route drifting
 * from the expected constrained endpoint, and a child with NO registered
 * provider — both refused before any prompt after matching readiness); the
 * infrastructure-failure boundary (a child that dies mid-readiness throws as
 * infrastructure, never a minted refusal, with ZERO counted model requests);
 * cancellation; and concurrent isolation (AS-020: only the refusing child's
 * own reservation is released).
 */

import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMISSION_CONSTRAINED_SAMPLING_REQUEST } from "../../src/core/emission-tool";
import { canonicalRecord, type ContextDigest } from "../../src/core/orchestration-contract/identity";
import type { PayloadProducerKindName } from "../../src/core/agent-catalog-projections";
import type { EmissionStartupDecision } from "../../../pi/emission-readiness-gate";
import {
  CANCEL_AFTER_MS,
  contextDigestOf,
  CURRENT_REVISION,
  customEntriesOf,
  deferred,
  expectOpenRun,
  expectZeroRequestRefusal,
  HOLD_MS,
  HOLD_ORDERING_SLACK_MS,
  HOLD_RELEASE_CAP_MS,
  HOLD_RESOLVE_TIMEOUT_MS,
  holdResolvedPredicate,
  isolatedPiEnv,
  makeExpectation,
  nextRequestId,
  openPiRpcChild,
  orderingPair,
  piIdentity,
  READINESS_COMMAND_NAME,
  READINESS_ENTRY_TYPE,
  readinessAbsentWithinWindow,
  READY_TIMEOUT_MS,
  recordOf,
  runLauncherBarrier,
  sleep,
  SLOW_READINESS_MS,
  STALE_REVISION,
  STATE_TIMEOUT_MS,
  awaitFirstRequestOrDeadline,
  withBarrierResources,
  type LauncherReadinessWait,
} from "../fixtures/emission-child-harness";
import { cellSchemaBytes, cellSchemaDigest, JUDGE_V1_CELL, REVIEWER_V2_CELL, type RegistryCell } from "../fixtures/emission-registry-cells";

/**
 * The child-side extension — adapted from the committed
 * `probes/emission-readiness/probe-extension.mjs` (PROBE PASS 4/4): the
 * counting provider and the ISSUED emission tool are registered inside the
 * readiness command (pi queues action methods at load time — never at factory
 * top level), the readiness payload is emitted via `appendEntry` →
 * `entry_appended` at gate time, the `held` variant proves the awaited
 * `before_agent_start` hold, and every scenario behavior is env-driven so the
 * SAME bytes serve all variants. The constrained-sampling request is the
 * shared production vocabulary, interpolated — the child registers with the
 * exact object production registers with.
 */
const CHILD_EXTENSION_SOURCE = `/**
 * Emission-startup suite child extension (probe-adapted). Env-driven; silent
 * on stdout — the RPC stream must carry only protocol JSON.
 */
import { createHash } from "node:crypto";

const env = process.env;
const VARIANT = env.EMISSION_STARTUP_VARIANT || "matching";
const READINESS_COMMAND = env.EMISSION_STARTUP_READINESS_COMMAND || "loom-emission-readiness";
const TOOL_NAME = env.EMISSION_STARTUP_TOOL_NAME || "";
const FROZEN_SCHEMA_TEXT = env.EMISSION_STARTUP_SCHEMA || "";
const STALE_SCHEMA_TEXT = env.EMISSION_STARTUP_STALE_SCHEMA || "";
const BINDING = JSON.parse(env.EMISSION_STARTUP_CHILD_BINDING || "{}");
const COUNT_BASE_URL = env.EMISSION_STARTUP_COUNT_BASE_URL || "";
const HOLD_MS = Number(env.EMISSION_STARTUP_HOLD_MS || "700");
const SLOW_READINESS_MS = Number(env.EMISSION_STARTUP_SLOW_READINESS_MS || "0");
const CONSTRAINED_SAMPLING = ${JSON.stringify(EMISSION_CONSTRAINED_SAMPLING_REQUEST)};
const READINESS_ENTRY_TYPE = "loom-emission-readiness";
const HOLD_ENTRY_TYPE = "loom-emission-hold";

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function (pi) {
  if (VARIANT === "held") {
    pi.on("before_agent_start", async () => {
      pi.appendEntry(HOLD_ENTRY_TYPE, { phase: "entered" });
      await sleep(HOLD_MS);
      pi.appendEntry(HOLD_ENTRY_TYPE, { phase: "resolved" });
      return undefined;
    });
  }
  if (VARIANT === "stale-extension") {
    pi.registerCommand(READINESS_COMMAND + "-v0-stale", {
      description: "stale extension build: the expected readiness command is absent",
      handler: async () => undefined,
    });
    return;
  }
  pi.registerCommand(READINESS_COMMAND, {
    description: "Emission readiness: register the issued tool, verify active, report.",
    handler: async () => {
      if (SLOW_READINESS_MS > 0) {
        setTimeout(() => { void reportReadiness(pi); }, SLOW_READINESS_MS);
        return undefined;
      }
      return reportReadiness(pi);
    },
  });
}

async function reportReadiness(pi) {
  const registeredBytes = VARIANT === "wrong-digest" ? STALE_SCHEMA_TEXT : FROZEN_SCHEMA_TEXT;
  if (VARIANT === "no-provider") {
    // The route-bind-absent control: an honestly matching readiness payload
    // about a child that never registered the constrained provider — the
    // gate's fail-closed bind must refuse before any prompt.
  } else {
  pi.registerProvider("loom-counting", {
    name: "Loom Counting Provider",
    baseUrl: COUNT_BASE_URL,
    apiKey: "$EMISSION_STARTUP_COUNT_KEY",
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
  }
  pi.registerTool({
    name: TOOL_NAME,
    label: "Loom Emission Tool",
    description: "Emit the issued structured payload.",
    parameters: JSON.parse(registeredBytes),
    constrainedSampling: CONSTRAINED_SAMPLING,
    async execute(_toolCallId, params) {
      pi.appendEntry("loom-emission-args", { tool: TOOL_NAME, args: params });
      return { content: [{ type: "text", text: "payload acknowledged" }], details: {}, terminate: true };
    },
  });
  if (VARIANT === "silent") return undefined;
  const payload = VARIANT === "malformed"
    ? { emitted: "legacy-shape", note: "a stale extension emitted an incompatible readiness payload" }
    : {
        requestId: BINDING.requestId,
        contextDigest: BINDING.contextDigest,
        kind: BINDING.kind,
        version: BINDING.version,
        toolName: TOOL_NAME,
        schemaDigest: sha256Hex(registeredBytes),
        revision: BINDING.revision,
        active: pi.getActiveTools().includes(TOOL_NAME),
        childPid: process.pid,
        registeredTools: pi.getAllTools().map((tool) => tool.name),
      };
  pi.appendEntry(READINESS_ENTRY_TYPE, payload);
  return undefined;
}
`;

// ---------------------------------------------------------------------------
// The scenario ADT: one closed description of the spawned child and the
// launcher's intervention — every knob lives on the arm that reads it
// ---------------------------------------------------------------------------

/** How the launcher behaves while a SLOW child's readiness is pending: waits
 *  the window out (the late-readiness control), cancels (the cancellation
 *  control), or kills the child (the infrastructure-failure boundary). */
type SlowReadinessLauncher = LauncherReadinessWait;

/** What the loaded fixture extension's readiness command does. */
type ChildReadiness =
  | Readonly<{ kind: "honest" }>
  /** Honest readiness behind an awaited `before_agent_start` hold; the
   *  launcher waits for the hold's resolution after prompting. */
  | Readonly<{ kind: "held" }>
  /** Registers the frozen schema plus one marker property: a DIFFERENT digest. */
  | Readonly<{ kind: "stale-schema" }>
  | Readonly<{ kind: "malformed" }>
  /** Registers everything but never reports readiness. */
  | Readonly<{ kind: "silent" }>
  /** Honest readiness about a child that never registered the provider. */
  | Readonly<{ kind: "no-provider" }>
  /** Honest readiness, but the provider is registered under a drifted base
   *  URL — the live fail-closed route bind's drift surface. */
  | Readonly<{ kind: "drifted-provider"; baseUrl: string }>
  /** Reports readiness only after `delayMs`. */
  | Readonly<{ kind: "slow"; delayMs: number; launcher: SlowReadinessLauncher }>;

/** The one identity drift a loaded child carries against the issued request. */
type ChildDrift =
  | Readonly<{ kind: "none" }>
  /** The child's OWN registration cell — the wrong-kind surface. */
  | Readonly<{ kind: "registers-cell"; cell: RegistryCell }>
  | Readonly<{ kind: "claims-version"; version: string }>
  /** Bound to another request (its context digest derived from that id). */
  | Readonly<{ kind: "bound-to-request"; requestId: string }>
  /** The ISSUED request id beside a foreign context digest. */
  | Readonly<{ kind: "foreign-context-digest"; contextDigest: ContextDigest }>
  | Readonly<{ kind: "stale-revision"; revision: string }>
  /** The FROZEN schema registered — active — under a drifted tool name. */
  | Readonly<{ kind: "drifted-tool-name"; toolName: string }>
  /** The issued tool excluded by the real spawn-time --tools allowlist. */
  | Readonly<{ kind: "tool-excluded" }>
  /** Bound to another request AND registered for another cell. */
  | Readonly<{ kind: "misbound"; requestId: string; cell: RegistryCell }>;

type ChildSpec =
  /** No child extension is loaded at all. */
  | Readonly<{ kind: "absent-extension" }>
  /** A stale extension build registering only a renamed readiness command. */
  | Readonly<{ kind: "stale-extension" }>
  | Readonly<{ kind: "loaded"; readiness: ChildReadiness; drift: ChildDrift }>;

type ScenarioSpec = Readonly<{
  label: string;
  issuedCell: RegistryCell;
  child: ChildSpec;
  /** Hold this run's own release open until the promise settles — the AS-020
   *  control keeps the matching child mid-flight across a peer's release. */
  holdRelease?: Promise<void>;
}>;

/** The fixture extension's env-driven variant vocabulary. */
type ChildVariant = "matching" | "held" | "wrong-digest" | "malformed" | "silent" | "stale-extension" | "slow" | "no-provider";

type ChildBinding = Readonly<{
  requestId: string;
  contextDigest: ContextDigest;
  kind: PayloadProducerKindName;
  version: string;
  revision: string;
}>;

/** One scenario resolved for one run: everything the runner reads, decided
 *  once from the ADT, so no runner step consults an optional knob. */
type ChildPlan = Readonly<{
  loadsExtension: boolean;
  variant: ChildVariant;
  /** The cell whose schema the child registers. */
  cell: RegistryCell;
  toolName: string;
  binding: ChildBinding;
  allowlist: readonly string[];
  /** The provider base URL; `null` registers it at the run's counting server. */
  driftedBaseUrl: string | null;
  readinessDelayMs: number;
  launcher: SlowReadinessLauncher;
  waitForHold: boolean;
}>;

const readinessVariant = (readiness: ChildReadiness): ChildVariant => {
  switch (readiness.kind) {
    case "honest":
    case "drifted-provider":
      return "matching";
    case "held":
      return "held";
    case "stale-schema":
      return "wrong-digest";
    case "malformed":
    case "silent":
    case "no-provider":
    case "slow":
      return readiness.kind;
  }
};

function childPlanOf(spec: ScenarioSpec, issuedRequestId: string): ChildPlan {
  const child = spec.child;
  const readiness: ChildReadiness = child.kind === "loaded" ? child.readiness : { kind: "honest" };
  const drift: ChildDrift = child.kind === "loaded" ? child.drift : { kind: "none" };
  const cell = drift.kind === "registers-cell" || drift.kind === "misbound" ? drift.cell : spec.issuedCell;
  const requestId = drift.kind === "bound-to-request" || drift.kind === "misbound" ? drift.requestId : issuedRequestId;
  const toolName = drift.kind === "drifted-tool-name" ? drift.toolName : cell.spec.toolName;
  const allowlist = drift.kind === "tool-excluded" ? ["read"] : [toolName];
  return Object.freeze({
    loadsExtension: child.kind !== "absent-extension",
    variant: child.kind === "stale-extension" ? "stale-extension" : readinessVariant(readiness),
    cell,
    toolName,
    binding: canonicalRecord({
      requestId,
      contextDigest: drift.kind === "foreign-context-digest"
        ? drift.contextDigest
        : contextDigestOf(`emission-startup-context:${requestId}`),
      kind: cell.kind,
      version: drift.kind === "claims-version" ? drift.version : cell.version,
      revision: drift.kind === "stale-revision" ? drift.revision : CURRENT_REVISION,
    }),
    allowlist: Object.freeze(allowlist),
    driftedBaseUrl: readiness.kind === "drifted-provider" ? readiness.baseUrl : null,
    readinessDelayMs: readiness.kind === "slow" ? readiness.delayMs : 0,
    launcher: readiness.kind === "slow" ? readiness.launcher : { kind: "waits" as const },
    waitForHold: readiness.kind === "held",
  });
}

const childEnvFor = (countingBaseUrl: string, plan: ChildPlan): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["PI_CODING_AGENT"];
  env["EMISSION_STARTUP_VARIANT"] = plan.variant;
  env["EMISSION_STARTUP_READINESS_COMMAND"] = READINESS_COMMAND_NAME;
  env["EMISSION_STARTUP_TOOL_NAME"] = plan.toolName;
  env["EMISSION_STARTUP_SCHEMA"] = cellSchemaBytes(plan.cell);
  env["EMISSION_STARTUP_STALE_SCHEMA"] = plan.variant === "wrong-digest" ? staleSchemaBytes(cellSchemaBytes(plan.cell)) : "";
  env["EMISSION_STARTUP_CHILD_BINDING"] = JSON.stringify(plan.binding);
  env["EMISSION_STARTUP_COUNT_BASE_URL"] = plan.driftedBaseUrl ?? countingBaseUrl;
  env["EMISSION_STARTUP_COUNT_KEY"] = "loom-counting-key";
  env["EMISSION_STARTUP_HOLD_MS"] = String(HOLD_MS);
  env["EMISSION_STARTUP_SLOW_READINESS_MS"] = String(plan.readinessDelayMs);
  return env;
};

/** The stale schema a drifted child registers: the frozen bytes plus one
 *  marker property — still a valid tool schema, a DIFFERENT digest. */
const staleSchemaBytes = (schemaBytes: string): string => {
  const parsed = recordOf(JSON.parse(schemaBytes));
  if (parsed === null) throw new Error("the frozen schema bytes are not a JSON object");
  const properties = recordOf(parsed["properties"]);
  return JSON.stringify({ ...parsed, properties: { ...(properties ?? {}), staleDriftMarker: { type: "string" } } });
};

type StartupRun = Readonly<{
  label: string;
  decision: EmissionStartupDecision;
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commandListed: boolean;
  commandsSeen: readonly string[];
  invocationCount: number;
  readinessPayload: unknown;
  readinessObservedAt: number | null;
  /** Readiness entries that arrived AFTER the gate decision — the bounded-
   *  observation control proves a late observation cannot reopen a decided
   *  barrier (zero of them may ever induce a prompt or a model request). */
  readinessEntriesAfterDecision: number;
  prompted: boolean;
  holdResolvedAt: number | null;
  firstRequestAt: number | null;
  requestCount: number;
  issuedRequestId: string;
  countingBaseUrl: string;
  childPid: number | null;
  childKilled: boolean;
  releasedAt: number | null;
  stderr: string;
}>;

type StartedGate = Readonly<{
  result: Promise<StartupRun>;
  childReady: Promise<ChildProcess | null>;
  /** Settles when the gate decision exists (or the run already settled) —
   *  the AS-020 control's mid-flight synchronization point. */
  gateDecided: Promise<void>;
}>;

/** The commands discovery reported, as `name (source)` diagnostics. */
const commandsSeenOf = (commands: readonly Record<string, unknown>[]): readonly string[] =>
  Object.freeze(commands.flatMap((command) =>
    typeof command["name"] === "string" && typeof command["source"] === "string"
      ? [`${command["name"]} (${command["source"]})`]
      : []));

/**
 * Run the launcher barrier protocol against a REAL headless pi child — the
 * harness's one `runLauncherBarrier` sequence inside the lifecycle bracket,
 * which cleans up exactly this child and this counting server in every
 * outcome (AS-020's release discipline: only the refusing run's own
 * reservation is released).
 */
const startStartupGate = (spec: ScenarioSpec): StartedGate => {
  const childReady = deferred<ChildProcess | null>();
  const decisionMade = deferred<void>();
  const result = withBarrierResources(`loom-emission-startup-${spec.label}-`, async ({ server, tmp, adopt }): Promise<StartupRun> => {
    const issuedRequestId = nextRequestId(spec.label);
    const expectation = makeExpectation(spec.issuedCell, issuedRequestId, server.baseUrl);
    const plan = childPlanOf(spec, issuedRequestId);
    const extPath = join(tmp, "loom-emission-child.mjs");
    await writeFile(extPath, CHILD_EXTENSION_SOURCE, "utf8");
    const args: string[] = ["--mode", "rpc", "--no-session", "-ne"];
    if (plan.loadsExtension) args.push("-e", extPath);
    if (plan.allowlist.length > 0) args.push("--tools", plan.allowlist.join(","));
    const rpc = adopt(openPiRpcChild({
      role: "pi child",
      idPrefix: `t4-${spec.label}`,
      args,
      cwd: tmp,
      env: { ...childEnvFor(server.baseUrl, plan), ...await isolatedPiEnv(tmp) },
      responseTimeoutMs: STATE_TIMEOUT_MS,
    }));
    childReady.resolve(rpc.child);

    const barrier = await runLauncherBarrier(
      rpc,
      expectation,
      { invocations: 1, wait: plan.launcher, unobserved: readinessAbsentWithinWindow },
      {
        onDecided: () => decisionMade.resolve(),
        afterPrompt: async (): Promise<number | null> => {
          let holdResolvedAt: number | null = null;
          if (plan.waitForHold) {
            await rpc.bus.waitFor(holdResolvedPredicate, HOLD_RESOLVE_TIMEOUT_MS, "hold resolution");
            holdResolvedAt = Date.now();
          }
          await awaitFirstRequestOrDeadline(server);
          return holdResolvedAt;
        },
      },
    );

    // 6. The launcher's own release: the barrier is decided, so this child's
    //    reservation is released (the bracket is only the safety net). A held
    //    release keeps the child mid-flight across a peer's release (the
    //    AS-020 concurrent-isolation observation point), capped so a lost
    //    test can never wedge the run.
    if (spec.holdRelease !== undefined) {
      await Promise.race([spec.holdRelease, sleep(HOLD_RELEASE_CAP_MS)]);
    }
    rpc.release();

    const hits = server.hits;
    return canonicalRecord({
      label: spec.label,
      decision: barrier.decision,
      channelAlive: barrier.channelAlive,
      channelDiagnostic: barrier.channelDiagnostic,
      commandListed: barrier.commandListed,
      commandsSeen: commandsSeenOf(barrier.commands),
      invocationCount: barrier.invocationCount,
      readinessPayload: barrier.readiness.kind === "observed" ? barrier.readiness.payload : null,
      readinessObservedAt: barrier.readinessObservedAt,
      readinessEntriesAfterDecision: customEntriesOf(rpc.bus, READINESS_ENTRY_TYPE)
        .filter((event) => event.receivedAt > barrier.decidedAt).length,
      prompted: barrier.prompted,
      holdResolvedAt: barrier.afterPrompt ?? null,
      firstRequestAt: hits.length > 0 ? hits[0]!.at : null,
      requestCount: hits.length,
      issuedRequestId,
      countingBaseUrl: server.baseUrl,
      childPid: typeof rpc.child.pid === "number" ? rpc.child.pid : null,
      childKilled: rpc.releasedAt() !== null,
      releasedAt: rpc.releasedAt(),
      stderr: rpc.stderr(),
    });
  });
  // A run that fails before (or while) spawning never resolves its child.
  void result.catch(() => childReady.resolve(null));
  return {
    result,
    childReady: childReady.promise,
    gateDecided: Promise.race([decisionMade.promise, result.then(() => undefined, () => undefined)]),
  };
};

const runStartupGate = async (spec: ScenarioSpec): Promise<StartupRun> => (await startStartupGate(spec)).result;

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

const HONEST: ChildReadiness = Object.freeze({ kind: "honest" });
const NO_DRIFT: ChildDrift = Object.freeze({ kind: "none" });

const loadedChild = (readiness: ChildReadiness = HONEST, drift: ChildDrift = NO_DRIFT): ChildSpec =>
  Object.freeze({ kind: "loaded", readiness, drift });

const driftedChild = (drift: ChildDrift): ChildSpec => loadedChild(HONEST, drift);

const scenario = (
  label: string,
  child: ChildSpec = loadedChild(),
  options: Readonly<{ issuedCell?: RegistryCell; holdRelease?: Promise<void> }> = {},
): ScenarioSpec => ({
  label,
  issuedCell: options.issuedCell ?? REVIEWER_V2_CELL,
  child,
  ...(options.holdRelease === undefined ? {} : { holdRelease: options.holdRelease }),
});

// ---------------------------------------------------------------------------
// The real-child scenarios — counting-provider substitute, zero-request
// negative controls, release isolation (FR-008 / AS-020)
// ---------------------------------------------------------------------------

describe(`emission-startup barrier against a real headless pi child on ${piIdentity} — counting-provider substitute`, { timeout: 60_000 }, () => {
  it("resolves every scenario into one plan — each drift and readiness knob read on exactly one arm", () => {
    const issued = "req-plan-issued";
    const honest = childPlanOf(scenario("plan-honest"), issued);
    expect(honest).toMatchObject({
      loadsExtension: true,
      variant: "matching",
      toolName: REVIEWER_V2_CELL.spec.toolName,
      allowlist: [REVIEWER_V2_CELL.spec.toolName],
      driftedBaseUrl: null,
      readinessDelayMs: 0,
      launcher: { kind: "waits" },
      waitForHold: false,
      binding: {
        requestId: issued,
        contextDigest: contextDigestOf(`emission-startup-context:${issued}`),
        kind: "reviewer-payload",
        version: "v2",
        revision: CURRENT_REVISION,
      },
    });
    const misbound = childPlanOf(scenario("plan-misbound", driftedChild({ kind: "misbound", requestId: "req-peer", cell: JUDGE_V1_CELL })), issued);
    expect(misbound.binding).toMatchObject({ requestId: "req-peer", kind: "judge-verdict", version: "v1" });
    expect(misbound.binding.contextDigest).toBe(contextDigestOf("emission-startup-context:req-peer"));
    expect(misbound.toolName).toBe(JUDGE_V1_CELL.spec.toolName);
    const drifted = childPlanOf(scenario("plan-drifted", driftedChild({ kind: "drifted-tool-name", toolName: "loom_emit_x" })), issued);
    expect(drifted).toMatchObject({ toolName: "loom_emit_x", allowlist: ["loom_emit_x"], cell: REVIEWER_V2_CELL });
    expect(childPlanOf(scenario("plan-absent", { kind: "absent-extension" }), issued).loadsExtension).toBe(false);
    expect(childPlanOf(scenario("plan-stale", { kind: "stale-extension" }), issued).variant).toBe("stale-extension");
    const slow = childPlanOf(scenario("plan-slow", loadedChild({ kind: "slow", delayMs: 9, launcher: { kind: "cancels", afterMs: 3 } })), issued);
    expect(slow).toMatchObject({ variant: "slow", readinessDelayMs: 9, launcher: { kind: "cancels", afterMs: 3 } });
  });

  it.each([
    { label: "matching-judge-v1", cell: JUDGE_V1_CELL, kind: "judge-verdict", version: "v1", toolName: "loom_emit_judge_verdict" },
    { label: "matching-reviewer-v2", cell: REVIEWER_V2_CELL, kind: "reviewer-payload", version: "v2", toolName: "loom_emit_reviewer_payload" },
  ] as const)("matching readiness on the $kind $version cell opens the gate, and the first model request lands after the readiness observation (FR-008)", async ({ label, cell, kind, version, toolName }) => {
    const run = await runStartupGate(scenario(label, loadedChild(), { issuedCell: cell }));
    const open = expectOpenRun(run);
    expect(run.channelAlive).toBe(true);
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    const { firstRequestAt, readinessObservedAt } = orderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    expect(open.readiness.requestId).toBe(run.issuedRequestId);
    expect(open.readiness.kind).toBe(kind);
    expect(open.readiness.version).toBe(version);
    expect(open.readiness.toolName).toBe(toolName);
    expect(open.readiness.schemaDigest).toBe(cellSchemaDigest(cell));
    expect(open.readiness.active).toBe(true);
    expect(open.readiness.childPid).toBe(run.childPid);
    expect(open.route).toEqual({
      kind: "pinned-endpoint",
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: run.countingBaseUrl,
    });
  });

  it("the in-child before_agent_start hold delays the first model request until the hold resolves — defense-in-depth ordering (AD-4)", async () => {
    const run = await runStartupGate(scenario("held", loadedChild({ kind: "held" })));
    expectOpenRun(run);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    if (run.holdResolvedAt === null) throw new Error(`[${run.label}] the hold-resolution marker was never observed`);
    const { firstRequestAt, readinessObservedAt } = orderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    expect(firstRequestAt).toBeGreaterThanOrEqual(run.holdResolvedAt - HOLD_ORDERING_SLACK_MS);
  });

  it("a child whose registered schema digest contradicts the issued frozen schema is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("wrong-digest", loadedChild({ kind: "stale-schema" })));
    const refusedDecision = expectZeroRequestRefusal(run, "schema-digest-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    expect(run.invocationCount).toBe(1);
    expect(refusedDecision.message).toContain("digest");
  });

  it("a child claiming a schema version outside the issued binding is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("wrong-version", driftedChild({ kind: "claims-version", version: "v9" })));
    const refusedDecision = expectZeroRequestRefusal(run, "unexpected-version");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain("v9");
  });

  it("a child activated for a different producer kind is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("wrong-kind", driftedChild({ kind: "registers-cell", cell: JUDGE_V1_CELL })));
    const refusedDecision = expectZeroRequestRefusal(run, "unexpected-kind");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["kind"]).toBe("judge-verdict");
    expect(refusedDecision.message).toContain("judge-verdict");
  });

  it("a child still bound to a stale request is refused with ZERO model requests, the message naming both request ids (AS-020)", async () => {
    const staleRequestId = nextRequestId("stale-peer");
    const run = await runStartupGate(scenario("wrong-request", driftedChild({ kind: "bound-to-request", requestId: staleRequestId })));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    expect(run.readinessPayload).not.toBeNull();
    expect(recordOf(run.readinessPayload)?.["contextDigest"]).toBe(contextDigestOf(`emission-startup-context:${staleRequestId}`));
    expect(refusedDecision.message).toContain(staleRequestId);
    expect(refusedDecision.message).toContain(run.issuedRequestId);
  });

  it("a child binding the ISSUED request id to a foreign context digest is refused as wrong-request with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("foreign-context-digest", driftedChild({
      // Same request id, different context digest: the wrong-request bind is
      // BOTH identity fields, and the digest arm is discriminated only when
      // the request-id arm matches — the misbinding precedence through the
      // real protocol, not only at the pure gate.
      kind: "foreign-context-digest",
      contextDigest: contextDigestOf("emission-startup-context:foreign-digest-seed"),
    })));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["requestId"]).toBe(run.issuedRequestId);
    expect(raw?.["contextDigest"]).toBe(contextDigestOf("emission-startup-context:foreign-digest-seed"));
    expect(refusedDecision.message).toContain("context digest");
    expect(refusedDecision.message).toContain("≠ issued");
  });

  it("a child loaded at a stale revision is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("stale-revision", driftedChild({ kind: "stale-revision", revision: STALE_REVISION })));
    const refusedDecision = expectZeroRequestRefusal(run, "revision-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain(STALE_REVISION);
  });

  it("a child registering the FROZEN schema under a drifted tool name — active and digest-matching — is refused with ZERO model requests (AS-020)", async () => {
    const driftedToolName = "loom_emit_reviewer_payload_drifted";
    // The drifted tool is genuinely registered AND active (the allowlist
    // follows the drifted name): the child is fully functional under the
    // wrong name, so the refusal is purely the exact-tool-name bind, never an
    // inactive-tool accident.
    const run = await runStartupGate(scenario("drifted-tool-name", driftedChild({ kind: "drifted-tool-name", toolName: driftedToolName })));
    const refusedDecision = expectZeroRequestRefusal(run, "tool-name-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["toolName"]).toBe(driftedToolName);
    expect(raw?.["active"]).toBe(true);
    expect(raw?.["schemaDigest"]).toBe(cellSchemaDigest(REVIEWER_V2_CELL));
    expect(refusedDecision.message).toContain(driftedToolName);
    expect(refusedDecision.message).toContain(REVIEWER_V2_CELL.spec.toolName);
  });

  it("a registered-but-inactive tool under a real --tools allowlist exclusion is honestly refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("honestly-inactive", driftedChild({ kind: "tool-excluded" })));
    const refusedDecision = expectZeroRequestRefusal(run, "tool-inactive");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["active"]).toBe(false);
    expect(refusedDecision.message).toContain("--tools");
  });

  it("a readiness payload violating the bound contract shape is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("malformed-payload", loadedChild({ kind: "malformed" })));
    const refusedDecision = expectZeroRequestRefusal(run, "malformed-readiness");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain("violates its contract");
  });

  it("a silent child is refused by the bounded readiness timeout with ZERO model requests (FR-008/AS-020)", async () => {
    const run = await runStartupGate(scenario("silent-child", loadedChild({ kind: "silent" })));
    const refusedDecision = expectZeroRequestRefusal(run, "readiness-timeout");
    expect(run.readinessPayload).toBeNull();
    expect(run.invocationCount).toBe(1);
    expect(refusedDecision.message).toContain("bounded window");
  });

  it("a stale extension that no longer registers the expected readiness command is refused by discovery with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("stale-extension", { kind: "stale-extension" }));
    const refusedDecision = expectZeroRequestRefusal(run, "readiness-command-absent");
    expect(run.invocationCount).toBe(0);
    expect(run.readinessPayload).toBeNull();
    expect(run.commandsSeen.join(" | ")).toContain("loom-emission-readiness-v0-stale (extension)");
    expect(run.commandsSeen.join(" | ")).not.toContain("loom-emission-readiness (extension)");
    expect(refusedDecision.message).toContain("/reload");
  });

  it("an absent extension is refused by discovery with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("absent-extension", { kind: "absent-extension" }));
    const refusedDecision = expectZeroRequestRefusal(run, "readiness-command-absent");
    expect(run.channelAlive).toBe(true);
    expect(run.invocationCount).toBe(0);
    expect(run.readinessPayload).toBeNull();
    expect(run.commandsSeen.join(" | ")).not.toContain("loom-emission-readiness (extension)");
    expect(refusedDecision.message).toContain("/reload");
  });

  it("cancelling the barrier mid-readiness releases the child and sends ZERO model requests (FR-008/AS-020)", async () => {
    const run = await runStartupGate(scenario("cancellation", loadedChild({
      kind: "slow",
      delayMs: SLOW_READINESS_MS,
      launcher: { kind: "cancels", afterMs: CANCEL_AFTER_MS },
    })));
    const refusedDecision = expectZeroRequestRefusal(run, "cancelled");
    expect(run.readinessPayload).toBeNull();
    expect(run.invocationCount).toBe(1);
    expect(run.releasedAt).not.toBeNull();
    expect(refusedDecision.message).toContain("cancelled");
  });

  it("a readiness observation arriving AFTER the bounded window cannot reopen the decided barrier — the launcher releases without prompting on late readiness (FR-008)", async () => {
    // The bounded-observation law through the REAL protocol: the child's
    // readiness entry lands PAST the bounded readiness window, while the
    // launcher's release is still held, so the late observation provably
    // ARRIVES — and provably does nothing. The decided readiness-timeout
    // refusal stands: no prompt, ZERO counted model requests, the child's
    // own reservation released. The counting substitute is the discriminator:
    // an unbounded or reopenable launcher would have prompted on the late
    // entry and produced a counted request.
    const holdRelease = deferred<void>();
    const LATE_DELAY_MS = 4_000;
    const gate = startStartupGate(scenario(
      "late-readiness",
      loadedChild({ kind: "slow", delayMs: LATE_DELAY_MS, launcher: { kind: "waits" } }),
      { holdRelease: holdRelease.promise },
    ));
    try {
      await gate.gateDecided;
      // Hold the release past the child's late emission: the bounded window
      // plus the delay plus settling margin — safely inside the runner's
      // HOLD_RELEASE_CAP_MS cap so a lost late entry still settles the run.
      await sleep(LATE_DELAY_MS - READY_TIMEOUT_MS + 1_500);
      holdRelease.resolve();
      const run = await gate.result;
      const refusedDecision = expectZeroRequestRefusal(run, "readiness-timeout");
      // The late entry PROVABLY arrived after the decision — and induced
      // nothing: the in-window payload stayed absent, the refused message
      // names the bounded window, and the counting substitute recorded zero.
      expect(run.readinessEntriesAfterDecision, run.label).toBeGreaterThanOrEqual(1);
      expect(run.readinessPayload, run.label).toBeNull();
      expect(run.invocationCount, run.label).toBe(1);
      expect(refusedDecision.message, run.label).toContain("bounded window");
    } finally {
      holdRelease.resolve();
      await gate.result.catch(() => undefined);
    }
  });

  it("a child provisioned for a stale peer's request AND a different producer kind is refused wrong-request with ZERO model requests — no later capability mismatch reclassifies a misbound child (FR-014)", async () => {
    // The misbinding precedence through the REAL protocol (the pure gate pins
    // the whole chain): a child bound to another request and activated for
    // another kind/version/tool must refuse as wrong-request — its capability
    // mismatch must never mask the misbinding that is the actual failure.
    const staleRequestId = nextRequestId("misbound-peer");
    const run = await runStartupGate(scenario("misbound-everywhere", driftedChild({
      kind: "misbound",
      requestId: staleRequestId,
      cell: JUDGE_V1_CELL,
    })));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["requestId"]).toBe(staleRequestId);
    expect(raw?.["kind"]).toBe("judge-verdict");
    expect(raw?.["toolName"]).toBe("loom_emit_judge_verdict");
    expect(refusedDecision.message).toContain(staleRequestId);
    expect(refusedDecision.message).toContain(run.issuedRequestId);
    expect(refusedDecision.message).not.toContain("judge-verdict, not the issued");
  });

  it("a child whose bound route drifts from the expected constrained endpoint is refused by the fail-closed bind with ZERO model requests — matching readiness alone never opens the gate (AS-020/AD-4)", async () => {
    // Discriminating only through the REAL protocol: the child registers a
    // live provider and an active, digest-matching tool — every readiness
    // field matches — but under a DRIFTED base URL, so set_model binds a
    // route that is not the issued constrained endpoint. Prompting here
    // would deliver the emission payload to an endpoint the issued binding
    // never certified; the gate must refuse before ANY model request.
    const run = await runStartupGate(scenario("route-bind-drift", loadedChild({
      kind: "drifted-provider",
      baseUrl: "http://127.0.0.1:9/v1",
    })));
    const refusedDecision = expectZeroRequestRefusal(run, "route-bind-refused");
    expect(run.channelAlive, run.label).toBe(true);
    expect(run.commandListed, run.label).toBe(true);
    expect(run.invocationCount, run.label).toBe(1);
    expect(run.readinessPayload, run.label).not.toBeNull();
    expect(refusedDecision.message, run.label).toContain("not the expected constrained route");
    expect(refusedDecision.message, run.label).toContain("http://127.0.0.1:9/v1");
  });

  it("a child with matching readiness but NO registered provider is refused by the bounded route-bind settle with ZERO model requests (AS-020/AD-4)", async () => {
    // The bind itself fails closed: the child emits an honest, fully
    // matching readiness payload, but set_model never finds the constrained
    // model (the child registered no provider), so the settle-bounded bind
    // refuses and the launcher releases without prompting.
    const run = await runStartupGate(scenario("route-bind-absent-provider", loadedChild({ kind: "no-provider" })));
    const refusedDecision = expectZeroRequestRefusal(run, "route-bind-refused");
    expect(run.channelAlive, run.label).toBe(true);
    expect(run.commandListed, run.label).toBe(true);
    expect(run.invocationCount, run.label).toBe(1);
    expect(run.readinessPayload, run.label).not.toBeNull();
    expect(refusedDecision.message, run.label).toContain("set_model refused");
  });

  it("a child that dies mid-readiness is an INFRASTRUCTURE failure — never a minted gate refusal, no remediation vocabulary, ZERO counted model requests (AD-4)", async () => {
    // The refusal ADT is the launcher's decision vocabulary for OBSERVED
    // startup facts. A child that dies while the bounded readiness wait is
    // open is infrastructure: the existing semantics propagate the error —
    // no refusal code, no remediation, no minted decision, no consumed
    // attempt — while the run's own counting substitute still proves that
    // ZERO model requests were sent before the failure.
    const runPromise = runStartupGate(scenario("mid-readiness-death", loadedChild({
      kind: "slow",
      delayMs: SLOW_READINESS_MS,
      launcher: { kind: "kills-child", afterMs: 300 },
    })));
    await expect(runPromise).rejects.toThrow(/child died during a bounded wait/);
    const failure: unknown = await runPromise.catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("unreachable: the rejection is an Error");
    // NOT a refusal decision: the infrastructure error carries no refusal
    // code, no remediation text and no decision arm — the closed ADT was
    // never minted, and semantic retry authority was never touched.
    expect("code" in failure, failure.message).toBe(false);
    expect("remediation" in failure, failure.message).toBe(false);
    expect("decision" in failure, failure.message).toBe(false);
    // The death is the test's own SIGKILL of a child that had already been
    // invoked, and the counted evidence on the rejection path is ZERO model
    // requests.
    expect(failure.message, failure.message).toContain("signal SIGKILL");
    expect(failure.message, failure.message).toContain("the counting substitute recorded 0 model request(s)");
  });

  it("AS-020: a refused child is released without disturbing a concurrently starting matching child", async () => {
    const holdRelease = deferred<void>();
    const refusedGate = startStartupGate(scenario("as020-refused", loadedChild({ kind: "stale-schema" })));
    const matchingGate = startStartupGate(scenario("as020-matching", loadedChild(), { holdRelease: holdRelease.promise }));
    try {
      // Synchronize: the matching child is past its gate decision (mid-flight)
      // before the refused peer's release is even awaited.
      await matchingGate.gateDecided;
      const refusedRun = await refusedGate.result;
      expectZeroRequestRefusal(refusedRun, "schema-digest-mismatch");
      const matchingChild = await matchingGate.childReady;
      if (matchingChild === null) throw new Error("the matching child was never spawned");
      // The refused release touched ONLY the refused reservation: the
      // matching child is still alive and was never signalled.
      expect(refusedRun.childPid).not.toBe(matchingChild.pid);
      expect(matchingChild.exitCode).toBeNull();
      expect(matchingChild.killed).toBe(false);
      holdRelease.resolve();
      const matchingRun = await matchingGate.result;
      const open = expectOpenRun(matchingRun);
      expect(open.readiness.requestId).toBe(matchingRun.issuedRequestId);
      expect(open.readiness.active).toBe(true);
      expect(matchingRun.prompted).toBe(true);
      expect(matchingRun.requestCount).toBe(1);
      const { firstRequestAt, readinessObservedAt } = orderingPair(matchingRun);
      expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    } finally {
      // The held release is ALWAYS unblocked — even on an assertion failure —
      // so both runs settle and release their own reservations.
      holdRelease.resolve();
      await Promise.allSettled([refusedGate.result, matchingGate.result]);
    }
  });
});
