/**
 * Record an operator Contract Revision: observe the edited frozen bytes of one
 * Acceptance Contract, then re-stamp them and return the current Wave's
 * implemented claimants to revalidation, atomically through StateManager.
 *
 * A revision also settles the contract's engine-written skeletons (AD-10,
 * FR-033): once the revision is known to be admissible, the skeleton refresh
 * (`refreshRevisedSkeletons`, `orchestration/skeleton-revision.ts`) rewrites
 * every untouched skeleton from the revised types and settles every modified
 * one stale, and the locked update commits those settlements with the
 * revision (`reviseAcceptanceContract`). Status shows a stale one as
 * `stale against revised contract`. Every binding problem the revised types
 * raise (a vanished or retyped alias) is named in the outcome; the next
 * spawn's stage two re-resolves the stamped types and blocks on it (AS-051).
 * Writes precede the locked update: a refused update leaves refreshed bytes
 * that content-addressed recognition adopts.
 */

import { dirname, resolve } from "node:path";
import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { anyActiveSubagent } from "../../machine/ledger";
import { frozenPathsToObserve } from "../../core/acceptance-contract";
import { parseContractRevisionArgs, reviseAcceptanceContract, revisionOutcomeMessage } from "../../core/contract-revision";
import { observeFrozenDigests } from "../../orchestration/frozen-path-observation";
import { refreshRevisedSkeletons } from "../../orchestration/skeleton-revision";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";
import { resolveCanonicalGitRepositoryRoot } from "../../utils/workspace-digest";

const OPERATION = "Contract Revision";

export function createReviseContractHandler(subagentActive: SubagentActivity = anyActiveSubagent): HookHandler {
  return async (_stdin, args) => {
    const request = parseContractRevisionArgs(args);
    if (!request.ok) return { kind: "error", message: request.error };

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: refusal };
    const repository = resolveCanonicalGitRepositoryRoot(dirname(resolve(manager.getPath())));
    if (!repository.ok) {
      const reason = "message" in repository.error ? repository.error.message : repository.error.kind;
      return { kind: "error", message: `Contract Revision needs the TaskGraph's Git repository: ${reason}` };
    }

    try {
      // Observed before the lock, like the Wave Gate's stamp: the locked
      // transform reads no mutable bytes, and refuses as stale if the contracts
      // under the lock name a path this observation never read.
      const loaded = manager.load();
      const observations = observeFrozenDigests(repository.value, frozenPathsToObserve(loaded.acceptance_contracts ?? []));
      // A refused revision must not touch a skeleton: decide admissibility
      // first, then write, then commit under the lock (which decides again).
      const admissible = reviseAcceptanceContract(loaded, request.value, observations);
      if (!admissible.ok) return { kind: "error", message: admissible.error.message };
      const skeletons = refreshRevisedSkeletons(repository.value, loaded, request.value.contract);
      if (!skeletons.ok) {
        return { kind: "error", message: `Contract Revision cannot refresh ${request.value.contract}'s skeletons: ${skeletons.error}` };
      }
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const revised = reviseAcceptanceContract(locked, request.value, observations, skeletons.value);
        if (!revised.ok) throw new Error(revised.error.message);
        return { state: revised.value.graph, value: revised.value };
      });
      process.stderr.write(revisionOutcomeMessage(outcome));
      return { kind: "passthrough" };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

export default createReviseContractHandler();
