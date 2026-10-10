/**
 * Changed-path authority for standalone review scope: fixed-argv Git probes
 * (bounded retries on transient empty output, see `observeGitProbe`) that
 * derive the canonical unstaged/staged/committed path sets, the paths this
 * change created, and the added-line count a frozen scope classifies with.
 * Imperative shell — every classification rule lives in core/scope-classification.
 * Every probe reaches Git through the `GitSpawn` port: each exported entry
 * point defaults it to the policy-bound `spawnGit` and binds it once with
 * `scopeProbes`, and tests pass a scripted fake returning `GitSpawnOutcome`
 * values.
 */
import { devNull } from 'node:os';
import { GIT_PROBE_OUTPUT_LIMIT, spawnGit, type GitSpawn } from '../../../utils/git-execution-policy';
import {
  describeGitOutcome,
  gitCleanNegative,
  gitExitedWith,
  gitStderrText,
  gitStdoutText,
  type GitExit,
} from '../../../utils/git-spawn-outcome';
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
  const paths: string[] = [];
  for (const [index, binary] of chunks.entries()) {
    if (binary === "") continue;
    try {
      paths.push(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(binary, "binary")));
    } catch (cause) {
      return { ok: false as const, error: new Error(`git path ${index} is not UTF-8: ${cause instanceof Error ? cause.message : String(cause)}`) };
    }
  }
  return { ok: true as const, value: Object.freeze(paths.sort()) };
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

const decoded = <T>(value: T): GitProbeStep<T, Error> => ({ ok: true as const, value });

/** The two spawn→probe wraps, closed over one `GitSpawn` port. */
type ProbeRunner = Readonly<{
  /** One shape for every spawn→probe wrap: the shared spawn-failure refusal
   *  is stated once, and each probe passes only its own output budget,
   *  accepted exits and refusal labels — the real per-site differences (the
   *  no-index probe's status-1 acceptance, message labels) stay visible as
   *  parameters. Only an `exited` outcome reaches `classify`; a child that
   *  never started, faulted, timed out, outgrew its budget or was signalled
   *  refuses here with its rendered outcome. */
  spawnProbe: <T>(
    args: readonly string[],
    maxBuffer: number,
    classify: (exit: GitExit) => GitProbeStep<T, Error>,
  ) => () => GitProbeStep<T, Error>;
  /** `spawnProbe` for the probes whose protocol accepts only status 0: every
   *  other exit refuses through `exitRefusal` with `failure` as its fallback
   *  label, and `decode` reads the accepted exit. */
  zeroExitProbe: <T>(
    args: readonly string[],
    maxBuffer: number,
    failure: string,
    decode: (exit: GitExit<0>) => GitProbeStep<T, Error>,
  ) => () => GitProbeStep<T, Error>;
}>;

/** Every probe runs under the shared `git-execution-policy` (production's
 *  `spawnGit`), so review scope is derived under the same ignore rules and
 *  config as every other observer. */
function probeRunner(spawn: GitSpawn): ProbeRunner {
  const spawnProbe: ProbeRunner["spawnProbe"] = (args, maxBuffer, classify) => () => {
    const outcome = spawn(args, { maxBuffer });
    if (outcome.kind !== "exited") {
      return { ok: false as const, error: new Error(`git ${args[0]} ${describeGitOutcome(outcome)}`) };
    }
    return classify(outcome);
  };
  return Object.freeze({
    spawnProbe,
    zeroExitProbe: (args, maxBuffer, failure, decode) =>
      spawnProbe(args, maxBuffer, (exit) => gitExitedWith(exit, [0]) ? decode(exit) : exitRefusal(exit, failure)),
  });
}

const pathsProbe = ({ zeroExitProbe }: ProbeRunner) => (args: readonly string[], empty: GitEmptyDecision): readonly string[] => {
  const frozenPaths = (listed: readonly string[]): readonly string[] => Object.freeze([...listed]);
  return resolveObservation(
    observeGitProbe(
      zeroExitProbe(args, SCOPE_LISTING_LIMIT, `git ${args[0]} failed`, (exit) => decodeListedPaths(exit.stdout)),
      (listed) => listed.length === 0,
    ),
    (confirmed) => {
      if (empty === "refuse") throw scopeEmptyRefusal(args.join(" "));
      return frozenPaths(confirmed.third);
    },
    frozenPaths,
  );
};

const textProbe = ({ zeroExitProbe }: ProbeRunner) => (args: readonly string[], empty: GitEmptyDecision): string => resolveObservation(
  observeGitProbe(
    zeroExitProbe(args, SCOPE_LISTING_LIMIT, `git ${args[0]} failed`, (exit) => decoded(gitStdoutText(exit).trim())),
    (value) => value === "",
  ),
  (confirmed) => {
    if (empty === "refuse") throw scopeEmptyRefusal(args.join(" "));
    return confirmed.third;
  },
  (value) => value,
);

