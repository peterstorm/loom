/**
 * Lint coverage of the project the working directory sits in.
 *
 * Usage: bun cli.ts helper lint-coverage <status | ignore --reason <why> | unignore>
 *
 * - `status` prints the project root and, for each opt-in rule family, whether
 *   it is configured, declined (with its reason) or a gap; and whether the
 *   session reminder is silenced for the project.
 * - `ignore --reason <why>` silences the session reminder for this project in
 *   the user's ignore list (`lint-coverage-shell.ts`), outside the repository.
 * - `unignore` takes it off the list again.
 */

import { resolve } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import { errorResult, passthroughResult } from "../../types";
import { findProjectRoot, type LintCoverage } from "../../linter/index";
import { pathExistsFailClosed } from "../../config";
import { argumentValue } from "./cli-args";
import { isIgnored, withIgnored, withoutIgnored, type CoverageIgnoreList } from "../../core/lint-coverage-ignore";
import {
  coverageIgnoreFile,
  projectCoverageAt,
  readCoverageIgnoreList,
  writeCoverageIgnoreList,
} from "../lint-coverage-shell";

const USAGE = "Usage: helper lint-coverage <status | ignore --reason <why> | unignore>";

/** The coverage lines `status` prints, one per family. Pure. */
export function coverageLines(coverage: LintCoverage): readonly string[] {
  if (coverage.kind === "no-setup") return ["no lint setup: only the shipped rules run (lint-project --init turns every family on)"];
  return coverage.families.map((family) => {
    switch (family.kind) {
      case "configured": return `${family.key}: configured`;
      case "declined": return `${family.key}: declined — ${family.reason}`;
      case "gap": return `${family.key}: GAP — neither configured nor declined`;
      default: {
        const unreachable: never = family;
        return unreachable;
      }
    }
  });
}

function status(): HookResult {
  const project = projectCoverageAt(process.cwd());
  if (project.kind === "no-project") {
    process.stdout.write("Not in a project: no rules layout and no repository at or above this directory.\n");
    return passthroughResult();
  }
  const ignored = readCoverageIgnoreList(coverageIgnoreFile());
  const lines = [
    `project: ${project.root}`,
    ...(project.kind === "config-refused" ? [`rules config refused: ${project.error}`] : coverageLines(project.coverage)),
    ignored.ok
      ? `session reminder: ${isIgnored(ignored.value, project.root) ? "silenced (ignore list)" : "on"}`
      : `session reminder: ignore list unreadable (${ignored.error})`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return passthroughResult();
}

/** Apply `update` to the ignore list for the project the cwd is in. */
function updateIgnoreList(update: (list: CoverageIgnoreList, root: string) => CoverageIgnoreList, verb: string): HookResult {
  const root = findProjectRoot(resolve(process.cwd()), pathExistsFailClosed);
  if (root === null) return errorResult("lint-coverage: not in a project — there is nothing to ignore here");
  const file = coverageIgnoreFile();
  const current = readCoverageIgnoreList(file);
  if (!current.ok) return errorResult(`lint-coverage: ${current.error}`);
  writeCoverageIgnoreList(file, update(current.value, root));
  process.stdout.write(`${verb} ${root} in ${file}\n`);
  return passthroughResult();
}

const handler: HookHandler = async (_stdin, args) => {
  const [command] = args;
  if (command === "status") return status();
  if (command === "unignore") return updateIgnoreList((list, root) => withoutIgnored(list, root), "Unignored");
  if (command === "ignore") {
    const reason = argumentValue(args, "--reason");
    if (reason === null || reason.trim() === "") {
      return errorResult("lint-coverage ignore: --reason <why> is required — every ignored repository states why");
    }
    return updateIgnoreList((list, root) => withIgnored(list, root, reason), "Ignored");
  }
  return errorResult(USAGE);
};

export default handler;
