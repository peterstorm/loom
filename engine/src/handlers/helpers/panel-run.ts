/**
 * Panel run shell — the filesystem boundary every panel helper shares.
 *
 * Companion to `core/panel-kernel.ts`: the kernel owns the pure envelope rules,
 * this owns the untrusted-path rules. Both panels write their artifacts into a
 * unique run directory under a runs-root inside the cwd, and both must reject
 * a symlinked hop, an escaping path, and an empty or non-regular artifact
 * before any agent output is believed.
 *
 * Not pure: lstat/realpath/read/write. Kept out of `core/` for that reason.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HookResult } from "../../types";
import type { ParseResult, RunLayout } from "../../core/panel-kernel";
import { fail, ok } from "../../core/panel-kernel";

// `RunLayout` and the two layouts are pure data and live in the kernel, beside
// the manifest parsers that give them meaning — those parsers used to hardcode
// `"interview.md"` / `"candidates"` while this module declared them as
// constants, with nothing comparing the two. Re-exported so the shell's own
// callers need not know where the definition moved.
export { ARCHITECTURE_LAYOUT, REVIEW_LAYOUT } from "../../core/panel-kernel";
export type { RunLayout } from "../../core/panel-kernel";

export function argumentValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

export function contractError(context: string, errors: readonly string[]) {
  return {
    kind: "error" as const,
    message: [`${context} contract failed:`, ...errors.map((error) => `- ${error}`)].join("\n"),
  };
}

export type RunBoundary = Readonly<{ runDir: string; manifestPath: string }>;

/** The runs-root must sit inside the cwd, reached without traversing a symlink.
 *  Every hop is checked, not just the leaf: a symlinked ancestor is enough to
 *  point the whole run somewhere the containment checks never see. */
