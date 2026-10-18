import type { HookHandler } from "../../types";
import {
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureDispatchProgram,
  startRefutationDispatchProgram,
} from "../../core/panel-program";
import {
  translateLegacyPanelJournal,
  PANELS,
  type LegacyPanelKind,
} from "../../core/legacy-archive";

const USAGE = `Usage: helper panel-program <${PANELS.join("|")}> < program.json`;

// The legacy v1 journal translation surface moved to the archive (A11): this
// helper file keeps the replay shell entry point and re-exports the archive's
// names so existing import sites (orchestration.ts, tests) keep working. See
// core/legacy-archive.ts Section D for the deprecation horizon.
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
