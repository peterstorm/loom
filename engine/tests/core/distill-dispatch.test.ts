/**
 * Distill Task dispatch (ADR-0068 §3, §8): status withholds the Wave's distill
 * pass until every other Task of the Wave is implemented and unreserved,
 * registration refuses it by the same rule, and its dispatch carries the
 * distill appendix the spawn gate binds line for line.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DISTILL_APPENDIX_HEADER,
  distillPromptAppendix,
  distillWithheldMessage,
} from "../../src/core/distill-task";
import { classifyImplementationWindow, type ImplementationWindow } from "../../src/core/implementation-window";
import { authorizeImplementationSpawn } from "../../src/core/implementation-retry";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import {
  taskExecutionDecision,
  taskExecutionOwnershipError,
  taskExecutionRegistrationError,
  type TaskExecutionBaselines,
} from "../../src/core/validate-task-execution";
import type { Task, TaskGraph } from "../../src/types";
import { implementationEscalatedLineage } from "../fixtures/implementation-escalation";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import {
  distillTaskFixture,
  graphFixture,
  siblingTaskFixture,
  type DistillTaskFixtureInput,
  type TaskFixtureInput,
} from "../fixtures/task-lifecycle";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const LIVE = new Date(NOW).toISOString();
const STALE = "2000-01-01T00:00:00.000Z";
const observed = (anyActiveForGraph = false) => ({ kind: "observed" as const, observedAtMs: NOW, anyActiveForGraph });

/** A Wave sibling owning `src/<id>.ts`, the spelling this suite's scopes and messages use. */
const sibling = (id: string, overrides: Partial<TaskFixtureInput> = {}): Task =>
  siblingTaskFixture({ id, file_list: [`src/${id}.ts`], ...overrides });

/** The Wave's Distill Task T9 over `scope`; `implemented` settles it on the `unchanged` basis. */
const distill = (scope: readonly string[], overrides: Partial<DistillTaskFixtureInput> = {}): Task =>
  distillTaskFixture({ id: "T9", wave: 1, scope, ...overrides });

const SCOPE = ["src/T1.ts", "src/T2.ts"] as const;
const wave = (first: Task, second: Task, pass: Task = distill(SCOPE), executing: readonly string[] = []): TaskGraph =>
  ({ ...graphFixture([first, second, pass]), executing_tasks: [...executing] });

const offered = (window: ImplementationWindow): readonly string[] =>
  window.kind === "window" && window.recovery.kind === "spawn-wave-implementation"
    ? window.recovery.dispatches.map(({ taskId }) => taskId)
    : [];

