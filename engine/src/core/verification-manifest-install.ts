/**
 * Pure decision core of `helper write-verification-manifest`.
 *
 * The helper installs the operator's Verification Manifest before Task
 * population. Two questions decide what it may do, and both are answered
 * here without I/O:
 *
 * - **Is the candidate the same authority as what is installed?** Authority is
 *   the parsed manifest, not its bytes. Both sides are canonicalized through
 *   `parseVerificationManifest` and the canonical JSON compared, so a manifest
 *   that differs only in whitespace or key layout is an idempotent replay,
 *   never a conflicting overwrite.
 * - **May different authority be replaced?** Only when the operator asked for
 *   it with `--replace`. The shell has already refused every mutation once
 *   Tasks are populated, so replacement is confined to the pre-population
 *   boundary where nothing has frozen the old commands.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { DomainResult } from "./orchestration-contract";
import { COMPLETION_REPORT_ROOT } from "./engine-owned-paths";
import { parseVerificationManifest } from "./verification-manifest";

/** Upper bound on a manifest source; anything larger is refused unparsed. */
export const MAX_MANIFEST_SOURCE_BYTES = 1_048_576;

/** The single flag the helper accepts. */
export const REPLACE_FLAG = "--replace" as const;

/** Canonical JSON text of a parsed, valid Verification Manifest. */
export type CanonicalManifest = string & { readonly __brand: "CanonicalManifest" };

/** Whether the operator authorized replacing different installed authority. */
export type ManifestInstallMode = "create-only" | "replace";

/** What the helper shell must do with the candidate manifest. */
export type ManifestInstallPlan =
  /** No manifest is installed: create it. */
  | Readonly<{ kind: "create"; manifest: CanonicalManifest }>
  /** The installed manifest is the same authority: change nothing. */
  | Readonly<{ kind: "unchanged" }>
  /** Different (or invalid) installed authority, and the operator asked to replace it. */
  | Readonly<{ kind: "replace"; manifest: CanonicalManifest }>
  /** Different (or invalid) installed authority, and no replacement was asked for. */
  | Readonly<{ kind: "refuse"; reason: string }>;

/**
 * Parse the helper's argv. Exactly `[]` or `["--replace"]`; anything else is
 * refused so a typo such as `--replce` can never silently mean create-only.
 */
export function parseManifestInstallArgs(
  args: readonly string[],
): DomainResult<ManifestInstallMode, string> {
  if (args.length === 0) return { ok: true, value: "create-only" };
  if (args.length === 1 && args[0] === REPLACE_FLAG) return { ok: true, value: "replace" };
  return {
    ok: false,
    error: `unexpected arguments ${JSON.stringify(args)}; expected none or ${REPLACE_FLAG}`,
  };
}

