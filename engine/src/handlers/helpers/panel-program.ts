/**
 * `helper panel-program architecture < program.json`: replay the journal
 * `/loom --panel` keeps through the architecture dispatch program and print
 * the resulting state and next action (ADR-0096). Parsing and replay are pure
 * (`core/panel-program`); this shell only reads stdin and writes stdout.
 */
import type { HookHandler } from "../../types";
import {
  parseArchitecturePanelJournal,
  reduceArchitectureProgram,
  startArchitectureDispatchProgram,
} from "../../core/panel-program";

const USAGE = "Usage: helper panel-program architecture < program.json";

const handler: HookHandler = async (stdin, args) => {
  if (args[0] !== "architecture") return { kind: "error", message: USAGE };
  let raw: unknown;
  try { raw = JSON.parse(stdin); }
  catch (error) { return { kind: "error", message: `Panel program input is invalid JSON: ${error}` }; }
  const journal = parseArchitecturePanelJournal(raw);
  if (!journal.ok) return { kind: "error", message: journal.error };

  let step = startArchitectureDispatchProgram(journal.value.input);
  if (!step.ok) return { kind: "error", message: step.errors.join("\n") };
  for (const event of journal.value.events) {
    const reduced = reduceArchitectureProgram(step.value.state, event);
    if (!reduced.ok) return { kind: "error", message: `Panel program rejected event: ${JSON.stringify(reduced.error)}` };
    step = { ok: true, value: reduced.value };
  }
  process.stdout.write(JSON.stringify(step.value, null, 2) + "\n");
  return { kind: "passthrough" };
};

export default handler;
