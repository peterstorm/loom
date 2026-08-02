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

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HookHandler, HookResult, TaskGraph } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import type { ParseResult } from "../../core/panel-kernel";
import { applyFindingOutcomes } from "../../core/findings";
import {
  briefCompletenessErrors,
  briefFindingFilename,
  buildFindingBrief,
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
  tallyRefutations,
  REVIEW_LENSES_DEFAULT,
  type FindingBrief,
  type FindingOutcome,
  type WaveFindingId,
} from "../../core/review-panel";
import {
  REVIEW_LAYOUT,
  argumentValue,
  contractError,
  parseRunBoundary,
  parseRunDirectory,
  prepareWriteTargets,
  readVerdicts,
  realRunDir,
  runArtifactErrors,
  writeCanonicalOutput,
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
  "(--run-dir <dir> | --manifest <file>) [--wave N] [--lenses N] [--lens <name>] [--threshold N]";

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

/** brief — engine-authored context artifacts for one wave. */
function operationBrief(runsRoot: string, runDir: string, wave: number): HookResult {
  const boundary = parseRunDirectory(runsRoot, runDir);
  if (!boundary.ok) return contractError("review run boundary", boundary.errors);

  const state = loadGraph();
  if (!state.ok) return contractError("review brief", state.errors);

  // The wave is proven against the graph, not taken on trust. `wave-gate.md`
  // asked the operator to check this with `jq` — but the engine loads the graph
  // two lines up and has everything it needs, and a stale `--wave` produces a
  // fully adjudicable brief whose `tally` then writes `refuted_findings` and can
  // promote a PAST wave's tasks blocked → passed. `checkCriticalFindings` is
  // wave-scoped, so the blast radius is a corrupted audit record rather than an
  // opened gate; that is still not a thing to leave to a prose reminder.
  const current = state.value.current_wave;
  if (current !== undefined && current !== wave) {
    return contractError("review brief", [
      `--wave ${wave} is not the graph's current wave (${current}) — a brief for a closed wave ` +
        `re-adjudicates decisions that are already recorded`,
    ]);
  }

  const brief = buildFindingBrief(wave, state.value.tasks);
  const completeness = briefCompletenessErrors(brief, state.value.tasks);
  if (completeness.length > 0) return contractError("review brief", completeness);

  const briefJson = serializeFindingBrief(brief);

  // Re-parse what we are about to write. A brief that cannot survive its own
  // validator must never reach a verifier — that is how a malformed finding
  // becomes an un-refutable item nobody can vote on.
  const reparsed = parseFindingBriefJson(JSON.parse(briefJson));
  if (!reparsed.ok) return contractError("review brief", reparsed.errors);

  const targets = prepareWriteTargets(
    runDir,
    [LAYOUT.itemDir, LAYOUT.verdictDir],
    [
      LAYOUT.contextMd,
      LAYOUT.contextJson,
      ...brief.findings.map((finding) => join(LAYOUT.itemDir, briefFindingFilename(finding.id))),
    ],
  );
  if (!targets.ok) return contractError("review run boundary", targets.errors);

  try {
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
      writeFileSync(manifestPath, manifestJson + "\n");
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

  const current = loadGraph();
  if (!current.ok) return contractError("review tally", current.errors);
  const replays = replayedOutcomes(tallied.value, refutedIdsOf(current.value.tasks));
  if (replays.length > 0) return contractError("review tally", [replayError(replays)]);

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return contractError("review tally", [`no task graph at ${TASK_GRAPH_PATH}`]);
  try {
    await mgr.update((s) => ({
      ...s,
      tasks: s.tasks.map((task) => applyFindingOutcomes(task, tallied.value)),
    }));
  } catch (error) {
    // `applyFindingOutcomes` throws on a broken findings invariant. Reaching the
    // operator as a contract diagnostic, like every other failure in this
    // helper, beats an unhandled stack trace out of a hook.
    return contractError("review tally", [error instanceof Error ? error.message : String(error)]);
  }

  const refuted = tallied.value.filter((outcome) => !outcome.survives).length;
  process.stderr.write(
    `Refutation panel: ${tallied.value.length - refuted} finding(s) survived, ${refuted} refuted ` +
      `(${manifest.value.lenses.length} lenses, threshold ${threshold})\n`,
  );
  return writeCanonicalOutput(serializeOutcomes(tallied.value, manifest.value.lenses, threshold) + "\n");
};

export default handler;
