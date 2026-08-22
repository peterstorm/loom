import type {
  SpecTraceWaveGateRetirement,
  TaskGraph,
} from "../types";
import type { OrchestrationRunId } from "./orchestration-contract";
import {
  parseSpecTraceContract,
  SPEC_TRACE_VERSION,
  specTraceDiagnosticMessages,
} from "./spec-trace";

export type SpecTraceUpgradeOutcome = Readonly<{
  kind: "upgraded" | "already-v2";
  graph: TaskGraph;
}>;

export type SpecTraceUpgradeError = Readonly<{
  kind: "spec-trace-upgrade-rejected";
  message: string;
}>;

export type SpecTraceUpgradeResult =
  | Readonly<{ ok: true; value: SpecTraceUpgradeOutcome }>
  | Readonly<{ ok: false; error: SpecTraceUpgradeError }>;

/** Parser-proven immutable marker read from the exact protected Run Directory. */
export type SpecTraceWaveGateAbandonment = Readonly<{
  runId: OrchestrationRunId;
  reason: string;
  supersededBy: OrchestrationRunId | null;
}>;

type TraceOwnership = Readonly<{
  spec_anchors: readonly string[];
  spec_contributions: readonly string[];
}>;

type OwnershipParse =
  | Readonly<{ ok: true; value: ReadonlyMap<string, TraceOwnership> }>
  | Readonly<{ ok: false; error: SpecTraceUpgradeError }>;

const upgradeError = (message: string): SpecTraceUpgradeError => Object.freeze({
  kind: "spec-trace-upgrade-rejected",
  message,
});

const reject = (message: string): SpecTraceUpgradeResult => Object.freeze({
  ok: false,
  error: upgradeError(message),
});

const exactFields = (record: Record<string, unknown>, fields: readonly string[]): boolean => {
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const isStringArray = (raw: unknown): raw is readonly string[] =>
  Array.isArray(raw) && raw.every((entry) => typeof entry === "string");

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function parseOwnershipInput(raw: unknown): OwnershipParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
      !exactFields(raw as Record<string, unknown>, ["spec_trace_version", "tasks"])) {
    return { ok: false, error: upgradeError("Spec trace upgrade input must contain exactly spec_trace_version and tasks") };
  }
  const input = raw as Record<string, unknown>;
  if (input.spec_trace_version !== SPEC_TRACE_VERSION) {
    return { ok: false, error: upgradeError(`Spec trace upgrade input must declare spec_trace_version: ${SPEC_TRACE_VERSION}`) };
  }
  if (!Array.isArray(input.tasks)) {
    return { ok: false, error: upgradeError("Spec trace upgrade tasks must be an array") };
  }

  const ownership = new Map<string, TraceOwnership>();
  for (const [index, entry] of input.tasks.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
        !exactFields(entry as Record<string, unknown>, ["id", "spec_anchors", "spec_contributions"])) {
      return { ok: false, error: upgradeError(
        `Spec trace upgrade tasks[${index}] must contain exactly id/spec_anchors/spec_contributions`,
      ) };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") {
      return { ok: false, error: upgradeError(`Spec trace upgrade tasks[${index}].id must be a non-empty string`) };
    }
    if (ownership.has(record.id)) {
      return { ok: false, error: upgradeError(`Spec trace upgrade roster repeats Task ${record.id}`) };
    }
    if (!isStringArray(record.spec_anchors) || !isStringArray(record.spec_contributions)) {
      return { ok: false, error: upgradeError(
        `Spec trace upgrade Task ${record.id} must provide spec_anchors and spec_contributions string arrays`,
      ) };
    }
    ownership.set(record.id, Object.freeze({
      spec_anchors: Object.freeze([...record.spec_anchors]),
      spec_contributions: Object.freeze([...record.spec_contributions]),
    }));
  }
  return Object.freeze({ ok: true, value: ownership });
}

function rosterError(graph: TaskGraph, ownership: ReadonlyMap<string, TraceOwnership>): string | null {
  const currentIds = graph.tasks.map(({ id }) => id);
  const submittedIds = [...ownership.keys()];
  const missing = currentIds.filter((id) => !ownership.has(id));
  const foreign = submittedIds.filter((id) => !currentIds.includes(id));
  if (missing.length > 0 || foreign.length > 0 || submittedIds.length !== currentIds.length) {
    return [
      "Spec trace upgrade roster is stale or partial",
      ...(missing.length === 0 ? [] : [`missing existing Tasks: ${missing.join(", ")}`]),
      ...(foreign.length === 0 ? [] : [`foreign Tasks: ${foreign.join(", ")}`]),
    ].join("; ");
  }
  return submittedIds.some((id, index) => id !== currentIds[index])
    ? "Spec trace upgrade roster order must exactly match the protected Task roster"
    : null;
}

function installOwnership(graph: TaskGraph, ownership: ReadonlyMap<string, TraceOwnership>): TaskGraph {
  return Object.freeze({
    ...graph,
    spec_trace_version: SPEC_TRACE_VERSION,
    tasks: Object.freeze(graph.tasks.map((task) => {
      const trace = ownership.get(task.id)!;
      return Object.freeze({
        ...task,
        spec_anchors: trace.spec_anchors,
        spec_contributions: trace.spec_contributions,
      });
    })),
  });
}

