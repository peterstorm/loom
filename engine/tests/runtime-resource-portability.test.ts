import { describe, expect, it } from "vitest";
import { canonicalTempDir } from "./fixtures/canonical-temp-dir";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { renderMarkdownForPi } from "../src/core/harness-resources";
import { resolveInitialState } from "../src/phase-init";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_URL = pathToFileURL(join(REPO_ROOT, "engine/src/config.ts")).href;
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
const MARKDOWN_CASES = FILES.map((file) => [relative(REPO_ROOT, file), file] as const);
const LEGACY_LOOM_CACHE = /\.claude\/plugins\/cache[^\n`]*loom|plugins\/cache\/plugins\/loom|LOOM_DIR=.*plugins\/cache/;

// Discovery tests intentionally leave LOOM_STATE_PATH unset: only their
// disposable cwd and explicit harness marker may decide native/legacy fallback.
function discoveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_CODING_AGENT;
  delete env.PI_CODING_AGENT_DIR;
  delete env.LOOM_STATE_PATH;
  return env;
}

describe("Pi harness detection", () => {
  it.each([
    ["absent", null, ".pi/state/active_task_graph.json"],
    ["legacy", ".claude/state/active_task_graph.json", ".claude/state/active_task_graph.json"],
    ["native", ".pi/state/active_task_graph.json", ".pi/state/active_task_graph.json"],
  ] as const)("uses the Pi process marker with %s state and no agent-directory override", (_label, presentGraph, expectedPath) => {
    const root = canonicalTempDir("loom-pi-marker-");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      if (presentGraph !== null) {
        mkdirSync(dirname(join(root, presentGraph)), { recursive: true });
        writeFileSync(join(root, presentGraph), JSON.stringify(resolveInitialState({}, root)));
      }
      const run = spawnSync(BUN, ["-e", [
        `import { HARNESS, TASK_GRAPH_PATH, PROJECT_RULES_DIR } from ${JSON.stringify(CONFIG_URL)};`,
        "console.log(JSON.stringify({ HARNESS, TASK_GRAPH_PATH, PROJECT_RULES_DIR }));",
      ].join(" ")], {
        cwd: root,
        env: { ...discoveryEnv(), PI_CODING_AGENT: "true" },
        encoding: "utf-8",
      });

      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        HARNESS: "pi",
        TASK_GRAPH_PATH: expectedPath,
        PROJECT_RULES_DIR: ".pi/linter/rules",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes legacy Claude state when Pi-native state is absent", () => {
    const root = canonicalTempDir("loom-pi-state-fallback-");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const legacy = ".claude/state/active_task_graph.json";
      mkdirSync(join(root, ".claude", "state"), { recursive: true });
      writeFileSync(join(root, legacy), JSON.stringify(resolveInitialState({}, root)));
      const script = [
        `import { TASK_GRAPH_PATH, guardedDirs } from ${JSON.stringify(CONFIG_URL)};`,
        "console.log(JSON.stringify({ taskGraphPath: TASK_GRAPH_PATH, guardedDirs: guardedDirs() }));",
      ].join(" ");
      const env: NodeJS.ProcessEnv = { ...discoveryEnv(), PI_CODING_AGENT: "true" };
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
      writeFileSync(join(root, ".pi", "state", "active_task_graph.json"), JSON.stringify(resolveInitialState({}, root)));
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
  const configScript = `import { TASK_GRAPH_PATH } from ${JSON.stringify(CONFIG_URL)}; console.log(TASK_GRAPH_PATH);`;

  function fakeGit(root: string, stderr: string, status: number): string {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit ${status}\n`);
    chmodSync(git, 0o755);
    return bin;
  }

  it("fails closed when Git cannot prove the root from a nested repository cwd", () => {
    const root = canonicalTempDir("loom-git-root-failure-");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      mkdirSync(join(root, ".claude", "state"), { recursive: true });
      writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), "{}\n");
      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      const bin = fakeGit(root, "fatal: detected dubious ownership in repository", 128);

      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: nested,
        env: { ...discoveryEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("git rev-parse failed (exited 128)");
      expect(run.stderr).toContain("dubious ownership");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a fatal exit whose stderr never arrived as a lost capture after the bounded retries", () => {
    // The macos-15 verify failure (run 37744264682) surfaced this as
    // `git rev-parse failed (exit 128): no diagnostic` in a non-repository.
    const root = canonicalTempDir("loom-git-silent-fatal-");
    try {
      const bin = fakeGit(root, "", 128);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...discoveryEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        `git rev-parse failed (exited 128) for ${root} (confirmed after bounded retries): stderr empty, stdout 0 bytes — ` +
        "Git writes a diagnostic for every fatal exit",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)("rejects Git's non-repository diagnostic when ancestor metadata exists but is unreadable", () => {
    const root = canonicalTempDir("loom-unreadable-git-root-");
    const gitDirectory = join(root, ".git");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      chmodSync(gitDirectory, 0o000);

      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: nested,
        env: discoveryEnv(),
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/repository metadata|git rev-parse failed|cannot inspect repository metadata/);
    } finally {
      chmodSync(gitDirectory, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-repository diagnostic when readable ancestor metadata exists", () => {
    const root = canonicalTempDir("loom-readable-git-root-");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      const bin = fakeGit(root, "fatal: not a git repository (or any of the parent directories): .git", 128);

      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: nested,
        env: { ...discoveryEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(`git reported no repository, but repository metadata exists at ${join(root, ".git")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the Git executable cannot start", () => {
    const root = canonicalTempDir("loom-missing-git-");
    try {
      const emptyPath = join(root, "empty-bin");
      mkdirSync(emptyPath);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...discoveryEnv(), PATH: emptyPath },
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
    const root = canonicalTempDir("loom-empty-git-root-");
    try {
      const bin = fakeGit(root, "", 0);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...discoveryEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("git rev-parse returned an empty repository root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses cwd-relative creation authority only for a proven non-repository", () => {
    const root = canonicalTempDir("loom-no-git-root-");
    try {
      const bin = fakeGit(root, "fatal: not a git repository (or any of the parent directories): .git", 128);
      const run = spawnSync(BUN, ["-e", configScript], {
        cwd: root,
        env: { ...discoveryEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` },
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

  it.each(MARKDOWN_CASES)(
    "%s never discovers Loom through the Claude plugin cache",
    (_relativePath, file) => {
      expect(readFileSync(file, "utf-8")).not.toMatch(LEGACY_LOOM_CACHE);
    },
  );

  it.each(MARKDOWN_CASES)(
    "%s has no unresolved Claude root after Pi lowering",
    (_relativePath, file) => {
      const rendered = renderMarkdownForPi(readFileSync(file, "utf-8"), "/active/loom-package");
      expect(rendered.ok).toBe(true);
      if (rendered.ok) expect(rendered.value).not.toMatch(/\$\{?CLAUDE_PLUGIN_ROOT\}?/);
    },
  );
});
