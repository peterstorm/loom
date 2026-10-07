/**
 * The production parent `tool_call`/`tool_result` path through the INSTALLED
 * subagent launcher's readiness barrier (FR-008 / FR-031 / AS-020), and the
 * native launcher integration. The parent extension authenticates a published
 * standalone reviewer request, stages its emission launch, and the installed
 * launcher (synced from dotfiles into the ambient Pi agent dir, outside this
 * repository) runs the bridge's readiness verifier against a fake `pi` child
 * before any Task prompt. A CI runner without the launcher reports the
 * launcher-dependent tests as skipped; everywhere else an absent launcher
 * fails loudly.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { captureLoomRuntimeIdentity } from "../../src/runtime-compatibility";
import { renderPiAgentDefinition } from "../../src/utils/render-pi-agent";
import { emissionToolPrimaryInstruction, projectEmissionTaskText } from "../../src/core/issued-emission-capability";
import { issueEmissionBinding } from "../../src/core/emission-tool";
import { canonicalRecord, parseRequestId, success } from "../../src/core/orchestration-contract/identity";
import loomPiExtension from "../../../pi/extension";
import {
  LOOM_SUBAGENT_LAUNCH_CHANNEL,
  registerPiEmissionLaunchBridge,
  type PiEmissionLaunchExpectation,
  type PiSubagentLaunchEventBus,
} from "../../../pi/emission-launch-bridge";
import { LOOM_EMISSION_BINDING_ENV } from "../../../pi/emission-tool";
import type { PiIssuedReviewRouteQualifier } from "../../../pi/review-run-authority";
import { buildReviewerContextPacket, encodeByteSection } from "../../src/core/context-packets";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review-preparation";
import { createRunDirectory, openRegisteredRunDirectory } from "../../src/orchestration/run-directory-handle";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import { parsedAuthority, type RegisteredStandaloneProgram } from "../../src/handlers/helpers/programs/registration";
import { publishReviewInitialBatch } from "../../src/handlers/helpers/programs/request-publication";
import { renderReviewProgramSpawn } from "../../src/handlers/helpers/programs/spawn-task";
import { standaloneRequestId } from "../../src/handlers/helpers/programs/standalone-requests";
import { standaloneFixtureRegistration } from "../fixtures/standalone-reviewer-protocol";
import { fixtureSession, withFixturePiSession } from "../fixtures/pi-session";
import { JUDGE_V1_CELL, recordOf, repoRoot, withProcessState } from "../fixtures/emission-child-harness";
import { bridgeLaunchExpectation, NoEventBusFakePi, SynchronousEventBus } from "../fixtures/emission-launch-port";

const fixtureValue = <T, E>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>,
): T => {
  if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

type PublishedParentSpawnFixture = Readonly<{
  root: string;
  piAgentDir: string;
  runsRoot: string;
  runDirectory: string;
  task: string;
  emissionDescriptor: string;
  toolPrimaryInstruction: string;
}>;

const publishedParentSpawnFixture = async (label: string): Promise<PublishedParentSpawnFixture> => {
  const root = canonicalTempDir(`loom-parent-emission-${label}-`);
  const piAgentDir = join(root, "pi-agent");
  const runsRoot = join(root, "runs");
  const sourcePath = "src/fixture.ts";
  await mkdir(runsRoot);
  await mkdir(join(root, "src"));
  await mkdir(join(piAgentDir, "agents"), { recursive: true });
  await writeFile(join(root, sourcePath), "export const fixture = true;\n", "utf8");
  await writeFile(
    join(piAgentDir, "agents", "code-reviewer.md"),
    renderPiAgentDefinition(
      readFileSync(join(repoRoot, "agents", "code-reviewer.md"), "utf8"),
      "code-reviewer",
      repoRoot,
    ),
    "utf8",
  );
  const created = createRunDirectory(runsRoot, `run.${label}`);
  if (!created.ok) throw new Error(created.error.message);
  const handle = created.value;
  const packets = ([1, 2] as const).map((attempt) => {
    const requestId = fixtureValue(parseRequestId(standaloneRequestId(handle.runId, "code-reviewer", attempt)));
    const section = fixtureValue(encodeByteSection(
      "standalone-review-authority",
      JSON.stringify({ runId: handle.runId, scope: [sourcePath], role: "code-reviewer", attempt }),
    ));
    return fixtureValue(buildReviewerContextPacket({
      requestId,
      role: "code-reviewer",
      requiredSkill: "none",
      fixedContext: Object.freeze([section]),
      variableContext: Object.freeze([]),
    }));
  });
  const packet = packets[0]!;
  const prepared = fixtureValue(prepareFreshStandaloneReview({
    runId: handle.runId,
    explicitScope: Object.freeze([sourcePath]),
    changedPaths: Object.freeze({
      unstaged: Object.freeze([sourcePath]),
      staged: Object.freeze([]),
      committed: Object.freeze([]),
      base_revision: null,
      head_revision: "a".repeat(40),
    }),
    reviewMetadata: Object.freeze({
      requested_kinds: Object.freeze(["types"]),
      docs_only: false,
      source_or_test_changed: false,
      types_changed: false,
      comments_changed: false,
      additions: 1,
      file_count: 1,
      new_structure: false,
      languages: Object.freeze(["TypeScript"]),
    }),
    scopeSafety: Object.freeze([{ path: sourcePath, status: "safe" as const }]),
    reviewerContexts: Object.freeze([{
      attempts: [packets[0]!.digest, packets[1]!.digest] as const,
    }]),
  }));
  const registration = standaloneFixtureRegistration(prepared.authority) as RegisteredStandaloneProgram;
  const parsed = parsedAuthority(registration);
  if (!parsed.ok) throw new Error(parsed.message);
  const authority = parsed.value.roster.orderedSlots[0]?.attempts[0];
  if (authority === undefined) throw new Error("fixture standalone authority carries no reviewer attempt");
  const registered = await handle.registerProgram(registration);
  if (!registered.ok) throw new Error(registered.error.message);
  const published = await publishReviewInitialBatch(
    handle,
    Object.freeze([Object.freeze({
      authority,
      context: Object.freeze({
        digest: packet.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }),
    })]),
    Object.freeze([packet]),
    "standalone-reviewer-payload-v2",
    registration,
  );
  if (!published.ok) throw new Error(published.message);

  const binding = issueEmissionBinding({
    requestId: authority.requestId,
    kind: "reviewer-payload",
    version: "v2",
  });
  if (!binding.ok) throw new Error(`fixture emission binding refused: ${binding.error.message}`);
  const baseInstruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
  const projected = projectEmissionTaskText(
    canonicalRecord({
      kind: "emission" as const,
      binding: binding.value,
      contextDigest: authority.contextDigest,
    }),
    baseInstruction,
  );
  const toolPrimaryInstruction = emissionToolPrimaryInstruction(binding.value);
  const task = projected.descriptor + renderReviewProgramSpawn(
    handle,
    authority,
    projected.instruction,
    registration,
    { standalone: true },
  ).task;
  return Object.freeze({
    root,
    piAgentDir,
    runsRoot,
    runDirectory: handle.runDirectory,
    task,
    emissionDescriptor: projected.descriptor,
    toolPrimaryInstruction,
  });
};

const qualifiedPublishedReviewerRoute = (
  onQualification: () => void,
): PiIssuedReviewRouteQualifier => (classified, published) => {
  onQualification();
  const binding = issueEmissionBinding({
    requestId: classified.claim.requestId,
    kind: classified.claim.producerKind,
    version: classified.claim.version,
    ...(classified.claim.schemaDigest === undefined ? {} : { schemaDigest: classified.claim.schemaDigest }),
  });
  if (!binding.ok) return { ok: false, error: { message: binding.error.message } };
  return success(Object.freeze({
    role: published.role,
    claim: classified.claim,
    route: Object.freeze({
      kind: "emission" as const,
      binding: binding.value,
      contextDigest: classified.claim.contextDigest,
    }),
  }));
};

class ParentGuardFakePi extends NoEventBusFakePi {
  constructor(readonly events: SynchronousEventBus) {
    super();
  }
}

const shutdownParentExtension = async (
  pi: ParentGuardFakePi,
  fixture: PublishedParentSpawnFixture,
): Promise<void> => {
  const session = fixtureSession(fixture.root);
  for (const handler of pi.handlers.get("session_shutdown") ?? []) {
    await handler({}, {
      cwd: fixture.root,
      hasUI: false,
      sessionManager: { getSessionId: () => session.sessionId },
    });
  }
};

type InstalledLauncherResult = Readonly<{
  agent: string;
  task: string;
  exitCode: number;
  stderr: string;
  messages: readonly unknown[];
  stopReason?: string;
  launchOutcome?: unknown;
}>;

type InstalledLauncherModules = Readonly<{
  launcher: Readonly<{
    runSingleAgent: (...args: unknown[]) => Promise<InstalledLauncherResult>;
  }>;
  port: Readonly<{ advertiseSubagentLaunchPort: (events: unknown) => () => void }>;
  routingPolicy: Readonly<{
    parseModelRoutingPolicy: (raw: unknown) => Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: readonly string[] }>;
  }>;
}>;

/**
 * The installed launcher lives outside this repository (synced from dotfiles
 * into the ambient Pi agent dir), so it is resolved once from the ambient
 * environment, before any test swaps PI_CODING_AGENT_DIR for a fixture.
 */
