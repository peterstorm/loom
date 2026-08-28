import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { renderMarkdownForPi } from "../src/core/harness-resources";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_TREES = ["agents", "commands", "skills", "references"] as const;
const BUN = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();

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

describe("Pi harness detection", () => {
  it("uses the Pi process marker when no agent-directory override is set", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT: "true" };
    delete env.PI_CODING_AGENT_DIR;
    delete env.LOOM_STATE_PATH;
    const run = spawnSync("bun", ["-e", [
      'import { HARNESS, TASK_GRAPH_PATH, PROJECT_RULES_DIR } from "./engine/src/config.ts";',
      "console.log(JSON.stringify({ HARNESS, TASK_GRAPH_PATH, PROJECT_RULES_DIR }));",
    ].join(" ")], { cwd: REPO_ROOT, env, encoding: "utf-8" });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      HARNESS: "pi",
      TASK_GRAPH_PATH: ".pi/state/active_task_graph.json",
      PROJECT_RULES_DIR: ".pi/linter/rules",
    });
  });

  it("resumes legacy Claude state when Pi-native state is absent", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-pi-state-fallback-")));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const legacy = ".claude/state/active_task_graph.json";
      mkdirSync(join(root, ".claude", "state"), { recursive: true });
      writeFileSync(join(root, legacy), "{}\n");
      const configUrl = pathToFileURL(join(REPO_ROOT, "engine/src/config.ts")).href;
      const script = [
        `import { TASK_GRAPH_PATH, guardedDirs } from ${JSON.stringify(configUrl)};`,
        "console.log(JSON.stringify({ taskGraphPath: TASK_GRAPH_PATH, guardedDirs: guardedDirs() }));",
      ].join(" ");
      const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT: "true" };
      delete env.PI_CODING_AGENT_DIR;
      delete env.LOOM_STATE_PATH;
      delete env.LOOM_SUBAGENT_DIR;
      delete env.LOOM_MACHINES_DIR;

      const legacyRun = spawnSync("bun", ["-e", script], { cwd: root, env, encoding: "utf-8" });
      expect(legacyRun.status, legacyRun.stderr).toBe(0);
      expect(JSON.parse(legacyRun.stdout)).toEqual({
        taskGraphPath: legacy,
        guardedDirs: [".pi/state", ".claude/state", ".loom", "/tmp/claude-subagents", join(REPO_ROOT, "machines")],
      });

      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      const walkUpRun = spawnSync("bun", ["-e", script], { cwd: nested, env, encoding: "utf-8" });
      expect(walkUpRun.status, walkUpRun.stderr).toBe(0);
      expect(JSON.parse(walkUpRun.stdout).taskGraphPath).toBe(join(root, legacy));

      mkdirSync(join(root, ".pi", "state"), { recursive: true });
      writeFileSync(join(root, ".pi", "state", "active_task_graph.json"), "{}\n");
      const nativeRun = spawnSync("bun", ["-e", script], { cwd: root, env, encoding: "utf-8" });
      expect(nativeRun.status, nativeRun.stderr).toBe(0);
      expect(JSON.parse(nativeRun.stdout).taskGraphPath).toBe(".pi/state/active_task_graph.json");

      const overrideRun = spawnSync("bun", ["-e", script], {
        cwd: root,
        env: { ...env, LOOM_STATE_PATH: "custom/state.json" },
        encoding: "utf-8",
      });
      expect(overrideRun.status, overrideRun.stderr).toBe(0);
      expect(JSON.parse(overrideRun.stdout).taskGraphPath).toBe("custom/state.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("TaskGraph repository-root discovery", () => {
  const configScript = `import { TASK_GRAPH_PATH } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "engine/src/config.ts")).href)}; console.log(TASK_GRAPH_PATH);`;

  function fakeGit(root: string, stderr: string, status: number): string {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit ${status}\n`);
    chmodSync(git, 0o755);
    return bin;
  }

  it("fails closed when Git cannot prove the root from a nested repository cwd", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-git-root-failure-")));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      mkdirSync(join(root, ".claude", "state"), { recursive: true });
      writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), "{}\n");
      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      const bin = fakeGit(root, "fatal: detected dubious ownership in repository", 128);

      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: nested,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("git rev-parse failed (exit 128)");
      expect(run.stderr).toContain("dubious ownership");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Git's non-repository diagnostic when ancestor metadata exists but is unreadable", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-unreadable-git-root-")));
    const gitDirectory = join(root, ".git");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      chmodSync(gitDirectory, 0o000);

      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: nested,
        env: process.env,
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/repository metadata|git rev-parse failed|cannot inspect repository metadata/);
    } finally {
      chmodSync(gitDirectory, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the Git executable cannot start", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-missing-git-")));
    try {
      const emptyPath = join(root, "empty-bin");
      mkdirSync(emptyPath);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...process.env, PATH: emptyPath },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("git rev-parse could not start");
      expect(run.stderr).toMatch(/ENOENT|not found/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Git reports success without a repository root", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-empty-git-root-")));
    try {
      const bin = fakeGit(root, "", 0);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("git rev-parse returned an empty repository root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses cwd-relative creation authority only for a proven non-repository", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-no-git-root-")));
    try {
      const bin = fakeGit(root, "fatal: not a git repository (or any of the parent directories): .git", 128);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe(".claude/state/active_task_graph.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
      expect(rendered.ok).toBe(true);
      if (rendered.ok) expect(rendered.value).not.toMatch(/\$\{?CLAUDE_PLUGIN_ROOT\}?/);
    },
  );
});
