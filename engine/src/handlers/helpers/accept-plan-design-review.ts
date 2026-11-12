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
import { relative, resolve, sep } from "node:path";
import { taskGraphPath } from "../../config";
import { parseArtifactDigest } from "../../core/orchestration-contract/identity";
import {
  ACCEPT_PLAN_DESIGN_REVIEW_HELPER,
  judgePlanDesignEvidence,
  renderPlanDesignRefusal,
  type AcceptedPlanDesignReview,
  type CurrentPlan,
} from "../../core/plan-design-review";
import { standalonePublicationReferenceSchema } from "../../core/standalone-lineage-contract";
import type { StandaloneDispositionPublicationReference } from "../../core/standalone-review-model";
import { planArtifactOf } from "../../core/validate-phase-order";
import { StateManager } from "../../state-manager";
import type { HookHandler, HookResult } from "../../types";
import { describeCause } from "../../utils/describe-cause";
import { realArtifactProbe } from "../pre-tool-use/validate-phase-order";
import { argumentValue } from "./cli-args";
import { readPlanDesignEvidence, type ProgramParse } from "./programs";

const USAGE =
  `Usage: helper ${ACCEPT_PLAN_DESIGN_REVIEW_HELPER} --runs-root <dir> --run <run> ` +
  "[--disposition <absolute Run directory> --disposition-run <id> --disposition-digest <sha256>]";

const refused = (message: string): HookResult => ({ kind: "error", message: `${ACCEPT_PLAN_DESIGN_REVIEW_HELPER}: ${message}` });
const bad = (message: string): ProgramParse<never> => ({ ok: false, message });

type Request = Readonly<{
  runsRoot: string;
  run: string;
  disposition: StandaloneDispositionPublicationReference | null;
}>;

function parseRequest(args: readonly string[]): ProgramParse<Request> {
  const runsRoot = argumentValue(args, "--runs-root");
  const run = argumentValue(args, "--run");
  if (runsRoot === null || run === null) return bad(USAGE);
  const locator = argumentValue(args, "--disposition");
  const runId = argumentValue(args, "--disposition-run");
  const digest = argumentValue(args, "--disposition-digest");
  if (locator === null && runId === null && digest === null) return { ok: true, value: { runsRoot, run, disposition: null } };
  const selected = standalonePublicationReferenceSchema.safeParse({ locator, runId, resultDigest: digest });
  return selected.success
    ? { ok: true, value: { runsRoot, run, disposition: Object.freeze({
        locator: selected.data.locator, runId: selected.data.runId, dispositionDigest: selected.data.resultDigest }) } }
    : bad("a disposition is named by exact --disposition, --disposition-run and --disposition-digest together");
}

/**
 * The plan as a Standalone Review scope names it: relative to the working
 * directory, the root both the review and the phase gate resolve it against.
 */
function currentPlan(plan: string): ProgramParse<CurrentPlan> {
  const path = relative(resolve("."), resolve(plan)).split(sep).join("/");
  try {
    const sha256 = parseArtifactDigest(realArtifactProbe.sha256(plan));
    return sha256.ok ? { ok: true, value: { path, sha256: sha256.value } } : bad(sha256.error.message);
  } catch (cause) {
    return bad(`the plan ${plan} cannot be read: ${describeCause(cause)}`);
  }
}

const handler: HookHandler = async (_stdin, args) => {
  const request = parseRequest(args);
  if (!request.ok) return refused(request.message);

  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return refused(`no task graph at ${statePath}`);
  let planPath: string | null;
  try {
    planPath = planArtifactOf(manager.load(), realArtifactProbe);
  } catch (cause) {
    return refused(`cannot read task graph at ${statePath}: ${describeCause(cause)}`);
  }
  if (planPath === null) return refused("this orchestration has no architecture plan yet; the review follows the architecture phase");
  const plan = currentPlan(planPath);
  if (!plan.ok) return refused(plan.message);

  const evidence = await readPlanDesignEvidence(request.value.runsRoot, request.value.run, request.value.disposition);
  if (!evidence.ok) return refused(evidence.message);
  const judged = judgePlanDesignEvidence(evidence.value, plan.value);
  if (!judged.ok) return refused(renderPlanDesignRefusal(judged.error));
  const accepted: AcceptedPlanDesignReview = judged.value;

  try {
    // The plan this graph names is re-read under the lock: an acceptance is
    // never recorded against a graph that now names another plan.
    const recorded = await manager.updateAndReturn((state) =>
      planArtifactOf(state, realArtifactProbe) === planPath
        ? { state: { ...state, plan_design_review: accepted }, value: true }
        : { state, value: false });
    if (!recorded) return refused("the task graph names a different plan than the one judged; run the helper again");
  } catch (cause) {
    return refused(`failed to write state: ${describeCause(cause)}`);
  }
  process.stderr.write(
    `Plan design review accepted: ${plan.value.path} sha256 ${accepted.planSha256} (run ${accepted.runId})\n`);
  return { kind: "allow" };
};

export default handler;
