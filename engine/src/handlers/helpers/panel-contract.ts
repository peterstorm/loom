import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler } from "../../types";
import {
  aggregateVerdicts,
  deriveJudgeCriteria,
  parseInterviewDigest,
  parseInterviewDigestJson,
  parseJudgeVerdict,
  parsePanelManifest,
  selectPanelLenses,
  serializeJudgeVerdict,
  serializeRankings,
  type JudgeVerdict,
  type PanelManifest,
} from "../../core/panel-contract";
import {
  ARCHITECTURE_LAYOUT,
  argumentValue,
  artifactError,
  contractError,
  parseRunBoundary,
  readVerdicts,
  realRunDir,
  writeCanonicalOutput,
} from "./panel-run";

const LAYOUT = ARCHITECTURE_LAYOUT;

function artifactErrors(manifest: PanelManifest, runDir: string, includeCandidates: boolean): string[] {
  const resolved = realRunDir(runDir);
  if (!resolved.ok) return [...resolved.errors];
  const root = resolved.value;

  const paths = includeCandidates
    ? [manifest.interviewFile, manifest.interviewJson, ...manifest.candidates.map((candidate) => candidate.path)]
    : [manifest.interviewFile, manifest.interviewJson];

  return paths.flatMap((path) => {
    const expectedParent = path === manifest.interviewFile || path === manifest.interviewJson
      ? root
      : join(root, LAYOUT.itemDir);
    const error = artifactError(path, expectedParent);
    return error ? [error] : [];
  });
}

/**
 * Every operation this helper implements, in the order one run performs them.
 *
 * Exported for the same reason as REVIEW_PANEL_OPERATIONS: the `/loom --panel`
 * runbook must document all of them and drive them in this order, and
 * `tests/runbook-contract.test.ts` binds the prose to this list both ways.
 */
export const PANEL_CONTRACT_OPERATIONS = [
  "interview",
  "manifest",
  "criteria",
  "verdict",
  "aggregate",
] as const;
export type PanelContractOperation = (typeof PANEL_CONTRACT_OPERATIONS)[number];

const USAGE = `Usage: helper panel-contract <${PANEL_CONTRACT_OPERATIONS.join("|")}> [--runs-root <dir> --manifest <file> --designers <N> --criterion <text>]`;

/** Operations that share the run-boundary → manifest → interview prelude —
 *  every one but the `interview` that produces the digest they all read.
 *  Derived, so a new operation cannot leave this set silently stale. */
const RUN_SCOPED: ReadonlySet<string> = new Set(
  PANEL_CONTRACT_OPERATIONS.filter((operation) => operation !== "interview"),
);

/** Validate untrusted panel handoffs at the imperative filesystem boundary. */
const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];

  if (operation === "interview") {
    const parsed = parseInterviewDigest(stdin);
    if (!parsed.ok) return contractError("interview digest", parsed.errors);
    return writeCanonicalOutput(JSON.stringify(parsed.value, null, 2) + "\n");
  }

  if (operation && RUN_SCOPED.has(operation)) {
    const criterion = argumentValue(args, "--criterion");
    const manifestPath = argumentValue(args, "--manifest");
    const runsRoot = argumentValue(args, "--runs-root");
    const rawDesigners = argumentValue(args, "--designers");
    if (!manifestPath || !runsRoot || !rawDesigners || !/^\d+$/.test(rawDesigners) || (operation === "verdict" && !criterion)) {
      return { kind: "error", message: USAGE };
    }
    const designerCount = Number(rawDesigners);

    const boundary = parseRunBoundary(runsRoot, manifestPath);
    if (!boundary.ok) return contractError("panel run boundary", boundary.errors);
    const { runDir } = boundary.value;

    let manifestJson: unknown;
    let interviewJson: unknown;
    try {
      manifestJson = JSON.parse(readFileSync(manifestPath, "utf-8"));
      interviewJson = JSON.parse(readFileSync(join(runDir, LAYOUT.contextJson), "utf-8"));
    } catch (error) {
      return contractError("panel JSON", [
        `cannot read manifest/interview JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const interview = parseInterviewDigestJson(interviewJson);
    if (!interview.ok) return contractError("canonical interview digest", interview.errors);
    const expectedLenses = selectPanelLenses(interview.value, designerCount);
    if (!expectedLenses.ok) return contractError("panel lens selection", expectedLenses.errors);

    const manifest = parsePanelManifest(manifestJson, runDir, LAYOUT, expectedLenses.value);
    if (!manifest.ok) return contractError("panel manifest", manifest.errors);
    const needsCandidates = operation === "verdict" || operation === "aggregate";
    const artifacts = artifactErrors(manifest.value, runDir, needsCandidates);
    if (artifacts.length > 0) return contractError("panel artifacts", artifacts);
    if (operation === "manifest") return { kind: "allow" };

    // The criteria set is DERIVED from the validated digest, not supplied by
    // the caller — the orchestrator and the finalizer can no longer disagree
    // about what the criteria are or what order they are in.
    const criteria = deriveJudgeCriteria(interview.value);
    const candidateFilenames = manifest.value.candidates.map((candidate) => candidate.filename);

    if (operation === "criteria") {
      return writeCanonicalOutput(JSON.stringify(criteria, null, 2) + "\n");
    }

    if (operation === "verdict") {
      if (criterion === null) return contractError("judge verdict", ["criterion is required"]);
      // Reject a criterion that is not one this run's digest derives, so a
      // typo'd or stale --criterion cannot produce a verdict that aggregation
      // will later reject as "unexpected" with no way to tell which step lied.
      if (!criteria.includes(criterion)) {
        return contractError("judge verdict", [
          `criterion must be one of the derived criteria: ${criteria.join(", ")}; received: ${criterion}`,
        ]);
      }
      const verdict = parseJudgeVerdict(stdin, criterion, candidateFilenames);
      if (!verdict.ok) return contractError("judge verdict", verdict.errors);
      return writeCanonicalOutput(serializeJudgeVerdict(verdict.value) + "\n");
    }

    // aggregate — re-read and re-validate every verdict from disk, then rank.
    const resolved = realRunDir(runDir);
    if (!resolved.ok) return contractError("panel aggregate", resolved.errors);

    const verdictsDir = join(resolved.value, LAYOUT.verdictDir);
    const verdicts = readVerdicts(runDir, LAYOUT, verdictsDir, criteria, (raw, expectedCriterion) =>
      parseJudgeVerdict(raw, expectedCriterion, candidateFilenames),
    );
    if (!verdicts.ok) return contractError("panel verdicts", verdicts.errors);

    const ranked = aggregateVerdicts(verdicts.value, criteria, candidateFilenames);
    if (!ranked.ok) return contractError("panel aggregate", ranked.errors);

    return writeCanonicalOutput(serializeRankings(ranked.value, criteria) + "\n");
  }

  return { kind: "error", message: USAGE };
};

export default handler;
