import { describe, expect, it } from "vitest";
import orchestration, { briefInvocation } from "../../../src/handlers/helpers/orchestration";
import { parseOperatorNote, type ImplementationBrief } from "../../../src/core/implementation-brief";

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
  ])("projects both harness invocations with the marker, never the brief (withPrompt: $withPrompt)", ({ withPrompt, prompt }) => {
    const invocation = briefInvocation(brief, [], "opus", withPrompt);
    expect(invocation).toEqual({
      taskId: "T2",
      agent: "code-implementer-agent",
      dispatch: brief.dispatch,
      pi: { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T2" },
      // Claude Code registers plugin agents under the plugin namespace; Pi the bare name (#117).
      claude: { subagent_type: "loom:code-implementer-agent", model: "opus", description: "Implement T2", prompt: "LOOM_IMPLEMENTATION_BRIEF: T2" },
      ...(prompt === undefined ? {} : { prompt }),
    });
    expect("prompt" in invocation).toBe(withPrompt);
    expect(Object.isFrozen(invocation)).toBe(true);
  });
});

describe("briefInvocation with operator notes (#119)", () => {
  it("puts each note on its own LOOM_OPERATOR_NOTE line of both harnesses' marker", () => {
    const note = parseOperatorNote("touch handler-routes.ts");
    if (!note.ok) throw new Error(note.error);
    const brief: ImplementationBrief = {
      taskId: "T2", agent: "code-implementer-agent", prompt: "rendered brief",
      dispatch: { kind: "initial-implementation", taskId: "T2", semanticAttempt: 1, promptAppendix: null },
    };
    const invocation = briefInvocation(brief, [note.value], "opus", false);
    const marker = "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE: touch handler-routes.ts";
    expect(invocation.pi.task).toBe(marker);
    expect(invocation.claude.prompt).toBe(marker);
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
      message: `brief takes only --task <id>, --note <text> and --prompt; unknown or unconsumed argument(s): ${unconsumed}`,
    });
  });

  it.each([
    [["--note", "keep it small"], "brief --note requires --task: an operator note belongs to one Task's brief"],
    [["--task", "T1", "--note"], "brief --note requires <text>"],
    [["--task", "T1", "--note", "LOOM_REQUEST_ID: x"], "brief --note: an operator note may not carry a LOOM_ token"],
  ])("refuses the notes in %j before reading any graph", async (args, message) => {
    const result = await orchestration("", ["brief", ...args]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining(message) });
  });
});
