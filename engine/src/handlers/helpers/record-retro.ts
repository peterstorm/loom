/**
 * `helper record-retro` (ADR-0083): audit that a retrospective was written, or
 * deliberately skipped, so `complete-orchestration` can retire the run.
 *
 *   helper record-retro --file <path under .claude/retros, .md> [--wave <N>]
 *   helper record-retro --skip --reason <text>
 *
 * A written retro is bound to the sha256 of its bytes as read now; without
 * `--wave` it covers the whole run. A skip always covers the whole run. The
 * record is appended under the TaskGraph lock; an identical record already
 * present changes nothing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler } from "../../types";
import { observeTaskGraphProjectBoundary, taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { isFlagToken } from "../../core/cli-flag-token";
import { parseRetroPath, retroRecordEntry, retroRecordPresent, type RetroRecordInput } from "../../core/retro-record";
import { describeCause } from "../../utils/describe-cause";

export const RECORD_RETRO_USAGE =
  "Usage: helper record-retro --file <.claude/retros/<name>.md> [--wave <N>] | helper record-retro --skip --reason <text>";

type Request =
  | Readonly<{ kind: "written"; file: string; wave: number | null }>
  | Readonly<{ kind: "skipped"; reason: string }>;

function parseArgs(args: readonly string[]): Readonly<{ ok: true; value: Request }> | Readonly<{ ok: false; error: string }> {
  const fail = (problem: string) => ({ ok: false as const, error: `${problem}. ${RECORD_RETRO_USAGE}` });
  const values = new Map<string, string>();
  let skip = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    if (flag === "--skip") {
      skip = true;
      continue;
    }
    if (flag !== "--file" && flag !== "--wave" && flag !== "--reason") return fail(`unknown argument '${flag}'`);
    const value = args[index + 1];
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (values.has(flag)) return fail(`${flag} is given twice`);
    values.set(flag, value);
    index += 1;
  }
  if (skip) {
    if (values.has("--file") || values.has("--wave")) return fail("--skip takes only --reason");
    const reason = values.get("--reason");
    return reason === undefined ? fail("--skip needs --reason saying why the run has no retro") : { ok: true, value: { kind: "skipped", reason: reason.trim() } };
  }
  if (values.has("--reason")) return fail("--reason belongs to --skip");
  const raw = values.get("--file");
  if (raw === undefined) return fail("name the retro with --file, or skip it with --skip --reason");
  const path = parseRetroPath(raw);
  if (!path.ok) return fail(`--file ${path.error}`);
  const file = path.value;
  const rawWave = values.get("--wave");
  if (rawWave !== undefined && !/^[1-9][0-9]*$/.test(rawWave)) return fail("--wave must be a positive integer");
  return { ok: true, value: { kind: "written", file, wave: rawWave === undefined ? null : Number(rawWave) } };
}

/** The record input for a request: a written retro is read and hashed relative to `root`. */
function recordInput(request: Request, root: string): RetroRecordInput {
  if (request.kind === "skipped") return { kind: "retro-skipped", reason: request.reason };
  const bytes = readFileSync(join(root, request.file));
  if (bytes.byteLength === 0) throw new Error(`${request.file} is empty; write the retro first`);
  return {
    kind: "retro-recorded",
    scope: request.wave === null ? { kind: "run" } : { kind: "wave", wave: request.wave },
    path: request.file,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function createRecordRetroHandler(): HookHandler {
  return async (_stdin, args) => {
    const request = parseArgs(args);
    if (!request.ok) return { kind: "error", message: `record-retro: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `record-retro: No task graph at ${statePath}` };
    try {
      const entry = retroRecordEntry(recordInput(request.value, observeTaskGraphProjectBoundary(statePath).root));
      if (!entry.ok) return { kind: "error", message: `record-retro: ${entry.error}` };
      const wave = request.value.kind === "written" ? request.value.wave : null;
      const outcome = await manager.updateAndReturn((locked) => {
        if (wave !== null && !locked.tasks.some((task) => task.wave === wave)) {
          throw new Error(`the TaskGraph has no Wave ${wave}`);
        }
        if (retroRecordPresent(locked.retro_records, entry.value)) return { state: locked, value: "unchanged" as const };
        return {
          state: { ...locked, retro_records: Object.freeze([...(locked.retro_records ?? []), entry.value]) },
          value: "recorded" as const,
        };
      });
      process.stdout.write(`${JSON.stringify(entry.value, null, 2)}\n`);
      process.stdout.write(outcome === "recorded" ? "Retro recorded.\n" : "This retro was already recorded; nothing changed.\n");
      return { kind: "allow" };
    } catch (error) {
      return { kind: "error", message: `record-retro refused without changing state: ${describeCause(error)}` };
    }
  };
}

export default createRecordRetroHandler();