/** Parse manifest source text into its canonical form, or name why it is not a manifest. */
export function canonicalizeManifestSource(source: string): DomainResult<CanonicalManifest, string> {
  if (Buffer.byteLength(source, "utf-8") > MAX_MANIFEST_SOURCE_BYTES) {
    return { ok: false, error: `source exceeds ${MAX_MANIFEST_SOURCE_BYTES} bytes` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (cause) {
    return {
      ok: false,
      error: `source must be JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const parsed = parseVerificationManifest(raw);
  return parsed.ok
    ? { ok: true, value: `${JSON.stringify(parsed.value, null, 2)}\n` as CanonicalManifest }
    : { ok: false, error: parsed.error.errors.join("; ") };
}

/**
 * Decide the install for a valid candidate against what is installed.
 *
 * @param installed - The installed manifest's text, or `null` when none exists.
 */
export function planManifestInstall(
  installed: string | null,
  candidate: CanonicalManifest,
  mode: ManifestInstallMode,
  manifestPath: string,
): ManifestInstallPlan {
  if (installed === null) return { kind: "create", manifest: candidate };

  const current = canonicalizeManifestSource(installed);
  if (current.ok && current.value === candidate) return { kind: "unchanged" };
  if (mode === "replace") return { kind: "replace", manifest: candidate };

  return {
    kind: "refuse",
    reason: current.ok
      ? `${manifestPath} already exists with different authority; refusing overwrite ` +
        `(pass ${REPLACE_FLAG} to replace it before Task population)`
      : `${manifestPath} already exists but is not a valid verification manifest (${current.error}); ` +
        `refusing overwrite (pass ${REPLACE_FLAG} to replace it before Task population)`,
  };
}

/**
 * Every report path the manifest's commands write: each project check's and
 * each runner's `required-file` report. The engine writes these paths while
 * Tasks run (the stop checks) and while Waves complete, so each must be
 * untracked and Git-ignored; a Git-visible report is read as somebody's
 * change.
 */
export function manifestReportPaths(manifest: CanonicalManifest): readonly string[] {
  const raw: unknown = JSON.parse(manifest);
  const parsed = parseVerificationManifest(raw);
  // A CanonicalManifest is minted only from a parsed manifest, so this is a
  // constructor invariant, unreachable through canonicalizeManifestSource.
  if (!parsed.ok) throw new Error(`CanonicalManifest no longer parses: ${parsed.error.errors.join("; ")}`);
  const value = parsed.value;
  const reports = [
    ...value.checks.map((check) => check.report),
    ...(value.acceptanceRunner === undefined ? [] : [value.acceptanceRunner.report]),
    ...(value.affectedRunner === undefined ? [] : [value.affectedRunner.report]),
  ];
  return Object.freeze([...new Set(reports.flatMap((report) =>
    report.kind === "required-file" ? [report.path] : []))].sort());
}

/**
 * The refusal for report paths the project does not Git-ignore, or null when
 * every report path is ignored. It names the paths and the rule to add.
 */
export function unignoredReportRefusal(unignored: readonly string[]): string | null {
  if (unignored.length === 0) return null;
  return "verification manifest report paths must be untracked and Git-ignored before Task population, " +
    "or the engine's own report writes are judged as a Task's out-of-scope writes. " +
    `Not ignored: ${unignored.join(", ")}. ` +
    `Add an operator-owned ignore rule (for example \`${COMPLETION_REPORT_ROOT}/\` in .gitignore) ` +
    "and untrack any of these paths Git already tracks (a tracked path is never ignored), then retry.";
}

/** One executable a manifest will run, and where the engine would look for it. */
export type ManifestExecutable = Readonly<{
  /** Which declaration names it: a check id, `affectedRunner` or `acceptanceRunner`. */
  label: string;
  executable: string;
  /**
   * Where it resolves: a project-root-relative path (`<cwd>/<executable>`) for
   * an executable that names a path, else each `PATH` directory joined with it.
   */
  candidates: readonly Readonly<{ kind: "project"; path: string } | { kind: "absolute"; path: string }>[];
}>;

/**
 * Every executable the manifest declares (its checks, its affected runner and
 * its acceptance runner), each with the places the engine would resolve it
 * (loom#198, Cause 5): an executable with a `/` is a path from the
 * declaration's cwd, a bare name is looked up on `pathDirectories`.
 */
export function manifestExecutables(manifest: CanonicalManifest, pathDirectories: readonly string[]): readonly ManifestExecutable[] {
  const raw: unknown = JSON.parse(manifest);
  const parsed = parseVerificationManifest(raw);
  if (!parsed.ok) throw new Error(`CanonicalManifest no longer parses: ${parsed.error.errors.join("; ")}`);
  const value = parsed.value;
  const declared: readonly Readonly<{ label: string; executable: string; cwd: string }>[] = [
    ...value.checks.map((check) => ({ label: check.id, executable: check.executable, cwd: check.cwd })),
    ...(value.affectedRunner === undefined ? [] : [{ label: "affectedRunner", ...value.affectedRunner }]),
    ...(value.acceptanceRunner === undefined ? [] : [{ label: "acceptanceRunner", ...value.acceptanceRunner }]),
  ];
  const joined = (left: string, right: string): string => (left === "." || left === "" ? right : `${left.replace(/\/+$/u, "")}/${right}`);
  return Object.freeze(declared.map(({ label, executable, cwd }) => Object.freeze({
    label,
    executable,
    candidates: Object.freeze(executable.includes("/")
      ? [Object.freeze({ kind: "project" as const, path: joined(cwd, executable) })]
      : pathDirectories.filter((directory) => directory !== "").map((directory) => Object.freeze({ kind: "absolute" as const, path: joined(directory, executable) }))),
  })));
}

/** The warning for executables none of whose candidates exists, or null when every one resolves. */
export function unresolvedExecutablesWarning(unresolved: readonly ManifestExecutable[]): string | null {
  if (unresolved.length === 0) return null;
  const named = unresolved.map(({ label, executable }) => `${label} runs ${executable}`).join("; ");
  return `write-verification-manifest: installed, but ${named}, which ${unresolved.length === 1 ? "does" : "do"} not resolve ` +
    "from the project root or PATH here; the runner will fail when it is first run. Install the dependency or fix the executable, then re-run.";
}
