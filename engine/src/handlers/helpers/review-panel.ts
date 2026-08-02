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
import type { HookHandler, HookResult, Task } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import type { ParseResult } from "../../core/panel-kernel";
import { applyFindingOutcomes } from "../../core/findings";
import {
  briefFindingFilename,
  briefIsEmpty,
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
  type WaveFindingId,
} from "../../core/review-panel";
import {
  REVIEW_LAYOUT,
  argumentValue,
  artifactError,
  contractError,
  parseRunBoundary,
  parseRunDirectory,
  prepareWriteTargets,
  readVerdicts,
  realRunDir,
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

/** The panel size a written manifest records. Null when the file says nothing
 *  usable — `parseReviewManifest` is what rejects it, with a real diagnostic. */
function manifestLensCount(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const lenses = (raw as Record<string, unknown>).lenses;
  return Array.isArray(lenses) && lenses.length > 0 ? lenses.length : null;
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

/**
 * The brief is the panel's whole idea of what exists. If it is short, every
 * later stage still succeeds — an empty item set satisfies every length and
 * coverage rule vacuously — and the run reports "0 survived, 0 refuted", which
 * is indistinguishable from a panel that adjudicated the wave and upheld
 * nothing. So the brief proves its own completeness against the view the wave
 * gate actually counts, and refuses to be built otherwise.
 */
function briefCompletenessErrors(brief: FindingBrief, waveTasks: readonly Task[], wave: number): string[] {
  if (waveTasks.length === 0) {
    return [`no tasks in wave ${wave} — check --wave against .current_wave`];
  }
  const gateCounts = waveTasks.reduce(
    (total, task) => total + (task.critical_findings?.length ?? 0),
    0,
  );
  if (briefIsEmpty(brief)) {
    return gateCounts === 0
      ? [`wave ${wave} has no ${brief.severity} findings — skip the refutation panel, there is nothing to adjudicate`]
      : [completenessMessage(wave, gateCounts, 0)];
  }
  return brief.findings.length < gateCounts
    ? [completenessMessage(wave, gateCounts, brief.findings.length)]
    : [];
}

function completenessMessage(wave: number, gateCounts: number, briefCount: number): string {
  return (
    `wave ${wave} has ${gateCounts} critical_findings but only ${briefCount} carry structured identity — ` +
    `the panel cannot adjudicate the remainder, and a partial brief would report the rest as upheld. ` +
    `Re-run the reviewers so every critical is emitted through the findings block, ` +
    `or repair the graph with: helper validate-task-graph --fix`
  );
}

/** brief — engine-authored context artifacts for one wave. */
function operationBrief(runsRoot: string, runDir: string, wave: number): HookResult {
  const boundary = parseRunDirectory(runsRoot, runDir);
  if (!boundary.ok) return contractError("review run boundary", boundary.errors);

  const state = loadTasks();
  if (!state.ok) return contractError("review brief", state.errors);

  const brief = buildFindingBrief(wave, state.value);
  const completeness = briefCompletenessErrors(
    brief,
    state.value.filter((task) => task.wave === wave),
    wave,
  );
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
  // the caller's omission. The lens SET is still re-derived from the brief and
  // compared, so a tampered manifest is still rejected; only the count is taken
  // from the file, and a count the brief's signals do not reproduce fails that
  // comparison anyway.
  let manifestRaw: unknown = null;
  if (operation !== "manifest") {
    try {
      manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      return contractError("review manifest", [
        `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  const lensCount = rawLensCount !== null
    ? positiveInteger(rawLensCount)!
    : manifestLensCount(manifestRaw) ?? REVIEW_LENSES_DEFAULT;

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

  const rawThreshold = argumentValue(args, "--threshold");
  const threshold = rawThreshold === null
    ? defaultRefutationThreshold(manifest.value.lenses.length)
    : positiveInteger(rawThreshold);
  if (threshold === null) return usageError;

  const verdicts = readVerdicts(runDir, LAYOUT, verdictsDir, manifest.value.lenses, (raw, lens) =>
    parseRefutationVerdict(raw, lens, findingIds),
  );
  if (!verdicts.ok) return contractError("review verdicts", verdicts.errors);

  const tallied = tallyRefutations(verdicts.value, manifest.value.lenses, brief.value.findings, threshold);
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
