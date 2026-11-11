import type { Task, TaskGraph, TaskTestResult } from "../../types";
import {
  describeDistillSnapshotFailure,
  distillRestoreOf,
  distillSnapshotRetention,
  distillSnapshotScope,
  keptDistillSnapshotNote,
  type DistillSnapshotFailure,
  type DistillSnapshotPort,
} from "../../core/distill-snapshot";
import { isDistillTask } from "../../core/distill-task";
import {
  redThenGreenDuty,
  settleObservedImplementation,
  settleUnavailableImplementation,
  type ImplementationSettlementApplicationResult,
  type IncomingImplementationEvidence,
  type NewTestEvidence,
  type RedThenGreenDuty,
  type TaskLocalByteObservation,
} from "../../core/implementation-application";
import type {
  ImplementationAttemptAuthority,
  IsoInstant,
} from "../../core/implementation-completion";
import type { NonEmpty } from "../../core/orchestration-contract";
import type { ProofEvaluationPolicy } from "../../core/proof-obligations";
import { discardDistillSnapshots, gitDistillSnapshots } from "../../orchestration/distill-snapshot";
import { judgeRedThenGreen } from "../../core/red-then-green";
import type { LedgerObservation, RedThenGreenObservation } from "../../core/red-then-green-types";
import { classifyTaskFiles } from "../../core/test-file-classification";
import { taskVerificationPolicy, type NewTestWaiverReason, type VerificationRequirement } from "../../core/verification-policy";
import { observeContractConformance } from "../../orchestration/contract-conformance-observation";
import { canonicalRepositoryPaths } from "../../utils/repository-path";
import {
  collectNewTestEvidence,
  describeNewTestObservationError,
  observeTaskLocalCompletion,
  realDiffDepsAt,
  type NewTestObservationResult,
  type TaskLocalCompletionArgs,
} from "./task-local-completion";

export type ExactImplementationTransportFacts = Readonly<{
  transport: "Claude" | "Pi";
  authority: ImplementationAttemptAuthority;
  observedAt: IsoInstant;
  parserModifiedPaths: readonly string[];
  parserPathLabel: string;
  taskCompleted: boolean;
  testResult: TaskTestResult;
  testEvidence: string;
  proofEvaluationPolicy: ProofEvaluationPolicy;
  /**
   * The attempt epoch's ledger as this transport read it: Claude Code's
   * session ledger folded into the agent's epoch, or the parent ledger read
   * back under a Pi child's grant epoch. Consulted only for a Task whose
   * `redThenGreenDuty` is `owed`; for such a Task an `unreadable`
   * observation settles as infrastructure and never as a semantic retry.
   */
  ledger: LedgerObservation;
}>;

export type ExactSettlementRepositoryPort = Readonly<{
  root: string;
  authoritativeStatePath: string;
  observeTaskLocal: (args: TaskLocalCompletionArgs) => TaskLocalByteObservation;
}>;

export type ExactNewTestCollectionArgs = Readonly<{
  filesModified: readonly string[];
  requirement: boolean | undefined | VerificationRequirement<NewTestWaiverReason>;
  startSha?: string;
}>;

export type ExactSettlementNewTestPort = Readonly<{
  collect: (args: ExactNewTestCollectionArgs) => NewTestObservationResult<NewTestEvidence>;
}>;

export type ExactImplementationSettlementPorts = Readonly<{
  repository: ExactSettlementRepositoryPort;
  newTests: ExactSettlementNewTestPort;
}>;

export type ExactImplementationSettlement = Readonly<{
  application: ImplementationSettlementApplicationResult;
  infrastructureReason?: string;
}>;

export function productionExactSettlementPorts(
  repositoryRoot: string,
  authoritativeStatePath: string,
): ExactImplementationSettlementPorts {
  return Object.freeze({
    repository: Object.freeze({
      root: repositoryRoot,
      authoritativeStatePath,
      observeTaskLocal: observeTaskLocalCompletion,
    }),
    newTests: Object.freeze({
      collect: (args: ExactNewTestCollectionArgs) =>
        collectNewTestEvidence(
          args.filesModified,
          args.requirement,
          args.startSha,
          realDiffDepsAt(repositoryRoot),
        ),
    }),
  });
}

function currentWaveSiblingOwnedPaths(
  state: TaskGraph,
  task: Task,
  repositoryRoot: string,
): readonly string[] {
  const paths = state.tasks
    .filter((candidate) => candidate.id !== task.id && candidate.wave === task.wave)
    .flatMap((candidate) => [...(candidate.file_list ?? []), ...(candidate.files_modified ?? [])]);
  return canonicalRepositoryPaths(
    repositoryRoot,
    paths,
    `${task.id} current-Wave sibling-owned paths`,
  );
}

