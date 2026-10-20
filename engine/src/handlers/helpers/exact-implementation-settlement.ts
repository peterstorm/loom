import type { Task, TaskGraph, TaskTestResult } from "../../types";
import {
  redThenGreenDuty,
  settleObservedImplementation,
  settleUnavailableImplementation,
  type ImplementationSettlementApplicationResult,
  type NewTestEvidence,
  type RedThenGreenDuty,
  type TaskLocalByteObservation,
} from "../../core/implementation-application";
import type {
  ImplementationAttemptAuthority,
  IsoInstant,
} from "../../core/implementation-completion";
import type { ProofEvaluationPolicy } from "../../core/proof-obligations";
import { judgeRedThenGreen } from "../../core/red-then-green";
import type { LedgerObservation, RedThenGreenObservation } from "../../core/red-then-green-types";
import { classifyTaskFiles } from "../../core/test-file-classification";
import { taskVerificationPolicy, type NewTestWaiverReason, type VerificationRequirement } from "../../core/verification-policy";
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

/** Shared exact Claude/Pi shell. Transport adapters parse identity/transcripts
 * and render outcomes; this operation alone observes bytes/new tests and calls
 * the Oracle, without relabeling either transport's test provenance. */
export function settleExactImplementation(
  state: TaskGraph,
  facts: ExactImplementationTransportFacts,
  ports: ExactImplementationSettlementPorts,
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

  let siblingOwnedPaths: readonly string[];
  try {
    siblingOwnedPaths = currentWaveSiblingOwnedPaths(state, task, ports.repository.root);
  } catch (error) {
    return unavailable(
      state,
      facts,
      `${facts.transport} sibling ownership observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    });
  } catch (error) {
    return unavailable(
      state,
      facts,
      `${facts.transport} task-local observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const suiteOutcome = bytes.suite.checks[0]?.outcome;
  if (suiteOutcome?.kind === "observation-unavailable") {
    return unavailable(state, facts, suiteOutcome.reason, bytes);
  }

  const policy = taskVerificationPolicy(task);
  let newTests: NewTestObservationResult<NewTestEvidence>;
  try {
    newTests = ports.newTests.collect({
      filesModified: bytes.cumulativeModifiedPaths,
      requirement: policy.newTests,
      startSha: task.start_sha,
    });
  } catch (error) {
    return unavailable(
      state,
      facts,
      `${facts.transport} new-test observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      bytes,
    );
  }
  if (!newTests.ok) {
    return unavailable(
      state,
      facts,
      `${facts.transport} new-test observation unavailable: ${describeNewTestObservationError(newTests.error)}`,
      bytes,
    );
  }
  const redThenGreen = judgeAttemptRedThenGreen(task, duty, facts, ports.repository.root);
  if (redThenGreen.kind === "unavailable") return unavailable(state, facts, redThenGreen.reason, bytes);

  return Object.freeze({
    application: settleObservedImplementation(
      state,
      facts.authority,
      facts.observedAt,
      {
        taskCompleted: facts.taskCompleted,
        testResult: facts.testResult,
        testEvidence: facts.testEvidence,
        newTests: newTests.value,
        ...(redThenGreen.kind === "judged" ? { redThenGreen: redThenGreen.observation } : {}),
      },
      facts.proofEvaluationPolicy,
      bytes,
    ),
  });
}
