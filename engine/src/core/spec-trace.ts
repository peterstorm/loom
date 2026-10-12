/**
 * Pure Requirement trace contract.
 *
 * Legacy graphs have no `spec_trace_version` and retain their historical
 * completion-only `spec_anchors` interpretation. Version 2 separates partial
 * Requirement Contributions from Requirement Completion Claims and proves the
 * cross-Wave ownership rules before either validation shell or StateManager
 * accepts the graph.
 */

import type { SpecTraceAmendment, SpecTraceAmendmentChange, SpecTraceOwnership } from "../types";

export const SPEC_TRACE_VERSION = 2 as const;

export type RequirementTraceTask = Readonly<{
  id: string;
  wave: number;
  completionClaims: readonly string[];
  contributions: readonly string[];
}>;

export type SpecTraceContract =
  | Readonly<{ kind: "legacy" }>
  | Readonly<{
      kind: "v2";
      version: typeof SPEC_TRACE_VERSION;
      tasks: readonly RequirementTraceTask[];
    }>;

export type SpecTraceDiagnosticCode =
  | "trace-version-required"
  | "unsupported-trace-version"
  | "legacy-contributions"
  | "invalid-trace-task"
  | "invalid-trace-array"
  | "duplicate-trace-entry"
  | "overlapping-trace-role"
  | "multiple-completion-waves"
  | "missing-completion-wave"
  | "contribution-after-completion";

export type SpecTraceDiagnostic = Readonly<{
  code: SpecTraceDiagnosticCode;
  message: string;
  taskId: string | null;
  anchor: string | null;
}>;

export type SpecTraceParseResult =
  | Readonly<{ ok: true; value: SpecTraceContract }>
  | Readonly<{ ok: false; diagnostics: readonly SpecTraceDiagnostic[] }>;

export type SpecTraceParseOptions = Readonly<{ requireV2?: boolean }>;

const diagnostic = (
  code: SpecTraceDiagnosticCode,
  message: string,
  taskId: string | null = null,
  anchor: string | null = null,
): SpecTraceDiagnostic => Object.freeze({ code, message, taskId, anchor });

const isNonEmptyStringArray = (raw: unknown): raw is readonly string[] =>
  Array.isArray(raw) && raw.every((entry) => typeof entry === "string" && entry.trim() !== "");

function parseTraceArray(
  raw: unknown,
  field: "spec_anchors" | "spec_contributions",
  taskId: string,
  required: boolean,
  distinct: boolean,
): Readonly<{ values: readonly string[]; diagnostics: readonly SpecTraceDiagnostic[] }> {
  if (raw === undefined && !required) return { values: Object.freeze([]), diagnostics: Object.freeze([]) };
  if (!isNonEmptyStringArray(raw)) {
    return {
      values: Object.freeze([]),
      diagnostics: Object.freeze([diagnostic(
        "invalid-trace-array",
        `Task ${taskId}: ${field} must be an array of non-empty strings${required ? "" : " if present"}`,
        taskId,
      )]),
    };
  }
  if (distinct && new Set(raw).size !== raw.length) {
    const duplicate = raw.find((entry, index) => raw.indexOf(entry) !== index) ?? null;
    return {
      values: Object.freeze([...raw]),
      diagnostics: Object.freeze([diagnostic(
        "duplicate-trace-entry",
        `Task ${taskId}: '${field}' contains duplicate Requirement trace entry ${JSON.stringify(duplicate)}`,
        taskId,
        duplicate,
      )]),
    };
  }
  return { values: Object.freeze([...raw]), diagnostics: Object.freeze([]) };
}

