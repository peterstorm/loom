import { createHash } from "node:crypto";
import {
  compareCandidateRepositoryWitnesses,
  prepareDefectFamilyAccounting,
  evaluateInstallableDefectFamilyAccounting,
  parseCandidateRepositoryWitness,
  prepareDefectFamilyVerification,
  type CandidateRepositoryWitness,
  type DefectFamilyVerificationPlan,
  type EngineObservedRepairedCheck,
} from "../../../core/defect-family-accounting";
import {
  canonicalStructuralEquals,
  parseEffectId,
  parseVerifiedIndexInstalled,
  type OrchestrationRunId,
  type VerifiedIndexInstalled,
} from "../../../core/orchestration-contract";
import {
  auditRemediationPaths,
  createStandaloneResultPublicationAuthorityResolver,
  parseRemediationState,
  parseRemediationPathSet,
  parseRepositorySnapshotWitness,
  prepareLiteralGitPathspec,
  prepareVerifiedIndexInstallation,
  reduceRemediation,
  stageTemporaryIndex,
  startRemediation,
  verifyTemporaryIndex,
  type RemediationAuditError,
  type RemediationState,
  type RepositorySnapshotWitness,
} from "../../../core/remediation-machine";
import type { StandaloneDoneState } from "../../../core/standalone-review-machine";
import { readAuthenticatedStandaloneSource } from "./standalone-source";
import {
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  VERIFICATION_MANIFEST_SOURCE_PATH,
  type FrozenVerificationManifest,
} from "../../../core/verification-manifest";
import { inspectRepositoryPath } from "../../../utils/repository-path";
import {
  captureRemediationCandidateWorkspace,
  recaptureRemediationCandidateWorkspace,
  type RemediationCandidateCapture,
} from "../../../orchestration/remediation-candidate";
import { runRemediationCheck } from "../../../orchestration/completion-check-runner";
import {
  createTemporaryIndex,
  digestTemporaryIndex,
  discardTemporaryIndex,
  installVerifiedIndex,
  observeDirtyPaths,
  observeStagedPaths,
  openGitRepository,
  readStagedPaths,
  snapshotRepositoryWitness,
  stageAuditedPaths,
  type GitRepository,
} from "../../../orchestration/git-remediation";
import { readRunBytesNoFollow } from "../../../orchestration/no-follow-fs";
import {
  parseRunDirectoryReference,
  type RunDirHandle,
} from "../../../orchestration/run-directory-handle";
import {
  REMEDIATION_EVENT_RESOURCE_POLICY,
  remediationCheckObservedEvent,
  replayRemediationCheckObservedEvent,
} from "./remediation-events";
import {
  createRegisteredRemediationProgramV2,
  type RegisteredRemediationProgram,
  type RegisteredRemediationProgramV2,
  type RemediationStartInputV2,
} from "./remediation-registration";
import type { RemediationInspectionLabel } from "../../../core/run-inspection";
import {
  failed,
  type FacadeBlockedAction,
  type FacadeBlockedDiagnostic,
  type FacadeDoneAction,
  type FacadeDriveResult,
  type RemediationInstalledOutcome,
} from "./program-result";

/** What a remediation drive emits: a defect-family accounting block, or the installed remediation. */
type RemediationFacadeAction =
  | (FacadeBlockedAction & Readonly<{
      diagnostic: Extract<FacadeBlockedDiagnostic, Readonly<{ kind: "defect-family-accounting-blocked" }>>;
    }>)
  | (Extract<FacadeDoneAction, Readonly<{ runId: OrchestrationRunId }>> & Readonly<{ outcome: RemediationInstalledOutcome }>);
type RemediationDriveResult = FacadeDriveResult<RemediationFacadeAction>;

export function remediationBlocked(handle: RunDirHandle, message: string): RemediationDriveResult {
  return {
    ok: true,
    action: {
      kind: "blocked",
      runId: handle.runId,
      diagnostic: { kind: "defect-family-accounting-blocked", message },
    },
  };
}

export function remediationAuditBlockMessage(error: RemediationAuditError): string {
  return error.unauthorizedDirtyPaths.length === 0
    ? error.message
    : `${error.message} — this run's start input is immutable, so resuming it cannot authorize them: ` +
      "start a FRESH remediation run whose start input registers each path that belongs to the " +
      "remediation as a supportPath (this run stays as blocked evidence), or revert the paths that do not";
}

