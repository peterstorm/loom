import fc from "fast-check";
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
  it("returns one rewrite per marker in a parallel batch, leaving the payload untouched", () => {
    const input = {
      tasks: [
        { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5" },
        { agent: "ts-test-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T6", cwd: "/repo" },
      ],
    };
    expect(expandImplementationBriefMarkers(input, render)).toEqual({
      ok: true,
      rewrites: [
        { slot: 0, taskId: "T5", prompt: "**Task ID:** T5 rendered brief" },
        { slot: 1, taskId: "T6", prompt: "**Task ID:** T6 rendered brief" },
      ],
    });
    expect(input.tasks.map(({ task }) => task)).toEqual(["LOOM_IMPLEMENTATION_BRIEF: T5", "LOOM_IMPLEMENTATION_BRIEF: T6"]);
  });

  it("addresses a single-shape spawn as slot 0 and skips ordinary task text", () => {
    const single = { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5", agentScope: "user" };
    expect(expandImplementationBriefMarkers(single, render)).toEqual({
      ok: true,
      rewrites: [{ slot: 0, taskId: "T5", prompt: "**Task ID:** T5 rendered brief" }],
    });
    expect(single.task).toBe("LOOM_IMPLEMENTATION_BRIEF: T5");

    const ordinary = { tasks: [{ agent: "code-reviewer", task: "LOOM_REQUEST_ID: r1\nReview Task T5." }] };
    expect(expandImplementationBriefMarkers(ordinary, render)).toEqual({ ok: true, rewrites: [] });
  });

  it("keeps each rewrite on its own slot when markers sit between ordinary chain steps", () => {
    const chain = {
      chain: [
        { agent: "code-reviewer", task: "Review first." },
        { agent: "ts-test-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T6" },
      ],
    };
    expect(expandImplementationBriefMarkers(chain, render)).toEqual({
      ok: true,
      rewrites: [{ slot: 1, taskId: "T6", prompt: "**Task ID:** T6 rendered brief" }],
    });
  });

  it("refuses the whole batch, with no rewrite, when one marker cannot render", () => {
    const input = {
      tasks: [
        { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5" },
        { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T9" },
      ],
    };
    expect(expandImplementationBriefMarkers(input, render)).toEqual({
      ok: false,
      reason: "BLOCKED: spawn item 2 cannot expand its implementation brief: Task T9 is not owed a dispatch",
    });
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

  it("answers a malformed batch with no rewrites", () => {
    expect(expandImplementationBriefMarkers(null, render)).toEqual({ ok: true, rewrites: [] });
    expect(expandImplementationBriefMarkers(["LOOM_IMPLEMENTATION_BRIEF: T5"], render)).toEqual({ ok: true, rewrites: [] });
  });

  describe("invariants over arbitrary batches", () => {
    type Entry = Readonly<{ agent: string; task: string }>;
    const entry: fc.Arbitrary<Entry> = fc.oneof(
      fc.constantFrom("T5", "T6", "T9").chain((taskId) =>
        fc.constantFrom("code-implementer-agent", "ts-test-agent", "security-agent").map((agent) => ({
          agent,
          task: `LOOM_IMPLEMENTATION_BRIEF: ${taskId}`,
        }))),
      fc.string().map((task) => ({ agent: "code-reviewer", task })),
    );
    const batch = fc.oneof(
      fc.array(entry, { maxLength: 8 }).map((tasks) => ({ tasks })),
      fc.array(entry, { maxLength: 8 }).map((chain) => ({ chain })),
      entry.map((single) => ({ ...single })),
    );
    const entriesOf = (raw: Record<string, unknown>): readonly Entry[] =>
      (Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw.chain) ? raw.chain : [raw]) as readonly Entry[];

    it("never mutates the batch it reads", () => {
      fc.assert(fc.property(batch, (raw) => {
        const before = structuredClone(raw);
        expandImplementationBriefMarkers(raw, render);
        expect(raw).toEqual(before);
      }));
    });

    it("rewrites exactly the marker slots, in order, or refuses at the first unrenderable one", () => {
      fc.assert(fc.property(batch, (raw) => {
        const entries = entriesOf(raw);
        const markerSlots = entries.flatMap((candidate, slot) =>
          /^LOOM_IMPLEMENTATION_BRIEF: T\d+$/.test(candidate.task.trim()) ? [slot] : []);
        const firstRefused = markerSlots.find((slot) => {
          const taskId = entries[slot]!.task.trim().slice("LOOM_IMPLEMENTATION_BRIEF: ".length);
          return briefs[taskId]?.agent !== entries[slot]!.agent;
        });
        const expansion = expandImplementationBriefMarkers(raw, render);
        if (firstRefused === undefined) {
          expect(expansion.ok).toBe(true);
          if (expansion.ok) expect(expansion.rewrites.map(({ slot }) => slot)).toEqual(markerSlots);
        } else {
          expect(expansion).toEqual({ ok: false, reason: expect.stringContaining(`spawn item ${firstRefused + 1} `) });
        }
      }));
    });

    it("is idempotent: an applied expansion contains no marker left to expand", () => {
      fc.assert(fc.property(batch, (raw) => {
        const expansion = expandImplementationBriefMarkers(raw, render);
        if (!expansion.ok) return;
        const applied = structuredClone(raw);
        const appliedEntries = entriesOf(applied) as unknown as { task: string }[];
        for (const { slot, prompt } of expansion.rewrites) appliedEntries[slot]!.task = prompt;
        expect(expandImplementationBriefMarkers(applied, render)).toEqual({ ok: true, rewrites: [] });
      }));
    });
  });
});
