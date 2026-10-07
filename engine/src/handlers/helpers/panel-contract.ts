import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import {
  admitJudgeVerdict,
  admitPanelRun,
  parseInterviewDigest,
  parseJudgeVerdict,
  rankPanelVerdicts,
  serializeCriteria,
  type PanelContractResult,
  type PanelManifest,
} from "../../core/panel-contract";
import {
  ARCHITECTURE_LAYOUT,
  argumentValue,
  contractError,
  parseRunBoundary,
  readVerdicts,
  realRunDir,
  runArtifactErrors,
  writeCanonicalOutput,
} from "./panel-run";

const LAYOUT = ARCHITECTURE_LAYOUT;

/** The interview digest always; the candidates only once they should exist —
 *  `manifest` runs before any designer has written one. */
function artifactErrors(manifest: PanelManifest, runDir: string, includeCandidates: boolean): string[] {
  return runArtifactErrors(
    runDir,
    LAYOUT,
    [manifest.interviewFile, manifest.interviewJson],
    includeCandidates ? manifest.candidates.map((candidate) => candidate.path) : [],
  );
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

const USAGE = `Usage: helper panel-contract <${PANEL_CONTRACT_OPERATIONS.join("|")}> [--runs-root <dir> --manifest <file> --designers <N> --criterion <text>]`;

/**
 * One parsed run-scoped invocation — every operation but the `interview` that
 * produces the digest they all read. `--criterion` is part of the `verdict`
 * arm and of no other, so the requirement is stated once, here, and the
 * verdict branch below receives a criterion that cannot be absent.
 */
type RunScopedRequest = Readonly<{
  runsRoot: string;
  manifestPath: string;
  designerCount: number;
  operation:
    | Readonly<{ kind: "manifest" | "criteria" | "aggregate" }>
    | Readonly<{ kind: "verdict"; criterion: string }>;
}>;

function parseRunScopedRequest(args: readonly string[]): RunScopedRequest | null {
  const kind = args[0];
  const manifestPath = argumentValue(args, "--manifest");
  const runsRoot = argumentValue(args, "--runs-root");
  const rawDesigners = argumentValue(args, "--designers");
  if (!manifestPath || !runsRoot || !rawDesigners || !/^\d+$/.test(rawDesigners)) return null;
  const designerCount = Number(rawDesigners);
  if (kind === "verdict") {
    const criterion = argumentValue(args, "--criterion");
    return criterion ? { runsRoot, manifestPath, designerCount, operation: { kind, criterion } } : null;
  }
  return kind === "manifest" || kind === "criteria" || kind === "aggregate"
    ? { runsRoot, manifestPath, designerCount, operation: { kind } }
    : null;
}

/** The shell's one translation of a core refusal into a hook diagnostic. */
function emit(result: PanelContractResult<string>): HookResult {
  return result.ok ? writeCanonicalOutput(result.value + "\n") : contractError(result.failure.contract, result.failure.errors);
}

/**
 * Validate untrusted panel handoffs at the imperative filesystem boundary.
 * The shell reads files and writes output; every rule decidable from the bytes
 * — interview parity, lens selection, manifest binding, criterion membership,
 * aggregation — is a pure `core/panel-contract` function.
 */
const handler: HookHandler = async (stdin, args) => {
  if (args[0] === "interview") {
    const parsed = parseInterviewDigest(stdin);
    if (!parsed.ok) return contractError("interview digest", parsed.errors);
    return writeCanonicalOutput(JSON.stringify(parsed.value, null, 2) + "\n");
  }

  const request = parseRunScopedRequest(args);
  if (request === null) return { kind: "error", message: USAGE };
  const { operation } = request;

  const boundary = parseRunBoundary(request.runsRoot, request.manifestPath);
  if (!boundary.ok) return contractError("panel run boundary", boundary.errors);
  const { runDir } = boundary.value;

  let manifestJson: unknown;
  let interviewJson: unknown;
  let interviewMarkdown: string;
  try {
    manifestJson = JSON.parse(readFileSync(request.manifestPath, "utf-8"));
    interviewJson = JSON.parse(readFileSync(join(runDir, LAYOUT.contextJson), "utf-8"));
    interviewMarkdown = readFileSync(join(runDir, LAYOUT.contextMd), "utf-8");
  } catch (error) {
    return contractError("panel JSON", [
      `cannot read manifest/interview artifacts: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const admitted = admitPanelRun({ manifestJson, interviewJson, interviewMarkdown }, runDir, LAYOUT, request.designerCount);
  if (!admitted.ok) return contractError(admitted.failure.contract, admitted.failure.errors);
  const run = admitted.value;

  const needsCandidates = operation.kind === "verdict" || operation.kind === "aggregate";
  const artifacts = artifactErrors(run.manifest, runDir, needsCandidates);
  if (artifacts.length > 0) return contractError("panel artifacts", artifacts);

  switch (operation.kind) {
    case "manifest":
      return { kind: "allow" };
    case "criteria":
      return writeCanonicalOutput(serializeCriteria(run) + "\n");
    case "verdict":
      return emit(admitJudgeVerdict(run, operation.criterion, stdin));
    case "aggregate": {
      // Re-read and re-validate every verdict from disk, then rank.
      const resolved = realRunDir(runDir);
      if (!resolved.ok) return contractError("panel aggregate", resolved.errors);
      const verdictsDir = join(resolved.value, LAYOUT.verdictDir);
      const verdicts = readVerdicts(runDir, LAYOUT, verdictsDir, run.criteria, (raw, expectedCriterion) =>
        parseJudgeVerdict(raw, expectedCriterion, run.candidates),
      );
      if (!verdicts.ok) return contractError("panel verdicts", verdicts.errors);
      return emit(rankPanelVerdicts(run, verdicts.value));
    }
  }
};

export default handler;
