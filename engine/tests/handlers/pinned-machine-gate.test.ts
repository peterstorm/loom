/**
 * ADR-0076 end to end through the hooks: a shipped machine its pin refuses
 * still BINDS at SubagentStart, and the PreToolUse gate then BLOCKS every
 * enforced tool, naming the refusal. Tampering makes a gate stricter, never
 * weaker.
 *
 * The real shipped definitions are never touched. The pin module is mocked for
 * this file only, so the real shipped files stand in for every tampering:
 * - security-hunter-agent is pinned to a digest its file does not have
 *   (a rewritten machine);
 * - ghost-agent is pinned but has no file (a deleted machine);
 * - code-implementer-agent has a file but no pin (an added machine).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { agentIdOf, agentTypeOf, sessionIdOf } from "../fixtures/machine-identities";
import { validMachineJson } from "../fixtures/machine-definitions";
import { SUBAGENT_DIR } from "../../src/config";
import { PIN_MACHINES_COMMAND } from "../../src/core/machine-integrity";
import { bindMachineAgent, machineBindingPath } from "../../src/machine";
import enforce from "../../src/handlers/pre-tool-use/enforce-phase-tools";
import markActive from "../../src/handlers/subagent-start/mark-subagent-active";
import { preI6DefaultVerificationManifest } from "../../src/core/verification-manifest";

vi.mock("../../src/core/machine-pins", () => ({
  SHIPPED_MACHINE_PINS: Object.freeze({
    "security-hunter-agent": "0".repeat(64),
    "ghost-agent": "1".repeat(64),
  }),
}));

const run = `pinned-gate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const stateDir = canonicalTempDir("loom-pinned-gate-state-");
const statePath = join(stateDir, "active_task_graph.json");
const savedEnv = { machines: process.env.LOOM_MACHINES_DIR, state: process.env.LOOM_STATE_PATH };

beforeAll(() => {
  writeFileSync(statePath, JSON.stringify({
    current_phase: "execute", verification_manifest: preI6DefaultVerificationManifest(), phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
    tasks: [], wave_gates: {},
  }, null, 2));
});

afterEach(() => {
  if (savedEnv.machines === undefined) delete process.env.LOOM_MACHINES_DIR;
  else process.env.LOOM_MACHINES_DIR = savedEnv.machines;
  if (savedEnv.state === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = savedEnv.state;
});

afterAll(() => {
  for (const name of readdirSync(SUBAGENT_DIR)) {
    if (name.startsWith(run)) rmSync(join(SUBAGENT_DIR, name), { recursive: true, force: true });
  }
  rmSync(stateDir, { recursive: true, force: true });
});

const sessionOf = (label: string): string => `${run}-${label}`;

const start = (session: string, agentType: string): string =>
  JSON.stringify({ session_id: session, agent_id: "a-1", agent_type: `loom:${agentType}` });

const write = (session: string): string =>
  JSON.stringify({ session_id: session, agent_id: "a-1", tool_name: "Write", tool_input: { file_path: join(stateDir, "x.ts"), content: "" } });

/** Start the agent from the shipped machines, then attempt one enforced tool. */
async function startThenWrite(label: string, agentType: string): Promise<{ bound: string; gate: Awaited<ReturnType<typeof enforce>>; stderr: string }> {
  delete process.env.LOOM_MACHINES_DIR;
  process.env.LOOM_STATE_PATH = statePath;
  const session = sessionOf(label);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const started = await markActive(start(session, agentType), []);
    expect(started.kind, JSON.stringify(started)).toBe("passthrough");
    const bound = readFileSync(machineBindingPath(sessionIdOf(session)), "utf-8");
    const gate = await enforce(write(session), []);
    return { bound, gate, stderr: stderr.mock.calls.map(([text]) => String(text)).join("") };
  } finally {
    stderr.mockRestore();
  }
}

describe("a shipped machine its pin refuses binds and then blocks (ADR-0076)", () => {
  it("a rewritten machine (digest mismatch) binds at SubagentStart and blocks Write, naming both digests and the re-pin command", async () => {
    const { bound, gate, stderr } = await startThenWrite("rewritten", "security-hunter-agent");
    expect(bound).toContain("a-1\tsecurity-hunter-agent\t");
    expect(stderr).toContain("machine invalid (gate will fail closed)");
    expect(gate).toMatchObject({
      kind: "block",
      message: expect.stringMatching(/security-hunter-agent has sha256 [0-9a-f]{64}, but the engine pins 0{64}/),
    });
    expect(gate.kind === "block" && gate.message).toContain(PIN_MACHINES_COMMAND);
  });

  it("a deleted pinned machine binds and blocks as a refusal, never as a vanished or ungated machine", async () => {
    const { bound, gate } = await startThenWrite("deleted", "ghost-agent");
    expect(bound).toContain("a-1\tghost-agent\t");
    expect(gate).toMatchObject({
      kind: "block",
      message: expect.stringContaining("the shipped machine for ghost-agent is pinned (sha256 1111"),
    });
    expect(gate.kind === "block" && gate.message).not.toContain("vanished");
  });

  it("a machine no pin names blocks its bound agent", async () => {
    delete process.env.LOOM_MACHINES_DIR;
    const session = sessionOf("unpinned");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await bindMachineAgent(sessionIdOf(session), agentTypeOf("code-implementer-agent"), agentIdOf("a-1"));
      expect(await enforce(write(session), [])).toMatchObject({
        kind: "block",
        message: expect.stringContaining("no shipped machine is pinned for code-implementer-agent"),
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it("an operator directory binds without the pins and says so on stderr", async () => {
    const machines = canonicalTempDir("loom-pinned-gate-operator-");
    writeFileSync(join(machines, "operator-agent.machine.json"), validMachineJson("operator-agent"));
    process.env.LOOM_MACHINES_DIR = machines;
    process.env.LOOM_STATE_PATH = statePath;
    const session = sessionOf("operator");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect((await markActive(start(session, "operator-agent"), [])).kind).toBe("passthrough");
      expect(readFileSync(machineBindingPath(sessionIdOf(session)), "utf-8")).toContain("a-1\toperator-agent\t");
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain(`operator-agent machine read from operator directory ${machines} (LOOM_MACHINES_DIR) — not checked against the shipped pins`);
    } finally {
      stderr.mockRestore();
      rmSync(machines, { recursive: true, force: true });
    }
  });

  it("a machine from the shipped directory raises no operator-directory notice", async () => {
    const { stderr } = await startThenWrite("no-notice", "security-hunter-agent");
    expect(stderr).not.toContain("operator directory");
  });
});
