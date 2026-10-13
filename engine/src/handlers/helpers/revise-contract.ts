/**
 * Record an operator Contract Revision: observe the edited frozen bytes of one
 * Acceptance Contract, then re-stamp them and return the current Wave's
 * implemented claimants to revalidation, atomically through StateManager.
 */

import { dirname, resolve } from "node:path";
import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { anyActiveSubagent } from "../../machine/ledger";
import { frozenPathsToObserve } from "../../core/acceptance-contract";
import { parseContractRevisionArgs, reviseAcceptanceContract, type RevisedContract } from "../../core/contract-revision";
import { observeFrozenDigests } from "../../orchestration/frozen-path-observation";
import { resolveCanonicalGitRepositoryRoot } from "../../utils/workspace-digest";

function outcomeMessage({ contract, revision }: RevisedContract): string {
  const revalidated = revision.revalidatedTaskIds.length === 0
    ? "no implemented claimant needed revalidation"
    : `${revision.revalidatedTaskIds.join(", ")} returned to revalidation`;
  return `${contract} revision ${revision.revision} recorded; ${revalidated}. ` +
    "The next Wave Gate re-records its acceptance roster green.\n";
}

/** The shell's one collaborator besides the State File: whether a subagent is
 *  active for this TaskGraph. Checked before the lock and again under it, so a
 *  subagent that starts in between still refuses the revision. */
export type SubagentActivity = (statePath: string) => boolean;

export function createReviseContractHandler(subagentActive: SubagentActivity = anyActiveSubagent): HookHandler {
  return async (_stdin, args) => {
    const request = parseContractRevisionArgs(args);
    if (!request.ok) return { kind: "error", message: request.error };

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
    if (subagentActive(statePath)) {
      return {
        kind: "error",
        message: "Contract Revision refused while a subagent is active for this TaskGraph; wait for it to settle and retry",
      };
    }
    const repository = resolveCanonicalGitRepositoryRoot(dirname(resolve(manager.getPath())));
    if (!repository.ok) {
      const reason = "message" in repository.error ? repository.error.message : repository.error.kind;
      return { kind: "error", message: `Contract Revision needs the TaskGraph's Git repository: ${reason}` };
    }

    try {
      // Observed before the lock, like the Wave Gate's stamp: the locked
      // transform reads no mutable bytes, and refuses as stale if the contracts
      // under the lock name a path this observation never read.
      const observations = observeFrozenDigests(repository.value, frozenPathsToObserve(manager.load().acceptance_contracts ?? []));
      const outcome = await manager.updateAndReturn((locked) => {
        if (subagentActive(statePath)) {
          throw new Error("A subagent became active before the Contract Revision could commit");
        }
        const revised = reviseAcceptanceContract(locked, request.value, observations);
        if (!revised.ok) throw new Error(revised.error.message);
        return { state: revised.value.graph, value: revised.value };
      });
      process.stderr.write(outcomeMessage(outcome));
      return { kind: "passthrough" };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

export default createReviseContractHandler();