describe("the implementation window withholds a Distill Task (ADR-0068 §3)", () => {
  it("offers only the siblings while they are dispatchable, and keeps the pass pending", () => {
    const window = classifyImplementationWindow(wave(sibling("T1"), sibling("T2")), observed(), []);
    expect(window).toMatchObject({ kind: "window", pendingTaskIds: ["T1", "T2", "T9"], activeTaskIds: [] });
    expect(offered(window)).toEqual(["T1", "T2"]);
  });

  it("offers the dispatchable siblings beside an active one, never the pass", () => {
    const graph = wave(sibling("T1", { reserved_at: LIVE }), sibling("T2"), distill(SCOPE), ["T1"]);
    const window = classifyImplementationWindow(graph, observed(), []);
    expect(window).toMatchObject({ kind: "window", activeTaskIds: ["T1"] });
    expect(offered(window)).toEqual(["T2"]);
  });

  it("awaits the active siblings when nothing else is dispatchable", () => {
    const graph = wave(sibling("T1", { reserved_at: LIVE }), sibling("T2", { status: "implemented" }), distill(SCOPE), ["T1"]);
    expect(classifyImplementationWindow(graph, observed(), [])).toMatchObject({
      kind: "window",
      pendingTaskIds: ["T1", "T9"],
      recovery: { kind: "await-wave-implementation", activeTaskIds: ["T1"] },
    });
  });

  it("withholds the pass while an implemented sibling still holds a live reservation", () => {
    const graph = wave(
      sibling("T1", { status: "implemented", reserved_at: LIVE }), sibling("T2", { status: "implemented" }), distill(SCOPE), ["T1"],
    );
    expect(classifyImplementationWindow(graph, observed(), [])).toMatchObject({
      kind: "window", recovery: { kind: "await-wave-implementation", activeTaskIds: ["T1"] },
    });
  });

  it("re-dispatches a sibling whose reservation is reclaimable before it offers the pass", () => {
    const graph = wave(sibling("T1", { reserved_at: STALE }), sibling("T2", { status: "implemented" }), distill(SCOPE), ["T1"]);
    expect(offered(classifyImplementationWindow(graph, observed(), []))).toEqual(["T1"]);
  });

  it("escalates a sibling's terminal failure instead of offering the pass", () => {
    const { retry, escalation } = implementationEscalatedLineage();
    const escalated: Task = {
      ...sibling("T1"),
      implementation_attempt_history: [retry, escalation],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    };
    const window = classifyImplementationWindow(wave(escalated, sibling("T2", { status: "implemented" })), observed(), []);
    expect(window).toMatchObject({
      kind: "window", recovery: { kind: "escalate-wave-implementation", tasks: [{ taskId: "T1" }] },
    });
  });

  it.each<readonly [string, Task["status"]]>([["implemented", "implemented"], ["completed", "completed"]])(
    "offers the pass as the one dispatch once every sibling is %s",
    (_label, status) => {
      const window = classifyImplementationWindow(wave(sibling("T1", { status }), sibling("T2", { status })), observed(), []);
      expect(window).toMatchObject({
        kind: "window",
        pendingTaskIds: ["T9"],
        recovery: { kind: "spawn-wave-implementation", dispatches: [{ kind: "initial-implementation", taskId: "T9" }] },
      });
    },
  );

  it("does not wait for another Wave's Tasks", () => {
    const graph: TaskGraph = {
      ...graphFixture([sibling("T1", { status: "implemented" }), sibling("T2", { wave: 2 }), distill(["src/T1.ts"])]),
      executing_tasks: [],
    };
    expect(offered(classifyImplementationWindow(graph, observed(), []))).toEqual(["T9"]);
  });

  it("awaits the pass itself while it executes", () => {
    const graph = wave(
      sibling("T1", { status: "implemented" }), sibling("T2", { status: "implemented" }), distill(SCOPE, { reserved_at: LIVE }), ["T9"],
    );
    expect(classifyImplementationWindow(graph, observed(), [])).toMatchObject({
      kind: "window", recovery: { kind: "await-wave-implementation", activeTaskIds: ["T9"] },
    });
  });

  it("cannot start the Wave Gate before the pass settles, and leaves the window once it has", () => {
    const settledSiblings = [sibling("T1", { status: "implemented" }), sibling("T2", { status: "implemented" })] as const;
    const before = classifyImplementationWindow(wave(...settledSiblings), observed(), []);
    expect(before).toMatchObject({ kind: "window", recovery: { kind: "spawn-wave-implementation" } });

    const after = classifyImplementationWindow(wave(...settledSiblings, distill(SCOPE, { status: "implemented" })), observed(), []);
    expect(after.kind).toBe("window");
    if (after.kind !== "window") return;
    expect(["start-wave-gate", "repair-wave-start-readiness"]).toContain(after.recovery.kind);
    expect(after.pendingTaskIds).toEqual([]);
  });

  it("names the blockers when a withheld pass can never start", () => {
    // Two distill passes in one Wave wait for each other: no legal graph holds this.
    const graph = wave(sibling("T1", { status: "implemented" }), distill(["src/T1.ts"], { id: "T8" }), distill(["src/T1.ts"]));
    expect(classifyImplementationWindow(graph, observed(), [])).toEqual({
      kind: "contradiction",
      reason: {
        kind: "authority-contradiction",
        taskId: "T8",
        message: `${distillWithheldMessage("T8", ["T9"])}; none of them is dispatchable, active or escalated, ` +
          "so the distill pass can never start; repair the Task Graph",
      },
    });
  });
});

const baselinesFor = (tasks: readonly Task[]): TaskExecutionBaselines => new Map(tasks.map((task) => {
  const baseline = (task.file_list ?? []).map((artifact) => ({ artifact, snapshot: { kind: "missing" as const } }));
  return [task.id, { proof: baseline, attempt: baseline, repositoryAttempt: [], repositoryObservation: [] }] as const;
}));
const spawnOf = (task: Task) => ({ kind: "implementation" as const, prompt: `**Task ID:** ${task.id}`, description: "" });

