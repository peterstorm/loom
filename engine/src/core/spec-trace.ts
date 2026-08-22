/**
 * Pure Requirement trace contract.
 *
 * Legacy graphs have no `spec_trace_version` and retain their historical
 * completion-only `spec_anchors` interpretation. Version 2 separates partial
 * Requirement Contributions from Requirement Completion Claims and proves the
 * cross-Wave ownership rules before either validation shell or StateManager
 * accepts the graph.
 */

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
