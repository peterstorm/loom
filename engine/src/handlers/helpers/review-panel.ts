/**
 * The review-panel helper: the wave gate's refutation stage at the filesystem
 * boundary.
 *
 * Mirrors `panel-contract`'s operation set on the shared run shell, so both
 * harnesses get identical enforcement for free — Claude Code and Pi differ only
 * in how they SPAWN the verifiers, never in what is validated.
 *
 *   brief    — read critical findings from wave state or a canonical standalone
 *              aggregate; write brief.md, brief.json, and one artifact per finding.
 *   manifest — write and validate manifest.json, fixing the finding set and the
 *              lens set before any verifier spawns.
 *   lenses   — emit the selected lenses, derived from the validated brief.
 *   verdict  — validate one verifier's raw output; emit canonical JSON.
 *   tally    — re-read every verdict from disk and adjudicate; wave runs publish
 *              a run closure and update task state, while critical-bearing
 *              standalone runs atomically publish outcomes.json and result.json.
 *
 * `brief` and `manifest` are ENGINE-authored here and in the architecture panel.
 * Review findings already exist in wave state or the standalone aggregate, so
 * an orchestrator building this manifest by hand could quietly omit a critical.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { HookHandler, HookResult, TaskGraph } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import type { ParseResult } from "../../core/panel-kernel";
import { applyFindingOutcomes } from "../../core/findings";
import {
  briefCompletenessErrors,
  briefFindingFilename,
  buildFindingBrief,
  buildStandaloneFindingBrief,
  defaultRefutationThreshold,
  manifestLensCount,
  panelSizeConflict,
  parseFindingBriefJson,
  refutedIdsOf,
  replayError,
  replayedOutcomes,
  thresholdError,
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
  staleWaveError,
  tallyRefutations,
  REVIEW_LENSES_DEFAULT,
  type FindingBrief,
  type FindingOutcome,
  type WaveFindingId,
} from "../../core/review-panel";
import {
  finalizeStandaloneReview,
  parseStandalonePanelOutcomes,
  serializeAdjudicatedStandaloneReview,
} from "../../core/standalone-review";
import { loadEvidenceBoundAggregate } from "./standalone-review";
import {
  REVIEW_LAYOUT,
  argumentValue,
  artifactError,
  contractError,
  parseRunBoundary,
  parseRunDirectory,
  prepareWriteTargets,
  pruneSurplusItems,
  readVerdicts,
  realRunDir,
  runArtifactErrors,
  writeCanonicalOutput,
  writeRunFileNoFollow,
} from "./panel-run";

const LAYOUT = REVIEW_LAYOUT;

/**
 * Every operation this helper implements, in the order one run performs them.
 *
 * Exported because it is a CONTRACT, not an implementation detail: the wave-gate
 * runbook has to document all of them and drive them in this order, and
 * `tests/runbook-contract.test.ts` binds the prose to this list in both
 * directions. An operation added here without a runbook step fails that test,
 * which is the drift nothing used to catch.
 */
export const REVIEW_PANEL_OPERATIONS = ["brief", "manifest", "lenses", "verdict", "tally"] as const;
export type ReviewPanelOperation = (typeof REVIEW_PANEL_OPERATIONS)[number];

const USAGE =
  `Usage: helper review-panel <${REVIEW_PANEL_OPERATIONS.join("|")}> --runs-root <dir> ` +
  "(--run-dir <dir> | --manifest <file>) [--wave N | --standalone <aggregate.json>] " +
  "[--lenses N] [--lens <name>] [--threshold N]";

const usageError: HookResult = { kind: "error", message: USAGE };

/** Operations that consult an already-written manifest.json — every one but the
 *  `brief` that creates the run. Derived, so adding an operation cannot leave
 *  this set silently stale. */
const MANIFEST_SCOPED: ReadonlySet<string> = new Set(
  REVIEW_PANEL_OPERATIONS.filter((operation) => operation !== "brief"),
);

