/**
 * What the clone detector's tests share: thresholds through the one parser,
 * source blocks that are clones of nothing but themselves, and throwaway
 * projects that take their fingerprint cache with them when they go.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCloneOptions, type CloneOptions } from "../../src/linter/clones/clone-detection";
import { defaultCacheFile } from "../../src/linter/clones/project-corpus";
import { CLAUDE_PROJECT_RULES_DIR } from "../../src/linter/programmatic/config";
import { canonicalTempDir } from "./canonical-temp-dir";

/** Thresholds as clone options; throws on anything but two positive integers. */
export function cloneOptions(minTokens: number, minLines: number): CloneOptions {
  const parsed = parseCloneOptions({ minTokens, minLines });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** `count` statements, one per line, each made of tokens no block of another name shares. */
export const block = (name: string, count: number): string =>
  Array.from({ length: count }, (_, row) => `const ${name}${row} = compute${name}(${row}, "${name}");`).join("\n");

export type CloneProjects = Readonly<{
  /** A project holding `files`; with `config`, also a rules directory carrying it as `config.json`. */
  create: (files: Readonly<Record<string, string>>, config?: Readonly<Record<string, unknown>>) => string;
  /** The rules directory `create` writes when given a config. */
  rulesDir: (root: string) => string;
  /** Remove every project created, and the fingerprint cache an edit-tier run left for it under the temp directory. */
  dispose: () => void;
}>;

/** Temp projects for one test file: call `dispose` in `afterEach`. */
export function cloneProjects(prefix: string): CloneProjects {
  const roots: string[] = [];
  const rulesDir = (root: string): string => join(root, CLAUDE_PROJECT_RULES_DIR);
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  return {
    create: (files, config) => {
      const root = canonicalTempDir(prefix);
      roots.push(root);
      if (config !== undefined) write(join(rulesDir(root), "config.json"), JSON.stringify(config));
      for (const [path, content] of Object.entries(files)) write(join(root, path), content);
      return root;
    },
    rulesDir,
    dispose: () => {
      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
        rmSync(defaultCacheFile(root), { force: true });
      }
    },
  };
}
