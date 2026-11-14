/**
 * The lint-coverage shell: which project a directory is in, what its rules
 * config turns on, and whether the user has silenced the reminder for it.
 * The decisions are pure (`linter/lint-coverage.ts`,
 * `core/lint-coverage-ignore.ts`); this module reads and writes the files.
 *
 * Shared by Claude Code's session-start hook, Pi's session start and the
 * `helper lint-coverage` command, so all three report the same coverage.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RULES_DIR, pathExistsFailClosed, projectRulesDir } from "../config";
import { loadProjectConfig } from "../linter/loader";
import { coverageReminder, findProjectRoot, lintCoverage, type CoverageReminder, type LintCoverage } from "../linter/index";
import { isIgnored, parseCoverageIgnoreList, renderCoverageIgnoreList, type CoverageIgnoreList } from "../core/lint-coverage-ignore";

/** Where the user's ignore list lives: outside every repository, in their own
 *  config directory. `LOOM_LINT_COVERAGE_IGNORE` names another file (tests). */
export const coverageIgnoreFile = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env.LOOM_LINT_COVERAGE_IGNORE ??
  join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "loom", "lint-coverage-ignore.json");

export type IgnoreListRead =
  | Readonly<{ ok: true; value: CoverageIgnoreList }>
  | Readonly<{ ok: false; error: string }>;

/** The ignore list at `path`: empty when the file does not exist, refused when
 *  it does not parse — a broken list is reported, never read as "ignore all". */
export function readCoverageIgnoreList(path: string): IgnoreListRead {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: [] };
    return { ok: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseCoverageIgnoreList(raw);
  return parsed.ok ? parsed : { ok: false, error: `${path}: ${parsed.error}` };
}

/** Replace the ignore list at `path` in one rename, so a reader never sees half a file. */
export function writeCoverageIgnoreList(path: string, list: CoverageIgnoreList): void {
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, renderCoverageIgnoreList(list));
  renameSync(staged, path);
}

/** A directory's project and its coverage, or why there is no answer. */
export type ProjectCoverage =
  | Readonly<{ kind: "no-project" }>
  | Readonly<{ kind: "config-refused"; root: string; error: string }>
  | Readonly<{ kind: "covered"; root: string; coverage: LintCoverage }>;

/** The coverage of the project `directory` sits in. A directory in no project
 *  (no rules layout and no repository above it) has none. */
export function projectCoverageAt(directory: string): ProjectCoverage {
  const root = findProjectRoot(resolve(directory), pathExistsFailClosed);
  if (root === null) return { kind: "no-project" };
  const rulesDir = projectRulesDir(root);
  if (rulesDir === null) return { kind: "covered", root, coverage: lintCoverage(null) };
  try {
    return { kind: "covered", root, coverage: lintCoverage(loadProjectConfig(rulesDir)) };
  } catch (error) {
    return { kind: "config-refused", root, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The Loom checkout this module runs from: the default rules' parent. */
const LOOM_ROOT = resolve(DEFAULT_RULES_DIR, "..");

/** The commands a reminder offers, spelled for this Loom installation. */
const COMMANDS = Object.freeze({
  init: `bun ${join(LOOM_ROOT, "scripts", "lint-project.ts")} --init`,
  ignore: `bun ${join(LOOM_ROOT, "engine", "src", "cli.ts")} helper lint-coverage ignore --reason "<why>"`,
});

/**
 * The session-start reminder for the project `directory` sits in, or null when
 * there is nothing to say: no project, full coverage, or a repository the user
 * silenced. A config the linter refuses, or an ignore list that does not parse,
 * is said too — a reminder that cannot be computed must not go quiet.
 */
export function coverageReminderAt(directory: string, ignoreFile: string = coverageIgnoreFile()): CoverageReminder | null {
  const project = projectCoverageAt(directory);
  if (project.kind === "no-project") return null;
  const ignored = readCoverageIgnoreList(ignoreFile);
  if (!ignored.ok) {
    const message = `Loom lint: the lint-coverage ignore list cannot be read (${ignored.error}); fix or delete it.`;
    return { forModel: message, forOperator: message };
  }
  if (isIgnored(ignored.value, project.root)) return null;
  if (project.kind === "config-refused") {
    const message = `Loom lint: the rules config of ${project.root} is refused, so every edit's lint fails: ${project.error}`;
    return { forModel: message, forOperator: message };
  }
  return coverageReminder(project.root, project.coverage, COMMANDS);
}
