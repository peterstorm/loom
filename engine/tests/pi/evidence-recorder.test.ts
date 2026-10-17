/**
 * The Pi child evidence recorder (AD-8): grant-state decision, the Pi tool
 * adapter's exit rule, the grant's parent-ledger address, and the parent's
 * read-back of a child's epoch.
 *
 * - `piEvidenceTarget` is the recorder's one total decision over the child's
 *   grant state: one case per state (AS-039).
 * - `createPiEvidenceRecorder(...).recordToolResult` records a granted child's
 *   facts into the PARENT session's ledger under `epochOf(grant agent id,
 *   agent type)` (FR-032) and records nothing, with one stderr note naming
 *   the reason, otherwise (AS-039).
 * - `piToolCall` reads a bash exit only from that call's own result:
 *   `details.exitCode` when numeric, otherwise `isError` as 1 or 0 (FR-033).
 * - The write grant carries the parent's ledger address, integrity-bound by
 *   the grant MAC, from issue through consumption to the active child grant.
 * - Spawn reservation (`reservePiSpawnLifecycle`) mints that address from the
 *   parent session and the item's agent type, and refuses a slot whose agent
 *   type cannot address an evidence epoch.
 * - The extension factory registers the recorder as the FIRST `tool_result`
 *   handler, returning no rewrite, and wires `before_agent_start` to
 *   `observeAgentStart` (FR-033).
 * - `piChildEvidence` recomputes the child's grant identity from the slot's
 *   token and returns that epoch's facts, or an unreadable observation.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPiEvidenceRecorder,
  piChildEvidence,
  piEvidenceTarget,
  type PiEvidenceRecorderPorts,
} from "../../../pi/evidence-recorder";
import {
  activatePiChildWriteGrant,
  createPiChildWriteGrants,
  type ActiveChildWriteGrant,
  type PiChildWriteGrantPorts,
} from "../../../pi/child-write-grant";
import { consumePiWriteGrant, injectPiWriteGrant, issuePiWriteGrant, piGrantedAgentId } from "../../../pi/write-grant";
import { piToolCall } from "../../src/core/harness-tool-call";
import {
  epochOf,
  parseAgentType,
  type SessionId,
  type SessionRegistry,
  type SessionTaskGraphPointerBinding,
} from "../../src/machine";
import type { PiEvidenceLedgerAddress } from "../../src/machine/harness-tool-call-types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { IMPLEMENTER_TYPE, agentIdOf, sessionIdOf } from "../fixtures/machine-identities";
import { inMemorySessionRegistry } from "../machine/fake-session-registry";
import { inertEmissionLaunchBridge } from "../fixtures/held-spawn-batch";
import { recordingDurableReleases } from "../fixtures/recording-durable-releases";
import { reservePiSpawnLifecycle, type PiSpawnLifecyclePorts } from "../../../pi/spawn-lifecycle";
import { createPiParentSessions } from "../../../pi/spawn-reservation";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";
import type { AdmittedSpawnItem, SpawnAdmission } from "../../src/core/spawn-admission";
import { PI_EXTENSION_RUNTIME_REVISION_ENV, PI_EXTENSION_RUNTIME_ROOT_ENV } from "../../src/runtime-compatibility";

const parent = sessionIdOf("pi-parent-session");
const child = sessionIdOf("pi-child-session");
const grantAgent = agentIdOf("pi-grant-0123456789abcdef");
const address: PiEvidenceLedgerAddress = { sessionId: parent, agentType: IMPLEMENTER_TYPE };
const pointer = { directory: "/state", pointerName: "p", registryName: "r", target: "/graph.json" } as unknown as SessionTaskGraphPointerBinding;
const activeGrant: ActiveChildWriteGrant = { kind: "active", agentId: grantAgent, pointerBinding: pointer, evidenceLedger: address };

// ─── piEvidenceTarget: one case per grant state ───────────────────────────

describe("piEvidenceTarget — the recorder's one total decision over the child's grant state", () => {
  it("AS-039: a session that activated no write grant records nothing (no-grant)", () => {
    expect(piEvidenceTarget(undefined, false, child)).toEqual({ kind: "no-record", reason: "no-grant" });
  });

  it("AS-039: a session whose grant was rejected records nothing (grant-rejected), even while it still owes roster cleanup", () => {
    expect(piEvidenceTarget(undefined, true, child)).toEqual({ kind: "no-record", reason: "grant-rejected" });
    const debt: ActiveChildWriteGrant = { kind: "roster-cleanup-pending", agentId: grantAgent, pointerBinding: null };
    expect(piEvidenceTarget(debt, true, child)).toEqual({ kind: "no-record", reason: "grant-rejected" });
  });

  it("AS-039: a binding that survives only as cleanup debt records nothing (cleanup-pending)", () => {
    const rosterPending: ActiveChildWriteGrant = {
      kind: "roster-cleanup-pending", agentId: grantAgent, pointerBinding: null, evidenceLedger: address,
    };
    const pointerPending: ActiveChildWriteGrant = {
      kind: "pointer-cleanup-pending", agentId: null, pointerBinding: pointer, evidenceLedger: address,
    };
    expect(piEvidenceTarget(rosterPending, false, child)).toEqual({ kind: "no-record", reason: "cleanup-pending" });
    expect(piEvidenceTarget(pointerPending, false, child)).toEqual({ kind: "no-record", reason: "cleanup-pending" });
  });

  it("an active grant the parent issued without a ledger address grants no evidence authority (no-grant)", () => {
    const unaddressed: ActiveChildWriteGrant = { kind: "active", agentId: grantAgent, pointerBinding: pointer };
    expect(piEvidenceTarget(unaddressed, false, child)).toEqual({ kind: "no-record", reason: "no-grant" });
  });

  it("FR-032: an active grant targets the parent's ledger under epochOf(grant agent id, agent type), reading stamps from the child", () => {
    expect(piEvidenceTarget(activeGrant, false, child)).toEqual({
      kind: "record",
      ledger: parent,
      epoch: epochOf(grantAgent, IMPLEMENTER_TYPE),
      stamps: child,
    });
  });
});

// ─── The recorder shell ───────────────────────────────────────────────────

type Harness = Readonly<{
  registry: SessionRegistry;
  stderr: string[];
  ports: PiEvidenceRecorderPorts;
}>;

const harness = (): Harness => {
  const registry = inMemorySessionRegistry();
  const stderr: string[] = [];
  return { registry, stderr, ports: { registry, nowMs: () => Date.now(), writeStderr: (line) => { stderr.push(line); } } };
};

const ctx = (sessionId: string, cwd = "/repo") => ({ cwd, sessionManager: { getSessionId: () => sessionId } });
const CHILD_SYSTEM_PROMPT = "<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->\nYou implement.";

const readEvent = (path: string, callId = "call-read") => ({
  type: "tool_result", toolName: "read", toolCallId: callId, input: { path }, content: [{ type: "text", text: "" }], isError: false,
});
const bashEvent = (command: string, isError: boolean, details?: unknown, callId = "call-bash") => ({
  type: "tool_result", toolName: "bash", toolCallId: callId, input: { command }, content: [{ type: "text", text: "" }], isError, details,
});

describe("createPiEvidenceRecorder — the Pi child's tool_result recorder", () => {
  it("FR-031: a granted child records FileRead, via-tagged FileWrites and TestRuns for its own calls", () => {
    const { registry, ports } = harness();
    const grants = createPiChildWriteGrants();
    grants.active.set(child, activeGrant);
    const recorder = createPiEvidenceRecorder(grants, ports);

    recorder.recordToolResult(readEvent("/repo/README.md"), ctx(child));
    recorder.recordToolResult({
      type: "tool_result", toolName: "write", toolCallId: "call-write", input: { path: "src/a.ts", content: "x" },
      content: [{ type: "text", text: "ok" }], isError: false,
    }, ctx(child));
    recorder.recordToolResult(bashEvent("printf x > out.txt && bun test", true), ctx(child));

    expect(registry.readEvidence(parent).map(({ epoch, event, callId }) => ({ epoch, event, callId }))).toEqual([
      { epoch: epochOf(grantAgent, IMPLEMENTER_TYPE), event: { kind: "FileRead", path: "/repo/README.md" }, callId: "call-read" },
      { epoch: epochOf(grantAgent, IMPLEMENTER_TYPE), event: { kind: "FileWrite", path: "/repo/src/a.ts", via: "tool" }, callId: "call-write" },
      { epoch: epochOf(grantAgent, IMPLEMENTER_TYPE), event: { kind: "FileWrite", path: "/repo/out.txt", via: "shell" }, callId: "call-bash" },
      { epoch: epochOf(grantAgent, IMPLEMENTER_TYPE), event: { kind: "TestRun", command: "printf x > out.txt && bun test", exit: null, report: null }, callId: "call-bash" },
    ]);
    expect(registry.readEvidence(child)).toEqual([]);
  });

  it("AS-039: a Loom child with no write grant records nothing into any epoch and its stderr names no-grant, once", () => {
    const { registry, stderr, ports } = harness();
    const recorder = createPiEvidenceRecorder(createPiChildWriteGrants(), ports);
    recorder.observeAgentStart({ systemPrompt: CHILD_SYSTEM_PROMPT }, ctx(child));

    recorder.recordToolResult(readEvent("/repo/README.md"), ctx(child));
    recorder.recordToolResult(bashEvent("printf x > out.txt", false), ctx(child));

    expect(registry.readEvidence(parent)).toEqual([]);
    expect(registry.readEvidence(child)).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("no-grant");
    expect(stderr[0]).toContain(child);
  });

  it("AS-039: a child whose grant was rejected records nothing and its stderr names grant-rejected", () => {
    const { registry, stderr, ports } = harness();
    const grants = createPiChildWriteGrants();
    grants.rejectedSessions.add(child);
    const recorder = createPiEvidenceRecorder(grants, ports);

    recorder.recordToolResult(readEvent("/repo/README.md"), ctx(child));

    expect(registry.readEvidence(parent)).toEqual([]);
    expect(registry.readEvidence(child)).toEqual([]);
    expect(stderr.join("")).toContain("grant-rejected");
  });

  it("AS-039: a child whose binding survives only as cleanup debt records nothing and its stderr names cleanup-pending", () => {
    const { registry, stderr, ports } = harness();
    const grants = createPiChildWriteGrants();
    grants.active.set(child, { kind: "roster-cleanup-pending", agentId: grantAgent, pointerBinding: null, evidenceLedger: address });
    const recorder = createPiEvidenceRecorder(grants, ports);

    recorder.recordToolResult(readEvent("/repo/README.md"), ctx(child));

    expect(registry.readEvidence(parent)).toEqual([]);
    expect(stderr.join("")).toContain("cleanup-pending");
  });

  it("a session that is not a Loom child (the parent or a plain Pi session) stays quiet and records nothing", () => {
    const { registry, stderr, ports } = harness();
    const recorder = createPiEvidenceRecorder(createPiChildWriteGrants(), ports);
    recorder.observeAgentStart({ systemPrompt: "You are a helpful assistant." }, ctx(parent));

    recorder.recordToolResult(readEvent("/repo/README.md"), ctx(parent));

    expect(registry.readEvidence(parent)).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("a recorder failure is reported on stderr and never throws into Pi's tool_result chain", () => {
    const { stderr, ports } = harness();
    const grants = createPiChildWriteGrants();
    grants.active.set(child, activeGrant);
    const broken: PiEvidenceRecorderPorts = {
      ...ports,
      registry: { ...ports.registry, appendEvidence: () => { throw new Error("disk full"); } },
    };
    const recorder = createPiEvidenceRecorder(grants, broken);

    expect(recorder.recordToolResult(readEvent("/repo/README.md"), ctx(child))).toEqual([]);
    expect(stderr.join("")).toContain("disk full");
  });
});

// ─── piToolCall: the Pi adapter (FR-033) ─────────────────────────────────

describe("piToolCall — Pi tool_result normalization", () => {
  it("FR-033: a bash exit is details.exitCode when numeric, otherwise isError read as 1 or 0", () => {
    const outcome = (isError: boolean, details?: unknown) => {
      const call = piToolCall({ toolName: "bash", toolCallId: "c", input: { command: "bun test" }, content: [], isError, details }, "/repo");
      return call.tool === "Bash" ? call.outcome : null;
    };
    expect(outcome(true)).toEqual({ kind: "exited", exit: 1, stdout: "" });
    expect(outcome(false)).toEqual({ kind: "exited", exit: 0, stdout: "" });
    expect(outcome(true, { exitCode: 3 })).toEqual({ kind: "exited", exit: 3, stdout: "" });
    expect(outcome(false, { exitCode: 0 })).toEqual({ kind: "exited", exit: 0, stdout: "" });
    // A non-integer or non-numeric exitCode is not an exit code.
    expect(outcome(true, { exitCode: "3" })).toEqual({ kind: "exited", exit: 1, stdout: "" });
    expect(outcome(false, { exitCode: 1.5 })).toEqual({ kind: "exited", exit: 0, stdout: "" });
    expect(outcome(false, { truncation: {}, fullOutputPath: "/tmp/x" })).toEqual({ kind: "exited", exit: 0, stdout: "" });
  });

  it("FR-033: a killed bash call (Pi's aborted or timed-out status line) is interrupted, so it can never vouch", () => {
    for (const status of ["Command aborted", "Command timed out after 120 seconds"]) {
      const call = piToolCall({
        toolName: "bash", toolCallId: "c", input: { command: "npx vitest run" },
        content: [{ type: "text", text: `partial output\n\n${status}` }], isError: true,
      }, "/repo");
      expect(call.tool === "Bash" && call.outcome).toEqual({ kind: "interrupted" });
    }
    // The same words from a successful command are only output.
    const fine = piToolCall({
      toolName: "bash", toolCallId: "c", input: { command: "echo" }, content: [{ type: "text", text: "Command aborted" }], isError: false,
    }, "/repo");
    expect(fine.tool === "Bash" && fine.outcome).toEqual({ kind: "exited", exit: 0, stdout: "Command aborted" });
  });

  it("carries the text content as stdout for report discovery", () => {
    const call = piToolCall({
      toolName: "bash", toolCallId: "c", input: { command: "npx vitest --reporter=json" },
      content: [{ type: "text", text: "{\"a\":1}" }, { type: "image", data: "", mimeType: "image/png" }], isError: false,
    }, "/repo");
    expect(call.tool === "Bash" && call.outcome).toEqual({ kind: "exited", exit: 0, stdout: "{\"a\":1}" });
  });

  it("maps Pi's lowercase tool names onto the harness vocabulary; anything else is Other", () => {
    const toolOf = (toolName: string) => piToolCall({ toolName, toolCallId: "c", input: {}, content: [], isError: false }, "/repo").tool;
    expect(["read", "write", "edit", "multi_edit", "bash", "grep", "find", "ls", "subagent", "Read"].map(toolOf))
      .toEqual(["Read", "Write", "Edit", "MultiEdit", "Bash", "Other", "Other", "Other", "Other", "Other"]);
  });

  it("a file tool's isError is a failed outcome; a missing, empty or non-string call id is no id", () => {
    const failed = piToolCall({ toolName: "edit", toolCallId: "", input: { path: "a" }, content: [], isError: true }, "/repo");
    expect(failed).toEqual({ tool: "Edit", input: { path: "a" }, outcome: { kind: "failed" }, callId: null, cwd: "/repo" });
    const unidentified = piToolCall({ toolName: "read", toolCallId: 7, input: "not a record", content: [], isError: false }, "/repo");
    expect(unidentified).toEqual({ tool: "Read", input: {}, outcome: { kind: "succeeded" }, callId: null, cwd: "/repo" });
  });
});

// ─── The grant's ledger address: issue → consume → activate ─────────────

describe("the write grant carries the parent's ledger address", () => {
  let root: string;
  let cwd: string;
  let graph: string;
  let priorSubagentDir: string | undefined;

  beforeEach(() => {
    root = canonicalTempDir("loom-pi-evidence-recorder-");
    priorSubagentDir = process.env.LOOM_SUBAGENT_DIR;
    process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
    cwd = join(root, "project");
    graph = join(cwd, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(cwd, ".claude", "state"), { recursive: true });
    writeFileSync(graph, "{}\n");
  });

  afterEach(() => {
    if (priorSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
    else process.env.LOOM_SUBAGENT_DIR = priorSubagentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const issue = (evidenceLedger?: PiEvidenceLedgerAddress) => issuePiWriteGrant({
    agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph, ...(evidenceLedger ? { evidenceLedger } : {}),
  });

  it("FR-032: consuming a grant returns the address the parent minted and the identity piGrantedAgentId recomputes", () => {
    const issued = issue(address);
    const consumed = consumePiWriteGrant(injectPiWriteGrant("Task ID: T1", issued), cwd, "code-implementer-agent");
    expect(consumed?.evidenceLedger).toEqual(address);
    expect(consumed?.agentId).toBe(piGrantedAgentId(issued.token));
  });

  it("a grant issued without an address consumes with none", () => {
    const consumed = consumePiWriteGrant(injectPiWriteGrant("Task ID: T1", issue()), cwd, "code-implementer-agent");
    expect(consumed?.evidenceLedger).toBeNull();
  });

  it("the address is integrity-bound: rewriting it on disk breaks the grant", () => {
    const issued = issue(address);
    const directory = join(root, "subagents", "pi-write-grants");
    const [file] = readdirSync(directory);
    const path = join(directory, file!);
    const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stored, evidenceLedger: { sessionId: "attacker-session", agentType: "code-implementer-agent" } }));
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T1", issued), cwd, "code-implementer-agent"))
      .toThrow(/integrity/);
  });

  it("a stored address that is not a {sessionId, agentType} record is refused as malformed before any MAC check", () => {
    for (const evidenceLedger of [["pi-parent-session"], "pi-parent-session", { sessionId: "pi-parent-session" }, { sessionId: 7, agentType: "code-implementer-agent" }]) {
      const issued = issue(address);
      const directory = join(root, "subagents", "pi-write-grants");
      const [file] = readdirSync(directory);
      const path = join(directory, file!);
      const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...stored, evidenceLedger }));
      expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T1", issued), cwd, "code-implementer-agent"), JSON.stringify(evidenceLedger))
        .toThrow("write grant is malformed");
    }
  });

  it("a MAC-valid address whose ids do not parse is refused at consumption, never recorded into a wrong epoch", () => {
    // The issuer is the only writer a MAC admits; these forge an inconsistent
    // issuer by handing issue() ids the parsers would refuse.
    const unparseableSession = { sessionId: "../escape" as SessionId, agentType: IMPLEMENTER_TYPE };
    const badSession = issue(unparseableSession);
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T1", badSession), cwd, "code-implementer-agent"))
      .toThrow("write grant evidence ledger address is invalid");

    const spacedAgent = "code implementer";
    const badAgentType = issuePiWriteGrant({
      agent: spacedAgent, taskId: "T1", cwd, taskGraphPath: graph,
      evidenceLedger: { sessionId: parent, agentType: spacedAgent as typeof IMPLEMENTER_TYPE },
    });
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T1", badAgentType), cwd, spacedAgent))
      .toThrow("write grant evidence ledger address is invalid");
  });

  it("an address naming another agent type than the grant's agent is refused at issue", () => {
    const architect = parseAgentType("architecture-agent")!;
    expect(() => issue({ sessionId: parent, agentType: architect })).toThrow(/agent type/);
  });

  it("piGrantedAgentId refuses anything but a 64-hex grant token", () => {
    expect(piGrantedAgentId("abc")).toBeNull();
    expect(piGrantedAgentId("g".repeat(64))).toBeNull();
    expect(piGrantedAgentId("a".repeat(64))).toBe(`pi-grant-${"a".repeat(16)}`);
  });

  it("FR-032: activation keeps the consumed address on the child's active grant", async () => {
    const grants = createPiChildWriteGrants();
    const ports: PiChildWriteGrantPorts = {
      markActive: async () => undefined,
      removeActive: async () => undefined,
      bindPointer: async () => pointer,
      writeStderr: () => undefined,
    };
    const issued = issue(address);
    await activatePiChildWriteGrant(
      { prompt: injectPiWriteGrant("Task ID: T1", issued), systemPrompt: CHILD_SYSTEM_PROMPT },
      ctx(child, cwd),
      grants,
      ports,
    );
    const granted = grants.active.get(child);
    expect(granted?.kind).toBe("active");
    expect(granted?.evidenceLedger).toEqual(address);
    expect(piEvidenceTarget(granted, false, child)).toEqual({
      kind: "record",
      ledger: parent,
      epoch: epochOf(piGrantedAgentId(issued.token)!, IMPLEMENTER_TYPE),
      stamps: child,
    });
  });
});

// ─── Spawn-time minting: reservation issues the address ─────────────────

describe("spawn reservation mints the grant's evidence ledger address", () => {
  const SPAWN_KEYS = ["LOOM_SUBAGENT_DIR", "LOOM_ORCHESTRATION_RUNS_ROOT", "LOOM_ORCHESTRATION_RUN_DIR"] as const;
  const parentRaw = "pi-spawning-parent";
  const parentSession = sessionIdOf(parentRaw);
  const toolCallId = "call-spawn-evidence";
  let root: string;
  let previous: ReadonlyArray<readonly [string, string | undefined]>;

  beforeEach(() => {
    root = canonicalTempDir("loom-pi-evidence-spawn-");
    previous = SPAWN_KEYS.map((key) => [key, process.env[key]] as const);
    process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
    delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
    writeFileSync(join(root, "graph.json"), "{}\n");
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const lifecyclePorts = (): PiSpawnLifecyclePorts => ({
    parentSessions: createPiParentSessions(),
    emissionLaunchBridge: inertEmissionLaunchBridge,
    reviewWitnesses: createTrustedReviewWitnesses(),
    durableClaimReleases: recordingDurableReleases().durableClaimReleases,
    runtimeRevision: "r".repeat(64),
    graphExists: () => false,
    enterGuard: () => undefined,
  });

  const admittedItem = (agent: string, task: string, kind: "implementation" | "non-implementation"): AdmittedSpawnItem =>
    Object.freeze({
      item: Object.freeze({ agent, task }) as AdmittedSpawnItem["item"],
      taskExecutionSpawn: Object.freeze({ kind }) as unknown as AdmittedSpawnItem["taskExecutionSpawn"],
      emissionExpectation: Object.freeze({ kind: "no-emission-tool" }),
    });

  /** Reserve one item under an active task graph, so its slot is issued a grant. */
  const reserveOne = (input: { agent: string; task: string }, kind: "implementation" | "non-implementation") =>
    reservePiSpawnLifecycle({
      event: { toolName: "subagent", input, toolCallId },
      cwd: root,
      sessionId: parentRaw,
      safeSessionId: parentSession,
      admission: Object.freeze({
        kind: "admit",
        itemAdmissions: Object.freeze([admittedItem(input.agent, input.task, kind)]),
        needsTaskGraphLifecycle: false,
      }) as Extract<SpawnAdmission, { kind: "admit" }>,
      graph: { active: true, path: join(root, "graph.json"), spawnGraphPath: null },
    }, lifecyclePorts());

  const grantFiles = () => {
    try {
      return readdirSync(join(root, "subagents", "pi-write-grants"));
    } catch {
      return [];
    }
  };

  it("FR-032: a reserved slot's grant consumes carrying the parent's session id and the item's agent type", async () => {
    const input = { agent: "specify-agent", task: "Write the spec to .claude/specs/demo/spec.md" };
    expect(await reserveOne(input, "non-implementation")).toBeUndefined();
    // Reservation injected the grant into the live child prompt.
    expect(input.task).toContain("LOOM_PI_WRITE_GRANT:");

    const consumed = consumePiWriteGrant(input.task, root, "specify-agent");
    const specifyAgent = parseAgentType("specify-agent")!;
    expect(consumed?.evidenceLedger).toEqual({ sessionId: parentSession, agentType: specifyAgent });
    // The address the child consumed is the parent ledger under the grant's epoch.
    const granted: ActiveChildWriteGrant = {
      kind: "active", agentId: consumed!.agentId, pointerBinding: pointer, evidenceLedger: consumed!.evidenceLedger!,
    };
    expect(piEvidenceTarget(granted, false, child)).toEqual({
      kind: "record", ledger: parentSession, epoch: epochOf(consumed!.agentId, specifyAgent), stamps: child,
    });
  });

  it("a slot whose agent type cannot address an evidence epoch is refused, issuing no grant", async () => {
    const input = { agent: "code implementer", task: "Task ID: T1\nImplement it" };
    expect(parseAgentType(input.agent)).toBeNull();
    const refusal = await reserveOne(input, "implementation");
    expect(refusal).toEqual({
      block: true,
      reason: "Cannot record Loom subagent lifecycle evidence; refusing spawn: " +
        `Pi write-grant slot 1 agent ${JSON.stringify(input.agent)} cannot address an evidence epoch`,
    });
    expect(grantFiles()).toEqual([]);
    expect(input.task).toBe("Task ID: T1\nImplement it");
  });
});

