/**
 * Exact Implementation Attempt binding — the pure core.
 *
 * The business rules pinned here:
 *  - an Agent binds ONLY to the attempt of the Task its own first prompt
 *    names, whatever else is executing beside it (Wave runs spawn several
 *    implementers of one type in parallel);
 *  - a transcript not yet written is retriable (`unavailable`), never a
 *    refusal and never a guess;
 *  - only `bound` admits a write, and a calling implementation Agent is judged
 *    by its OWN binding — a bound sibling never lends it authority;
 *  - a harness that supplies no binding probe (Pi) keeps role admission.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  identifyImplementationAttempt,
  type FirstPromptObservation,
  type ImplementationBinding,
} from "../../src/core/implementation-binding";
import {
  implementationWriteVerdict,
  shouldBlockDirectEdit,
  type ActiveRosterEntry,
} from "../../src/core/block-direct-edits";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import type { TaskGraph } from "../../src/types";

function attempt(taskId: string): ImplementationAttemptAuthority {
  const instant = parseIsoInstant("2026-10-02T00:00:00.000Z");
  const reservation = parseReservationId(`binding-${taskId}`);
  if (!instant.ok || !reservation.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId, wave: 1, semanticAttempt: 1, reservationId: reservation.value,
    headSha: "1".repeat(40), reservedAt: instant.value,
    taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

type TaskShape = Readonly<{ executing: boolean; hasAttempt: boolean }>;

function graphOf(shapes: readonly TaskShape[]): TaskGraph {
  const tasks = shapes.map((shape, index) => taskFixture({
    id: `T${index + 1}`, description: "binding", agent: "code-implementer-agent",
    wave: 1, depends_on: [], file_list: [],
    ...(shape.hasAttempt ? { active_implementation_attempt: attempt(`T${index + 1}`) } : {}),
  }));
  return {
    ...graphFixture(tasks),
    executing_tasks: shapes.flatMap((shape, index) => shape.executing ? [`T${index + 1}`] : []),
  };
}

const taskShapes = fc.array(
  fc.record({ executing: fc.boolean(), hasAttempt: fc.boolean() }),
  { minLength: 1, maxLength: 6 },
);
/** Prompt phrasings extractTaskId recognises, canonical and legacy. */
const phrasing = fc.constantFrom(
  (id: string) => `**Task ID:** ${id}\n\nImplement it.`,
  (id: string) => `Task ID: ${id}`,
  (id: string) => `Please implement ${id} now.`,
);

describe("identifyImplementationAttempt — the prompt's own Task, never a sibling's", () => {
  it("identifies exactly the named Task's active attempt iff that Task is executing with one", () => {
    fc.assert(fc.property(taskShapes, fc.nat(), phrasing, (shapes, pick, phrase) => {
      // Names range one past the graph, so unknown Tasks are generated too.
      const named = (pick % (shapes.length + 1)) + 1;
      const graph = graphOf(shapes);
      const result = identifyImplementationAttempt({ kind: "prompt", text: phrase(`T${named}`) }, graph);
      const shape = shapes[named - 1];
      if (shape !== undefined && shape.executing && shape.hasAttempt) {
        expect(result.kind).toBe("identified");
        if (result.kind === "identified") {
          expect(result.authority.taskId).toBe(`T${named}`);
          expect(result.authority).toBe(graph.tasks[named - 1]!.active_implementation_attempt);
        }
      } else {
        expect(result.kind).toBe("refused");
      }
    }));
  });

  it("never binds an Agent whose prompt names no Task, however many attempts are executing", () => {
    fc.assert(fc.property(taskShapes, (shapes) => {
      const result = identifyImplementationAttempt({ kind: "prompt", text: "Implement the requested change" }, graphOf(shapes));
      expect(result).toEqual({ kind: "refused", reason: "trusted first user prompt contains no Task id" });
    }));
  });

  it("an unwritten transcript is retriable and an untrusted one refused, independent of the graph", () => {
    fc.assert(fc.property(taskShapes, fc.string(), (shapes, reason) => {
      const graph = graphOf(shapes);
      const unwritten: FirstPromptObservation = { kind: "unwritten", reason };
      const untrusted: FirstPromptObservation = { kind: "untrusted", reason };
      expect(identifyImplementationAttempt(unwritten, graph)).toEqual({ kind: "unavailable", reason });
      expect(identifyImplementationAttempt(untrusted, graph)).toEqual({ kind: "refused", reason });
    }));
  });

  it("names the refusal precisely", () => {
    const graph = graphOf([{ executing: true, hasAttempt: true }, { executing: false, hasAttempt: true }]);
    expect(identifyImplementationAttempt({ kind: "prompt", text: "Task ID: T9" }, graph))
      .toEqual({ kind: "refused", reason: "trusted first user prompt names unknown Task T9" });
    expect(identifyImplementationAttempt({ kind: "prompt", text: "Task ID: T2" }, graph))
      .toEqual({ kind: "refused", reason: "Task T2 has no current modern implementation attempt" });
  });
});

