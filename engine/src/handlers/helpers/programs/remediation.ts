/**
 * Façade program driver volume (A14): the imperative shell's program drivers
 * were one 2,900-line module; this volume owns ONE program's driver (or, for
 * helpers, the shared recovery/git/scope machinery). The public surface is
 * re-exported by index.ts so all existing import sites are unchanged.
 */
import { parseEffectId, parseVerifiedIndexInstalled, type VerifiedIndexInstalled } from '../../../core/orchestration-contract';
import { parseStandaloneReviewMachineState } from '../../../core/standalone-review-machine';
import { openRunDirectory, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { auditRemediationPaths, parseRepositorySnapshotWitness, prepareLiteralGitPathspec, prepareVerifiedIndexInstallation, reduceRemediation, stageTemporaryIndex, startRemediation, verifyTemporaryIndex, type RemediationAuditError, type RemediationState } from '../../../core/remediation-machine';
import { createTemporaryIndex, digestTemporaryIndex, installVerifiedIndex, observeDirtyPaths, observeStagedPaths, openGitRepository, readStagedPaths, snapshotRepositoryWitness, stageAuditedPaths } from '../../../orchestration/git-remediation';
import { failed, publicationResolver, type FacadeDriveResult, type RegisteredRemediationProgram } from './helpers';

export function remediationBlocked(handle: RunDirHandle, message: string): FacadeDriveResult {
  return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "remediation-blocked", message } } };
}

/**
 * Say which recovery an audit refusal actually has.
 *
 * Only the SHELL knows this, which is why it is said here and not in the audit
 * itself: the authorized set comes from the run's `supportPaths`, and
 * `registerProgram` admits a re-registration only when it is byte-identical, so
 * a path the start input never named can never be authorized by the run that
 * refused it. "Resume after fixing the cause" — the generic recovery every
 * other blocked cause has — is therefore unreachable advice for exactly the
 * case `supportPaths` exists to serve: a plan file or regression pin the
 * remediation itself wrote, outside the frozen review scope. The operator was
 * left to derive the immutability from the handle's source and guess that a
 * fresh run was the intended path.
 *
 * Only the unauthorized-dirty branch gets the extra sentence. The other audit
 * refusals (pre-existing staged work, excluded evidence paths, an expected/
 * actual mismatch) name dirty state that IS removable in place, and telling
 * those to start a fresh run would trade one wrong recovery for another.
 */
export function remediationAuditBlockMessage(error: RemediationAuditError): string {
  return error.unauthorizedDirtyPaths.length === 0
    ? error.message
    : `${error.message} — this run's start input is immutable, so resuming it cannot authorize them: ` +
      "start a FRESH remediation run whose start input registers each path that belongs to the " +
      "remediation as a supportPath (this run stays as blocked evidence), or revert the paths that do not";
}

export function witness(repository: Parameters<typeof snapshotRepositoryWitness>[0]):
  | Readonly<{ ok: true; value: import("../../../core/remediation-machine").RepositorySnapshotWitness }>
  | Readonly<{ ok: false; message: string }> {
  const observed = snapshotRepositoryWitness(repository);
  if (!observed.ok) return { ok: false, message: observed.error.message };
  const parsed = parseRepositorySnapshotWitness(observed.value);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, message: parsed.error.message };
}

/** Persist terminal evidence after the real Git index has already been installed. */
export async function recordInstalledRemediation(
  handle: RunDirHandle,
  state: Extract<RemediationState, { state: "done" }>,
  receipt: VerifiedIndexInstalled,
): Promise<FacadeDriveResult> {
  try {
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, state }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failed(
      `verified index was installed, but remediation checkpoint recording failed: ${detail}; ` +
      `installation receipt: ${JSON.stringify(receipt)}`,
    );
  }
  return { ok: true, action: { kind: "done", runId: handle.runId, outcome: receipt } };
}

