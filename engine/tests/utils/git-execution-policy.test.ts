/**
 * The shared Git execution policy, pinned at its own interface: the
 * allow-listed environment, and `core.fsmonitor` disabled in BOTH forms — the
 * `-c` argv prefix every Git honours and the GIT_CONFIG_COUNT/KEY/VALUE
 * environment form only Git 2.31+ honours. The real-Git cases strip the
 * environment form to stand in for an older Git, proving the argv form alone
 * keeps a repository-configured fsmonitor hook from running.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenedGitInvocation } from "../../src/utils/git-execution-policy";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { git } from "../fixtures/git-repository";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withAmbient<T>(variables: Readonly<Record<string, string>>, run: () => T): T {
  const previous = new Map(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The policy's environment as a Git older than 2.31 sees it: no environment config. */
function withoutEnvironmentConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_CONFIG_") || key === "GIT_CONFIG_NOSYSTEM" || key === "GIT_CONFIG_GLOBAL"));
}

/** A repository whose own config names an fsmonitor hook that leaves a marker. */
function fsmonitorRepository(): Readonly<{ root: string; marker: string }> {
  const root = canonicalTempDir("loom-git-policy-");
  cleanup.push(root);
  const marker = join(root, "FSMONITOR_EXECUTED");
  git(root, ["init", "--quiet"]);
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["-c", "user.email=loom@example.invalid", "-c", "user.name=Loom", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "base"]);
  const hook = join(root, "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  git(root, ["config", "core.fsmonitor", hook]);
  return Object.freeze({ root, marker });
}

function run(root: string, argv: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync("git", [...argv], { cwd: root, env, encoding: "utf-8" });
}

describe("hardenedGitInvocation", () => {
  it("drops every ambient GIT_* variable and keeps only launch essentials", () => {
    const { env } = withAmbient({
      GIT_DIR: "/attacker/.git",
      GIT_WORK_TREE: "/attacker",
      GIT_INDEX_FILE: "/attacker/index",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "diff.external",
      GIT_CONFIG_VALUE_1: "sh -c 'touch /tmp/owned'",
      GIT_EXTERNAL_DIFF: "sh",
      GIT_LITERAL_PATHSPECS: "1",
      LOOM_UNRELATED: "leak",
    }, () => hardenedGitInvocation(["status"]));

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_LITERAL_PATHSPECS).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
    expect(env.LOOM_UNRELATED).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env).toMatchObject({
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("puts the command-scope fsmonitor override ahead of the command's own argv", () => {
    expect(hardenedGitInvocation(["--literal-pathspecs", "ls-files", "-z"]).argv)
      .toEqual(["-c", "core.fsmonitor=false", "--literal-pathspecs", "ls-files", "-z"]);
  });

  it("relocates the repository only through the closed location overlay", () => {
    const location = {
      GIT_DIR: "/shadow",
      GIT_WORK_TREE: "/work",
      GIT_INDEX_FILE: "/work/.git/index",
      GIT_OBJECT_DIRECTORY: "/work/.git/objects",
    };
    const { env } = withAmbient({ GIT_DIR: "/attacker/.git" }, () => hardenedGitInvocation(["diff"], location));
    expect(env).toMatchObject({ ...location, GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" });
  });

  it("returns an immutable invocation", () => {
    const invocation = hardenedGitInvocation(["status"]);
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.argv)).toBe(true);
    expect(Object.isFrozen(invocation.env)).toBe(true);
  });

  it("makes Git read core.fsmonitor as false even when the environment config form is ignored", () => {
    const { root } = fsmonitorRepository();
    const { argv, env } = hardenedGitInvocation(["config", "--get", "core.fsmonitor"]);

    expect(run(root, argv, env).stdout.trim()).toBe("false");
    expect(run(root, argv, withoutEnvironmentConfig(env)).stdout.trim()).toBe("false");
  });

  it("never runs a repository-configured fsmonitor hook, on the argv form alone", () => {
    const { root, marker } = fsmonitorRepository();
    // Control: the fixture's hook really runs for an unhardened Git.
    const bare = hardenedGitInvocation(["status", "--porcelain"]);
    expect(run(root, ["status", "--porcelain"], withoutEnvironmentConfig(bare.env)).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const { argv, env } = hardenedGitInvocation(["status", "--porcelain"]);
    expect(run(root, argv, withoutEnvironmentConfig(env)).status).toBe(0);
    expect(run(root, argv, env).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
