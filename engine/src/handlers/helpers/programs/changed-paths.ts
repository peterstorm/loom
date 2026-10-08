/**
 * Changed-path authority for standalone review scope: fixed-argv Git probes
 * (bounded retries on transient empty output, see `observeGitProbe`) that
 * derive the canonical unstaged/staged/committed path sets, the paths this
 * change created, and the added-line count a frozen scope classifies with.
 * Imperative shell — every classification rule lives in core/scope-classification.
 */
import { devNull } from 'node:os';
import {
  describeGitOutcome,
  gitCleanNegative,
  gitStderrText,
  gitStdoutText,
  GIT_PROBE_OUTPUT_LIMIT,
  spawnGit,
  type GitExit,
} from '../../../utils/git-execution-policy';
import { observeGitProbe, type GitProbeObservation, type GitProbeStep } from '../../../utils/git-probe';
import type { StandaloneReviewKind, StandaloneReviewMetadata } from '../../../core/standalone-review-scope';
import { classifyScope, parseNumstatAdditions, reviewablePath } from '../../../core/scope-classification';

/**
 * The caller decision a confirmed-empty Git observation is handed to. The
 * canonical transient rationale lives at `observeGitProbe` (utils/git-probe):
 * the darwin verification campaign observed transient status-0/empty-stdout
 * success for HEAD/root probes, and the bounded retries discharge exactly
 * that. A still-empty answer is never ingested silently into review scope
 * authority — it reaches one of these two explicit decisions:
 *
 * - "refuse" — the output cannot legitimately be empty (a HEAD revision, or
 *   any `--branch` status probe, which always emits branch header lines);
 *   throw loudly with attribution instead of freezing fabricated authority.
 * - "legitimate" — emptiness is a real answer of this probe (a path listing
 *   with no entries, tracked numstat with no content delta); pass the empty
 *   value through after the retry budget was spent.
 */
type GitEmptyDecision = "refuse" | "legitimate";
type CandidateReference = Readonly<{ kind: "missing" }> | Readonly<{ kind: "present"; revision: string }>;
type MergeBaseCandidate = Readonly<{ kind: "no-base" }> | Readonly<{ kind: "base"; revision: string }>;

/** stdout budgets: a scope path listing or text answer, and one baseline blob.
 *  Every other probe answers a ref, a base, a numstat row or one `ls-tree`
 *  entry and keeps `GIT_PROBE_OUTPUT_LIMIT`. */
const SCOPE_LISTING_LIMIT = 16 * 1024 * 1024;
const BASELINE_BLOB_LIMIT = 64 * 1024 * 1024;

/** Shared refusal for a Git exit the probe's protocol does not accept: Git's
 *  own diagnostic when it wrote one, otherwise the caller's exact fallback
 *  label with the rendered exit, so a silent failure still names its status. */
function exitRefusal(exit: GitExit, fallback: string): Readonly<{ ok: false; error: Error }> {
  const diagnostic = gitStderrText(exit);
  return { ok: false as const, error: new Error(diagnostic || `${fallback} (${describeGitOutcome(exit)})`) };
}

/** Fatal UTF-8 decode of one NUL-delimited Git path listing: a chunk whose
 *  bytes are not valid UTF-8 refuses with attribution instead of entering
 *  scope authority as a U+FFFD-mangled path that can never match the real
 *  worktree file (the same contract workspace-digest parseListedPaths
 *  enforces for its listings). Bytes travel through a latin1 round-trip so
 *  the NUL separators split on byte boundaries before any decoding. */
function decodeListedPaths(stdout: Buffer): GitProbeStep<readonly string[], Error> {
  const chunks = stdout.toString("binary").split("\0");
  const decoded: string[] = [];
  for (const [index, binary] of chunks.entries()) {
    if (binary === "") continue;
    try {
      decoded.push(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(binary, "binary")));
    } catch (cause) {
      return { ok: false as const, error: new Error(`git path ${index} is not UTF-8: ${cause instanceof Error ? cause.message : String(cause)}`) };
    }
  }
  return { ok: true as const, value: Object.freeze(decoded.sort()) };
}

/** The one scope-authority refusal for a confirmed-empty Git observation,
 *  stated once so every scope probe's attribution stays byte-identical and
 *  cannot drift apart under lockstep edits. */