export function witness(repository: GitRepository):
  | Readonly<{ ok: true; value: RepositorySnapshotWitness }>
  | Readonly<{ ok: false; message: string }> {
  const observed = snapshotRepositoryWitness(repository);
  if (!observed.ok) return { ok: false, message: observed.error.message };
  const parsed = parseRepositorySnapshotWitness(observed.value);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, message: parsed.error.message };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function standaloneResultResolver(source: StandaloneDoneState) {
  return createStandaloneResultPublicationAuthorityResolver((lookup) =>
    lookup.runId === source.publicationReceipt.runId && lookup.effectId === source.publicationReceipt.effectId
      ? { ok: true, value: source.publicationReceipt }
      : {
          ok: false,
          error: {
            kind: "standalone-result-publication-authority-unavailable",
            field: "lookup",
            message: "canonical source publication does not match remediation authority",
          },
        });
}

function pathState(
  source: StandaloneDoneState,
  supportPaths: readonly string[],
): Readonly<{ ok: true; state: RemediationState }> | Readonly<{ ok: false; message: string }> {
  const started = startRemediation({
    standaloneResult: source.result,
    publicationReceipt: source.publicationReceipt,
  });
  if (!started.ok) return { ok: false, message: started.error.message };
  let state = started.value;
  for (const path of supportPaths) {
    const next = reduceRemediation(state, { kind: "support-path-registered", path });
    if (!next.ok) return { ok: false, message: next.error.message };
    state = next.value;
  }
  return { ok: true, state };
}

function readFrozenManifest(repository: GitRepository): Readonly<{ ok: true; value: FrozenVerificationManifest }> |
  Readonly<{ ok: false; message: string }> {
  try {
    const inspected = inspectRepositoryPath(
      repository.root,
      VERIFICATION_MANIFEST_SOURCE_PATH,
      "remediation Verification Manifest",
      { mustExist: true },
    );
    const parsed = freezeVerificationManifest(readRunBytesNoFollow(inspected.absolute));
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : { ok: false, message: parsed.error.errors.join("; ") };
  } catch (cause) {
    return { ok: false, message: `cannot read ${VERIFICATION_MANIFEST_SOURCE_PATH}: ${messageOf(cause)}` };
  }
}

export type PreparedRemediationFacadeStart = Readonly<{
  registration: RegisteredRemediationProgramV2;
}>;

export type PrepareRemediationFacadeStartInput = Readonly<{
  input: RemediationStartInputV2;
  repositoryStartPath: string;
  remediationRunsRoot: string;
  remediationRun: string;
}>;

/** Complete all source/manifest/candidate preflight before creating the new Run Directory. */
export async function prepareRemediationFacadeStart(
  request: PrepareRemediationFacadeStartInput,
): Promise<Readonly<{ ok: true; value: PreparedRemediationFacadeStart }> | Readonly<{ ok: false; message: string }>> {
  const runReference = parseRunDirectoryReference(request.remediationRunsRoot, request.remediationRun);
  if (!runReference.ok) return { ok: false, message: runReference.error.message };
  const source = await readAuthenticatedStandaloneSource(request.input.sourceRunsRoot, request.input.sourceRun);
  if (!source.ok) return source;
  const accounting = prepareDefectFamilyAccounting(source.value.result, request.input.defectFamily);
  if (!accounting.ok) return { ok: false, message: accounting.error.failures.map(({ message }) => message).join("; ") };
  const repository = openGitRepository(request.repositoryStartPath);
  if (!repository.ok) return { ok: false, message: repository.error.message };
  const manifest = accounting.value.declaration.kind === "not-required" ? null : readFrozenManifest(repository.value);
  if (manifest !== null && !manifest.ok) return manifest;
  const plan = prepareDefectFamilyVerification(
    accounting.value,
    manifest === null ? null : manifest.value,
  );
  if (!plan.ok) return { ok: false, message: plan.error.failures.map(({ message }) => message).join("; ") };
  if (plan.value.kind === "blocked-declaration") {
    return { ok: false, message: plan.value.failures.map(({ message }) => message).join("; ") };
  }
  const paths = pathState(source.value, request.input.supportPaths);
  if (!paths.ok) return paths;
  const repositoryWitness = witness(repository.value);
  if (!repositoryWitness.ok) return repositoryWitness;
  const candidate = captureRemediationCandidateWorkspace({
    repositoryStartPath: repository.value.root,
    verification: plan.value,
    pathSources: {
      reviewedPaths: paths.state.authority.reviewedScope.paths,
      supportPaths: request.input.supportPaths,
      siblingPaths: accounting.value.siblingPaths,
      inputSourcePaths: [],
    },
    runDirectory: runReference.value.runDirectory,
  }, repositoryWitness.value);
  if (!candidate.ok) return { ok: false, message: candidate.error.message };
  const registration = createRegisteredRemediationProgramV2({
    remediationRunId: runReference.value.runId,
    input: Object.freeze({
      sourceRunsRoot: request.input.sourceRunsRoot,
      sourceRun: request.input.sourceRun,
      supportPaths: request.input.supportPaths,
      defectFamily: accounting.value.declaration,
    }),
    verification: plan.value,
    manifest: manifest === null ? null : manifest.value,
    candidateBaseline: candidate.value.candidateWitness,
  });
  return registration.ok
    ? { ok: true, value: Object.freeze({ registration: registration.value }) }
    : { ok: false, message: registration.error.message };
}

