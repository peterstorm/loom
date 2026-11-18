/**
 * Attestation is enforced, not instructed (ADR-0085): an implementation
 * Agent whose Task is armed for attestation cannot Edit or Write, on either
 * harness, and a Task whose mode cannot be observed fails closed with the
 * cause in the refusal.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  attestationWriteRefusal,
  taskWriteMode,
  type AttestationTask,
  type TaskWriteMode,
} from "../../src/core/attestation-writes";
import {
  callerWriteModeVerdict,
  shouldBlockDirectEdit,
  type ActiveRosterEntry,
  type CallerWriteMode,
} from "../../src/core/block-direct-edits";
import type { ImplementationBinding } from "../../src/core/implementation-binding";
import { callerWriteModeOf, readAttestationTasks } from "../../src/handlers/attestation-mode";
import { claudeCallerWriteMode } from "../../src/handlers/pre-tool-use/block-direct-edits";
import { parseSessionId } from "../../src/machine/evidence";
import type { StateManager } from "../../src/state-manager";

const SESSION = "attestation-guard-session";
const PROJECT = "/project";
const IMPLEMENTING: TaskWriteMode = { kind: "implementing" };
const ATTESTING: TaskWriteMode = { kind: "attesting" };
const entry = (agentId: string, agentType: string | null): ActiveRosterEntry => ({ agentId, agentType } as ActiveRosterEntry);
const bound = { kind: "bound", authority: { taskId: "T7" } } as unknown as ImplementationBinding;
/** A TaskGraph manager whose `load` answers `load`. */
const managerOf = (load: () => unknown) => ({ load }) as unknown as StateManager;
const graphHolding = (tasks: readonly AttestationTask[]) => () => managerOf(() => ({ tasks }));

/** One implementation caller `a-1`, bound to T7, writing inside the project, with `mode` as T7's write mode. */
const callerEdit = (mode: CallerWriteMode | undefined) => shouldBlockDirectEdit(
  "Edit", SESSION, () => true,
  () => [entry("a-1", "code-implementer-agent")],
  {
    artifactWrite: { callerAgentId: "a-1", targetPath: `${PROJECT}/src/a.ts`, projectRoot: PROJECT },
    implementationBinding: () => bound,
    callerWriteMode: () => mode,
  },
);

describe("taskWriteMode", () => {
  const observed = { ok: true as const, tasks: [{ id: "T1", implementation_attestation: true as const }, { id: "T2" }] };

  it("is attesting only for a Task armed for attestation, and unobservable, with the cause, otherwise", () => {
    expect(taskWriteMode(observed, "T1")).toEqual(ATTESTING);
    expect(taskWriteMode(observed, "T2")).toEqual(IMPLEMENTING);
    expect(taskWriteMode(observed, "T9")).toEqual({ kind: "unobservable", reason: "the TaskGraph holds no Task T9" });
    expect(taskWriteMode({ ok: false, reason: "corrupt" }, "T1")).toEqual({ kind: "unobservable", reason: "corrupt" });
  });
});

describe("the edit guard enforces attestation (Claude Code)", () => {
  it("refuses a bound implementation Agent's write while its Task is attesting, naming the Task", () => {
    expect(callerEdit({ taskId: "T7", mode: ATTESTING })).toEqual({ kind: "block", message: attestationWriteRefusal("T7") });
  });

  it("fails closed when the Task's mode cannot be observed, carrying the cause into the refusal", () => {
    const result = callerEdit({ taskId: "T7", mode: { kind: "unobservable", reason: "the TaskGraph of session s cannot be read: corrupt" } });
    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("cannot be read: corrupt") });
  });

  it("admits an implementing attempt, and a caller whose port answers undefined (no bound attempt)", () => {
    expect(callerEdit({ taskId: "T7", mode: IMPLEMENTING }).kind).toBe("allow");
    expect(callerEdit(undefined).kind).toBe("allow");
  });

  it("never consults the mode for a write the guard does not admit", () => {
    let asked = false;
    const result = shouldBlockDirectEdit(
      "Edit", SESSION, () => true, () => [entry("r-1", "code-reviewer")],
      {
        artifactWrite: { callerAgentId: "r-1", targetPath: `${PROJECT}/src/a.ts`, projectRoot: PROJECT },
        callerWriteMode: () => { asked = true; return { taskId: "T7", mode: ATTESTING }; },
      },
    );
    expect(result.kind).toBe("block");
    expect(asked).toBe(false);
  });

  it("leaves a write outside the orchestrated repository alone", () => {
    const result = shouldBlockDirectEdit(
      "Write", SESSION, () => true, () => [entry("a-1", "code-implementer-agent")],
      {
        locateEdit: () => ({
          repository: { kind: "resolved", roots: [PROJECT], protectedRoots: ["/tmp/claude-subagents"] },
          targets: { kind: "resolved", paths: ["/elsewhere/scratch.md"] },
        }),
        callerWriteMode: () => ({ taskId: "T7", mode: ATTESTING }),
      },
    );
    expect(result.kind).toBe("allow");
  });
});