function scopeEmptyRefusal(subject: string): Error {
  return new Error(`git ${subject} returned empty output after bounded retries; review scope authority cannot be fabricated from an empty observation`);
}

type ConfirmedEmptyObservation<T> = Extract<GitProbeObservation<T, Error>, { kind: "confirmed-empty" }>;

/** One shared post-observation resolution for the module's Git probes: a
 *  failed observation throws with the probe's own attribution, a confirmed
 *  empty reaches the caller's explicit per-site decision, and an observed
 *  value passes through. The transient-empty rationale lives at
 *  `observeGitProbe`; this helper only states the shared resolution tail
 *  once — each call site keeps its true per-site policy (empty decision,
 *  value decode) visible as parameters. */
function resolveObservation<T, R>(
  observed: GitProbeObservation<T, Error>,
  confirmedEmpty: (observation: ConfirmedEmptyObservation<T>) => R,
  observedValue: (value: T) => R,
): R {
  if (observed.kind === "failed") throw observed.error;
  if (observed.kind === "confirmed-empty") return confirmedEmpty(observed);
  return observedValue(observed.value);
}

/** One file-local shape for the module's eight spawn→probe wraps
 *  (gitPaths, gitText, candidateReference, candidateMergeBase,
 *  trackedAdditions, untrackedAdditions, and baselineBlob's two): the adapter states the shared
 *  spawn-failure refusal once, and each call site passes only its own output
 *  budget, value decode, and refusal labels — the real per-site differences
 *  (the no-index probe's status-1 acceptance, message labels) stay visible as
 *  parameters instead of a diff across eight near-identical blocks. Every
 *  probe runs under the shared `git-execution-policy`, so review scope is
 *  derived under the same ignore rules and config as every other observer.
 *  Only an `exited` outcome reaches `classify`; a child that never started,
 *  timed out, outgrew its budget or was signalled refuses here with its
 *  rendered outcome. */
function gitSpawnProbe<T>(
  args: readonly string[],
  maxBuffer: number,
  classify: (exit: GitExit) => GitProbeStep<T, Error>,
): () => GitProbeStep<T, Error> {
  return () => {
    const outcome = spawnGit(args, { maxBuffer });
    if (outcome.kind !== "exited") {
      return { ok: false as const, error: new Error(`git ${args[0]} ${describeGitOutcome(outcome)}`) };
    }
    return classify(outcome);
  };
}

function gitPaths(args: readonly string[], empty: GitEmptyDecision): readonly string[] {
  const frozenPaths = (paths: readonly string[]): readonly string[] => Object.freeze([...paths]);
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe(args, SCOPE_LISTING_LIMIT, (exit) =>
        exit.status !== 0
          ? exitRefusal(exit, `git ${args[0]} failed`)
          : decodeListedPaths(exit.stdout)),
      (paths) => paths.length === 0,
    ),
    (confirmed) => {
      if (empty === "refuse") throw scopeEmptyRefusal(args.join(" "));
      return frozenPaths(confirmed.third);
    },
    frozenPaths,
  );
}

/**
 * One fixed-argv Git probe for text authority, retried twice on status-0
 * empty stdout. The `empty` argument is the caller's confirmed-empty decision
 * (see `GitEmptyDecision`) and is required at every call site so the policy
 * for text authority is visible where the value is consumed, never defaulted.
 */
export function gitText(args: readonly string[], empty: GitEmptyDecision): string {
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe(args, SCOPE_LISTING_LIMIT, (exit) =>
        exit.status !== 0
          ? exitRefusal(exit, `git ${args[0]} failed`)
          : { ok: true as const, value: gitStdoutText(exit).trim() }),
      (value) => value === "",
    ),
    (confirmed) => {
      if (empty === "refuse") throw scopeEmptyRefusal(args.join(" "));
      return confirmed.third;
    },
    (value) => value,
  );
}

export type CanonicalChangedPaths = Readonly<{
  /** Tracked files whose worktree content differs from the index, plus untracked non-ignored files. */
  unstaged: readonly string[];
  staged: readonly string[];
  committed: readonly string[];
  base_revision: string | null;
  head_revision: string;
}>;

