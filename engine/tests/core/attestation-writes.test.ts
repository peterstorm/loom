/**
 * Attestation is enforced, not instructed (ADR-0085): an implementation
 * Agent whose Task is armed for attestation cannot Edit or Write, on either
 * harness, and a Task whose mode cannot be observed fails closed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { attestationWriteRefusal, taskWriteMode, type AttestationTask } from "../../src/core/attestation-writes";
import {
  callerWriteModeVerdict,
  shouldBlockDirectEdit,
  type ActiveRosterEntry,
  type CallerWriteMode,
} from "../../src/core/block-direct-edits";
import type { ImplementationBinding } from "../../src/core/implementation-binding";
import { readAttestationTasks } from "../../src/handlers/pre-tool-use/block-direct-edits";
import type { StateManager } from "../../src/state-manager";

const SESSION = "attestation-guard-session";
const PROJECT = "/project";
const entry = (agentId: string, agentType: string | null): ActiveRosterEntry => ({ agentId, agentType } as ActiveRosterEntry);
const bound = { kind: "bound", authority: { taskId: "T7" } } as unknown as ImplementationBinding;

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
  const tasks: readonly AttestationTask[] = [
    { id: "T1", implementation_attestation: true },
    { id: "T2" },
  ];

  it("is attesting only for a Task armed for attestation, and unobservable for an unknown Task or unreadable graph", () => {
    expect(taskWriteMode(tasks, "T1")).toBe("attesting");
    expect(taskWriteMode(tasks, "T2")).toBe("implementing");
    expect(taskWriteMode(tasks, "T9")).toBe("unobservable");
    expect(taskWriteMode(null, "T1")).toBe("unobservable");
  });
});

describe("the edit guard enforces attestation (Claude Code)", () => {
  it("refuses a bound implementation Agent's write while its Task is attesting, naming the Task", () => {
    expect(callerEdit({ taskId: "T7", mode: "attesting" })).toEqual({ kind: "block", message: attestationWriteRefusal("T7") });
  });

  it("fails closed when the Task's mode cannot be observed", () => {
    const result = callerEdit({ taskId: "T7", mode: "unobservable" });
    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("cannot read the TaskGraph") });
  });

  it("admits an implementing attempt, and a caller with no bound attempt is not asked", () => {
    expect(callerEdit({ taskId: "T7", mode: "implementing" }).kind).toBe("allow");
    expect(callerEdit(undefined).kind).toBe("allow");
  });

  it("never consults the mode for a write the guard does not admit", () => {
    let asked = false;
    const result = shouldBlockDirectEdit(
      "Edit", SESSION, () => true, () => [entry("r-1", "code-reviewer")],
      {
        artifactWrite: { callerAgentId: "r-1", targetPath: `${PROJECT}/src/a.ts`, projectRoot: PROJECT },
        callerWriteMode: () => { asked = true; return { taskId: "T7", mode: "attesting" }; },
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
        callerWriteMode: () => ({ taskId: "T7", mode: "attesting" }),
      },
    );
    expect(result.kind).toBe("allow");
  });
});

describe("the edit guard enforces attestation (Pi write grants)", () => {
  it("refuses a granted implementation child whose Task is attesting, and admits one that is implementing", () => {
    const granted = (mode: CallerWriteMode["mode"]) => shouldBlockDirectEdit(
      "edit", SESSION, () => true, () => [entry("pi-grant-abcdef0123456789", null)],
      { callerWriteMode: () => ({ taskId: "T4", mode }) },
    );
    expect(granted("attesting")).toEqual({ kind: "block", message: attestationWriteRefusal("T4") });
    expect(granted("implementing").kind).toBe("allow");
  });
});

describe("callerWriteModeVerdict (property)", () => {
  it("allows exactly an absent caller or an implementing one", () => {
    const mode = fc.constantFrom("implementing", "attesting", "unobservable") as fc.Arbitrary<CallerWriteMode["mode"]>;
    fc.assert(fc.property(fc.option(mode, { nil: undefined }), (picked) => {
      const verdict = callerWriteModeVerdict(picked === undefined ? undefined : { taskId: "T1", mode: picked });
      expect(verdict.kind === "allow").toBe(picked === undefined || picked === "implementing");
    }));
  });
});

describe("readAttestationTasks (shell)", () => {
  it("reads the Tasks of the resolved TaskGraph, and answers null when none resolves or it cannot be read", () => {
    const manager = (load: () => unknown) => ({ load }) as unknown as StateManager;
    expect(readAttestationTasks(() => manager(() => ({ tasks: [{ id: "T1", implementation_attestation: true }] })), "test"))
      .toEqual([{ id: "T1", implementation_attestation: true }]);
    expect(readAttestationTasks(() => null, "test")).toBeNull();
    expect(readAttestationTasks(() => manager(() => { throw new Error("corrupt"); }), "test")).toBeNull();
  });
});