function runsRootErrors(cwd: string, fromCwd: string): string[] {
  const errors: string[] = [];
  if (isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    errors.push("panel-runs root must be inside the current working directory");
    return errors;
  }
  let cursor = cwd;
  for (const segment of fromCwd.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) errors.push(`path component must not be a symbolic link: ${cursor}`);
    } catch (error) {
      errors.push(`cannot inspect path component ${cursor}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return errors;
}

/** One run-scoped path's shape check: exists, right kind, not a symlink. */
function entryErrors(label: string, path: string, kind: "directory" | "file"): string[] {
  const errors: string[] = [];
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) errors.push(`${label} must not be a symbolic link: ${path}`);
    if (kind === "directory" && !stat.isDirectory()) errors.push(`${label} must be a directory: ${path}`);
    if (kind === "file" && (!stat.isFile() || stat.size === 0)) errors.push(`${label} must be a non-empty regular file: ${path}`);
  } catch (error) {
    errors.push(`cannot inspect ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/**
 * Bind a run DIRECTORY to an explicit panel-runs root, for the operations that
 * run before a manifest exists (the review panel writes its brief and manifest
 * from the engine). Same containment and symlink rules as parseRunBoundary,
 * minus the manifest itself.
 */
export function parseRunDirectory(runsRoot: string, runDir: string): ParseResult<string> {
  const cwd = realpathSync(process.cwd());
  const absoluteRoot = resolve(runsRoot);
  const absoluteRunDir = resolve(runDir);

  const errors = runsRootErrors(cwd, relative(cwd, absoluteRoot));
  if (runDir.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    errors.push(`run directory must not contain dot path segments: ${runDir}`);
  }
  if (dirname(absoluteRunDir) !== absoluteRoot) {
    errors.push("run directory must be directly inside --runs-root");
  }
  errors.push(...entryErrors("run directory", absoluteRunDir, "directory"));
  try {
    if (realpathSync(runDir) !== absoluteRunDir) {
      errors.push(`run directory must resolve directly to its lexical path: ${runDir}`);
    }
  } catch (error) {
    errors.push(`cannot resolve run directory ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return errors.length > 0 ? fail(errors) : ok(runDir);
}

/** Bind the run to an explicit panel-runs root and reject every symlinked hop. */
export function parseRunBoundary(runsRoot: string, manifestPath: string): ParseResult<RunBoundary> {
  const cwd = realpathSync(process.cwd());
  const absoluteRoot = resolve(runsRoot);
  const absoluteManifest = resolve(manifestPath);
  const absoluteRunDir = dirname(absoluteManifest);

  const errors = runsRootErrors(cwd, relative(cwd, absoluteRoot));
  if (manifestPath.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    errors.push(`manifest path must not contain dot path segments: ${manifestPath}`);
  }
  if (dirname(absoluteRunDir) !== absoluteRoot) {
    errors.push("manifest must be directly inside one run directory under --runs-root");
  }
  if (absoluteManifest !== join(absoluteRunDir, "manifest.json")) {
    errors.push("manifest filename must be exactly manifest.json");
  }
  errors.push(...entryErrors("run directory", absoluteRunDir, "directory"));
  errors.push(...entryErrors("manifest", absoluteManifest, "file"));
  try {
    if (realpathSync(dirname(manifestPath)) !== absoluteRunDir) {
      errors.push(`manifest run directory must resolve directly to its lexical path: ${dirname(manifestPath)}`);
    }
    if (realpathSync(manifestPath) !== absoluteManifest) {
      errors.push(`manifest must resolve directly to its lexical path: ${manifestPath}`);
    }
  } catch (error) {
    errors.push(`cannot resolve manifest boundary ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) return fail(errors);
  return ok({ runDir: dirname(manifestPath), manifestPath });
}

/** One artifact's existence/shape/containment check. Returns null when the file
 *  is a non-empty regular file resolving directly inside `expectedParent`. */
export function artifactError(path: string, expectedParent: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `artifact must not be a symbolic link: ${path}`;
    if (!stat.isFile() || stat.size === 0) {
      return `artifact must be a non-empty regular file: ${path}`;
    }
    if (dirname(realpathSync(path)) !== expectedParent) {
      return `artifact resolves outside its run-scoped directory: ${path}`;
    }
    return null;
  } catch (error) {
    return `cannot verify artifact ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Every artifact one run names, each checked against the directory it must
 * resolve into.
 *
 * Two TIERS, taken as separate arguments: context files (the interview digest,
 * the findings brief) sit at the run root, item files (candidates, findings) in
 * the run's item directory. Both panels ran this loop; the architecture copy
 * discriminated the tiers after the fact by comparing each path against
 * `manifest.interviewFile` by VALUE, which is safe only because
 * `parsePanelManifest` guarantees candidate paths live under `candidates/` — a
 * guarantee held two modules away with nothing linking them. Change
 * `candidateFilename` or the layout so a candidate path could equal a context
 * path, and that copy would check the candidate against the run root instead of
 * the item directory: a containment check passing on a path it should reject.
 * Which list a path came from is the fact that decides the tier, so it is the
 * fact the signature carries.
 */
export function runArtifactErrors(
  runDir: string,
  layout: RunLayout,
  contextPaths: readonly string[],
  itemPaths: readonly string[],
): string[] {
  const resolved = realRunDir(runDir);
  if (!resolved.ok) return [...resolved.errors];
  const root = resolved.value;
  const itemDir = join(root, layout.itemDir);
  const check = (path: string, parent: string): string[] => {
    const error = artifactError(path, parent);
    return error ? [error] : [];
  };
  return [
    ...contextPaths.flatMap((path) => check(path, root)),
    ...itemPaths.flatMap((path) => check(path, itemDir)),
    ...(itemPaths.length === 0 ? [] : surplusItemErrors(itemDir, itemPaths, layout)),
  ];
}

/**
 * Item files on disk that the manifest does not name.
 *
 * The exact-set rules prove the manifest names every EXPECTED item; nothing
 * looked at what is actually in the item directory. A surplus
 * `candidate-performance-first.md` is not junk to ignore — it is positive
 * evidence that the panel which RAN was larger than the manifest claims, the
 * same reasoning `surplusVerdictErrors` applies to the verdict directory. The
 * architecture panel had no analogue, so a run with five designed candidates and
 * a two-candidate manifest declared a winner from two of five at exit 0, with
 * nothing on stderr.
 *
 * A missing item directory is NOT an error here: `artifactError` above already
 * reports every named item that does not resolve, and reporting the absence
 * twice tells the operator nothing new.
 */
function surplusItemErrors(
  itemDir: string,
  itemPaths: readonly string[],
  layout: RunLayout,
): string[] {
  let names: readonly string[];
  try {
    names = readdirSync(itemDir);
  } catch {
    return [];
  }
  const named = new Set(itemPaths.map((path) => basename(path)));
  const surplus = names.filter((name) => !named.has(name)).sort();
  return surplus.length === 0
    ? []
    : [
        `${layout.itemDir} directory holds ${surplus.length} file(s) the manifest does not name ` +
          `(${surplus.join(", ")}) — the panel that produced them was larger than the manifest ` +
          `declares, so this run would decide on a subset of the work done`,
      ];
}

/**
 * Prepare a run-scoped directory and prove every path the engine is about to
 * WRITE is safe to write.
 *
 * The read side has always been checked (`entryErrors`, `artifactError`); the
 * review panel is the first panel where the engine authors artifacts, and a
 * write follows a symlink just as happily as a read does. `mkdirSync` is a
 * silent no-op on an existing symlinked directory, and `writeFileSync` through
 * a symlinked `brief.md` lands the JSON wherever it points — outside the run
 * root the containment checks all compare against. Checked BEFORE the write,
 * because `artifactErrors` runs at the manifest step, by which time the bytes
 * have already landed.
 */
export function prepareWriteTargets(
  runDir: string,
  directories: readonly string[],
  files: readonly string[],
): ParseResult<void> {
  const errors: string[] = [];
  for (const directory of directories) {
    const path = join(runDir, directory);
    try {
      mkdirSync(path, { recursive: true });
    } catch (error) {
      errors.push(`cannot create ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    errors.push(...entryErrors("run subdirectory", path, "directory"));
  }
  for (const file of files) {
    const path = join(runDir, file);
    try {
      // Absent is the expected state for a fresh run directory and is fine;
      // anything that EXISTS must be a plain file we are overwriting in place.
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) errors.push(`write target must not be a symbolic link: ${path}`);
      else if (!stat.isFile()) errors.push(`write target must be a regular file: ${path}`);
    } catch (error) {
      // ONLY ENOENT means "nothing to follow, nothing to check". A blanket
      // catch read EACCES on a parent component and ELOOP as "absent, safe to
      // write" — which is precisely the state this function exists to refuse.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        errors.push(
          `cannot verify write target ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return errors.length > 0 ? fail(errors) : ok(undefined);
}

/**
 * Delete the artifacts in an item directory that the caller is not about to
 * write, and report what went.
 *
 * Only the engine-authored side needs this, and only because a re-brief is a
 * legitimate operation: after a finding is refuted or overridden, the next
 * brief names fewer findings, and the file for the departed one stayed behind.
 * The surplus was then caught two steps later by `runArtifactErrors` — with the
 * diagnostic "the panel that produced them was larger than the manifest
 * declares", which describes the opposite of what happened and sends the
 * operator looking for a resized panel that does not exist.
 *
 * Refuses rather than deletes anything that is not a plain file it recognizes:
 * this runs `rm` inside a directory derived from an argument, so a symlink or a
 * nested directory is a reason to stop, not something to clean up. Unknown
 * plain files ARE removed — a stale `finding-code-reviewer-9.json` is exactly
 * the surplus this exists to clear.
 */
export function pruneSurplusItems(
  runDir: string,
  itemDir: string,
  expected: readonly string[],
): ParseResult<readonly string[]> {
  const directory = join(runDir, itemDir);
  const keep = new Set(expected);
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    // A run directory that has never held items is the normal first-brief case.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return ok([]);
    return fail([
      `cannot list ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const removed: string[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    const path = join(directory, entry);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        errors.push(`stale run artifact must not be a symbolic link: ${path}`);
        continue;
      }
      if (!stat.isFile()) {
        errors.push(`stale run artifact must be a regular file: ${path}`);
        continue;
      }
      unlinkSync(path);
      removed.push(entry);
    } catch (error) {
      errors.push(
        `cannot clear stale run artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors.length > 0 ? fail(errors) : ok(removed);
}

/** Canonical per-criterion verdict path. Positional by index, but the content
 *  is re-validated against `criteria[index]` when read, so a verdict written to
 *  the wrong slot is a hard error rather than a silent mis-adjudication. */
export function verdictPath(runDir: string, layout: RunLayout, index: number): string {
  return join(runDir, layout.verdictDir, `verdict-${index + 1}.json`);
}

/** Resolve a run directory once, so every containment check compares against
 *  the same real path. Errors are returned, never thrown — a panel helper's
 *  failure must reach the operator as a contract diagnostic. */
export function realRunDir(runDir: string): ParseResult<string> {
  try {
    return ok(realpathSync(runDir));
  } catch (error) {
    return fail([`cannot resolve run directory ${runDir}: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

/**
 * Verdict files numbered past the criteria set, which the read loop below would
 * otherwise never open.
 *
 * A surplus `verdict-4.json` is not junk to ignore — it is positive evidence
 * that the panel which actually RAN was larger than the criteria set now
 * claims. That is exactly the shape a shrunken panel leaves behind (see the
 * panel-size note in helpers/review-panel.ts), and ignoring it is what let a
 * 5-lens run be adjudicated as a 3-lens one with a lower absolute refutation
 * bar. Reported, never silently skipped.
 */
function surplusVerdictErrors(verdictsDir: string, expected: number): string[] {
  let names: readonly string[];
  try {
    names = readdirSync(verdictsDir);
  } catch (error) {
    return [
      `cannot list verdict directory ${verdictsDir}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const surplus = names
    .flatMap((name) => {
      const match = /^verdict-(\d+)\.json$/.exec(name);
      const index = match ? Number(match[1]) : 0;
      return match && index > expected ? [{ name, index }] : [];
    })
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.name);

  return surplus.length === 0
    ? []
    : [
        `verdict directory holds ${surplus.length} verdict file(s) beyond the ${expected} this run ` +
          `expects (${surplus.join(", ")}) — the panel that produced them was larger than the ` +
          `criteria set names, so this tally would adjudicate on a subset of the votes cast`,
      ];
}

/**
 * Read and re-validate every criterion's verdict from disk.
 *
 * Both panels re-read rather than trusting the step that just wrote — the
 * verdict operation validated ONE agent's output in isolation, and nothing
 * until now has looked at the collected set. Shared because it is the same
 * loop: per-criterion path, artifact shape check, read, parse, prefix every
 * diagnostic with the file that produced it, and collect across all of them so
 * a re-run learns every bad verdict at once rather than the first.
 */
export function readVerdicts<T, Criterion extends string>(
  runDir: string,
  layout: RunLayout,
  verdictsDir: string,
  criteria: readonly Criterion[],
  parse: (raw: string, criterion: Criterion) => ParseResult<T>,
): ParseResult<readonly T[]> {
  const verdicts: T[] = [];
  const errors: string[] = surplusVerdictErrors(verdictsDir, criteria.length);
  for (const [index, criterion] of criteria.entries()) {
    const path = verdictPath(runDir, layout, index);
    const fileError = artifactError(path, verdictsDir);
    if (fileError) {
      errors.push(fileError);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      errors.push(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parse(raw, criterion);
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((error) => `${path}: ${error}`));
      continue;
    }
    verdicts.push(parsed.value);
  }
  return errors.length > 0 ? fail(errors) : ok(verdicts);
}

export function writeCanonicalOutput(output: string): HookResult {
  try {
    writeFileSync(process.stdout.fd, output);
    return { kind: "allow" as const };
  } catch (error) {
    return contractError("canonical output", [
      `stdout write failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}
