import type { HookHandler } from "../../types";
import {
  planArchitecturePanelPersistence,
  planRefutationPanelPersistence,
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureDispatchProgram,
  startRefutationDispatchProgram,
  type ArchitectureEngineOperation,
  type ArchitectureProgramEvent,
  type PersistentArchitecturePanelHistory,
  type PersistentArchitectureStep,
  type PersistentRefutationPanelHistory,
  type PersistentRefutationStep,
  type RefutationEngineOperation,
  type RefutationProgramEvent,
} from "../../core/panel-program";
import { PANEL_LENSES, type PanelLens } from "../../core/panel-contract";
import { parseReviewLens, parseWaveFindingId, type ReviewLens } from "../../core/review-panel";
import type { PublicationAuthorityResolver } from "../../core/orchestration-contract";

export const LEGACY_PANEL_PROGRAM_SCHEMA_VERSION = 1 as const;
const PANELS = ["architecture", "refutation"] as const;
type LegacyPanelKind = (typeof PANELS)[number];
const ARCHITECTURE_OPERATIONS: readonly ArchitectureEngineOperation[] = [
  "architecture-prepare-candidates",
  "architecture-prepare-judges",
  "architecture-aggregate",
];
const REFUTATION_OPERATIONS: readonly RefutationEngineOperation[] = [
  "refutation-prepare-verifiers",
  "refutation-tally",
];
const USAGE = `Usage: helper panel-program <${PANELS.join("|")}> < program.json`;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseArchitectureLenses(value: unknown): readonly PanelLens[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: PanelLens[] = [];
  for (const entry of value) {
    const lens = PANEL_LENSES.find((candidate) => candidate === entry);
    if (lens === undefined) return null;
    parsed.push(lens);
  }
  return Object.freeze(parsed);
}

function parseRefutationLenses(value: unknown): readonly ReviewLens[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: ReviewLens[] = [];
  for (const entry of value) {
    const lens = parseReviewLens(entry);
    if (lens === null) return null;
    parsed.push(lens);
  }
  return Object.freeze(parsed);
}

function parseEvent(panel: "architecture", raw: unknown, index: number): ArchitectureProgramEvent | string;
function parseEvent(panel: "refutation", raw: unknown, index: number): RefutationProgramEvent | string;
function parseEvent(panel: LegacyPanelKind, raw: unknown, index: number): ArchitectureProgramEvent | RefutationProgramEvent | string {
  if (!record(raw)) return `events[${index}] must be an object`;
  if (raw.type === "spawn-outcome") {
    if (typeof raw.requestId !== "string" || (raw.attempt !== 1 && raw.attempt !== 2)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return `events[${index}] is not a valid spawn-outcome`;
    }
    if (raw.error !== undefined && typeof raw.error !== "string") return `events[${index}].error must be a string`;
    return Object.freeze({
      type: "spawn-outcome" as const,
      requestId: raw.requestId,
      attempt: raw.attempt,
      outcome: raw.outcome,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    });
  }
  if (raw.type === "engine-outcome") {
    const allowedOperations: readonly string[] = panel === "architecture"
      ? ARCHITECTURE_OPERATIONS
      : REFUTATION_OPERATIONS;
    if (typeof raw.operationId !== "string"
      || !allowedOperations.includes(raw.operationId)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return `events[${index}] is not a valid ${panel} engine-outcome`;
    }
    if (raw.error !== undefined && typeof raw.error !== "string") return `events[${index}].error must be a string`;
    const event = Object.freeze({
      type: "engine-outcome" as const,
      operationId: raw.operationId,
      outcome: raw.outcome,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    });
    return panel === "architecture"
      ? event as ArchitectureProgramEvent
      : event as RefutationProgramEvent;
  }
  return `events[${index}].type must be spawn-outcome or engine-outcome`;
}

export type LegacyArchitecturePanelJournal = Readonly<{
  format: "legacy-panel-program";
  schemaVersion: 1;
  panel: "architecture";
  input: Readonly<{ candidateLenses: readonly PanelLens[]; judgeCriteria: readonly string[] }>;
  events: readonly ArchitectureProgramEvent[];
}>;

