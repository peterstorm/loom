/**
 * Static guard for the one Git spawn seam: no engine or Pi source file may
 * spawn `git` except `utils/git-execution-policy.ts`, and no file may obtain
 * process-spawning authority at all unless it is on the justified allowlist
 * below. The scan reads source text, so a new direct spawn fails here before
 * any behavioural test has to notice that its child ran with ambient config.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_ROOTS = ["engine/src", "pi"] as const;
const SEAM = "engine/src/utils/git-execution-policy.ts";

/** Files that may hold runtime process-spawning authority, and why. Each one's
 *  own Git observations (if any) still go through the seam; what it spawns
 *  directly is never `git`. */
const SPAWN_AUTHORITY_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  [SEAM]: "the one policy-bound Git spawn",
  "engine/src/handlers/helpers/complete-wave-gate.ts": "runs the operator's authenticated `gh` CLI for issue bodies and comments",
  "engine/src/orchestration/completion-check-runner.ts":
    "runs the operator's verification-manifest project command (any executable, no shell); its Git probes use the seam",
  "pi/interactive-subagent.ts": "spawns the Pi RPC subagent child process",
});

/** A runtime (non-type-only) import or require of the child-process module,
 *  or Bun's spawn API. */
const SPAWN_AUTHORITY = [
  /^\s*import\s+(?!type\b)[^;]*?from\s*["'](?:node:)?child_process["']/m,
  /\brequire\(\s*["'](?:node:)?child_process["']\s*\)/,
  /\bimport\(\s*["'](?:node:)?child_process["']\s*\)/,
  /\bBun\.spawn(?:Sync)?\b/,
] as const;

/** `git` named as an executable: a bare quoted `git` literal (an
 *  execFile/spawn argument or a constant holding one) or a command string
 *  opening with `git `. A backticked bare `git` is prose in a doc comment, so
 *  only the command-string form counts for template literals. */
const GIT_EXECUTABLE = [
  /(["'])git\1/,
  /\b(?:execSync|exec|spawn|spawnSync|execFile|execFileSync)\(\s*(["'`])git\s/,
] as const;

function spawnViolations(path: string, source: string): readonly string[] {
  const violations: string[] = [];
  if (path !== SEAM && GIT_EXECUTABLE.some((pattern) => pattern.test(source))) {
    violations.push(`${path}: names git as an executable outside ${SEAM}`);
  }
  if (!(path in SPAWN_AUTHORITY_ALLOWLIST) && SPAWN_AUTHORITY.some((pattern) => pattern.test(source))) {
    violations.push(`${path}: holds process-spawning authority but is not on the justified allowlist`);
  }
  return violations;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name) ? [path] : [];
  });
}

describe("the engine has exactly one place that spawns git", () => {
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root)))
    .map((absolute) => relative(REPOSITORY_ROOT, absolute).split("\\").join("/"));

  it("scans a non-trivial source tree that includes the seam and every allowlisted file", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const path of Object.keys(SPAWN_AUTHORITY_ALLOWLIST)) expect(files, path).toContain(path);
  });

  it("finds no direct Git spawn and no unlisted spawn authority in engine/src or pi", () => {
    const violations = files.flatMap((path) => spawnViolations(path, readFileSync(join(REPOSITORY_ROOT, path), "utf-8")));
    expect(violations).toEqual([]);
  });

  it("keeps the seam itself the one file that names git as an executable", () => {
    expect(GIT_EXECUTABLE.some((pattern) => pattern.test(readFileSync(join(REPOSITORY_ROOT, SEAM), "utf-8")))).toBe(true);
  });

  it.each([
    ["a direct execFileSync", 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"]);'],
    ["a spawnSync through a named constant", "import { spawnSync } from 'node:child_process';\nconst GIT = 'git';\nspawnSync(GIT, []);"],
    ["a shell command string", 'import { execSync } from "child_process";\nexecSync(`git rev-parse HEAD`);'],
    ["a dynamic import", 'const { spawnSync } = await import("node:child_process");'],
    ["Bun's spawn API", 'Bun.spawnSync(["ls"]);'],
  ])("flags %s outside the allowlist", (_label, source) => {
    expect(spawnViolations("engine/src/handlers/helpers/example.ts", source)).not.toEqual([]);
  });

  it("allows a type-only child-process import and prose that merely mentions git", () => {
    const source = "import type { SpawnSyncReturns } from 'node:child_process';\n// runs git rev-parse through the seam\n";
    expect(spawnViolations("engine/src/handlers/helpers/example.ts", source)).toEqual([]);
  });

  it("still flags git named as an executable inside an allowlisted spawner", () => {
    const source = 'import { spawn } from "node:child_process";\nspawn("git", ["fetch"]);';
    expect(spawnViolations("engine/src/orchestration/completion-check-runner.ts", source)).toEqual([
      "engine/src/orchestration/completion-check-runner.ts: names git as an executable outside engine/src/utils/git-execution-policy.ts",
    ]);
  });
});
