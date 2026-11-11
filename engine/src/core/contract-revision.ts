/**
 * Contract Revision: the one operator path that changes a frozen Acceptance
 * Contract.
 *
 * A frozen contract's bytes are the specification its claimants implement; no
 * Task may write them. When an acceptance test or the types file is itself
 * wrong, the operator edits it and records a revision: the new bytes are
 * stamped, the roster is cleared so the next Wave Gate re-records it green, and
 * the current Wave's claimants that already implemented against the old bytes
 * return to revalidation, with that Wave's settled Distill Task when any
 * claimant does (ADR-0068 §7). A claimant in a completed Wave is verified scope —
 * that Wave must be reopened first, never silently re-judged.
 *
 * Its Wave precondition (execute Phase, no live gate, no implementation
 * reservation or active attempt) is the one Task Reopening shares,
 * `reopenableWave`; the contract checks are its own.
 *
 * A revision also settles the contract's engine-written skeletons (AD-10,
 * FR-033): the shell has already refreshed each untouched one from the
 * revised types and hands over one settlement per path — the new digests of
 * a refreshed one, or `stale` for a modified one, which keeps its bytes and
 * record and is flagged `stale: { revision }`. The binding problems the
 * revised types raise are reported, never committed: the next spawn's stage
 * two re-resolves the stamped types and blocks on them. A prepared name a
 * skeleton write left behind is reported as a note, never a refusal.
 *
 * Pure: the shell supplies its observations of the frozen paths and the
 * skeleton refresh it already wrote.
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
import { normalizePlanPath } from "./plan-path-match";
import type { LeftPreparedName, SkeletonProblem } from "./skeleton/problems";
import { installSkeletonRecords } from "./skeleton/records";
import { renderSkeletonRevisionLines } from "./skeleton/status";
import type { SkeletonRecord } from "./skeleton/types";
import { reopenableWave, returnWaveTasksToRevalidation, type WaveReopeningRefusal } from "./task-revalidation";
import type { TaskGraph } from "../types";

/** The longest reason a revision records; it is an audit line, not a document. */
const MAX_REVISION_REASON_LENGTH = 512;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);

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

/**
 * How a revision settles one engine-written skeleton of the contract: either
 * refreshed from the revised types (its record takes these digests, origin
 * `revision`), or left on disk because it was modified (its record is kept,
 * flagged `stale: { revision }`). Refused at write time with reason
 * `modified` is the same settlement as modified when observed (ADR-0057).
 */
export type SkeletonSettlement =
  | Readonly<{ kind: "refreshed"; skeleton: RefreshedSkeleton }>
  | Readonly<{ kind: "stale" }>;

/** The record fields a refresh rewrites; the path is the settlement's key. */
export type RefreshedSkeleton = Readonly<Pick<SkeletonRecord, "contract" | "language" | "engineSha256" | "typesSha256">>;

/**
 * What the revision shell did to the contract's engine-written skeletons
 * before the locked update: one settlement per skeleton path it settled,
 * keyed by normalized path so no path is both refreshed and stale, every
 * problem the revised types raised, and every prepared name a write left
 * behind. Built only by `skeletonRevisionOf`.
 */
export type SkeletonRevision = Readonly<{
  settlements: ReadonlyMap<string, SkeletonSettlement>;
  bindingProblems: readonly SkeletonProblem[];
  leftovers: readonly LeftPreparedName[];
}>;

/** The revision of `settled` paths (a later settlement of one path replaces
 *  an earlier one), `bindingProblems` and `leftovers`. */
export const skeletonRevisionOf = (
  settled: readonly (readonly [path: string, settlement: SkeletonSettlement])[],
  bindingProblems: readonly SkeletonProblem[],
  leftovers: readonly LeftPreparedName[] = [],
): SkeletonRevision =>
  freeze({
    settlements: new Map(settled.map(([path, settlement]) => [normalizePlanPath(path), settlement] as const)),
    bindingProblems: Object.freeze([...bindingProblems]),
    leftovers: Object.freeze([...leftovers]),
  });

/** A revision of a contract with no engine-written skeleton to settle. */
export const NO_SKELETON_REVISION: SkeletonRevision = skeletonRevisionOf([], []);

export type RevisedContract = Readonly<{
  graph: TaskGraph;
  contract: string;
  revision: ContractRevision;
  /** The paths of the refreshed skeletons. */
  refreshed: readonly string[];
  /** The paths whose records are now flagged `stale: { revision }`; status
   *  renders each as `stale against revised contract`. */
  staleSkeletons: readonly string[];
  bindingProblems: readonly SkeletonProblem[];
  /** The prepared names the skeleton writes left behind: notes, never refusals. */
  leftovers: readonly LeftPreparedName[];
}>;

