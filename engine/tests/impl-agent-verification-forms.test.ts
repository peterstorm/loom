/**
 * The implementer prompts tell Agents exactly how to run their FINAL
 * verification so the evidence recorder can mint a trusted pass. Those forms
 * are only worth anything while the engine still accepts them: every command
 * the template and the code-implementer Agent document must classify as a
 * SOLE test segment (its exit is attributable), name an absolute report path
 * the report-discovery parsers read, pass the state-file guard, and — fed a
 * fresh runner-written report — judge as trusted-pass.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attributeExit, classifyTestCommandDetailed } from "../src/machine/extract-evidence";
import { bunJunitOutputFileFromCommand, findReport, outputFileFromCommand } from "../src/machine/report-discovery";
import { judgeTestRun } from "../src/machine/test-report";
import { guardStateFileDecision } from "../src/core/guard-state-file";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

const SOURCES = {
  template: read("commands", "templates", "impl-agent-context.md"),
  agent: read("agents", "code-implementer-agent.md"),
} as const;

/** Concrete report-writing commands documented in a prompt source, with its
 *  placeholders filled the way an Agent fills them. A bare runner name in
 *  prose (`bun test`, `npm test`) and elided forms (`…`) are not commands. */
function documentedCommands(source: string): readonly string[] {
  return [...source.matchAll(/`((?:bun test|npx vitest|npx jest|npm test)\b[^`]*)`/g)]
    .map((m) => m[1]!)
    .filter((cmd) => cmd.includes(" --") && !cmd.includes("…"))
    .map((cmd) => cmd.replaceAll("{task_id}", "T1").replaceAll("<task-id>", "T1"));
}

const reportPathOf = (cmd: string): string | null =>
  bunJunitOutputFileFromCommand(cmd) ?? outputFileFromCommand(cmd);

describe("documented final-verification forms stay accepted by the evidence recorder", () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    const commands = documentedCommands(source);

    it(`${name} documents Bun, Vitest, Jest, and npm report-writing forms`, () => {
      expect(commands.some((c) => c.startsWith("bun test") && c.includes("--cwd="))).toBe(true);
      for (const head of ["bun test", "npx vitest", "npx jest", "npm test"]) {
        expect(commands.some((c) => c.startsWith(head)), head).toBe(true);
      }
    });

    for (const cmd of commands) {
      it(`${name}: \`${cmd}\` is a sole, guard-clean test run naming an absolute report`, () => {
        const classified = classifyTestCommandDetailed(cmd);
        expect(classified).not.toBeNull();
        expect(classified!.isSole).toBe(true);
        expect(attributeExit(0, classified!)).toBe(0);
        expect(attributeExit(1, classified!)).toBe(1);
        const report = reportPathOf(classified!.segment);
        expect(report).not.toBeNull();
        expect(isAbsolute(report!)).toBe(true);
        expect(guardStateFileDecision(cmd).kind).toBe("allow");
      });
    }
  }

  it("the template forbids chained, piped and redirected final runs and shared-worktree git resets", () => {
    for (const rule of ["One bare command per Bash call", "ABSOLUTE", "git stash", "git checkout", "git reset", "scope violation"]) {
      expect(SOURCES.template).toContain(rule);
    }
    for (const rule of ["ONE bare command", "ABSOLUTE", "git stash", "git checkout", "git reset", "scope violation"]) {
      expect(SOURCES.agent).toContain(rule);
    }
  });
});

describe("a documented form fed a fresh runner-written report judges trusted-pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-verification-forms-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const BUN_JUNIT =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<testsuites name="bun test" tests="2" assertions="2" failures="0" skipped="0" time="0.01">\n' +
    '  <testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="2" failures="0" skipped="0" time="0.01">\n' +
    '    <testcase name="one" classname="" time="0.001" />\n' +
    '    <testcase name="two" classname="" time="0.001" />\n' +
    "  </testsuite>\n</testsuites>\n";

  const cases = [
    { head: "bun test", file: "bun.xml", body: BUN_JUNIT },
    { head: "npx vitest", file: "vitest.json", body: JSON.stringify({ numTotalTests: 2, numFailedTests: 0 }) },
    { head: "npx jest", file: "jest.json", body: JSON.stringify({ numTotalTests: 2, numFailedTests: 0 }) },
  ] as const;

  for (const { head, file, body } of cases) {
    it(`${head}`, () => {
      const documented = documentedCommands(SOURCES.template).find((c) => c.startsWith(head) && !c.includes("--cwd"));
      expect(documented).toBeDefined();
      const reportPath = join(dir, file);
      const cmd = documented!.replace(reportPathOf(documented!)!, reportPath);
      const callStartMs = Date.now() - 1000;
      writeFileSync(reportPath, body); // the runner's write, during the call
      const classified = classifyTestCommandDetailed(cmd)!;
      const report = findReport(classified.segment, "/elsewhere", "", { nowMs: Date.now(), callStartMs });
      expect(judgeTestRun(attributeExit(0, classified), report)).toEqual({ verdict: "trusted-pass" });
    });
  }
});
