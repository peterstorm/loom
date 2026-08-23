import { describe, expect, it } from "vitest";
import askUserQuestion from "../../../pi/ask-user-question";

type Execute = (
  id: string,
  params: {
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string; preview?: string }>;
      multiSelect: boolean;
    }>;
  },
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: Record<string, unknown>,
) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;

const registeredExecute = (): Execute => {
  let execute: Execute | undefined;
  askUserQuestion({
    registerTool(tool: { execute: Execute }) {
      execute = tool.execute;
    },
  } as never);
  if (execute === undefined) throw new Error("AskUserQuestion tool was not registered");
  return execute;
};

const question = (multiSelect = false) => ({
  question: "Which architecture?",
  header: "Architecture",
  options: [
    { label: "Simple", description: "Minimal moving parts" },
    { label: "Typed", description: "Strong contracts", preview: "ADTs and exhaustive reducers" },
  ],
  multiSelect,
});

describe("AskUserQuestion RPC child tool", () => {
  it("returns the selected semantic label rather than its rendered description", async () => {
    const execute = registeredExecute();
    const result = await execute("call-1", { questions: [question()] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => options[1],
        input: async () => undefined,
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "Architecture: Typed" }]);
    expect(result.details).toEqual({
      answers: [{
        header: "Architecture",
        question: "Which architecture?",
        answers: ["Typed"],
        cancelled: false,
      }],
    });
  });

  it("keeps colliding rendered options distinct and records the selected semantic label", async () => {
    const execute = registeredExecute();
    const colliding = {
      question: "Which collision?",
      header: "Collision",
      options: [
        { label: "A", description: "B — C" },
        { label: "A — B", description: "C" },
      ],
      multiSelect: false,
    };
    const result = await execute("call-collision", { questions: [colliding] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          expect(options[0]).not.toBe(options[1]);
          return options[1];
        },
        input: async () => undefined,
      },
    });

    expect(result.content[0]?.text).toBe("Collision: A — B");
  });

  it("keeps colliding multi-select options distinct", async () => {
    const execute = registeredExecute();
    const colliding = {
      question: "Which collisions?",
      header: "Collisions",
      options: [
        { label: "A", description: "B — C" },
        { label: "A — B", description: "C" },
      ],
      multiSelect: true,
    };
    let selection = 0;
    const result = await execute("call-multi-collision", { questions: [colliding] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          selection += 1;
          if (selection === 1) {
            expect(options[0]).not.toBe(options[1]);
            return options[1];
          }
          return options.at(-1);
        },
        input: async () => undefined,
      },
    });

    expect(result.content[0]?.text).toBe("Collisions: A — B");
  });

  it("supports deterministic multi-select toggles followed by Done", async () => {
    const execute = registeredExecute();
    let selection = 0;
    const result = await execute("call-2", { questions: [question(true)] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          selection += 1;
          return selection === 1 ? options[0] : selection === 2 ? options[1] : options.at(-1);
        },
        input: async () => undefined,
      },
    });

    expect(result.content[0]?.text).toBe("Architecture: Simple, Typed");
  });

  it("records custom single- and multi-select answers", async () => {
    const execute = registeredExecute();
    const single = await execute("call-custom-single", { questions: [question()] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => options.at(-1),
        input: async () => "Custom single",
      },
    });
    expect(single.content[0]?.text).toBe("Architecture: Custom single");

    const multi = await execute("call-custom-multi", { questions: [question(true)] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => options.at(-2),
        input: async () => "Custom multi",
      },
    });
    expect(multi.content[0]?.text).toBe("Architecture: Custom multi");
  });

  it("rejects duplicate semantic labels before opening a dialog", async () => {
    const execute = registeredExecute();
    let dialogOpened = false;
    const duplicated = {
      question: "Which duplicate?",
      header: "Duplicate",
      options: [
        { label: "Same", description: "First meaning" },
        { label: "Same", description: "Second meaning" },
      ],
      multiSelect: false,
    };

    await expect(execute("call-duplicate", { questions: [duplicated] }, undefined, undefined, {
      hasUI: true,
      ui: {
        select: async () => { dialogOpened = true; return undefined; },
        input: async () => undefined,
      },
    })).rejects.toThrow("Duplicate: option labels must be unique; repeated label \"Same\"");
    expect(dialogOpened).toBe(false);
  });

  it("reports cancellation without inventing an answer", async () => {
    const execute = registeredExecute();
    const result = await execute("call-3", { questions: [question()] }, undefined, undefined, {
      hasUI: true,
      ui: { select: async () => undefined, input: async () => undefined },
    });

    expect(result.content[0]?.text).toBe("Architecture: user cancelled");
    expect(result.details).toEqual({
      answers: [{
        header: "Architecture",
        question: "Which architecture?",
        answers: [],
        cancelled: true,
      }],
    });
  });
});