export async function recordInstalledRemediation(
  handle: RunDirHandle,
  state: Extract<RemediationState, { state: "done" }>,
  receipt: VerifiedIndexInstalled,
): Promise<RemediationDriveResult> {
  try {
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 2, state }));
  } catch (cause) {
    return failed(
      `verified index was installed, but remediation checkpoint recording failed: ${messageOf(cause)}; ` +
      `installation receipt: ${JSON.stringify(receipt)}`,
    );
  }
  return {
    ok: true,
    action: {
      kind: "done",
      runId: handle.runId,
      outcome: {
        kind: "remediation-installed",
        installation: receipt,
        defectFamilyAssessment: state.defectFamilyAssessment,
      },
    },
  };
}

export async function startRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgramV2,
): Promise<RemediationDriveResult> {
  if (registration.schemaVersion !== 2 || registration.candidateBaseline.repositoryRoot === handle.runDirectory) {
    return failed("remediation start requires a prepared schema-v2 registration");
  }
  const registered = await handle.registerProgram(registration);
  if (!registered.ok) return failed(registered.error.message);
  return driveRemediationFacade(handle, registration);
}

type RuntimeV2 = Readonly<{
  registration: RegisteredRemediationProgramV2;
  source: StandaloneDoneState;
  plan: Exclude<DefectFamilyVerificationPlan, { kind: "blocked-declaration" }>;
  pathState: RemediationState;
}>;

async function rehydrateV2(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgramV2,
): Promise<Readonly<{ ok: true; value: RuntimeV2 }> | Readonly<{ ok: false; message: string }>> {
  const source = await readAuthenticatedStandaloneSource(registration.input.sourceRunsRoot, registration.input.sourceRun);
  if (!source.ok) return source;
  const accounting = prepareDefectFamilyAccounting(source.value.result, registration.input.defectFamily);
  if (!accounting.ok) return { ok: false, message: accounting.error.failures.map(({ message }) => message).join("; ") };
  let manifest: FrozenVerificationManifest | null = null;
  if (registration.verification.kind === "selected-operator-checks") {
    const parsed = parseFrozenVerificationManifest(registration.verification.manifest);
    if (!parsed.ok) return { ok: false, message: parsed.error.errors.join("; ") };
    manifest = parsed.value;
  }
  const plan = prepareDefectFamilyVerification(accounting.value, manifest);
  if (!plan.ok) return { ok: false, message: plan.error.failures.map(({ message }) => message).join("; ") };
  if (plan.value.kind === "blocked-declaration") return { ok: false, message: "stored declaration is now blocked" };
  const candidate = parseCandidateRepositoryWitness(registration.candidateBaseline);
  if (!candidate.ok) return { ok: false, message: candidate.error.failures.map(({ message }) => message).join("; ") };
  const rebuilt = createRegisteredRemediationProgramV2({
    remediationRunId: handle.runId,
    input: Object.freeze({ ...registration.input, defectFamily: accounting.value.declaration }),
    verification: plan.value,
    manifest,
    candidateBaseline: candidate.value,
  });
  if (!rebuilt.ok || !canonicalStructuralEquals(rebuilt.value, registration)) {
    return { ok: false, message: rebuilt.ok ? "schema-v2 registration does not match canonical source/check/candidate authority" : rebuilt.error.message };
  }
  const paths = pathState(source.value, rebuilt.value.input.supportPaths);
  if (!paths.ok) return paths;
  return { ok: true, value: Object.freeze({
    registration: rebuilt.value,
    source: source.value,
    plan: plan.value,
    pathState: paths.state,
  }) };
}