const installedLauncher = (() => {
  const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  const subagentRoot = join(agentDir, "extensions", "subagent");
  const paths = Object.freeze({
    launcher: join(subagentRoot, "index.ts"),
    port: join(subagentRoot, "loom-launch-port.ts"),
    routingPolicy: join(agentDir, "extensions", "model-routing", "policy.ts"),
  });
  const missing = Object.freeze(Object.values(paths).filter((path) => !existsSync(path)));
  return Object.freeze({ agentDir, paths, missing });
})();

/**
 * A CI runner can never hold the out-of-repo launcher, so there these
 * acceptance tests report as skipped. Everywhere else an absent launcher still
 * fails loudly: the prerequisite is tracked, never a claimed pass (FR-032/FR-008).
 */
const skipWithoutInstalledLauncher = process.env["CI"] === "true" && installedLauncher.missing.length > 0;

const loadInstalledLauncherModules = async (): Promise<InstalledLauncherModules> => {
  const [absent] = installedLauncher.missing;
  if (absent !== undefined) {
    throw new Error(
      `Installed Pi launcher prerequisite is absent at ${absent}. Install/sync the shared subagent and model-routing extensions under ${installedLauncher.agentDir}, then rerun this acceptance test.`,
    );
  }
  const { paths } = installedLauncher;
  return Object.freeze({
    launcher: await import(/* @vite-ignore */ paths.launcher),
    port: await import(/* @vite-ignore */ paths.port),
    routingPolicy: await import(/* @vite-ignore */ paths.routingPolicy),
  }) as InstalledLauncherModules;
};

