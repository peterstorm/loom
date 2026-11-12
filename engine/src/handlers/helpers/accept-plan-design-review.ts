/**
 * Accept a completed `plan-design` Standalone Review as this orchestration's
 * plan design review (ADR-0070), opening the decompose gate for the plan's
 * current bytes.
 *
 * Usage: bun cli.ts helper accept-plan-design-review --runs-root <dir> --run <run>
 *          [--disposition <absolute Run directory> --disposition-run <id> --disposition-digest <sha256>]
 *
 * Imperative shell: it reads the plan's digest, takes the review's evidence
 * from the programs volume and writes the State File. Whether the evidence is
 * an acceptance is `judgePlanDesignEvidence` (core/plan-design-review), which
 * sees nothing the caller typed except which Run and which disposition to read.
 */
import { resolve } from "node:path";
import { taskGraphPath } from "../../config";
import { parseArtifactDigest } from "../../core/orchestration-contract/identity";
import {
  ACCEPT_PLAN_DESIGN_REVIEW_HELPER,
  judgePlanDesignEvidence,
  renderPlanDesignRefusal,
  type AcceptedPlanDesignReview,
  type CurrentPlan,
} from "../../core/plan-design-review";
import { parseRepositoryPath } from "../../core/repository-path";
import { parseReviewPath } from "../../core/review-packet";
import { standalonePublicationReferenceSchema } from "../../core/standalone-lineage-contract";
import type { StandaloneDispositionPublicationReference } from "../../core/standalone-review-model";
import { planArtifactOf, type ArtifactProbe } from "../../core/validate-phase-order";
import { realArtifactProbe } from "../../orchestration/artifact-probe";
import { StateManager } from "../../state-manager";
import type { HookHandler, HookResult, TaskGraph } from "../../types";
import { describeCause } from "../../utils/describe-cause";
import { argumentValue } from "./cli-args";
import { readPlanDesignEvidence, type ProgramParse } from "./programs";
import { failed } from "./programs/program-result";

const USAGE =
  `Usage: helper ${ACCEPT_PLAN_DESIGN_REVIEW_HELPER} --runs-root <dir> --run <run> ` +
  "[--disposition <absolute Run directory> --disposition-run <id> --disposition-digest <sha256>]";

const refused = (message: string): HookResult => ({ kind: "error", message: `${ACCEPT_PLAN_DESIGN_REVIEW_HELPER}: ${message}` });

/** The plan reads this helper needs: whether the named plan exists, and the digest of its bytes. */
export type PlanProbe = Pick<ArtifactProbe, "exists" | "sha256">;

type Request = Readonly<{
  runsRoot: string;
  run: string;
  disposition: StandaloneDispositionPublicationReference | null;
}>;

function parseRequest(args: readonly string[]): ProgramParse<Request> {
  const runsRoot = argumentValue(args, "--runs-root");
  const run = argumentValue(args, "--run");
  if (runsRoot === null || run === null) return failed(USAGE);
  const locator = argumentValue(args, "--disposition");
  const runId = argumentValue(args, "--disposition-run");
  const digest = argumentValue(args, "--disposition-digest");
  if (locator === null && runId === null && digest === null) return { ok: true, value: { runsRoot, run, disposition: null } };
  const selected = standalonePublicationReferenceSchema.safeParse({ locator, runId, resultDigest: digest });
  return selected.success
    ? { ok: true, value: { runsRoot, run, disposition: Object.freeze({
        locator: selected.data.locator, runId: selected.data.runId, dispositionDigest: selected.data.resultDigest }) } }
    : failed("a disposition is named by exact --disposition, --disposition-run and --disposition-digest together");
}

/**
 * The plan as a Standalone Review scope names it: canonical and relative to the
 * working directory, the root both the review and the phase gate resolve it
 * against, through the same path parsers the review's scope passes; and the
 * digest of its bytes now.
 */
function currentPlan(plan: string, probe: PlanProbe): ProgramParse<CurrentPlan> {
  const located = parseRepositoryPath(resolve("."), plan, "plan_file");
  if (!located.ok) return failed(located.errors.join("; "));
  const path = parseReviewPath(located.value.relative, "plan_file");
  if (!path.ok) return failed(path.errors.join("; "));
  try {
    const sha256 = parseArtifactDigest(probe.sha256(plan));
    return sha256.ok ? { ok: true, value: { path: path.value, sha256: sha256.value } } : failed(sha256.error.message);
  } catch (cause) {
    return failed(`the plan ${plan} cannot be read: ${describeCause(cause)}`);
  }
}

/** The architecture plan the State File names, as an existing path. */
function namedPlan(manager: StateManager, statePath: string, probe: PlanProbe): ProgramParse<string> {
  let state: TaskGraph;
  try {
    state = manager.load();
  } catch (cause) {
    return failed(`cannot read task graph at ${statePath}: ${describeCause(cause)}`);
  }
  const plan = planArtifactOf(state, probe);
  return plan === null
    ? failed("this orchestration has no architecture plan yet; the review follows the architecture phase")
    : { ok: true, value: plan };
}

/**
 * What the locked write finds: the graph still names the judged plan, and that
 * plan's bytes now are the bytes judged. Read under the lock, so the stored
 * `planSha256` is the plan's digest at the moment it is written.
 */
function lockedAcceptanceProblem(state: TaskGraph, planPath: string, accepted: AcceptedPlanDesignReview, probe: PlanProbe): string | null {
  if (planArtifactOf(state, probe) !== planPath) return "the task graph names a different plan than the one judged; run the helper again";
  const now = currentPlan(planPath, probe);
  if (!now.ok) return now.message;
  return now.value.sha256 === accepted.planSha256
    ? null
    : `the plan changed while its review was being accepted (judged sha256 ${accepted.planSha256}, now ${now.value.sha256}); ` +
      "run the helper again, and review the plan afresh if its edit is meant to stay";
}

/** The helper over a plan probe: the real filesystem in production, a plain fake in tests. */
export function createAcceptPlanDesignReviewHandler(probe: PlanProbe): HookHandler {
  return async (_stdin, args) => {
    const request = parseRequest(args);
    if (!request.ok) return refused(request.message);

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return refused(`no task graph at ${statePath}`);
    const planPath = namedPlan(manager, statePath, probe);
    if (!planPath.ok) return refused(planPath.message);
    const plan = currentPlan(planPath.value, probe);
    if (!plan.ok) return refused(plan.message);

    const evidence = await readPlanDesignEvidence(request.value.runsRoot, request.value.run, request.value.disposition);
    if (!evidence.ok) return refused(evidence.message);
    const judged = judgePlanDesignEvidence(evidence.value, plan.value);
    if (!judged.ok) return refused(renderPlanDesignRefusal(judged.error));
    const accepted: AcceptedPlanDesignReview = judged.value;

    let problem: string | null;
    try {
      problem = await manager.updateAndReturn((state) => {
        const found = lockedAcceptanceProblem(state, planPath.value, accepted, probe);
        return found === null
          ? { state: { ...state, plan_design_review: accepted }, value: null }
          : { state, value: found };
      });
    } catch (cause) {
      return refused(`failed to write state: ${describeCause(cause)}`);
    }
    if (problem !== null) return refused(problem);
    process.stderr.write(
      `Plan design review accepted: ${plan.value.path} sha256 ${accepted.planSha256} (run ${accepted.runId})\n`);
    return { kind: "allow" };
  };
}

export default createAcceptPlanDesignReviewHandler(realArtifactProbe);
