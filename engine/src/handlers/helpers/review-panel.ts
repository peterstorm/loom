/**
 * The review-panel helper: the wave gate's refutation stage at the filesystem
 * boundary.
 *
 * Mirrors `panel-contract`'s operation set on the shared run shell, so both
 * harnesses get identical enforcement for free — Claude Code and Pi differ only
 * in how they SPAWN the verifiers, never in what is validated.
 *
 *   brief    — read the wave's critical findings from state; write brief.md,
 *              brief.json, and one artifact per finding into the run directory.
 *   manifest — write and validate manifest.json, fixing the finding set and the
 *              lens set before any verifier spawns.
 *   lenses   — emit the selected lenses, derived from the validated brief.
 *   verdict  — validate one verifier's raw output; emit canonical JSON.
 *   tally    — re-read every verdict from disk, adjudicate, write the outcome
 *              back into the task graph, and emit the tally.
 *
 * `brief` and `manifest` are ENGINE-authored, unlike the architecture panel's
 * orchestrator-written manifest: the findings already exist in the task graph,
 * so an orchestrator building this by hand could quietly omit a critical.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HookHandler, HookResult, Task } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import type { ParseResult, VerdictEnvelope } from "../../core/panel-kernel";
import {
  applyFindingOutcomes,
  briefFindingFilename,
  buildFindingBrief,
  defaultRefutationThreshold,
  parseFindingBriefJson,
  parseRefutationVerdict,
  parseReviewManifest,
  renderFindingBriefMarkdown,
  reviewSignals,
  selectReviewLenses,
  serializeBriefFinding,
  serializeFindingBrief,
  serializeOutcomes,
  serializeRefutationVerdict,
  serializeReviewManifest,
  tallyRefutations,
  REVIEW_LENSES_DEFAULT,
  type FindingBrief,
  type RefutationVerdict,
} from "../../core/review-panel";
import {
  REVIEW_LAYOUT,
  argumentValue,
  artifactError,
  contractError,
  parseRunBoundary,
  parseRunDirectory,
  realRunDir,
  verdictPath,
  writeCanonicalOutput,
} from "./panel-run";

const LAYOUT = REVIEW_LAYOUT;

const USAGE =
  "Usage: helper review-panel <brief|manifest|lenses|verdict|tally> --runs-root <dir> " +
  "(--run-dir <dir> | --manifest <file>) [--wave N] [--lenses N] [--lens <name>] [--threshold N]";

const usageError: HookResult = { kind: "error", message: USAGE };

/** Operations that consult an already-written manifest.json. */
const MANIFEST_SCOPED = new Set(["manifest", "lenses", "verdict", "tally"]);