function currentCandidate(
  repository: GitRepository,
  handle: RunDirHandle,
  baseline: CandidateRepositoryWitness,
): Readonly<{ ok: true; capture: RemediationCandidateCapture; repositoryWitness: RepositorySnapshotWitness }> |
  Readonly<{ ok: false; message: string }> {
  const repositoryWitness = witness(repository);
  if (!repositoryWitness.ok) return repositoryWitness;
  const capture = recaptureRemediationCandidateWorkspace({
    repositoryStartPath: repository.root,
    candidateBaseline: baseline,
    runDirectory: handle.runDirectory,
  }, repositoryWitness.value);
  if (!capture.ok) return { ok: false, message: capture.error.message };
  const unchanged = compareCandidateRepositoryWitnesses(baseline, capture.value.candidateWitness);
  return unchanged.ok
    ? { ok: true, capture: capture.value, repositoryWitness: repositoryWitness.value }
    : { ok: false, message: unchanged.error.failures.map(({ message }) => message).join("; ") };
}

async function existingCheckEvents(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgramV2,
): Promise<Readonly<{ ok: true; byCheck: Map<string, unknown> }> | Readonly<{ ok: false; message: string }>> {
  let events;
  try { events = await handle.readEvents(REMEDIATION_EVENT_RESOURCE_POLICY); }
  catch (cause) { return { ok: false, message: `remediation journal: ${messageOf(cause)}` }; }
  const byCheck = new Map<string, unknown>();
  for (const { event, dedupKey } of events) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return { ok: false, message: "schema-v2 remediation event is malformed" };
    }
    const kind = Object.getOwnPropertyDescriptor(event, "kind")?.value;
    if (kind === "remediation-check-runner-failed") {
      const keys = Object.keys(event).sort();
      const expected = [
        "authorityDigest", "candidateWitnessDigest", "checkId", "kind", "message",
        "registrationDigest", "schemaVersion",
      ].sort();
      const record = event as Record<string, unknown>;
      const authorized = registration.verification.kind === "selected-operator-checks"
        ? registration.verification.checks.find(({ command }) => command.checkId === record.checkId)
        : undefined;
      if (JSON.stringify(keys) !== JSON.stringify(expected) || record.schemaVersion !== 1 ||
          dedupKey !== checkEventDedupKey(registration, String(record.checkId)) ||
          record.registrationDigest !== registration.registrationDigest ||
          record.candidateWitnessDigest !== registration.candidateBaseline.digest ||
          authorized === undefined || record.authorityDigest !== authorized.authorityDigest ||
          typeof record.message !== "string" || record.message.trim() === "") {
        return { ok: false, message: "foreign or malformed remediation runner failure event" };
      }
      if (byCheck.has(record.checkId as string)) return { ok: false, message: `duplicate remediation observation for ${String(record.checkId)}` };
      byCheck.set(record.checkId as string, event);
      continue;
    }
    if (kind !== "remediation-check-observed") return { ok: false, message: `unexpected schema-v2 remediation event kind ${String(kind)}` };
    const checkId = (event as Record<string, unknown>).checkId;
    if (typeof checkId !== "string") return { ok: false, message: "remediation observation has no check id" };
    if (dedupKey !== checkEventDedupKey(registration, checkId)) {
      return { ok: false, message: `remediation observation for ${checkId} has a foreign deduplication key` };
    }
    if (byCheck.has(checkId)) return { ok: false, message: `duplicate remediation observation for ${checkId}` };
    byCheck.set(checkId, event);
  }
  return { ok: true, byCheck };
}

