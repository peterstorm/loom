import { describe, expect, it } from "vitest";
import { planPiWriteGrants } from "../../src/core/pi-write-grant-plan";
import { classifyTaskExecutionSpawn } from "../../src/core/validate-task-execution";
import { STANDALONE_REVIEW_CONTEXT_MARKER } from "../../src/core/review-output";

const spawn = (agent: string, task: string) =>
  classifyTaskExecutionSpawn({ agentType: agent, prompt: task, description: "" });

const plan = (
  items: readonly { agent: string; task: string }[],
  graphIsActive: boolean,
) => planPiWriteGrants(items, items.map((i) => spawn(i.agent, i.task)), graphIsActive);

describe("planPiWriteGrants — outside orchestration", () => {
  it("requires no grant and no Task ID for an implementation agent", () => {
    const result = plan([{ agent: "code-implementer-agent", task: "Add a retry to the HTTP client." }], false);
    expect(result).toEqual({ ok: true, requirements: [{ kind: "none" }] });
  });

  it("requires no grant for every implementation agent in the catalog", () => {
    const agents = [
      "code-implementer-agent", "ts-test-agent", "java-test-agent",
      "test-engineer", "frontend-agent", "security-agent", "adr-writer-agent",
    ];
    const result = plan(agents.map((agent) => ({ agent, task: "Do the thing." })), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirements).toEqual(agents.map(() => ({ kind: "none" })));
  });

  it("mints no scoped grant for a phase writer either", () => {
    const result = plan([{ agent: "specify-agent", task: "Specify the feature." }], false);
    expect(result).toEqual({ ok: true, requirements: [{ kind: "none" }] });
  });
});

describe("planPiWriteGrants — during orchestration", () => {
  it("binds an implementation item to its Task ID", () => {
    const result = plan([{ agent: "code-implementer-agent", task: "**Task ID:** T7\nAdd retries." }], true);
    expect(result).toEqual({ ok: true, requirements: [{ kind: "session", taskId: "T7" }] });
  });

  it("still refuses an implementation item with no Task ID", () => {
    const result = plan([{ agent: "code-implementer-agent", task: "Add retries." }], true);
    expect(result).toEqual({
      ok: false,
      error: "implementation item 1 has no Task ID for write-grant binding",
    });
  });

  it("reports the failing item's position within a batch", () => {
    const result = plan([
      { agent: "code-implementer-agent", task: "**Task ID:** T1\nOne." },
      { agent: "code-implementer-agent", task: "No identifier here." },
    ], true);
    expect(result).toEqual({
      ok: false,
      error: "implementation item 2 has no Task ID for write-grant binding",
    });
  });

  it("scopes a phase writer to its artifact dirs", () => {
    const result = plan([{ agent: "specify-agent", task: "Specify the feature." }], true);
    expect(result).toEqual({
      ok: true,
      requirements: [{ kind: "scoped", taskId: "phase:specify", scopeDirs: [".claude/specs"] }],
    });
  });

  it("gives a read-only reviewer nothing", () => {
    const result = plan([{ agent: "code-reviewer", task: "Task: T3\nReview the diff." }], true);
    expect(result).toEqual({ ok: true, requirements: [{ kind: "none" }] });
  });

  it("gives a standalone-marked review run nothing", () => {
    const task = `${STANDALONE_REVIEW_CONTEXT_MARKER}\nReview the branch.`;
    const result = plan([{ agent: "code-reviewer", task }], true);
    expect(result).toEqual({ ok: true, requirements: [{ kind: "none" }] });
  });
});

describe("planPiWriteGrants — batch integrity", () => {
  it("refuses a batch whose classifications do not line up", () => {
    const result = planPiWriteGrants([{ agent: "code-reviewer", task: "Review." }], [], true);
    expect(result).toEqual({
      ok: false,
      error: "Pi write-grant plan requires one classified spawn per batch item",
    });
  });

  it("preserves one requirement per item, in order", () => {
    const items = [
      { agent: "code-implementer-agent", task: "**Task ID:** T1\nBuild." },
      { agent: "code-reviewer", task: "Review it." },
      { agent: "architecture-agent", task: "Write the plan." },
    ];
    const result = plan(items, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirements.map((r) => r.kind)).toEqual(["session", "none", "scoped"]);
  });
});
