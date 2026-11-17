/**
 * What a repository shows about its test runner, read for the runner-preset
 * suggestion (`core/runner-presets.ts`, loom#198 Cause 3). Read-only, and
 * total: a missing or unreadable `package.json` is a repository with no
 * packages, never a failure, because the facts only ever feed a suggestion.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../core/plain-record";
import type { RepositoryRunnerFacts } from "../core/runner-presets";

const NO_PACKAGE: Readonly<{ packages: ReadonlySet<string>; testScript: string | null }> =
  Object.freeze({ packages: new Set<string>(), testScript: null });

function packageFacts(root: string): Readonly<{ packages: ReadonlySet<string>; testScript: string | null }> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return NO_PACKAGE;
  }
  if (!isRecord(raw)) return NO_PACKAGE;
  const names = [raw.dependencies, raw.devDependencies].flatMap((block) => (isRecord(block) ? Object.keys(block) : []));
  const scripts = isRecord(raw.scripts) ? raw.scripts : {};
  return Object.freeze({ packages: new Set(names), testScript: typeof scripts.test === "string" ? scripts.test : null });
}

export function observeRunnerFacts(root: string): RepositoryRunnerFacts {
  return Object.freeze({
    ...packageFacts(root),
    bunLockfile: existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")),
  });
}