function checkEventDedupKey(registration: RegisteredRemediationProgramV2, checkId: string): string {
  return `check:${createHash("sha256").update(
    `${registration.registrationDigest}:${registration.candidateBaseline.digest}:${checkId}`,
  ).digest("hex")}`;
}

async function appendAndReadRegisteredCheckEvent(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgramV2,
  checkId: string,
  event: unknown,
): Promise<Readonly<{ ok: true; event: unknown }> | Readonly<{ ok: false; message: string }>> {
  try {
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: checkEventDedupKey(registration, checkId),
      recordedAtMs: Date.now(),
      event,
    }, REMEDIATION_EVENT_RESOURCE_POLICY);
  } catch (cause) {
    return { ok: false, message: `remediation journal append: ${messageOf(cause)}` };
  }
  const registered = await existingCheckEvents(handle, registration);
  if (!registered.ok) return registered;
  const durable = registered.byCheck.get(checkId);
  return durable === undefined
    ? { ok: false, message: `registered remediation event is missing for ${checkId}` }
    : { ok: true, event: durable };
}

async function checkObservations(
  handle: RunDirHandle,
  runtime: RuntimeV2,
  repository: GitRepository,
  executeMissing: boolean,
): Promise<Readonly<{ ok: true; observations: readonly EngineObservedRepairedCheck[] }> | Readonly<{ ok: false; message: string }>> {
  const existing = await existingCheckEvents(handle, runtime.registration);
  if (!existing.ok) return existing;
  if (runtime.registration.verification.kind === "not-required") {
    return existing.byCheck.size === 0
      ? { ok: true, observations: Object.freeze([]) }
      : { ok: false, message: "not-required remediation must have no check events" };
  }
  const knownIds: ReadonlySet<string> = new Set(runtime.registration.verification.checks.map(({ command }) => command.checkId));
  const foreign = [...existing.byCheck.keys()].filter((id) => !knownIds.has(id));
  if (foreign.length > 0) return { ok: false, message: `foreign remediation observation(s): ${foreign.join(", ")}` };
  const observations: EngineObservedRepairedCheck[] = [];
  for (const check of runtime.registration.verification.checks) {
    let raw = existing.byCheck.get(check.command.checkId);
    if (raw === undefined) {
      if (!executeMissing) return { ok: false, message: `terminal remediation is missing event for ${check.command.checkId}` };
      const before = currentCandidate(repository, handle, runtime.registration.candidateBaseline);
      if (!before.ok) return before;
      const execution = await runRemediationCheck(check, before.capture.repositoryRoot);
      if (!execution.ok) {
        const message = execution.error.message;
        const registered = await appendAndReadRegisteredCheckEvent(
          handle,
          runtime.registration,
          check.command.checkId,
          Object.freeze({
            kind: "remediation-check-runner-failed",
            schemaVersion: 1,
            registrationDigest: runtime.registration.registrationDigest,
            authorityDigest: check.authorityDigest,
            candidateWitnessDigest: runtime.registration.candidateBaseline.digest,
            checkId: check.command.checkId,
            message,
          }),
        );
        return registered.ok
          ? { ok: false, message }
          : registered;
      }
      const after = currentCandidate(repository, handle, runtime.registration.candidateBaseline);
      const observed = remediationCheckObservedEvent(
        execution.value,
        before.capture.candidateWitness,
        after.ok ? after.capture.candidateWitness : null,
      );
      const registered = await appendAndReadRegisteredCheckEvent(
        handle,
        runtime.registration,
        check.command.checkId,
        observed,
      );
      if (!registered.ok) return registered;
      raw = registered.event;
      if (!after.ok) return after;
    }
    if ((raw as Record<string, unknown>).kind === "remediation-check-runner-failed") {
      return { ok: false, message: String((raw as Record<string, unknown>).message) };
    }
    const replayed = replayRemediationCheckObservedEvent(raw, check, runtime.registration.candidateBaseline);
    if (!replayed.ok) return { ok: false, message: replayed.error.message };
    if (replayed.value.kind === "terminal-failure") return { ok: false, message: replayed.value.message };
    observations.push(replayed.value.observation);
  }
  return { ok: true, observations: Object.freeze(observations) };
}

