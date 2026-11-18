/**
 * `helper retro-facts [--wave <N>] [--graph <path>]` (ADR-0083): print the
 * friction a run recorded, as JSON, for `/retro` to read before the session
 * transcript. The live TaskGraph by default; `--graph` names an archived one
 * (`completed_task_graph-*.json`), parsed by the same State File parser.
 * `--wave` narrows the output to one Wave's digest and its suggestion.
 *
 * Read-only: it never takes the TaskGraph lock and never writes.
 */

import { readFileSync } from "node:fs";
import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { parseTaskGraph } from "../../state-manager";
import { retroFacts } from "../../core/retro-facts";
import { retroSuggestions } from "../../core/retro-triggers";
import { isFlagToken, positiveIntegerToken } from "../../core/cli-flag-token";

export const RETRO_FACTS_USAGE = "Usage: helper retro-facts [--wave <N>] [--graph <path to a live or archived TaskGraph>]";

type RetroFactsArgs = Readonly<{ wave: number | null; graph: string | null }>;

function parseArgs(args: readonly string[]): Readonly<{ ok: true; value: RetroFactsArgs }> | Readonly<{ ok: false; error: string }> {
  let wave: number | null = null;
  let graph: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--wave" && flag !== "--graph") return { ok: false, error: `unknown argument '${flag}'. ${RETRO_FACTS_USAGE}` };
    if (value === undefined || isFlagToken(value)) return { ok: false, error: `${flag} needs a value. ${RETRO_FACTS_USAGE}` };
    if (flag === "--wave") {
      if (wave !== null) return { ok: false, error: `--wave is given twice. ${RETRO_FACTS_USAGE}` };
      wave = positiveIntegerToken(value);
      if (wave === null) return { ok: false, error: `--wave must be a positive integer. ${RETRO_FACTS_USAGE}` };
    } else {
      if (graph !== null) return { ok: false, error: `--graph is given twice. ${RETRO_FACTS_USAGE}` };
      graph = value;
    }
  }
  return { ok: true, value: { wave, graph } };
}

const toStdout = (text: string): void => {
  process.stdout.write(text);
};

export function createRetroFactsHandler(write: (text: string) => void = toStdout): HookHandler {
  return async (_stdin, args) => {
    const parsedArgs = parseArgs(args);
    if (!parsedArgs.ok) return { kind: "error", message: `retro-facts: ${parsedArgs.error}` };
    const path = parsedArgs.value.graph ?? taskGraphPath();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return { kind: "error", message: `retro-facts: cannot read the TaskGraph at ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const graph = parseTaskGraph(raw);
    if (!graph.ok) return { kind: "error", message: `retro-facts: the TaskGraph at ${path} does not parse: ${graph.error}` };
    const facts = retroFacts(graph.value);
    const suggestions = retroSuggestions(facts);
    const { wave } = parsedArgs.value;
    if (wave === null) {
      write(`${JSON.stringify({ graph: path, facts, suggestions }, null, 2)}\n`);
      return { kind: "passthrough" };
    }
    const digest = facts.waves.find((entry) => entry.wave === wave);
    if (digest === undefined) return { kind: "error", message: `retro-facts: the TaskGraph at ${path} has no Wave ${wave}` };
    write(`${JSON.stringify({
      graph: path,
      wave: digest,
      engineRevisionAdoptions: facts.engineRevisionAdoptions,
      suggestion: suggestions.find((entry) => entry.wave === wave) ?? null,
    }, null, 2)}\n`);
    return { kind: "passthrough" };
  };
}

export default createRetroFactsHandler();
