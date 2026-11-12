/**
 * A completed Standalone Review read as plan design evidence (ADR-0070).
 *
 * Imperative shell: everything is read from the Run Directory in one
 * authenticated walk (`readAuthenticatedStandaloneRun`) and parsed here into
 * the types the judgement takes. Whether the evidence is an acceptance is
 * `judgePlanDesignEvidence` (core/plan-design-review); nothing here judges.
 */
import { parseArtifactDigest, parseOrchestrationRunId, type ArtifactDigest } from "../../../core/orchestration-contract/identity";
import type { PlanDesignEvidence } from "../../../core/plan-design-review";
import { parseReviewPath, type ReviewPath } from "../../../core/review-packet";
import type { StandaloneLineageSource } from "../../../core/standalone-review";
import type { StandaloneDispositionPublicationReference } from "../../../core/standalone-review-model";
import { parseStandaloneReviewerRole, type StandaloneReviewerRole } from "../../../core/standalone-review-scope";
import { describeCause } from "../../../utils/describe-cause";
import { failed, type ProgramParse } from "./program-result";
import type { RegisteredStandaloneProgram } from "./registration";
import { readSelectedStandaloneDisposition } from "./standalone-disposition-source";
import { readAuthenticatedStandaloneRun } from "./standalone-source";

/**
 * Whether the Run was registered with the read obligation (ADR-0022). Only a
 * schema-2 registration carrying the read-coverage policy obliges it; a v1
 * Run, a v2 Run without the policy and a successor (v3) Run do not.
 */
export const readObligated = (registration: RegisteredStandaloneProgram): boolean =>
  registration.schemaVersion === 2 && registration.readCoverage !== undefined;

type FrozenPlanScope = PlanDesignEvidence["scope"];

/** The frozen scope as reviewed: each path parsed, with its frozen digest or null when no bytes were frozen. */
function frozenScope(snapshot: StandaloneLineageSource["snapshot"]): ProgramParse<FrozenPlanScope> {
  const scope: Readonly<{ path: ReviewPath; sha256: ArtifactDigest | null }>[] = [];
  for (const file of snapshot) {
    const path = parseReviewPath(file.path, "frozen scope path");
    if (!path.ok) return failed(path.errors.join("; "));
    if (file.kind !== "present") {
      scope.push(Object.freeze({ path: path.value, sha256: null }));
      continue;
    }
    const sha256 = parseArtifactDigest(file.digest);
    if (!sha256.ok) return failed(`frozen digest of ${file.path}: ${sha256.error.message}`);
    scope.push(Object.freeze({ path: path.value, sha256: sha256.value }));
  }
  return { ok: true, value: Object.freeze(scope) };
}

function reviewerRoster(reviewers: readonly string[]): ProgramParse<readonly StandaloneReviewerRole[]> {
  const roles: StandaloneReviewerRole[] = [];
  for (const reviewer of reviewers) {
    const role = parseStandaloneReviewerRole(reviewer);
    if (role === null) return failed(`the review's roster names an unknown reviewer: ${reviewer}`);
    roles.push(role);
  }
  return { ok: true, value: Object.freeze(roles) };
}

/**
 * Everything the judgement needs: the published result, the bytes the review
 * froze, the registration's read obligation, and the disposition the caller
 * named. A disposition that does not authenticate against this exact review is
 * an error here, never an absent one.
 */
export async function readPlanDesignEvidence(
  runsRoot: string,
  run: string,
  disposition: StandaloneDispositionPublicationReference | null,
): Promise<ProgramParse<PlanDesignEvidence>> {
  try {
    const authenticated = await readAuthenticatedStandaloneRun(runsRoot, run);
    if (!authenticated.ok) return authenticated;
    const { done, lineage, registration } = authenticated.value;
    if (disposition !== null) {
      const selected = readSelectedStandaloneDisposition(lineage, disposition);
      if (!selected.ok) return failed(`the named disposition is not a published disposition of this review: ${selected.message}`);
    }
    const runId = parseOrchestrationRunId(lineage.publication.runId);
    if (!runId.ok) return failed(runId.error.message);
    const resultDigest = parseArtifactDigest(lineage.publication.resultDigest);
    if (!resultDigest.ok) return failed(resultDigest.error.message);
    const scope = frozenScope(lineage.snapshot);
    if (!scope.ok) return scope;
    const reviewers = reviewerRoster(lineage.reviewers);
    if (!reviewers.ok) return reviewers;
    return { ok: true, value: Object.freeze({
      runId: runId.value,
      resultDigest: resultDigest.value,
      requestedKinds: done.authority.reviewMetadata.requestedKinds,
      scope: scope.value,
      reviewers: reviewers.value,
      readObligated: readObligated(registration),
      survivingCriticals: done.result.survivingCriticals.map(({ id }) => id),
      advisoryCount: done.result.advisories.length,
      dispositionPublished: disposition !== null,
    }) };
  } catch (cause) {
    return failed(`the review Run cannot be read: ${describeCause(cause)}`);
  }
}