const binding: fc.Arbitrary<ImplementationBinding> = fc.oneof(
  fc.constant<ImplementationBinding>({ kind: "bound", authority: attempt("T1") }),
  fc.string().map((reason): ImplementationBinding => ({ kind: "pending", reason })),
  fc.string().map((reason): ImplementationBinding => ({ kind: "refused", reason })),
);

describe("implementationWriteVerdict — only bound admits", () => {
  it("allows iff bound; pending says retriable, refused says it stays blocked", () => {
    fc.assert(fc.property(binding, (state) => {
      const verdict = implementationWriteVerdict(state);
      expect(verdict.kind).toBe(state.kind === "bound" ? "allow" : "block");
      if (verdict.kind === "block" && state.kind !== "bound") {
        expect(verdict.message).toContain(state.reason);
        expect(verdict.message).toContain(state.kind === "pending" ? "retriable" : "stay blocked");
      }
    }));
  });
});

const entry = (agentId: string, agentType: string | null): ActiveRosterEntry =>
  ({ agentId, agentType } as ActiveRosterEntry);
const SESSION = "binding-core-session";
const PROJECT = "/project";

describe("shouldBlockDirectEdit with a binding probe (Claude Code)", () => {
  const rosterOfBindings = fc.array(binding, { minLength: 1, maxLength: 5 });

  it("a calling implementation Agent is admitted by its own binding alone", () => {
    fc.assert(fc.property(rosterOfBindings, fc.nat(), (states, pick) => {
      const ids = states.map((_, index) => `a-${index}`);
      const caller = ids[pick % ids.length]!;
      const stateOf = new Map(ids.map((id, index) => [id, states[index]!]));
      const result = shouldBlockDirectEdit(
        "Edit", SESSION, () => true,
        () => ids.map((id) => entry(id, "code-implementer-agent")),
        { callerAgentId: caller, targetPath: `${PROJECT}/src/a.ts`, projectRoot: PROJECT },
        (agentId) => stateOf.get(agentId)!,
      );
      expect(result.kind).toBe(stateOf.get(caller)!.kind === "bound" ? "allow" : "block");
    }));
  });

  it("an uncalled pending or refused row never admits anyone; a bound row keeps the roster-wide admission", () => {
    fc.assert(fc.property(rosterOfBindings, (states) => {
      const ids = states.map((_, index) => `a-${index}`);
      const stateOf = new Map(ids.map((id, index) => [id, states[index]!]));
      const result = shouldBlockDirectEdit(
        "Write", SESSION, () => true,
        () => ids.map((id) => entry(id, "code-implementer-agent")),
        { callerAgentId: null, targetPath: `${PROJECT}/src/a.ts`, projectRoot: PROJECT },
        (agentId) => stateOf.get(agentId)!,
      );
      expect(result.kind).toBe(states.some((state) => state.kind === "bound") ? "allow" : "block");
    }));
  });

  it("without a probe (Pi), implementation roles and write grants still admit by role", () => {
    expect(shouldBlockDirectEdit("Edit", SESSION, () => true, () => [entry("a-0", "code-implementer-agent")]).kind)
      .toBe("allow");
    expect(shouldBlockDirectEdit("Edit", SESSION, () => true, () => [entry("pi-grant-abcdef0123456789", null)]).kind)
      .toBe("allow");
  });

  it("the probe never gates non-implementation callers or Pi write grants", () => {
    const refusedEverywhere = (): ImplementationBinding => ({ kind: "refused", reason: "never asked" });
    expect(shouldBlockDirectEdit(
      "Write", SESSION, () => true,
      () => [entry("w-1", "specify-agent")],
      { callerAgentId: "w-1", targetPath: `${PROJECT}/.claude/specs/x/spec.md`, projectRoot: PROJECT },
      refusedEverywhere,
    ).kind).toBe("allow");
    expect(shouldBlockDirectEdit(
      "Edit", SESSION, () => true, () => [entry("pi-grant-abcdef0123456789", null)], undefined, refusedEverywhere,
    ).kind).toBe("allow");
  });
});