/** The settled paths of one kind, in settlement order. */
const settledPaths = (skeletons: SkeletonRevision, kind: SkeletonSettlement["kind"]): readonly string[] =>
  Object.freeze([...skeletons.settlements].flatMap(([path, settlement]) => (settlement.kind === kind ? [path] : [])));

/** The stale-settled paths `revisedSkeletonRecords` actually flags, in
 *  settlement order: only those with a record. A stale settlement with no
 *  record flags nothing, so it is never reported stale either. */
const flaggedStalePaths = (current: readonly SkeletonRecord[], skeletons: SkeletonRevision): readonly string[] => {
  const recorded = new Set(current.map(({ path }) => normalizePlanPath(path)));
  return Object.freeze(settledPaths(skeletons, "stale").filter((path) => recorded.has(path)));
};

/** The records after a revision: each stale-settled record flagged with the
 *  revision number, each refreshed one installed with origin `revision`. */
function revisedSkeletonRecords(
  current: readonly SkeletonRecord[],
  skeletons: SkeletonRevision,
  revision: number,
): readonly SkeletonRecord[] {
  const flagged = current.map((record): SkeletonRecord =>
    skeletons.settlements.get(normalizePlanPath(record.path))?.kind === "stale"
      ? freeze({ ...record, stale: freeze({ revision }) })
      : record);
  const refreshed = [...skeletons.settlements].flatMap(([path, settlement]): readonly SkeletonRecord[] =>
    settlement.kind === "refreshed" ? [freeze({ path, ...settlement.skeleton, origin: "revision", stale: null })] : []);
  return installSkeletonRecords(flagged, refreshed);
}

const USAGE = 'Usage: helper revise-contract --contract CT-<n> --reason "<why the frozen bytes changed>"';

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
    const flag = args[index];
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
 * refuse with the exact precondition that failed. `skeletons` is what the
 * shell already did to the contract's skeletons; it is committed with the
 * revision.
 */
export function reviseAcceptanceContract(
  graph: TaskGraph,
  request: ContractRevisionRequest,
  observations: FrozenPathObservations,
  skeletons: SkeletonRevision = NO_SKELETON_REVISION,
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

  // The current Wave's suite receipt and reviews judged the old bytes, and its
  // Distill Task distilled code written against them: the transition returns
  // it with the claimants, and the revision audits every Task it returned.
  const revalidated = returnWaveTasksToRevalidation(
    reopenable.value,
    claimants.filter((task) => task.wave === wave && task.status === "implemented").map(({ id }) => id),
  );
  const revision: ContractRevision = freeze({
    revision: contract.revisions.length + 1,
    reason: request.reason,
    previous: contract.freeze.paths,
    paths: observed.value,
    revalidatedTaskIds: revalidated.returned.taskIds,
  });
  const revisedContract: AcceptanceContract = freeze({
    ...contract,
    freeze: freeze({ state: "revised", paths: observed.value }),
    revisions: Object.freeze([...contract.revisions, revision]),
  });
  // The transition reads no contract, so the revised one is written over its result.
  const revisedGraph: TaskGraph = {
    ...revalidated.graph,
    acceptance_contracts: contracts.map((entry) => entry.id === contract.id ? revisedContract : entry),
    ...(skeletons.settlements.size > 0 ? { skeletons: revisedSkeletonRecords(graph.skeletons ?? [], skeletons, revision.revision) } : {}),
  };
  return freeze({
    ok: true as const,
    value: freeze({
      graph: revisedGraph,
      contract: contract.id,
      revision,
      refreshed: settledPaths(skeletons, "refreshed"),
      staleSkeletons: flaggedStalePaths(graph.skeletons ?? [], skeletons),
      bindingProblems: skeletons.bindingProblems,
      leftovers: skeletons.leftovers,
    }),
  });
}

/** The outcome an operator reads: the revision, then the skeleton lines
 *  `renderSkeletonRevisionLines` owns — one per refreshed skeleton, stale
 *  skeleton, binding problem and prepared name left behind. */
export function revisionOutcomeMessage(
  { contract, revision, refreshed, staleSkeletons, bindingProblems, leftovers }:
    Pick<RevisedContract, "contract" | "revision" | "refreshed" | "staleSkeletons" | "bindingProblems" | "leftovers">,
): string {
  const revalidated = revision.revalidatedTaskIds.length === 0
    ? "no implemented claimant needed revalidation"
    : `${revision.revalidatedTaskIds.join(", ")} returned to revalidation`;
  return [
    `${contract} revision ${revision.revision} recorded; ${revalidated}. The next Wave Gate re-records its acceptance roster green.`,
    ...renderSkeletonRevisionLines({ refreshed, stale: staleSkeletons, bindingProblems, leftovers }),
    "",
  ].join("\n");
}