/** Checkpoint JSON is untrusted. Parse both path arrays BEFORE assessment or
 * event replay; missing or wrong-typed audit facts never become empty arrays. */
function checkpointAuditPaths(raw: unknown) {
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const evidence = field(field(raw, "verified"), "evidence");
  const audited = parseRemediationPathSet(field(field(evidence, "auditedPaths"), "paths"), "checkpoint audit paths");
  const dirty = parseRemediationPathSet(field(field(evidence, "dirtyPaths"), "paths"), "checkpoint audit dirty paths");
  if (!audited.ok || !dirty.ok) return { ok: false as const, message: "remediation checkpoint audit paths are missing or malformed" };
  return { ok: true as const, value: Object.freeze({ auditedInstalledPaths: audited.value.paths, dirtyOrStagedPaths: dirty.value.paths }) };
}

async function completedV2(
  handle: RunDirHandle,
  runtime: RuntimeV2,
  repository: GitRepository,
  checkpoint: string,
): Promise<RemediationDriveResult | null> {
  let raw: unknown;
  try { raw = JSON.parse(checkpoint) as unknown; } catch (cause) { return failed(`remediation checkpoint is invalid JSON: ${messageOf(cause)}`); }
  if (typeof raw !== "object" || raw === null || (raw as Record<string, unknown>).schemaVersion !== 2) return null;
  const stateRaw = (raw as Record<string, unknown>).state;
  if (typeof stateRaw !== "object" || stateRaw === null || (stateRaw as Record<string, unknown>).state !== "done") return null;
  const audit = checkpointAuditPaths(stateRaw);
  if (!audit.ok) return failed(audit.message);
  const observations = await checkObservations(handle, runtime, repository, false);
  if (!observations.ok) return remediationBlocked(handle, observations.message);
  const assessment = evaluateInstallableDefectFamilyAccounting(
    runtime.plan, runtime.registration.candidateBaseline, audit.value, observations.observations,
  );
  if (!assessment.ok) return remediationBlocked(handle, assessment.error.failures.map(({ message }) => message).join("; "));
  const state = parseRemediationState(
    stateRaw,
    standaloneResultResolver(runtime.source),
    assessment.value,
    runtime.registration.candidateBaseline,
  );
  if (!state.ok || state.value.state !== "done") return failed(state.ok ? "schema-v2 terminal checkpoint is not done" : state.error.message);
  return {
    ok: true,
    action: {
      kind: "done",
      runId: handle.runId,
      outcome: {
        kind: "remediation-installed",
        installation: state.value.receipt,
        defectFamilyAssessment: state.value.defectFamilyAssessment,
      },
    },
  };
}

/** Read-only terminal projection: authenticates source, events, assessment, and receipt without executing checks. */
export async function inspectRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgram,
): Promise<Readonly<{ ok: true; label: RemediationInspectionLabel | null }> | Readonly<{ ok: false; message: string }>> {
  if (registration.schemaVersion === 1) {
    const historical = await resumeRemediationFacade(handle, registration);
    if (!historical.ok) return historical;
    const action = historical.action;
    return action.kind === "done"
      ? { ok: true, label: "done — historical P3 assessment unknown" }
      : { ok: false, message: action.diagnostic.message };
  }
  const checkpoint = await handle.readCheckpoint();
  if (checkpoint === null) return { ok: true, label: null };
  const runtime = await rehydrateV2(handle, registration);
  if (!runtime.ok) return runtime;
  const repository = openGitRepository(runtime.value.registration.candidateBaseline.repositoryRoot);
  if (!repository.ok) return { ok: false, message: repository.error.message };
  const completed = await completedV2(handle, runtime.value, repository.value, checkpoint);
  if (completed === null) return { ok: false, message: "schema-v2 remediation checkpoint is not a valid terminal checkpoint" };
  if (!completed.ok) return completed;
  const action = completed.action;
  if (action.kind !== "done") return { ok: false, message: action.diagnostic.message };
  const status = action.outcome.defectFamilyAssessment?.status;
  if (status === "repair-checked") return { ok: true, label: "repair-checked" };
  if (status === "not-required") return { ok: true, label: "repair-check-not-required" };
  return { ok: false, message: "terminal schema-v2 remediation has no authenticated P3 assessment" };
}

