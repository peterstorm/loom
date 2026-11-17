/**
 * What a repository shows about its test runner, read for the runner-preset
 * suggestion (`core/runner-presets.ts`, loom#198 Cause 3). Read-only and
 * total: the facts only ever feed a suggestion, so nothing here throws. A
 * missing `package.json` is a repository with no packages; one that exists
 * but cannot be read or parsed is named, so the hint never points the
 * operator at the generic shape for the wrong reason.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../core/plain-record";
import type { PackageRunnerFacts, RepositoryRunnerFacts } from "../core/runner-presets";
import { describeCause } from "./describe-cause";
import { isAbsence } from "./file-absence";

const noPackages = (packageJsonProblem: string | null): PackageRunnerFacts =>
  Object.freeze({ packages: new Set<string>(), testScript: null, packageJsonProblem });

function packageFacts(root: string): PackageRunnerFacts {
  let text: string;
  try {
    text = readFileSync(join(root, "package.json"), "utf8");
  } catch (cause) {
    return noPackages(isAbsence(cause) ? null : `package.json could not be read: ${describeCause(cause)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return noPackages(`package.json is not valid JSON: ${describeCause(cause)}`);
  }
  if (!isRecord(raw) || Array.isArray(raw)) return noPackages("package.json is not a JSON object");
  const names = [raw.dependencies, raw.devDependencies].flatMap((block) => (isRecord(block) ? Object.keys(block) : []));
  const scripts = isRecord(raw.scripts) ? raw.scripts : {};
  return Object.freeze({
    packages: new Set(names),
    testScript: typeof scripts.test === "string" ? scripts.test : null,
    packageJsonProblem: null,
  });
}

export function observeRunnerFacts(root: string): RepositoryRunnerFacts {
  return Object.freeze({
    ...packageFacts(root),
    bunLockfile: existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")),
  });
}
