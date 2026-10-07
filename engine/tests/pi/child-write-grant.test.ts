import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  activatePiChildWriteGrant,
  createPiChildWriteGrants,
  rejectedChildWriteGrantDebt,
  retainedChildWriteGrant,
  type ActiveChildWriteGrant,
  type PiChildWriteGrantPorts,
} from "../../../pi/child-write-grant";
import { injectPiWriteGrant, issuePiWriteGrant } from "../../../pi/write-grant";
import { parseAgentId, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import type { AgentId } from "../../src/machine/evidence";

const agentId = parseAgentId("pi-grant-child-1")!;
const pointer = { directory: "/state", pointerName: "p", registryName: "r", target: "/graph.json" } as unknown as SessionTaskGraphPointerBinding;
const scope = { scopeDirs: [".claude/specs/x/"], grantCwd: "/repo" } as const;
const active: ActiveChildWriteGrant = { ...scope, kind: "active", agentId, pointerBinding: pointer };

const none = new Set<never>();

describe("retainedChildWriteGrant", () => {
  it("retires a binding whose roster entry and pointer lease were both released", () => {
    expect(retainedChildWriteGrant(active, new Set<AgentId>([agentId]), new Set([pointer]))).toBeNull();
  });

  it("keeps an untouched binding active, scope included", () => {
    expect(retainedChildWriteGrant(active, none, none)).toEqual(active);
  });

  it("names only the roster entry when the pointer lease was released", () => {
    expect(retainedChildWriteGrant(active, none, new Set([pointer]))).toEqual({
      ...scope, kind: "roster-cleanup-pending", agentId, pointerBinding: null,
    });
  });

  it("names only the pointer lease when the roster entry was removed", () => {
    expect(retainedChildWriteGrant(active, new Set<AgentId>([agentId]), none)).toEqual({
      ...scope, kind: "pointer-cleanup-pending", agentId: null, pointerBinding: pointer,
    });
  });

  it("retires a pending variant once its last debt is released", () => {
    const rosterPending: ActiveChildWriteGrant = { kind: "roster-cleanup-pending", agentId, pointerBinding: null };
    expect(retainedChildWriteGrant(rosterPending, new Set<AgentId>([agentId]), none)).toBeNull();
    const pointerPending: ActiveChildWriteGrant = { kind: "pointer-cleanup-pending", agentId: null, pointerBinding: pointer };
    expect(retainedChildWriteGrant(pointerPending, none, new Set([pointer]))).toBeNull();
  });

  it("retains exactly the capabilities that were not released, never mutating the binding", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (rosterRemoved, pointerReleased) => {
      const before = structuredClone(active);
      const retained = retainedChildWriteGrant(
        active,
        rosterRemoved ? new Set<AgentId>([agentId]) : none,
        pointerReleased ? new Set([pointer]) : none,
      );
      expect(active).toEqual(before);
      expect(retained?.agentId ?? null).toBe(rosterRemoved ? null : agentId);
      expect(retained?.pointerBinding ?? null).toBe(pointerReleased ? null : pointer);
    }));
  });
});

describe("rejectedChildWriteGrantDebt", () => {
  const sessionId = parseSessionId("child-session")!;

  it("retains a partial roster entry as cleanup debt, keyed by its session, exactly when its removal failed", () => {
    fc.assert(fc.property(fc.boolean(), fc.array(fc.string(), { maxLength: 3 }), (partialMade, cleanupErrors) => {
      const debt = rejectedChildWriteGrantDebt(partialMade ? { sessionId, agentId } : null, cleanupErrors);
      expect(debt).toEqual(partialMade && cleanupErrors.length > 0
        ? { sessionId, grant: { kind: "roster-cleanup-pending", agentId, pointerBinding: null } }
        : null);
    }));
  });
});

