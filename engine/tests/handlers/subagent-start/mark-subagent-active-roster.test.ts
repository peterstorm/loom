/**
 * Roster failure handling in mark-subagent-active: a markAgentActive
 * lock/fs failure means the agent is OFF the roster — soleActiveBinding
 * would then cross-credit its tool calls into any armed binding. The
 * handler must (a) say so, (b) block the implementation start, and (c)
 * roll back the sidecar/roster/machine capability set. Modern exact authority
 * fails closed; there is no child SubagentStop to justify a ghost pointer.
 *
 * SUBAGENT_DIR freezes at first config import, so this suite uses the
 * shared dir with unique session ids (the pattern every other suite uses).
 * The task-graph path and machines dir are read at CALL time by the
 * handler, so per-test env re-pointing works without a module reload.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_DIR } from "../../../src/config";
import { shouldBlockDirectEdit } from "../../../src/core/block-direct-edits";
import { activeRosterProbe } from "../../../src/handlers/pre-tool-use/block-direct-edits";
import markActive from "../../../src/handlers/subagent-start/mark-subagent-active";
import { runCleanupSubagentFlag } from "../../../src/handlers/subagent-stop/cleanup-subagent-flag";
import {
  parseSessionId,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
  TASK_GRAPH_POINTER_LEASES_SUFFIX,
} from "../../../src/machine";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
} from "../../../src/core/implementation-completion";
import { taskFixture } from "../../fixtures/task-lifecycle";
import type { TaskGraph } from "../../../src/types";

const uniq = `roster-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const stateDir = mkdtempSync(join(tmpdir(), "loom-roster-state-"));
const statePath = join(stateDir, "active_task_graph.json");
const guardedReviewMachines = join(stateDir, "guarded-review-machines");
mkdirSync(guardedReviewMachines);
writeFileSync(join(guardedReviewMachines, "guarded-review-agent.machine.json"), JSON.stringify({
  agent: "guarded-review-agent",
  enforcedTools: ["Edit"],
  phases: [
    { id: "inspect", allowedTools: [], advance: { event: "FileRead", min: 1 } },
    { id: "review", terminal: true, allowedTools: [], requires: [] },
  ],
}));
const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
const reservationId = parseReservationId("roster-modern-attempt");
if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
const createdAuthority = createImplementationAttemptAuthority({
  taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
  headSha: "1".repeat(40), reservedAt: instant.value,
  taskScopeBaseline: [], dirtySetBaseline: [],
});
if (!createdAuthority.ok) throw new Error(createdAuthority.error.errors.join("; "));
const modernGraph: TaskGraph = {
  current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
  spec_file: null, plan_file: null, current_wave: 1, executing_tasks: ["T1"],
  tasks: [taskFixture({
    id: "T1", description: "roster", agent: "code-implementer-agent",
    wave: 1, status: "pending", depends_on: [], file_list: [],
    active_implementation_attempt: createdAuthority.value,
    attempt_artifact_baseline: [], attempt_repository_baseline: [],
    reserved_at: createdAuthority.value.reservedAt,
  })],
  wave_gates: {},
};
writeFileSync(statePath, JSON.stringify(modernGraph, null, 2));

beforeEach(() => {
  try {
    chmodSync(statePath, 0o600);
  } catch {
    // First test setup may run before StateManager has protected the file.
  }
  writeFileSync(statePath, JSON.stringify(modernGraph, null, 2));
});

const sessions: string[] = [];
const session = (label: string) => {
  const s = `${uniq}-${label}`;
  sessions.push(s);
  return s;
};

afterAll(() => {
  delete process.env.LOOM_STATE_PATH;
  for (const s of sessions) {
    for (const suffix of [
      "active", "active.tmp", "machine", "task_graph", "evidence.jsonl", "cleanup",
      TASK_GRAPH_POINTER_LEASES_SUFFIX.slice(1),
    ]) {
      rmSync(join(SUBAGENT_DIR, `${s}.${suffix}`), { recursive: true, force: true });
    }
    for (const agentId of ["a-1", "reviewer-1"]) {
      const encodedAgent = Buffer.from(agentId, "utf8").toString("hex");
      rmSync(join(SUBAGENT_DIR, `${s}.${encodedAgent}.implementation-attempt.json`), { force: true });
      rmSync(join(SUBAGENT_DIR, `${s}.${encodedAgent}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`), { force: true });
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
});

const start = (s: string, agentId: string | null = "a-1", agentType = "loom:code-implementer-agent") => {
  const transcript = join(stateDir, `${s}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "Task ID: T1" } }) + "\n");
  return JSON.stringify({
    session_id: s,
    ...(agentId === null ? {} : { agent_id: agentId }),
    agent_type: agentType,
    agent_transcript_path: transcript,
  });
};

describe("mark-subagent-active — roster failure is contained, never silent", () => {
  it("blocks malformed hook input while a TaskGraph is active", async () => {
    process.env.LOOM_STATE_PATH = statePath;

    const result = await markActive("{not-json", []);

    expect(result).toMatchObject({ kind: "block" });
    if (result.kind === "block") expect(result.message).toContain("malformed SubagentStart input");
  });

  it("roster write failure blocks and rolls back every modern capability", async () => {
    const s = session("fail");
    process.env.LOOM_STATE_PATH = statePath;
    // A DIRECTORY at the .active path makes markAgentActive's append throw.
    mkdirSync(join(SUBAGENT_DIR, `${s}.active`), { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s), []);
      expect(result.kind).toBe("block");

      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("roster update failed");
      expect(text).toContain("refusing to arm machine binding");
    } finally {
      stderrSpy.mockRestore();
    }

    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(false);
  });

  it("machine binding failure blocks the Agent and rolls back the created .task_graph pointer", async () => {
    const s = session("bind-fail");
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(join(SUBAGENT_DIR, `${s}.machine`), { recursive: true });

    const result = await markActive(start(s), []);

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("bindMachineAgent failed");
      expect(result.message).toContain("refusing to run code-implementer-agent (a-1) ungated");
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(false);

    const parsedSession = parseSessionId(s);
    expect(parsedSession).not.toBeNull();
    if (parsedSession === null) return;
    expect(activeRosterProbe(parsedSession)).toBeNull();
    expect(shouldBlockDirectEdit("Edit", s, () => true, activeRosterProbe).kind).toBe("block");
  });

  it("reports an unproven rollback when strict roster removal itself fails", async () => {
    const s = session("rollback-fail");
    process.env.LOOM_STATE_PATH = statePath;
    const activePath = join(SUBAGENT_DIR, `${s}.active`);
    writeFileSync(activePath, "reviewer-1\tcode-reviewer\n");
    // A second surviving row makes rollback use the atomic rewrite path. Its
    // deterministic temporary slot is a directory, so strict removal cannot
    // prove the denied implementation Agent's role-bearing row was removed.
    mkdirSync(`${activePath}.tmp`);
    mkdirSync(join(SUBAGENT_DIR, `${s}.machine`));

    const result = await markActive(start(s), []);

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("bindMachineAgent failed");
      expect(result.message).toContain("active-roster rollback could not be proven");
      expect(result.message).toContain("EISDIR");
    }
    expect(readFileSync(activePath, "utf8")).toContain("a-1\tcode-implementer-agent");

    const parsedSession = parseSessionId(s);
    expect(parsedSession).not.toBeNull();
    if (parsedSession === null) return;
    expect(activeRosterProbe(parsedSession)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentType: "code-implementer-agent" }),
    ]));
    // This is why the failed rollback is security-sensitive: the ghost row is
    // still interpreted as an active implementation-role write authority.
    expect(shouldBlockDirectEdit("Edit", s, () => true, activeRosterProbe).kind).toBe("allow");
  });

  it("an inaccessible TaskGraph blocks before publishing any cross-repo pointer", async () => {
    const s = session("graph-eloop");
    const loop = join(stateDir, "graph-loop");
    symlinkSync(loop, loop);
    process.env.LOOM_STATE_PATH = loop;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s), []);
      expect(result.kind).toBe("block");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(false);
  });

  it("reports an unreadable stored task_graph pointer before attempting repair", async () => {
    const s = session("pointer-eloop");
    const pointer = join(SUBAGENT_DIR, `${s}.task_graph`);
    process.env.LOOM_STATE_PATH = statePath;
    symlinkSync(pointer, pointer);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s), []);
      expect(result.kind).toBe("block");
      const text = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
      expect(text).toContain(`failed to persist task_graph pointer authority for ${s}/a-1`);
      expect(text).toContain("cross-repo SubagentStop cleanup is unavailable");
      expect(text).toMatch(/ELOOP|too many levels of symbolic links/i);
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.a-1.implementation-attempt.json`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(false);
    const rolledBack = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(rolledBack.executing_tasks).toEqual([]);
    expect(rolledBack.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(rolledBack.tasks[0]?.implementation_attempt_history?.[0]).toMatchObject({
      transition: "infrastructure-blocked",
      failureKinds: ["reservation-reclaimed"],
    });
  });

  it("rolls back only newly acquired capabilities when a prior pointer lease already exists", async () => {
    const s = session("mixed-duplicate");
    process.env.LOOM_STATE_PATH = statePath;
    const previousMachines = process.env.LOOM_MACHINES_DIR;
    process.env.LOOM_MACHINES_DIR = guardedReviewMachines;
    try {
      const payload = start(s, "reviewer-1", "loom:guarded-review-agent");
      expect((await markActive(payload, [])).kind).toBe("passthrough");

      // Preserve the prior pointer lease, but simulate partial capability loss:
      // the roster is absent and the machine slot is now unwritable. The retry
      // creates a roster row, observes the old pointer, then fails machine bind.
      rmSync(join(SUBAGENT_DIR, `${s}.active`));
      rmSync(join(SUBAGENT_DIR, `${s}.machine`));
      mkdirSync(join(SUBAGENT_DIR, `${s}.machine`));

      const retry = await markActive(payload, []);

      expect(retry).toMatchObject({ kind: "block", message: expect.stringContaining("bindMachineAgent failed") });
      expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(false);
      expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
    } finally {
      if (previousMachines === undefined) delete process.env.LOOM_MACHINES_DIR;
      else process.env.LOOM_MACHINES_DIR = previousMachines;
    }
  });

  it("task_graph pointer write failure blocks a non-implementation Loom Agent", async () => {
    const s = session("review-pointer-eloop");
    const pointer = join(SUBAGENT_DIR, `${s}.task_graph`);
    process.env.LOOM_STATE_PATH = statePath;
    symlinkSync(pointer, pointer);

    const result = await markActive(start(s, "reviewer-1", "loom:code-reviewer"), []);

    expect(result).toMatchObject({
      kind: "block",
      message: expect.stringContaining("failed to persist task_graph pointer authority"),
    });
    const parsedSession = parseSessionId(s);
    expect(parsedSession).not.toBeNull();
    if (parsedSession !== null) expect(activeRosterProbe(parsedSession)).toBeNull();
  });

  it("control: a healthy start persists pointer cleanup authority and successful stop releases it", async () => {
    const s = session("ok");
    process.env.LOOM_STATE_PATH = statePath;
    const result = await markActive(start(s), []);
    const encodedAgent = Buffer.from("a-1", "utf8").toString("hex");
    const pointerBinding = join(SUBAGENT_DIR, `${s}.${encodedAgent}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`);
    expect(result.kind).toBe("passthrough");
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
    expect(existsSync(pointerBinding)).toBe(true);

    const duplicate = await markActive(start(s), []);
    expect(duplicate.kind).toBe("passthrough");
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
    expect(existsSync(pointerBinding)).toBe(true);

    const cleaned = await runCleanupSubagentFlag(JSON.stringify({
      session_id: s,
      agent_id: "a-1",
      agent_type: "loom:code-implementer-agent",
    }));

    expect(cleaned.kind).toBe("passthrough");
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(false);
    expect(existsSync(pointerBinding)).toBe(false);
  });

  it("an unparseable (traversal) session_id blocks and refuses all session-file writes", async () => {
    process.env.LOOM_STATE_PATH = statePath;
    const evil = "../mark-active-escape";

    const result = await markActive(start(evil), []);

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("invalid session_id");
      expect(result.message).toContain("exact authority cannot be bound");
    }
    // The traversal path was never created — neither inside nor above the dir.
    expect(existsSync(join(SUBAGENT_DIR, `${evil}.task_graph`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${evil}.active`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${evil}.machine`))).toBe(false);
  });

  it.each([
    ["missing", null],
    ["invalid", "evil:id"],
  ])("a machine-bearing review role with a %s agent_id is blocked before roster or pointer capability publication", async (_label, agentId) => {
    const s = session(`review-${_label}`);
    process.env.LOOM_STATE_PATH = statePath;
    const previousMachines = process.env.LOOM_MACHINES_DIR;
    process.env.LOOM_MACHINES_DIR = guardedReviewMachines;
    try {
      const result = await markActive(start(s, agentId, "loom:guarded-review-agent"), []);
      expect(result).toMatchObject({
        kind: "block",
        message: expect.stringContaining("Guarded Skill Machine"),
      });
    } finally {
      if (previousMachines === undefined) delete process.env.LOOM_MACHINES_DIR;
      else process.env.LOOM_MACHINES_DIR = previousMachines;
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(false);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(false);
  });

  it("an unparseable agent_type (path traversal) never reaches loadMachine — no bind, loud stderr", async () => {
    const s = session("evil-type");
    process.env.LOOM_STATE_PATH = statePath;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await markActive(start(s, "a-1", "../../outside/evil-agent"), []);
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("path-unsafe characters");
      expect(text).toContain("UNGATED");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(join(SUBAGENT_DIR, `${s}.machine`))).toBe(false);
    // Roster + task_graph writes still happen — only the machine bind refuses.
    expect(existsSync(join(SUBAGENT_DIR, `${s}.active`))).toBe(true);
    expect(existsSync(join(SUBAGENT_DIR, `${s}.task_graph`))).toBe(true);
  });
});