export async function startRemediationFacade(
  handle: RunDirHandle,
  input: RegisteredRemediationProgram["input"],
): Promise<FacadeDriveResult> {
  const registration: RegisteredRemediationProgram = Object.freeze({ schemaVersion: 1, kind: "remediation", input });
  const registered = await handle.registerProgram(registration);
  if (!registered.ok) return failed(registered.error.message);
  return driveRemediationFacade(handle, registration);
}

export async function resumeRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgram,
): Promise<FacadeDriveResult> {
  const checkpoint = await handle.readCheckpoint();
  if (checkpoint !== null) {
    let raw: unknown;
    try { raw = JSON.parse(checkpoint); }
    catch { return failed("remediation checkpoint is invalid JSON"); }
    if (typeof raw === "object" && raw !== null) {
      const record = raw as { schemaVersion?: unknown; state?: { state?: unknown; receipt?: unknown } };
      if (record.schemaVersion === 1 && typeof record.state === "object" && record.state !== null && record.state.state === "done") {
        // Parse the stored receipt into its branded type instead of shape-
        // checking fields — a done claim rides on a receipt the contract
        // itself vouches for, or it is not a done claim.
        const receipt = parseVerifiedIndexInstalled(record.state.receipt);
        if (!receipt.ok) {
          return failed(`remediation checkpoint claims done but contains no valid verified-index-installed receipt: ${receipt.error.message}`);
        }
        return { ok: true, action: { kind: "done", runId: handle.runId, outcome: receipt.value } };
      }
    }
  }
  return driveRemediationFacade(handle, registration);
}

