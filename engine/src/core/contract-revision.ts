/**
 * Contract Revision: the one operator path that changes a frozen Acceptance
 * Contract.
 *
 * A frozen contract's bytes are the specification its claimants implement; no
 * Task may write them. When an acceptance test or the types file is itself
 * wrong, the operator edits it and records a revision: the new bytes are
 * stamped, the roster is cleared so the next Wave Gate re-records it green, and
 * the current Wave's claimants that already implemented against the old bytes
 * return to revalidation. A claimant in a completed Wave is verified scope —
 * that Wave must be reopened first, never silently re-judged.
 *
 * Its Wave precondition (execute Phase, no live gate, no implementation
 * reservation or active attempt) is the one Task Reopening shares,
 * `reopenableWave`; the contract checks are its own.
 *
 * Pure: the shell supplies its observations of the frozen paths.
 */

import { match } from "ts-pattern";
import {
  CONTRACT_ID,
  contractClaimants,
  contractWave,
  frozenPathDigests,
  renderFrozenPathProblems,
  type AcceptanceContract,
  type ContractRevision,
  type FrozenPathObservations,
} from "./acceptance-contract";
import { canonicalStructuralEquals, type DomainResult } from "./orchestration-contract";
import { reopenableWave, returnWaveTasksToRevalidation, type WaveReopeningRefusal } from "./task-revalidation";
import type { TaskGraph } from "../types";

/** The longest reason a revision records; it is an audit line, not a document. */
const MAX_REVISION_REASON_LENGTH = 512;

export type ContractRevisionRequest = Readonly<{ contract: string; reason: string }>;

export type ContractRevisionRefusalKind =
  | "unknown-contract"
  | "not-executing"
  | "implementation-active"
  | "live-wave-gate"
  | "not-frozen"
  | "contract-wave-open"
  | "claimant-completed"
  | "unreadable-path"
  | "observation-stale"
  | "unchanged";

export type ContractRevisionRefusal = Readonly<{ kind: ContractRevisionRefusalKind; message: string }>;

export type RevisedContract = Readonly<{ graph: TaskGraph; contract: string; revision: ContractRevision }>;

const USAGE = 'Usage: helper revise-contract --contract CT-<n> --reason "<why the frozen bytes changed>"';

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const refuse = (kind: ContractRevisionRefusalKind, message: string): DomainResult<never, ContractRevisionRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });

/** The shared Wave-reopening refusal, in this operation's words. */
const waveReopeningRefusal = (refusal: WaveReopeningRefusal): DomainResult<never, ContractRevisionRefusal> =>
  match(refusal)
    .with({ kind: "not-executing" }, ({ phase }) =>
      refuse("not-executing", `Contract Revision requires the execute Phase (current: ${phase})`))
    .with({ kind: "live-wave-gate" }, ({ runId, wave }) =>
      refuse("live-wave-gate", `Contract Revision refused: Wave Gate run ${runId} owns Wave ${wave}'s ` +
        "verification; abandon it with helper orchestration abandon, then retry"))
    .with({ kind: "implementation-active" }, ({ holders }) =>
      refuse("implementation-active", `Contract Revision refused while implementation reservations are active: ${holders.join(", ")}`))
    .exhaustive();