describe("the edit guard enforces attestation (Pi write grants)", () => {
  it("refuses a granted implementation child whose Task is attesting, and admits one that is implementing", () => {
    const granted = (mode: TaskWriteMode) => shouldBlockDirectEdit(
      "edit", SESSION, () => true, () => [entry("pi-grant-abcdef0123456789", null)],
      { callerWriteMode: () => ({ taskId: "T4", mode }) },
    );
    expect(granted(ATTESTING)).toEqual({ kind: "block", message: attestationWriteRefusal("T4") });
    expect(granted(IMPLEMENTING).kind).toBe("allow");
  });
});

describe("callerWriteModeVerdict (property)", () => {
  it("allows exactly an absent caller or an implementing one", () => {
    const mode: fc.Arbitrary<TaskWriteMode> = fc.oneof(
      fc.constant(IMPLEMENTING), fc.constant(ATTESTING),
      fc.string().map((reason): TaskWriteMode => ({ kind: "unobservable", reason })),
    );
    fc.assert(fc.property(fc.option(mode, { nil: undefined }), (picked) => {
      const verdict = callerWriteModeVerdict(picked === undefined ? undefined : { taskId: "T1", mode: picked });
      expect(verdict.kind === "allow").toBe(picked === undefined || picked.kind === "implementing");
    }));
  });
});

describe("the shared shell read (handlers/attestation-mode)", () => {
  it("reads the resolved TaskGraph's Tasks, and names why when none resolves or it cannot be read", () => {
    expect(readAttestationTasks(graphHolding([{ id: "T1" }]), "test")).toEqual({ ok: true, tasks: [{ id: "T1" }] });
    expect(readAttestationTasks(() => null, "session s")).toEqual({ ok: false, reason: "no TaskGraph resolves for session s" });
    expect(readAttestationTasks(() => managerOf(() => { throw new Error("corrupt"); }), "session s"))
      .toEqual({ ok: false, reason: "the TaskGraph of session s cannot be read: corrupt" });
  });

  it("answers the named Task's mode from that graph", () => {
    expect(callerWriteModeOf("T1", graphHolding([{ id: "T1", implementation_attestation: true }]), "test"))
      .toEqual({ taskId: "T1", mode: ATTESTING });
  });
});

describe("claudeCallerWriteMode (Claude Code adapter)", () => {
  const session = parseSessionId(SESSION);
  if (session === null) throw new Error("fixture session id is invalid");
  const graphs: string[] = [];
  const graphOf = (sessionId: string) => { graphs.push(sessionId); return graphHolding([{ id: "T7", implementation_attestation: true }]); };

  it("reads the bound caller's Task from its session's graph", () => {
    expect(claudeCallerWriteMode(session, { callerId: "a-1", binding: bound }, graphOf)()).toEqual({ taskId: "T7", mode: ATTESTING });
    expect(graphs).toEqual([SESSION]);
  });

  it("answers undefined, reading nothing, for an unbound caller, a non-implementation caller or no session", () => {
    graphs.length = 0;
    const pending = { kind: "pending", reason: "not yet" } as ImplementationBinding;
    expect(claudeCallerWriteMode(session, { callerId: "a-1", binding: pending }, graphOf)()).toBeUndefined();
    expect(claudeCallerWriteMode(session, { callerId: "a-1", binding: null }, graphOf)()).toBeUndefined();
    expect(claudeCallerWriteMode(session, null, graphOf)()).toBeUndefined();
    expect(claudeCallerWriteMode(null, { callerId: "a-1", binding: bound }, graphOf)()).toBeUndefined();
    expect(graphs).toEqual([]);
  });
});