export type LegacyRefutationPanelJournal = Readonly<{
  format: "legacy-panel-program";
  schemaVersion: 1;
  panel: "refutation";
  input: Readonly<{ criticalFindingIds: readonly NonNullable<ReturnType<typeof parseWaveFindingId>>[]; lenses: readonly ReviewLens[] }>;
  events: readonly RefutationProgramEvent[];
}>;

export type LegacyPanelJournal = LegacyArchitecturePanelJournal | LegacyRefutationPanelJournal;
export type LegacyJournalTranslation =
  | Readonly<{ ok: true; value: LegacyPanelJournal }>
  | Readonly<{ ok: false; error: string }>;

export type BytePreservingLegacyJournalTranslation =
  | Readonly<{ ok: true; value: Readonly<{ source: string; journal: LegacyPanelJournal }> }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Parses a historical journal while retaining its exact caller-owned UTF-8
 * spelling. New-session persistence never rewrites this source; the parsed
 * journal is an in-memory compatibility view only.
 */
export function translateLegacyPanelJournalBytes(
  panel: LegacyPanelKind,
  source: string,
): BytePreservingLegacyJournalTranslation {
  if (typeof source !== "string") return { ok: false, error: "Legacy panel journal source must be text" };
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch (error) { return { ok: false, error: `Legacy panel journal is invalid JSON: ${String(error)}` }; }
  const translated = translateLegacyPanelJournal(panel, raw);
  return translated.ok
    ? { ok: true, value: Object.freeze({ source, journal: translated.value }) }
    : translated;
}

/** Panel-specific helper contracts consumed by the filesystem executor. */
export function prepareArchitecturePanelPersistenceOperations(
  step: PersistentArchitectureStep,
  history: PersistentArchitecturePanelHistory,
  resolver: PublicationAuthorityResolver,
) {
  return step.recordedEvent === undefined
    ? { ok: false as const, error: "Architecture step has no durable event to persist" }
    : planArchitecturePanelPersistence(step, history, resolver);
}

export function prepareRefutationPanelPersistenceOperations(
  step: PersistentRefutationStep,
  history: PersistentRefutationPanelHistory,
  resolver: PublicationAuthorityResolver,
) {
  return step.recordedEvent === undefined
    ? { ok: false as const, error: "Refutation step has no durable event to persist" }
    : planRefutationPanelPersistence(step, history, resolver);
}

/**
 * Format-detect and translate a historical/in-flight v1 journal in memory.
 * The caller-owned document and its event prefix are never rewritten. A
 * schemaVersion of 1 is accepted for forward-written compatibility copies;
 * absence is the original on-disk spelling.
 */
