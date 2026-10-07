import {
  prepareDefectFamilyAccounting,
  evaluateInstallableDefectFamilyAccounting,
  prepareDefectFamilyVerification,
} from "../../src/core/defect-family-accounting";
import {
  auditRemediationPaths,
  parseRepositorySnapshotWitness,
  prepareVerifiedIndexInstallation,
  stageTemporaryIndex,
  startRemediation,
  verifyTemporaryIndex,
  type CurrentVerifiedIndexInstallation,
} from "../../src/core/remediation-machine";
import { captureRemediationCandidateWorkspace } from "../../src/orchestration/remediation-candidate";
import {
  digestTemporaryIndex,
  observeDirtyPaths,
  observeStagedPaths,
  readStagedPaths,
  snapshotRepositoryWitness,
  type GitRepository,
  type TemporaryIndex,
} from "../../src/orchestration/git-remediation";
import { standaloneFixture } from "./standalone-remediation-authority";
import { value } from "./parse-result";

/** Build real opaque P3 installation authority around an already-staged fixture index. */
export function verifiedRemediationInstallation(
  repository: GitRepository,
  temporary: TemporaryIndex,
): CurrentVerifiedIndexInstallation {
  const stagedPaths = value(readStagedPaths(repository, temporary));
  if (stagedPaths.length === 0) throw new Error("fixture installation requires a non-empty staged path set");
  const standalone = standaloneFixture(stagedPaths, false);
  const accounting = value(prepareDefectFamilyAccounting(standalone.input.standaloneResult, { kind: "not-required" }));
  const plan = value(prepareDefectFamilyVerification(accounting, null));
  if (plan.kind !== "not-required") throw new Error("fixture not-required plan required");
  const started = value(startRemediation(standalone.input));
  const dirty = value(observeDirtyPaths(repository));
  const preexisting = value(observeStagedPaths(repository));
  const rawWitness = value(snapshotRepositoryWitness(repository));
  const repositoryWitness = value(parseRepositorySnapshotWitness(rawWitness));
  const actualPaths = dirty.map(({ path }) => path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(stagedPaths)) {
    throw new Error(`fixture dirty paths must equal temporary staged paths: ${actualPaths.join(", ")}`);
  }
  const audited = value(auditRemediationPaths(started.authority, {
    expectedDirtyPaths: actualPaths,
    actualDirtyPaths: dirty,
    preexistingStagedPaths: preexisting,
    repositoryWitness,
  }));
  const candidate = value(captureRemediationCandidateWorkspace({
    repositoryStartPath: repository.root,
    verification: plan,
    pathSources: {
      reviewedPaths: stagedPaths,
      supportPaths: [],
      siblingPaths: [],
      inputSourcePaths: [],
    },
    runDirectory: temporary.directory,
  }, repositoryWitness));
  const stagedDigest = value(digestTemporaryIndex(repository, temporary));
  const staged = value(stageTemporaryIndex(audited, stagedDigest, repositoryWitness));
  const verified = value(verifyTemporaryIndex(staged, {
    actualTemporaryIndexStagedPaths: stagedPaths,
    actualIndexDigest: stagedDigest,
    currentRepositoryWitness: repositoryWitness,
  }));
  const installable = value(evaluateInstallableDefectFamilyAccounting(plan, candidate.candidateWitness, {
    auditedInstalledPaths: audited.paths.paths,
    dirtyOrStagedPaths: actualPaths,
  }, []));
  return value(prepareVerifiedIndexInstallation(
    verified,
    installable,
    `effect:test-install:${verified.digest}`,
    repositoryWitness,
    candidate.candidateWitness,
  ));
}
