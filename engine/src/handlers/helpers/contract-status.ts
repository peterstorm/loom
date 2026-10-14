/**
 * Contract Status (CT-1): print what each Acceptance Contract has frozen, when
 * each Requirement it covers is due, and whether it was revised.
 *
 * A read-only shell around the pure `renderContractStatus`: it locates the
 * TaskGraph, loads it, renders and writes the lines. It never writes the State
 * File and never takes the TaskGraph lock (FR-005). A missing TaskGraph is
 * refused with the path looked for; an unreadable or corrupt one surfaces the
 * parser's error rather than reading as missing.
 */

import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { renderContractStatus } from "../../core/contract-status";

const toStdout = (text: string): void => {
  process.stdout.write(text);
};

export function createContractStatusHandler(write: (text: string) => void = toStdout): HookHandler {
  return async () => {
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };

    // Only the load boundary may refuse: the renderer is pure and total, so a
    // throw from it is a defect and must crash rather than read as a refusal.
    let graph: ReturnType<StateManager["load"]>;
    try {
      graph = manager.load();
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    write(`${renderContractStatus(graph).join("\n")}\n`);
    return { kind: "passthrough" };
  };
}

export default createContractStatusHandler();
