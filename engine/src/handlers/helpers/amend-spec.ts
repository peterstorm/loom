/**
 * `helper amend-spec --from <proposed spec> --reason <text>` (ADR-0087):
 * change the specification's text while the TaskGraph is live.
 *
 * Observes the protected spec_file and the proposed bytes (both indexed under
 * the spec_file path), decides through the pure `amendSpec`, commits the
 * audit under the TaskGraph lock, and only then writes the new bytes. A crash
 * between the two leaves the audit naming bytes the spec does not hold yet; the
 * same command then answers `bytes-pending` and writes them.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { anyActiveSubagent } from "../../machine/ledger";
import { isFlagToken } from "../../core/cli-flag-token";
import { amendSpec, type SpecAmendmentOutcome } from "../../core/spec-amendment";
import { observeSpecIndex, projectSpecBytes } from "../../orchestration/spec-index-observation";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

export const AMEND_SPEC_USAGE = "Usage: helper amend-spec --from <path to the proposed spec> --reason <why the spec changes>";

const OPERATION = "spec amendment";

/** Exactly one `--from` and one `--reason`, in any order. */
export function parseAmendSpecArgs(args: readonly string[]): Readonly<{ ok: true; from: string; reason: string }> | Readonly<{ ok: false; error: string }> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const value = args[index + 1];
    if (flag !== "--from" && flag !== "--reason") return { ok: false, error: `unknown argument '${flag}'. ${AMEND_SPEC_USAGE}` };
    if (value === undefined || isFlagToken(value)) return { ok: false, error: `${flag} needs a value. ${AMEND_SPEC_USAGE}` };
    if (values.has(flag)) return { ok: false, error: `${flag} is given twice. ${AMEND_SPEC_USAGE}` };
    values.set(flag, value);
  }
  const from = values.get("--from");
  const reason = values.get("--reason");
  if (from === undefined || reason === undefined) return { ok: false, error: AMEND_SPEC_USAGE };
  return { ok: true, from, reason: reason.trim() };
}

function outcomeMessage(outcome: SpecAmendmentOutcome, specFile: string): string {
  if (outcome.kind === "unchanged") return `${specFile} already holds the proposed text; nothing written\n`;
  const { wave, rewritten, added, withdrawn, rejudge } = outcome.amendment;
  const list = (label: string, ids: readonly string[]) => (ids.length === 0 ? [] : [`${label} ${ids.join(", ")}`]);
  const changes = [...list("rewrote", rewritten), ...list("added", added), ...list("withdrew", withdrawn)].join("; ") || "changed no Requirement";
  const owed = rejudge.length === 0 ? "" : ` The next Wave Gate judges ${rejudge.map(({ taskId, claim }) => `${taskId}:${claim}`).join(", ")} again.`;
  const prefix = outcome.kind === "bytes-pending" ? "Finished a recorded spec amendment" : "Spec amended";
  return `${prefix} (${changes}); Wave ${wave} review authority retired.${owed} ` +
    "Assign any added Requirement with helper amend-spec-trace, then start the Wave Gate.\n";
}

/**
 * Write `bytes` to `path` through a sibling temporary file, so a reader never
 * sees a partial spec; the temporary file is removed when the write fails.
 */
function writeAtomically(path: string, bytes: Buffer): void {
  const temporary = `${path}.amend-spec.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function createAmendSpecHandler(subagentActive: SubagentActivity = anyActiveSubagent): HookHandler {
  return async (_stdin, args) => {
    const parsed = parseAmendSpecArgs(args);
    if (!parsed.ok) return { kind: "error", message: `amend-spec: ${parsed.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `amend-spec: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `amend-spec: ${refusal}` };

    let proposedBytes: Buffer;
    try {
      proposedBytes = readFileSync(parsed.from);
    } catch (error) {
      return { kind: "error", message: `amend-spec: cannot read ${parsed.from}: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      // Observed before the lock, like amend-spec-trace: the core refuses when
      // spec_file moved, and the transform reads no mutable source bytes.
      const specFile = manager.load().spec_file;
      if (specFile === null || specFile === undefined) return { kind: "error", message: "amend-spec: the TaskGraph names no spec_file" };
      const proposed = projectSpecBytes(specFile, proposedBytes);
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        // Observed under the lock, so the audit's `before` names the bytes this run replaces.
        const decided = amendSpec(locked, observeSpecIndex(locked.spec_file ?? specFile), proposed, parsed.reason);
        if (!decided.ok) throw new Error(`refused without changing state (${decided.error.kind}): ${decided.error.message}`);
        return { state: decided.value.kind === "amended" ? decided.value.graph : locked, value: decided.value };
      });
      if (outcome.kind !== "unchanged") {
        try {
          writeAtomically(specFile, proposedBytes);
        } catch (error) {
          return {
            kind: "error",
            message: `amend-spec: the amendment is recorded, but writing ${specFile} failed: ` +
              `${error instanceof Error ? error.message : String(error)}. Fix the cause and run the same command again; ` +
              "it writes the bytes without recording a second amendment",
          };
        }
      }
      process.stderr.write(outcomeMessage(outcome, specFile));
      return { kind: "passthrough" };
    } catch (error) {
      return { kind: "error", message: `amend-spec: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

export default createAmendSpecHandler();