describe("registration refuses a withheld Distill Task (ADR-0068 §3)", () => {
  it("refuses it while a sibling is not implemented, naming every blocker", () => {
    expect(taskExecutionDecision(wave(sibling("T1"), sibling("T2", { status: "implemented" })), "T9")).toEqual({
      kind: "ineligible", reason: distillWithheldMessage("T9", ["T1"]),
    });
    expect(taskExecutionDecision(wave(sibling("T1"), sibling("T2")), "T9")).toEqual({
      kind: "ineligible", reason: distillWithheldMessage("T9", ["T1", "T2"]),
    });
  });

  it("refuses it while an implemented sibling is still reserved, stale or not", () => {
    const graph = wave(
      sibling("T1", { status: "implemented", reserved_at: STALE }), sibling("T2", { status: "implemented" }), distill(SCOPE), ["T1"],
    );
    expect(taskExecutionDecision(graph, "T9")).toEqual({ kind: "ineligible", reason: distillWithheldMessage("T9", ["T1"]) });
  });

  it("admits it once every sibling is implemented and unreserved", () => {
    const graph = wave(sibling("T1", { status: "implemented" }), sibling("T2", { status: "completed" }));
    expect(taskExecutionDecision(graph, "T9")).toEqual({ kind: "eligible" });
    // Its paths overlap its siblings' by design; they no longer execute, so ownership admits it.
    expect(taskExecutionOwnershipError(graph, ["T9"], "parallel")).toBeNull();
    const pass = distill(SCOPE);
    expect(taskExecutionRegistrationError(graph, [spawnOf(pass)], ["T9"], "parallel", baselinesFor([pass]))).toBeNull();
  });

  it("leaves every other Task's decision as it was", () => {
    const graph = wave(sibling("T1"), sibling("T2", { status: "implemented" }));
    expect(taskExecutionDecision(graph, "T1")).toEqual({ kind: "eligible" });
    expect(taskExecutionDecision(graph, "T1", ["T1", "T9"])).toEqual({ kind: "eligible" });
  });

  describe("in a batch", () => {
    it("refuses the pass beside a sibling that is not implemented", () => {
      const first = sibling("T1");
      const pass = distill(SCOPE);
      const graph = wave(first, sibling("T2", { status: "implemented" }), pass);
      expect(taskExecutionDecision(graph, "T9", ["T1", "T9"])).toEqual({
        kind: "ineligible", reason: distillWithheldMessage("T9", ["T1"]),
      });
      // The locked re-check refuses the whole batch; the shared declared path decides first.
      expect(taskExecutionRegistrationError(
        graph, [spawnOf(first), spawnOf(pass)], ["T1", "T9"], "parallel", baselinesFor([first, pass]),
      )).toBe("Parallel implementation tasks T1 and T9 both declare src/T1.ts; use disjoint scopes.");
    });

    it("refuses the pass beside a pending sibling whose files it does not hold", () => {
      const tests = sibling("T2", { file_list: ["tests/T2.test.ts"] });
      const pass = distill(["src/T1.ts"]);
      const graph = wave(sibling("T1", { status: "implemented" }), tests, pass);
      expect(taskExecutionRegistrationError(
        graph, [spawnOf(tests), spawnOf(pass)], ["T2", "T9"], "parallel", baselinesFor([tests, pass]),
      )).toBe(distillWithheldMessage("T9", ["T2"]));
    });

    it("refuses the pass beside an implemented sibling registering in the same batch", () => {
      const tests = sibling("T2", { status: "implemented", file_list: ["tests/T2.test.ts"] });
      const pass = distill(["src/T1.ts"]);
      const graph = wave(sibling("T1", { status: "implemented" }), tests, pass);
      expect(taskExecutionDecision(graph, "T9")).toEqual({ kind: "eligible" });
      expect(taskExecutionRegistrationError(
        graph, [spawnOf(tests), spawnOf(pass)], ["T2", "T9"], "parallel", baselinesFor([tests, pass]),
      )).toBe(distillWithheldMessage("T9", ["T2"]));
    });

    it("refuses the pass while a sibling still executes on a path it holds", () => {
      const graph = wave(sibling("T1", { reserved_at: LIVE }), sibling("T2", { status: "implemented" }), distill(SCOPE), ["T1"]);
      expect(taskExecutionOwnershipError(graph, ["T9"], "parallel"))
        .toBe("Task T9 cannot execute while T1 owns declared path src/T1.ts.");
    });
  });
});

