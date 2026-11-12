/**
 * A completed Standalone Review read as plan design evidence (ADR-0070).
 *
 * Imperative shell: everything is read from the authenticated Run Directory.
 * Whether the evidence is an acceptance is `judgePlanDesignEvidence`
 * (core/plan-design-review); nothing here judges.
 */
import { parseArtifactDigest, parseOrchestrationRunId } from "../../../core/orchestration-contract/identity";
import type { PlanDesignEvidence } from "../../../core/plan-design-review";
import type { StandaloneDispositionPublicationReference } from "../../../core/standalone-review-model";
import { openRegisteredRunDirectory } from "../../../orchestration/run-directory-handle";
import { describeCause } from "../../../utils/describe-cause";
import type { ProgramParse } from "./program-result";
import { parseRegistration } from "./registration";
import { readSelectedStandaloneDisposition } from "./standalone-disposition-source";
import { readAuthenticatedStandaloneLineageSource, readAuthenticatedStandaloneSource } from "./standalone-source";

const bad = (message: string): ProgramParse<never> => ({ ok: false, message });

/** Whether the Run's registration carries the read obligation (ADR-0022). */
function readObligated(runsRoot: string, run: string): ProgramParse<boolean> {
  const opened = openRegisteredRunDirectory(runsRoot, run);
  if (!opened.ok) return bad(opened.error.message);
  const stored = opened.value.readProgramRegistration();
  if (!stored.ok) return bad(stored.error.message);
  const registration = parseRegistration(stored.value);
  if (!registration.ok) return registration;
  return { ok: true, value: registration.value.schemaVersion === 2 && registration.value.readCoverage !== undefined };
}

/**
 * Everything the judgement needs: the published result, the bytes the review
 * froze, and the disposition the caller named. A disposition that does not
 * authenticate against this exact review is an error here, never an absent one.
 */
export async function readPlanDesignEvidence(
  runsRoot: string,
  run: string,
  disposition: StandaloneDispositionPublicationReference | null,
): Promise<ProgramParse<PlanDesignEvidence>> {
  try {
    const done = await readAuthenticatedStandaloneSource(runsRoot, run);
    if (!done.ok) return done;
    const lineage = await readAuthenticatedStandaloneLineageSource(runsRoot, run);
    if (!lineage.ok) return lineage;
    const obligated = readObligated(runsRoot, run);
    if (!obligated.ok) return obligated;
    if (disposition !== null) {
      const selected = readSelectedStandaloneDisposition(lineage.value, disposition);
      if (!selected.ok) return bad(`the named disposition is not a published disposition of this review: ${selected.message}`);
    }
    const runId = parseOrchestrationRunId(lineage.value.publication.runId);
    if (!runId.ok) return bad(runId.error.message);
    const resultDigest = parseArtifactDigest(lineage.value.publication.resultDigest);
    if (!resultDigest.ok) return bad(resultDigest.error.message);
    return { ok: true, value: Object.freeze({
      runId: runId.value,
      resultDigest: resultDigest.value,
      requestedKinds: done.value.authority.reviewMetadata.requestedKinds,
      scope: lineage.value.snapshot.map((file) => ({ path: file.path, sha256: file.kind === "present" ? file.digest : null })),
      reviewers: lineage.value.reviewers,
      readObligated: obligated.value,
      survivingCriticals: done.value.result.survivingCriticals.map(({ id }) => id),
      advisoryCount: done.value.result.advisories.length,
      dispositionPublished: disposition !== null,
    }) };
  } catch (cause) {
    return bad(`the review Run cannot be read: ${describeCause(cause)}`);
  }
}
