import type { HookHandler } from "../../types";
import {
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureDispatchProgram,
  startRefutationDispatchProgram,
  type ArchitectureProgramEvent,
  type RefutationProgramEvent,
  type PanelEngineOperation,
} from "../../core/panel-program";
import type { PanelLens } from "../../core/panel-contract";
import { parseWaveFindingId, type ReviewLens } from "../../core/review-panel";

const PANELS = ["architecture", "refutation"] as const;
const OPERATIONS: readonly PanelEngineOperation[] = [
  "architecture-prepare-candidates",
  "architecture-prepare-judges",
  "architecture-aggregate",
  "refutation-prepare-verifiers",
  "refutation-tally",
];
const USAGE = `Usage: helper panel-program <${PANELS.join("|")}> < program.json`;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseEvent(raw: unknown, index: number): ArchitectureProgramEvent | RefutationProgramEvent | string {
  if (!record(raw)) return `events[${index}] must be an object`;
  if (raw.type === "spawn-outcome") {
    if (typeof raw.requestId !== "string" || (raw.attempt !== 1 && raw.attempt !== 2)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return `events[${index}] is not a valid spawn-outcome`;
    }
    if (raw.error !== undefined && typeof raw.error !== "string") return `events[${index}].error must be a string`;
    return {
      type: "spawn-outcome",
      requestId: raw.requestId,
      attempt: raw.attempt,
      outcome: raw.outcome,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  }
  if (raw.type === "engine-outcome") {
    if (typeof raw.operationId !== "string"
      || !OPERATIONS.includes(raw.operationId as PanelEngineOperation)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return `events[${index}] is not a valid engine-outcome`;
    }
    if (raw.error !== undefined && typeof raw.error !== "string") return `events[${index}].error must be a string`;
    return {
      type: "engine-outcome",
      operationId: raw.operationId as PanelEngineOperation,
      outcome: raw.outcome,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    } as ArchitectureProgramEvent | RefutationProgramEvent;
  }
  return `events[${index}].type must be spawn-outcome or engine-outcome`;
}

const handler: HookHandler = async (stdin, args) => {
  const panel = args[0];
  if (!panel || !(PANELS as readonly string[]).includes(panel)) return { kind: "error", message: USAGE };
  let raw: unknown;
  try { raw = JSON.parse(stdin); }
  catch (error) { return { kind: "error", message: `Panel program input is invalid JSON: ${error}` }; }
  if (!record(raw) || !record(raw.input) || !Array.isArray(raw.events)) {
    return { kind: "error", message: "Panel program requires {input, events: []}" };
  }
  const events: Array<ArchitectureProgramEvent | RefutationProgramEvent> = [];
  for (let index = 0; index < raw.events.length; index++) {
    const parsed = parseEvent(raw.events[index], index);
    if (typeof parsed === "string") return { kind: "error", message: parsed };
    events.push(parsed);
  }

  if (panel === "architecture") {
    if (!strings(raw.input.candidateLenses) || !strings(raw.input.judgeCriteria)) {
      return { kind: "error", message: "architecture input requires candidateLenses[] and judgeCriteria[]" };
    }
    let step = startArchitectureDispatchProgram({
      candidateLenses: raw.input.candidateLenses as PanelLens[],
      judgeCriteria: raw.input.judgeCriteria,
    });
    if (!step.ok) return { kind: "error", message: step.errors.join("\n") };
    for (const event of events) {
      const reduced = reduceArchitectureProgram(step.value.state, event as ArchitectureProgramEvent);
      if (!reduced.ok) return { kind: "error", message: `Panel program rejected event: ${JSON.stringify(reduced.error)}` };
      step = { ok: true, value: reduced.value };
    }
    process.stdout.write(JSON.stringify(step.value, null, 2) + "\n");
    return { kind: "passthrough" };
  }

  if (!strings(raw.input.criticalFindingIds) || !strings(raw.input.lenses)) {
    return { kind: "error", message: "refutation input requires criticalFindingIds[] and lenses[]" };
  }
  const criticalFindingIds = raw.input.criticalFindingIds.map(parseWaveFindingId);
  const malformedId = criticalFindingIds.findIndex((id) => id === null);
  if (malformedId >= 0) {
    return {
      kind: "error",
      message: `criticalFindingIds[${malformedId}] must be a wave-scoped task-id:finding-id`,
    };
  }
  let step = startRefutationDispatchProgram({
    criticalFindingIds: criticalFindingIds.filter((id): id is NonNullable<typeof id> => id !== null),
    lenses: raw.input.lenses as ReviewLens[],
  });
  if (!step.ok) return { kind: "error", message: step.errors.join("\n") };
  for (const event of events) {
    const reduced = reduceRefutationProgram(step.value.state, event as RefutationProgramEvent);
    if (!reduced.ok) return { kind: "error", message: `Panel program rejected event: ${JSON.stringify(reduced.error)}` };
    step = { ok: true, value: reduced.value };
  }
  process.stdout.write(JSON.stringify(step.value, null, 2) + "\n");
  return { kind: "passthrough" };
};

export default handler;
