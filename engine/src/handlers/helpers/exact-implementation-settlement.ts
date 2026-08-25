import type { TaskGraph, TaskTestResult } from "../../types";
import {
  settleObservedImplementation,
  settleUnavailableImplementation,
  type ImplementationSettlementApplicationResult,
  type NewTestEvidence,
  type TaskLocalByteObservation,
} from "../../core/implementation-application";
import type {
  ImplementationAttemptAuthority,
  IsoInstant,
} from "../../core/implementation-completion";
import type { ProofEvaluationPolicy } from "../../core/proof-obligations";
import { taskVerificationPolicy, type NewTestWaiverReason, type VerificationRequirement } from "../../core/verification-policy";
import {
  collectNewTestEvidence,
  observeTaskLocalCompletion,
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
}>;

export type ExactSettlementRepositoryPort = Readonly<{
  root: string;
  observeTaskLocal: (args: TaskLocalCompletionArgs) => TaskLocalByteObservation;
}>;

export type ExactNewTestCollectionArgs = Readonly<{
  filesModified: readonly string[];
  requirement: boolean | undefined | VerificationRequirement<NewTestWaiverReason>;
  startSha?: string;
}>;

export type ExactSettlementNewTestPort = Readonly<{
  collect: (args: ExactNewTestCollectionArgs) => NewTestEvidence;
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
): ExactImplementationSettlementPorts {
  return Object.freeze({
    repository: Object.freeze({
      root: repositoryRoot,
      observeTaskLocal: observeTaskLocalCompletion,
    }),
    newTests: Object.freeze({
      collect: (args: ExactNewTestCollectionArgs) =>
        collectNewTestEvidence(args.filesModified, args.requirement, args.startSha),
    }),
  });
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

  const bytes = ports.repository.observeTaskLocal({
    repositoryRoot: ports.repository.root,
    task,
    authority: facts.authority,
    parserModifiedPaths: facts.parserModifiedPaths,
    parserPathLabel: facts.parserPathLabel,
  });
  const suiteOutcome = bytes.suite.checks[0]?.outcome;
  if (suiteOutcome?.kind === "observation-unavailable") {
    return unavailable(state, facts, suiteOutcome.reason, bytes);
  }

  const policy = taskVerificationPolicy(task);
  let newTests: NewTestEvidence;
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

  return Object.freeze({
    application: settleObservedImplementation(
      state,
      facts.authority,
      facts.observedAt,
      {
        taskCompleted: facts.taskCompleted,
        testResult: facts.testResult,
        testEvidence: facts.testEvidence,
        newTestsWritten: newTests.written,
        newTestEvidence: newTests.evidence,
      },
      facts.proofEvaluationPolicy,
      bytes,
    ),
  });
}