function positiveInteger(raw: string | null): number | null {
  return raw !== null && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

/** Load the task graph, failing loudly rather than adjudicating an empty set.
 *  Returns the whole graph, not just `tasks`: `brief` proves its `--wave`
 *  against `current_wave`, which is a sibling field. */
function loadGraph(): ParseResult<TaskGraph> {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { ok: false, errors: [`no task graph at ${TASK_GRAPH_PATH}`] };
  try {
    return { ok: true, value: mgr.load() };
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

/** brief — engine-authored context artifacts for a wave or standalone run. */
function operationBrief(
  runsRoot: string,
  runDir: string,
  source: { readonly kind: "wave"; readonly wave: number } | { readonly kind: "standalone"; readonly path: string },
): HookResult {
  const boundary = parseRunDirectory(runsRoot, runDir);
  if (!boundary.ok) return contractError("review run boundary", boundary.errors);

  let brief: FindingBrief;
  if (source.kind === "wave") {
    const state = loadGraph();
    if (!state.ok) return contractError("review brief", state.errors);
    const stale = staleWaveError(source.wave, state.value.current_wave);
    if (stale !== null) return contractError("review brief", [stale]);
    brief = buildFindingBrief(source.wave, state.value.tasks);
    const completeness = briefCompletenessErrors(brief, state.value.tasks);
    if (completeness.length > 0) return contractError("review brief", completeness);
  } else {
    const expected = resolve(join(runDir, "aggregate.json"));
    if (resolve(source.path) !== expected) {
      return contractError("review brief", [`--standalone must be ${join(runDir, "aggregate.json")}`]);
    }
    const aggregateArtifactError = artifactError(source.path, resolve(runDir));
    if (aggregateArtifactError !== null) return contractError("review brief", [aggregateArtifactError]);
    const aggregate = loadEvidenceBoundAggregate(runDir);
    if (!aggregate.ok) return contractError("review brief", aggregate.errors);
    brief = buildStandaloneFindingBrief(aggregate.value);
    if (brief.findings.length === 0) {
      return contractError("review brief", ["standalone review has no critical findings — skip the refutation panel"]);
    }
  }

  const briefJson = serializeFindingBrief(brief);

  // Re-parse what we are about to write. A brief that cannot survive its own
  // validator must never reach a verifier — that is how a malformed finding
  // becomes an un-refutable item nobody can vote on.
  const reparsed = parseFindingBriefJson(JSON.parse(briefJson));
  if (!reparsed.ok) return contractError("review brief", reparsed.errors);

  const itemFilenames = brief.findings.map((finding) => briefFindingFilename(finding.id));
  const targets = prepareWriteTargets(
    runDir,
    [LAYOUT.itemDir, LAYOUT.verdictDir],
    [
      LAYOUT.contextMd,
      LAYOUT.contextJson,
      ...itemFilenames.map((filename) => join(LAYOUT.itemDir, filename)),
    ],
  );
  if (!targets.ok) return contractError("review run boundary", targets.errors);

  // A re-brief after a refutation names FEWER findings than the last one, and
  // the file for the departed finding used to stay behind — surfacing two steps
  // later as `manifest` failing with "the panel that produced them was larger
  // than the manifest declares", a diagnostic about a resized panel that never
  // happened. The brief owns this directory; it is written whole each time.
  const pruned = pruneSurplusItems(runDir, LAYOUT.itemDir, itemFilenames);
  if (!pruned.ok) return contractError("review run boundary", pruned.errors);

  try {
    writeRunFileNoFollow(join(runDir, LAYOUT.contextMd), renderFindingBriefMarkdown(brief));
    writeRunFileNoFollow(join(runDir, LAYOUT.contextJson), briefJson + "\n");
    for (const finding of brief.findings) {
      writeRunFileNoFollow(
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

/** Narrow state-update port: tests can present a state that changes after preflight. */
export interface ReviewTallyStateUpdater {
  readonly update: (transform: (state: TaskGraph) => TaskGraph) => Promise<void>;
}

/** Apply wave outcomes under the state manager's lock, rechecking replay there. */
export async function applyWaveTallyState(
  updater: ReviewTallyStateUpdater,
  outcomes: readonly FindingOutcome[],
): Promise<void> {
  await updater.update((state) => {
    const raced = replayedOutcomes(outcomes, refutedIdsOf(state.tasks));
    if (raced.length > 0) throw new Error(replayError(raced));
    return { ...state, tasks: state.tasks.map((task) => applyFindingOutcomes(task, outcomes)) };
  });
}

/** Validate untrusted refutation-panel handoffs at the filesystem boundary. */
const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];
  const runsRoot = argumentValue(args, "--runs-root");
  if (!operation || !runsRoot) return usageError;

  if (operation === "brief") {
    const runDir = argumentValue(args, "--run-dir");
    const rawWave = argumentValue(args, "--wave");
    const standalone = argumentValue(args, "--standalone");
    const wave = positiveInteger(rawWave);
    if (!runDir || (rawWave === null) === (standalone === null) || (rawWave !== null && wave === null)) return usageError;
    return operationBrief(
      runsRoot,
      runDir,
      standalone !== null ? { kind: "standalone", path: standalone } : { kind: "wave", wave: wave! },
    );
  }

  if (!MANIFEST_SCOPED.has(operation)) return usageError;

  const rawLensCount = argumentValue(args, "--lenses");
  if (rawLensCount !== null && positiveInteger(rawLensCount) === null) return usageError;

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

  // The manifest is read BEFORE lens selection, not after, because it is what
  // fixes the panel size for this run. `--lenses` chooses that size once, at
  // `manifest`; every later operation recovers it from the file rather than
  // requiring the orchestrator to thread the flag through three more commands.
  // Threading it was the contract, and forgetting it failed the next step with
  // "manifest.lenses must contain exactly 3 lenses" — blaming the manifest for
  // the caller's omission.
  //
  // `manifest` reads the existing file too, and that is load-bearing rather
  // than symmetry. It used to skip the read, so re-running it without
  // `--lenses` rewrote a recorded 5-lens panel to the 3-lens default;
  // `readVerdicts` then iterated only the shrunken lens list, verdict-4 and
  // verdict-5 were silently ignored, the absolute refutation bar fell from 3 to
  // 2, and a finding the full panel had UPHELD came out refuted — promoting the
  // task blocked → passed at exit 0 with nothing on stderr. Re-deriving the
  // lens SET does not catch it: `selectReviewLenses` returns nested prefixes, so
  // a truncated lens list reproduces its own derivation exactly.
  //
  // ENOENT is tolerated only for `manifest`, the operation that CREATES the
  // file; every other operation requires it.
  let manifestRaw: unknown = null;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    if (operation !== "manifest" || !absent) {
      return contractError("review manifest", [
        `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  // The panel size is fixed for the LIFE of the run, not per invocation. The
  // rule itself is `panelSizeConflict` in the core, beside the threshold floor
  // it is the sibling of; this is just where the two integers are read.
  const recordedLensCount = manifestLensCount(manifestRaw);
  const requestedLensCount = rawLensCount === null ? null : positiveInteger(rawLensCount)!;
  const sizeConflict = panelSizeConflict(requestedLensCount, recordedLensCount);
  if (sizeConflict !== null) return contractError("review manifest", [sizeConflict]);
  const lensCount = requestedLensCount ?? recordedLensCount ?? REVIEW_LENSES_DEFAULT;

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
    const target = prepareWriteTargets(runDir, [], ["manifest.json"]);
    if (!target.ok) return contractError("review run boundary", target.errors);
    try {
      writeRunFileNoFollow(manifestPath, manifestJson + "\n");
    } catch (error) {
      return contractError("review manifest", [
        `cannot write ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    try {
      manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      return contractError("review manifest", [
        `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  // Re-read from disk even on the write path — the same discipline `aggregate`
  // applies to verdicts: never trust the step that just ran.
  const manifest = parseReviewManifest(manifestRaw, runDir, LAYOUT, lenses.value, findingIds);
  if (!manifest.ok) return contractError("review manifest", manifest.errors);

  const artifacts = runArtifactErrors(
    runDir,
    LAYOUT,
    [manifest.value.briefFile, manifest.value.briefJson],
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
    const rawLens = argumentValue(args, "--lens");
    if (!rawLens) return usageError;
    // Resolve the flag against this run's selected set rather than merely
    // testing membership: a typo'd or stale --lens cannot then produce a
    // verdict the tally later rejects as "unexpected" with no way to tell which
    // step lied, and the value that reaches the parser is a narrowed ReviewLens
    // rather than an arbitrary string that happened to compare equal.
    const lens = manifest.value.lenses.find((selected) => selected === rawLens);
    if (lens === undefined) {
      return contractError("refutation verdict", [
        `lens must be one of the selected lenses: ${manifest.value.lenses.join(", ")}; received: ${rawLens}`,
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

  const lensesRun = manifest.value.lenses.length;
  const rawThreshold = argumentValue(args, "--threshold");
  const threshold = rawThreshold === null ? defaultRefutationThreshold(lensesRun) : positiveInteger(rawThreshold);
  if (threshold === null) return usageError;
  const belowFloor = thresholdError(threshold, lensesRun);
  if (belowFloor !== null) return contractError("review tally", [belowFloor]);

  const verdicts = readVerdicts(runDir, LAYOUT, verdictsDir, manifest.value.lenses, (raw, lens) =>
    parseRefutationVerdict(raw, lens, findingIds),
  );
  if (!verdicts.ok) return contractError("review verdicts", verdicts.errors);

  // `tallyRefutations` reaches `requireEntry`, which THROWS on a broken coverage
  // invariant rather than defaulting a vote. `panel-run` states the rule this
  // helper follows — "errors are returned, never thrown; a panel helper's
  // failure must reach the operator as a contract diagnostic" — and the throw is
  // unreachable only for as long as the coverage guard inside `tallyRefutations`
  // holds. If it is ever weakened the operator gets a stack trace out of a hook.
  let tallied: ParseResult<readonly FindingOutcome[]>;
  try {
    tallied = tallyRefutations(verdicts.value, manifest.value.lenses, brief.value.findings, threshold);
  } catch (error) {
    return contractError("review tally", [error instanceof Error ? error.message : String(error)]);
  }
  if (!tallied.ok) return contractError("review tally", tallied.errors);

  const outcomesJson = serializeOutcomes(tallied.value, manifest.value.lenses, threshold) + "\n";

  if (brief.value.source === "standalone") {
    const outcomesPath = join(runDir, "outcomes.json");
    const resultPath = join(runDir, "result.json");
    const pendingResultPath = join(runDir, ".result.pending.json");
    if (existsSync(outcomesPath) || existsSync(resultPath) || existsSync(pendingResultPath)) {
      return contractError("review tally", [
        "this standalone run has already been tallied or has an incomplete prior tally — start a new run directory",
      ]);
    }

    const aggregatePath = join(runDir, "aggregate.json");
    const aggregateError = artifactError(aggregatePath, resolve(runDir));
    if (aggregateError !== null) return contractError("review tally", [aggregateError]);
    const aggregate = loadEvidenceBoundAggregate(runDir);
    if (!aggregate.ok) return contractError("review tally", aggregate.errors);
    const criticals = aggregate.value.findings.filter((finding) => finding.severity === "critical");
    const panel = parseStandalonePanelOutcomes(
      JSON.parse(outcomesJson),
      criticals,
      manifest.value.lenses,
    );
    if (!panel.ok) return contractError("review tally", panel.errors);
    const finalized = finalizeStandaloneReview(aggregate.value, panel.value);
    if (!finalized.ok) return contractError("review tally", finalized.errors);
    const resultJson = serializeAdjudicatedStandaloneReview(finalized.value) + "\n";

    const target = prepareWriteTargets(runDir, [], ["outcomes.json", "result.json", ".result.pending.json"]);
    if (!target.ok) return contractError("review run boundary", target.errors);
    try {
      // Stage the result first, claim the replay marker second, and publish the
      // result last. A crash can dead-end the run, never expose a fabricated or
      // partial remediation input as finalized.
      writeFileSync(pendingResultPath, resultJson, { flag: "wx" });
      writeFileSync(outcomesPath, outcomesJson, { flag: "wx" });
      renameSync(pendingResultPath, resultPath);
    } catch (error) {
      try { if (existsSync(pendingResultPath)) unlinkSync(pendingResultPath); } catch { /* preserve original diagnostic */ }
      return contractError("review tally", [
        `cannot publish standalone tally (the run may already be closed): ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  } else {
    const closurePath = join(runDir, "tally-closure.json");
    const outcomesPath = join(runDir, "outcomes.json");
    const pendingOutcomesPath = join(runDir, ".outcomes.pending.json");
    if (existsSync(closurePath) || existsSync(outcomesPath) || existsSync(pendingOutcomesPath)) {
      return contractError("review tally", [
        `this review run has already been tallied or has an incomplete prior tally: ${findingIds.join(", ")}`,
      ]);
    }

    const current = loadGraph();
    if (!current.ok) return contractError("review tally", current.errors);
    // The task graph catches a different run trying to adjudicate findings that
    // have already moved to the audit trail. The run closure below handles the
    // complementary all-upheld case where task state is intentionally unchanged.
    const replays = replayedOutcomes(tallied.value, refutedIdsOf(current.value.tasks));
    if (replays.length > 0) return contractError("review tally", [replayError(replays)]);

    const target = prepareWriteTargets(
      runDir,
      [],
      ["tally-closure.json", "outcomes.json", ".outcomes.pending.json"],
    );
    if (!target.ok) return contractError("review run boundary", target.errors);
    try {
      // Claim the run before state mutation. Even an all-upheld decision changes
      // no task fields, so task state alone cannot prove that this manifest has
      // already been adjudicated. A crash can dead-end this run, never reopen it.
      writeFileSync(closurePath, JSON.stringify({ run_id: basename(runDir), finding_ids: findingIds }, null, 2) + "\n", { flag: "wx" });
      writeFileSync(pendingOutcomesPath, outcomesJson, { flag: "wx" });
      renameSync(pendingOutcomesPath, outcomesPath);
    } catch (error) {
      return contractError("review tally", [
        `cannot publish wave tally closure (the run may already be closed): ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
    if (!mgr) return contractError("review tally", [`no task graph at ${TASK_GRAPH_PATH}`]);
    try {
      await applyWaveTallyState(mgr, tallied.value);
    } catch (error) {
      return contractError("review tally", [
        `wave tally was closed but task state was not updated; start a fresh run: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  const refuted = tallied.value.filter((outcome) => !outcome.survives).length;
  process.stderr.write(
    `Refutation panel: ${tallied.value.length - refuted} finding(s) survived, ${refuted} refuted ` +
      `(${manifest.value.lenses.length} lenses, threshold ${threshold})\n`,
  );
  return writeCanonicalOutput(outcomesJson);
};

export default handler;