type SiblingState = Readonly<{
  status: "pending" | "implemented" | "completed";
  reservation: "none" | "live" | "stale";
}>;

/** A completed Task never holds a reservation: the window reports that graph as a contradiction of its own. */
const siblingState: fc.Arbitrary<SiblingState> = fc.oneof(
  fc.record({ status: fc.constantFrom("pending" as const, "implemented" as const), reservation: fc.constantFrom("none" as const, "live" as const, "stale" as const) }),
  fc.constant({ status: "completed" as const, reservation: "none" as const }),
);

describe("the dispatch rule holds for every Wave (ADR-0068 §3)", () => {
  it("offers the pass exactly when every sibling is settled and unreserved, and never offers what registration refuses", () => {
    fc.assert(fc.property(fc.array(siblingState, { minLength: 1, maxLength: 5 }), (states) => {
      const siblings = states.map(({ status, reservation }, index) => sibling(`T${index + 1}`, {
        status,
        ...(reservation === "none" ? {} : { reserved_at: reservation === "live" ? LIVE : STALE }),
      }));
      const graph: TaskGraph = {
        ...graphFixture([...siblings, distill(siblings.flatMap(({ file_list }) => file_list ?? []))]),
        executing_tasks: siblings.filter((_task, index) => states[index]?.reservation !== "none").map(({ id }) => id),
      };
      const dispatched = offered(classifyImplementationWindow(graph, observed(), []));
      const ready = states.every(({ status, reservation }) => status !== "pending" && reservation === "none");

      expect(dispatched.includes("T9")).toBe(ready);
      expect(taskExecutionDecision(graph, "T9").kind).toBe(ready ? "eligible" : "ineligible");
      for (const taskId of dispatched) expect(taskExecutionDecision(graph, taskId)).toEqual({ kind: "eligible" });
    }));
  });
});

const retrying = (task: Task): Task => ({
  ...task,
  implementation_attempt_history: [semanticAttemptReceipt(task.id, 1, [])],
  implementation_retry_protocol: 2,
  implementation_retry_history_start: 0,
});

const appendixOf = (task: Task): string => {
  const derivation = deriveTaskImplementationDispatch(task);
  if (derivation.kind !== "dispatch" || derivation.dispatch.promptAppendix === null) {
    throw new Error(`fixture Task must be owed a dispatch with an appendix, got ${derivation.kind}`);
  }
  return derivation.dispatch.promptAppendix;
};