/** Exactly `--contract CT-<n>` and a non-blank `--reason`, each once, in either order. */
export function parseContractRevisionArgs(args: readonly string[]): DomainResult<ContractRevisionRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${USAGE}` });
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (flag !== "--contract" && flag !== "--reason") return fail(`unknown argument '${flag}'`);
    if (value === undefined) return fail(`${flag} needs a value`);
    if (values.has(flag)) return fail(`${flag} is given twice`);
    values.set(flag, value);
  }
  const contract = values.get("--contract");
  const reason = values.get("--reason")?.trim();
  if (contract === undefined || !CONTRACT_ID.test(contract)) return fail("--contract must name a contract as CT-<n>");
  if (reason === undefined || reason.length === 0) return fail("--reason must say why the frozen bytes changed");
  if (reason.length > MAX_REVISION_REASON_LENGTH) {
    return fail(`--reason is longer than ${MAX_REVISION_REASON_LENGTH} characters`);
  }
  return freeze({ ok: true as const, value: freeze({ contract, reason }) });
}

/**
 * Record an operator Contract Revision against the observed frozen bytes, or
 * refuse with the exact precondition that failed.
 */
export function reviseAcceptanceContract(
  graph: TaskGraph,
  request: ContractRevisionRequest,
  observations: FrozenPathObservations,
): DomainResult<RevisedContract, ContractRevisionRefusal> {
  const contracts = graph.acceptance_contracts ?? [];
  const contract = contracts.find(({ id }) => id === request.contract);
  if (contract === undefined) {
    const known = contracts.map(({ id }) => id).join(", ") || "none";
    return refuse("unknown-contract", `${request.contract} is not an Acceptance Contract of this TaskGraph (contracts: ${known})`);
  }
  const reopenable = reopenableWave(graph);
  if (!reopenable.ok) return waveReopeningRefusal(reopenable.error);
  const { wave } = reopenable.value;
  if (contract.freeze.state === "awaiting-red") {
    return refuse("not-frozen", `${contract.id} is not frozen yet: its contract Task ${contract.contractTask} still owns ` +
      "those files until its Wave Gate observes them red");
  }
  const completedWaves = new Set((graph.wave_gate_history ?? []).map(({ wave: completed }) => completed));
  const writtenIn = contractWave(contract, graph.tasks);
  if (writtenIn === undefined || !completedWaves.has(writtenIn)) {
    return refuse("contract-wave-open", `${contract.id}'s contract Wave ${writtenIn ?? "?"} has not completed; ` +
      "finish it before revising what it froze");
  }
  const claimants = contractClaimants(contract, graph.tasks);
  const settled = claimants.filter((task) => completedWaves.has(task.wave));
  if (settled.length > 0) {
    return refuse("claimant-completed", `${contract.id} has claimants in completed Waves, verified against the frozen bytes: ` +
      `${settled.map(({ id, wave: settledWave }) => `${id} (Wave ${settledWave})`).join(", ")}; ` +
      "reopen that Wave first (helper reopen-completed-wave)");
  }
  const observed = frozenPathDigests(contract, observations);
  if (!observed.ok) {
    // A path the shell never observed means the contracts changed between its
    // read and this lock: the observation is stale, not the file unreadable.
    return observed.error.some(({ kind }) => kind === "not-observed")
      ? refuse("observation-stale", `${contract.id}'s frozen paths changed while they were being observed ` +
        `(${renderFrozenPathProblems(observed.error)}); retry`)
      : refuse("unreadable-path", `${contract.id}: frozen path(s) missing or unreadable: ${renderFrozenPathProblems(observed.error)}`);
  }
  if (canonicalStructuralEquals(contract.freeze.paths, observed.value)) {
    return refuse("unchanged", `${contract.id}'s frozen bytes are unchanged; edit them before recording a revision`);
  }

  const revalidatedIds = claimants
    .filter((task) => task.wave === wave && task.status === "implemented")
    .map(({ id }) => id);
  const revision: ContractRevision = freeze({
    revision: contract.revisions.length + 1,
    reason: request.reason,
    previous: contract.freeze.paths,
    paths: observed.value,
    revalidatedTaskIds: Object.freeze(revalidatedIds),
  });
  const revisedContract: AcceptanceContract = freeze({
    ...contract,
    freeze: freeze({ state: "revised", paths: observed.value }),
    revisions: Object.freeze([...contract.revisions, revision]),
  });
  // The current Wave's suite receipt and reviews judged the old bytes. The
  // transition reads no contract, so the revised one is written over its result.
  const revisedGraph: TaskGraph = {
    ...returnWaveTasksToRevalidation(reopenable.value, revalidatedIds),
    acceptance_contracts: contracts.map((entry) => entry.id === contract.id ? revisedContract : entry),
  };
  return freeze({ ok: true as const, value: freeze({ graph: revisedGraph, contract: contract.id, revision }) });
}
