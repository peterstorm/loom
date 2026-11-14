/**
 * The lint-coverage shell (`handlers/lint-coverage-shell.ts`), the SessionStart
 * hook that speaks it (`session-start lint-coverage`) and the `helper
 * lint-coverage` command, over temporary projects and a temporary ignore list
 * (`LOOM_LINT_COVERAGE_IGNORE`), so nothing reads the user's own list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { coverageIgnoreFile, coverageReminderAt, projectCoverageAt, readCoverageIgnoreList } from "../../../src/handlers/lint-coverage-shell";
import { sessionDirectory, sessionStartOutput } from "../../../src/handlers/session-start/lint-coverage";
import { coverageLines } from "../../../src/handlers/helpers/lint-coverage";

const CLI = join(__dirname, "..", "..", "..", "src", "cli.ts");
const RULES_DIR = ".claude/linter/rules";

const FULLY_DECIDED = {
  pureModules: ["src/"],
  declined: [
    { key: "boundaries", reason: "one layer" },
    { key: "requireGovernance", reason: "no boundaries" },
    { key: "docReferences", reason: "no docs" },
  ],
};

let scratch: string;
let project: string;
let ignoreFile: string;

beforeEach(() => {
  scratch = canonicalTempDir("loom-lint-coverage-");
  project = join(scratch, "repo");
  mkdirSync(join(project, "src"), { recursive: true });
  // A real repository: the CLI resolves the repository a helper runs in.
  const init = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
  expect(init.status, init.stderr).toBe(0);
  writeFileSync(join(project, "src", "a.ts"), "export const one = 1;\n");
  ignoreFile = join(scratch, "config", "lint-coverage-ignore.json");
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function writeConfig(config: Readonly<Record<string, unknown>>): void {
  mkdirSync(join(project, RULES_DIR), { recursive: true });
  writeFileSync(join(project, RULES_DIR, "config.json"), JSON.stringify(config));
}

function cli(args: readonly string[], cwd: string, stdin = ""): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const result = spawnSync("bun", [CLI, ...args], {
    cwd,
    input: stdin,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, LOOM_LINT_COVERAGE_IGNORE: ignoreFile },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("coverageIgnoreFile", () => {
  it("is the override when set, else XDG_CONFIG_HOME's loom directory, else ~/.config's", () => {
    expect(coverageIgnoreFile({ LOOM_LINT_COVERAGE_IGNORE: "/x.json", XDG_CONFIG_HOME: "/xdg" })).toBe("/x.json");
    expect(coverageIgnoreFile({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe("/xdg/loom/lint-coverage-ignore.json");
    expect(coverageIgnoreFile({ HOME: "/home/u" })).toBe("/home/u/.config/loom/lint-coverage-ignore.json");
  });
});

describe("projectCoverageAt", () => {
  it("finds the project from a subdirectory, and reads its coverage", () => {
    writeConfig(FULLY_DECIDED);
    const coverage = projectCoverageAt(join(project, "src"));
    expect(coverage).toMatchObject({ kind: "covered", root: project, coverage: { kind: "set-up" } });
  });

  it("a repository with no rules directory has no setup", () => {
    expect(projectCoverageAt(project)).toEqual({ kind: "covered", root: project, coverage: { kind: "no-setup" } });
  });

  it("a directory in no project has nothing to report", () => {
    expect(projectCoverageAt(join(scratch))).toEqual({ kind: "no-project" });
  });

  it("a config the loader refuses is reported, not read as empty", () => {
    writeConfig({ exlude: [] });
    expect(projectCoverageAt(project)).toMatchObject({ kind: "config-refused", root: project, error: expect.stringContaining("unknown key 'exlude'") });
  });
});

describe("coverageReminderAt", () => {
  it("reminds a project with no setup", () => {
    expect(coverageReminderAt(project, ignoreFile)?.forOperator).toBe(`Loom lint: ${project} has no lint setup — ask Claude to turn it on, or silence this for the repository.`);
  });

  it("names the gaps of a set-up project, and is silent once every family is decided", () => {
    writeConfig({ pureModules: ["src/"] });
    expect(coverageReminderAt(project, ignoreFile)?.forOperator).toBe(`Loom lint: 3 rule families are off in ${project} (boundaries, requireGovernance, docReferences).`);
    writeConfig(FULLY_DECIDED);
    expect(coverageReminderAt(project, ignoreFile)).toBeNull();
  });

  it("is silent for a repository on the ignore list, and for a directory in no project", () => {
    mkdirSync(join(scratch, "config"));
    writeFileSync(ignoreFile, JSON.stringify({ ignore: [{ path: project, reason: "not mine" }] }));
    expect(coverageReminderAt(project, ignoreFile)).toBeNull();
    expect(coverageReminderAt(scratch, ignoreFile)).toBeNull();
  });

  it("an ignore list that does not parse is said, never read as 'ignore everything'", () => {
    mkdirSync(join(scratch, "config"));
    writeFileSync(ignoreFile, "{ broken");
    expect(coverageReminderAt(project, ignoreFile)?.forOperator).toMatch(/^Loom lint: the lint-coverage ignore list cannot be read \(.* is not JSON/);
  });

  it("a refused config is said: every edit's lint fails until it is fixed", () => {
    writeConfig({ exlude: [] });
    expect(coverageReminderAt(project, ignoreFile)?.forOperator).toContain(`Loom lint: the rules config of ${project} is refused`);
  });
});

describe("the session-start hook", () => {
  it("reads the session's directory from the payload, else falls back", () => {
    expect(sessionDirectory(JSON.stringify({ cwd: "/w" }), "/f")).toBe("/w");
    expect(sessionDirectory(JSON.stringify({ cwd: "" }), "/f")).toBe("/f");
    expect(sessionDirectory("not json", "/f")).toBe("/f");
  });

  it("speaks to both audiences: the model in additionalContext, the user in systemMessage", () => {
    expect(JSON.parse(sessionStartOutput({ forModel: "model text", forOperator: "user text" }))).toEqual({
      systemMessage: "user text",
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "model text" },
    });
  });

  it("spawned for a project with no setup, prints the reminder JSON and exits 0", () => {
    const result = cli(["session-start", "lint-coverage"], scratch, JSON.stringify({ cwd: project }));
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { systemMessage: string; hookSpecificOutput: { additionalContext: string } };
    expect(output.systemMessage).toContain(`${project} has no lint setup`);
    expect(output.hookSpecificOutput.additionalContext).toContain("<!-- LOOM LINT COVERAGE -->");
  });

  it("spawned for a fully decided project, prints nothing and exits 0", () => {
    writeConfig(FULLY_DECIDED);
    const result = cli(["session-start", "lint-coverage"], scratch, JSON.stringify({ cwd: project }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("helper lint-coverage", () => {
  it("status prints the project, each family's decision and the reminder state", () => {
    writeConfig({ ...FULLY_DECIDED, declined: FULLY_DECIDED.declined.slice(1) });
    const result = cli(["helper", "lint-coverage", "status"], join(project, "src"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe([
      `project: ${project}`,
      "boundaries: GAP — neither configured nor declined",
      "pureModules: configured",
      "requireGovernance: declined — no boundaries",
      "docReferences: declined — no docs",
      "session reminder: on",
      "",
    ].join("\n"));
  });

  it("ignore needs a reason, writes the user's list outside the repository, and unignore takes it off", () => {
    const noReason = cli(["helper", "lint-coverage", "ignore"], project);
    expect(noReason.status).not.toBe(0);
    expect(noReason.stdout + noReason.stderr).toContain("--reason <why> is required");
    expect(existsSync(ignoreFile)).toBe(false);

    const ignored = cli(["helper", "lint-coverage", "ignore", "--reason", "upstream's repository"], join(project, "src"));
    expect(ignored.status, ignored.stderr).toBe(0);
    expect(JSON.parse(readFileSync(ignoreFile, "utf8"))).toEqual({ ignore: [{ path: project, reason: "upstream's repository" }] });
    expect(existsSync(join(project, RULES_DIR))).toBe(false);
    expect(cli(["helper", "lint-coverage", "status"], project).stdout).toContain("session reminder: silenced (ignore list)");
    expect(cli(["session-start", "lint-coverage"], scratch, JSON.stringify({ cwd: project })).stdout).toBe("");

    const unignored = cli(["helper", "lint-coverage", "unignore"], project);
    expect(unignored.status, unignored.stderr).toBe(0);
    expect(readCoverageIgnoreList(ignoreFile)).toEqual({ ok: true, value: [] });
  });

  it("outside every project, there is nothing to ignore", () => {
    const result = cli(["helper", "lint-coverage", "ignore", "--reason", "x"], scratch);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("not in a project");
  });

  it("coverageLines says a project with no setup has only the shipped rules", () => {
    expect(coverageLines({ kind: "no-setup" })).toEqual(["no lint setup: only the shipped rules run (lint-project --init turns every family on)"]);
  });
});