describe("a Distill Task's dispatch carries the distill appendix (ADR-0068 §8)", () => {
  const pass = distill(SCOPE);

  it("is the whole appendix of its initial dispatch", () => {
    expect(deriveTaskImplementationDispatch(pass)).toEqual({
      kind: "dispatch",
      dispatch: { kind: "initial-implementation", taskId: "T9", semanticAttempt: 1, promptAppendix: distillPromptAppendix(pass) },
    });
  });

  it("follows the retry context on a retry dispatch", () => {
    const derivation = deriveTaskImplementationDispatch(retrying(pass));
    expect(derivation).toMatchObject({ kind: "dispatch", dispatch: { kind: "retry-implementation", semanticAttempt: 2 } });
    const [retryLine, ...rest] = appendixOf(retrying(pass)).split("\n");
    expect(retryLine).toMatch(/^LOOM_IMPLEMENTATION_RETRY_CONTEXT: \{/);
    expect(rest.join("\n")).toBe(distillPromptAppendix(pass));
  });

  it("is absent from every other Task's dispatch", () => {
    expect(deriveTaskImplementationDispatch(sibling("T1"))).toMatchObject({ dispatch: { promptAppendix: null } });
    expect(appendixOf(retrying(sibling("T1")))).not.toContain(DISTILL_APPENDIX_HEADER);
  });
});

describe("the spawn gate binds the distill appendix (ADR-0068 §8)", () => {
  const pass = distill(SCOPE);
  const appendix = distillPromptAppendix(pass);
  const prompt = (body: string): string => `**Task ID:** T9\n\n${body}\n\nFiles follow.`;
  const refusal = (task: Task, text: string): string => {
    const admission = authorizeImplementationSpawn(task, text);
    if (admission.ok) throw new Error("expected the spawn to be refused");
    return admission.error;
  };
  const MISMATCH = "Task T9 distill appendix bytes do not match its protected file list";

  it("admits the exact status-issued appendix at semantic attempt 1", () => {
    expect(authorizeImplementationSpawn(pass, prompt(appendix))).toMatchObject({ ok: true, kind: "initial", semanticAttempt: 1 });
  });

  it("refuses a Distill Task prompt that carries no appendix", () => {
    expect(refusal(pass, prompt("Simplify the Wave's code.")))
      .toBe("Task T9 is its Wave's distill pass and requires the exact distill appendix from orchestration status");
    // An appendix that does not open its own line is not one.
    expect(refusal(pass, prompt(`> ${appendix}`))).toContain("requires the exact distill appendix");
  });

  it.each<readonly [string, string]>([
    ["a widened scope", appendix.replace("- src/T2.ts", "- src/T2.ts\n- src/other.ts")],
    ["a narrowed scope", appendix.replace("- src/T2.ts\n", "")],
    ["an edited rule", appendix.replace("Never edit a test file", "Edit test files freely")],
    ["a truncated tail", appendix.split("\n").slice(0, -1).join("\n")],
    ["another header", appendix.replace(DISTILL_APPENDIX_HEADER, "LOOM_DISTILL_PASS: 2")],
    ["another Task's appendix", distillPromptAppendix({ ...pass, id: "T8" })],
  ])("refuses an appendix with %s", (_label, altered) => {
    expect(refusal(pass, prompt(altered))).toBe(MISMATCH);
  });

  it("refuses the appendix once the protected file list no longer derives it", () => {
    expect(refusal(distill(["src/T1.ts"]), prompt(appendix))).toBe(MISMATCH);
  });

  it("refuses a second appendix", () => {
    expect(refusal(pass, prompt(`${appendix}\n${appendix}`))).toBe("implementation prompt must contain at most one distill appendix");
  });

  it("refuses a distill appendix on a Task that is not a Distill Task", () => {
    const foreign = sibling("T1");
    expect(refusal(foreign, `**Task ID:** T1\n${distillPromptAppendix(foreign)}`))
      .toBe("Task T1 is not a Distill Task; refusing a caller-supplied distill appendix");
    expect(refusal(foreign, "**Task ID:** T1\nLOOM_DISTILL_PASS:")).toContain("is not a Distill Task");
    expect(authorizeImplementationSpawn(foreign, "**Task ID:** T1\nMention of LOOM_DISTILL_PASS: 1 in prose.")).toMatchObject({ ok: true });
  });

  it("binds it beside the retry context on semantic attempt 2", () => {
    const task = retrying(pass);
    const whole = appendixOf(task);
    expect(authorizeImplementationSpawn(task, prompt(whole))).toMatchObject({ ok: true, kind: "retry", semanticAttempt: 2 });
    const retryOnly = whole.split("\n")[0] ?? "";
    expect(refusal(task, prompt(retryOnly))).toContain("requires the exact distill appendix");
    expect(refusal(task, prompt(appendix))).toBe("Task T9 requires the exact attempt-2 retry context from orchestration status");
  });

  it("admits the derived appendix and refuses any one-line edit of it, for every scope", () => {
    const path = fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,2}\.ts$/);
    const cases = fc.uniqueArray(path, { minLength: 1, maxLength: 5 }).chain((scope) => {
      const lines = distillPromptAppendix({ id: "T9", file_list: scope }).split("\n");
      return fc.record({ scope: fc.constant(scope), dropped: fc.integer({ min: 0, max: lines.length - 1 }) });
    });
    fc.assert(fc.property(cases, ({ scope, dropped }) => {
      const task = distill(scope);
      const lines = distillPromptAppendix(task).split("\n");
      expect(authorizeImplementationSpawn(task, prompt(lines.join("\n")))).toMatchObject({ ok: true });
      expect(authorizeImplementationSpawn(task, prompt(lines.filter((_line, index) => index !== dropped).join("\n")))).toMatchObject({ ok: false });
      expect(authorizeImplementationSpawn(task, prompt(lines.map((line, index) => (index === dropped ? `${line} ` : line)).join("\n"))))
        .toMatchObject({ ok: false });
    }));
  });
});