export type DerivedChangedPaths = Readonly<{
  authority: CanonicalChangedPaths;
  /** Kept separately so diff statistics can add new files exactly once. */
  untracked: readonly string[];
  /**
   * Paths that did not exist before this change: untracked files plus files
   * added (not modified) in the index or on the branch since the base
   * revision. This is what makes `newStructure` mean "new", not "deep".
   */
  created: ReadonlySet<string>;
}>;

function candidateReference(candidate: string): CandidateReference {
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe<CandidateReference>(["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`],
        GIT_PROBE_OUTPUT_LIMIT, (exit) => {
          if (gitCleanNegative(exit)) return { ok: true, value: { kind: "missing" } };
          if (exit.status !== 0) return exitRefusal(exit, `git cannot observe candidate ${candidate}`);
          return { ok: true, value: { kind: "present", revision: gitStdoutText(exit).trim() } };
        }),
      (value) => value.kind === "present" && value.revision === "",
    ),
    () => { throw scopeEmptyRefusal(`candidate ${candidate}`); },
    (value) => value,
  );
}

function candidateMergeBase(candidate: string, head: string): MergeBaseCandidate {
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe<MergeBaseCandidate>(["merge-base", candidate, head], GIT_PROBE_OUTPUT_LIMIT, (exit) => {
        if (gitCleanNegative(exit)) return { ok: true, value: { kind: "no-base" } };
        if (exit.status !== 0) return exitRefusal(exit, `git merge-base failed for ${candidate}`);
        return { ok: true, value: { kind: "base", revision: gitStdoutText(exit).trim() } };
      }),
      (value) => value.kind === "base" && value.revision === "",
    ),
    () => { throw scopeEmptyRefusal(`merge-base ${candidate} ${head}`); },
    (value) => value,
  );
}

export function deriveChangedPaths(): DerivedChangedPaths {
  // A HEAD revision can never legitimately be empty: a confirmed-empty answer
  // after the bounded retry refuses instead of freezing `head_revision: ""`.
  const head = gitText(["rev-parse", "HEAD"], "refuse");
  let base: string | null = null;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    // A missing ref is distinct from an error: real temporary repositories
    // often have no origin/main, and merge-base reports that absence as 128.
    if (candidateReference(candidate).kind === "missing") continue;
    const observed = candidateMergeBase(candidate, head);
    if (observed.kind === "no-base") continue;
    base = observed.revision;
    break;
  }
  const untracked = gitPaths(["ls-files", "--others", "--exclude-standard", "-z", "--"], "legitimate").filter(reviewablePath);
  const trackedUnstaged = gitPaths(["diff", "--name-only", "-z", "--"], "legitimate").filter(reviewablePath);
  const stagedAdded = gitPaths(["diff", "--cached", "--name-only", "--diff-filter=A", "-z", "--"], "legitimate").filter(reviewablePath);
  const committedAdded = base === null
    ? []
    : gitPaths(["diff", "--name-only", "--diff-filter=A", "-z", `${base}...${head}`, "--"], "legitimate").filter(reviewablePath);
  return Object.freeze({
    authority: Object.freeze({
      unstaged: Object.freeze([...new Set([...trackedUnstaged, ...untracked])].sort()),
      staged: gitPaths(["diff", "--cached", "--name-only", "-z", "--"], "legitimate").filter(reviewablePath),
      committed: base === null ? Object.freeze([]) : gitPaths(["diff", "--name-only", "-z", `${base}...${head}`, "--"], "legitimate").filter(reviewablePath),
      base_revision: base,
      head_revision: head,
    }),
    untracked,
    created: Object.freeze(new Set([...untracked, ...stagedAdded, ...committedAdded])),
  });
}

function trackedAdditions(baseline: string, paths: readonly string[]): number {
  if (paths.length === 0) return 0;
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe(["diff", "--numstat", baseline, "--", ...paths], GIT_PROBE_OUTPUT_LIMIT, (exit) =>
        exit.status !== 0
          ? exitRefusal(exit, "git diff --numstat failed")
          : { ok: true as const, value: gitStdoutText(exit) }),
      (output) => output === "",
    ),
    // Explicit caller decision: numstat legitimately produces no lines when
    // there is no content delta to count, so confirmed-empty means zero
    // additions — never a fabricated count reaching reviewer selection.
    (confirmed) => parseNumstatAdditions(confirmed.third),
    parseNumstatAdditions,
  );
}