function legacyContract(
  tasks: readonly unknown[],
): SpecTraceParseResult {
  const diagnostics: SpecTraceDiagnostic[] = [];
  for (const [index, raw] of tasks.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const task = raw as Record<string, unknown>;
    const taskId = typeof task.id === "string" && task.id !== "" ? task.id : `tasks[${index}]`;
    diagnostics.push(...parseTraceArray(task.spec_anchors, "spec_anchors", taskId, false, false).diagnostics);
    if (task.spec_contributions !== undefined) {
      diagnostics.push(diagnostic(
        "legacy-contributions",
        `Task ${taskId}: 'spec_contributions' requires top-level spec_trace_version: 2`,
        taskId,
      ));
    }
  }
  return diagnostics.length === 0
    ? Object.freeze({ ok: true, value: Object.freeze({ kind: "legacy" }) })
    : Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
}

function v2Task(raw: unknown, index: number): Readonly<{
  task: RequirementTraceTask | null;
  diagnostics: readonly SpecTraceDiagnostic[];
}> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      task: null,
      diagnostics: Object.freeze([diagnostic(
        "invalid-trace-task",
        `tasks[${index}] must be an object before its Requirement trace can be parsed`,
      )]),
    };
  }
  const record = raw as Record<string, unknown>;
  const taskId = typeof record.id === "string" && record.id !== "" ? record.id : `tasks[${index}]`;
  if (typeof record.id !== "string" || record.id === "" ||
      typeof record.wave !== "number" || !Number.isSafeInteger(record.wave) || record.wave < 1) {
    return {
      task: null,
      diagnostics: Object.freeze([diagnostic(
        "invalid-trace-task",
        `Task ${taskId}: Requirement trace requires a non-empty id and a positive safe-integer wave`,
        taskId,
      )]),
    };
  }
  const completion = parseTraceArray(record.spec_anchors, "spec_anchors", record.id, true, true);
  const contributions = parseTraceArray(record.spec_contributions, "spec_contributions", record.id, true, true);
  const diagnostics = [...completion.diagnostics, ...contributions.diagnostics];
  for (const anchor of completion.values.filter((entry) => contributions.values.includes(entry))) {
    diagnostics.push(diagnostic(
      "overlapping-trace-role",
      `Task ${record.id}: Requirement ${anchor} cannot be both a Contribution and a Completion Claim on the same Task`,
      record.id,
      anchor,
    ));
  }
  return {
    task: Object.freeze({
      id: record.id,
      wave: record.wave,
      completionClaims: completion.values,
      contributions: contributions.values,
    }),
    diagnostics: Object.freeze(diagnostics),
  };
}

function relationalDiagnostics(tasks: readonly RequirementTraceTask[]): readonly SpecTraceDiagnostic[] {
  const completionWaves = new Map<string, Set<number>>();
  for (const task of tasks) {
    for (const anchor of task.completionClaims) {
      const waves = completionWaves.get(anchor) ?? new Set<number>();
      waves.add(task.wave);
      completionWaves.set(anchor, waves);
    }
  }

  const diagnostics: SpecTraceDiagnostic[] = [];
  for (const [anchor, waves] of completionWaves) {
    if (waves.size > 1) {
      diagnostics.push(diagnostic(
        "multiple-completion-waves",
        `Requirement ${anchor} has Completion Claims in multiple Waves (${[...waves].sort((a, b) => a - b).join(", ")}); repeated claims are allowed only within one completion Wave`,
        null,
        anchor,
      ));
    }
  }
  for (const task of tasks) {
    for (const anchor of task.contributions) {
      const waves = completionWaves.get(anchor);
      if (waves === undefined || waves.size === 0) {
        diagnostics.push(diagnostic(
          "missing-completion-wave",
          `Task ${task.id}: Contribution to ${anchor} has no Requirement Completion Claim in any Wave`,
          task.id,
          anchor,
        ));
        continue;
      }
      if (waves.size !== 1) continue;
      const completionWave = [...waves][0]!;
      if (task.wave > completionWave) {
        diagnostics.push(diagnostic(
          "contribution-after-completion",
          `Task ${task.id}: Contribution to ${anchor} is in Wave ${task.wave}, after its Completion Wave ${completionWave}`,
          task.id,
          anchor,
        ));
      }
    }
  }
  return Object.freeze(diagnostics);
}

