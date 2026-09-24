/**
 * The one CLI flag reader the helper shell uses.
 *
 * Five copies of "read the value after a named flag" had accumulated —
 * `panel-run`'s `argumentValue`, `orchestration`'s `flag`, and an `arg` each in
 * `model-calibration`, `model-profiles`, and `review-packet` — and they did not
 * agree. `model-profiles`'s copy accepted an EMPTY value the others rejected;
 * only `orchestration`'s rejected a value that is itself a flag. Divergence in
 * argument parsing is silent: the wrong copy simply reads a different command
 * line than the operator typed.
 *
 * `argumentValue` treats a missing, empty, or `--`-prefixed value as absent;
 * the whole-argv parser also retains empty tokens as unconsumed arguments.
 * `--run --json` never reads as `run = "--json"`.
 */
import { parseTaskId, type TaskId } from "../../core/task-id";

const isFlagValue = (value: string | undefined): value is string =>
  value !== undefined && value !== "" && !value.startsWith("--");

export function argumentValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return isFlagValue(value) ? value : null;
}

/** Return every token not consumed by the recognized value-flag grammar.
 * Recognized flag tokens are always removed; a following non-empty, non-flag
 * value is removed with them. Missing values remain the caller's typed error. */
export function unconsumedValueArguments(args: readonly string[], flags: ReadonlySet<string>): readonly string[] {
  const unconsumed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!flags.has(token)) {
      unconsumed.push(token);
      continue;
    }
    const value = args[index + 1];
    if (isFlagValue(value)) index += 1;
  }
  return Object.freeze(unconsumed);
}

export type TaskReasonArguments<Flag extends string = never> = Readonly<{
  taskId: TaskId;
  reason: string;
  additionalValues: Readonly<Record<Flag, string>>;
}>;

export type TaskReasonArgumentGrammar<Flag extends string = never> = Readonly<{
  operation: string;
  maximumReasonLength: number;
  additionalRequired?: readonly Readonly<{ flag: Flag; missingMessage: string }>[];
}>;

/** Parse the exact shared task/reason grammar plus operation-specific values. */
export function parseTaskReasonArguments<const Flag extends string>(
  args: readonly string[],
  grammar: TaskReasonArgumentGrammar<Flag>,
): Readonly<{ ok: true; value: TaskReasonArguments<Flag> }> | Readonly<{ ok: false; message: string }> {
  const additional = grammar.additionalRequired ?? [];
  const flags = new Set(["--task", "--reason", ...additional.map(({ flag }) => flag)]);
  const unconsumed = unconsumedValueArguments(args, flags);
  if (unconsumed.length > 0) {
    return { ok: false, message: `unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
  }
  const task = argumentValue(args, "--task");
  if (task === null) return { ok: false, message: `${grammar.operation} requires --task <task-id>` };
  const additionalValues: Record<string, string> = {};
  for (const requirement of additional) {
    const value = argumentValue(args, requirement.flag);
    if (value === null) return { ok: false, message: requirement.missingMessage };
    additionalValues[requirement.flag] = value;
  }
  const reason = argumentValue(args, "--reason");
  if (reason === null) return { ok: false, message: `${grammar.operation} requires --reason <text>` };
  if (reason.trim().length === 0 || reason.length > grammar.maximumReasonLength) {
    return {
      ok: false,
      message: `${grammar.operation} --reason must be non-empty and at most ${grammar.maximumReasonLength} characters`,
    };
  }
  for (const flag of flags) {
    if (args.filter((argument) => argument === flag).length > 1) {
      return { ok: false, message: `${grammar.operation} requires ${flag} exactly once` };
    }
  }
  const taskId = parseTaskId(task, `${grammar.operation} --task`);
  if (!taskId.ok) return { ok: false, message: taskId.error.errors.join("; ") };
  return {
    ok: true,
    value: Object.freeze({
      taskId: taskId.value,
      reason,
      // The loop above populated every grammar-admitted Flag or returned an error.
      additionalValues: Object.freeze(additionalValues) as Readonly<Record<Flag, string>>,
    }),
  };
}

/** Is this bare switch present? Pass the full flag, `--json`, not `json`. */
export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}