function unavailable(
  state: TaskGraph,
  facts: ExactImplementationTransportFacts,
  reason: string,
  bytes?: TaskLocalByteObservation,
): ExactImplementationSettlement {
  return Object.freeze({
    application: settleUnavailableImplementation(
      state,
      facts.authority,
      facts.observedAt,
      reason,
      bytes,
    ),
    infrastructureReason: reason,
  });
}

/** I6 for one settlement: nothing owed, the judge's verdict, or why the
 *  ledger could not be judged (an infrastructure reason). */
type RedThenGreenJudgment =
  | Readonly<{ kind: "not-owed" }>
  | Readonly<{ kind: "judged"; observation: RedThenGreenObservation }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/**
 * The one place both harnesses split a Task's `file_list` for I6 (INV-2):
 * `classifyTaskFiles` against the frozen classification the `owed` duty
 * carries and the Task's first artifact baseline (which names the files it
 * creates, FR-007a), handed ready to the pure judge. Only an `owed` Task
 * consults the ledger; the epoch it judges is the one this attempt's transport observed
 * (I6 is judged per attempt epoch). A `proof-unfrozen` duty never reaches
 * here: settlement refuses it before observing anything.
 */
function judgeAttemptRedThenGreen(
  task: Task,
  duty: Exclude<RedThenGreenDuty, { kind: "proof-unfrozen" }>,
  facts: ExactImplementationTransportFacts,
  repositoryRoot: string,
): RedThenGreenJudgment {
  switch (duty.kind) {
    case "not-owed":
      return { kind: "not-owed" };
    case "classification-unfrozen":
      return { kind: "unavailable", reason: duty.reason };
    case "owed": {
      const { ledger } = facts;
      if (ledger.kind === "unreadable") {
        return { kind: "unavailable", reason: `${facts.transport} evidence ledger unreadable for ${task.id}: ${ledger.reason}` };
      }
      const piStructured = facts.testResult.verdict === "untrusted" && facts.testResult.provenance === "pi-structured";
      const classification = classifyTaskFiles(task.file_list ?? [], duty.testFiles, task.artifact_baseline);
      return { kind: "judged", observation: judgeRedThenGreen(ledger.events, classification, repositoryRoot, piStructured) };
    }
    default: {
      const unreachable: never = duty;
      return unreachable;
    }
  }
}

/** A settlement the Oracle cannot run at all: state unchanged, no receipt,
 *  the reservation left standing for the operator. */
function refused(state: TaskGraph, reason: string): ExactImplementationSettlement {
  return Object.freeze({
    application: Object.freeze({
      kind: "error",
      state,
      error: Object.freeze({ kind: "invalid-task", errors: Object.freeze<[string]>([reason]) }),
    }),
  });
}

/** One live attempt, proven current and owed a settlement: what every observation below reads. */
type SettlementContext = Readonly<{
  state: TaskGraph;
  task: Task;
  duty: Exclude<RedThenGreenDuty, { kind: "proof-unfrozen" }>;
  facts: ExactImplementationTransportFacts;
  ports: ExactImplementationSettlementPorts;
}>;

/** An observation the settlement needs, or the infrastructure settlement its failure already is. */
type Observed<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; settlement: ExactImplementationSettlement }>;

const observed = <T>(value: T): Observed<T> => ({ ok: true, value });
const withheld = (settlement: ExactImplementationSettlement): Observed<never> => ({ ok: false, settlement });