export async function driveRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgram,
): Promise<FacadeDriveResult> {
  try {
    const source = openRunDirectory(registration.input.sourceRunsRoot, registration.input.sourceRun);
    // "source run: " is the only thing separating this from the byte-identical
    // failure a malformed `--run` flag produces, and without it the operator
    // re-checks the CLI flag that was never wrong. The sibling source checks
    // below already carry the attribution; this one used to drop it.
    if (!source.ok) return remediationBlocked(handle, `source run: ${source.error.message}`);
    const sourceCheckpoint = await source.value.readCheckpoint();
    if (sourceCheckpoint === null) return remediationBlocked(handle, "source standalone review checkpoint is missing");
    const sourceStateRaw = JSON.parse(sourceCheckpoint) as unknown;
    const sourceState = parseStandaloneReviewMachineState(sourceStateRaw, publicationResolver(source.value));
    if (!sourceState.ok || sourceState.value.kind !== "done") {
      return remediationBlocked(handle, sourceState.ok ? "source standalone review is not done" : sourceState.error.message);
    }
    let started = startRemediation({
      standaloneResult: sourceState.value.result,
      publicationReceipt: sourceState.value.publicationReceipt,
    });
    if (!started.ok) return remediationBlocked(handle, started.error.message);
    let state: RemediationState = started.value;
    for (const path of registration.input.supportPaths) {
      const next = reduceRemediation(state, { kind: "support-path-registered", path });
      if (!next.ok) return remediationBlocked(handle, next.error.message);
      state = next.value;
    }
    const repository = openGitRepository(process.cwd());
    if (!repository.ok) return remediationBlocked(handle, repository.error.message);
    const dirty = observeDirtyPaths(repository.value);
    const preexisting = observeStagedPaths(repository.value);
    const initialWitness = witness(repository.value);
    if (!dirty.ok) return remediationBlocked(handle, dirty.error.message);
    if (!preexisting.ok) return remediationBlocked(handle, preexisting.error.message);
    if (!initialWitness.ok) return remediationBlocked(handle, initialWitness.message);
    const actualPaths = dirty.value.map(({ path }) => path);
    const audited = auditRemediationPaths(state.authority, {
      expectedDirtyPaths: actualPaths,
      actualDirtyPaths: dirty.value,
      preexistingStagedPaths: preexisting.value,
      repositoryWitness: initialWitness.value,
    });
    if (!audited.ok) return remediationBlocked(handle, remediationAuditBlockMessage(audited.error));
    let next = reduceRemediation(state, { kind: "audit-succeeded", audited: audited.value });
    if (!next.ok || next.value.state !== "audited") return remediationBlocked(handle, next.ok ? "audit transition failed" : next.error.message);
    state = next.value;

    const pathspec = prepareLiteralGitPathspec(state.audited);
    if (!pathspec.ok) return remediationBlocked(handle, pathspec.error.message);
    const temporary = createTemporaryIndex(repository.value);
    if (!temporary.ok) return remediationBlocked(handle, temporary.error.message);
    const stagedPaths = stageAuditedPaths(repository.value, temporary.value, pathspec.value);
    if (!stagedPaths.ok) return remediationBlocked(handle, stagedPaths.error.message);
    const indexDigest = digestTemporaryIndex(repository.value, temporary.value);
    const stagingWitness = witness(repository.value);
    if (!indexDigest.ok) return remediationBlocked(handle, indexDigest.error.message);
    if (!stagingWitness.ok) return remediationBlocked(handle, stagingWitness.message);
    const staged = stageTemporaryIndex(state.audited, indexDigest.value, stagingWitness.value);
    if (!staged.ok) return remediationBlocked(handle, staged.error.message);
    next = reduceRemediation(state, { kind: "temporary-index-staged", staged: staged.value });
    if (!next.ok || next.value.state !== "staged-temporary-index") return remediationBlocked(handle, next.ok ? "staging transition failed" : next.error.message);
    state = next.value;

    const observedStaged = readStagedPaths(repository.value, temporary.value);
    const verifiedDigest = digestTemporaryIndex(repository.value, temporary.value);
    const verificationWitness = witness(repository.value);
    if (!observedStaged.ok) return remediationBlocked(handle, observedStaged.error.message);
    if (!verifiedDigest.ok) return remediationBlocked(handle, verifiedDigest.error.message);
    if (!verificationWitness.ok) return remediationBlocked(handle, verificationWitness.message);
    const verified = verifyTemporaryIndex(state.staged, {
      actualTemporaryIndexStagedPaths: observedStaged.value,
      actualIndexDigest: verifiedDigest.value,
      currentRepositoryWitness: verificationWitness.value,
    });
    if (!verified.ok) return remediationBlocked(handle, verified.error.message);
    next = reduceRemediation(state, { kind: "staged-set-verified", verified: verified.value });
    if (!next.ok || next.value.state !== "verified") return remediationBlocked(handle, next.ok ? "verification transition failed" : next.error.message);
    state = next.value;

    const effectId = parseEffectId(`effect:remediation-install:${verified.value.digest}`);
    if (!effectId.ok) return remediationBlocked(handle, effectId.error.message);
    const installation = prepareVerifiedIndexInstallation(verified.value, effectId.value, verificationWitness.value);
    if (!installation.ok) return remediationBlocked(handle, installation.error.message);
    const receipt: VerifiedIndexInstalled = {
      kind: "verified-index-installed",
      effectId: installation.value.intent.effectId,
      runId: installation.value.intent.runId,
      indexDigest: installation.value.intent.indexDigest,
      witnessDigest: installation.value.intent.witnessDigest,
    };
    next = reduceRemediation(state, { kind: "index-installed", installation: installation.value, receipt });
    if (!next.ok || next.value.state !== "done") {
      return remediationBlocked(handle, next.ok ? "installation transition failed" : next.error.message);
    }
    // Prove the terminal state before crossing the irreversible index-install
    // boundary. After this call succeeds, no later error may claim that the
    // repository remained unmodified.
    const installed = installVerifiedIndex(repository.value, temporary.value, verificationWitness.value);
    if (!installed.ok) return remediationBlocked(handle, installed.error.message);
    return recordInstalledRemediation(handle, next.value, receipt);
  } catch (error) {
    return remediationBlocked(handle, error instanceof Error ? error.message : String(error));
  }
}

