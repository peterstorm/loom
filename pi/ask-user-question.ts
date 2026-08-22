import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Short option label" }),
  description: Type.String({ description: "What choosing this option means" }),
  preview: Type.Optional(Type.String({ description: "Optional detailed preview" })),
});

const QuestionSchema = Type.Object({
  question: Type.String({ minLength: 1, description: "Complete question to show the user" }),
  header: Type.String({ minLength: 1, maxLength: 32, description: "Short question heading" }),
  options: Type.Array(OptionSchema, { minItems: 1, maxItems: 8 }),
  multiSelect: Type.Boolean({ description: "Whether the user may select multiple options" }),
});

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});

type Question = Static<typeof AskUserQuestionParams>["questions"][number];
type QuestionOption = Question["options"][number];

type QuestionAnswer = Readonly<{
  header: string;
  question: string;
  answers: readonly string[];
  cancelled: boolean;
}>;

const OTHER = "Type a different answer…";
const DONE = "Done selecting";

const displayOption = (option: QuestionOption, index: number, selected = false): string => {
  const marker = selected ? "[x] " : "[ ] ";
  const detail = option.preview?.trim() || option.description.trim();
  return `${marker}${index + 1}. ${option.label}${detail.length > 0 ? ` — ${detail}` : ""}`;
};

const questionAnswer = (
  question: Question,
  answers: readonly string[],
  cancelled: boolean,
): QuestionAnswer => Object.freeze({
  header: question.header,
  question: question.question,
  answers: Object.freeze([...answers]),
  cancelled,
});

const answerText = (answers: readonly QuestionAnswer[]): string =>
  answers.map((answer) =>
    answer.cancelled
      ? `${answer.header}: user cancelled`
      : `${answer.header}: ${answer.answers.join(", ") || "no options selected"}`
  ).join("\n");

async function askSingle(question: Question, ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4]): Promise<QuestionAnswer> {
  const rendered = question.options.map((option, index) => displayOption(option, index));
  const selected = await ctx.ui.select(`${question.header}: ${question.question}`, [...rendered, OTHER]);
  if (selected === undefined) return questionAnswer(question, [], true);
  if (selected === OTHER) {
    const custom = await ctx.ui.input(`${question.header}: ${question.question}`, "Type your answer");
    return custom === undefined
      ? questionAnswer(question, [], true)
      : questionAnswer(question, [custom], false);
  }
  const index = rendered.indexOf(selected);
  return index < 0
    ? questionAnswer(question, [], true)
    : questionAnswer(question, [question.options[index]!.label], false);
}

async function askMultiple(question: Question, ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4]): Promise<QuestionAnswer> {
  const selected = new Set<number>();
  while (true) {
    const options = question.options.map((option, index) => displayOption(option, index, selected.has(index)));
    const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [...options, OTHER, DONE]);
    if (choice === undefined) return questionAnswer(question, [], true);
    if (choice === DONE) {
      return questionAnswer(
        question,
        [...selected].sort((left, right) => left - right).map((index) => question.options[index]!.label),
        false,
      );
    }
    if (choice === OTHER) {
      const custom = await ctx.ui.input(`${question.header}: ${question.question}`, "Type an additional answer");
      if (custom === undefined) return questionAnswer(question, [], true);
      const chosen = [...selected].sort((left, right) => left - right).map((index) => question.options[index]!.label);
      return questionAnswer(question, [...chosen, custom], false);
    }
    const index = options.indexOf(choice);
    if (index < 0) return questionAnswer(question, [], true);
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
  }
}

/** RPC-child-only extension. Standard ctx.ui dialogs become extension_ui_request frames. */
export default function askUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description: "Ask the user up to four questions and continue this same agent turn with their answers.",
    promptSnippet: "Ask the user interactive clarification questions",
    promptGuidelines: [
      "Use AskUserQuestion whenever a Loom phase requires user clarification or an approach selection; never fabricate an answer.",
    ],
    parameters: AskUserQuestionParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("AskUserQuestion requires a relayed Pi RPC UI");
      const answers: QuestionAnswer[] = [];
      for (const question of params.questions) {
        const answer = question.multiSelect
          ? await askMultiple(question, ctx)
          : await askSingle(question, ctx);
        answers.push(answer);
        if (answer.cancelled) break;
      }
      return {
        content: [{ type: "text", text: answerText(answers) }],
        details: { answers: Object.freeze([...answers]) },
      };
    },
  });
}