const candidateReferenceProbe = ({ spawnProbe }: ProbeRunner) => (candidate: string): CandidateReference => resolveObservation(
  observeGitProbe(
    spawnProbe<CandidateReference>(["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`],
      GIT_PROBE_OUTPUT_LIMIT, (exit) => {
        if (gitCleanNegative(exit)) return decoded({ kind: "missing" });
        if (!gitExitedWith(exit, [0])) return exitRefusal(exit, `git cannot observe candidate ${candidate}`);
        return decoded({ kind: "present", revision: gitStdoutText(exit).trim() });
      }),
    (value) => value.kind === "present" && value.revision === "",
  ),
  () => { throw scopeEmptyRefusal(`candidate ${candidate}`); },
  (value) => value,
);

const candidateMergeBaseProbe = ({ spawnProbe }: ProbeRunner) => (candidate: string, head: string): MergeBaseCandidate => resolveObservation(
  observeGitProbe(
    spawnProbe<MergeBaseCandidate>(["merge-base", candidate, head], GIT_PROBE_OUTPUT_LIMIT, (exit) => {
      if (gitCleanNegative(exit)) return decoded({ kind: "no-base" });
      if (!gitExitedWith(exit, [0])) return exitRefusal(exit, `git merge-base failed for ${candidate}`);
      return decoded({ kind: "base", revision: gitStdoutText(exit).trim() });
    }),
    (value) => value.kind === "base" && value.revision === "",
  ),
  () => { throw scopeEmptyRefusal(`merge-base ${candidate} ${head}`); },
  (value) => value,
);

const trackedAdditionsProbe = ({ zeroExitProbe }: ProbeRunner) => (baseline: string, tracked: readonly string[]): number => {
  if (tracked.length === 0) return 0;
  return resolveObservation(
    observeGitProbe(
      zeroExitProbe(["diff", "--numstat", baseline, "--", ...tracked], GIT_PROBE_OUTPUT_LIMIT, "git diff --numstat failed",
        (exit) => decoded(gitStdoutText(exit))),
      (output) => output === "",
    ),
    // Explicit caller decision: numstat legitimately produces no lines when
    // there is no content delta to count, so confirmed-empty means zero
    // additions — never a fabricated count reaching reviewer selection.
    (confirmed) => parseNumstatAdditions(confirmed.third),
    parseNumstatAdditions,
  );
};

const untrackedAdditionsProbe = ({ spawnProbe }: ProbeRunner) => (untracked: readonly string[]): number =>
  untracked.reduce((sum, path) => sum + resolveObservation(
    observeGitProbe(
      // No-index numstat exits 1 whenever the file differs from /dev/null, so
      // its protocol accepts 0 and 1 — and only with a silent stderr.
      spawnProbe(["diff", "--no-index", "--numstat", "--", devNull, path], GIT_PROBE_OUTPUT_LIMIT, (exit) =>
        gitExitedWith(exit, [0, 1]) && gitStderrText(exit) === ""
          ? decoded(gitStdoutText(exit))
          : exitRefusal(exit, `cannot measure untracked additions for ${path}`)),
      (output) => output === "",
    ),
    // No-index numstat emits a row even for an empty file. An empty success
    // after bounded retries cannot authorize zero additions, because that
    // could suppress an automatically required reviewer. This refusal is a
    // measurement invariant, not scope authority, so it stays site-local.
    () => { throw new Error(`cannot measure untracked additions for ${path}: empty output after bounded retries`); },
    parseNumstatAdditions,
  ), 0);

const treeEntryProbe = ({ zeroExitProbe }: ProbeRunner) => (revision: string, path: string): string | null => resolveObservation(
  observeGitProbe(
    zeroExitProbe(["ls-tree", "-z", "--full-tree", revision, "--", path], GIT_PROBE_OUTPUT_LIMIT, `git ls-tree failed for ${revision}:${path}`,
      (exit) => decoded(gitStdoutText(exit))),
    (entry) => entry === "",
  ),
  () => null,
  (entry: string | null) => entry,
);

const blobBytesProbe = ({ zeroExitProbe }: ProbeRunner) => (blobId: string, object: string): Uint8Array => resolveObservation(
  observeGitProbe(
    zeroExitProbe(["cat-file", "blob", blobId], BASELINE_BLOB_LIMIT, `git cat-file blob failed for ${object}`,
      (exit) => decoded(new Uint8Array(exit.stdout))),
    (bytes) => bytes.length === 0,
  ),
  // An empty file is a real blob: confirmed-empty bytes are its content.
  (confirmed) => confirmed.third,
  (bytes) => bytes,
);

/** The module's Git probes with the `GitSpawn` port bound ONCE: each entry
 *  point builds `scopeProbes(spawn)`, and every probe reaches Git through that
 *  one runner, so no call site restates the port. */
type ScopeProbes = Readonly<{
  paths: ReturnType<typeof pathsProbe>;
  text: ReturnType<typeof textProbe>;
  candidateReference: ReturnType<typeof candidateReferenceProbe>;
  candidateMergeBase: ReturnType<typeof candidateMergeBaseProbe>;
  trackedAdditions: ReturnType<typeof trackedAdditionsProbe>;
  untrackedAdditions: ReturnType<typeof untrackedAdditionsProbe>;
  /** The exact path's one `ls-tree -z` entry in `revision`, or null when it lists nothing. */
  treeEntry: ReturnType<typeof treeEntryProbe>;
  /** One blob's bytes; `object` is the `<revision>:<path>` it was listed for. */
  blobBytes: ReturnType<typeof blobBytesProbe>;
}>;

function scopeProbes(spawn: GitSpawn): ScopeProbes {
  const runner = probeRunner(spawn);
  return Object.freeze({
    paths: pathsProbe(runner),
    text: textProbe(runner),
    candidateReference: candidateReferenceProbe(runner),
    candidateMergeBase: candidateMergeBaseProbe(runner),
    trackedAdditions: trackedAdditionsProbe(runner),
    untrackedAdditions: untrackedAdditionsProbe(runner),
    treeEntry: treeEntryProbe(runner),
    blobBytes: blobBytesProbe(runner),
  });
}

/**
 * One fixed-argv Git probe for text authority, retried twice on status-0
 * empty stdout. The `empty` argument is the caller's confirmed-empty decision
 * (see `GitEmptyDecision`) and is required at every call site so the policy
 * for text authority is visible where the value is consumed, never defaulted.
 */
export function gitText(args: readonly string[], empty: GitEmptyDecision, spawn: GitSpawn = spawnGit): string {
  return scopeProbes(spawn).text(args, empty);
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

export function deriveChangedPaths(spawn: GitSpawn = spawnGit): DerivedChangedPaths {
  const git = scopeProbes(spawn);
  // A HEAD revision can never legitimately be empty: a confirmed-empty answer
  // after the bounded retry refuses instead of freezing `head_revision: ""`.
  const head = git.text(["rev-parse", "HEAD"], "refuse");
  let base: string | null = null;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    // A missing ref is distinct from an error: real temporary repositories
    // often have no origin/main, and merge-base reports that absence as 128.
    if (git.candidateReference(candidate).kind === "missing") continue;
    const observed = git.candidateMergeBase(candidate, head);
    if (observed.kind === "no-base") continue;
    base = observed.revision;
    break;
  }
  const untracked = git.paths(["ls-files", "--others", "--exclude-standard", "-z", "--"], "legitimate").filter(reviewablePath);
  const trackedUnstaged = git.paths(["diff", "--name-only", "-z", "--"], "legitimate").filter(reviewablePath);
  const stagedAdded = git.paths(["diff", "--cached", "--name-only", "--diff-filter=A", "-z", "--"], "legitimate").filter(reviewablePath);
  const committedAdded = base === null
    ? []
    : git.paths(["diff", "--name-only", "--diff-filter=A", "-z", `${base}...${head}`, "--"], "legitimate").filter(reviewablePath);
  return Object.freeze({
    authority: Object.freeze({
      unstaged: Object.freeze([...new Set([...trackedUnstaged, ...untracked])].sort()),
      staged: git.paths(["diff", "--cached", "--name-only", "-z", "--"], "legitimate").filter(reviewablePath),
      committed: base === null ? Object.freeze([]) : git.paths(["diff", "--name-only", "-z", `${base}...${head}`, "--"], "legitimate").filter(reviewablePath),
      base_revision: base,
      head_revision: head,
    }),
    untracked,
    created: Object.freeze(new Set([...untracked, ...stagedAdded, ...committedAdded])),
  });
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
 * Both probes go through the module's `scopeProbes`/`observeGitProbe` seam.
 */
export function baselineBlob(revision: string, path: string, spawn: GitSpawn = spawnGit): Uint8Array | null {
  const git = scopeProbes(spawn);
  const object = `${revision}:${path}`;
  const listing = git.treeEntry(revision, path);
  if (listing === null) return null;
  const [, type, blobId, listedPath] = TREE_ENTRY.exec(listing) ?? [];
  if (type === undefined || blobId === undefined || listedPath !== path) {
    throw new Error(`git ls-tree listed an unexpected entry for ${object}`);
  }
  if (type !== "blob") throw new Error(`${object} is a ${type}, not a file`);
  return git.blobBytes(blobId, object);
}

export function metadata(
  kind: StandaloneReviewKind,
  scope: readonly string[],
  changed: DerivedChangedPaths,
  spawn: GitSpawn = spawnGit,
): StandaloneReviewMetadata {
  const git = scopeProbes(spawn);
  const scopedUntracked = new Set(changed.untracked.filter((path) => scope.includes(path)));
  const trackedScope = scope.filter((path) => !scopedUntracked.has(path));
  const baseline = reviewBaseline(changed);
  const additions = git.trackedAdditions(baseline, trackedScope) + git.untrackedAdditions([...scopedUntracked].sort());
  return classifyScope(kind, scope, changed.created, additions);
}
