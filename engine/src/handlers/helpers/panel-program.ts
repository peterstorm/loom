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
import { type PanelLens } from "../../core/panel-contract";
import { type ReviewLens } from "../../core/review-panel";
import type { PublicationAuthorityResolver } from "../../core/orchestration-contract";
// The legacy v1 journal translation surface moved to the archive (A11): this
// helper file keeps the byte-preserving shell entry point and re-exports the
// archive's names so existing import sites (orchestration.ts, tests) keep
// working. See core/legacy-archive.ts Section D for the deprecation horizon.
import {
  translateLegacyPanelJournal,
  LEGACY_PANEL_PROGRAM_SCHEMA_VERSION,
  PANELS,
  type LegacyArchitecturePanelJournal,
  type LegacyJournalTranslation,
  type LegacyPanelJournal,
  type LegacyPanelKind,
  type LegacyRefutationPanelJournal,
} from "../../core/legacy-archive";

const USAGE = `Usage: helper panel-program <${PANELS.join("|")}> < program.json`;

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

// ── Legacy v1 journal translation surface (archived; re-exported for compat) ──
export {
  LEGACY_PANEL_PROGRAM_SCHEMA_VERSION,
  translateLegacyPanelJournal,
  type LegacyArchitecturePanelJournal,
  type LegacyJournalTranslation,
  type LegacyPanelJournal,
  type LegacyPanelKind,
  type LegacyRefutationPanelJournal,
} from "../../core/legacy-archive";

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