export function translateLegacyPanelJournal(
  panel: LegacyPanelKind,
  raw: unknown,
): LegacyJournalTranslation {
  try {
    if (!record(raw) || !record(raw.input) || !Array.isArray(raw.events)) {
      return { ok: false, error: "Panel program requires {input, events: []}" };
    }
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== LEGACY_PANEL_PROGRAM_SCHEMA_VERSION) {
      return { ok: false, error: `Unsupported legacy panel journal schemaVersion: ${String(raw.schemaVersion)}` };
    }
    if (raw.format !== undefined && raw.format !== "legacy-panel-program") {
      return { ok: false, error: `Unsupported panel journal format: ${String(raw.format)}` };
    }
    if (raw.panel !== undefined && raw.panel !== panel) {
      return { ok: false, error: `Panel journal declares '${String(raw.panel)}' but was opened as '${panel}'` };
    }
    if (panel === "architecture") {
      const candidateLenses = parseArchitectureLenses(raw.input.candidateLenses);
      if (candidateLenses === null || !strings(raw.input.judgeCriteria)) {
        const unknownLens = strings(raw.input.candidateLenses)
          ? raw.input.candidateLenses.find((lens) => !(PANEL_LENSES as readonly string[]).includes(lens))
          : undefined;
        return unknownLens === undefined
          ? { ok: false, error: "architecture input requires exact PanelLens candidateLenses[] and judgeCriteria[]" }
          : { ok: false, error: `unknown architecture design lens: ${unknownLens}` };
      }
      const events: ArchitectureProgramEvent[] = [];
      for (let index = 0; index < raw.events.length; index++) {
        const parsed = parseEvent("architecture", raw.events[index], index);
        if (typeof parsed === "string") return { ok: false, error: parsed };
        events.push(parsed);
      }
      return {
        ok: true,
        value: Object.freeze({
          format: "legacy-panel-program" as const,
          schemaVersion: 1 as const,
          panel,
          input: Object.freeze({
            candidateLenses,
            judgeCriteria: Object.freeze([...raw.input.judgeCriteria]),
          }),
          events: Object.freeze([...events]) as readonly ArchitectureProgramEvent[],
        }),
      };
    }

    const lenses = parseRefutationLenses(raw.input.lenses);
    if (!strings(raw.input.criticalFindingIds) || lenses === null) {
      const unknownLens = strings(raw.input.lenses)
        ? raw.input.lenses.find((lens) => parseReviewLens(lens) === null)
        : undefined;
      return unknownLens === undefined
        ? { ok: false, error: "refutation input requires criticalFindingIds[] and exact ReviewLens lenses[]" }
        : { ok: false, error: `unknown refutation lens: ${unknownLens}` };
    }
    const events: RefutationProgramEvent[] = [];
    for (let index = 0; index < raw.events.length; index++) {
      const parsed = parseEvent("refutation", raw.events[index], index);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      events.push(parsed);
    }
    const criticalFindingIds = raw.input.criticalFindingIds.map(parseWaveFindingId);
    const malformedId = criticalFindingIds.findIndex((id) => id === null);
    if (malformedId >= 0) {
      return { ok: false, error: `criticalFindingIds[${malformedId}] must be a wave-scoped task-id:finding-id` };
    }
    return {
      ok: true,
      value: Object.freeze({
        format: "legacy-panel-program" as const,
        schemaVersion: 1 as const,
        panel,
        input: Object.freeze({
          criticalFindingIds: Object.freeze(criticalFindingIds.filter(
            (id): id is NonNullable<typeof id> => id !== null,
          )),
          lenses,
        }),
        events: Object.freeze([...events]) as readonly RefutationProgramEvent[],
      }),
    };
  } catch {
    return { ok: false, error: "Panel program journal could not be safely inspected" };
  }
}

const handler: HookHandler = async (stdin, args) => {
  const panel = args[0];
  if (!panel || !(PANELS as readonly string[]).includes(panel)) return { kind: "error", message: USAGE };
  let raw: unknown;
  try { raw = JSON.parse(stdin); }
  catch (error) { return { kind: "error", message: `Panel program input is invalid JSON: ${error}` }; }
  const translated = translateLegacyPanelJournal(panel as LegacyPanelKind, raw);
  if (!translated.ok) return { kind: "error", message: translated.error };
  const journal = translated.value;

  if (journal.panel === "architecture") {
    let step = startArchitectureDispatchProgram(journal.input);
    if (!step.ok) return { kind: "error", message: step.errors.join("\n") };
    for (const event of journal.events) {
      const reduced = reduceArchitectureProgram(step.value.state, event);
      if (!reduced.ok) return { kind: "error", message: `Panel program rejected event: ${JSON.stringify(reduced.error)}` };
      step = { ok: true, value: reduced.value };
    }
    process.stdout.write(JSON.stringify(step.value, null, 2) + "\n");
    return { kind: "passthrough" };
  }

  let step = startRefutationDispatchProgram(journal.input);
  if (!step.ok) return { kind: "error", message: step.errors.join("\n") };
  for (const event of journal.events) {
    const reduced = reduceRefutationProgram(step.value.state, event);
    if (!reduced.ok) return { kind: "error", message: `Panel program rejected event: ${JSON.stringify(reduced.error)}` };
    step = { ok: true, value: reduced.value };
  }
  process.stdout.write(JSON.stringify(step.value, null, 2) + "\n");
  return { kind: "passthrough" };
};

export default handler;
