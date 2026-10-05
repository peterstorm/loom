import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  retainedChildWriteGrant,
  type ActiveChildWriteGrant,
} from "../../../pi/child-write-grant";
import { parseAgentId, type SessionTaskGraphPointerBinding } from "../../src/machine";
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
