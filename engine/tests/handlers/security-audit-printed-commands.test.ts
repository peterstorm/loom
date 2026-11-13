/**
 * Every command the security-audit program prints for someone to run must run
 * as printed.
 *
 * The program used to print `loom helper …`, and no `loom` binary exists:
 * neither `package.json` declares a `bin`. The docs papered over it with an
 * alias the reader had to substitute by hand. Whoever runs a printed line — the
 * operator, the parent session, a hunter — is working in the audited
 * repository, so the only spelling that runs there is the executing package's
 * own `cli.ts` by absolute path (`core/loom-cli-command`), and the only path to
 * the sandbox script or a lens document that names anything there is absolute
 * too.
 *
 * Three bindings: the transcript of a whole run (start to disposition), the
 * engine sources that could print such a line, and the documents that relay the
 * program's printed lines to a reader.
 */

import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { aRun, assignUnit, claimPayload, must, removeRuns, startRun } from "./security-audit-harness";
import type { Run } from "./security-audit-run-seam";
import { verifyWith } from "./security-verification-harness";

/** The words every printed helper command starts with. */
const HELPER = `bun '${join(LOOM_PACKAGE_ROOT, "engine", "src", "cli.ts")}' helper `;

/** The form that names a binary nobody installs. */
const UNINSTALLED = "loom helper";

/** A line that IS a command: a helper operation followed by a flag. Prose that
 *  merely names an operation (`run \`publish\` first`) carries no flag. */
const COMMAND_LINE = /\bhelper (?:security-audit|orchestration) [a-z-]+ (?:[a-z-]+ )?--/;

const ARTIFACT = "agents/security-hunter-agent/artifacts/repro.txt";

let scratch: string;
let target: string;

beforeEach(() => {
  // Real paths: the capture path reads transcripts under LOOM_SUBAGENT_DIR
  // without following symlinks (macOS `/var` → `/private/var`).
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-security-printed-")));
  // Outside the run directory: `nonce` refuses a run whose scratch the sandbox
  // would refuse, and this suite needs the sandbox instructions it prints.
  target = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-security-printed-target-")));
  vi.stubEnv("LOOM_SUBAGENT_DIR", join(scratch, "bindings"));
  vi.stubEnv("LOOM_ORCHESTRATION_RUNS_ROOT", undefined);
  vi.stubEnv("LOOM_ORCHESTRATION_RUN_DIR", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRuns();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

/** What each operation of one whole run printed, in the order an operator runs them. */
async function wholeRunTranscript(): Promise<ReadonlyMap<string, string>> {
  const printed = new Map<string, string>();
  const run: Run = aRun();
  const step = async (name: string, act: () => Promise<unknown>): Promise<void> => {
    await act();
    printed.set(name, run.stdout());
  };
  await step("start", () => startRun(run, { repo: target, signals: { languages: ["typescript"], servesHttp: true } }));
  await step("assign", () => assignUnit(run, 0));
  await step("nonce", () => must(run, ["nonce", "--artifact", ARTIFACT]));
  await step("submit", () => must(run, ["submit"], claimPayload(0)));
  await step("status", () => must(run, ["status"]));
  await step("status --json", () => must(run, ["status", "--json"]));
  await step("verify", () => verifyWith(run));
  await step("publish", () => must(run, ["publish"]));
  await step("findings", () => must(run, ["findings"]));
  await step("disposition", () => must(run, ["disposition"]));
  printed.set("REPORT.md", readFileSync(join(run.out, "REPORT.md"), "utf8"));
  return printed;
}

describe("what the security-audit program prints", () => {
  it("never names the `loom` binary, and starts every command with the executing package's own CLI", async () => {
    const transcript = await wholeRunTranscript();
    for (const [operation, text] of transcript) {
      expect(text, operation).not.toContain(UNINSTALLED);
      for (const line of text.split("\n").filter((candidate) => COMMAND_LINE.test(candidate))) {
        expect(line, operation).toContain(HELPER);
      }
    }
    // Not vacuous: each of these operations does print a command to run.
    const commandsOf = (operation: string): number =>
      (transcript.get(operation) ?? "").split("\n").filter((line) => COMMAND_LINE.test(line)).length;
    expect(commandsOf("assign")).toBe(1); // the nonce line
    expect(commandsOf("status")).toBe(2); // the verification start and its import
    expect(commandsOf("status --json")).toBe(2); // the same two, as `command` and `importCommand`
    expect(commandsOf("disposition")).toBe(1); // the handoff
    expect(commandsOf("REPORT.md")).toBe(1); // the same handoff, published
  });

  it("names the sandbox script and every selected lens by an absolute path in the package", async () => {
    const transcript = await wholeRunTranscript();
    const lensLines = (transcript.get("start") ?? "").split("\n").filter((line) => line.includes("security-lenses/"));
    expect(lensLines.length).toBeGreaterThan(0);
    for (const line of lensLines) expect(line).toContain(`- ${join(LOOM_PACKAGE_ROOT, "references", "security-lenses")}/`);
    expect(transcript.get("nonce")).toContain(`  ${join(LOOM_PACKAGE_ROOT, "scripts", "security-sandbox.sh")} --target ${target} `);
  });
});

/** Every file under `directory`, skipping installed dependencies. */
const filesUnder = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry): readonly string[] => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });

describe("the sources that print commands", () => {
  it.each(["engine/src", "pi", "scripts", "hooks"])("%s holds no `loom helper` text to print", (root) => {
    const naming = filesUnder(join(LOOM_PACKAGE_ROOT, root)).filter((file) => readFileSync(file, "utf8").includes(UNINSTALLED));
    expect(naming).toEqual([]);
  });
});

describe("the documents that relay the program's printed lines", () => {
  // Once the program prints runnable commands there is nothing to alias: a
  // document that still wrote `loom helper` would send its reader to a binary
  // that is not there. Vendored lens files are upstream's and are not listed.
  it.each([
    "skills/security-audit/SKILL.md",
    "commands/security-audit.md",
    "agents/security-hunter-agent.md",
    "agents/security-verifier-agent.md",
    "agents/security-critic-agent.md",
    "docs/security-audit.md",
    "references/security-lenses/LOOM-DELTAS.md",
  ])("%s writes commands in a runnable form", (document) => {
    const naming = readFileSync(join(LOOM_PACKAGE_ROOT, document), "utf8").split("\n").filter((line) => line.includes(UNINSTALLED));
    expect(naming).toEqual([]);
  });
});
