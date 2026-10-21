import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAuthorizedWaveCompletionCheck, type AuthorizedWaveCompletionCheck } from "../../src/core/completion-suite";
import { HOOK_INVOCATION_VARIABLES, projectCommandEnvironment } from "../../src/core/project-command-environment";
import { runCompletionCheck } from "../../src/orchestration/completion-check-runner";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureRoot(): CanonicalRepositoryRoot {
  const root = canonicalTempDir("loom-project-command-env-");
  roots.push(root);
  if (spawnSync("git", ["init", "--quiet"], { cwd: root }).status !== 0) throw new Error("fixture Git init failed");
  writeFileSync(
    join(root, "print-env.mjs"),
    "process.stdout.write(JSON.stringify(Object.fromEntries(process.argv.slice(2).map((n) => [n, process.env[n] ?? null]))));\n",
  );
  const parsed = parseCanonicalRepositoryRoot(root);
  if (!parsed.ok) throw new Error("fixture root observation drifted");
  return parsed.value;
}

/** A project command that prints the named variables as JSON, `null` for an unset one. */
function printEnvironment(names: readonly string[]): ProjectCommandCheck {
  const parsed = parseAuthorizedWaveCompletionCheck({
    kind: "project-command",
    checkId: "project:print-env",
    scope: "wave",
    executable: "node",
    args: ["print-env.mjs", ...names],
    cwd: ".",
    timeoutMs: 5_000,
    reportPolicy: { kind: "not-required" },
  });
  if (!parsed.ok || parsed.value.kind !== "project-command") throw new Error("invalid test check");
  return parsed.value;
}

describe("projectCommandEnvironment", () => {
  it("drops exactly the hook-invocation variables and keeps everything else", () => {
    const environment = {
      CLAUDE_PROJECT_DIR: "/repo",
      CLAUDE_PLUGIN_ROOT: "/plugin",
      CLAUDE_PLUGIN_DATA: "/data",
      CLAUDE_ENV_FILE: "/env",
      CLAUDE_CODE_SESSION_ID: "session",
      PATH: "/usr/bin",
      LOOM_SUBAGENT_DIR: "/tmp/subagents",
    };
    expect(projectCommandEnvironment(environment)).toEqual({
      CLAUDE_CODE_SESSION_ID: "session",
      PATH: "/usr/bin",
      LOOM_SUBAGENT_DIR: "/tmp/subagents",
    });
    expect(environment.CLAUDE_PROJECT_DIR).toBe("/repo");
  });

  it("is the identity on an environment that carries no hook-invocation variable", () => {
    const environment = { PATH: "/usr/bin", HOME: "/home/operator" };
    expect(projectCommandEnvironment(environment)).toEqual(environment);
  });
});

describe("a project command launched from inside a hook", () => {
  it("runs without the hook's invocation variables, as it would from the operator's shell", async () => {
    for (const name of HOOK_INVOCATION_VARIABLES) vi.stubEnv(name, `/hook/${name}`);
    vi.stubEnv("LOOM_PROJECT_COMMAND_PROBE", "kept");
    const result = await runCompletionCheck(
      printEnvironment([...HOOK_INVOCATION_VARIABLES, "LOOM_PROJECT_COMMAND_PROBE"]),
      fixtureRoot(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkResult.outcome).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(JSON.parse(result.value.diagnostics.stdoutTail)).toEqual({
      CLAUDE_PROJECT_DIR: null,
      CLAUDE_PLUGIN_ROOT: null,
      CLAUDE_PLUGIN_DATA: null,
      CLAUDE_ENV_FILE: null,
      LOOM_PROJECT_COMMAND_PROBE: "kept",
    });
  });
});
