import { describe, expect, it } from "vitest";
import orchestration, { briefInvocation } from "../../../src/handlers/helpers/orchestration";
import type { ImplementationBrief } from "../../../src/core/implementation-brief";

/** The typed `orchestration brief` projection and its argument grammar. */
describe("briefInvocation", () => {
  const brief: ImplementationBrief = {
    taskId: "T2",
    agent: "code-implementer-agent",
    dispatch: { kind: "initial-implementation", taskId: "T2", semanticAttempt: 1, promptAppendix: null },
    prompt: "rendered brief",
  };

  it.each([
    { withPrompt: false, prompt: undefined },
    { withPrompt: true, prompt: "rendered brief" },
  ])("projects both harness invocations (withPrompt: $withPrompt)", ({ withPrompt, prompt }) => {
    const invocation = briefInvocation(brief, "opus", withPrompt);
    expect(invocation).toEqual({
      taskId: "T2",
      agent: "code-implementer-agent",
      dispatch: brief.dispatch,
      pi: { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T2" },
      claude: { subagent_type: "code-implementer-agent", model: "opus", description: "Implement T2" },
      ...(prompt === undefined ? {} : { prompt }),
    });
    expect("prompt" in invocation).toBe(withPrompt);
    expect(Object.isFrozen(invocation)).toBe(true);
  });
});

describe("brief argument grammar", () => {
  it.each([
    [["--wave", "1"], "--wave 1"],
    [["--runs-root", "/runs"], "--runs-root /runs"],
    [["--run", "/runs/run.x"], "--run /runs/run.x"],
    [["--task", "T1", "--json"], "--json"],
  ])("refuses %j before reading any graph", async (args, unconsumed) => {
    const result = await orchestration("", ["brief", ...args]);
    expect(result).toEqual({
      kind: "error",
      message: `brief takes only --task <id> and --prompt; unknown or unconsumed argument(s): ${unconsumed}`,
    });
  });
});
