import { describe, expect, it } from "vitest";
import { expandImplementationBriefMarkers, type RenderTaskBrief } from "../../../pi/implementation-brief-expansion";

const briefs: Readonly<Record<string, { agent: string; prompt: string }>> = {
  T5: { agent: "code-implementer-agent", prompt: "**Task ID:** T5 rendered brief" },
  T6: { agent: "ts-test-agent", prompt: "**Task ID:** T6 rendered brief" },
};

const render: RenderTaskBrief = (taskId) => {
  const brief = briefs[taskId];
  return brief === undefined
    ? { ok: false, error: `Task ${taskId} is not owed a dispatch` }
    : {
        ok: true,
        value: {
          taskId,
          agent: brief.agent,
          dispatch: { kind: "initial-implementation", taskId, semanticAttempt: 1, promptAppendix: null },
          prompt: brief.prompt,
        },
      };
};

describe("expandImplementationBriefMarkers", () => {
  it("replaces every marker in a parallel batch with its rendered brief, in place", () => {
    const input = {
      tasks: [
        { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5" },
        { agent: "ts-test-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T6", cwd: "/repo" },
      ],
    };
    expect(expandImplementationBriefMarkers(input, render)).toEqual({ ok: true, expandedTaskIds: ["T5", "T6"] });
    expect(input.tasks.map(({ task }) => task)).toEqual(["**Task ID:** T5 rendered brief", "**Task ID:** T6 rendered brief"]);
  });

  it("expands a single-shape spawn and leaves ordinary task text untouched", () => {
    const single = { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5", agentScope: "user" };
    expect(expandImplementationBriefMarkers(single, render)).toEqual({ ok: true, expandedTaskIds: ["T5"] });
    expect(single.task).toBe("**Task ID:** T5 rendered brief");

    const ordinary = { tasks: [{ agent: "code-reviewer", task: "LOOM_REQUEST_ID: r1\nReview Task T5." }] };
    expect(expandImplementationBriefMarkers(ordinary, render)).toEqual({ ok: true, expandedTaskIds: [] });
    expect(ordinary.tasks[0]!.task).toBe("LOOM_REQUEST_ID: r1\nReview Task T5.");
  });

  it("refuses the whole batch, unmodified, when one marker cannot render", () => {
    const input = {
      tasks: [
        { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5" },
        { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T9" },
      ],
    };
    const expansion = expandImplementationBriefMarkers(input, render);
    expect(expansion).toEqual({ ok: false, reason: "BLOCKED: spawn item 2 cannot expand its implementation brief: Task T9 is not owed a dispatch" });
    expect(input.tasks.map(({ task }) => task)).toEqual(["LOOM_IMPLEMENTATION_BRIEF: T5", "LOOM_IMPLEMENTATION_BRIEF: T9"]);
  });

  it("refuses a marker spawned under an agent other than the Task's", () => {
    const input = { tasks: [{ agent: "security-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5" }] };
    expect(expandImplementationBriefMarkers(input, render)).toEqual({
      ok: false,
      reason: "BLOCKED: spawn item 1 names agent security-agent but T5 is assigned to code-implementer-agent",
    });
    expect(input.tasks[0]!.task).toBe("LOOM_IMPLEMENTATION_BRIEF: T5");
  });
});
