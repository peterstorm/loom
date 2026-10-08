/**
 * One authorized standalone-remediation check, minted through the production
 * path (declared defect-family accounting -> frozen verification manifest ->
 * selected plan -> candidate witness -> check scope -> authorization) so the
 * runner suites exercise the real authority, never a hand-built value.
 *
 * The check's name keys its repair group, check id and remediation run id; the
 * command and its required report path are the suite's own.
 */
import {
  authorizeRemediationChecks,
  createCandidateRepositoryWitness,
  createRemediationCheckScope,
  prepareDefectFamilyAccounting,
  prepareDefectFamilyVerification,
  type AuthorizedRemediationCheck,
} from "../../src/core/defect-family-accounting";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import { VERIFICATION_MANIFEST_KIND, freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { standaloneFixture } from "./standalone-remediation-authority";
import { value } from "./parse-result";

export type RemediationCheckSpec = Readonly<{
  /** Keys `family:<name>`, `project:<name>` and `<runIdPrefix>-<name>`. */
  name: string;
  /** The remediation run id stem, e.g. `run.runner`. */
  runIdPrefix: string;
  /** The required-file report the check writes, also excluded from the candidate witness. */
  reportPath: string;
  args: readonly string[];
  executable?: string;
  timeoutMs?: number;
}>;

const digest = (character: string): string => character.repeat(64);

export function authorizedRemediationCheck(
  root: CanonicalRepositoryRoot,
  { name, runIdPrefix, reportPath, args, executable = "node", timeoutMs = 2_000 }: RemediationCheckSpec,
): AuthorizedRemediationCheck {
  const source = standaloneFixture(["src/main.ts"], true).input.standaloneResult;
  const findingId = source.survivingCriticals[0]!.id;
  const accounting = value(prepareDefectFamilyAccounting(source, {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: `family:${name}` }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: `family:${name}`,
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "The tested behavior regressed." },
      invariant: { provenance: "DECLARED", statement: "The tested behavior remains fixed." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "No siblings declared." },
      checks: [{
        checkId: `project:${name}`,
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: "The check distinguishes the historical defect.",
          reference: null,
        },
      }],
    }],
  }));
  const manifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: VERIFICATION_MANIFEST_KIND,
    checks: [{
      id: `project:${name}`,
      scope: "wave",
      executable,
      args,
      cwd: ".",
      timeoutMs,
      report: { kind: "required-file", path: reportPath },
    }],
  }))));
  const plan = value(prepareDefectFamilyVerification(accounting, manifest));
  if (plan.kind !== "selected-operator-checks") throw new Error("selected remediation plan required");
  const gitWitness = value(parseRepositorySnapshotWitness({
    baseTreeDigest: digest("1"),
    indexDigest: digest("2"),
    worktreeDigest: digest("3"),
  }));
  const candidate = value(createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: root,
    workspaceDigest: digest("4"),
    pathCount: 1,
    observedPaths: ["src/candidate.ts"],
    gitWitness,
    generatedReportExclusions: [reportPath],
  }));
  const scope = value(createRemediationCheckScope(plan.source, candidate, {
    kind: "standalone-remediation",
    remediationRunId: `${runIdPrefix}-${name}`,
    sourceRunId: plan.source.sourceRunId,
    registrationDigest: digest("a"),
    candidateWitnessDigest: candidate.digest,
  }));
  return value(authorizeRemediationChecks(plan, scope))[0];
}
