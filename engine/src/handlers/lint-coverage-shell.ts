/**
 * The lint-coverage shell: which project a directory is in, what its rules
 * config turns on, and whether the user has silenced the reminder for it.
 * The decisions are pure (`linter/lint-coverage.ts`,
 * `core/lint-coverage-ignore.ts`); this module reads and writes the files.
 *
 * Shared by Claude Code's session-start hook, Pi's session start and the
 * `helper lint-coverage` command, so all three report the same coverage.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RULES_DIR, projectAt } from "../config";
import { loadProjectConfig } from "../linter/loader";
import { lintCoverage, messageOf, sessionReminder, type CoverageReminder, type ProjectCoverage } from "../linter/index";
import { parseCoverageIgnoreList, renderCoverageIgnoreList, type CoverageIgnoreList, type IgnoreListParse } from "../core/lint-coverage-ignore";

/** Where the user's ignore list lives: outside every repository, in their own
 *  config directory. `LOOM_LINT_COVERAGE_IGNORE` names another file (tests). */
export const coverageIgnoreFile = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env.LOOM_LINT_COVERAGE_IGNORE ??
  join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "loom", "lint-coverage-ignore.json");

/** The ignore list at `path`: empty when the file does not exist, refused when
 *  it does not parse — a broken list is reported, never read as "ignore all". */
export function readCoverageIgnoreList(path: string): IgnoreListParse {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: [] };
    return { ok: false, error: `cannot read ${path}: ${messageOf(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${path} is not JSON: ${messageOf(error)}` };
  }
  const parsed = parseCoverageIgnoreList(raw);
  return parsed.ok ? parsed : { ok: false, error: `${path}: ${parsed.error}` };
}

/** A write of the ignore list: done, or why not — the list on disk is unchanged then. */
export type IgnoreListWrite = Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>;

/** Replace the ignore list at `path` in one rename, so a reader never sees half
 *  a file. A failure leaves the old list in place and no staged file behind. */
export function writeCoverageIgnoreList(path: string, list: CoverageIgnoreList): IgnoreListWrite {
  const staged = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staged, renderCoverageIgnoreList(list));
    renameSync(staged, path);
    return { ok: true };
  } catch (error) {
    rmSync(staged, { force: true });
    return { ok: false, error: `cannot write ${path}: ${messageOf(error)}` };
  }
}

/** The coverage of the project `directory` sits in. A directory in no project
 *  (no rules layout and no repository above it) has none. */
export function projectCoverageAt(directory: string): ProjectCoverage {
  const project = projectAt(directory);
  if (project === null) return { kind: "no-project" };
  if (project.rulesDir === null) return { kind: "covered", root: project.root, coverage: lintCoverage(null) };
  try {
    return { kind: "covered", root: project.root, coverage: lintCoverage(loadProjectConfig(project.rulesDir)) };
  } catch (error) {
    return { kind: "config-refused", root: project.root, error: messageOf(error) };
  }
}

/** The Loom checkout this module runs from: the default rules' parent. */
const LOOM_ROOT = resolve(DEFAULT_RULES_DIR, "..");

/** The commands a reminder offers, spelled for this Loom installation. */
const COMMANDS = Object.freeze({
  init: `bun ${join(LOOM_ROOT, "scripts", "lint-project.ts")} --init`,
  ignore: `bun ${join(LOOM_ROOT, "engine", "src", "cli.ts")} helper lint-coverage ignore --reason "<why>"`,
});

/** The session-start reminder for the project `directory` sits in, or null
 *  when there is nothing to say (`sessionReminder` decides). */
export function coverageReminderAt(directory: string, ignoreFile: string = coverageIgnoreFile()): CoverageReminder | null {
  return sessionReminder(projectCoverageAt(directory), readCoverageIgnoreList(ignoreFile), COMMANDS);
}
