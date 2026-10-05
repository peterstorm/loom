/**
 * Shared shell boundary results; independent of registration parsers and program drivers.
 *
 * `FacadeAction` is the closed contract between every program driver and the
 * orchestration façade: the ONE external action an invocation emits on stdout.
 * Its four kinds are the façade's whole vocabulary — a driver cannot hand the
 * façade a fifth kind, and the façade's spawn/completion binding publication
 * narrows on `kind` instead of re-probing an untyped record.
 */
import type {
  AgentRequestAuthority,
  ArtifactRef,
  ArtifactSetPublished,
  AwaitUserAction,
  SpawnRequest,
  OrchestrationRunId,
  ProtectedWaveStateCommitted,
  SpawnBatchAction,
  VerifiedIndexInstalled,
} from '../../../core/orchestration-contract';
import type { BlockedAction as PanelBlockedAction, DoneAction as PanelDoneAction } from '../../../core/panel-program';
import type { RemediationState } from '../../../core/remediation-machine';
import type { StandaloneReviewMachineState } from '../../../core/standalone-review';
import type { PublishedStandaloneDisposition } from '../../../core/standalone-review-model';
import type { WaveCompletionSuiteDiagnostic } from '../wave-completion-suite';

export type ProgramParse<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

/** One spawnable request: issued authority, its context packet, and the exact task text the harness executes. */
export type FacadeSpawnRequest = Readonly<{
  authority: AgentRequestAuthority;
  context: SpawnRequest["context"];
  task: string;
}>;

/** A spawn batch re-emitted from durable authority (reissues, retries, pending panel requests). */
export type FacadeSpawnBatch = Readonly<{
  kind: "spawn-batch";
  runId: OrchestrationRunId;
  requests: readonly FacadeSpawnRequest[];
}>;

/** A spawn batch whose initial publication this invocation proved: it also carries the batch publication identity. */
export type FacadePublishedSpawnBatch = Readonly<Omit<SpawnBatchAction, "requests"> & {
  requests: readonly FacadeSpawnRequest[];
}>;

export type FacadeBlockedDiagnostic =
  | Readonly<{ kind: "wave-gate-blocked"; message: string }>
  | Readonly<{ kind: "defect-family-accounting-blocked"; message: string }>
  | WaveCompletionSuiteDiagnostic
  | Extract<StandaloneReviewMachineState, Readonly<{ kind: "terminal-blocked" | "recoverable-blocked" }>>
  | PanelBlockedAction;

export type FacadeBlockedAction = Readonly<{
  kind: "blocked";
  runId: OrchestrationRunId;
  diagnostic: FacadeBlockedDiagnostic;
}>;

export type RemediationInstalledOutcome = Readonly<{
  kind: "remediation-installed";
  installation: VerifiedIndexInstalled;
  defectFamilyAssessment:
    | Extract<RemediationState, Readonly<{ state: "done" }>>["defectFamilyAssessment"]
    | Readonly<{ status: "historical-unknown"; reason: "legacy-remediation-has-no-p3-accounting" }>;
}>;

export type StandaloneDispositionPublishedOutcome = Readonly<{
  kind: "standalone-disposition-published";
  provenance: "DECLARED";
  publication: PublishedStandaloneDisposition["publication"];
  receipt: ArtifactSetPublished;
  record: PublishedStandaloneDisposition["record"];
}>;

export type FacadeDoneAction =
  | Readonly<{
      kind: "done";
      runId: OrchestrationRunId;
      /** Wave Gate completion receipt, standalone result artifact, disposition publication, or remediation installation. */
      outcome: ProtectedWaveStateCommitted | ArtifactRef | StandaloneDispositionPublishedOutcome | RemediationInstalledOutcome;
    }>
  // The legacy panel's terminal step names its panel, not its run.
  | Readonly<{ kind: "done"; panel: PanelDoneAction["panel"]; outcome: PanelDoneAction["outcome"] }>;

export type FacadeAction =
  | FacadeSpawnBatch
  | FacadePublishedSpawnBatch
  | AwaitUserAction
  | FacadeBlockedAction
  | FacadeDoneAction;

/** A driver's result; `A` narrows the actions a driver can emit (default: the whole façade vocabulary). */
export type FacadeDriveResult<A extends FacadeAction = FacadeAction> =
  | Readonly<{ ok: true; action: A }>
  | Readonly<{ ok: false; message: string }>;

export const failed = (message: string): Readonly<{ ok: false; message: string }> => ({ ok: false, message });