export async function resumeRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgram,
): Promise<RemediationDriveResult> {
  if (registration.schemaVersion === 1) {
    const checkpoint = await handle.readCheckpoint();
    if (checkpoint !== null) {
      try {
        const raw = JSON.parse(checkpoint) as { schemaVersion?: unknown; state?: { state?: unknown; receipt?: unknown } };
        if (raw.schemaVersion === 1 && raw.state?.state === "done") {
          const receipt = parseVerifiedIndexInstalled(raw.state.receipt);
          if (!receipt.ok) return failed(`legacy remediation done receipt is invalid: ${receipt.error.message}`);
          return {
            ok: true,
            action: {
              kind: "done",
              runId: handle.runId,
              outcome: {
                kind: "remediation-installed",
                installation: receipt.value,
                defectFamilyAssessment: { status: "historical-unknown", reason: "legacy-remediation-has-no-p3-accounting" },
              },
            },
          };
        }
      } catch (cause) {
        return failed(`remediation checkpoint is invalid JSON for ${handle.runDirectory}: ${messageOf(cause)}`);
      }
    }
    return remediationBlocked(handle, "unfinished schema-v1 remediation cannot install; start a fresh schema-v2 run");
  }
  return driveRemediationFacade(handle, registration);
}

export async function driveRemediationFacade(
  handle: RunDirHandle,
  rawRegistration: RegisteredRemediationProgram,
): Promise<RemediationDriveResult> {
  if (rawRegistration.schemaVersion === 1) {
    return remediationBlocked(handle, "schema-v1 remediation is read-only; start a fresh schema-v2 run");
  }
  const runtime = await rehydrateV2(handle, rawRegistration);
  if (!runtime.ok) return remediationBlocked(handle, runtime.message);
  const repository = openGitRepository(runtime.value.registration.candidateBaseline.repositoryRoot);
  if (!repository.ok) return remediationBlocked(handle, repository.error.message);
  const checkpoint = await handle.readCheckpoint();
  if (checkpoint !== null) {
    const completed = await completedV2(handle, runtime.value, repository.value, checkpoint);
    if (completed !== null) return completed;
    return remediationBlocked(handle, "schema-v2 remediation checkpoint is not a valid terminal checkpoint");
  }

  const immediatelyAfterRegistration = currentCandidate(repository.value, handle, runtime.value.registration.candidateBaseline);
  if (!immediatelyAfterRegistration.ok) return remediationBlocked(handle, immediatelyAfterRegistration.message);
  const observations = await checkObservations(handle, runtime.value, repository.value, true);
  if (!observations.ok) return remediationBlocked(handle, observations.message);
  const beforeAudit = currentCandidate(repository.value, handle, runtime.value.registration.candidateBaseline);
  if (!beforeAudit.ok) return remediationBlocked(handle, beforeAudit.message);
  const dirty = observeDirtyPaths(repository.value);
  const preexisting = observeStagedPaths(repository.value);
  if (!dirty.ok) return remediationBlocked(handle, dirty.error.message);
  if (!preexisting.ok) return remediationBlocked(handle, preexisting.error.message);
  const actualPaths = dirty.value.map(({ path }) => path);
  const audited = auditRemediationPaths(runtime.value.pathState.authority, {
    expectedDirtyPaths: actualPaths,
    actualDirtyPaths: dirty.value,
    preexistingStagedPaths: preexisting.value,
    repositoryWitness: beforeAudit.repositoryWitness,
  });
  if (!audited.ok) return remediationBlocked(handle, remediationAuditBlockMessage(audited.error));
  let next = reduceRemediation(runtime.value.pathState, { kind: "audit-succeeded", audited: audited.value });
  if (!next.ok || next.value.state !== "audited") return remediationBlocked(handle, next.ok ? "audit transition failed" : next.error.message);
  let state: RemediationState = next.value;
  const assessment = evaluateInstallableDefectFamilyAccounting(
    runtime.value.plan,
    runtime.value.registration.candidateBaseline,
    { auditedInstalledPaths: state.audited.paths.paths, dirtyOrStagedPaths: [...new Set([...actualPaths, ...preexisting.value])].sort() },
    observations.observations,
  );
  if (!assessment.ok) return remediationBlocked(handle, assessment.error.failures.map(({ message }) => message).join("; "));

  const beforeStage = currentCandidate(repository.value, handle, runtime.value.registration.candidateBaseline);
  if (!beforeStage.ok) return remediationBlocked(handle, beforeStage.message);
  const pathspec = prepareLiteralGitPathspec(state.audited);
  if (!pathspec.ok) return remediationBlocked(handle, pathspec.error.message);
  const temporary = createTemporaryIndex(repository.value);
  if (!temporary.ok) return remediationBlocked(handle, temporary.error.message);
  let installerOwnsTemporary = false;
  try {
    const stagedPaths = stageAuditedPaths(repository.value, temporary.value, pathspec.value);
    if (!stagedPaths.ok) return remediationBlocked(handle, stagedPaths.error.message);
    const indexDigest = digestTemporaryIndex(repository.value, temporary.value);
    if (!indexDigest.ok) return remediationBlocked(handle, indexDigest.error.message);
    const afterStage = currentCandidate(repository.value, handle, runtime.value.registration.candidateBaseline);
    if (!afterStage.ok) return remediationBlocked(handle, afterStage.message);
    const staged = stageTemporaryIndex(state.audited, indexDigest.value, afterStage.repositoryWitness);
    if (!staged.ok) return remediationBlocked(handle, staged.error.message);
    next = reduceRemediation(state, { kind: "temporary-index-staged", staged: staged.value });
    if (!next.ok || next.value.state !== "staged-temporary-index") return remediationBlocked(handle, next.ok ? "staging transition failed" : next.error.message);
    state = next.value;

    const observedStaged = readStagedPaths(repository.value, temporary.value);
    const verifiedDigest = digestTemporaryIndex(repository.value, temporary.value);
    const afterVerification = currentCandidate(repository.value, handle, runtime.value.registration.candidateBaseline);
    if (!observedStaged.ok) return remediationBlocked(handle, observedStaged.error.message);
    if (!verifiedDigest.ok) return remediationBlocked(handle, verifiedDigest.error.message);
    if (!afterVerification.ok) return remediationBlocked(handle, afterVerification.message);
    const verified = verifyTemporaryIndex(state.staged, {
      actualTemporaryIndexStagedPaths: observedStaged.value,
      actualIndexDigest: verifiedDigest.value,
      currentRepositoryWitness: afterVerification.repositoryWitness,
    });
    if (!verified.ok) return remediationBlocked(handle, verified.error.message);
    next = reduceRemediation(state, { kind: "staged-set-verified", verified: verified.value });
    if (!next.ok || next.value.state !== "verified") return remediationBlocked(handle, next.ok ? "verification transition failed" : next.error.message);
    state = next.value;

    const beforePrepare = currentCandidate(repository.value, handle, runtime.value.registration.candidateBaseline);
    if (!beforePrepare.ok) return remediationBlocked(handle, beforePrepare.message);
    const effectId = parseEffectId(`effect:remediation-install:${verified.value.digest}`);
    if (!effectId.ok) return remediationBlocked(handle, effectId.error.message);
    const installation = prepareVerifiedIndexInstallation(
      verified.value,
      assessment.value,
      effectId.value,
      beforePrepare.repositoryWitness,
      beforePrepare.capture.candidateWitness,
    );
    if (!installation.ok) return remediationBlocked(handle, installation.error.message);
    installerOwnsTemporary = true;
    const installed = installVerifiedIndex(repository.value, temporary.value, installation.value);
    if (!installed.ok) return remediationBlocked(handle, installed.error.message);
    next = reduceRemediation(state, { kind: "index-installed", installation: installation.value, receipt: installed.value });
    if (!next.ok || next.value.state !== "done") return failed(next.ok ? "installation transition failed after the real index was installed" : next.error.message);
    return recordInstalledRemediation(handle, next.value, installed.value);
  } finally {
    if (!installerOwnsTemporary) discardTemporaryIndex(temporary.value);
  }
}