function untrackedAdditions(paths: readonly string[]): number {
  return paths.reduce((sum, path) => {
    return sum + resolveObservation(
      observeGitProbe(
        gitSpawnProbe(["diff", "--no-index", "--numstat", "--", devNull, path], GIT_PROBE_OUTPUT_LIMIT, (exit) => {
          if ((exit.status !== 0 && exit.status !== 1) || gitStderrText(exit) !== "") {
            return exitRefusal(exit, `cannot measure untracked additions for ${path}`);
          }
          return { ok: true as const, value: gitStdoutText(exit) };
        }),
        (output) => output === "",
      ),
      // No-index numstat emits a row even for an empty file. An empty success
      // after bounded retries cannot authorize zero additions, because that
      // could suppress an automatically required reviewer. This refusal is a
      // measurement invariant, not scope authority, so it stays site-local.
      () => { throw new Error(`cannot measure untracked additions for ${path}: empty output after bounded retries`); },
      parseNumstatAdditions,
    );
  }, 0);
}

/** The revision a scope's changes are measured against: the merge base, or HEAD without one. */
export function reviewBaseline(changed: DerivedChangedPaths): string {
  return changed.authority.base_revision ?? changed.authority.head_revision;
}

/** One `ls-tree -z` entry: `<mode> <type> <object>\t<path>\0`. */
const TREE_ENTRY = /^[0-7]{6} ([a-z]+) ([0-9a-f]+)\t([^\0]*)\0$/;

/**
 * The exact bytes of `path` in `revision`, or null when the revision has no
 * such path (the file is new in this change). The read-coverage frozen diff
 * (ADR-0022) takes its base side from here. Absence is the plumbing answer an
 * `ls-tree` of the exact path gives by listing nothing — never a match on
 * Git's localized stderr text. Every other outcome (an invalid revision, a
 * path that names a tree or submodule, an unreadable object) throws with
 * attribution, so an unreadable base can never become an "added file" diff.
 * Both probes go through the module's `gitSpawnProbe`/`observeGitProbe` seam.
 */
export function baselineBlob(revision: string, path: string): Uint8Array | null {
  const object = `${revision}:${path}`;
  const listing = resolveObservation(
    observeGitProbe(
      gitSpawnProbe(["ls-tree", "-z", "--full-tree", revision, "--", path], GIT_PROBE_OUTPUT_LIMIT, (exit) =>
        exit.status !== 0
          ? exitRefusal(exit, `git ls-tree failed for ${object}`)
          : { ok: true as const, value: gitStdoutText(exit) }),
      (entry) => entry === "",
    ),
    () => null,
    (entry: string | null) => entry,
  );
  if (listing === null) return null;
  const [, type, blobId, listedPath] = TREE_ENTRY.exec(listing) ?? [];
  if (type === undefined || blobId === undefined || listedPath !== path) {
    throw new Error(`git ls-tree listed an unexpected entry for ${object}`);
  }
  if (type !== "blob") throw new Error(`${object} is a ${type}, not a file`);
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe(["cat-file", "blob", blobId], BASELINE_BLOB_LIMIT, (exit) =>
        exit.status !== 0
          ? exitRefusal(exit, `git cat-file blob failed for ${object}`)
          : { ok: true as const, value: new Uint8Array(exit.stdout) }),
      (bytes) => bytes.length === 0,
    ),
    // An empty file is a real blob: confirmed-empty bytes are its content.
    (confirmed) => confirmed.third,
    (bytes) => bytes,
  );
}

export function metadata(
  kind: StandaloneReviewKind,
  scope: readonly string[],
  changed: DerivedChangedPaths,
): StandaloneReviewMetadata {
  const scopedUntracked = new Set(changed.untracked.filter((path) => scope.includes(path)));
  const trackedScope = scope.filter((path) => !scopedUntracked.has(path));
  const baseline = reviewBaseline(changed);
  const additions = trackedAdditions(baseline, trackedScope) + untrackedAdditions([...scopedUntracked].sort());
  return classifyScope(kind, scope, changed.created, additions);
}
