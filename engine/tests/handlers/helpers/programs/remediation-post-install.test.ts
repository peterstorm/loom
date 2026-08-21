import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { driveRemediationFacade } from "../../../../src/handlers/helpers/programs/remediation";
import type { RegisteredRemediationProgram } from "../../../../src/handlers/helpers/programs/helpers";
import { openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";

const ENGINE = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function runCli(repository: string, args: readonly string[], input = "") {
  return spawnSync("bun", [CLI, "helper", "orchestration", ...args], {
    cwd: repository,
    encoding: "utf8",
    input,
    env: process.env,
  });
}

async function completedReviewFixture() {
  const repository = mkdtempSync(join(tmpdir(), "loom-remediation-post-install-repo-"));
  const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-remediation-post-install-runs-")));
  cleanup.push(repository, runsRoot);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  git(repository, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repository, "a.txt"), "old\n");
  git(repository, ["add", "a.txt"]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  writeFileSync(join(repository, "a.txt"), "new\n");

  const sourceRun = "source";
  const started = runCli(
    repository,
    ["start", "standalone-review", "--runs-root", runsRoot, "--run", sourceRun],
    JSON.stringify({ kind: "comments", files: ["a.txt"], dryRun: false }),
  );
  expect(started.status, started.stderr).toBe(0);
  const action = JSON.parse(started.stdout) as {
    requests: readonly { authority: AgentRequestAuthority }[];
  };
  const source = openRunDirectory(runsRoot, sourceRun);
  if (!source.ok) throw new Error(source.error.message);
  const transcript = [
    "### Machine Summary",
    "CRITICAL_COUNT: 0",
    "ADVISORY_COUNT: 0",
    "",
    "```findings",
    "[]",
    "```",
  ].join("\n");
  for (const { authority } of action.requests) {
    const captured = await source.value.captureTranscript(authority, [...Buffer.from(transcript)]);
    if (!captured.ok) throw new Error(captured.error.message);
  }
  const completed = runCli(repository, ["resume", "--runs-root", runsRoot, "--run", sourceRun]);
  expect(completed.status, completed.stderr).toBe(0);
  expect(JSON.parse(completed.stdout).kind).toBe("done");

  const remediationRun = "remediation";
  mkdirSync(join(runsRoot, remediationRun));
  const remediation = openRunDirectory(runsRoot, remediationRun);
  if (!remediation.ok) throw new Error(remediation.error.message);
  return { repository, runsRoot, sourceRun, remediation: remediation.value };
}

describe.sequential("remediation post-install checkpoint boundary", () => {
  it("retains installation evidence when the full driver cannot checkpoint after installing", async () => {
    const fixture = await completedReviewFixture();
    const checkpointFailingHandle = {
      runId: fixture.remediation.runId,
      writeCheckpoint: async () => { throw new Error("disk full"); },
    } as unknown as RunDirHandle;
    const registration: RegisteredRemediationProgram = {
      schemaVersion: 1,
      kind: "remediation",
      input: {
        sourceRunsRoot: fixture.runsRoot,
        sourceRun: fixture.sourceRun,
        supportPaths: [],
      },
    };

    const previousCwd = process.cwd();
    let driven;
    try {
      process.chdir(fixture.repository);
      driven = await driveRemediationFacade(checkpointFailingHandle, registration);
    } finally {
      process.chdir(previousCwd);
    }

    expect(driven.ok).toBe(false);
    if (driven.ok) return;
    expect(driven.message).toContain("verified index was installed");
    expect(driven.message).toContain("checkpoint recording failed: disk full");
    expect(driven.message).toContain('"kind":"verified-index-installed"');
    expect(driven.message).not.toContain("remediation-blocked");
    expect(git(fixture.repository, ["diff", "--cached", "--name-only"]).trim()).toBe("a.txt");
  }, 30_000);
});