/** Parse and prove one graph's complete Requirement trace contract. */
export function parseSpecTraceContract(
  version: unknown,
  tasksRaw: unknown,
  options: SpecTraceParseOptions = {},
): SpecTraceParseResult {
  if (!Array.isArray(tasksRaw)) {
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([diagnostic(
        "invalid-trace-task",
        "Requirement trace tasks must be an array",
      )]),
    });
  }
  const tasks = tasksRaw;
  if (version === undefined) {
    if (options.requireV2 === true) {
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([diagnostic(
          "trace-version-required",
          `Fresh decompose payloads must declare top-level spec_trace_version: ${SPEC_TRACE_VERSION}`,
        )]),
      });
    }
    return legacyContract(tasks);
  }
  if (version !== SPEC_TRACE_VERSION) {
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([diagnostic(
        "unsupported-trace-version",
        `spec_trace_version must be ${SPEC_TRACE_VERSION} when present; omit it only for a legacy graph`,
      )]),
    });
  }

  const parsed = tasks.map(v2Task);
  const parsedTasks = parsed.flatMap(({ task }) => task === null ? [] : [task]);
  const diagnostics = [
    ...parsed.flatMap((entry) => entry.diagnostics),
    ...relationalDiagnostics(parsedTasks),
  ];
  return diagnostics.length === 0
    ? Object.freeze({
        ok: true,
        value: Object.freeze({
          kind: "v2",
          version: SPEC_TRACE_VERSION,
          tasks: Object.freeze(parsedTasks),
        }),
      })
    : Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
}

export function specTraceDiagnosticMessages(result: SpecTraceParseResult): readonly string[] {
  return result.ok ? Object.freeze([]) : Object.freeze(result.diagnostics.map(({ message }) => message));
}

const isStringArray = (raw: unknown): raw is readonly string[] =>
  Array.isArray(raw) && raw.every((entry) => typeof entry === "string");

/**
 * The one shape of a Task's Requirement trace ownership: two string arrays,
 * copied and frozen. Every parser of an ownership record (helper input,
 * persisted amendment audit) builds it here under its own labels; null when
 * either field is not a string array.
 */
export function parseTraceOwnership(anchors: unknown, contributions: unknown): SpecTraceOwnership | null {
  return isStringArray(anchors) && isStringArray(contributions)
    ? Object.freeze({
        spec_anchors: Object.freeze([...anchors]),
        spec_contributions: Object.freeze([...contributions]),
      })
    : null;
}

/** The trace fields a Task carries; on a v2 graph both arrays are proven. */
export type TraceFields = Readonly<{ spec_anchors?: readonly string[]; spec_contributions?: readonly string[] }>;

/** A Task's live trace ownership: an absent array owns nothing. */
export const traceOf = (task: TraceFields): SpecTraceOwnership => Object.freeze({
  spec_anchors: task.spec_anchors ?? [],
  spec_contributions: task.spec_contributions ?? [],
});

/**
 * Why an amendment audit does not describe the trace it claims to, or null.
 * Each Task's successive changes must chain (a change starts, as sets, where
 * that Task's previous change ended) and its live trace must be the `after` of
 * its latest change. The audit is the only sanctioned way a v2 trace changes
 * in place, so a break means the trace or its history was edited behind it.
 */
export function amendmentHistoryError(
  amendments: readonly SpecTraceAmendment[] | undefined,
  tasks: readonly (TraceFields & Readonly<{ id: string }>)[],
): string | null {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const latest = new Map<string, SpecTraceAmendmentChange>();
  for (const change of (amendments ?? []).flatMap(({ changes }) => changes)) {
    if (!byId.has(change.taskId)) {
      return `spec_trace_amendments names Task ${change.taskId}, which is not in the protected roster`;
    }
    const previous = latest.get(change.taskId);
    if (previous !== undefined && !sameRequirementTrace(previous.after, change.before)) {
      return `Task ${change.taskId} spec_trace_amendments change does not start where its previous change ended`;
    }
    latest.set(change.taskId, change);
  }
  for (const [taskId, change] of latest) {
    if (!sameRequirementTrace(traceOf(byId.get(taskId)!), change.after)) {
      return `Task ${taskId} Requirement trace contradicts its latest spec_trace_amendments change`;
    }
  }
  return null;
}

