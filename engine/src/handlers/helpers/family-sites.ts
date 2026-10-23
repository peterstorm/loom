/**
 * `helper family-sites [--json] [--baseline <file>] [--root <dir>]` (AD-11).
 *
 * A read-only shell around the pure family-site metric: it reads every
 * TypeScript file under `<root>/engine/src`, hands the bytes to
 * `scanFamilySites`, and prints the human report or, with `--json`, the JSON
 * document. `--baseline` names an earlier `--json` output to compare against;
 * the per-family delta is printed with the report. `--root` defaults to the
 * Loom package that owns this engine, so the metric measures Loom itself
 * wherever it is invoked from; pointing it at a checkout of another commit is
 * how the recorded baseline was made.
 *
 * It never writes a file and never touches the State File. Symlinks are not
 * followed, so the scan cannot leave the tree it was pointed at.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import { errorResult, passthroughResult } from "../../types";
import {
  familySiteDelta,
  parseFamilySiteBaseline,
  renderFamilySites,
  scanFamilySites,
  serializeFamilySites,
  type FamilySiteBaseline,
  type SourceFile,
} from "../../core/family-sites";
import { failure, success, type DomainResult } from "../../core/orchestration-contract/identity";
import { argumentValue, hasFlag, unconsumedValueArguments } from "./cli-args";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";

const USAGE = "usage: helper family-sites [--json] [--baseline <file>] [--root <dir>]";
const SCANNED_DIRECTORY = "engine/src";
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--baseline", "--root"]);

type Options = Readonly<{ json: boolean; root: string; baseline: string | null }>;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseOptions(args: readonly string[]): DomainResult<Options, string> {
  const unknown = unconsumedValueArguments(args, VALUE_FLAGS).filter((argument) => argument !== "--json");
  if (unknown.length > 0) return failure(`unknown argument(s): ${unknown.join(" ")}; ${USAGE}`);
  for (const flag of VALUE_FLAGS) {
    if (args.includes(flag) && argumentValue(args, flag) === null) return failure(`${flag} requires a value; ${USAGE}`);
  }
  const root = argumentValue(args, "--root");
  const baseline = argumentValue(args, "--baseline");
  return success({
    json: hasFlag(args, "--json"),
    root: root === null ? LOOM_PACKAGE_ROOT : resolve(root),
    baseline: baseline === null ? null : resolve(baseline),
  });
}

/** Every `.ts` file under `<root>/engine/src`, by repository-relative path. Directories and regular files only. */
function readSources(root: string): readonly SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith(".ts")) files.push({ path, text: readFileSync(join(root, path), "utf-8") });
    }
  };
  walk(SCANNED_DIRECTORY);
  return files;
}

function readBaseline(path: string): DomainResult<FamilySiteBaseline, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return failure(`cannot read baseline ${path}: ${describe(error)}`);
  }
  const parsed = parseFamilySiteBaseline(raw);
  return parsed.ok ? parsed : failure(`baseline ${path} is malformed: ${parsed.error}`);
}

export function createFamilySitesHandler(write: (text: string) => void = (text) => { process.stdout.write(text); }): HookHandler {
  return async (_stdin, args): Promise<HookResult> => {
    const options = parseOptions(args);
    if (!options.ok) return errorResult(options.error);
    const { json, root, baseline } = options.value;

    const recorded = baseline === null ? null : readBaseline(baseline);
    if (recorded !== null && !recorded.ok) return errorResult(recorded.error);

    let sources: readonly SourceFile[];
    try {
      sources = readSources(root);
    } catch (error) {
      return errorResult(`cannot read ${SCANNED_DIRECTORY} under ${root}: ${describe(error)}`);
    }

    const report = scanFamilySites(sources);
    const delta = recorded === null ? null : familySiteDelta(report, recorded.value);
    write(json ? serializeFamilySites(report, delta) : renderFamilySites(report, delta));
    return passthroughResult();
  };
}

export default createFamilySitesHandler();