function traceOwnershipUnchanged(graph: TaskGraph, candidate: TaskGraph): boolean {
  return graph.tasks.every((task, index) => {
    const candidateTask = candidate.tasks[index]!;
    return sameStrings(task.spec_anchors ?? [], candidateTask.spec_anchors ?? []) &&
      sameStrings(task.spec_contributions ?? [], candidateTask.spec_contributions ?? []);
  });
}

function retireWaveGateScope(graph: TaskGraph, wave: number): TaskGraph {
  const { active_wave_gate: _active, wave_review_epoch: _epoch, ...withoutAuthority } = graph;
  if (withoutAuthority.spec_check?.wave !== wave) return withoutAuthority;
  const { spec_check: _staleSpecCheck, ...withoutStaleSpecCheck } = withoutAuthority;
  return withoutStaleSpecCheck;
}

function validatedOwnershipCandidate(
  graph: TaskGraph,
  raw: unknown,
): SpecTraceUpgradeResult | Readonly<{ candidate: TaskGraph }> {
  const parsed = parseOwnershipInput(raw);
  if (!parsed.ok) return Object.freeze({ ok: false, error: parsed.error });
  const rosterProblem = rosterError(graph, parsed.value);
  if (rosterProblem !== null) return reject(rosterProblem);
  const executingTasks = graph.executing_tasks ?? [];
  if (executingTasks.length > 0) {
    return reject(
      `Spec trace upgrade refused while protected implementation reservations are active: ` +
      executingTasks.join(", "),
    );
  }

  const candidate = installOwnership(graph, parsed.value);
  const validated = parseSpecTraceContract(candidate.spec_trace_version, candidate.tasks);
  if (!validated.ok) {
    return reject(`Spec trace upgrade violates v2 ownership: ${specTraceDiagnosticMessages(validated).join("; ")}`);
  }
  if (graph.spec_trace_version === SPEC_TRACE_VERSION) {
    return traceOwnershipUnchanged(graph, candidate)
      ? Object.freeze({ ok: true, value: Object.freeze({ kind: "already-v2", graph }) })
      : reject("Spec trace upgrade is stale: the protected graph is already v2 with different trace ownership");
  }
  return Object.freeze({ candidate });
}

const isUpgradeResult = (
  value: SpecTraceUpgradeResult | Readonly<{ candidate: TaskGraph }>,
): value is SpecTraceUpgradeResult => "ok" in value;

/**
 * Pure atomic-transition preparation. Only trace ownership fields are replaced;
 * every implementation, review, Finding, proof, Wave Gate, and audit field is
 * carried through unchanged.
 */
export function prepareSpecTraceUpgrade(
  graph: TaskGraph,
  raw: unknown,
): SpecTraceUpgradeResult {
  const prepared = validatedOwnershipCandidate(graph, raw);
  if (isUpgradeResult(prepared)) return prepared;
  if (graph.active_wave_gate !== undefined) {
    return reject(
      `Spec trace upgrade requires active_wave_gate to be absent. Finish run ` +
      `${graph.active_wave_gate.runId} through the registered engine-owned Wave Gate until it archives and clears active authority, then retry the same upgrade input. ` +
      `If legacy Requirement scope alone makes that impossible, first retire the exact run with helper orchestration abandon, then retry with --retire-abandoned-run.`,
    );
  }
  return Object.freeze({ ok: true, value: Object.freeze({ kind: "upgraded", graph: prepared.candidate }) });
}

/**
 * Exceptional transition after the shell has proved the immutable abandonment
 * marker against the exact locked active Run Directory and program authority.
 */
export function prepareAbandonedWaveGateSpecTraceUpgrade(
  graph: TaskGraph,
  raw: unknown,
  abandonment: SpecTraceWaveGateAbandonment,
): SpecTraceUpgradeResult {
  const prepared = validatedOwnershipCandidate(graph, raw);
  if (isUpgradeResult(prepared)) return prepared;
  const active = graph.active_wave_gate;
  if (active === undefined) {
    return reject("Spec trace Wave Gate retirement requires protected active_wave_gate authority");
  }
  if (active.terminalOutcome !== null) {
    return reject(`Spec trace Wave Gate retirement requires nonterminal active run ${active.runId}`);
  }
  if (active.runsRoot === undefined) {
    return reject(`Spec trace Wave Gate retirement requires run ${active.runId} to carry protected runsRoot authority`);
  }
  if (abandonment.runId !== active.runId) {
    return reject(
      `Spec trace Wave Gate retirement marker belongs to foreign run ${abandonment.runId}; protected active run is ${active.runId}`,
    );
  }
  const audit: SpecTraceWaveGateRetirement = Object.freeze({
    schemaVersion: 1,
    kind: "spec-trace-wave-gate-retirement",
    runId: active.runId,
    wave: active.wave,
    authorityDigest: active.authorityDigest,
    revision: active.revision,
    runsRoot: active.runsRoot,
    reason: abandonment.reason,
    supersededBy: abandonment.supersededBy,
  });
  if ((graph.spec_trace_wave_gate_retirements ?? []).some(({ runId }) => runId === active.runId)) {
    return reject(`Spec trace Wave Gate retirement audit already exists for run ${active.runId}`);
  }

  const migrated = Object.freeze({
    ...retireWaveGateScope(prepared.candidate, active.wave),
    spec_trace_wave_gate_retirements: Object.freeze([
      ...(graph.spec_trace_wave_gate_retirements ?? []),
      audit,
    ]),
  });
  return Object.freeze({ ok: true, value: Object.freeze({ kind: "upgraded", graph: migrated }) });
}
