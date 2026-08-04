import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdownForPi } from "../src/core/harness-resources";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_TREES = ["agents", "commands", "skills", "references"] as const;

function markdownFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extname(entry.name) === ".md") files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

const FILES = RUNTIME_TREES.flatMap((tree) => markdownFiles(join(REPO_ROOT, tree)));
const LEGACY_LOOM_CACHE = /\.claude\/plugins\/cache[^\n`]*loom|plugins\/cache\/plugins\/loom|LOOM_DIR=.*plugins\/cache/;

describe("runtime markdown is portable across harnesses", () => {
  it("scans a non-vacuous command/skill/agent/reference surface", () => {
    expect(FILES.length).toBeGreaterThan(100);
    for (const tree of RUNTIME_TREES) {
      expect(FILES.some((file) => relative(REPO_ROOT, file).startsWith(`${tree}/`))).toBe(true);
    }
  });

  it.each(FILES.map((file) => [relative(REPO_ROOT, file), file] as const))(
    "%s never discovers Loom through the Claude plugin cache",
    (_relativePath, file) => {
      expect(readFileSync(file, "utf-8")).not.toMatch(LEGACY_LOOM_CACHE);
    },
  );

  it.each(FILES.map((file) => [relative(REPO_ROOT, file), file] as const))(
    "%s has no unresolved Claude root after Pi lowering",
    (_relativePath, file) => {
      const rendered = renderMarkdownForPi(readFileSync(file, "utf-8"), "/active/loom-package");
      expect(rendered).not.toMatch(/\$\{?CLAUDE_PLUGIN_ROOT\}?/);
    },
  );
});