function positiveInteger(raw: string | null): number | null {
  return raw !== null && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

/** Load the task graph, failing loudly rather than adjudicating an empty set. */
function loadTasks(): ParseResult<readonly Task[]> {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { ok: false, errors: [`no task graph at ${TASK_GRAPH_PATH}`] };
  try {
    return { ok: true, value: mgr.load().tasks };
  } catch (error) {
    return {
      ok: false,
      errors: [`cannot read task graph: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** Read back and re-validate the brief a run wrote. */
function loadBrief(runDir: string): ParseResult<FindingBrief> {
  const path = join(runDir, LAYOUT.contextJson);
  try {
    return parseFindingBriefJson(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    return {
      ok: false,
      errors: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** Every run-scoped artifact the manifest names must be a real, contained file. */
function artifactErrors(
  runDir: string,
  briefFile: string,
  briefJson: string,
  findingPaths: readonly string[],
): string[] {
  const resolved = realRunDir(runDir);
  if (!resolved.ok) return [...resolved.errors];
  const root = resolved.value;
  const itemDir = join(root, LAYOUT.itemDir);
  const check = (path: string, parent: string): string[] => {
    const error = artifactError(path, parent);
    return error ? [error] : [];
  };
  return [
    ...check(briefFile, root),
    ...check(briefJson, root),
    ...findingPaths.flatMap((path) => check(path, itemDir)),
  ];
}

/** brief — engine-authored context artifacts for one wave. */
function operationBrief(runsRoot: string, runDir: string, wave: number): HookResult {
  const boundary = parseRunDirectory(runsRoot, runDir);
  if (!boundary.ok) return contractError("review run boundary", boundary.errors);

  const state = loadTasks();
  if (!state.ok) return contractError("review brief", state.errors);

  const brief = buildFindingBrief(wave, state.value);
  const briefJson = serializeFindingBrief(brief);

  // Re-parse what we are about to write. A brief that cannot survive its own
  // validator must never reach a verifier — that is how a malformed finding
  // becomes an un-refutable item nobody can vote on.
  const reparsed = parseFindingBriefJson(JSON.parse(briefJson));
  if (!reparsed.ok) return contractError("review brief", reparsed.errors);

  try {
    mkdirSync(join(runDir, LAYOUT.itemDir), { recursive: true });
    mkdirSync(join(runDir, LAYOUT.verdictDir), { recursive: true });
    writeFileSync(join(runDir, LAYOUT.contextMd), renderFindingBriefMarkdown(brief));
    writeFileSync(join(runDir, LAYOUT.contextJson), briefJson + "\n");
    for (const finding of brief.findings) {
      writeFileSync(
        join(runDir, LAYOUT.itemDir, briefFindingFilename(finding.id)),
        serializeBriefFinding(finding) + "\n",
      );
    }
  } catch (error) {
    return contractError("review brief", [
      `cannot write run artifacts under ${runDir}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  return writeCanonicalOutput(briefJson + "\n");
}

/** Validate untrusted refutation-panel handoffs at the filesystem boundary. */
const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];
  const runsRoot = argumentValue(args, "--runs-root");
  if (!operation || !runsRoot) return usageError;

  if (operation === "brief") {
    const runDir = argumentValue(args, "--run-dir");
    const wave = positiveInteger(argumentValue(args, "--wave"));
    if (!runDir || wave === null) return usageError;
    return operationBrief(runsRoot, runDir, wave);
  }

  if (!MANIFEST_SCOPED.has(operation)) return usageError;

  const rawLensCount = argumentValue(args, "--lenses");
  const lensCount = rawLensCount === null ? REVIEW_LENSES_DEFAULT : positiveInteger(rawLensCount);
  if (lensCount === null) return usageError;

  // `manifest` WRITES the file, so it is the one manifest-scoped operation that
  // cannot require it to exist yet; it validates the run directory instead.
  let runDir: string;
  let manifestPath: string;
  if (operation === "manifest") {
    const runDirArg = argumentValue(args, "--run-dir");
    if (!runDirArg) return usageError;
    const boundary = parseRunDirectory(runsRoot, runDirArg);
    if (!boundary.ok) return contractError("review run boundary", boundary.errors);
    runDir = runDirArg;
    manifestPath = join(runDirArg, "manifest.json");
  } else {
    const manifestArg = argumentValue(args, "--manifest");
    if (!manifestArg) return usageError;
    const boundary = parseRunBoundary(runsRoot, manifestArg);
    if (!boundary.ok) return contractError("review run boundary", boundary.errors);
    runDir = boundary.value.runDir;
    manifestPath = boundary.value.manifestPath;
  }

  const brief = loadBrief(runDir);
  if (!brief.ok) return contractError("review brief", brief.errors);

  // Lenses are DERIVED from the validated brief, not supplied by the caller —
  // the orchestrator and the tally can no longer disagree about the lens set
  // or its order.
  const lenses = selectReviewLenses(reviewSignals(brief.value.findings), lensCount);
  if (!lenses.ok) return contractError("review lens selection", lenses.errors);

  const findingIds = brief.value.findings.map((finding) => finding.id);

  if (operation === "manifest") {
    const manifestJson = serializeReviewManifest(
      basename(runDir),
      runDir,
      LAYOUT,
      lenses.value,
      brief.value.findings,
    );
    try {
      writeFileSync(manifestPath, manifestJson + "\n");
    } catch (error) {
      return contractError("review manifest", [
        `cannot write ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    return contractError("review manifest", [
      `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  // Re-read from disk even on the write path — the same discipline `aggregate`
  // applies to verdicts: never trust the step that just ran.
  const manifest = parseReviewManifest(manifestRaw, runDir, LAYOUT, lenses.value, findingIds);
  if (!manifest.ok) return contractError("review manifest", manifest.errors);

  const artifacts = artifactErrors(
    runDir,
    manifest.value.briefFile,
    manifest.value.briefJson,
    manifest.value.findings.map((finding) => finding.path),
  );
  if (artifacts.length > 0) return contractError("review artifacts", artifacts);

  if (operation === "manifest") {
    return writeCanonicalOutput(JSON.stringify(manifestRaw, null, 2) + "\n");
  }

  if (operation === "lenses") {
    return writeCanonicalOutput(JSON.stringify(manifest.value.lenses, null, 2) + "\n");
  }

  if (operation === "verdict") {
    const lens = argumentValue(args, "--lens");
    if (!lens) return usageError;
    // Reject a lens outside this run's selected set, so a typo'd or stale
    // --lens cannot produce a verdict the tally later rejects as "unexpected"
    // with no way to tell which step lied.
    if (!(manifest.value.lenses as readonly string[]).includes(lens)) {
      return contractError("refutation verdict", [
        `lens must be one of the selected lenses: ${manifest.value.lenses.join(", ")}; received: ${lens}`,
      ]);
    }
    const verdict = parseRefutationVerdict(stdin, lens, findingIds);
    if (!verdict.ok) return contractError("refutation verdict", verdict.errors);
    return writeCanonicalOutput(serializeRefutationVerdict(verdict.value) + "\n");
  }

  // tally — re-read and re-validate every verdict from disk, then adjudicate.
  const resolved = realRunDir(runDir);
  if (!resolved.ok) return contractError("review tally", resolved.errors);
  const verdictsDir = join(resolved.value, LAYOUT.verdictDir);

  const rawThreshold = argumentValue(args, "--threshold");
  const threshold = rawThreshold === null
    ? defaultRefutationThreshold(manifest.value.lenses.length)
    : positiveInteger(rawThreshold);
  if (threshold === null) return usageError;

  const verdicts: VerdictEnvelope<RefutationVerdict>[] = [];
  const verdictErrors: string[] = [];
  for (const [index, lens] of manifest.value.lenses.entries()) {
    const path = verdictPath(runDir, LAYOUT, index);
    const fileError = artifactError(path, verdictsDir);
    if (fileError) {
      verdictErrors.push(fileError);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      verdictErrors.push(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parseRefutationVerdict(raw, lens, findingIds);
    if (!parsed.ok) {
      verdictErrors.push(...parsed.errors.map((error) => `${path}: ${error}`));
      continue;
    }
    verdicts.push(parsed.value);
  }
  if (verdictErrors.length > 0) return contractError("review verdicts", verdictErrors);

  const tallied = tallyRefutations(verdicts, manifest.value.lenses, brief.value.findings, threshold);
  if (!tallied.ok) return contractError("review tally", tallied.errors);

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return contractError("review tally", [`no task graph at ${TASK_GRAPH_PATH}`]);
  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((task) => applyFindingOutcomes(task, tallied.value)),
  }));

  const refuted = tallied.value.filter((outcome) => !outcome.survives).length;
  process.stderr.write(
    `Refutation panel: ${tallied.value.length - refuted} finding(s) survived, ${refuted} refuted ` +
      `(${manifest.value.lenses.length} lenses, threshold ${threshold})\n`,
  );
  return writeCanonicalOutput(serializeOutcomes(tallied.value, manifest.value.lenses, threshold) + "\n");
};

export default handler;
