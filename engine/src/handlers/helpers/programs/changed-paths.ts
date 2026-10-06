/**
 * Changed-path authority for standalone review scope: fixed-argv Git probes
 * (bounded retries on transient empty output, see `observeGitProbe`) that
 * derive the canonical unstaged/staged/committed path sets, the paths this
 * change created, and the added-line count a frozen scope classifies with.
 * Imperative shell — every classification rule lives in core/scope-classification.
 */
import { devNull } from 'node:os';
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
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

/** Spawn stdout/stderr text with Buffer's default UTF-8 decoding and an empty fallback. */
function spawnText(stream: string | Buffer | undefined): string {
  return stream?.toString() ?? "";
}

/** Shared stderr-fallback refusal for a non-zero Git exit: the caller's exact
 *  fallback label passes through verbatim, so per-site message labels stay
 *  the only visible variation. */
function stderrRefusal(
  stderr: string | Buffer | undefined,
  fallback: string,
): Readonly<{ ok: false; error: Error }> {
  return { ok: false as const, error: new Error(spawnText(stderr).trim() || fallback) };
}

/** Fatal UTF-8 decode of one NUL-delimited Git path listing: a chunk whose
 *  bytes are not valid UTF-8 refuses with attribution instead of entering
 *  scope authority as a U+FFFD-mangled path that can never match the real
 *  worktree file (the same contract workspace-digest parseListedPaths
 *  enforces for its listings). Bytes travel through a latin1 round-trip so
 *  the NUL separators split on byte boundaries before any decoding. */
function decodeListedPaths(stdout: string | Buffer | undefined): GitProbeStep<readonly string[], Error> {
  const chunks = Buffer.from(stdout ?? new Uint8Array(0)).toString("binary").split("\0");
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

/** One file-local shape for the module's six spawnSync→probe wraps
 *  (gitPaths, gitText, candidateReference, candidateMergeBase,
 *  trackedAdditions, untrackedAdditions): the adapter states the shared
 *  spawn-failure refusal once, and each call site passes only its own spawn
 *  options, value decode, and refusal labels — the real per-site differences
 *  (buffer vs utf8 stderr decoding, the no-index probe's status-1 acceptance,
 *  message labels) stay visible as parameters instead of a diff across six
 *  near-identical blocks. */
function gitSpawnProbe<T>(
  args: readonly string[],
  options: SpawnSyncOptions,
  classify: (result: SpawnSyncReturns<string | Buffer>) => GitProbeStep<T, Error>,
): () => GitProbeStep<T, Error> {
  return () => {
    const result = spawnSync("git", [...args], options);
    if (result.error) {
      return { ok: false as const, error: new Error(`git ${args[0]} could not be spawned: ${result.error.message}`) };
    }
    return classify(result);
  };
}

function gitPaths(args: readonly string[], empty: GitEmptyDecision): readonly string[] {
  const frozenPaths = (paths: readonly string[]): readonly string[] => Object.freeze([...paths]);
  return resolveObservation(
    observeGitProbe(
      gitSpawnProbe(args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (result) =>
        result.status !== 0
          ? stderrRefusal(result.stderr, `git ${args[0]} failed`)
          : decodeListedPaths(result.stdout)),
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
      gitSpawnProbe(args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (result) =>
        result.status !== 0
          ? stderrRefusal(result.stderr, `git ${args[0]} failed`)
          : { ok: true as const, value: spawnText(result.stdout).trim() }),
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
        { encoding: "utf8" }, (result) => {
          if (result.status === 1 && spawnText(result.stdout).trim() === "" && spawnText(result.stderr).trim() === "") {
            return { ok: true, value: { kind: "missing" } };
          }
          if (result.status !== 0) return stderrRefusal(result.stderr, `git cannot observe candidate ${candidate}`);
          return { ok: true, value: { kind: "present", revision: spawnText(result.stdout).trim() } };
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
      gitSpawnProbe<MergeBaseCandidate>(["merge-base", candidate, head], { encoding: "utf8" }, (result) => {
        if (result.status === 1 && spawnText(result.stdout).trim() === "" && spawnText(result.stderr).trim() === "") {
          return { ok: true, value: { kind: "no-base" } };
        }
        if (result.status !== 0) return stderrRefusal(result.stderr, `git merge-base failed for ${candidate}`);
        return { ok: true, value: { kind: "base", revision: spawnText(result.stdout).trim() } };
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
      gitSpawnProbe(["diff", "--numstat", baseline, "--", ...paths], { encoding: "utf8" }, (result) =>
        result.status !== 0
          ? stderrRefusal(result.stderr, "git diff --numstat failed")
          : { ok: true as const, value: spawnText(result.stdout) }),
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
        gitSpawnProbe(["diff", "--no-index", "--numstat", "--", devNull, path], { encoding: "utf8" }, (result) => {
          const diagnostic = spawnText(result.stderr).trim();
          if ((result.status !== 0 && result.status !== 1) || diagnostic !== "") {
            return { ok: false as const, error: new Error(diagnostic || `cannot measure untracked additions for ${path}`) };
          }
          return { ok: true as const, value: spawnText(result.stdout) };
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

/**
 * The exact bytes of `path` in `revision`, or null when the revision has no
 * such path (the file is new in this change). The read-coverage frozen diff
 * (ADR-0022) takes its base side from here. Only Git's two "path is not in
 * this revision" refusals mean absence; any other failure (an invalid
 * revision, an unreadable object) throws with attribution, so an unreadable
 * base can never become an "added file" diff.
 */
export function baselineBlob(revision: string, path: string): Uint8Array | null {
  const object = `${revision}:${path}`;
  const probe = spawnSync("git", ["cat-file", "-e", object], { encoding: "buffer" });
  if (probe.error) throw new Error(`git cat-file could not be spawned: ${probe.error.message}`);
  if (probe.status !== 0) {
    const stderr = spawnText(probe.stderr).trim();
    if (/^fatal: path '.*' (does not exist in|exists on disk, but not in) '/.test(stderr)) return null;
    throw new Error(stderr || `git cat-file -e failed for ${object}`);
  }
  const blob = spawnSync("git", ["cat-file", "blob", object], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (blob.error) throw new Error(`git cat-file could not be spawned: ${blob.error.message}`);
  if (blob.status !== 0) throw new Error(spawnText(blob.stderr).trim() || `git cat-file blob failed for ${object}`);
  return new Uint8Array(blob.stdout);
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