// ─── The extension factory's recorder wiring ─────────────────────────────

describe("the Pi extension registers the evidence recorder", () => {
  type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

  /** A Pi host that only collects what the factory registers. */
  class FakePiHost {
    readonly handlers = new Map<string, Handler[]>();
    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
    registerCommand(): void {}
    registerTool(): void {}
    handlersOf(event: string): readonly Handler[] {
      return this.handlers.get(event) ?? [];
    }
  }

  const FACTORY_ENV_KEYS = [
    "LOOM_STATE_PATH", "LOOM_SUBAGENT_DIR", "PI_CODING_AGENT_DIR", "LOOM_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT",
    PI_EXTENSION_RUNTIME_ROOT_ENV, PI_EXTENSION_RUNTIME_REVISION_ENV,
  ] as const;
  let root: string;
  let previous: ReadonlyArray<readonly [string, string | undefined]>;
  let stderr: string[];

  beforeEach(() => {
    root = canonicalTempDir("loom-pi-evidence-extension-");
    previous = FACTORY_ENV_KEYS.map((key) => [key, process.env[key]] as const);
    // No task graph: the resume-context handler stays quiet.
    process.env.LOOM_STATE_PATH = join(root, "absent", "active_task_graph.json");
    process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const registeredHost = async (): Promise<FakePiHost> => {
    const module = await import("../../../pi/extension") as { default: (pi: never) => void };
    const pi = new FakePiHost();
    module.default(pi as never);
    return pi;
  };

  const childCtx = {
    cwd: "/repo",
    hasUI: false,
    sessionManager: { getSessionId: () => child },
    ui: { notify: () => undefined },
    abort: () => undefined,
  };
  const plainCtx = { ...childCtx, sessionManager: { getSessionId: () => parent } };

  it("FR-033: the recorder is the FIRST tool_result handler and returns no rewrite of the tool's own result", async () => {
    const pi = await registeredHost();
    const [first, ...rest] = pi.handlersOf("tool_result");
    expect(first).toBeDefined();
    expect(rest.length).toBeGreaterThan(0);

    // A Loom child with no write grant: only the recorder answers this call,
    // with its one no-grant note, and it rewrites nothing.
    for (const handler of pi.handlersOf("before_agent_start")) {
      await handler({ type: "before_agent_start", prompt: "Implement it", systemPrompt: CHILD_SYSTEM_PROMPT }, childCtx);
    }
    expect(stderr.join("")).not.toContain("evidence recorder");
    expect(await first!(readEvent("/repo/README.md"), childCtx)).toBeUndefined();
    expect(stderr.join("")).toContain(`nothing recorded for session ${child} (no-grant)`);
  });

  it("FR-033: before_agent_start reaches observeAgentStart, so only a Loom child's lost evidence is explained", async () => {
    const pi = await registeredHost();
    const [recorder] = pi.handlersOf("tool_result");

    // Without the child's agent start the recorder treats the session as a
    // plain Pi session and stays quiet.
    await recorder!(readEvent("/repo/README.md"), childCtx);
    expect(stderr.join("")).not.toContain("evidence recorder");

    // A plain session's agent start is observed and still marks no child.
    for (const handler of pi.handlersOf("before_agent_start")) {
      await handler({ type: "before_agent_start", prompt: "Hi", systemPrompt: "You are a helpful assistant." }, plainCtx);
    }
    await recorder!(readEvent("/repo/README.md"), plainCtx);
    expect(stderr.join("")).not.toContain("evidence recorder");

    for (const handler of pi.handlersOf("before_agent_start")) {
      await handler({ type: "before_agent_start", prompt: "Implement it", systemPrompt: CHILD_SYSTEM_PROMPT }, childCtx);
    }
    await recorder!(readEvent("/repo/README.md", "call-read-2"), childCtx);
    expect(stderr.join("")).toContain(`nothing recorded for session ${child} (no-grant)`);
  });
});

// ─── piChildEvidence: the parent's read-back ─────────────────────────────

describe("piChildEvidence — the parent reads one child's epoch", () => {
  const token = "c".repeat(64);
  const childAgent = agentIdOf(`pi-grant-${"c".repeat(16)}`);

  it("returns exactly the facts of the child's epoch in the parent ledger", () => {
    const registry = inMemorySessionRegistry();
    registry.appendEvidence(parent, epochOf(childAgent, IMPLEMENTER_TYPE), [{ kind: "FileRead", path: "/a" }], "c1");
    registry.appendEvidence(parent, epochOf(agentIdOf("pi-grant-ffffffffffffffff"), IMPLEMENTER_TYPE), [{ kind: "FileRead", path: "/sibling" }]);
    registry.appendEvidence(parent, epochOf(childAgent, IMPLEMENTER_TYPE), [{ kind: "FileWrite", path: "/b", via: "tool" }], "c2");

    expect(piChildEvidence(parent, token, IMPLEMENTER_TYPE, registry)).toEqual({
      kind: "read",
      events: [{ kind: "FileRead", path: "/a" }, { kind: "FileWrite", path: "/b", via: "tool" }],
    });
  });

  it("an unreadable ledger is an unreadable observation, never an empty epoch", () => {
    const registry = { readEvidence: () => { throw new Error("evidence ledger is corrupt"); } };
    const observation = piChildEvidence(parent, token, IMPLEMENTER_TYPE, registry);
    expect(observation.kind).toBe("unreadable");
    expect(observation.kind === "unreadable" && observation.reason).toContain("corrupt");
  });

  it("a malformed slot token names no grant identity and is unreadable", () => {
    const observation = piChildEvidence(parent, "not-a-token", IMPLEMENTER_TYPE, inMemorySessionRegistry());
    expect(observation.kind).toBe("unreadable");
  });
});
