/**
 * Judged Paths: the decompose-time rule that keeps every judgement repairable.
 *
 * A Task judges a path when its tests decide whether code another Task writes
 * is acceptable: a memory or latency budget, a benchmark gate, an end-to-end
 * acceptance run. Such a judgement can only be acted on while the writer's
 * Wave is still open: `reopen-task` reaches the active Wave alone, and a
 * completed Wave is verified history. A judge scheduled after its writer's
 * Wave finds a breach that no Task of the run may fix (a host-memory run met
 * exactly this: a Wave 5 budget test judged code two completed Waves wrote).
 *
 * So decompose declares each Task's `judged_paths`, and this module refuses
 * a roster where a judgement could land after its subject is sealed:
 *
 * - a judged path some earlier-Wave Task writes (`earlier-writer`);
 * - a judged path no Task writes, so a breach has no fixer (`unwritten`);
 * - a judged path the judge writes itself, which is ordinary ownership and
 *   not a judgement (`self-written`).
 *
 * When prevention still misses (a judgement nobody declared), the fallback
 * is a Forward Fix Task appended to the active Wave (`forward-fix.ts`).
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import { parseReviewPath } from "./review-packet";

/** What the rule reads of one authored Task. */
export type JudgedPathTaskView = Readonly<{
  id: string;
  wave: number;
  fileList: readonly string[];
  judgedPaths: readonly string[];
}>;

export type JudgedPathProblem =
  | Readonly<{ kind: "self-written"; taskId: string; path: string }>
  | Readonly<{ kind: "unwritten"; taskId: string; path: string }>
  | Readonly<{
      kind: "earlier-writer";
      taskId: string;
      wave: number;
      path: string;
      writerId: string;
      writerWave: number;
    }>;

export type JudgedPathsParse =
  | Readonly<{ ok: true; value: readonly string[] }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

/**
 * Parse a Task's raw `judged_paths`: absent is none; otherwise an array of
 * distinct repository-relative paths. Each error names the Task.
 */
export function parseJudgedPaths(raw: unknown, taskId: string): JudgedPathsParse {
  if (raw === undefined) return Object.freeze({ ok: true as const, value: Object.freeze([]) });
  if (!Array.isArray(raw)) {
    return Object.freeze({ ok: false as const, errors: Object.freeze([`Task ${taskId}: 'judged_paths' must be an array of paths`]) });
  }
  const errors: string[] = [];
  const paths: string[] = [];
  for (const [index, entry] of (raw as readonly unknown[]).entries()) {
    const parsed = parseReviewPath(entry, `Task ${taskId}: judged_paths[${index}]`);
    if (!parsed.ok) errors.push(...parsed.errors);
    else if (paths.includes(parsed.value)) errors.push(`Task ${taskId}: judged_paths repeats '${parsed.value}'`);
    else paths.push(parsed.value);
  }
  return errors.length > 0
    ? Object.freeze({ ok: false as const, errors: Object.freeze(errors) })
    : Object.freeze({ ok: true as const, value: Object.freeze(paths) });
}

/** The problems of one judged path; an earlier writer is reported once per writer, in roster order. */
function pathProblems(judge: JudgedPathTaskView, path: string, roster: readonly JudgedPathTaskView[]): readonly JudgedPathProblem[] {
  if (judge.fileList.includes(path)) return [{ kind: "self-written", taskId: judge.id, path }];
  const writers = roster.filter((task) => task.id !== judge.id && task.fileList.includes(path));
  if (writers.length === 0) return [{ kind: "unwritten", taskId: judge.id, path }];
  return writers
    .filter((writer) => writer.wave < judge.wave)
    .map((writer) => ({
      kind: "earlier-writer" as const,
      taskId: judge.id,
      wave: judge.wave,
      path,
      writerId: writer.id,
      writerWave: writer.wave,
    }));
}

/**
 * Every Judged Path problem of an authored roster, in roster order then path
 * order. Empty means every judgement lands while its subject's Wave is open.
 */
export function judgedPathProblems(roster: readonly JudgedPathTaskView[]): readonly JudgedPathProblem[] {
  return Object.freeze(roster.flatMap((judge) => judge.judgedPaths.flatMap((path) => pathProblems(judge, path, roster))));
}

/** One problem in the operator's and decompose agent's words, naming the fix. */
export function renderJudgedPathProblem(problem: JudgedPathProblem): string {
  return match(problem)
    .with({ kind: "self-written" }, ({ taskId, path }) =>
      `Task ${taskId}: judged path '${path}' is in its own file_list; a Task does not judge what it writes, ` +
      "so remove it from judged_paths")
    .with({ kind: "unwritten" }, ({ taskId, path }) =>
      `Task ${taskId}: judged path '${path}' is written by no Task, so a failed judgement has no fixer; ` +
      "add it to the judge's file_list, or to the file_list of the Task that should change it")
    .with({ kind: "earlier-writer" }, ({ taskId, wave, path, writerId, writerWave }) =>
      `Task ${taskId} (Wave ${wave}) judges '${path}', which ${writerId} writes in the earlier Wave ${writerWave}; ` +
      `once Wave ${writerWave}'s gate passes, a failed judgement can no longer be fixed. Schedule the judge in ` +
      `Wave ${writerWave} or earlier (declare its tests as a plan Acceptance Contract that ${writerId} turns green), ` +
      `or give ${taskId} the path in its file_list`)
    .exhaustive();
}