describe("activatePiChildWriteGrant through in-memory registry and pointer ports", () => {
  let root: string;
  let priorSubagentDir: string | undefined;
  let cwd: string;
  let graph: string;

  beforeEach(() => {
    root = canonicalTempDir("loom-pi-child-write-grant-");
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

  type Call = readonly [string, ...string[]];

  /** A plain in-memory registry/pointer adapter: records every call and
   *  fails the operations a test names. */
  const fakePorts = (failing: ReadonlySet<"markActive" | "removeActive" | "bindPointer"> = new Set()) => {
    const calls: Call[] = [];
    const stderr: string[] = [];
    const roster = new Set<string>();
    const ports: PiChildWriteGrantPorts = {
      markActive: async (session, agent) => {
        calls.push(["markActive", session, agent]);
        if (failing.has("markActive")) throw new Error("roster write unavailable");
        roster.add(agent);
      },
      removeActive: async (session, agent) => {
        calls.push(["removeActive", session, agent]);
        if (failing.has("removeActive")) throw new Error("roster removal unavailable");
        roster.delete(agent);
      },
      bindPointer: async (session, taskGraphPath) => {
        calls.push(["bindPointer", session, taskGraphPath]);
        if (failing.has("bindPointer")) throw new Error("pointer lease unavailable");
        return pointer;
      },
      writeStderr: (line) => { stderr.push(line); },
    };
    return { ports, calls, stderr, roster };
  };

  const childEvent = () => {
    const grant = issuePiWriteGrant({ agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph });
    return {
      prompt: injectPiWriteGrant("Task ID: T1 implement the thing", grant),
      systemPrompt: "<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->",
    };
  };
  const ctx = (session = "child-session") => ({ cwd, sessionManager: { getSessionId: () => session } });

  it("binds the child's session: one roster entry, one pointer lease, an active scoped grant", async () => {
    const fake = fakePorts();
    const grants = createPiChildWriteGrants();
    expect(await activatePiChildWriteGrant(childEvent(), ctx(), grants, fake.ports)).toBeUndefined();
    expect(fake.calls.map(([name]) => name)).toEqual(["markActive", "bindPointer"]);
    expect(fake.calls[1]).toEqual(["bindPointer", "child-session", graph]);
    const granted = grants.active.get("child-session");
    expect(granted?.kind).toBe("active");
    expect(granted?.pointerBinding).toBe(pointer);
    expect(fake.roster.size).toBe(1);
    expect(grants.rejectedSessions.size).toBe(0);
    expect(fake.stderr).toEqual(["loom(pi): activated child write grant for T1/child-session\n"]);
  });

  it("rolls back the partial roster entry when the pointer bind fails, owing nothing", async () => {
    const fake = fakePorts(new Set(["bindPointer"]));
    const grants = createPiChildWriteGrants();
    const result = await activatePiChildWriteGrant(childEvent(), ctx(), grants, fake.ports);
    expect(result?.message?.customType).toBe("loom-write-grant-error");
    expect(String(result?.message?.content)).toContain("pointer lease unavailable");
    expect(String(result?.message?.content)).not.toContain("Cleanup failures");
    expect(fake.calls.map(([name]) => name)).toEqual(["markActive", "bindPointer", "removeActive"]);
    expect(fake.roster.size).toBe(0);
    expect(grants.active.has("child-session")).toBe(false);
    expect(grants.rejectedSessions.has("child-session")).toBe(true);
  });

  it("retains the partial roster entry as roster-cleanup-pending authority when its rollback fails", async () => {
    const fake = fakePorts(new Set(["bindPointer", "removeActive"]));
    const grants = createPiChildWriteGrants();
    const result = await activatePiChildWriteGrant(childEvent(), ctx(), grants, fake.ports);
    const granted = grants.active.get("child-session");
    expect(granted?.kind).toBe("roster-cleanup-pending");
    expect(granted?.pointerBinding).toBeNull();
    expect(fake.roster.size).toBe(1);
    expect(granted?.agentId).toBe([...fake.roster][0]);
    expect(String(result?.message?.content)).toContain("Cleanup failures: remove partial child roster entry");
    expect(fake.stderr.some((line) => line.startsWith("loom(pi): child write-grant cleanup failed:"))).toBe(true);
    expect(grants.rejectedSessions.has("child-session")).toBe(true);
  });

  it("makes no rollback attempt and owes nothing when the roster write itself fails", async () => {
    const fake = fakePorts(new Set(["markActive"]));
    const grants = createPiChildWriteGrants();
    const result = await activatePiChildWriteGrant(childEvent(), ctx(), grants, fake.ports);
    expect(String(result?.message?.content)).toContain("roster write unavailable");
    expect(fake.calls.map(([name]) => name)).toEqual(["markActive"]);
    expect(grants.active.size).toBe(0);
    expect(grants.rejectedSessions.has("child-session")).toBe(true);
  });

  it("leaves a prompt without a grant marker untouched", async () => {
    const fake = fakePorts();
    const grants = createPiChildWriteGrants();
    expect(await activatePiChildWriteGrant({ prompt: "Task ID: T1", systemPrompt: "" }, ctx(), grants, fake.ports))
      .toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(grants.active.size + grants.rejectedSessions.size).toBe(0);
  });
});