/** The attempt's bytes against its baselines, under locked Wave ownership. */
function observeAttemptBytes({ state, task, facts, ports }: SettlementContext): Observed<TaskLocalByteObservation> {
  let siblingOwnedPaths: readonly string[];
  try {
    siblingOwnedPaths = currentWaveSiblingOwnedPaths(state, task, ports.repository.root);
  } catch (error) {
    return withheld(unavailable(
      state,
      facts,
      `${facts.transport} sibling ownership observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
  let bytes: TaskLocalByteObservation;
  try {
    bytes = ports.repository.observeTaskLocal({
      repositoryRoot: ports.repository.root,
      task,
      authority: facts.authority,
      parserModifiedPaths: facts.parserModifiedPaths,
      parserPathLabel: facts.parserPathLabel,
      siblingOwnedPaths,
      authoritativeStatePath: ports.repository.authoritativeStatePath,
      // The engine-written skeleton records (AD-4). A graph with no
      // `skeletons` field recorded none; this is the one place that absence
      // is read — every layer below takes the records as required.
      engineSkeletons: state.skeletons ?? [],
    });
  } catch (error) {
    return withheld(unavailable(
      state,
      facts,
      `${facts.transport} task-local observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
  const suiteOutcome = bytes.suite.checks[0]?.outcome;
  return suiteOutcome?.kind === "observation-unavailable"
    ? withheld(unavailable(state, facts, suiteOutcome.reason, bytes))
    : observed(bytes);
}

/** What the transport did not carry and the shell observes: new tests, I6 and conformance. */
type ObservedAttemptEvidence = Pick<IncomingImplementationEvidence, "newTests" | "redThenGreen" | "contractConformance">;

/** New-test evidence, the I6 judgment and contract conformance over the observed bytes. */
function observeAttemptEvidence(
  { state, task, duty, facts, ports }: SettlementContext,
  bytes: TaskLocalByteObservation,
): Observed<ObservedAttemptEvidence> {
  let newTests: NewTestObservationResult<NewTestEvidence>;
  try {
    newTests = ports.newTests.collect({
      filesModified: bytes.cumulativeModifiedPaths,
      requirement: taskVerificationPolicy(task).newTests,
      startSha: task.start_sha,
    });
  } catch (error) {
    return withheld(unavailable(
      state,
      facts,
      `${facts.transport} new-test observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      bytes,
    ));
  }
  if (!newTests.ok) {
    return withheld(unavailable(
      state,
      facts,
      `${facts.transport} new-test observation unavailable: ${describeNewTestObservationError(newTests.error)}`,
      bytes,
    ));
  }
  const redThenGreen = judgeAttemptRedThenGreen(task, duty, facts, ports.repository.root);
  if (redThenGreen.kind === "unavailable") return withheld(unavailable(state, facts, redThenGreen.reason, bytes));
  // Conformance against the frozen contracts (AD-5): which files owe it is
  // the observation's scope (INV-5); a read failure is infrastructure.
  const conformance = observeContractConformance(ports.repository.root, state, task);
  if (!conformance.ok) {
    return withheld(unavailable(state, facts, `${facts.transport} contract conformance observation unavailable: ${conformance.error}`, bytes));
  }
  return observed({
    newTests: newTests.value,
    ...(redThenGreen.kind === "judged" ? { redThenGreen: redThenGreen.observation } : {}),
    contractConformance: conformance.value,
  });
}

/**
 * One settlement and the raw scope delta it judged
 * (`attemptScopeChangedPaths`; empty when the bytes could not be observed).
 */
type ObservedSettlement = Readonly<{
  settlement: ExactImplementationSettlement;
  scopeChanged: readonly string[];
}>;

/**
 * Observe the attempt once and run the pure settlement over what was
 * observed. Nothing is persisted here: the settlement is a value the caller
 * commits, so a Distill Task's trial may be discarded (`settleDistillAttempt`).
 * `restoredAfter` is present exactly when the shell wrote the Task's snapshot
 * back before this observation.
 */
function observeAndSettle(context: SettlementContext, restoredAfter?: NonEmpty<string>): ObservedSettlement {
  const { state, facts } = context;
  const bytes = observeAttemptBytes(context);
  if (!bytes.ok) return { settlement: bytes.settlement, scopeChanged: [] };
  const scopeChanged = bytes.value.attemptScopeChangedPaths;
  const evidence = observeAttemptEvidence(context, bytes.value);
  if (!evidence.ok) return { settlement: evidence.settlement, scopeChanged };
  return {
    scopeChanged,
    settlement: Object.freeze({
      application: settleObservedImplementation(
        state,
        facts.authority,
        facts.observedAt,
        {
          taskCompleted: facts.taskCompleted,
          testResult: facts.testResult,
          testEvidence: facts.testEvidence,
          ...evidence.value,
          ...(restoredAfter === undefined ? {} : { restoredAfter }),
        },
        facts.proofEvaluationPolicy,
        bytes.value,
      ),
    }),
  };
}

/** How many characters of the trial's failure kinds a restore problem names. */
const NAMED_RESTORE_REASON_LIMIT = 400;

/**
 * A restore that did not put the scope back is infrastructure, never a
 * semantic failure: the attempt's edits are unproven AND still on disk. The
 * reason names the snapshot the operator can still read, unless none exists.
 */
function restoreUnavailable(
  { state, facts }: SettlementContext,
  after: NonEmpty<string>,
  problem: string,
  failure?: DistillSnapshotFailure,
): ExactImplementationSettlement {
  const kept = failure?.kind === "no-snapshot" ? "" : `; ${keptDistillSnapshotNote(facts.authority.authorityDigest)}`;
  return unavailable(
    state,
    facts,
    `${facts.transport} distill restore of ${facts.authority.taskId} ${problem}${kept} ` +
      `(restoring after ${after.join(", ").slice(0, NAMED_RESTORE_REASON_LIMIT)})`,
  );
}

/**
 * The settlement of a Distill Task attempt whose trial could not prove its
 * changed bytes: write the snapshot back, observe again, and settle on that
 * observation with `restoredAfter` set. The second settlement may still fail
 * for a reason a restore cannot fix (a write outside the scope); it stands,
 * with the scope restored.
 */
function settleRestoredDistillAttempt(
  context: SettlementContext,
  snapshots: DistillSnapshotPort,
  after: NonEmpty<string>,
): ExactImplementationSettlement {
  const { task, facts, ports } = context;
  const restored = snapshots.restore(
    ports.repository.root,
    facts.authority.authorityDigest,
    distillSnapshotScope(task.attempt_artifact_baseline),
  );
  if (!restored.ok) {
    return restoreUnavailable(context, after, `failed: ${describeDistillSnapshotFailure(restored.error)}`, restored.error);
  }
  const settled = observeAndSettle(context, after);
  return settled.scopeChanged.length === 0
    ? settled.settlement
    : restoreUnavailable(context, after, `left ${settled.scopeChanged.join(", ")} differing from the attempt baseline`);
}

/**
 * A Distill Task attempt (ADR-0068 §5): settle once as a TRIAL, then let the
 * pure `distillRestoreOf` decide. `keep` makes the trial the result. `restore`
 * (the attempt changed its scope and the trial would settle a semantic
 * failure) discards the trial and settles again on the restored bytes.
 */
function settleDistillAttempt(context: SettlementContext, snapshots: DistillSnapshotPort): ExactImplementationSettlement {
  const trial = observeAndSettle(context);
  const decision = distillRestoreOf(trial.scopeChanged, trial.settlement.application);
  switch (decision.kind) {
    case "keep":
      return trial.settlement;
    case "restore":
      return settleRestoredDistillAttempt(context, snapshots, decision.after);
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

/** Shared exact Claude/Pi shell. Transport adapters parse identity/transcripts
 * and render outcomes; this operation alone observes bytes/new tests and calls
 * the Oracle, without relabeling either transport's test provenance.
 *
 * It runs under the caller's State File lock and persists nothing: the caller
 * commits the returned state. For a Distill Task it may write the attempt's
 * snapshot back first (`settleDistillAttempt`); `distillSnapshots` is the
 * store, Git's in production. The caller then calls
 * `releaseSettledDistillSnapshot` once the state is committed. */
export function settleExactImplementation(
  state: TaskGraph,
  facts: ExactImplementationTransportFacts,
  ports: ExactImplementationSettlementPorts,
  distillSnapshots: DistillSnapshotPort = gitDistillSnapshots,
): ExactImplementationSettlement {
  const task = state.tasks.find((candidate) => candidate.id === facts.authority.taskId);
  if (task?.implementation_attempt_history?.some(
    (receipt) => receipt.authorityDigest === facts.authority.authorityDigest,
  )) {
    return unavailable(state, facts, `duplicate ${facts.transport} result delivery`);
  }
  if (task?.active_implementation_attempt?.authorityDigest !== facts.authority.authorityDigest) {
    return unavailable(state, facts, `late ${facts.transport} result delivery`);
  }
  // One answer to "does this Task owe I6" (the frozen Proof, INV-6). A Task
  // with no frozen Proof that its era obligates is refused by name here,
  // never settled as if it owed nothing.
  const duty = redThenGreenDuty(task, state.verification_manifest);
  if (duty.kind === "proof-unfrozen") return refused(state, duty.reason);
  const context: SettlementContext = { state, task, duty, facts, ports };
  return isDistillTask(task) ? settleDistillAttempt(context, distillSnapshots) : observeAndSettle(context).settlement;
}

/**
 * Let go of a settled Distill Task attempt's snapshot. Call it only AFTER the
 * settlement's state is committed to the State File: until then a re-run of
 * the settlement may still need the snapshot. A semantic settlement discards
 * it; an `infrastructure-blocked`, `ignored` or `error` application keeps it
 * (`distillSnapshotRetention`). A snapshot that cannot be discarded is a
 * leftover ref, reported and never a failure of the settlement.
 */
export function releaseSettledDistillSnapshot(
  repositoryRoot: string,
  authority: ImplementationAttemptAuthority,
  application: ImplementationSettlementApplicationResult,
  distillSnapshots: DistillSnapshotPort = gitDistillSnapshots,
): void {
  const task = application.state.tasks.find((candidate) => candidate.id === authority.taskId);
  if (task === undefined || !isDistillTask(task) || distillSnapshotRetention(application) === "keep") return;
  discardDistillSnapshots(repositoryRoot, [authority.authorityDigest], distillSnapshots);
}