const FAKE_INSTALLED_PI_SOURCE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const mode = process.argv[process.argv.indexOf("--mode") + 1];
const log = process.env.FAKE_INSTALLED_LAUNCH_LOG;
if (mode !== "rpc") {
  if (log) appendFileSync(log, "ordinary-task\\n");
  console.log(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "ordinary path preserved" }], stopReason: "stop" },
  }));
  process.exit(0);
}
const binding = JSON.parse(process.env.LOOM_EMISSION_BINDING || "{}");
const variant = process.env.FAKE_INSTALLED_LAUNCH_VARIANT || "matching";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const response = (success = true, data = {}) => send({
      type: "response", id: request.id, command: request.type, success, data,
    });
    if (request.type === "get_commands") {
      response(true, { commands: variant === "missing-command"
        ? []
        : [{ name: "loom-emission-readiness", source: "extension" }] });
    } else if (request.type === "prompt" && request.message === "/loom-emission-readiness") {
      response();
      send({ type: "entry_appended", entry: {
        customType: "loom-emission-readiness",
        data: {
          requestId: binding.requestId,
          contextDigest: binding.contextDigest,
          kind: binding.kind,
          version: binding.version,
          toolName: binding.toolName,
          schemaDigest: variant === "wrong-schema" ? "0".repeat(64) : binding.schemaDigest,
          revision: process.env.FAKE_INSTALLED_LAUNCH_REVISION,
          active: variant !== "inactive",
          childPid: process.pid,
          registeredTools: [binding.toolName],
        },
      } });
    } else if (request.type === "set_model") {
      response(true, { provider: request.provider, id: request.modelId });
    } else if (request.type === "get_state") {
      response(true, { model: {
        provider: "desktop-vllm",
        id: "glm-5.3-flash-spark-tp2-v14",
      } });
    } else if (request.type === "prompt") {
      if (log) appendFileSync(log, "emission-task\\n");
      response();
      send({ type: "agent_settled" });
    } else {
      response(false, {});
    }
  }
});
`;

describe("production parent tool_call to installed launcher readiness barrier", { timeout: 30_000 }, () => {
  const parentContext = (fixture: PublishedParentSpawnFixture) => {
    const session = fixtureSession(fixture.root);
    return {
      cwd: fixture.root,
      hasUI: false,
      sessionManager: { getSessionId: () => session.sessionId },
    } as const;
  };

  const withPublishedRunEnvironment = <T>(
    fixture: PublishedParentSpawnFixture,
    operation: () => Promise<T>,
  ): Promise<T> =>
    withProcessState({ env: { [RUNS_ROOT_ENV]: fixture.runsRoot, [RUN_DIR_ENV]: fixture.runDirectory } }, operation);

  const invokeExistingParentSpawn = async (
    pi: ParentGuardFakePi,
    fixture: PublishedParentSpawnFixture,
    toolCallId: string,
  ): Promise<unknown> => {
    const handler = pi.handlers.get("tool_call")?.[0];
    if (handler === undefined) throw new Error("the production extension did not register its parent tool_call handler");
    return handler({
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: fixture.task, agentScope: "user" },
    }, parentContext(fixture));
  };

  const invokeIssuedParentSpawn = async (
    fixture: PublishedParentSpawnFixture,
    bus: SynchronousEventBus,
    toolCallId: string,
    qualified: { count: number },
  ): Promise<Readonly<{ pi: ParentGuardFakePi; result: unknown }>> => {
    return withProcessState({ env: { PI_CODING_AGENT_DIR: fixture.piAgentDir } }, async () => {
      const pi = new ParentGuardFakePi(bus);
      loomPiExtension(pi as never, () => Object.freeze([]), qualifiedPublishedReviewerRoute(() => {
        qualified.count += 1;
      }));
      const result = await invokeExistingParentSpawn(pi, fixture, toolCallId);
      return Object.freeze({ pi, result });
    });
  };

  const deliverParentToolResult = async (
    pi: ParentGuardFakePi,
    fixture: PublishedParentSpawnFixture,
    toolCallId: string,
    results: readonly unknown[],
  ): Promise<unknown> => {
    let response: unknown;
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      const next = await handler({
        toolName: "subagent",
        toolCallId,
        input: { agent: "code-reviewer", task: fixture.task, agentScope: "user" },
        content: [],
        details: { mode: "single", results },
        isError: true,
      }, parentContext(fixture));
      if (next !== undefined) response = next;
    }
    return response;
  };

  const expectUncapturedIssuedRequest = (fixture: PublishedParentSpawnFixture): void => {
    const opened = openRegisteredRunDirectory(fixture.runsRoot, fixture.runDirectory);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok || issued.value[0] === undefined) throw new Error("fixture issued request is unavailable");
    expect(opened.value.readCapturedAttempts()).toEqual({ ok: true, value: new Set() });
    expect(opened.value.readCaptureRejection(issued.value[0])).toEqual({ ok: true, value: null });
  };

  const runInstalledChild = async (
    installed: InstalledLauncherModules,
    bus: SynchronousEventBus,
    fixture: PublishedParentSpawnFixture,
    toolCallId: string,
    variant: "matching" | "wrong-schema",
  ): Promise<Readonly<{ result: InstalledLauncherResult; log: string }>> => {
    const fakePi = join(fixture.root, "pi");
    const log = join(fixture.root, "launch.log");
    await writeFile(fakePi, FAKE_INSTALLED_PI_SOURCE, "utf8");
    await chmod(fakePi, 0o700);
    const parsedPolicy = installed.routingPolicy.parseModelRoutingPolicy({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: {},
      targets: {},
      rules: [],
    });
    if (!parsedPolicy.ok) throw new Error(parsedPolicy.error.join("; "));
    const agent = {
      name: "code-reviewer",
      description: "published reviewer fixture",
      model: "desktop-vllm/glm-5.3-flash-spark-tp2-v14",
      declaredSkills: [],
      systemPrompt: "",
      source: "user",
      filePath: join(fixture.root, "code-reviewer.md"),
    } as const;
    return withProcessState({
      env: {
        PATH: `${fixture.root}:${process.env["PATH"] ?? ""}`,
        FAKE_INSTALLED_LAUNCH_LOG: log,
        FAKE_INSTALLED_LAUNCH_REVISION: captureLoomRuntimeIdentity(repoRoot).revision,
        FAKE_INSTALLED_LAUNCH_VARIANT: variant,
      },
      clearArgv1: true,
    }, async () => {
      const result = await installed.launcher.runSingleAgent(
        fixture.root,
        [agent],
        agent.name,
        fixture.task,
        undefined,
        undefined,
        undefined,
        undefined,
        (results: readonly unknown[]) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
        { policy: parsedPolicy.value, policyDigest: `parent-handler-${variant}` },
        {
          events: bus,
          sessionId: fixtureSession(fixture.root).sessionId,
          toolCallId,
          slot: { kind: "single", index: 0 },
          readinessTimeoutMs: 2_000,
        },
      );
      return Object.freeze({ result, log });
    });
  };

  it("refuses a stale disposable generated Agent before authenticating or launching the issued request", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-stale-agent");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const generatedAgentPath = join(fixture.piAgentDir, "agents", "code-reviewer.md");
        await writeFile(generatedAgentPath, `${await readFile(generatedAgentPath, "utf8")}\n<!-- stale definition -->\n`, "utf8");
        const qualified = { count: 0 };
        const parent = await invokeIssuedParentSpawn(
          fixture,
          new SynchronousEventBus(),
          "tool-call-parent-stale-agent",
          qualified,
        );
        expect(parent.result).toMatchObject({
          block: true,
          reason: expect.stringContaining("differs from active package"),
        });
        expect(qualified.count).toBe(0);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("authenticates the issued request and exact disposable generated Agent before launcher-capability refusal", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-missing-launcher");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const qualified = { count: 0 };
        const bus = new SynchronousEventBus();
        const ambientPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
        const parent = await invokeIssuedParentSpawn(
          fixture,
          bus,
          "tool-call-parent-missing-launcher",
          qualified,
        );
        expect(process.env["PI_CODING_AGENT_DIR"]).toBe(ambientPiAgentDir);
        expect(parent.result).toMatchObject({
          block: true,
          reason: expect.stringContaining("installed subagent launcher does not advertise"),
        });
        // The qualifier runs only after readPiIssuedSpawnRequest authenticated
        // the exact reservation, program registration, and publication. The
        // real admitPiSpawnBatch handler then reaches the capability guard.
        expect(qualified.count).toBe(1);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces an incompatible launcher capability reply through the production parent guard before any Task dispatch", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-incompatible-launcher");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const bus = new SynchronousEventBus();
        bus.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
          const probe = recordOf(event);
          if (probe?.["kind"] === "capability" && typeof probe["respond"] === "function") {
            probe["respond"]({ kind: "available", version: 1 });
          }
        });
        const qualified = { count: 0 };
        const parent = await invokeIssuedParentSpawn(fixture, bus, "tool-call-parent-incompatible-launcher", qualified);
        const blocked = recordOf(parent.result);
        expect(blocked?.["block"]).toBe(true);
        expect(typeof blocked?.["reason"]).toBe("string");
        if (typeof blocked?.["reason"] === "string") {
          expect(blocked["reason"]).toContain("incompatible v2 capability response");
          expect(blocked["reason"]).toContain("incompatible version");
          expect(blocked["reason"]).not.toContain("does not advertise");
        }
        expect(qualified.count).toBe(1);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces a launcher probe crash through the production parent guard before any Task dispatch", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-crashed-launcher");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const bus = new SynchronousEventBus();
        bus.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
          if (recordOf(event)?.["kind"] === "capability") throw new Error("launcher capability handler crashed before dispatch");
        });
        const qualified = { count: 0 };
        const parent = await invokeIssuedParentSpawn(fixture, bus, "tool-call-parent-crashed-launcher", qualified);
        expect(parent.result).toMatchObject({
          block: true,
          reason: expect.stringContaining("launcher capability handler crashed before dispatch"),
        });
        expect(JSON.stringify(parent.result)).not.toContain("does not advertise");
        expect(qualified.count).toBe(1);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(skipWithoutInstalledLauncher)("keeps the same issued request retriable after an attested pre-prompt refusal and accepts a new native correlator", async () => {
    const installed = await loadInstalledLauncherModules();
    const fixture = await publishedParentSpawnFixture("t5-parent-same-request-retry");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const bus = new SynchronousEventBus();
        installed.port.advertiseSubagentLaunchPort(bus);
        const qualified = { count: 0 };
        expect(fixture.task.match(/^LOOM_EMISSION_DESCRIPTOR:.*$/gm)).toEqual([
          fixture.emissionDescriptor.trimEnd(),
        ]);
        expect(fixture.task.split(fixture.toolPrimaryInstruction)).toHaveLength(2);

        const firstToolCallId = "tool-call-parent-wrong-readiness";
        const parent = await invokeIssuedParentSpawn(fixture, bus, firstToolCallId, qualified);
        expect(parent.result).toBeUndefined();
        const refused = await runInstalledChild(installed, bus, fixture, firstToolCallId, "wrong-schema");
        expect(refused.result).toMatchObject({
          exitCode: 1,
          messages: [],
          launchOutcome: {
            kind: "emission-startup-refused",
            sessionId: fixtureSession(fixture.root).sessionId,
            toolCallId: firstToolCallId,
            slot: { kind: "single", index: 0 },
            phase: "before-task-prompt",
          },
        });
        expect(refused.result.stderr).toContain("registered schema digest");
        expect(existsSync(refused.log)).toBe(false);

        const response = await deliverParentToolResult(parent.pi, fixture, firstToolCallId, [refused.result]);
        expect(response).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("retry this same issued request") }],
        });
        expectUncapturedIssuedRequest(fixture);

        const retryToolCallId = "tool-call-parent-readiness-retry";
        expect(await invokeExistingParentSpawn(parent.pi, fixture, retryToolCallId)).toBeUndefined();
        expect(qualified.count).toBe(2);
        const retry = await runInstalledChild(installed, bus, fixture, retryToolCallId, "matching");
        expect(retry.result.exitCode).toBe(0);
        expect(retry.result.launchOutcome).toBeUndefined();
        expect(await readFile(retry.log, "utf8")).toBe("emission-task\n");
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(skipWithoutInstalledLauncher)("terminally rejects an absent attempt-1 result and does not infer startup refusal from untrusted markers", async () => {
    const installed = await loadInstalledLauncherModules();

    const absentFixture = await publishedParentSpawnFixture("t5-parent-absent-result");
    try {
      await withFixturePiSession(absentFixture.root, () => withPublishedRunEnvironment(absentFixture, async () => {
        const bus = new SynchronousEventBus();
        installed.port.advertiseSubagentLaunchPort(bus);
        const parent = await invokeIssuedParentSpawn(absentFixture, bus, "tool-call-absent-result", { count: 0 });
        const response = await deliverParentToolResult(parent.pi, absentFixture, "tool-call-absent-result", []);
        expect(response).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("no typed pre-prompt outcome exists; terminal capture rejection") }],
        });

        const opened = openRegisteredRunDirectory(absentFixture.runsRoot, absentFixture.runDirectory);
        if (!opened.ok) throw new Error(opened.error.message);
        const issued = opened.value.readIssuedRequests();
        if (!issued.ok || issued.value[0] === undefined) throw new Error("fixture issued request is unavailable");
        expect(issued.value).toHaveLength(1);
        expect(issued.value[0].attempt).toBe(1);
        expect(opened.value.readCapturedAttempts()).toEqual({ ok: true, value: new Set() });
        expect(opened.value.readCaptureRejection(issued.value[0])).toEqual({
          ok: true,
          value: "capture-rejection: request-bound result 1 for code-reviewer was missing or mismatched; " +
            "no typed pre-prompt outcome exists; terminal capture rejection",
        });

        const sameRequestRetry = await invokeExistingParentSpawn(
          parent.pi,
          absentFixture,
          "tool-call-absent-result-same-request-retry",
        );
        expect(sameRequestRetry).toMatchObject({
          block: true,
          reason: expect.stringContaining("attempt 1"),
        });
        expect(sameRequestRetry).toMatchObject({
          block: true,
          reason: expect.stringContaining("terminally rejected"),
        });
        expect(sameRequestRetry).toMatchObject({
          block: true,
          reason: expect.stringContaining("new attempt-2 issuance is required"),
        });
        expect(opened.value.readIssuedRequests()).toEqual(issued);
        await shutdownParentExtension(parent.pi, absentFixture);
      }));
    } finally {
      await rm(absentFixture.root, { recursive: true, force: true });
    }

    for (const [label, rewrite] of [
      ["malformed", (outcome: unknown) => ({ ...(recordOf(outcome) ?? {}), requestId: 42 })],
      ["after-prompt", (outcome: unknown) => ({ ...(recordOf(outcome) ?? {}), phase: "task-prompt-sent" })],
    ] as const) {
      const fixture = await publishedParentSpawnFixture(`t5-parent-${label}-marker`);
      try {
        await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
          const bus = new SynchronousEventBus();
          installed.port.advertiseSubagentLaunchPort(bus);
          const toolCallId = `tool-call-${label}-marker`;
          const parent = await invokeIssuedParentSpawn(fixture, bus, toolCallId, { count: 0 });
          const refused = await runInstalledChild(installed, bus, fixture, toolCallId, "wrong-schema");
          const raw = { ...refused.result, launchOutcome: rewrite(refused.result.launchOutcome) };
          const response = await deliverParentToolResult(parent.pi, fixture, toolCallId, [raw]);
          expect(response).toMatchObject({
            isError: true,
            content: [{ text: expect.stringContaining("untrusted emission launch outcome") }],
          });
          const opened = openRegisteredRunDirectory(fixture.runsRoot, fixture.runDirectory);
          if (!opened.ok) throw new Error(opened.error.message);
          const issued = opened.value.readIssuedRequests();
          if (!issued.ok || issued.value[0] === undefined) throw new Error("fixture issued request is unavailable");
          expect(opened.value.readCaptureRejection(issued.value[0])).toMatchObject({ ok: true, value: expect.any(String) });
          await shutdownParentExtension(parent.pi, fixture);
        }));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });
});

describe("native installed subagent launcher integration", { timeout: 20_000 }, () => {
  it.skipIf(skipWithoutInstalledLauncher)("blocks a mismatched child before Task prompt and permits a fresh exact retry; ordinary JSON launch remains unchanged", async () => {
    const tmp = canonicalTempDir("loom-installed-launcher-t5-");
    const fakePi = join(tmp, "pi");
    const log = join(tmp, "launch.log");
    await writeFile(fakePi, FAKE_INSTALLED_PI_SOURCE, "utf8");
    await chmod(fakePi, 0o700);

    const bus = new SynchronousEventBus();
    const installed = await loadInstalledLauncherModules();
    installed.port.advertiseSubagentLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    expect(bridge.probe()).toEqual({ kind: "available" });

    const parsedPolicy = installed.routingPolicy.parseModelRoutingPolicy({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: {},
      targets: {},
      rules: [],
    });
    if (!parsedPolicy.ok) throw new Error(parsedPolicy.error.join("; "));
    const agent = {
      name: "code-reviewer",
      description: "fixture reviewer",
      model: "desktop-vllm/glm-5.3-flash-spark-tp2-v14",
      declaredSkills: [],
      systemPrompt: "",
      source: "user",
      filePath: join(tmp, "code-reviewer.md"),
    } as const;
    const routingSnapshot = {
      policy: parsedPolicy.value,
      policyDigest: "installed-launch-test",
    } as const;
    const makeDetails = (results: readonly unknown[]) => ({
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results,
    });
    const ambientBinding = process.env[LOOM_EMISSION_BINDING_ENV];

    const run = async (launch: PiEmissionLaunchExpectation) => installed.launcher.runSingleAgent(
      repoRoot,
      [agent],
      agent.name,
      launch.task,
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      routingSnapshot,
      {
        events: bus,
        sessionId: launch.sessionId,
        toolCallId: launch.toolCallId,
        slot: launch.slot,
        readinessTimeoutMs: 2_000,
      },
    );

    try {
      // The fake launcher's variant and revision are set per launch below; the
      // ambient emission binding keeps its value and must survive every launch.
      await withProcessState({
        env: {
          PATH: `${tmp}:${process.env["PATH"] ?? ""}`,
          FAKE_INSTALLED_LAUNCH_LOG: log,
          FAKE_INSTALLED_LAUNCH_REVISION: undefined,
          FAKE_INSTALLED_LAUNCH_VARIANT: undefined,
          [LOOM_EMISSION_BINDING_ENV]: ambientBinding,
        },
        clearArgv1: true,
      }, async () => {
        for (const [variant, diagnostic] of [
          ["missing-command", "Required extension command /loom-emission-readiness is unavailable"],
          ["inactive", "registered but inactive"],
          ["wrong-schema", "registered schema digest"],
          ["stale-revision", "reports revision sha256:stale-child"],
        ] as const) {
          const refused = bridgeLaunchExpectation(
            JUDGE_V1_CELL,
            `tool-call-native-${variant}`,
            { kind: "single", index: 0 },
          );
          expect(bridge.stage([refused])).toEqual({ ok: true });
          process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = variant === "stale-revision" ? "matching" : variant;
          process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = variant === "stale-revision"
            ? "sha256:stale-child"
            : refused.revision;
          const refusedResult = await run(refused);
          expect(refusedResult.exitCode, variant).toBe(1);
          expect(refusedResult.stderr, variant).toContain(diagnostic);
          bridge.removeToolCall(refused.sessionId, refused.toolCallId);
        }
        // None of the missing/inactive/wrong-schema/revision children reached
        // Task prompt — the executable launcher's zero-model-request invariant.
        await expect(readFile(log, "utf8")).rejects.toThrow();

        const retry = bridgeLaunchExpectation(JUDGE_V1_CELL, "tool-call-native-retry", { kind: "single", index: 0 });
        expect(bridge.stage([retry])).toEqual({ ok: true });
        process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = "matching";
        process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = retry.revision;
        const retryResult = await run(retry);
        expect(retryResult.exitCode).toBe(0);
        expect(await readFile(log, "utf8")).toBe("emission-task\n");

        bridge.removeToolCall(retry.sessionId, retry.toolCallId);
        const ordinaryResult = await installed.launcher.runSingleAgent(
          repoRoot,
          [agent],
          agent.name,
          "ordinary extraction-only task",
          undefined,
          undefined,
          undefined,
          undefined,
          makeDetails,
          routingSnapshot,
          {
            events: bus,
            sessionId: "01a0e4b3-c4c1-7b63-916d-f5d41d2b5a00",
            toolCallId: "tool-call-native-ordinary",
            slot: { kind: "single", index: 0 },
            readinessTimeoutMs: 2_000,
          },
        );
        expect(ordinaryResult.exitCode).toBe(0);
        expect(ordinaryResult.messages).toHaveLength(1);
        expect(await readFile(log, "utf8")).toBe("emission-task\nordinary-task\n");
        expect(process.env[LOOM_EMISSION_BINDING_ENV]).toBe(ambientBinding);
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