/** The exact-roster ownership input, keyed by Task id in submitted order. */
export type OwnershipParse =
  | Readonly<{ ok: true; value: ReadonlyMap<string, SpecTraceOwnership> }>
  | Readonly<{ ok: false; message: string }>;

const exactFields = (record: Record<string, unknown>, fields: readonly string[]): boolean => {
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

/**
 * Parse the exact-roster contract `{spec_trace_version: 2, tasks: [{id,
 * spec_anchors, spec_contributions}]}` shared by every trace-writing helper.
 * `label` names that helper in each refusal.
 */
export function parseOwnershipInput(raw: unknown, label: string): OwnershipParse {
  const refuse = (message: string): OwnershipParse => Object.freeze({ ok: false, message: `${label} ${message}` });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
      !exactFields(raw as Record<string, unknown>, ["spec_trace_version", "tasks"])) {
    return refuse("input must contain exactly spec_trace_version and tasks");
  }
  const input = raw as Record<string, unknown>;
  if (input.spec_trace_version !== SPEC_TRACE_VERSION) {
    return refuse(`input must declare spec_trace_version: ${SPEC_TRACE_VERSION}`);
  }
  if (!Array.isArray(input.tasks)) return refuse("tasks must be an array");

  const ownership = new Map<string, SpecTraceOwnership>();
  for (const [index, entry] of input.tasks.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
        !exactFields(entry as Record<string, unknown>, ["id", "spec_anchors", "spec_contributions"])) {
      return refuse(`tasks[${index}] must contain exactly id/spec_anchors/spec_contributions`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") {
      return refuse(`tasks[${index}].id must be a non-empty string`);
    }
    if (ownership.has(record.id)) return refuse(`roster repeats Task ${record.id}`);
    const trace = parseTraceOwnership(record.spec_anchors, record.spec_contributions);
    if (trace === null) {
      return refuse(`Task ${record.id} must provide spec_anchors and spec_contributions string arrays`);
    }
    ownership.set(record.id, trace);
  }
  return Object.freeze({ ok: true, value: ownership });
}

/** Why a submitted roster is not exactly the protected Task roster, in order; null when it is. */
export function rosterError(
  graph: Readonly<{ tasks: readonly Readonly<{ id: string }>[] }>,
  ownership: ReadonlyMap<string, SpecTraceOwnership>,
  label: string,
): string | null {
  const currentIds = graph.tasks.map(({ id }) => id);
  const submittedIds = [...ownership.keys()];
  const missing = currentIds.filter((id) => !ownership.has(id));
  const foreign = submittedIds.filter((id) => !currentIds.includes(id));
  if (missing.length > 0 || foreign.length > 0 || submittedIds.length !== currentIds.length) {
    return [
      `${label} roster is stale or partial`,
      ...(missing.length === 0 ? [] : [`missing existing Tasks: ${missing.join(", ")}`]),
      ...(foreign.length === 0 ? [] : [`foreign Tasks: ${foreign.join(", ")}`]),
    ].join("; ");
  }
  return submittedIds.some((id, index) => id !== currentIds[index])
    ? `${label} roster order must exactly match the protected Task roster`
    : null;
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

/** Whether two traces own the same Requirements. Arrays compare as sets: order is not ownership. */
export function sameRequirementTrace(left: SpecTraceOwnership, right: SpecTraceOwnership): boolean {
  return sameSet(left.spec_anchors, right.spec_anchors) && sameSet(left.spec_contributions, right.spec_contributions);
}
